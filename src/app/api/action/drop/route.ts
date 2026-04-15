import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { logEvent, getPlayerAndGame } from '@/lib/action-helpers'

const DROP_EXPIRE_MINUTES = 10

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id, item_id, qty } = await request.json()
    if (!game_id || !item_id || !qty || qty < 1) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    // ── 1st round trip: player + game + grid_state พร้อมกัน ──
    const [{ player, game, error }, ] = await Promise.all([
      getPlayerAndGame(supabase, user.id, game_id),
    ])
    if (!player || !game) return NextResponse.json({ error }, { status: 400 })
    if (player.pos_x === null || player.pos_y === null) return NextResponse.json({ error: 'ไม่ได้อยู่บนแผนที่' }, { status: 400 })

    const inventory: Array<{id:string,qty:number}> = player.inventory ?? []
    const itemIdx = inventory.findIndex(i => i.id === item_id)
    if (itemIdx === -1) return NextResponse.json({ error: 'ไม่มีไอเทมนี้ในกระเป๋า' }, { status: 400 })
    if (inventory[itemIdx].qty < qty) return NextResponse.json({ error: `มีแค่ ${inventory[itemIdx].qty} ชิ้น` }, { status: 400 })

    // ── 2nd round trip: grid_state ──
    const { data: gs } = await (supabase as any).from('grid_states').select('dropped_items').eq('game_id', game_id).eq('x', player.pos_x).eq('y', player.pos_y).maybeSingle()

    const expiresAt = new Date(Date.now() + DROP_EXPIRE_MINUTES * 60_000).toISOString()
    const existingDrops: any[] = gs?.dropped_items ?? []
    const existingIdx = existingDrops.findIndex(d => d.id === item_id && d.dropped_by_id === player.id)
    const newDrops = existingIdx !== -1
      ? existingDrops.map((d, i) => i === existingIdx ? { ...d, qty: d.qty + qty, expires_at: expiresAt } : d)
      : [...existingDrops, { id: item_id, qty, dropped_by: player.name, dropped_by_id: player.id, expires_at: expiresAt }]

    const newInventory = [...inventory]
    newInventory[itemIdx] = { ...newInventory[itemIdx], qty: newInventory[itemIdx].qty - qty }

    await Promise.all([
      (supabase as any).from('players').update({ inventory: newInventory.filter(i => i.qty > 0) }).eq('id', player.id),
      (supabase as any).from('grid_states').upsert({ game_id, x: player.pos_x, y: player.pos_y, items: [], dropped_items: newDrops }, { onConflict: 'game_id,x,y' }),
      logEvent(supabase, { game_id, event_type: 'ทิ้งของ', actor_id: player.id, pos_x: player.pos_x, pos_y: player.pos_y, data: { item: item_id, qty } }),
    ])

    return NextResponse.json({ ok: true, msg: `ทิ้ง ${item_id} ×${qty} — หายใน ${DROP_EXPIRE_MINUTES} นาที` })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
