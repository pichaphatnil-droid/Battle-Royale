import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function HomePage() {
  const supabase = await createClient()
  const sb = supabase as any
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: game } = await sb.from('games')
    .select('id')
    .in('status', ['รอผู้เล่น', 'กำลังเล่น', 'หยุดชั่วคราว'])
    .limit(1)
    .maybeSingle()

  if (!game) redirect('/lobby')

  // query ตรง ไม่ดึงทั้งหมด
  const { data: player } = await sb.from('players')
    .select('id')
    .eq('game_id', game.id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!player) redirect('/create-character')
  redirect('/game')
}