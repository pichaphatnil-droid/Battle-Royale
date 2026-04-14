import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import LobbyClient from './LobbyClient'

export default async function LobbyPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ถ้ามีเกมกำลังเล่น
  const { data: activeGame } = await supabase
    .from('games')
    .select('*')
    .in('status', ['กำลังเล่น', 'หยุดชั่วคราว'])
    .limit(1)
    .maybeSingle()

  if (activeGame) {
    // query ตรง ไม่ดึงทั้งหมด
    const [{ data: me }, { data: allPlayers }] = await Promise.all([
      supabase.from('players').select('id').eq('game_id', activeGame.id).eq('user_id', user.id).maybeSingle(),
      supabase.from('players').select('id').eq('game_id', activeGame.id),
    ])

    if (me) redirect('/game')

    return (
      <div style={{
        minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex',
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: '16px', padding: '24px', fontFamily: 'var(--font-body)',
      }}>
        <div style={{ fontSize: '48px' }}>🔒</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '24px', color: 'var(--red-bright)', letterSpacing: '0.1em', textAlign: 'center' }}>
          เกมเริ่มไปแล้ว
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', textAlign: 'center', maxWidth: '360px', lineHeight: 1.6 }}>
          ท่านมาไม่ทัน เกมนี้เริ่มต้นไปแล้ว โปรดรอเกมหน้าหรือติดต่อแอดมิน
        </p>
        <div style={{ padding: '10px 20px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
          สถานะ: {activeGame.status} — ผู้เล่น {allPlayers?.length ?? 0} คน
        </div>
        <form action="/api/auth/logout" method="POST">
          <button style={{ padding: '8px 20px', background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
            ออกจากระบบ
          </button>
        </form>
      </div>
    )
  }

  // รอผู้เล่น
  const { data: game } = await supabase
    .from('games').select('*').eq('status', 'รอผู้เล่น').limit(1).maybeSingle()

  if (!game) return <LobbyClient game={null} players={[]} userId={user.id} myPlayer={null} />

  const { data: players } = await supabase.from('players').select('*').eq('game_id', game.id)
  const myPlayer = players?.find(p => p.user_id === user.id) ?? null
  if (!myPlayer) redirect('/create-character')

  return <LobbyClient game={game} players={players ?? []} userId={user.id} myPlayer={myPlayer} />
}