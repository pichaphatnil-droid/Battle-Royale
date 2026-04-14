import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getValidPlayer, getActiveGame } from '@/lib/action-helpers'
import { cellsInRange } from '@/lib/visibility'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id, alliance_id } = await request.json()
    if (!game_id || !alliance_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    if (player.alliance_id) return NextResponse.json({ error: 'คุณมีกลุ่มอยู่แล้ว' }, { status: 400 })

    // ดึงข้อมูลกลุ่ม
    const { data: alliance } = await supabase.from('alliances').select('*').eq('id', alliance_id).single()
    if (!alliance || alliance.disbanded_at) return NextResponse.json({ error: 'กลุ่มนี้ไม่มีแล้ว' }, { status: 400 })
    if ((alliance.members as string[]).length >= 3) return NextResponse.json({ error: 'กลุ่มเต็มแล้ว (สูงสุด 3 คน)' }, { status: 400 })

    // ดึงหัวหน้ากลุ่ม
    const { data: leader } = await supabase.from('players').select('*').eq('id', alliance.leader_id).single()
    if (!leader || !leader.is_alive) return NextResponse.json({ error: 'หัวหน้ากลุ่มเสียชีวิตแล้ว' }, { status: 400 })

    // ตรวจระยะมองเห็น — ต้องเห็นสมาชิกอย่างน้อย 1 คนในกลุ่ม
    const { data: fromGrid } = await supabase.from('grids').select('visibility').eq('x', player.pos_x).eq('y', player.pos_y).maybeSingle()
    const fromVis = fromGrid?.visibility ?? 2
    const fromCells = new Set(cellsInRange(player.pos_x, player.pos_y, fromVis).map(c => `${c.x},${c.y}`))

    const members = alliance.members as string[]
    const { data: memberPlayers } = await supabase.from('players').select('pos_x,pos_y').in('id', members)
    const canSeeAny = memberPlayers?.some(m => fromCells.has(`${m.pos_x},${m.pos_y}`))
    if (!canSeeAny) return NextResponse.json({ error: 'ต้องอยู่ในระยะมองเห็นสมาชิกกลุ่มอย่างน้อย 1 คน' }, { status: 400 })

    // ลบ request เก่า (ถ้ามี)
    await supabase.from('alliance_invites')
      .delete()
      .eq('from_player_id', player.id)
      .eq('alliance_id', alliance_id)
      .eq('invite_type', 'request')

    // สร้าง request — from = ผู้ขอ, to = หัวหน้า
    const { data: invite, error: invErr } = await supabase.from('alliance_invites').insert({
      game_id,
      from_player_id: player.id,
      to_player_id: alliance.leader_id,
      alliance_id,
      invite_type: 'request',
    }).select().single()
    if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 })

    return NextResponse.json({ ok: true, invite_id: invite.id, msg: `ส่งคำขอเข้าร่วมกลุ่มของ ${leader.name} แล้ว` })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}