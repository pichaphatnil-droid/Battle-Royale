import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getPlayerAndGame, checkAndDeclareWinner } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id } = await request.json()
    if (!game_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const { player, game, error } = await getPlayerAndGame(supabase, user.id, game_id)
    if (!player || !game) return NextResponse.json({ error }, { status: 400 })

    const inventory: any[] = player.inventory ?? []
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()

    const writes: Promise<any>[] = [
      (supabase as any).from('players').update({ is_alive: false, hp: 0, inventory: [] }).eq('id', player.id),
      (supabase as any).from('events').insert({ game_id, event_type: 'ตาย', actor_id: player.id, target_id: player.id, pos_x: player.pos_x, pos_y: player.pos_y, data: { name: player.name, cause: 'ฆ่าตัวตาย' } }),
    ]

    if (inventory.length > 0 && player.pos_x !== null && player.pos_y !== null) {
      const { data: gs } = await (supabase as any).from('grid_states').select('dropped_items').eq('game_id', game_id).eq('x', player.pos_x).eq('y', player.pos_y).maybeSingle()
      const newDrops = [...(gs?.dropped_items ?? []), ...inventory.map((item: any) => ({ id: item.id, qty: item.qty, dropped_by: player.name, dropped_by_id: player.id, expires_at: expiresAt }))]
      writes.push((supabase as any).from('grid_states').upsert({ game_id, x: player.pos_x, y: player.pos_y, items: [], dropped_items: newDrops }, { onConflict: 'game_id,x,y' }))
    }

    await Promise.all(writes)
    await checkAndDeclareWinner(supabase, game_id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
