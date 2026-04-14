import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import GameClient from './GameClient'

export default async function GamePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ดึงเกมที่กำลังเล่นก่อน — ต้องได้ game.id ก่อนถึงดึงอย่างอื่นได้
  const { data: game } = await supabase
    .from('games')
    .select('*')
    .in('status', ['กำลังเล่น', 'หยุดชั่วคราว'])
    .limit(1)
    .maybeSingle()

  if (!game) redirect('/lobby')

  // ดึงผู้เล่นตัวเองก่อน — ต้องได้ myPlayer.id ก่อนดึง alliance
  const { data: allPlayers } = await supabase
    .from('players')
    .select('*')
    .eq('game_id', game.id)

  const myPlayer = allPlayers?.find(p => p.user_id === user.id)
  if (!myPlayer) redirect('/create-character')

  // ดึงที่เหลือทั้งหมดพร้อมกัน
  const [
    { data: grids },
    { data: gridStates },
    { data: traits },
    { data: moodles },
    { data: items },
    { data: recipes },
    { data: events },
    { data: myAlliance },
  ] = await Promise.all([
   (supabase as any).from('grids').select('*'),
   (supabase as any).from('grid_states').select('*').eq('game_id', game.id),
   (supabase as any).from('trait_definitions').select('*'),
   (supabase as any).from('moodle_definitions').select('*'),
   (supabase as any).from('item_definitions').select('*'),
   (supabase as any).from('craft_recipes').select('*').eq('is_active', true).order('id'),
   (supabase as any).from('events').select('*').eq('game_id', game.id).order('occurred_at', { ascending: false }).limit(50),
   (supabase as any).from('alliances').select('*').eq('game_id', game.id).contains('members', [myPlayer.id]).is('disbanded_at', null).maybeSingle(),
  ])

  return (
    <GameClient
      game={game}
      myPlayer={myPlayer}
      allPlayers={allPlayers ?? []}
      grids={grids ?? []}
      gridStates={gridStates ?? []}
      traits={traits ?? []}
      moodleDefs={moodles ?? []}
      itemDefs={items ?? []}
      initialEvents={events ?? []}
      myAlliance={myAlliance ?? null}
      recipes={recipes ?? []}
    />
  )
}
