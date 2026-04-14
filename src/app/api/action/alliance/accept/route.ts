import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getValidPlayer, getActiveGame, logEvent } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id, invite_id } = await request.json()
    if (!game_id || !invite_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    const { data: invite } = await (supabase as any).from('alliance_invites').select('*').eq('id', invite_id).single()
    if (!invite) return NextResponse.json({ error: 'ไม่พบคำชวนนี้' }, { status: 400 })
    if (invite.to_player_id !== player.id) return NextResponse.json({ error: 'คำชวนนี้ไม่ใช่ของคุณ' }, { status: 400 })
    if (new Date(invite.expires_at) < new Date()) return NextResponse.json({ error: 'คำชวนหมดอายุแล้ว' }, { status: 400 })

    const isRequest = invite.invite_type === 'request'
    // invite: from=ผู้ชวน, to=ผู้รับ(player)  -> player เข้ากลุ่มของ from
    // request: from=ผู้ขอ, to=หัวหน้า(player) -> from เข้ากลุ่มของ player
    const joiningPlayerId = isRequest ? invite.from_player_id : player.id
    const { data: joiningPlayer } = await (supabase as any).from('players').select('*').eq('id', joiningPlayerId).single()
    if (!joiningPlayer || !joiningPlayer.is_alive) return NextResponse.json({ error: 'ผู้เล่นเสียชีวิตแล้ว' }, { status: 400 })

    let allianceId: string
    let msg: string

    if (invite.alliance_id) {
      const { data: alliance } = await (supabase as any).from('alliances').select('*').eq('id', invite.alliance_id).single()
      if (!alliance || alliance.disbanded_at) return NextResponse.json({ error: 'กลุ่มนี้ถูกยุบแล้ว' }, { status: 400 })
      const members = alliance.members as string[]
      if (members.length >= 3) return NextResponse.json({ error: 'กลุ่มเต็มแล้ว (สูงสุด 3 คน)' }, { status: 400 })
      await (supabase as any).from('alliances').update({ members: [...members, joiningPlayerId] }).eq('id', alliance.id)
      allianceId = alliance.id
      msg = isRequest ? `อนุมัติให้ ${joiningPlayer.name} เข้ากลุ่มแล้ว` : `เข้ากลุ่มแล้ว`
    } else {
      // สร้างกลุ่มใหม่ — from_player เป็นหัวหน้า (ผู้ชวนคนแรก)
      const { data: fromPlayer } = await (supabase as any).from('players').select('*').eq('id', invite.from_player_id).single()
      if (!fromPlayer) return NextResponse.json({ error: 'ไม่พบผู้ชวน' }, { status: 400 })
      const { data: newAlliance, error: alErr } = await (supabase as any).from('alliances').insert({
        game_id,
        members: [fromPlayer.id, joiningPlayerId],
        trust_scores: {},
        leader_id: fromPlayer.id,
      }).select().single()
      if (alErr || !newAlliance) return NextResponse.json({ error: 'สร้างกลุ่มไม่ได้' }, { status: 500 })
      allianceId = newAlliance.id
      await (supabase as any).from('players').update({ alliance_id: allianceId }).eq('id', fromPlayer.id)
      msg = `รวมกลุ่มกับ ${fromPlayer.name} แล้ว`
    }

    await (supabase as any).from('players').update({ alliance_id: allianceId }).eq('id', joiningPlayerId)
    await (supabase as any).from('alliance_invites').delete().eq('id', invite_id)
    await logEvent(supabase, {
      game_id, event_type: 'รวมกลุ่ม',
      actor_id: joiningPlayerId,
      pos_x: joiningPlayer.pos_x ?? undefined,
      pos_y: joiningPlayer.pos_y ?? undefined,
      data: { alliance_id: allianceId },
    })

    return NextResponse.json({ ok: true, alliance_id: allianceId, msg })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
