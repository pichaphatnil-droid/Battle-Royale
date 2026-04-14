import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getValidPlayer, getActiveGame } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id, new_leader_id } = await request.json()
    if (!game_id || !new_leader_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })
    if (!player.alliance_id) return NextResponse.json({ error: 'ไม่ได้อยู่ในกลุ่ม' }, { status: 400 })

    const { data: alliance } = await (supabase as any).from('alliances').select('*').eq('id', player.alliance_id).single()
    if (!alliance || alliance.disbanded_at) return NextResponse.json({ error: 'ไม่พบกลุ่ม' }, { status: 400 })
    if (alliance.leader_id !== player.id) return NextResponse.json({ error: 'คุณไม่ใช่หัวหน้ากลุ่ม' }, { status: 400 })

    const members = alliance.members as string[]
    if (!members.includes(new_leader_id)) return NextResponse.json({ error: 'ผู้เล่นนี้ไม่ได้อยู่ในกลุ่ม' }, { status: 400 })

    const { data: newLeader } = await (supabase as any).from('players').select('name').eq('id', new_leader_id).single()
    await (supabase as any).from('alliances').update({ leader_id: new_leader_id }).eq('id', alliance.id)

    return NextResponse.json({ ok: true, msg: `โอนตำแหน่งหัวหน้าให้ ${newLeader?.name ?? '?'} แล้ว` })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
