import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getValidPlayer, getActiveGame, logEvent } from '@/lib/action-helpers'

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
    if (!player.alliance_id) return NextResponse.json({ error: 'ไม่ได้อยู่ในกลุ่ม' }, { status: 400 })

    const { data: alliance } = await (supabase as any).from('alliances').select('*').eq('id', player.alliance_id).single()
    if (!alliance) return NextResponse.json({ error: 'ไม่พบกลุ่ม' }, { status: 400 })

    const members = (alliance.members as string[]).filter(id => id !== player.id)

    // ออกจากกลุ่ม
    await (supabase as any).from('players').update({ alliance_id: null }).eq('id', player.id)

    if (members.length < 2) {
      // เหลือ 1 คน = ยุบกลุ่ม
      await (supabase as any).from('alliances').update({ disbanded_at: new Date().toISOString() }).eq('id', alliance.id)
      if (members.length === 1) {
        await (supabase as any).from('players').update({ alliance_id: null }).eq('id', members[0])
      }
    } else {
      // อัปเดต members
      await (supabase as any).from('alliances').update({ members }).eq('id', alliance.id)
    }

    await logEvent(supabase, {
      game_id,
      event_type: 'ออกจากกลุ่ม',
      actor_id: player.id,
      pos_x: player.pos_x ?? undefined,
      pos_y: player.pos_y ?? undefined,
      data: { alliance_id: alliance.id },
    })

    return NextResponse.json({ ok: true, msg: 'ออกจากกลุ่มแล้ว' })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
