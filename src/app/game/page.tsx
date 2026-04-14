import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import GameClient from './GameClient'

export default async function GamePage() {
  const supabase = await createClient()
  const sb = supabase as any
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ดึงเกมที่กำลังเล่นก่อน — ต้องได้ game.id ก่อนถึงดึงอย่างอื่นได้
  const { data: game } = await sb
    .from('games')
    .select('*')
    .in('status', ['กำลังเล่น', 'หยุดชั่วคราว'])
    .limit(1)
    .maybeSingle()

  if (!game) redirect('/lobby')

  // ดึงผู้เล่นตัวเองก่อน — ต้องได้ myPlayer.id ก่อนดึง alliance
  const { data: allPlayers } = await sb
    .from('players')
    .select('*')
    .eq('game_id', game.id)

  const myPlayer = allPlayers?.find((p: any) => p.user_id === user.id)
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
   sb.from('grids').select('*'),
   sb.from('grid_states').select('*').eq('game_id', game.id),
   sb.from('trait_definitions').select('*'),
   sb.from('moodle_definitions').select('*'),
   sb.from('item_definitions').select('*'),
   sb.from('craft_recipes').select('*').eq('is_active', true).order('id'),
   sb.from('events').select('*').eq('game_id', game.id).order('occurred_at', { ascending: false }).limit(50),
   sb.from('alliances').select('*').eq('game_id', game.id).contains('members', [myPlayer.id]).is('disbanded_at', null).maybeSingle(),
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
