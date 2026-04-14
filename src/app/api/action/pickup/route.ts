import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { logEvent, getValidPlayer, getActiveGame } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()

    const { game_id, drop_index } = await request.json()
    if (!game_id || drop_index === undefined)
      return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    if (player.pos_x === null || player.pos_y === null)
      return NextResponse.json({ error: 'ไม่ได้อยู่บนแผนที่' }, { status: 400 })

    // ดึง grid_state ของช่องที่ยืนอยู่
    const { data: gs } = await (supabase as any)
      .from('grid_states').select('*')
      .eq('game_id', game_id).eq('x', player.pos_x).eq('y', player.pos_y)
      .maybeSingle()

    if (!gs) return NextResponse.json({ error: 'ไม่มีของในช่องนี้' }, { status: 400 })

    const drops: Array<any> = gs.dropped_items ?? []
    const drop = drops[drop_index]
    if (!drop) return NextResponse.json({ error: 'ไม่พบของที่ระบุ' }, { status: 400 })

    // ตรวจว่าหมดอายุหรือยัง
    if (drop.expires_at && new Date(drop.expires_at).getTime() < Date.now())
      return NextResponse.json({ error: 'ของหายไปแล้ว' }, { status: 400 })

    // เพิ่มเข้ากระเป๋า
    const inventory: Array<{id:string,qty:number}> = player.inventory ?? []
    const existing = inventory.find(i => i.id === drop.id)
    let newInventory
    if (existing) {
      newInventory = inventory.map(i => i.id === drop.id ? { ...i, qty: i.qty + drop.qty } : i)
    } else {
      newInventory = [...inventory, { id: drop.id, qty: drop.qty }]
    }

    // ลบออกจาก dropped_items
    const newDrops = drops.filter((_: any, i: number) => i !== drop_index)

    await Promise.all([
     (supabase as any).from('players').update({ inventory: newInventory }).eq('id', player.id),
     (supabase as any).from('grid_states').update({ dropped_items: newDrops })
        .eq('game_id', game_id).eq('x', player.pos_x).eq('y', player.pos_y),
    ])

    await logEvent(supabase, {
      game_id, event_type: 'เก็บของ',
      actor_id: player.id,
      pos_x: player.pos_x, pos_y: player.pos_y,
      data: { item: drop.id, qty: drop.qty, from: drop.dropped_by },
    })

    return NextResponse.json({ ok: true, msg: `เก็บ ${drop.id} ×${drop.qty}` })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
