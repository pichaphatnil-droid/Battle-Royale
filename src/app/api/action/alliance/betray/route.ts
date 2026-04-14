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
    if (!alliance || alliance.disbanded_at) return NextResponse.json({ error: 'ไม่พบกลุ่ม' }, { status: 400 })

    const members = alliance.members as string[]
    const otherMembers = members.filter(id => id !== player.id)

    // ยุบกลุ่มทันที
    await (supabase as any).from('alliances').update({ disbanded_at: new Date().toISOString() }).eq('id', alliance.id)

    // ล้าง alliance_id ทุกคน
    await (supabase as any).from('players').update({ alliance_id: null }).in('id', members)

    // trigger moodle โศกเศร้า / แค้นเคือง ให้คนที่ถูกทรยศ
    for (const memberId of otherMembers) {
      const { data: memberPlayer } = await (supabase as any).from('players').select('moodles').eq('id', memberId).single()
      if (!memberPlayer) continue
      const moodles: any[] = memberPlayer.moodles ?? []
      const hasGrief = moodles.some(m => m.id === 'โศกเศร้า')
      const hasAngry = moodles.some(m => m.id === 'แค้นเคือง')
      const newMoodles = [...moodles]
      if (!hasGrief) newMoodles.push({ id: 'โศกเศร้า', level: 1 })
      if (!hasAngry) newMoodles.push({ id: 'แค้นเคือง', level: 1 })
      await (supabase as any).from('players').update({ moodles: newMoodles }).eq('id', memberId)
    }

    // log event ทรยศ — ไม่มี actor_id เพื่อให้แสดงทุกคน
    await logEvent(supabase, {
      game_id,
      event_type: 'ทรยศ',
      actor_id: player.id,
      pos_x: player.pos_x ?? undefined,
      pos_y: player.pos_y ?? undefined,
      data: { alliance_id: alliance.id, betrayed: otherMembers },
    })

    return NextResponse.json({ ok: true, msg: 'ทรยศกลุ่มแล้ว กลุ่มถูกยุบทันที' })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
