'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import type { Game, Player } from '@/lib/supabase/types'

interface Props {
  game: Game | null
  players: Player[]
  userId: string
  myPlayer: Player | null
}

export default function LobbyClient({ game, players: initialPlayers, userId, myPlayer }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [players, setPlayers] = useState(initialPlayers)
  const [currentGame, setCurrentGame] = useState(game)

  useEffect(() => {
    if (!currentGame) return
    const channel = supabase
      .channel(`lobby:${currentGame.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `game_id=eq.${currentGame.id}` },
        () => {
          supabase.from('players').select('*').eq('game_id', currentGame.id)
            .then(({ data }: { data: any }) => { if (data) setPlayers(data) })
        })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${currentGame.id}` },
        ({ new: g }) => {
          setCurrentGame(g as Game)
          if ((g as Game).status === 'กำลังเล่น') router.push('/game')
        })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [currentGame, router, supabase])

  function logout() {
    fetch('/api/auth/logout', { method: 'POST' }).then(() => router.push('/login'))
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
          <Image src="https://iili.io/BfyEfSI.png" alt="" width={28} height={28}
            style={{ filter: 'drop-shadow(0 0 6px rgba(139,0,0,0.7))' }} unoptimized />
          <span style={s.title}>โปรแกรม</span>
        </div>
        <button onClick={logout} style={s.logoutBtn}>ออกจากระบบ</button>
      </div>

      <div style={s.body}>
        <div style={s.statusCard}>
          <div style={{ width:'8px', height:'8px', borderRadius:'50%', flexShrink:0,
            background: currentGame ? 'var(--green-bright)' : 'var(--text-secondary)' }} />
          <span style={{ color: currentGame ? 'var(--green-bright)' : 'var(--text-secondary)', fontSize:'13px' }}>
            {currentGame ? `เกมรอผู้เล่น — ${players.length} / 30 คน` : 'ยังไม่มีเกม — รอแอดมินสร้างเกม'}
          </span>
        </div>

        {currentGame && (
          <>
            {myPlayer && (
              <div style={s.selfCard}>
                <span style={{ color:'var(--text-secondary)', fontSize:'11px' }}>คุณเข้าร่วมแล้ว</span>
                <span style={{ color:'var(--text-gold)', fontFamily:'var(--font-mono)', fontSize:'13px' }}>
                  #{String(myPlayer.student_number).padStart(2,'0')} {myPlayer.name}
                </span>
              </div>
            )}

            <div style={s.section}>
              <div style={s.sectionTitle}>ผู้เล่นที่เข้าร่วม ({players.length}/30)</div>
              <div style={s.grid}>
                {players.map(p => <PlayerCard key={p.id} player={p} isSelf={p.user_id === userId} />)}
                {Array.from({ length: Math.max(0, 30 - players.length) }).map((_, i) => (
                  <div key={`e-${i}`} style={s.emptySlot}>
                    <span style={{ color:'var(--border-bright)', fontSize:'18px' }}>?</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ textAlign:'center', padding:'8px' }}>
              <span style={{ color:'var(--text-secondary)', fontSize:'12px' }}>รอแอดมินกดเริ่มเกม...</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PlayerCard({ player, isSelf }: { player: Player; isSelf: boolean }) {
  const [imgError, setImgError] = useState(false)
  return (
    <div style={{ ...s.playerCard, borderColor: isSelf ? 'var(--red-blood)' : 'var(--border)',
      background: isSelf ? 'rgba(139,0,0,0.06)' : 'var(--bg-tertiary)' }}>
      <div style={{ width:'32px', height:'32px', flexShrink:0 }}>
        {player.photo_url && !imgError ? (
          <Image src={player.photo_url} alt={player.name} width={32} height={32}
            style={{ borderRadius:'50%', objectFit:'cover' }}
            onError={() => setImgError(true)} unoptimized />
        ) : (
          <div style={{ width:'32px', height:'32px', borderRadius:'50%', background:'var(--red-blood)',
            display:'flex', alignItems:'center', justifyContent:'center', fontSize:'14px',
            color:'var(--text-primary)', fontFamily:'var(--font-display)' }}>
            {player.name.charAt(0)}
          </div>
        )}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:'10px', color:'var(--text-secondary)' }}>
          #{String(player.student_number).padStart(2,'0')}
        </div>
        <div style={{ fontSize:'12px', color: isSelf ? 'var(--red-bright)' : 'var(--text-primary)',
          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          {player.name}
        </div>
      </div>
      <div style={{ fontSize:'10px', color:'var(--text-secondary)' }}>
        {player.gender === 'ชาย' ? '♂' : '♀'}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { minHeight:'100vh', background:'var(--bg-primary)', display:'flex', flexDirection:'column' },
  header: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 16px',
    height:'48px', background:'var(--bg-secondary)', borderBottom:'1px solid var(--red-blood)', flexShrink:0 },
  title: { fontFamily:'var(--font-display)', fontSize:'16px', fontWeight:700, color:'var(--red-bright)', letterSpacing:'0.1em' },
  logoutBtn: { background:'none', border:'1px solid var(--border)', color:'var(--text-secondary)', padding:'5px 10px', fontSize:'11px', cursor:'pointer' },
  body: { flex:1, maxWidth:'720px', width:'100%', margin:'0 auto', padding:'24px 16px', display:'flex', flexDirection:'column', gap:'16px' },
  statusCard: { display:'flex', alignItems:'center', gap:'8px', padding:'12px 16px', background:'var(--bg-secondary)', border:'1px solid var(--border)' },
  selfCard: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 16px', background:'rgba(139,0,0,0.06)', border:'1px solid var(--red-blood)' },
  section: { background:'var(--bg-secondary)', border:'1px solid var(--border)', padding:'16px' },
  sectionTitle: { fontSize:'10px', letterSpacing:'0.12em', color:'var(--text-secondary)', textTransform:'uppercase', marginBottom:'12px', borderBottom:'1px solid var(--border)', paddingBottom:'8px' },
  grid: { display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:'6px' },
  playerCard: { display:'flex', alignItems:'center', gap:'8px', padding:'8px 10px', border:'1px solid' },
  emptySlot: { display:'flex', alignItems:'center', justifyContent:'center', padding:'8px 10px', border:'1px dashed var(--border)', minHeight:'50px', opacity:0.4 },
}
