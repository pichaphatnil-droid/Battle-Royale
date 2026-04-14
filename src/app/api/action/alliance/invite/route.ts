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
    const { game_id, to_player_id } = await request.json()
    if (!game_id || !to_player_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    const { data: target } = await (supabase as any).from('players').select('*').eq('id', to_player_id).single()
    if (!target) return NextResponse.json({ error: 'ไม่พบผู้เล่นนี้' }, { status: 400 })
    if (!target.is_alive) return NextResponse.json({ error: 'ผู้เล่นนี้เสียชีวิตแล้ว' }, { status: 400 })
    if (target.id === player.id) return NextResponse.json({ error: 'ชวนตัวเองไม่ได้' }, { status: 400 })

    // ตรวจระยะมองเห็น — ต้องเห็นกันทั้งคู่
    const { data: fromGrid } = await (supabase as any).from('grids').select('visibility').eq('x', player.pos_x).eq('y', player.pos_y).maybeSingle()
    const { data: toGrid } = await (supabase as any).from('grids').select('visibility').eq('x', target.pos_x).eq('y', target.pos_y).maybeSingle()
    const fromVis = fromGrid?.visibility ?? 2
    const toVis = toGrid?.visibility ?? 2
    const fromCells = new Set(cellsInRange(player.pos_x ?? 0, player.pos_y ?? 0, fromVis).map(c => `${c.x},${c.y}`))
    const toCells = new Set(cellsInRange(target.pos_x ?? 0, target.pos_y ?? 0, toVis).map(c => `${c.x},${c.y}`))
    if (!fromCells.has(`${target.pos_x},${target.pos_y}`) || !toCells.has(`${player.pos_x},${player.pos_y}`))
      return NextResponse.json({ error: 'ต้องอยู่ในระยะที่มองเห็นกันทั้งคู่' }, { status: 400 })

    // ตรวจว่าเป้าหมายมีกลุ่มอยู่แล้วไหม
    if (target.alliance_id) {
      const { data: targetAlliance } = await (supabase as any).from('alliances').select('*').eq('id', target.alliance_id).single()
      if (targetAlliance && !targetAlliance.disbanded_at)
        return NextResponse.json({ error: `${target.name} มีกลุ่มอยู่แล้ว` }, { status: 400 })
    }

    // ตรวจกลุ่มของผู้ชวน
    let allianceId: string | null = null
    if (player.alliance_id) {
      const { data: alliance } = await (supabase as any).from('alliances').select('*').eq('id', player.alliance_id).single()
      if (alliance && !alliance.disbanded_at) {
        if ((alliance.members as string[]).length >= 3)
          return NextResponse.json({ error: 'กลุ่มเต็มแล้ว (สูงสุด 3 คน)' }, { status: 400 })
        allianceId = alliance.id
      }
    }

    // ลบ invite เก่า แล้วสร้างใหม่
    await (supabase as any).from('alliance_invites')
      .delete()
      .eq('from_player_id', player.id)
      .eq('to_player_id', to_player_id)
      .eq('game_id', game_id)

    const { data: invite, error: invErr } = await (supabase as any).from('alliance_invites').insert({
      game_id,
      from_player_id: player.id,
      to_player_id,
      alliance_id: allianceId,
      invite_type: 'invite',
    }).select().single()
    if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 })

    return NextResponse.json({ ok: true, invite_id: invite.id, msg: `ส่งคำชวน ${target.name} แล้ว (หมดอายุใน 5 นาที)` })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
