import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getValidPlayer, getActiveGame, checkAndDeclareWinner } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id } = await request.json()
    if (!game_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    // อัปเดตสถานะตาย
    await (supabase as any).from('players')
      .update({ is_alive: false, hp: 0 })
      .eq('id', player.id)

    // drop inventory ลงพื้น
    const inventory = player.inventory ?? []
    if (inventory.length > 0 && player.pos_x !== null && player.pos_y !== null) {
      const { data: gs } = await (supabase as any)
        .from('grid_states').select('*')
        .eq('game_id', game_id).eq('x', player.pos_x).eq('y', player.pos_y)
        .maybeSingle()
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
      const existingDrops: any[] = gs?.dropped_items ?? []
      const newDrops = [
        ...existingDrops,
        ...inventory.map((item: any) => ({
          id: item.id, qty: item.qty,
          dropped_by: player.name, dropped_by_id: player.id,
          expires_at: expiresAt,
        }))
      ]
      if (gs) {
        await (supabase as any).from('grid_states')
          .update({ dropped_items: newDrops })
          .eq('game_id', game_id).eq('x', player.pos_x).eq('y', player.pos_y)
      } else {
        await (supabase as any).from('grid_states')
          .insert({ game_id, x: player.pos_x, y: player.pos_y, items: [], dropped_items: newDrops })
      }
      await (supabase as any).from('players').update({ inventory: [] }).eq('id', player.id)
    }

    // log event ตาย
    await (supabase as any).from('events').insert({
      game_id,
      event_type: 'ตาย',
      actor_id: player.id,
      target_id: player.id,
      pos_x: player.pos_x,
      pos_y: player.pos_y,
      data: { name: player.name, cause: 'ฆ่าตัวตาย' },
    })

    // ตรวจ winner
    await checkAndDeclareWinner(supabase, game_id)

    return NextResponse.json({ ok: true, msg: 'เสียชีวิตแล้ว' })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
