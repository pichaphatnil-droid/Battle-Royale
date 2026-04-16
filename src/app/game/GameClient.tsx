'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { calculateCurrentAP, apToPercent, calculateCurrentHunger, calculateCurrentThirst, hungerColor, thirstColor } from '@/lib/ap'
import { cellsInRange } from '@/lib/visibility'
import type {
  Game, Player, Grid, GridState, TraitDefinition,
  MoodleDefinition, ItemDefinition, GameEvent, Alliance, CraftRecipe
} from '@/lib/supabase/types'

interface Props {
  game: Game
  myPlayer: Player
  allPlayers: Player[]
  grids: Grid[]
  gridStates: GridState[]
  traits: TraitDefinition[]
  moodleDefs: MoodleDefinition[]
  itemDefs: ItemDefinition[]
  initialEvents: GameEvent[]
  myAlliance: Alliance | null
  recipes: CraftRecipe[]
}

type ChatTab = 'ทั่วไป' | 'พื้นที่' | 'พันธมิตร'

export default function GameClient({
  game, myPlayer: initialPlayer, allPlayers: initialAllPlayers,
  grids, gridStates: initialGridStates, traits, moodleDefs, itemDefs,
  initialEvents, myAlliance: initialMyAlliance, recipes,
}: Props) {
  const router = useRouter()
  const supabase = createClient()

  // ── State ──────────────────────────────────────────────────
  const [myPlayer, setMyPlayer] = useState(initialPlayer)
  const [allPlayers, setAllPlayers] = useState(initialAllPlayers)
  const [gridStates, setGridStates] = useState(initialGridStates)
  const [events, setEvents] = useState(initialEvents)
  const [selectedCell, setSelectedCell] = useState<{x:number,y:number}|null>(null)
  const [chatTab, setChatTab] = useState<ChatTab>('ทั่วไป')
  const [rightTab, setRightTab] = useState<'stats'|'ally'>('stats')
  const [chatMsg, setChatMsg] = useState('')
  const [ap, setAp] = useState(initialPlayer.ap)
  const [hunger, setHunger] = useState(initialPlayer.hunger ?? 100)
  const [thirst, setThirst] = useState(initialPlayer.thirst ?? 100)
  const [mounted, setMounted] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [selectedWeapon, setSelectedWeapon] = useState<string|null>(null)
  const [attackTarget, setAttackTarget] = useState<string|null>(null)
  const [invSort, setInvSort] = useState<'default'|'name'|'category'|'weight'>('default')
  const [mapView, setMapView] = useState<'mini'|'zoom'>('zoom')
  const [mobileTab, setMobileTab] = useState<'map'|'stats'|'log'|'chat'|'ally'>('map')
  const [announcements, setAnnouncements] = useState<any[]>([]) // สำหรับ event log
  const [toastAnns, setToastAnns] = useState<any[]>([]) // สำหรับ toast เท่านั้น
  const [isDesktop, setIsDesktop] = useState(true)
  const [showPlayerList, setShowPlayerList] = useState(false)
  const [deathModal, setDeathModal] = useState<{ name: string; killer?: string; studentNumber?: number; gender?: string; photoUrl?: string | null; aliveCount?: number } | null>(null)
  const [winnerModal, setWinnerModal] = useState<{ name: string, killCount: number, studentNumber: number } | null>(null)
  const [selectedPlayerInfo, setSelectedPlayerInfo] = useState<Player | null>(null)
  const [myAlliance, setMyAlliance] = useState(initialMyAlliance)
  const [pendingInvites, setPendingInvites] = useState<any[]>([]) // คำชวนที่รอ accept
  const [allianceMsg, setAllianceMsg] = useState<string | null>(null)
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 769)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const [isCombat, setIsCombat] = useState(() => {
    const hour = (new Date().getUTCHours() + 7) % 24
    return hour >= 19
  })
  const [combatCountdown, setCombatCountdown] = useState('')
  // searchCooldown คำนวณจาก grid_states ของช่องที่ยืนอยู่
  const chatEndRef = useRef<HTMLDivElement>(null)
  const isMovingRef = useRef(false) // ป้องกัน Realtime override ระหว่าง move

  const [timeLeft, setTimeLeft] = useState('')

  // ── Auto Close Toasts ─────────────────────────────────────
  useEffect(() => {
    if (toastAnns.length > 0) {
      const timer = setTimeout(() => {
        setToastAnns(prev => prev.slice(1))
      }, 5000)
      return () => clearTimeout(timer)
    }
  }, [toastAnns])

  // ── คำนวณค่าหลัง mount (หลีกเลี่ยง hydration mismatch) ─────
  useEffect(() => {
    setMounted(true)
    setAp(calculateCurrentAP(myPlayer.ap, myPlayer.ap_updated_at))
    setHunger(calculateCurrentHunger(myPlayer.hunger ?? 100, myPlayer.hunger_updated_at ?? new Date().toISOString(), myPlayer.traits ?? []))
    setThirst(calculateCurrentThirst(myPlayer.thirst ?? 100, myPlayer.thirst_updated_at ?? new Date().toISOString(), myPlayer.traits ?? []))

    // โหลดประกาศล่าสุด 5 รายการ กรอง dismissed
    ;(async () => {
      const { data } = await (supabase as any).from('announcements').select('*')
        .eq('game_id', game.id)
        .or(`target_id.is.null,target_id.eq.${myPlayer.id}`)
        .order('occurred_at', { ascending: false })
        .limit(5)
      if (!data) return
      const key = `dismissed_ann_${game.id}`
      const dismissed: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      setAnnouncements(data)
      setToastAnns(data.filter((a: any) => !dismissed.includes(a.id)))
    })()

    // โหลด pending invites ที่ยังไม่หมดอายุ
    ;(async () => {
      const { data } = await (supabase as any).from('alliance_invites')
        .select('*, from_player:from_player_id(name)')
        .eq('to_player_id', myPlayer.id)
        .eq('game_id', game.id)
        .gt('expires_at', new Date().toISOString())
      if (data) setPendingInvites(data)
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── AP + countdown ทุก 10 วินาที ───────────────────────────
  useEffect(() => {
    function tick() {
      setNow(Date.now())
      setAp(calculateCurrentAP(myPlayer.ap, myPlayer.ap_updated_at))
      setHunger(calculateCurrentHunger(myPlayer.hunger ?? 100, myPlayer.hunger_updated_at ?? new Date().toISOString(), myPlayer.traits ?? []))
      setThirst(calculateCurrentThirst(myPlayer.thirst ?? 100, myPlayer.thirst_updated_at ?? new Date().toISOString(), myPlayer.traits ?? []))

      // คำนวณเวลาที่เหลือของเกม
      if (game.ends_at) {
        const diff = new Date(game.ends_at).getTime() - Date.now()
        if (diff <= 0) { setTimeLeft('หมดเวลา'); return }
        const h = Math.floor(diff / 3_600_000)
        const m = Math.floor((diff % 3_600_000) / 60_000)
        setTimeLeft(`${h}ชม. ${m}น.`)
      }

      // ตรวจเวลาต่อสู้
      const thaiHour = (new Date().getUTCHours() + 7) % 24
      const thaiMin = new Date().getUTCMinutes()
      const combat = thaiHour >= 19
      setIsCombat(combat)
      if (!combat) {
        const minsLeft = (19 - thaiHour) * 60 - thaiMin
        const h = Math.floor(minsLeft / 60)
        const m = minsLeft % 60
        setCombatCountdown(h > 0 ? `${h}ชม.${m}น.` : `${m}น.`)
      } else {
        setCombatCountdown('')
      }
    }
    tick()
    const interval = setInterval(tick, 10_000)
    return () => clearInterval(interval)
  }, [myPlayer.ap, myPlayer.ap_updated_at, game.ends_at])

  // ── Realtime ────────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel(`game:${game.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'players',
        filter: `game_id=eq.${game.id}`,
      }, (payload: any) => {
        const updated = payload.new
        if (!updated || updated.game_id !== game.id) return
        setAllPlayers(prev => {
          const idx = prev.findIndex((p: any) => p.id === updated.id)
          if (idx === -1) return [...prev, updated]
          const next = [...prev]
          next[idx] = updated
          return next
        })
        if (updated.user_id === myPlayer.user_id) {
          if (isMovingRef.current) {
            setMyPlayer((prev: any) => ({ ...updated, pos_x: prev.pos_x, pos_y: prev.pos_y }))
          } else {
            setMyPlayer(updated)
          }
          setAp(calculateCurrentAP(updated.ap, updated.ap_updated_at))
          setHunger(calculateCurrentHunger(updated.hunger ?? 100, updated.hunger_updated_at ?? new Date().toISOString(), updated.traits ?? []))
          setThirst(calculateCurrentThirst(updated.thirst ?? 100, updated.thirst_updated_at ?? new Date().toISOString(), updated.traits ?? []))
        }
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'events',
        filter: `game_id=eq.${game.id}`,
      }, (payload: any) => {
        const ev = payload.new
        if (ev?.game_id !== game.id) return
        setEvents(prev => [ev as GameEvent, ...prev].slice(0, 100))
        if (ev.event_type === 'ชนะ') {
          setWinnerModal({
            name: ev.data?.winner_name ?? '?',
            killCount: ev.data?.kill_count ?? 0,
            studentNumber: ev.data?.student_number ?? 0,
          })
        }
        if (ev.event_type === 'ตาย') {
          setAllPlayers(prev => {
            const deadPlayer = prev.find((p: any) => p.id === (ev.target_id ?? ev.actor_id))
            const aliveCount = prev.filter((p: any) => p.is_alive && p.id !== (ev.target_id ?? ev.actor_id)).length
            
            let killerName = undefined;
            if (ev.actor_id && ev.actor_id !== (ev.target_id ?? ev.actor_id)) {
              const killer = prev.find((p: any) => p.id === ev.actor_id);
              if (killer) killerName = killer.name;
            }

            setDeathModal({
              name: deadPlayer?.name ?? ev.data?.name ?? 'ผู้เล่น',
              killer: killerName,
              studentNumber: deadPlayer?.student_number,
              gender: deadPlayer?.gender,
              photoUrl: deadPlayer?.photo_url,
              aliveCount,
            })
            setTimeout(() => setDeathModal(null), 5000)
            return prev
          })
        }
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'grid_states',
        filter: `game_id=eq.${game.id}`,
      }, (payload: any) => {
        const updated = payload.new
        if (!updated || updated.game_id !== game.id) return
        setGridStates(prev => {
          const idx = prev.findIndex((g: any) => g.x === updated.x && g.y === updated.y)
          if (idx === -1) return [...prev, updated]
          const next = [...prev]
          next[idx] = updated
          return next
        })
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'games',
        filter: `id=eq.${game.id}`,
      }, (payload: any) => {
        const g = payload.new as Game
        if (g?.id !== game.id) return
        if (g.status === 'จบแล้ว') {
          ;(async () => {
            const { data } = await (supabase as any).from('events')
              .select('data')
              .eq('game_id', game.id)
              .eq('event_type', 'ชนะ')
              .order('occurred_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            if (data?.data) {
              setWinnerModal({
                name: data.data.winner_name,
                killCount: data.data.kill_count ?? 0,
                studentNumber: data.data.student_number ?? 0,
              })
            } else {
              router.push('/lobby')
            }
          })()
        }
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'announcements',
        filter: `game_id=eq.${game.id}`,
      }, (payload: any) => {
        const ann = payload.new
        if (ann?.game_id !== game.id) return
        if (ann.target_id && ann.target_id !== myPlayer.id) return
        const key = `dismissed_ann_${game.id}`
        const dismissed: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
        setAnnouncements(prev => [ann, ...prev].slice(0, 20))
        if (!dismissed.includes(ann.id)) {
          setToastAnns(prev => [ann, ...prev].slice(0, 10))
          // ทำให้มือถือสั่นถ้าประกาศส่วนตัว
          if (ann.ann_type === 'ส่วนตัว' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            navigator.vibrate([200, 100, 200])
          }
        }
      })
      .subscribe()

    // ── channel แยกสำหรับ alliance_invites (filter ด้วย to_player_id) ──
    const inviteChannel = supabase.channel(`invites-${myPlayer.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'alliance_invites',
        filter: `to_player_id=eq.${myPlayer.id}`,
      }, (payload: any) => {
        const invData: any = payload.new
        ;(async () => {
          const { data } = await (supabase as any).from('players').select('name').eq('id', invData.from_player_id).single()
          setPendingInvites(prev => {
            if (prev.some((p: any) => p.id === invData.id)) return prev
            return [...prev, { ...invData, from_player: { name: data?.name ?? '?' } }]
          })
        })()
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'alliances',
        filter: `game_id=eq.${game.id}`,
      }, (payload: any) => {
        const al = payload.new
        // ตรวจว่า myPlayer อยู่ใน members ของ alliance นี้
        const isMember = (al?.members as string[] ?? []).includes(myPlayer.id)
        if (!isMember && al?.id !== myAlliance?.id) return
        if (al.disbanded_at) {
          setMyAlliance(null)
          setMyPlayer(prev => ({ ...prev, alliance_id: null }))
        } else {
          setMyAlliance(al)
          // sync alliance_id ใน myPlayer ด้วย
          setMyPlayer(prev => ({ ...prev, alliance_id: al.id }))
        }
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      supabase.removeChannel(inviteChannel)
    }
  }, [game.id, myPlayer.user_id, router, supabase])

  // ── Helper ──────────────────────────────────────────────────
  const gridMap = new Map(grids.map(g => [`${g.x},${g.y}`, g]))
  const gsMap = new Map(gridStates.map(g => [`${g.x},${g.y}`, g]))

  const visRange = useMemo(() => {
    if (myPlayer.pos_x === null) return 0
    const base = gridMap.get(`${myPlayer.pos_x},${myPlayer.pos_y}`)?.visibility ?? 2
    const itemBonus = (myPlayer.inventory ?? []).reduce((sum: number, inv: any) => {
      const def = itemDefs.find(d => d.id === inv.id)
      return sum + ((def?.data as any)?.visibility_bonus ?? 0)
    }, 0)
    const traitBonus = (myPlayer.traits ?? []).reduce((sum: number, traitId: string) => {
      const def = traits.find(t => t.id === traitId)
      return sum + ((def?.special_effects?.visibility_bonus as number) ?? 0)
    }, 0)
    return base + itemBonus + traitBonus
  }, [myPlayer.pos_x, myPlayer.pos_y, myPlayer.inventory, myPlayer.traits, gridMap, itemDefs, traits])

  const visibleCells = useMemo(() => {
    if (myPlayer.pos_x === null) return new Set<string>()
    return new Set(cellsInRange(myPlayer.pos_x ?? 0, myPlayer.pos_y ?? 0, visRange).map(c => `${c.x},${c.y}`))
  }, [myPlayer.pos_x, myPlayer.pos_y, visRange])

  const allyIds = useMemo(
    () => myAlliance?.members?.filter((id: string) => id !== myPlayer.id) ?? [],
    [myAlliance, myPlayer.id]
  )

  // ── Actions ─────────────────────────────────────────────────
  const [actionMsg, setActionMsg] = useState<{text:string, ok:boolean}|null>(null)

  function notify(text: string, ok = true) {
    setActionMsg({ text, ok })
    setTimeout(() => setActionMsg(null), 3000)
  }

  // ── Alliance Actions ────────────────────────────────────────
  async function doInvite(to_player_id: string) {
    const res = await fetch('/api/action/alliance/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, to_player_id }),
    })
    const data = await res.json()
    if (!data.ok) notify(data.error, false)
    else notify(data.msg)
  }

  async function doRequestJoin(alliance_id: string) {
    const res = await fetch('/api/action/alliance/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, alliance_id }),
    })
    const data = await res.json()
    if (!data.ok) notify(data.error, false)
    else notify(data.msg)
  }

  async function doTransferLeader(new_leader_id: string) {
    const res = await fetch('/api/action/alliance/transfer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, new_leader_id }),
    })
    const data = await res.json()
    if (!data.ok) notify(data.error, false)
    else {
      // อัปเดต alliance state
      setMyAlliance((prev: any) => prev ? { ...prev, leader_id: new_leader_id } : prev)
      notify(data.msg)
    }
  }

  async function doAcceptInvite(invite_id: string) {
    const res = await fetch('/api/action/alliance/accept', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, invite_id }),
    })
    const data = await res.json()
    if (!data.ok) { notify(data.error, false); return }
    // อัปเดต alliance state
    const { data: alliance } = await (supabase as any).from('alliances').select('*').eq('id', data.alliance_id).single()
    if (alliance) setMyAlliance(alliance)
    setMyPlayer(prev => ({ ...prev, alliance_id: data.alliance_id }))
    setPendingInvites(prev => prev.filter(i => i.id !== invite_id))
    notify(data.msg)
  }

  async function doDeclineInvite(invite_id: string) {
    await (supabase as any).from('alliance_invites').delete().eq('id', invite_id)
    setPendingInvites(prev => prev.filter(i => i.id !== invite_id))
    notify('ปฏิเสธคำชวนแล้ว')
  }

  async function doLeaveAlliance() {
    if (!confirm('ยืนยันออกจากกลุ่ม?')) return
    const res = await fetch('/api/action/alliance/leave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id }),
    })
    const data = await res.json()
    if (!data.ok) { notify(data.error, false); return }
    setMyAlliance(null)
    setMyPlayer(prev => ({ ...prev, alliance_id: null }))
    notify(data.msg)
  }

  async function doBetray() {
    if (!confirm('⚠️ ยืนยันทรยศกลุ่ม?\n\nกลุ่มจะถูกยุบทันที')) return
    const res = await fetch('/api/action/alliance/betray', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id }),
    })
    const data = await res.json()
    if (!data.ok) { notify(data.error, false); return }
    setMyAlliance(null)
    setMyPlayer(prev => ({ ...prev, alliance_id: null }))
    notify(data.msg, false)
  }

  async function doMove(x: number, y: number) {
    if (!myPlayer.is_alive) return

    // Optimistic update — อัปเดต UI ทันทีก่อน API ตอบ
    const prevPos = { x: myPlayer.pos_x, y: myPlayer.pos_y }
    isMovingRef.current = true
    setMyPlayer(prev => ({ ...prev, pos_x: x, pos_y: y }))
    setAllPlayers(prev => prev.map(p =>
      p.id === myPlayer.id ? { ...p, pos_x: x, pos_y: y } : p
    ))

    const res = await fetch('/api/action/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, x, y }),
    })
    const data = await res.json()

    if (!data.ok) {
      // rollback ถ้า error
      setMyPlayer(prev => ({ ...prev, pos_x: prevPos.x, pos_y: prevPos.y }))
      setAllPlayers(prev => prev.map(p =>
        p.id === myPlayer.id ? { ...p, pos_x: prevPos.x, pos_y: prevPos.y } : p
      ))
      notify(data.error, false)
    } else {
      // หัก AP ตามที่ server บอก (หนองน้ำ = 35, ปกติ = 20)
      const cost = data.ap_cost ?? 20
      setAp(prev => Math.max(0, prev - cost))
      if (data.swamp) notify('⚠️ หนองน้ำ — เดินช้าลง AGI ลดชั่วคราว')
      if (data.forbidden) {
        notify(`🚫 เขตอันตราย! เสีย HP 80% (HP เหลือ ${data.hp ?? '?'})`, false)
        if (data.hp !== undefined) setMyPlayer(prev => ({ ...prev, hp: data.hp, is_alive: data.hp > 0 }))
      }
    }
    isMovingRef.current = false
  }

  async function doSearch(atX?: number, atY?: number) {
    if (!myPlayer.is_alive) return
    // ใช้ pos ที่ส่งมา (จาก selectedCell) ถ้าไม่มีก็ใช้จาก myPlayer
    const px = atX ?? myPlayer.pos_x
    const py = atY ?? myPlayer.pos_y

    // ตรวจ cooldown จาก localStorage รายผู้เล่นต่อช่อง
    const thaiHour = (new Date().getUTCHours() + 7) % 24
    const cdMins = (thaiHour >= 19 || thaiHour < 7) ? 20 : 60
    const cdKey = `search_${myPlayer.id}_${px}_${py}`
    const lastSearched = localStorage.getItem(cdKey)
    if (lastSearched) {
      const minsSince = (Date.now() - parseInt(lastSearched)) / 60_000
      if (minsSince < cdMins) {
        const minsLeft = Math.ceil(cdMins - minsSince)
        notify(`ค้นพื้นที่นี้แล้ว รอ ${minsLeft} นาทีอีกครั้ง`, false)
        return
      }
    }

    const res = await fetch('/api/action/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id }),
    })
    const data = await res.json()
    if (!data.ok) { notify(data.error, false); return }
    const found = data.found as Array<{id:string,qty:number}>
    // บันทึก cooldown รายผู้เล่นต่อช่อง
    localStorage.setItem(cdKey, Date.now().toString())

    if (found.length === 0) notify('ค้นแล้วไม่พบสิ่งใด')
    else notify(`พบ: ${found.map(f => `${f.id}×${f.qty}`).join(', ')}`)
  }

  async function doCraft(recipe_id: string) {
    if (!myPlayer.is_alive) return
    const res = await fetch('/api/action/craft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, recipe_id }),
    })
    const data = await res.json()
    if (!data.ok) { notify(data.error, false); return }
    if (data.ap !== undefined) {
      setAp(data.ap)
      setMyPlayer(prev => ({ ...prev, ap: data.ap, ap_updated_at: new Date().toISOString() }))
    }
    notify(data.msg)
  }

  async function doDrop(item_id: string, qty: number) {
    if (!myPlayer.is_alive) return
    const res = await fetch('/api/action/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, item_id, qty }),
    })
    const data = await res.json()
    if (!data.ok) notify(data.error, false)
    else notify(data.msg)
  }

  async function doHeal(item_id: string) {
    if (!myPlayer.is_alive) return
    const res = await fetch('/api/action/heal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, item_id }),
    })
    const data = await res.json()
    if (!data.ok) { notify(data.error, false); return }

    // Optimistic update จาก response
    const now = new Date().toISOString()
    if (data.hunger !== undefined) {
      setHunger(data.hunger)
      setMyPlayer(prev => ({ ...prev, hunger: data.hunger, hunger_updated_at: now }))
    }
    if (data.thirst !== undefined) {
      setThirst(data.thirst)
      setMyPlayer(prev => ({ ...prev, thirst: data.thirst, thirst_updated_at: now }))
    }
    if (data.hp !== undefined) {
      setMyPlayer(prev => ({ ...prev, hp: data.hp }))
    }
    if (data.ap !== undefined) {
      setAp(data.ap)
      setMyPlayer(prev => ({ ...prev, ap: data.ap, ap_updated_at: new Date().toISOString() }))
    }
    if (data.int !== undefined) {
      setMyPlayer(prev => ({ ...prev, int: data.int }))
    }
    notify(data.msg)
  }

  async function doUseItem(item_id: string) {
    if (!myPlayer.is_alive) return
    const res = await fetch('/api/action/use', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, player_id: myPlayer.id, item_id }),
    })
    const data = await res.json()
    if (!data.success) { notify(data.error, false); return }
    notify(data.message)
  }

  async function doAttack(target_player_id: string, weapon_id?: string) {
    if (!myPlayer.is_alive) return
    const res = await fetch('/api/action/attack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: game.id, target_player_id, weapon_id }),
    })
    const data = await res.json()
    if (!data.ok) notify(data.error, false)
    else notify(data.msg, !data.dodged)
  }

  async function sendChat() {
    if (!chatMsg.trim() || !myPlayer.is_alive) return
    const msg = chatMsg.trim()
    setChatMsg('')

    // insert DB — postgres_changes จะ trigger ChatMessages realtime
    await (supabase as any).from('chat_messages').insert({
      game_id: game.id,
      player_id: myPlayer.id,
      channel: chatTab,
      pos_x: myPlayer.pos_x,
      pos_y: myPlayer.pos_y,
      alliance_id: chatTab === 'พันธมิตร' ? myAlliance?.id ?? null : null,
      message: msg,
    })
  }

  // ── HP/AP bar color ─────────────────────────────────────────
  const hpPct = (myPlayer.hp / myPlayer.max_hp) * 100
  const hpClass = hpPct > 60 ? 'hp-fill-high' : hpPct > 30 ? 'hp-fill-mid' : 'hp-fill-low'

  // ── Render ───────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {/* ── TOP BAR ── */}
      <div style={s.topBar}>
        <Image src="https://iili.io/BfyEfSI.png" alt="" width={20} height={20} unoptimized priority
          style={{ filter: 'drop-shadow(0 0 4px rgba(139,0,0,0.8))' }} />
        <span style={s.topTitle}>BR ACT</span>
        <span style={{ color: 'var(--text-secondary)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
          วัน {game.started_at && mounted ? Math.min(4, Math.ceil((Date.now() - new Date(game.started_at).getTime()) / 86_400_000)) : 1}/4
        </span>
        {timeLeft && (
          <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: timeLeft === 'หมดเวลา' ? 'var(--red-bright)' : 'var(--text-gold)' }}>
            ⏱ {timeLeft}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '12px', color: isCombat ? 'var(--red-bright)' : 'var(--text-secondary)', border: `1px solid ${isCombat ? 'var(--red-bright)' : 'var(--border)'}`, padding: '2px 8px' }}>
          {isCombat ? '⚔ เวลาต่อสู้' : `🛡 ต่อสู้ได้ใน ${combatCountdown}`}
        </span>
        <span style={{ fontSize: '12px', color: myPlayer.is_alive ? 'var(--green-bright)' : 'var(--red-danger)' }}>
          {myPlayer.is_alive ? '● มีชีวิต' : '✕ ตาย'}
        </span>
        <button onClick={() => setShowPlayerList(p => !p)} style={{
          ...s.logoutBtn, borderColor: showPlayerList ? 'var(--red-bright)' : 'var(--border)',
          color: showPlayerList ? 'var(--red-bright)' : 'var(--text-secondary)',
        }}>👥 ผู้เล่น</button>
        <button onClick={() => { fetch('/api/auth/logout', { method: 'POST' }).then(() => router.push('/login')) }}
          style={s.logoutBtn}>ออก</button>
      </div>

      {/* ── Attack Modal — เลือกอาวุธ ── */}
      {attackTarget && (() => {
        const target = allPlayers.find(p => p.id === attackTarget)
        const dist = target && myPlayer.pos_x !== null && target.pos_x !== null
          ? Math.max(Math.abs(myPlayer.pos_x - target.pos_x), Math.abs((myPlayer.pos_y ?? 0) - (target.pos_y ?? 0)))
          : 0
        const weapons = myPlayer.inventory.filter((item: any) => {
          const def = itemDefs.find(d => d.id === item.id)
          if (def?.category !== 'อาวุธ') return false
          const range = (def?.data as any)?.range ?? 1
          return range >= dist // แสดงเฉพาะอาวุธที่ระยะถึง
        })
        return (
          <div style={{
            position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:200,
            display:'flex', alignItems:'center', justifyContent:'center',
          }} onClick={() => { setAttackTarget(null); setSelectedWeapon(null) }}>
            <div onClick={e => e.stopPropagation()} style={{
              background:'var(--bg-secondary)', border:'1px solid var(--red-blood)',
              padding:'20px', width:'320px', maxWidth:'90vw',
            }}>
              <div style={{ fontFamily:'var(--font-display)', fontSize:'14px', color:'var(--red-bright)', marginBottom:'4px', letterSpacing:'0.1em' }}>
                ⚔ โจมตี {target?.name}
              </div>
              <div style={{ fontSize:'12px', color:'var(--text-secondary)', marginBottom:'12px', display:'flex', gap:'12px' }}>
                <span>HP: {target?.hp}/{target?.max_hp}</span>
                <span>ระยะห่าง: {dist} ช่อง</span>
              </div>

              {/* เลือกอาวุธ */}
              <div style={{ fontSize:'11px', color:'var(--text-secondary)', marginBottom:'6px', letterSpacing:'0.08em', textTransform:'uppercase' }}>เลือกอาวุธ</div>
              <div style={{ display:'flex', flexDirection:'column', gap:'4px', marginBottom:'12px', maxHeight:'200px', overflow:'auto' }}>
                {/* มือเปล่า — แสดงเฉพาะถ้าอยู่ติดกัน */}
                {dist <= 1 && (
                  <div onClick={() => setSelectedWeapon(null)}
                    style={{ padding:'8px', border:`1px solid ${selectedWeapon === null ? 'var(--red-bright)' : 'var(--border)'}`, cursor:'pointer', background: selectedWeapon === null ? 'rgba(139,0,0,0.15)' : 'var(--bg-tertiary)', display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:'12px' }}>👊 มือเปล่า</span>
                    <span style={{ fontSize:'11px', color:'var(--text-secondary)', fontFamily:'var(--font-mono)' }}>DMG 10 | AP 30 | ระยะ 1</span>
                  </div>
                )}
                {weapons.map((item: any) => {
                  const def = itemDefs.find(d => d.id === item.id)
                  const dmg = (def?.data as any)?.damage ?? '?'
                  const ap = (def?.data as any)?.ap_cost ?? 30
                  const crit = (def?.data as any)?.crit_chance ?? 0
                  const range = (def?.data as any)?.range ?? 1
                  const isSelected = selectedWeapon === item.id
                  return (
                    <div key={item.id} onClick={() => setSelectedWeapon(item.id)}
                      style={{ padding:'8px', border:`1px solid ${isSelected ? 'var(--red-bright)' : 'var(--border)'}`, cursor:'pointer', background: isSelected ? 'rgba(139,0,0,0.15)' : 'var(--bg-tertiary)' }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'2px' }}>
                        <span style={{ fontSize:'12px', color:'var(--red-bright)' }}>⚔ {def?.name ?? item.id}</span>
                        <span style={{ fontSize:'11px', color:'var(--text-secondary)', fontFamily:'var(--font-mono)' }}>DMG {dmg} | AP {ap}</span>
                      </div>
                      <div style={{ fontSize:'10px', color:'var(--text-secondary)' }}>
                        คริต {crit}% | ระยะ {range} ช่อง
                        {(def?.data as any)?.bleed_chance ? ` | เลือดออก ${(def?.data as any).bleed_chance}%` : ''}
                        {(def?.data as any)?.stun_chance ? ` | มึนงง ${(def?.data as any).stun_chance}%` : ''}
                      </div>
                    </div>
                  )
                })}
                {weapons.length === 0 && dist > 1 && (
                  <div style={{ fontSize:'12px', color:'var(--text-secondary)', padding:'8px', textAlign:'center' }}>
                    ไม่มีอาวุธที่ระยะถึง {dist} ช่อง
                  </div>
                )}
              </div>

              <div style={{ display:'flex', gap:'8px' }}>
                <button onClick={async () => {
                  // ถ้าไม่มีอาวุธระยะถึงและไม่ได้เลือกอาวุธ ให้ block
                  if (dist > 1 && !selectedWeapon) { notify('ต้องเลือกอาวุธที่ระยะถึงก่อน', false); return }
                  await doAttack(attackTarget, selectedWeapon ?? undefined)
                  setAttackTarget(null)
                  setSelectedWeapon(null)
                }} style={{
                  flex:1, padding:'10px', background:'rgba(139,0,0,0.4)',
                  border:'1px solid var(--red-bright)', color:'var(--red-bright)',
                  fontSize:'13px', cursor:'pointer', fontFamily:'var(--font-body)',
                }}>⚔ ยืนยันโจมตี</button>
                <button onClick={() => { setAttackTarget(null); setSelectedWeapon(null) }} style={{
                  padding:'10px 16px', background:'none',
                  border:'1px solid var(--border)', color:'var(--text-secondary)',
                  fontSize:'13px', cursor:'pointer', fontFamily:'var(--font-body)',
                }}>ยกเลิก</button>
              </div>
            </div>
          </div>
        )
      })()}

      {actionMsg && (
        <div style={{
          position:'fixed', top:'48px', left:'50%', transform:'translateX(-50%)',
          padding:'8px 20px', zIndex:100,
          background: actionMsg.ok ? 'rgba(45,90,39,0.95)' : 'rgba(139,0,0,0.95)',
          border: `1px solid ${actionMsg.ok ? 'var(--green-bright)' : 'var(--red-bright)'}`,
          color: actionMsg.ok ? 'var(--green-bright)' : 'var(--red-bright)',
          fontSize:'13px', fontFamily:'var(--font-body)',
        }}>
          {actionMsg.text}
        </div>
      )}

      {/* ── Death Modal ── */}
      {deathModal && (
        <div style={{
          position:'fixed', inset:0, zIndex:300,
          display:'flex', alignItems:'center', justifyContent:'center',
          background:'rgba(0,0,0,0.75)',
          pointerEvents:'auto',
        }} onClick={() => setDeathModal(null)}>
          <div style={{
            background:'rgba(8,0,0,0.97)', border:'2px solid var(--red-bright)',
            padding:'28px 36px', textAlign:'center', maxWidth:'320px', width:'90vw',
            boxShadow:'0 0 60px rgba(139,0,0,0.5)',
            animation:'fadeIn 0.3s ease',
          }}>
            {/* รูปขาวดำ */}
            <div style={{ width:'80px', height:'80px', borderRadius:'50%', margin:'0 auto 14px', overflow:'hidden', border:'2px solid var(--red-bright)', background:'var(--bg-tertiary)', flexShrink:0 }}>
              {deathModal.photoUrl ? (
                <img
                  src={deathModal.photoUrl}
                  alt={deathModal.name}
                  style={{ width:'100%', height:'100%', objectFit:'cover', filter:'grayscale(100%) brightness(0.7)' }}
                />
              ) : (
                <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'28px', color:'var(--text-secondary)', filter:'grayscale(100%)' }}>
                  {deathModal.gender === 'หญิง' ? '♀' : '♂'}
                </div>
              )}
            </div>

            {/* เลขที่และเพศ */}
            {deathModal.studentNumber && (
              <div style={{ fontFamily:'var(--font-mono)', fontSize:'11px', color:'var(--text-secondary)', marginBottom:'4px', letterSpacing:'0.1em' }}>
                นักเรียน{deathModal.gender === 'หญิง' ? 'หญิง' : 'ชาย'}เลขที่ {String(deathModal.studentNumber).padStart(2,'0')}
              </div>
            )}

            {/* ชื่อ */}
            <div style={{ fontFamily:'var(--font-display)', fontSize:'16px', color:'var(--text-primary)', letterSpacing:'0.1em', marginBottom:'10px' }}>
              {deathModal.name}
            </div>

            {/* เสียชีวิต */}
            <div style={{ fontFamily:'var(--font-display)', fontSize:'13px', color:'var(--red-bright)', letterSpacing:'0.2em', marginBottom:'10px' }}>
              เสียชีวิต
            </div>

            {deathModal.killer && (
              <div style={{ fontSize:'11px', color:'var(--text-secondary)', borderTop:'1px solid var(--border)', paddingTop:'8px', marginBottom: '8px' }}>
                ถูกสังหารโดย <span style={{ color:'var(--red-bright)' }}>{deathModal.killer}</span>
              </div>
            )}

            {/* เหลือกี่คน */}
            {deathModal.aliveCount !== undefined && (
              <div style={{ fontSize:'11px', color:'var(--text-secondary)', fontFamily:'var(--font-mono)', borderTop: !deathModal.killer ? '1px solid var(--border)' : 'none', paddingTop: !deathModal.killer ? '8px' : '0' }}>
                เหลือผู้รอดชีวิต {deathModal.aliveCount} คน
              </div>
            )}

            <div style={{ fontSize:'10px', color:'rgba(255,255,255,0.2)', marginTop:'10px' }}>
              กดที่ใดก็ได้เพื่อปิด
            </div>
          </div>
        </div>
      )}

      {/* ── Winner Modal ── */}
      {winnerModal && (
        <div style={{
          position:'fixed', inset:0, zIndex:400,
          display:'flex', alignItems:'center', justifyContent:'center',
          background:'rgba(0,0,0,0.85)',
        }}>
          <div style={{
            background:'rgba(10,0,0,0.98)', border:'2px solid var(--text-gold)',
            padding:'40px 56px', textAlign:'center', maxWidth:'360px', width:'90vw',
            boxShadow:'0 0 60px rgba(180,140,0,0.4)',
            animation:'fadeIn 0.4s ease',
          }}>
            <div style={{ fontSize:'48px', marginBottom:'12px' }}>👑</div>
            <div style={{ fontFamily:'var(--font-display)', fontSize:'13px', color:'var(--text-gold)', letterSpacing:'0.25em', marginBottom:'8px' }}>
              ผู้รอดชีวิตคนสุดท้าย
            </div>
            <div style={{ fontFamily:'var(--font-display)', fontSize:'24px', color:'var(--text-primary)', letterSpacing:'0.1em', marginBottom:'4px' }}>
              {winnerModal.name}
            </div>
            <div style={{ fontSize:'13px', color:'var(--text-secondary)', fontFamily:'var(--font-mono)', marginBottom:'24px' }}>
              เลขที่ {String(winnerModal.studentNumber).padStart(2,'0')} · สังหาร {winnerModal.killCount} คน
            </div>
            <div style={{ width:'100%', height:'1px', background:'var(--border)', marginBottom:'20px' }} />
            <div style={{ fontSize:'12px', color:'var(--text-secondary)', marginBottom:'20px' }}>
              เกมจบแล้ว
            </div>
            <button
              onClick={() => router.push('/lobby')}
              style={{
                background:'var(--text-gold)', color:'#000', border:'none',
                padding:'10px 32px', fontSize:'13px', fontFamily:'var(--font-display)',
                letterSpacing:'0.1em', cursor:'pointer',
              }}
            >
              กลับหน้าหลัก
            </button>
          </div>
        </div>
      )}

      {/* ── Player Info Modal (กดจาก zoomed map) ── */}
      {selectedPlayerInfo && (
        <div style={{
          position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:250,
          display:'flex', alignItems:'center', justifyContent:'center',
        }} onClick={() => setSelectedPlayerInfo(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            background:'var(--bg-secondary)', border:'1px solid var(--red-blood)',
            padding:'20px', width:'280px', maxWidth:'90vw',
          }}>
            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'14px' }}>
              <div style={{ width:'40px', height:'40px', borderRadius:'50%', border:'1.5px solid var(--red-bright)', overflow:'hidden', flexShrink:0, background:'var(--bg-tertiary)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                {selectedPlayerInfo.photo_url ? (
                  <img src={selectedPlayerInfo.photo_url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover', borderRadius:'50%' }} />
                ) : (
                  <span style={{ fontSize:'16px', color:'var(--red-bright)' }}>{selectedPlayerInfo.name.charAt(0)}</span>
                )}
              </div>
              <div>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:'11px', color:'var(--text-secondary)' }}>
                  #{String(selectedPlayerInfo.student_number ?? '?').padStart(2,'0')}
                </div>
                <div style={{ fontSize:'14px', fontWeight:600, color:'var(--text-primary)' }}>
                  {selectedPlayerInfo.name}
                </div>
              </div>
              <button onClick={() => setSelectedPlayerInfo(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'var(--text-secondary)', cursor:'pointer', fontSize:'14px' }}>✕</button>
            </div>

            {/* HP bar */}
            <div style={{ marginBottom:'10px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:'12px', marginBottom:'3px' }}>
                <span style={{ color:'var(--text-secondary)' }}>HP</span>
                <span style={{ fontFamily:'var(--font-mono)', color:'var(--text-primary)' }}>
                  {selectedPlayerInfo.hp}/{selectedPlayerInfo.max_hp}
                </span>
              </div>
              <div style={{ height:'6px', background:'var(--bg-primary)', border:'1px solid var(--border)', borderRadius:'2px' }}>
                <div style={{
                  height:'100%', borderRadius:'2px',
                  width:`${Math.round((selectedPlayerInfo.hp / selectedPlayerInfo.max_hp) * 100)}%`,
                  background: selectedPlayerInfo.hp / selectedPlayerInfo.max_hp > 0.6 ? 'var(--green-bright)'
                    : selectedPlayerInfo.hp / selectedPlayerInfo.max_hp > 0.3 ? '#E67E22' : 'var(--red-bright)',
                }} />
              </div>
            </div>

            {/* ตำแหน่ง */}
            <div style={{ fontSize:'12px', color:'var(--text-secondary)', marginBottom:'10px', fontFamily:'var(--font-mono)' }}>
              📍 [{selectedPlayerInfo.pos_x},{selectedPlayerInfo.pos_y}]
              {allyIds.includes(selectedPlayerInfo.id) && (
                <span style={{ marginLeft:'8px', color:'var(--green-bright)', fontSize:'11px' }}>● พันธมิตร</span>
              )}
            </div>

            {/* โชว์อาวุธที่ถืออยู่ */}
            {(() => {
              const eqWeapons = (selectedPlayerInfo.inventory || []).filter((invItem: any) => {
                const def = itemDefs.find(d => d.id === invItem.id);
                return def?.category === 'อาวุธ';
              });
              return (
                <div style={{ marginBottom: '10px', padding: '8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize:'11px', color:'var(--text-gold)', letterSpacing:'0.05em', marginBottom:'4px' }}>อาวุธที่พกพา</div>
                  {eqWeapons.length > 0 ? (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:'4px' }}>
                      {eqWeapons.map((w: any) => (
                        <span key={w.id} style={{ fontSize:'11px', padding:'2px 6px', background:'rgba(139,0,0,0.15)', border:'1px solid var(--red-bright)', color:'var(--red-bright)' }}>
                          ⚔ {w.id}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize:'11px', color:'var(--text-secondary)' }}>มือเปล่า / ไม่พบอาวุธ</div>
                  )}
                </div>
              )
            })()}

            {/* Traits */}
            {selectedPlayerInfo.traits && selectedPlayerInfo.traits.length > 0 && (
              <div>
                <div style={{ fontSize:'11px', color:'var(--text-secondary)', letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:'6px' }}>นิสัย</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:'4px' }}>
                  {selectedPlayerInfo.traits.map((traitId: string) => {
                    const def = traits.find(t => t.id === traitId)
                    const isNeg = def?.type === 'ลบ'
                    return (
                      <span key={traitId} style={{
                        padding:'2px 7px', border:'1px solid', fontSize:'11px',
                        borderColor: isNeg ? 'var(--red-bright)' : 'var(--border-bright)',
                        color: isNeg ? 'var(--red-bright)' : 'var(--text-secondary)',
                        background:'var(--bg-tertiary)',
                      }}>{traitId}</span>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Alliance Invite Notifications ── */}
      {pendingInvites.length > 0 && (
        <div style={{ position:'fixed', top:'56px', left:'50%', transform:'translateX(-50%)', zIndex:110, display:'flex', flexDirection:'column', gap:'6px', width:'320px', maxWidth:'95vw' }}>
          {pendingInvites.map(inv => (
            <div key={inv.id} style={{ background:'rgba(10,30,10,0.97)', border:'1px solid var(--green-bright)', padding:'12px 14px', display:'flex', flexDirection:'column', gap:'8px' }}>
              <div style={{ fontSize:'13px', color:'var(--text-primary)' }}>
                {inv.invite_type === 'request'
                  ? <><span style={{ color:'var(--text-gold)', fontWeight:600 }}>📨 {inv.from_player?.name ?? '?'}</span> ขอเข้าร่วมกลุ่มของคุณ</>
                  : <><span style={{ color:'var(--green-bright)', fontWeight:600 }}>🤝 {inv.from_player?.name ?? '?'}</span> {inv.alliance_id ? 'ชวนเข้ากลุ่ม' : 'ชวนรวมกลุ่ม'}</>
                }
              </div>
              <div style={{ display:'flex', gap:'6px' }}>
                <button onClick={() => doAcceptInvite(inv.id)} style={{ flex:1, padding:'6px', background:'rgba(0,100,0,0.5)', border:'1px solid var(--green-bright)', color:'var(--green-bright)', fontSize:'12px', cursor:'pointer', fontFamily:'var(--font-body)' }}>
                  ✅ ยอมรับ
                </button>
                <button onClick={() => doDeclineInvite(inv.id)} style={{ flex:1, padding:'6px', background:'none', border:'1px solid var(--border)', color:'var(--text-secondary)', fontSize:'12px', cursor:'pointer', fontFamily:'var(--font-body)' }}>
                  ✕ ปฏิเสธ
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Announcements ── */}
      {toastAnns.length > 0 && (
        <div style={{ position:'fixed', top:'56px', right:'16px', zIndex:99, display:'flex', flexDirection:'column', gap:'6px', maxWidth:'360px' }}>
          {toastAnns.map((ann, i) => {
            const isTeacher = ann.ann_type === 'อาจารย์ผู้ควบคุม'
            const isPrivate = ann.ann_type === 'ส่วนตัว'
            const bg = isTeacher ? 'rgba(139,0,0,0.95)' : isPrivate ? 'rgba(45,60,100,0.95)' : 'rgba(20,30,20,0.95)'
            const border = isTeacher ? 'var(--red-bright)' : isPrivate ? '#5A80CC' : 'var(--border-bright)'
            const icon = isTeacher ? '📢' : isPrivate ? '✉️' : '📣'
            return (
              <div key={i} style={{ background: bg, border: `1px solid ${border}`, padding:'10px 14px', fontSize:'13px', fontFamily:'var(--font-body)', lineHeight:1.5 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'8px' }}>
                  <div>
                    <span style={{ color: border, fontWeight:700, marginRight:'6px' }}>{icon} {ann.ann_type}</span>
                    <span style={{ color:'var(--text-primary)' }}>{ann.message}</span>
                  </div>
                  <button onClick={() => {
                      // เก็บ dismissed ids ใน localStorage
                      const key = `dismissed_ann_${game.id}`
                      const dismissed = JSON.parse(localStorage.getItem(key) ?? '[]')
                      dismissed.push(ann.id)
                      localStorage.setItem(key, JSON.stringify(dismissed))
                      setToastAnns(prev => prev.filter((_, j) => j !== i))
                    }}
                    style={{ background:'none', border:'none', color:'var(--text-secondary)', cursor:'pointer', fontSize:'14px', flexShrink:0, padding:0 }}>✕</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* รายชื่อผู้เล่น overlay */}
      {showPlayerList && (
        <div style={{
          position: 'fixed', top: '40px', right: '0', zIndex: 150,
          width: '220px', maxHeight: 'calc(100vh - 40px)',
          background: 'var(--bg-secondary)', borderLeft: '1px solid var(--red-blood)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
        }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(139,0,0,0.1)', flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '12px', color: 'var(--red-bright)', letterSpacing: '0.1em' }}>
              👥 รายชื่อ
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)' }}>
              รอด {allPlayers.filter(p => p.is_alive).length}/{allPlayers.length}
            </span>
          </div>
          <div style={{ overflow: 'auto', flex: 1 }}>
            {[...allPlayers].sort((a, b) => (a.student_number ?? 0) - (b.student_number ?? 0)).map(p => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '5px 12px',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                background: p.id === myPlayer.id ? 'rgba(139,0,0,0.12)' : 'transparent',
                opacity: p.is_alive ? 1 : 0.4,
              }}>
                <div style={{ width:'24px', height:'24px', borderRadius:'50%', border:`1px solid ${p.id === myPlayer.id ? 'var(--text-gold)' : allyIds.includes(p.id) ? 'var(--green-bright)' : 'var(--border)'}`, overflow:'hidden', flexShrink:0, background:'var(--bg-tertiary)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {p.photo_url ? (
                    <img src={p.photo_url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover', borderRadius:'50%' }} />
                  ) : (
                    <span style={{ fontSize:'10px', color:'var(--text-secondary)' }}>{p.name.charAt(0)}</span>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', width: '22px', flexShrink: 0 }}>
                  {String(p.student_number ?? '?').padStart(2, '0')}
                </span>
                <span style={{ fontSize: '13px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: p.id === myPlayer.id ? 'var(--red-bright)' : p.is_alive ? 'var(--text-primary)' : 'var(--text-secondary)'
                }}>{p.name}</span>
                <span style={{ fontSize: '11px', flexShrink: 0, color: p.is_alive ? 'var(--green-bright)' : 'var(--text-secondary)' }}>
                  {p.is_alive ? '● รอด' : '✕ ตาย'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* ── MOBILE TAB BAR ── */}
      {!isDesktop && (
        <div style={{
          display: 'flex', borderBottom: '1px solid var(--red-blood)',
          background: 'var(--bg-secondary)', flexShrink: 0,
        }}>
          {([['map','🗺','แผนที่'],['stats','👤','สถานะ'],['log','📜','บันทึก'],['ally','🤝','กลุ่ม'],['chat','💬','แชท']] as const).map(([tab, icon, label]) => (
            <button key={tab} onClick={() => setMobileTab(tab as any)} style={{
              flex: 1, padding: '8px 2px', background: 'none', border: 'none',
              borderBottom: mobileTab === tab ? '2px solid var(--red-bright)' : '2px solid transparent',
              color: mobileTab === tab ? 'var(--red-bright)' : 'var(--text-secondary)',
              fontSize: '10px', cursor: 'pointer', fontFamily: 'var(--font-body)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
            }}>
              <span style={{ fontSize: '16px', lineHeight: 1 }}>{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}

      <div style={s.body}>
        {/* ── LEFT: MAP + CELL POPUP + EVENTS ── */}
        <div style={{ ...s.leftPanel, display: isDesktop || mobileTab === 'map' ? 'flex' : 'none', flexDirection:'column', overflow:'hidden' }}>
          <MapPanel
            grids={grids}
            gridStates={gridStates}
            allPlayers={allPlayers}
            myPlayer={myPlayer}
            visibleCells={visibleCells}
            selectedCell={selectedCell}
            onSelectCell={setSelectedCell}
            onMove={doMove}
            mapView={mapView}
            onToggleView={setMapView}
            allyIds={allyIds}
            onSelectPlayer={setSelectedPlayerInfo}
            traits={traits}
          />
          <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', borderTop:'1px solid var(--border)' }}>
          {/* Cell popup */}
          {selectedCell && (() => {
            const key = `${selectedCell.x},${selectedCell.y}`
            const grid = gridMap.get(key)
            const gs = gsMap.get(key)
            const isVisible = visibleCells.has(key) || myPlayer.pos_x === selectedCell.x && myPlayer.pos_y === selectedCell.y
            const playersHere = isVisible
              ? allPlayers.filter(p => p.pos_x === selectedCell.x && p.pos_y === selectedCell.y && p.is_alive)
              : []

            return (
              <div style={s.cellPopup}>
                <div style={s.cellPopupHeader}>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: '13px', color: 'var(--text-gold)' }}>
                    [{selectedCell.x},{selectedCell.y}] {grid?.zone_name ?? '?'}
                  </span>
                  <button onClick={() => setSelectedCell(null)} style={s.closeBtn}>✕</button>
                </div>

                {!isVisible ? (
                  <div style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                    🌫 นอกระยะมองเห็น
                  </div>
                ) : (
                  <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {grid?.description && (
                      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        {grid.description}
                      </p>
                    )}

                    {/* ผู้เล่นในช่อง */}
                    {playersHere.length > 0 && (
                      <div>
                        <div style={s.miniLabel}>ผู้เล่นในช่อง</div>
                        {playersHere.map(p => (
                          <div key={p.id} style={{ fontSize: '13px', color: p.id === myPlayer.id ? 'var(--red-bright)' : 'var(--text-primary)' }}>
                            #{String(p.student_number).padStart(2,'0')} {p.name}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* ซ่อนรายการของ spawn — ต้องค้นก่อนถึงรู้ */}

                    {/* ของทิ้งบนพื้น — เห็นได้เลย */}
                    {(() => {
                      const drops: any[] = gs?.dropped_items ?? []
                      const validDrops = drops.filter(d =>
                        !d.expires_at || new Date(d.expires_at).getTime() > now
                      )
                      if (validDrops.length === 0) return null
                      const isHere = selectedCell.x === myPlayer.pos_x && selectedCell.y === myPlayer.pos_y
                      return (
                        <div>
                          <div style={s.miniLabel}>◎ ของบนพื้น ({validDrops.length})</div>
                          <div style={{ maxHeight: '160px', overflowY: 'auto' }}>
                          {validDrops.map((drop: any, i: number) => {
                            const minsLeft = drop.expires_at
                              ? Math.max(0, Math.ceil((new Date(drop.expires_at).getTime() - now) / 60_000))
                              : null
                            const hoursLeft = minsLeft !== null ? Math.floor(minsLeft / 60) : null
                            const timeStr = hoursLeft !== null
                              ? hoursLeft > 0 ? `${hoursLeft}ชม.${minsLeft! % 60}น.` : `${minsLeft}น.`
                              : ''
                            return (
                              <div key={i} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:'12px', marginBottom:'3px', padding:'3px 6px', background:'var(--bg-tertiary)', border:'1px solid rgba(230,126,34,0.3)' }}>
                                <div>
                                  <span style={{ color:'#E67E22' }}>{drop.id}</span>
                                  <span style={{ color:'var(--text-secondary)', fontSize:'10px', marginLeft:'6px' }}>×{drop.qty}</span>
                                  <span style={{ color:'var(--text-secondary)', fontSize:'10px', marginLeft:'4px' }}>จาก {drop.dropped_by}</span>
                                </div>
                                <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                                  {timeStr && <span style={{ fontSize:'10px', color:'var(--text-secondary)', fontFamily:'var(--font-mono)' }}>⏱{timeStr}</span>}
                                  {isHere && (
                                    <button onClick={async () => {
                                      const res = await fetch('/api/action/pickup', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ game_id: game.id, drop_index: i }),
                                      })
                                      const data = await res.json()
                                      if (!data.ok) notify(data.error, false)
                                      else notify(data.msg)
                                    }} style={{
                                      padding:'2px 8px', background:'rgba(45,90,39,0.3)',
                                      border:'1px solid var(--green-bright)', color:'var(--green-bright)',
                                      fontSize:'11px', cursor:'pointer', fontFamily:'var(--font-body)',
                                    }}>เก็บ</button>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                          </div>
                        </div>
                      )
                    })()}

                    {/* Action buttons */}
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                      {/* ฆ่าตัวตาย — เฉพาะช่องตัวเอง */}
                      {selectedCell.x === myPlayer.pos_x && selectedCell.y === myPlayer.pos_y && myPlayer.is_alive && (
                        <button onClick={async () => {
                          if (!confirm('ยืนยันฆ่าตัวตาย? การกระทำนี้ไม่สามารถย้อนกลับได้')) return
                          const res = await fetch('/api/action/suicide', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ game_id: game.id }),
                          })
                          const data = await res.json()
                          if (!data.ok) notify(data.error, false)
                        }} style={{ ...s.actionBtn, background:'rgba(60,0,0,0.6)', border:'1px solid #660000', color:'#CC4444', fontSize:'11px' }}>
                          ☠ ฆ่าตัวตาย
                        </button>
                      )}
                      {/* เดินไป */}
                      {myPlayer.pos_x !== null && (
                        Math.abs(myPlayer.pos_x - selectedCell.x) <= 1 &&
                        Math.abs((myPlayer.pos_y ?? 0) - selectedCell.y) <= 1 &&
                        (selectedCell.x !== myPlayer.pos_x || selectedCell.y !== myPlayer.pos_y)
                      ) && (() => {
                        const isSwamp = grid?.terrain === 'หนองน้ำ'
                        // คำนวณ move cost จาก trait special_effects (ใช้ traits ที่โหลดมาแล้ว)
                        const moveApBonus = (myPlayer.traits ?? []).reduce((sum: number, tid: string) => {
                          const td = traits.find(t => t.id === tid)
                          return sum + ((td?.special_effects as any)?.move_ap_bonus ?? 0)
                        }, 0)
                        const hasSwim = (myPlayer.traits ?? []).some((tid: string) => {
                          const td = traits.find(t => t.id === tid)
                          return (td?.special_effects as any)?.swim === true
                        })
                        let moveCost = Math.max(0, 5 + moveApBonus)
                        if (isSwamp && !hasSwim) moveCost += 15
                        // บวก moodle ap_cost_bonus
                        const moodleBonus = (myPlayer.moodles ?? []).reduce((sum: number, m: any) => {
                          const def = moodleDefs.find(d => d.id === m.id)
                          const level = m.level ?? 1
                          const fx = def?.level_effects?.find((e: any) => e['ระดับ'] === level) as any
                          return sum + (fx?.['ผล']?.ap_cost_bonus ?? 0)
                        }, 0)
                        moveCost += moodleBonus
                        return (
                          <button onClick={() => { doMove(selectedCell.x, selectedCell.y); setSelectedCell(null) }} style={s.actionBtn}>
                            🚶 เดิน ({moveCost} AP){isSwamp && !hasSwim ? ' ⚠️' : ''}
                          </button>
                        )
                      })()}
                      {/* ค้นหา */}
                      {selectedCell.x === myPlayer.pos_x && selectedCell.y === myPlayer.pos_y && (() => {
                          // cooldown รายผู้เล่นเก็บใน localStorage แยกตามเวลา
                          const thaiHour = (new Date().getUTCHours() + 7) % 24
                          const cdMins = (thaiHour >= 19 || thaiHour < 7) ? 20 : 60
                          const key = `search_${myPlayer.id}_${selectedCell.x}_${selectedCell.y}`
                          const lastSearched = typeof window !== 'undefined' ? localStorage.getItem(key) : null
                          const minsSince = lastSearched
                            ? (Date.now() - parseInt(lastSearched)) / 60_000
                            : 999
                          const onCooldown = minsSince < cdMins
                          const minsLeft = Math.ceil(cdMins - minsSince)
                          return (
                            <button onClick={() => doSearch(selectedCell.x, selectedCell.y)} disabled={onCooldown} style={{
                              ...s.actionBtn,
                              opacity: onCooldown ? 0.4 : 1,
                              cursor: onCooldown ? 'not-allowed' : 'pointer',
                            }}>
                              {onCooldown ? `🔍 รออีก ${minsLeft} นาที` : '🔍 ค้นหา (30 AP)'}
                            </button>
                          )
                        })()}
                      {/* 🤝 ชวน/ขอเข้าร่วม — แสดงตลอดเวลา ไม่ขึ้นกับเวลาต่อสู้ */}
                      {myPlayer.is_alive && !myPlayer.alliance_id && (() => {
                        const others = playersHere.filter(p => p.id !== myPlayer.id && p.is_alive)
                        if (others.length === 0) return null
                        return others.map(other => {
                          const otherHasAlliance = other.alliance_id
                          return (
                            <button key={`invite-${other.id}`}
                              onClick={() => otherHasAlliance ? doRequestJoin(other.alliance_id!) : doInvite(other.id)}
                              style={{ ...s.actionBtn, background:'rgba(0,60,0,0.5)', border:'1px solid var(--green-bright)', color:'var(--green-bright)' }}>
                              {otherHasAlliance ? `📨 ขอเข้าร่วมกลุ่ม ${other.name}` : `🤝 ชวน ${other.name} รวมกลุ่ม`}
                            </button>
                          )
                        })
                      })()}
                      {/* ชวนคนอื่นเข้ากลุ่มของเรา (ถ้ามีกลุ่มและกลุ่มไม่เต็ม) */}
                      {myPlayer.is_alive && myAlliance && !myAlliance.disbanded_at && (myAlliance.members?.length ?? 0) < 3 && (() => {
                        const nonMembers = playersHere.filter(p => p.id !== myPlayer.id && p.is_alive && !p.alliance_id)
                        if (nonMembers.length === 0) return null
                        return nonMembers.map(other => (
                          <button key={`invite-${other.id}`} onClick={() => doInvite(other.id)}
                            style={{ ...s.actionBtn, background:'rgba(0,60,0,0.5)', border:'1px solid var(--green-bright)', color:'var(--green-bright)' }}>
                            🤝 ชวน {other.name} เข้ากลุ่ม
                          </button>
                        ))
                      })()}
                      {/* ⚔ โจมตี — แสดงตามระยะอาวุธที่มีใน inventory */}
                      {(isCombat || (game as any).force_combat) && myPlayer.is_alive && (() => {
                        const dist = Math.max(
                          Math.abs((myPlayer.pos_x ?? 0) - selectedCell.x),
                          Math.abs((myPlayer.pos_y ?? 0) - selectedCell.y)
                        )
                        // หาระยะสูงสุดจากอาวุธทุกชิ้น (มือเปล่า = 1)
                        const maxWeaponRange = Math.max(1, ...(myPlayer.inventory ?? []).map((inv: any) => {
                          const def = itemDefs.find(d => d.id === inv.id)
                          return def?.category === 'อาวุธ' ? ((def?.data as any)?.range ?? 1) : 0
                        }))
                        if (dist > maxWeaponRange) return null
                        const others = playersHere.filter(p => p.id !== myPlayer.id && p.is_alive)
                        if (others.length === 0) return null
                        return others.map(other => (
                          <div key={other.id} style={{ display:'flex', gap:'4px', flexWrap:'wrap' }}>
                            <button onClick={() => { setAttackTarget(other.id); setSelectedCell(null) }} style={{
                              ...s.actionBtn,
                              flex:1,
                              background: 'rgba(139,0,0,0.5)',
                              border: '1px solid var(--red-bright)',
                              color: 'var(--red-bright)',
                            }}>
                              ⚔ โจมตี {other.name} (HP {other.hp}/{other.max_hp})
                            </button>
                          </div>
                        ))
                      })()}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Event log */}
          <div style={s.eventLog}>
            <div style={s.sectionTitle}>บันทึกเหตุการณ์</div>
            <div style={s.eventList}>
              {events.length === 0 && announcements.length === 0 && (
                <div style={{ color: 'var(--text-secondary)', fontSize: '13px', padding: '8px' }}>ยังไม่มีเหตุการณ์</div>
              )}
              {/* ประกาศในล็อก */}
              {announcements.map(ann => {
                const isTeacher = ann.ann_type === 'อาจารย์ผู้ควบคุม'
                const isPrivate = ann.ann_type === 'ส่วนตัว'
                const color = isTeacher ? 'var(--red-bright)' : isPrivate ? '#5A80CC' : 'var(--green-bright)'
                const icon = isTeacher ? '📢' : isPrivate ? '✉️' : '📣'
                const time = new Date(ann.occurred_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
                return (
                  <div key={ann.id} style={{ padding:'4px 8px', borderLeft:`2px solid ${color}`, marginBottom:'2px', background:'rgba(255,255,255,0.02)' }}>
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:'11px', color:'var(--text-secondary)', marginRight:'6px' }}>{time}</span>
                    <span style={{ fontSize:'12px', color, fontWeight:600 }}>{icon} {ann.ann_type}: </span>
                    <span style={{ fontSize:'12px', color:'var(--text-primary)' }}>{ann.message}</span>
                  </div>
                )
              })}
              {events.filter(ev => {
                // system events — แสดงทุกคน
                const isSys = ['ตาย','เตือนเขตอันตราย','ปิดเขตอันตราย','ชนะ'].includes(ev.event_type)
                if (isSys) return true
                // event ที่ไม่มี actor และไม่มี pos = system admin event แสดงทุกคน
                if (!ev.actor_id && ev.pos_x === null) return true
                // เหตุการณ์ของตัวเอง
                if (ev.actor_id === myPlayer.id || ev.target_id === myPlayer.id) return true
                // เหตุการณ์ของพันธมิตร
                if (ev.actor_id && allyIds.includes(ev.actor_id)) return true
                // เหตุการณ์ที่เกิดในระยะมองเห็น
                if (ev.pos_x !== null && ev.pos_y !== null) {
                  return visibleCells.has(`${ev.pos_x},${ev.pos_y}`)
                }
                return false
              }).map(ev => (
                <EventRow key={ev.id} event={ev} allPlayers={allPlayers} myPlayer={myPlayer} allyIds={allyIds} />
              ))}
            </div>
          </div>

          </div>
        </div>

        {/* ── RIGHT: PLAYER PANEL + CHAT ── */}
        <div style={{ ...s.rightPanel, display: isDesktop || mobileTab === 'stats' || mobileTab === 'chat' || mobileTab === 'ally' ? 'flex' : 'none' }}>
          {/* ── Desktop tab bar: สถานะ / พันธมิตร ── */}
          {isDesktop && (
            <div style={{ display:'flex', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
              <button onClick={() => setRightTab('stats')} style={{
                flex:1, padding:'7px 4px', background:'none', border:'none', fontSize:'12px', cursor:'pointer', fontFamily:'var(--font-body)',
                borderBottom: rightTab === 'stats' ? '2px solid var(--red-bright)' : '2px solid transparent',
                color: rightTab === 'stats' ? 'var(--red-bright)' : 'var(--text-secondary)',
              }}>📋 สถานะ</button>
              <button onClick={() => setRightTab('ally')} style={{
                flex:1, padding:'7px 4px', background:'none', border:'none', fontSize:'12px', cursor:'pointer', fontFamily:'var(--font-body)',
                borderBottom: rightTab === 'ally' ? '2px solid var(--green-bright)' : '2px solid transparent',
                color: rightTab === 'ally' ? 'var(--green-bright)' : 'var(--text-secondary)',
              }}>🤝 พันธมิตร{myAlliance && !myAlliance.disbanded_at ? ` (${(myAlliance.members as string[]).length}/3)` : ''}</button>
            </div>
          )}

          {/* Player info */}
          <div style={{ display: (isDesktop ? rightTab === 'stats' : (mobileTab !== 'ally')) ? 'flex' : 'none', flexDirection:'column', overflow:'hidden', flex:1 }}>
            <PlayerPanel myPlayer={myPlayer} ap={ap} hunger={hunger} thirst={thirst} hpClass={hpClass} hpPct={hpPct} traits={traits} moodleDefs={moodleDefs} itemDefs={itemDefs} onHeal={doHeal} onDrop={doDrop} onCraft={doCraft} onUseItem={doUseItem} recipes={recipes} invSort={invSort} setInvSort={setInvSort} />
          </div>

          {/* ── Alliance Panel ── */}
          <div style={{
            display: (isDesktop ? rightTab === 'ally' : (mobileTab === 'ally')) ? 'flex' : 'none',
            flexDirection:'column', padding:'10px', flex:1, overflow:'auto',
            background:'rgba(0,40,0,0.15)',
          }}>
            {myAlliance && !myAlliance.disbanded_at ? (
              <>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'8px' }}>
                  <span style={{ fontSize:'11px', color:'var(--green-bright)', letterSpacing:'0.1em', textTransform:'uppercase' }}>🤝 กลุ่มพันธมิตร ({(myAlliance.members as string[]).length}/3)</span>
                  <div style={{ display:'flex', gap:'4px' }}>
                    <button onClick={doLeaveAlliance} style={{ fontSize:'10px', padding:'2px 7px', background:'none', border:'1px solid var(--border)', color:'var(--text-secondary)', cursor:'pointer' }}>
                      ออก
                    </button>
                    <button onClick={doBetray} style={{ fontSize:'10px', padding:'2px 7px', background:'none', border:'1px solid var(--red-blood)', color:'var(--red-bright)', cursor:'pointer' }}>
                      ⚔ ทรยศ
                    </button>
                  </div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
                  {(myAlliance.members as string[]).map(memberId => {
                    const member = allPlayers.find(p => p.id === memberId)
                    if (!member) return null
                    const isMe = memberId === myPlayer.id
                    const isLeader = memberId === myAlliance.leader_id
                    const amLeader = myAlliance.leader_id === myPlayer.id
                    const hpPct = member.hp / member.max_hp
                    return (
                      <div key={memberId} style={{ background:'rgba(0,0,0,0.2)', border:'1px solid var(--border)', padding:'6px 8px', display:'flex', flexDirection:'column', gap:'4px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                          <span style={{ color: isLeader ? 'var(--text-gold)' : 'var(--green-bright)', fontSize:'12px' }}>
                            {isLeader ? '👑' : '●'}
                          </span>
                          <span style={{ flex:1, fontSize:'13px', color: member.is_alive ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                            {member.name}{isMe ? ' (คุณ)' : ''}
                          </span>
                          {amLeader && !isMe && (
                            <button onClick={() => { if (confirm(`โอนตำแหน่งหัวหน้าให้ ${member.name}?`)) doTransferLeader(memberId) }}
                              style={{ fontSize:'9px', padding:'1px 5px', background:'none', border:'1px solid var(--text-gold)', color:'var(--text-gold)', cursor:'pointer' }}>
                              โอน
                            </button>
                          )}
                        </div>
                        {/* HP bar */}
                        <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                          <div style={{ flex:1, height:'4px', background:'rgba(255,255,255,0.1)', borderRadius:'2px', overflow:'hidden' }}>
                            <div style={{ width:`${hpPct*100}%`, height:'100%', background: hpPct > 0.5 ? 'var(--green-bright)' : hpPct > 0.25 ? 'var(--text-gold)' : 'var(--red-bright)', transition:'width 0.3s' }} />
                          </div>
                          <span style={{ fontFamily:'var(--font-mono)', fontSize:'10px', color:'var(--text-secondary)', flexShrink:0 }}>
                            {member.hp}/{member.max_hp}
                          </span>
                        </div>
                        {member.pos_x !== null && (
                          <div style={{ fontSize:'10px', color:'var(--text-secondary)' }}>
                            📍 [{member.pos_x},{member.pos_y}]
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <div style={{ fontSize:'12px', color:'var(--text-secondary)', textAlign:'center', padding:'12px 0' }}>
                ยังไม่มีกลุ่มพันธมิตร<br/>
                <span style={{ fontSize:'11px' }}>ชวนผู้เล่นที่อยู่ในระยะมองเห็น</span>
              </div>
            )}
          </div>

          {/* Chat */}
          <div style={s.chatBox}>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
              {(['ทั่วไป','พื้นที่','พันธมิตร'] as ChatTab[]).map(tab => (
                <button key={tab} onClick={() => setChatTab(tab)} style={{
                  ...s.chatTab,
                  borderBottom: chatTab === tab ? '2px solid var(--red-bright)' : '2px solid transparent',
                  color: chatTab === tab ? 'var(--red-bright)' : 'var(--text-secondary)',
                }}>{tab}</button>
              ))}
            </div>
            <ChatMessages gameId={game.id} myPlayer={myPlayer} tab={chatTab} allPlayers={allPlayers} myAlliance={myAlliance} />
            <div style={{ display: 'flex', gap: '4px', padding: '6px', borderTop: '1px solid var(--border)' }}>
              <input
                value={chatMsg}
                onChange={e => setChatMsg(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat()}
                placeholder="พิมพ์ข้อความ..."
                disabled={!myPlayer.is_alive}
                style={{ ...s.chatInput, flex: 1 }}
              />
              <button onClick={sendChat} disabled={!myPlayer.is_alive} style={s.sendBtn}>ส่ง</button>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}

// ── MAP 20×20 ────────────────────────────────────────────────
function MapPanel({ grids, gridStates, allPlayers, myPlayer, visibleCells, selectedCell, onSelectCell, onMove, mapView, onToggleView, allyIds, onSelectPlayer, traits }: {
  grids: Grid[]; gridStates: GridState[]; allPlayers: Player[]
  myPlayer: Player; visibleCells: Set<string>
  selectedCell: {x:number,y:number}|null
  onSelectCell: (c:{x:number,y:number}|null) => void
  onMove: (x:number,y:number) => void
  mapView: 'mini'|'zoom'
  onToggleView: (v: 'mini'|'zoom') => void
  allyIds: string[]
  onSelectPlayer: (p: Player) => void
  traits: TraitDefinition[]
}) {
  const gridMap = new Map(grids.map(g => [`${g.x},${g.y}`, g]))
  const gsMap = new Map(gridStates.map(g => [`${g.x},${g.y}`, g]))

  const TERRAIN_COLOR: Record<string, string> = {
    'ภูเขา':   '#6B5744',
    'หาด':     '#A08C4A',
    'ป่า':     '#1A6B1A',
    'โรงเรียน': '#3A3A7A',
    'เมือง':   '#7A4A4A',
    'หนองน้ำ':  '#1A5C3A',
    'ประภาคาร': '#8A8A30',
    'ท่าเรือ':  '#2A5A7A',
    'หน้าผา':   '#6A6A6A',
    'ถ้ำ':      '#220A22',
    'ซากปรัก':  '#6A4A20',
    'ทั่วไป':   '#404040',
  }

  const CELL = 40  // zoomed cell size px (ใหญ่ขึ้น)
  const MINI = 9   // mini-map cell size px
  const VIEW = 11  // viewport 11x11 รอบตัวละคร
  const px = myPlayer.pos_x ?? 0
  const py = myPlayer.pos_y ?? 0

  // viewport — center ที่ตัวละครเสมอ
  const half = Math.floor(VIEW / 2)
  const vx0 = Math.max(0, Math.min(px - half, 29 - VIEW + 1))
  const vy0 = Math.max(0, Math.min(py - half, 29 - VIEW + 1))
  const vx1 = Math.min(29, vx0 + VIEW - 1)
  const vy1 = Math.min(29, vy0 + VIEW - 1)

  // ── Mini-map renderer ───────────────────────────────────────
  const MiniMap = () => (
    <div style={{ flexShrink: 0 }}>
      <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>แผนที่รวม</div>
      <div style={{ border: '1px solid var(--border)', display: 'inline-block' }}>
        {Array.from({ length: 30 }, (_, my) => (
          <div key={my} style={{ display: 'flex' }}>
            {Array.from({ length: 30 }, (_, mx) => {
              const key = `${mx},${my}`
              const grid = gridMap.get(key)
              const gs = gsMap.get(key)
              const isMyPos = myPlayer.pos_x === mx && myPlayer.pos_y === my
              const hasPlayer = allPlayers.some(p => p.pos_x === mx && p.pos_y === my && p.is_alive && p.id !== myPlayer.id) && visibleCells.has(key)
              const hasAlly = allPlayers.some(p => p.pos_x === mx && p.pos_y === my && p.is_alive && p.id !== myPlayer.id && allyIds.includes(p.id))
              const isVP = mx >= vx0 && mx <= vx1 && my >= vy0 && my <= vy1
              const isForbidden = gs?.is_forbidden
              const isWarn = gs?.warn_forbidden
              const hasAirdrop = (gs?.dropped_items as any[] ?? []).some((d: any) => d.dropped_by === 'Airdrop' && (!d.expires_at || new Date(d.expires_at).getTime() > Date.now()))
              const terrainColor = TERRAIN_COLOR[grid?.terrain ?? ''] ?? '#383838'
              return (
                <div key={mx}
                  className={isForbidden ? 'forbidden-blink' : isWarn ? 'forbidden-blink' : undefined}
                  onClick={() => onSelectCell({ x: mx, y: my })}
                  style={{
                    width: `${MINI}px`, height: `${MINI}px`, flexShrink: 0, cursor: 'pointer',
                    background: isMyPos ? 'var(--text-gold)' : hasPlayer ? 'var(--red-bright)' : hasAlly ? 'var(--green-bright)' : isForbidden ? '#CC0000' : isWarn ? '#E67E22' : terrainColor,
                    outline: isVP ? '1px solid rgba(255,255,255,0.35)' : 'none',
                    boxShadow: hasAirdrop ? 'inset 0 0 0 1px #F39C12' : 'none',
                  }}
                />
              )
            })}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '5px' }}>
        {[
          { label: 'คุณ', el: <span style={{ color:'var(--text-gold)', lineHeight:1 }}>◆</span> },
          { label: 'ผู้เล่น', el: <span style={{ display:'inline-block', width:'9px', height:'9px', borderRadius:'50%', border:'1.5px solid var(--red-bright)', verticalAlign:'middle' }} /> },
          { label: 'พันธมิตร', el: <span style={{ display:'inline-block', width:'9px', height:'9px', borderRadius:'50%', border:'1.5px solid var(--green-bright)', verticalAlign:'middle' }} /> },
          { label: 'เฝ้าระวัง', el: <span className="forbidden-blink" style={{ display:'inline-block', width:'9px', height:'9px', background:'#E67E22', verticalAlign:'middle' }} /> },
          { label: 'อันตราย', el: <span className="forbidden-blink" style={{ display:'inline-block', width:'9px', height:'9px', background:'#CC0000', verticalAlign:'middle' }} /> },
          { label: 'Airdrop', el: <span style={{ display:'inline-block', width:'9px', height:'9px', border:'1px solid #F39C12', verticalAlign:'middle' }} /> },
        ].map(({ label, el }) => (
          <span key={label} style={{ display:'flex', alignItems:'center', gap:'3px', fontSize:'10px', color:'var(--text-secondary)' }}>
            {el} {label}
          </span>
        ))}
      </div>
      {/* Terrain legend */}
      <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginTop: '4px', maxWidth: `${MINI * 30}px` }}>
        {Object.entries(TERRAIN_COLOR).map(([name, color]) => (
          <span key={name} style={{ display:'flex', alignItems:'center', gap:'2px', fontSize:'9px', color:'var(--text-secondary)' }}>
            <span style={{ width:'7px', height:'7px', background:color, display:'inline-block', flexShrink:0, border:'1px solid rgba(255,255,255,0.08)' }} />
            {name}
          </span>
        ))}
      </div>
    </div>
  )

  // ── Zoomed view renderer ─────────────────────────────────────
  const ZoomedView = () => (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
      <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
        พื้นที่รอบตัว [{px},{py}]
      </div>
      <div style={{ border: '1px solid var(--border)', display: 'inline-block' }}>
        {Array.from({ length: vy1 - vy0 + 1 }, (_, ri) => {
          const y = vy0 + ri
          return (
            <div key={y} style={{ display: 'flex' }}>
              {Array.from({ length: vx1 - vx0 + 1 }, (_, ci) => {
                const x = vx0 + ci
                const key = `${x},${y}`
                const grid = gridMap.get(key)
                const gs = gsMap.get(key)
                const isVisible = visibleCells.has(key) || (x === px && y === py)
                const isMyPos = x === px && y === py
                const isSelected = selectedCell?.x === x && selectedCell?.y === y
                const playersHere = allPlayers.filter(p => p.pos_x === x && p.pos_y === y && p.is_alive)
                const isForbidden = gs?.is_forbidden
                const isWarn = gs?.warn_forbidden && isVisible
                const terrainColor = TERRAIN_COLOR[grid?.terrain ?? ''] ?? '#383838'
                const bg = isForbidden && isVisible ? '#660000' : isWarn ? '#7A4000' : terrainColor

                // ผู้เล่นอื่นที่จะแสดง: ใน visible range แสดงทุกคน, นอก range แสดงเฉพาะ ally
                const othersToShow = playersHere.filter(p => {
                  if (p.id === myPlayer.id) return false
                  if (isVisible) return true
                  // นอก visibility — แสดง ally เท่านั้น
                  return allyIds.includes(p.id)
                })
                // กำหนดว่าช่องนี้ควร "มองเห็น" ได้ไหม (ally ทำให้เห็นช่องที่ไม่อยู่ใน range)
                const hasAllyOutsideRange = !isVisible && othersToShow.length > 0

                return (
                  <div key={x}
                    className={(isForbidden || isWarn) && isVisible ? 'forbidden-blink' : undefined}
                    onClick={() => onSelectCell(isSelected ? null : { x, y })}
                    style={{
                      width: `${CELL}px`, height: `${CELL}px`, flexShrink: 0,
                      background: bg, cursor: 'pointer', position: 'relative',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      opacity: (isVisible || hasAllyOutsideRange) ? 1 : 0.15,
                      border: isSelected ? '2px solid var(--red-bright)' : isMyPos ? '2px solid var(--text-gold)' : '1px solid rgba(255,255,255,0.04)',
                      fontSize: '12px',
                    }}
                  >
                    {isMyPos && (
                      <div style={{
                        width:'20px', height:'20px', borderRadius:'50%',
                        border:'2px solid var(--text-gold)',
                        overflow:'hidden', flexShrink:0,
                        background:'var(--bg-tertiary)',
                        display:'flex', alignItems:'center', justifyContent:'center',
                        zIndex:2,
                      }}>
                        {myPlayer.photo_url ? (
                          <img src={myPlayer.photo_url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover', borderRadius:'50%' }} />
                        ) : (
                          <span style={{ fontSize:'9px', color:'var(--text-gold)', lineHeight:1 }}>
                            {myPlayer.name.charAt(0)}
                          </span>
                        )}
                      </div>
                    )}
                    {/* แสดงรูปวงกลมผู้เล่นอื่น — สูงสุด 3 คน + เครื่องหมาย + */}
                    {othersToShow.length > 0 && (() => {
                      const show = othersToShow.slice(0, 3)
                      const extra = othersToShow.length - 3
                      const size = 14
                      return (
                        <div style={{
                          position: isMyPos ? 'absolute' : 'static',
                          top: isMyPos ? '1px' : undefined,
                          right: isMyPos ? '1px' : undefined,
                          display: 'flex', alignItems: 'center', gap: '1px',
                        }}>
                          {show.map(p => {
                            const isAlly = allyIds.includes(p.id)
                            const borderColor = isAlly ? 'var(--green-bright)' : 'var(--red-bright)'
                            return (
                              <div key={p.id}
                                onClick={e => { e.stopPropagation(); if (isVisible) onSelectPlayer(p) }}
                                style={{
                                  width: `${size}px`, height: `${size}px`, borderRadius: '50%',
                                  border: `1.5px solid ${borderColor}`,
                                  overflow: 'hidden', flexShrink: 0,
                                  background: 'var(--bg-tertiary)',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  cursor: isVisible ? 'pointer' : 'default',
                                }}>
                                {p.photo_url ? (
                                  <img src={p.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                                ) : (
                                  <span style={{ fontSize: '8px', color: borderColor, lineHeight: 1 }}>
                                    {p.name.charAt(0)}
                                  </span>
                                )}
                              </div>
                            )
                          })}
                          {extra > 0 && (
                            <span style={{ fontSize: '8px', color: 'var(--red-bright)', fontWeight: 700, lineHeight: 1 }}>
                              +{extra}
                            </span>
                          )}
                        </div>
                      )
                    })()}
                    {isVisible && (gs?.dropped_items ?? []).filter((d: any) => !d.expires_at || new Date(d.expires_at).getTime() > Date.now()).length > 0 && (
                      <span style={{ position:'absolute', top:'1px', left:'2px', fontSize:'10px', color:'#E67E22' }}>◎</span>
                    )}
                    {isVisible && (
                      <span style={{ position:'absolute', bottom:'1px', right:'2px', fontSize:'7px', color:'rgba(255,255,255,0.2)', fontFamily:'var(--font-mono)' }}>
                        {x},{y}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )

  // ตรวจ viewport width — ถ้าน้อยกว่า 769px = mobile
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 769)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  return (
    <div style={{ padding: '8px', overflow: 'auto' }}>
      {isMobile ? (
        // ── Mobile: ปุ่มสลับ + แสดงทีละอัน ──
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '8px' }}>
            <button onClick={() => onToggleView('zoom')} style={{
              flex:1, padding:'8px', background:'none', border:'none', fontSize:'12px', cursor:'pointer', fontFamily:'var(--font-body)',
              borderBottom: mapView === 'zoom' ? '2px solid var(--red-bright)' : '2px solid transparent',
              color: mapView === 'zoom' ? 'var(--red-bright)' : 'var(--text-secondary)',
            }}>🔍 พื้นที่รอบตัว</button>
            <button onClick={() => onToggleView('mini')} style={{
              flex:1, padding:'8px', background:'none', border:'none', fontSize:'12px', cursor:'pointer', fontFamily:'var(--font-body)',
              borderBottom: mapView === 'mini' ? '2px solid var(--text-gold)' : '2px solid transparent',
              color: mapView === 'mini' ? 'var(--text-gold)' : 'var(--text-secondary)',
            }}>🗺 แผนที่รวม</button>
          </div>
          {mapView === 'zoom' ? <ZoomedView /> : <MiniMap />}
        </div>
      ) : (
        // ── Desktop: mini-map ซ้าย + zoomed กลาง ──
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', justifyContent: 'center' }}>
          <MiniMap />
          <ZoomedView />
        </div>
      )}
    </div>
  )
}

// ── PLAYER PANEL ─────────────────────────────────────────────
function PlayerPanel({ myPlayer, ap, hunger, thirst, hpClass, hpPct, traits, moodleDefs, itemDefs, onHeal, onDrop, onCraft, onUseItem, recipes, invSort, setInvSort }: {
  myPlayer: Player; ap: number; hunger: number; thirst: number; hpClass: string; hpPct: number
  traits: TraitDefinition[]; moodleDefs: MoodleDefinition[]; itemDefs: ItemDefinition[]
  onHeal: (item_id: string) => void
  onDrop: (item_id: string, qty: number) => void
  onCraft: (recipe_id: string) => void
  onUseItem: (item_id: string) => void
  recipes: CraftRecipe[]
  invSort: 'default'|'name'|'category'|'weight'
  setInvSort: (s: 'default'|'name'|'category'|'weight') => void
}) {
  const [tab, setTab] = useState<'stats'|'inventory'|'traits'|'craft'>('stats')

  const STATS = [
    { key: 'str', label: 'STR', val: myPlayer.str },
    { key: 'agi', label: 'AGI', val: myPlayer.agi },
    { key: 'int', label: 'INT', val: myPlayer.int },
    { key: 'per', label: 'PER', val: myPlayer.per },
    { key: 'cha', label: 'CHA', val: myPlayer.cha },
    { key: 'end_stat', label: 'END', val: myPlayer.end_stat },
    { key: 'stl', label: 'STL', val: myPlayer.stl },
    { key: 'lck', label: 'LCK', val: myPlayer.lck },
  ]

  return (
    <div style={s.playerPanel}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <div style={s.avatarSmall}>
          {myPlayer.photo_url ? (
            <Image src={myPlayer.photo_url} alt="" width={32} height={32} style={{ borderRadius: '50%', objectFit: 'cover' }} unoptimized />
          ) : (
            <span style={{ fontSize: '14px', color: 'var(--red-bright)' }}>{myPlayer.name.charAt(0)}</span>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
            #{String(myPlayer.student_number).padStart(2,'0')}
          </div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {myPlayer.name}
          </div>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          {myPlayer.pos_x !== null ? `[${myPlayer.pos_x},${myPlayer.pos_y}]` : 'ไม่ได้วาง'}
        </div>
      </div>

      {/* HP */}
      <div style={{ marginBottom: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>HP</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{myPlayer.hp}/{myPlayer.max_hp}</span>
        </div>
        <div className="hp-bar" style={{ borderRadius: '2px' }}>
          <div className={hpClass} style={{ width: `${hpPct}%`, height: '100%', borderRadius: '2px', transition: 'none' }} />
        </div>
      </div>

      {/* AP */}
      <div style={{ marginBottom: '4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>⚡ AP</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--blue-ap)' }}>{ap}/600</span>
        </div>
        <div className="ap-bar" style={{ borderRadius: '2px' }}>
          <div className="ap-fill" style={{ width: `${apToPercent(ap)}%`, height: '100%', borderRadius: '2px', transition: 'none' }} />
        </div>
      </div>

      {/* Hunger */}
      <div style={{ marginBottom: '4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>🍖 หิว</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: hungerColor(hunger) }}>{hunger}/100</span>
        </div>
        <div style={{ height: '4px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '2px' }}>
          <div style={{ height: '100%', borderRadius: '2px', transition: 'none',
            width: `${hunger}%`, background: hungerColor(hunger),
          }} />
        </div>
      </div>

      {/* Thirst */}
      <div style={{ marginBottom: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>💧 กระหาย</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: thirstColor(thirst) }}>{thirst}/100</span>
        </div>
        <div style={{ height: '4px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '2px' }}>
          <div style={{ height: '100%', borderRadius: '2px', transition: 'none',
            width: `${thirst}%`, background: thirstColor(thirst),
          }} />
        </div>
      </div>

      {/* Moodles */}
      {myPlayer.moodles && myPlayer.moodles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
          {myPlayer.moodles.filter((m: any) => {
            // กรอง moodle ที่หมดอายุแล้วออก
            if (!m.expires_at) return true
            return new Date(m.expires_at).getTime() > Date.now()
          }).map((m: any, i: number) => {
            const def = moodleDefs.find(d => d.id === m.id)
            const color = def?.border_color ?? 'var(--border)'
            // แสดงเวลาที่เหลือถ้ามี expires_at
            let expires = ''
            if (m.expires_at) {
              const minsLeft = Math.ceil((new Date(m.expires_at).getTime() - Date.now()) / 60_000)
              const h = Math.floor(minsLeft / 60)
              const min = minsLeft % 60
              expires = h > 0 ? ` ${h}ชม.${min}น.` : minsLeft > 0 ? ` ${minsLeft}น.` : ''
            }
            return (
              <span key={i} className="moodle-blink" style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                padding: '2px 7px', border: `1px solid ${color}`,
                color, background: 'var(--bg-tertiary)', fontSize: '11px',
              }}>
                {def?.icon_url && (
                  <img src={def?.icon_url} alt="" style={{ width: '14px', height: '14px', objectFit: 'contain', flexShrink: 0 }} />
                )}
                {m.id}{expires}
              </span>
            )
          })}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '8px' }}>
        {(['stats','inventory','traits','craft'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...s.smallTab,
            borderBottom: tab === t ? '2px solid var(--red-bright)' : '2px solid transparent',
            color: tab === t ? 'var(--red-bright)' : 'var(--text-secondary)',
          }}>{t === 'stats' ? 'สถานะ' : t === 'inventory' ? 'กระเป๋า' : t === 'traits' ? 'นิสัย' : 'คราฟต์'}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'stats' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px' }}>
            {STATS.map(s => (
              <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{s.label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 700 }}>{s.val}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', gridColumn: '1/-1' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>สังหาร</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--red-bright)', fontWeight: 700 }}>{myPlayer.kill_count}</span>
            </div>
          </div>
        )}

        {tab === 'inventory' && (() => {
          // ตรวจจาก item data ว่าใช้ได้ไหม (มี hp, hunger, thirst, removes_moodle, หรือ ap_bonus)
          const HEAL_IDS: string[] = itemDefs
            .filter(d => d.data && (d.data.hp || d.data.hunger || d.data.thirst || d.data.removes_moodle || d.data.ap_bonus || d.data.int_bonus))
            .map(d => d.id)
            
          const USE_EQUIP_IDS: string[] = itemDefs
            .filter(d => d.category === 'อุปกรณ์' && d.data && ((d.data as any).ap_bonus || (d.data as any).stat_bonus))
            .map(d => d.id)

          const totalWeight = myPlayer.inventory.reduce((sum, item) => {
            const def = itemDefs.find(d => d.id === item.id)
            return sum + ((def?.weight ?? 0) * item.qty)
          }, 0)
          const maxWeight = 20 + myPlayer.str * 2
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'4px 8px', background:'var(--bg-primary)', border:'1px solid var(--border)', marginBottom:'2px', gap:'6px' }}>
                <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>น้ำหนัก</span>
                <span style={{ fontFamily:'var(--font-mono)', fontSize:'12px', color: totalWeight > maxWeight ? 'var(--red-bright)' : 'var(--text-gold)', flex:1 }}>
                  {totalWeight.toFixed(1)} / {maxWeight} กก.
                </span>
                <select value={invSort} onChange={e => setInvSort(e.target.value as any)}
                  style={{ fontSize:'10px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', color:'var(--text-secondary)', padding:'2px 4px', cursor:'pointer' }}>
                  <option value="default">ตามที่เพิ่ม</option>
                  <option value="name">ชื่อ A-Z</option>
                  <option value="category">หมวดหมู่</option>
                  <option value="weight">น้ำหนัก</option>
                </select>
              </div>
              {myPlayer.inventory.length === 0 && (
                <span style={{ fontSize:'13px', color:'var(--text-secondary)' }}>กระเป๋าว่างเปล่า</span>
              )}
              {[...myPlayer.inventory].sort((a, b) => {
                if (invSort === 'name') return a.id.localeCompare(b.id, 'th')
                if (invSort === 'category') {
                  const ca = itemDefs.find(d=>d.id===a.id)?.category ?? ''
                  const cb = itemDefs.find(d=>d.id===b.id)?.category ?? ''
                  return ca.localeCompare(cb, 'th')
                }
                if (invSort === 'weight') {
                  const wa = (itemDefs.find(d=>d.id===a.id)?.weight ?? 0) * a.qty
                  const wb = (itemDefs.find(d=>d.id===b.id)?.weight ?? 0) * b.qty
                  return wb - wa
                }
                return 0
              }).map((item, i) => {
                const def = itemDefs.find(d => d.id === item.id)
                const isWeapon = def?.category === 'อาวุธ'
                const canHeal = HEAL_IDS.includes(item.id)
                const canUseEquip = USE_EQUIP_IDS.includes(item.id)
                
                return (
                  <div key={i} style={{ display:'flex', alignItems:'flex-start', padding:'6px 8px', background:'var(--bg-tertiary)', border:`1px solid ${isWeapon ? 'rgba(139,0,0,0.4)' : 'var(--border)'}`, fontSize:'13px', gap:'8px' }}>
                    {/* รูปภาพ */}
                    {def?.photo_url ? (
                      <img src={def.photo_url} alt={def.name} style={{ width:'36px', height:'36px', objectFit:'cover', flexShrink:0, border:'1px solid var(--border)' }} />
                    ) : (
                      <div style={{ width:'36px', height:'36px', background:'var(--bg-primary)', border:'1px solid var(--border)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'16px' }}>
                        {isWeapon ? '⚔' : '📦'}
                      </div>
                    )}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ color: isWeapon ? 'var(--red-bright)' : 'var(--text-primary)', fontWeight:600 }}>
                        {def?.name ?? item.id}
                      </div>
                      {def?.description && (
                        <div style={{ fontSize:'10px', color:'var(--text-secondary)', lineHeight:1.4, marginTop:'2px' }}>{def.description}</div>
                      )}
                      <div style={{ display:'flex', gap:'8px', marginTop:'2px', flexWrap:'wrap' }}>
                        {def?.weight ? <span style={{ fontSize:'10px', color:'var(--text-secondary)' }}>{def.weight} กก.</span> : null}
                        {isWeapon && def?.data && (
                          <span style={{ fontSize:'10px', color:'var(--text-secondary)', fontFamily:'var(--font-mono)' }}>
                            DMG {String(def.data.damage ?? "")} | คริต {String(def.data.crit_chance ?? "")}%
                          </span>
                        )}
                        {!isWeapon && def?.data && (
                          <>
                            {!!def.data.hp && <span style={{ fontSize:'10px', color:'var(--green-bright)', fontFamily:'var(--font-mono)' }}>HP +{String(def.data.hp ?? "")}</span>}
                            {!!def.data.hunger && <span style={{ fontSize:'10px', color:'#8B6914', fontFamily:'var(--font-mono)' }}>🍖 +{String(def.data.hunger ?? "")}</span>}
                            {!!def.data.thirst && <span style={{ fontSize:'10px', color:'#2A5A8A', fontFamily:'var(--font-mono)' }}>💧 +{String(def.data.thirst ?? "")}</span>}
                            {!!def.data.ap_bonus && <span style={{ fontSize:'10px', color:'var(--blue-ap)', fontFamily:'var(--font-mono)' }}>⚡ +{String(def.data.ap_bonus ?? "")}</span>}
                            {def.data.removes_moodle && <span style={{ fontSize:'10px', color:'var(--text-secondary)' }}>รักษา{String(def.data.removes_moodle ?? "")}</span>}
                            {(def.data.ap_cost as number) > 0 && <span style={{ fontSize:'10px', color:'var(--blue-ap)', fontFamily:'var(--font-mono)' }}>AP {String(def.data.ap_cost ?? "")}</span>}
                          </>
                        )}
                      </div>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:'4px', flexShrink:0 }}>
                      <span style={{ fontFamily:'var(--font-mono)', fontSize:'12px', color:'var(--text-secondary)' }}>×{item.qty}</span>
                      {canHeal && (
                        <button onClick={() => onHeal(item.id)} style={{
                          padding:'2px 7px', background:'rgba(45,90,39,0.3)',
                          border:'1px solid var(--green-bright)', color:'var(--green-bright)',
                          fontSize:'11px', cursor:'pointer', fontFamily:'var(--font-body)',
                        }}>ใช้</button>
                      )}
                      {canUseEquip && (
                        <button onClick={() => onUseItem(item.id)} style={{
                          padding:'2px 7px', background:'rgba(45,60,100,0.3)',
                          border:'1px solid #5A80CC', color:'#5A80CC',
                          fontSize:'11px', cursor:'pointer', fontFamily:'var(--font-body)',
                        }}>ใช้</button>
                      )}
                      <button onClick={() => {
                        const n = item.qty === 1 ? 1 : parseInt(window.prompt(`ทิ้งกี่ชิ้น? (มี ${item.qty})`) ?? '0')
                        if (n > 0) onDrop(item.id, Math.min(n, item.qty))
                      }} style={{
                        padding:'2px 7px', background:'rgba(90,60,0,0.3)',
                        border:'1px solid #8B6914', color:'#8B6914',
                        fontSize:'11px', cursor:'pointer', fontFamily:'var(--font-body)',
                      }}>ทิ้ง</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })()}

        {tab === 'traits' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {myPlayer.traits.map(traitId => {
              const def = traits.find(t => t.id === traitId)
              const isNeg = def?.type === 'ลบ'
              const borderColor = isNeg ? 'var(--red-bright)' : 'var(--border-bright)'
              const color = isNeg ? 'var(--red-bright)' : 'var(--text-secondary)'
              return (
                <span key={traitId} style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  padding: '3px 8px', border: '1px solid', fontSize: '12px',
                  borderColor, color, background: 'var(--bg-tertiary)',
                }}>
                  {def?.icon_url && (
                    <img src={def?.icon_url} alt="" style={{ width: '16px', height: '16px', objectFit: 'contain', flexShrink: 0 }} />
                  )}
                  {traitId}
                </span>
              )
            })}
          </div>
        )}

        {tab === 'craft' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recipes.length === 0 && (
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>ไม่มีสูตรคราฟต์</span>
            )}
            {recipes.map(recipe => {
              // ตรวจ INT ขั้นต่ำ — trait เรียนเก่ง ลด 2
              const hasSmartTrait = myPlayer.traits.some(t => {
                const def = traits.find(td => td.id === t)
                return def?.special_effects?.craft_int_bonus !== undefined
              })
              const intBonus = hasSmartTrait ? (traits.find(t => myPlayer.traits.includes(t.id) && t.special_effects?.craft_int_bonus !== undefined)?.special_effects?.craft_int_bonus as number ?? 0) : 0
              const effectiveMinInt = Math.max(1, recipe.min_int - intBonus)
              const intOk = myPlayer.int >= effectiveMinInt

              // ตรวจวัสดุ
              const hasAllMats = recipe.ingredients.every(ing => {
                const item = myPlayer.inventory.find(i => i.id === ing.id)
                return item && item.qty >= ing.qty
              })

              // ตรวจ AP
              // trait ลด AP คราฟต์
              const craftApBonus = myPlayer.traits.reduce((sum, t) => {
                const def = traits.find(td => td.id === t)
                return sum + (def?.special_effects?.craft_ap_bonus as number ?? 0)
              }, 0)
              const effectiveApCost = Math.max(10, recipe.ap_cost + craftApBonus)
              const apOk = ap >= effectiveApCost

              const canCraft = intOk && hasAllMats && apOk && myPlayer.is_alive

              return (
                <div key={recipe.id} style={{
                  padding: '8px', background: 'var(--bg-tertiary)',
                  border: `1px solid ${canCraft ? 'var(--border-bright)' : 'var(--border)'}`,
                  opacity: canCraft ? 1 : 0.6,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: canCraft ? 'var(--text-gold)' : 'var(--text-secondary)' }}>
                      {recipe.name}
                    </span>
                    <button onClick={() => onCraft(recipe.id)} disabled={!canCraft} style={{
                      padding: '3px 10px', fontSize: '11px', cursor: canCraft ? 'pointer' : 'not-allowed',
                      background: canCraft ? 'rgba(139,0,0,0.4)' : 'var(--bg-primary)',
                      border: `1px solid ${canCraft ? 'var(--red-bright)' : 'var(--border)'}`,
                      color: canCraft ? 'var(--red-bright)' : 'var(--text-secondary)',
                      fontFamily: 'var(--font-body)',
                    }}>คราฟต์</button>
                  </div>
                  {recipe.description && (
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{recipe.description}</div>
                  )}
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '2px' }}>
                    ผลลัพธ์: <span style={{ color: 'var(--text-primary)' }}>{recipe.result_id} ×{recipe.result_qty}</span>
                  </div>
                  <div style={{ fontSize: '11px', display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '2px' }}>
                    {recipe.ingredients.map((ing, i) => {
                      const have = myPlayer.inventory.find(it => it.id === ing.id)?.qty ?? 0
                      const ok = have >= ing.qty
                      return (
                        <span key={i} style={{ color: ok ? 'var(--green-bright)' : 'var(--red-bright)' }}>
                          {ing.id} ({have}/{ing.qty})
                        </span>
                      )
                    })}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', display: 'flex', gap: '8px' }}>
                    <span style={{ color: apOk ? 'var(--blue-ap)' : 'var(--red-bright)' }}>⚡ AP {effectiveApCost}</span>
                    <span style={{ color: intOk ? 'var(--text-secondary)' : 'var(--red-bright)' }}>
                      INT ≥ {effectiveMinInt}{intBonus > 0 ? ` (ลด${intBonus})` : ''}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── EVENT ROW ────────────────────────────────────────────────
function EventRow({ event, allPlayers, myPlayer, allyIds }: {
  event: GameEvent; allPlayers: Player[]; myPlayer: Player; allyIds: string[]
}) {
  const actor = allPlayers.find(p => p.id === event.actor_id)
  const target = allPlayers.find(p => p.id === event.target_id)
  const isMe = event.actor_id === myPlayer.id
  const isAlly = event.actor_id ? allyIds.includes(event.actor_id) : false

  const isSysEvent = ['เตือนเขตอันตราย','ปิดเขตอันตราย','ตาย','ชนะ'].includes(event.event_type)
  const color = isSysEvent ? 'var(--red-bright)'
    : isMe ? 'var(--text-gold)'
    : isAlly ? 'var(--green-bright)'
    : 'var(--text-secondary)'
  const time = new Date(event.occurred_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })

  const desc = (() => {
    const actorName = actor ? `${actor.name}` : 'ระบบ'
    const targetName = target ? `${target.name}` : event.data?.name ?? ''
    switch (event.event_type) {
      case 'เดิน': return `${actorName} เดินไป [${event.pos_x},${event.pos_y}]`
      case 'ค้นหา': return `${actorName} ค้นหาที่ [${event.pos_x},${event.pos_y}]`
      case 'โจมตี': {
        const dmg = event.data?.damage ?? '?'
        const crit = event.data?.crit ? ' [คริต!]' : ''
        const bleed = event.data?.bleeding ? ' [เลือดออก]' : ''
        const hpLeft = event.data?.hp_left !== undefined ? ` → HP ${event.data.hp_left}` : ''
        return `${actorName} โจมตี ${targetName} ${dmg} ดาเมจ${crit}${bleed}${hpLeft}`
      }
      case 'โจมตี-หลบ': return `${targetName} หลบการโจมตีของ ${actorName}`
      case 'ตาย': {
        const cause = event.data?.cause
        const name = targetName || actorName
        if (cause === 'ปลอกคอระเบิด') return `💀 ${name} ถูกระเบิดปลอกคอ`
        if (cause === 'สภาพแวดล้อม') return `💀 ${name} เสียชีวิตจากสภาพแวดล้อม`
        if (event.actor_id && event.actor_id !== event.target_id) return `💀 ${name} ถูกสังหารโดย ${actorName}`
        return `💀 ${name} เสียชีวิต`
      }
      case 'ทรยศ': return `⚔ ${actorName} ทรยศกลุ่ม`
      case 'รักษา': case 'ใช้ไอเทม': return `${actorName} ใช้ ${event.data?.item ?? 'ไอเทม'}`
      case 'เก็บของ': return `${actorName} เก็บ ${event.data?.item ?? 'ของ'} ×${event.data?.qty ?? 1}`
      case 'ทิ้งของ': return `${actorName} ทิ้ง ${event.data?.item ?? 'ของ'} ×${event.data?.qty ?? 1}`
      case 'คราฟต์': return `${actorName} คราฟต์ ${event.data?.result ?? ''}`
      case 'เตือนเขตอันตราย': return `⚠️ เขต [${event.pos_x},${event.pos_y}] กำลังจะเป็นเขตอันตราย`
      case 'ปิดเขตอันตราย': return `🚫 เขต [${event.pos_x},${event.pos_y}] เป็นเขตอันตราย`
      case 'ชนะ': return `👑 ${event.data?.winner_name ?? actorName} เป็นผู้รอดชีวิตคนสุดท้าย!`
      default: return `${actorName}: ${event.event_type}`
    }
  })()

  return (
    <div style={{ padding: '3px 8px', borderLeft: `2px solid ${color}`, marginBottom: '2px', background: 'rgba(255,255,255,0.01)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-secondary)', marginRight: '6px' }}>{time}</span>
      <span style={{ fontSize: '13px', color }}>{desc}</span>
    </div>
  )
}

// ── CHAT MESSAGES ────────────────────────────────────────────
function ChatMessages({ gameId, myPlayer, tab, allPlayers, myAlliance }: {
  gameId: string; myPlayer: Player; tab: ChatTab
  allPlayers: Player[]; myAlliance: Alliance | null
}) {
  const supabase = createClient()
  const [messages, setMessages] = useState<any[]>([])
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMessages([]) // ล้างก่อนโหลดใหม่เมื่อ tab เปลี่ยน

    let q = (supabase as any).from('chat_messages').select('*')
      .eq('game_id', gameId)
      .eq('channel', tab)
      .order('sent_at', { ascending: true })
      .limit(50)

    if (tab === 'พื้นที่' && myPlayer.pos_x !== null) {
      q = q.eq('pos_x', myPlayer.pos_x).eq('pos_y', myPlayer.pos_y ?? 0)
    }
    if (tab === 'พันธมิตร' && myAlliance) {
      q = q.eq('alliance_id', myAlliance.id)
    }

    ;(async () => { const { data } = await q; if (data) setMessages(data) })()

    // Realtime — postgres_changes เท่านั้น
    const channel = supabase.channel(`chat-${gameId}-${tab}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'chat_messages',
        filter: `game_id=eq.${gameId}`,
      }, ({ new: msg }) => {
        const m = msg as any
        if (m.channel !== tab) return
        if (tab === 'พื้นที่' && (m.pos_x !== myPlayer.pos_x || m.pos_y !== myPlayer.pos_y)) return
        if (tab === 'พันธมิตร' && myAlliance && m.alliance_id !== myAlliance.id) return
        setMessages(prev => {
          if (prev.some(p => p.id === m.id)) return prev
          return [...prev, m].slice(-100)
        })
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [gameId, tab, myPlayer.pos_x, myPlayer.pos_y, myAlliance?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '6px', display: 'flex', flexDirection: 'column', gap: '3px', minHeight: '80px', maxHeight: '150px' }}>
      {messages.length === 0 && (
        <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>ยังไม่มีข้อความ</span>
      )}
      {messages.map((msg, i) => {
        const sender = allPlayers.find(p => p.id === msg.player_id)
        const isMe = msg.player_id === myPlayer.id
        return (
          <div key={msg.id ?? i} style={{ fontSize: '13px' }}>
            <span style={{ fontFamily: 'var(--font-mono)', color: isMe ? 'var(--text-gold)' : 'var(--text-secondary)', marginRight: '4px' }}>
              {sender?.name ?? '?'}:
            </span>
            <span style={{ color: 'var(--text-primary)' }}>{msg.message}</span>
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  root: { height: '100vh', background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topBar: { height: '40px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--red-blood)', display: 'flex', alignItems: 'center', gap: '10px', padding: '0 12px', flexShrink: 0 },
  topTitle: { fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 700, color: 'var(--red-bright)', letterSpacing: '0.1em' },
  logoutBtn: { background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '12px', cursor: 'pointer' },
  body: { flex: 1, display: 'flex', overflow: 'hidden', gap: '1px', background: 'var(--border)', minWidth: 0 },
  leftPanel: { flex: 1, minWidth: 0, background: 'var(--bg-primary)', overflow: 'hidden', padding: '0' },
  centerPanel: { display: 'none' },
  rightPanel: { width: '280px', flexShrink: 0, background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },

  cellPopup: { background: 'var(--bg-secondary)', border: '1px solid var(--red-blood)', borderTop: 'none', flexShrink: 0 },
  cellPopupHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'rgba(139,0,0,0.06)' },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '12px' },
  miniLabel: { fontSize: '13px', letterSpacing: '0.1em', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '3px' },
  actionBtn: { padding: '5px 10px', background: 'var(--red-blood)', border: '1px solid var(--red-bright)', color: 'var(--text-primary)', fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-body)' },

  eventLog: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border)', borderTop: 'none' },
  sectionTitle: { fontSize: '13px', letterSpacing: '0.12em', color: 'var(--text-secondary)', textTransform: 'uppercase', padding: '5px 8px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0 },
  eventList: { flex: 1, overflow: 'auto', padding: '4px' },

  playerPanel: { flex: 1, display: 'flex', flexDirection: 'column', padding: '10px', overflow: 'hidden', borderBottom: '1px solid var(--border)' },
  avatarSmall: { width: '32px', height: '32px', borderRadius: '50%', border: '1px solid var(--red-blood)', overflow: 'hidden', flexShrink: 0, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  smallTab: { flex: 1, padding: '4px', background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-body)' },

  chatBox: { height: '260px', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)', flexShrink: 0 },
  chatTab: { flex: 1, padding: '5px 4px', background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-body)' },
  chatInput: { padding: '5px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'var(--font-body)' },
  sendBtn: { padding: '5px 10px', background: 'var(--red-blood)', border: '1px solid var(--red-bright)', color: 'var(--text-primary)', fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-body)' },

  legendItem: { fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' },
}
