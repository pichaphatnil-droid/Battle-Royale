import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabase = createServiceClient()
    const { data: userData } = await (supabase as any).from('users').select('role').eq('id', user.id).single()
    if (userData?.role !== 'แอดมิน') return NextResponse.json({ error: 'ไม่มีสิทธิ์' }, { status: 403 })

    const { game_id, ann_type, message, target_id } = await request.json()
    if (!game_id || !message) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const { error } = await supabase.from('announcements').insert({
      game_id, ann_type, message,
      target_id: target_id || null,
      sender_id: user.id,
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
