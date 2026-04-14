import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import AdminClient from './AdminClient'

export default async function AdminPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ตรวจสอบว่าเป็นแอดมิน
  const { data: userData } = await (supabase as any)
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (userData?.role !== 'แอดมิน') redirect('/')

  // ดึงข้อมูลทั้งหมด
  const [
    { data: games },
    { data: players },
    { data: items },
    { data: traits },
    { data: moodles },
    { data: recipes },
  ] = await Promise.all([
    (supabase as any).from('games').select('*').order('created_at', { ascending: false }),
    (supabase as any).from('players').select('*'),
    supabase.from('item_definitions').select('*').order('id'),
    supabase.from('trait_definitions').select('*').order('id'),
    supabase.from('moodle_definitions').select('*').order('id'),
    supabase.from('craft_recipes').select('*').order('id'),
  ])

  return (
    <AdminClient
      currentUserId={user.id}
      games={games ?? []}
      players={players ?? []}
      items={items ?? []}
      traits={traits ?? []}
      moodles={moodles ?? []}
      recipes={recipes ?? []}
    />
  )
}
