import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import CreateCharacterClient from './CreateCharacterClient'

export default async function CreateCharacterPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: game } = await supabase
    .from('games')
    .select('*')
    .eq('status', 'รอผู้เล่น')
    .limit(1)
    .maybeSingle()

  if (!game) redirect('/lobby')

  const { data: allPlayers } = await supabase
    .from('players')
    .select('*')
    .eq('game_id', game.id)

  const existing = allPlayers?.find(p => p.user_id === user.id)
  if (existing) redirect('/lobby')

  const { data: traits } = await supabase
    .from('trait_definitions')
    .select('*')

  // ดึงอาวุธทั้งหมดสำหรับสุ่มให้ผู้เล่น
  const { data: weapons } = await supabase
    .from('item_definitions')
    .select('*')
    .eq('category', 'อาวุธ')

  const activeTraits = traits?.filter(t => t.is_active) ?? []
  const usedMaleNumbers = allPlayers?.filter(p => p.gender === 'ชาย').map(p => p.student_number) ?? []
  const usedFemaleNumbers = allPlayers?.filter(p => p.gender === 'หญิง').map(p => p.student_number) ?? []

  const availableMaleNumbers = Array.from({ length: 15 }, (_, i) => i + 1).filter(n => !usedMaleNumbers.includes(n))
  const availableFemaleNumbers = Array.from({ length: 15 }, (_, i) => i + 1).filter(n => !usedFemaleNumbers.includes(n))

  // สุ่มพิกัดเริ่มต้นจากทั้งแผนที่ 30×30 ที่ยังไม่มีคนอยู่
  const allPositions = Array.from({ length: 30 }, (_, x) =>
    Array.from({ length: 30 }, (_, y) => ({ x, y }))
  ).flat()
  const usedPositions = new Set(allPlayers?.map(p => `${p.pos_x},${p.pos_y}`) ?? [])
  const freePositions = allPositions.filter(p => !usedPositions.has(`${p.x},${p.y}`))
  const shuffled = freePositions.sort(() => Math.random() - 0.5)
  const startPos = shuffled[0] ?? { x: 10, y: 10 }

  return (
    <CreateCharacterClient
      gameId={game.id}
      userId={user.id}
      availableMaleNumbers={availableMaleNumbers}
      availableFemaleNumbers={availableFemaleNumbers}
      traits={activeTraits}
      weapons={weapons ?? []}
      startPos={startPos}
    />
  )
}