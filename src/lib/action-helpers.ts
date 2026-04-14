import { createServiceClient } from '@/lib/supabase/server'
import type { Player } from '@/lib/supabase/types'

// ── คำนวณ AP ปัจจุบัน ─────────────────────────────────────────
export function calcAP(savedAP: number, savedAt: string): number {
  const minutes = (Date.now() - new Date(savedAt).getTime()) / 60_000
  return Math.min(savedAP + Math.floor(minutes * 10), 600)
}

// ── หักแต้ม AP ────────────────────────────────────────────────
export async function spendAP(supabase: any, player: Player, cost: number): Promise<{ok:boolean, msg?:string}> {
  const current = calcAP(player.ap, player.ap_updated_at)
  if (current < cost) return { ok: false, msg: `AP ไม่พอ (มี ${current} ต้องการ ${cost})` }

  await supabase.from('players').update({
    ap: current - cost,
    ap_updated_at: new Date().toISOString(),
  }).eq('id', player.id)

  return { ok: true }
}

// ── บันทึก event ──────────────────────────────────────────────
export async function logEvent(supabase: any, params: {
  game_id: string
  event_type: string
  actor_id?: string
  target_id?: string
  pos_x?: number
  pos_y?: number
  data?: Record<string, unknown>
}) {
  await supabase.from('events').insert({
    game_id: params.game_id,
    event_type: params.event_type,
    actor_id: params.actor_id ?? null,
    target_id: params.target_id ?? null,
    pos_x: params.pos_x ?? null,
    pos_y: params.pos_y ?? null,
    data: params.data ?? {},
  })
}

// ── ดึงและตรวจสอบผู้เล่น ─────────────────────────────────────
export async function getValidPlayer(supabase: any, userId: string, gameId?: string): Promise<{
  player: Player | null; error?: string
}> {
  let q = supabase.from('players').select('*').eq('user_id', userId)
  if (gameId) q = q.eq('game_id', gameId)
  const { data: player } = await q.limit(1).maybeSingle()

  if (!player) return { player: null, error: 'ไม่พบตัวละคร' }
  if (!player.is_alive) return { player: null, error: 'ตัวละครเสียชีวิตแล้ว' }
  if (player.is_banned) return { player: null, error: 'ถูกแบน' }
  return { player }
}

// ── ตรวจเกมที่กำลังเล่น ──────────────────────────────────────
export async function getActiveGame(supabase: any, gameId: string) {
  const { data: game } = await supabase
    .from('games')
    .select('*')
    .eq('id', gameId)
    .single()

  if (!game) return null
  if (!['กำลังเล่น'].includes(game.status)) return null
  return game
}

// ── ตรวจช่วงเวลาต่อสู้ (19:00–00:00 ไทย) ────────────────────
export function isCombatTime(): boolean {
  const hour = (new Date().getUTCHours() + 7) % 24
  return hour >= 19 // 19:00–23:59 ไทย
}

export function minutesUntilCombat(): number {
  const now = new Date()
  const thaiHour = (now.getUTCHours() + 7) % 24
  const thaiMin = now.getUTCMinutes()
  if (thaiHour >= 19) return 0
  const minsLeft = (19 - thaiHour) * 60 - thaiMin
  return minsLeft
}

// ── สุ่มจาก spawn_table ───────────────────────────────────────
export function rollSpawnTable(spawnTable: Array<Record<string, any>>, count: number): Array<{id:string, qty:number}> {
  if (!spawnTable || spawnTable.length === 0) return []
  // รองรับทั้ง key "weight" และ "น้ำหนัก"
  const getWeight = (item: any): number => item.weight ?? item['น้ำหนัก'] ?? 1
  const totalWeight = spawnTable.reduce((s, i) => s + getWeight(i), 0)
  if (totalWeight === 0) return []
  const result: Record<string, number> = {}

  for (let i = 0; i < count; i++) {
    let rand = Math.random() * totalWeight
    for (const item of spawnTable) {
      rand -= getWeight(item)
      if (rand <= 0) {
        result[item.id] = (result[item.id] ?? 0) + 1
        break
      }
    }
  }

  return Object.entries(result).map(([id, qty]) => ({ id, qty }))
}

// ── apply moodle triggers จาก event ──────────────────────────
// event: 'attack_received' | 'attack_dealt' | 'ally_died' | 'enter_swamp'
// context: ข้อมูลเพิ่มเติม เช่น weapon data, kill_count, hp_pct
export async function applyMoodleTriggers(
  supabase: any,
  player: Player,
  event: string,
  context: {
    weaponBleedChance?: number
    weaponBoneBreakChance?: number
    killCount?: number
    hpPct?: number
  } = {}
): Promise<{ newMoodles: any[], msgs: string[] }> {
  // ดึง moodle_definitions ที่มี trigger ตรงกับ event นี้
  const { data: defs } = await supabase
    .from('moodle_definitions')
    .select('id, trigger, max_level')
    .not('trigger', 'is', null)
    .eq('is_active', true)

  if (!defs) return { newMoodles: player.moodles ?? [], msgs: [] }

  let newMoodles = [...(player.moodles ?? [])]
  const msgs: string[] = []

  for (const def of defs) {
    const t = def.trigger as any
    if (t.event !== event) continue

    const alreadyHas = newMoodles.find((m: any) => m.id === def.id)

    // ── attack_received ──────────────────────────────────────
    if (event === 'attack_received' && t.condition === 'on_hit') {
      if (alreadyHas) continue

      if (t.chance_from_weapon) {
        // อ่าน field ที่ระบุ หรือ fallback เป็น bleed_chance
        const field = t.weapon_field ?? 'bleed_chance'
        const chance = field === 'bone_break_chance'
          ? (context.weaponBoneBreakChance ?? 0)
          : (context.weaponBleedChance ?? 0)
        if (chance > 0 && Math.random() * 100 < chance) {
          newMoodles = [...newMoodles, { id: def.id, level: 1 }]
          msgs.push(`ติด ${def.id}`)
        }
        continue
      }

      // moodle อื่น — ใช้ chance คงที่
      const chance = t.chance ?? 0
      if (Math.random() * 100 < chance) {
        newMoodles = [...newMoodles, { id: def.id, level: 1 }]
        msgs.push(`ติด ${def.id}`)
      }
    }

    // ── attack_dealt — on_kill_first ─────────────────────────
    if (event === 'attack_dealt' && t.condition === 'on_kill_first') {
      if (alreadyHas) continue
      // killCount ที่ส่งมาคือหลัง +1 แล้ว ดังนั้น kill แรก = 1
      if ((context.killCount ?? 0) === 1) {
        newMoodles = [...newMoodles, { id: def.id, level: 1 }]
        msgs.push(`ติด ${def.id}`)
      }
    }

    // ── attack_dealt — kill_count_gte (น่าเกรงขาม) ──────────
    if (event === 'attack_dealt' && t.condition === 'kill_count_gte') {
      if (alreadyHas) continue
      // killCount ที่ส่งมาคือหลัง +1 แล้ว
      if ((context.killCount ?? 0) >= (t.value ?? 7)) {
        newMoodles = [...newMoodles, { id: def.id, level: 1 }]
        msgs.push(`ติด ${def.id}`)
      }
    }

    // ── ally_died ────────────────────────────────────────────
    if (event === 'ally_died' && t.condition === 'on_ally_death') {
      if (alreadyHas) continue
      const chance = t.chance ?? 100
      if (Math.random() * 100 < chance) {
        newMoodles = [...newMoodles, { id: def.id, level: 1 }]
        msgs.push(`ติด ${def.id}`)
      }
    }

    // ── move_swamp (ป่วย) ────────────────────────────────────
    if (event === 'move_swamp' && t.condition === 'on_swamp') {
      if (alreadyHas) continue
      const chance = t.chance ?? 15
      if (Math.random() * 100 < chance) {
        newMoodles = [...newMoodles, { id: def.id, level: 1 }]
        msgs.push(`ติด ${def.id}`)
      }
    }
  }

  return { newMoodles, msgs }
}

// ── apply moodle triggers จาก stat threshold ─────────────────
// ใช้หลัง heal/use-item หรือหลัง lazy calc hunger/thirst
export async function applyStatThresholdMoodles(
  supabase: any,
  player: Player,
  stats: { hunger?: number, thirst?: number, hp?: number, maxHp?: number },
  moodleDefsOverride?: any[]
): Promise<{ newMoodles: any[], updates: Record<string, any> }> {
  let defs = moodleDefsOverride
  if (!defs) {
    const { data } = await supabase
      .from('moodle_definitions')
      .select('id, trigger, max_level')
      .eq('is_active', true)
      .not('trigger', 'is', null)
    defs = data
  }
  if (!defs) return { newMoodles: player.moodles ?? [], updates: {} }

  let newMoodles = [...(player.moodles ?? [])]
  const updates: Record<string, any> = {}

  const hunger = stats.hunger ?? player.hunger ?? 100
  const thirst = stats.thirst ?? player.thirst ?? 100
  const hp = stats.hp ?? player.hp ?? player.max_hp
  const maxHp = stats.maxHp ?? player.max_hp
  const hpPct = maxHp > 0 ? (hp / maxHp) * 100 : 100

  for (const def of defs) {
    const t = def.trigger as any
    if (t.event !== 'stat_threshold') continue

    const existing = newMoodles.find((m: any) => m.id === def.id)

    // ── hunger_below ─────────────────────────────────────────
    if (t.condition === 'hunger_below') {
      const thresholds: Array<{value:number,level:number}> = t.thresholds ?? []
      // หา level ที่ถูกต้อง
      const matched = [...thresholds]
        .sort((a, b) => a.value - b.value) // เรียงน้อย → มาก
        .find(th => hunger < th.value)
      if (matched) {
        if (!existing) {
          newMoodles = [...newMoodles, { id: def.id, level: matched.level }]
        } else if (existing.level !== matched.level) {
          newMoodles = newMoodles.map((m: any) => m.id === def.id ? { ...m, level: matched.level } : m)
        }
      } else if (existing && t.remove_condition === 'hunger_above' && hunger >= (t.remove_value ?? 50)) {
        newMoodles = newMoodles.filter((m: any) => m.id !== def.id)
      }
    }

    // ── thirst_below ─────────────────────────────────────────
    if (t.condition === 'thirst_below') {
      const thresholds: Array<{value:number,level:number}> = t.thresholds ?? []
      const matched = [...thresholds]
        .sort((a, b) => a.value - b.value)
        .find(th => thirst < th.value)
      if (matched) {
        if (!existing) {
          newMoodles = [...newMoodles, { id: def.id, level: matched.level }]
        } else if (existing.level !== matched.level) {
          newMoodles = newMoodles.map((m: any) => m.id === def.id ? { ...m, level: matched.level } : m)
        }
      } else if (existing && t.remove_condition === 'thirst_above' && thirst >= (t.remove_value ?? 50)) {
        newMoodles = newMoodles.filter((m: any) => m.id !== def.id)
      }
    }

    // ── hp_below_pct ─────────────────────────────────────────
    if (t.condition === 'hp_below_pct') {
      const thresholds: Array<{value:number,level:number}> = t.thresholds ?? []
      const matched = [...thresholds]
        .sort((a, b) => b.value - a.value)
        .find(th => hpPct < th.value)
      if (matched) {
        if (!existing) {
          newMoodles = [...newMoodles, { id: def.id, level: matched.level }]
        } else if (existing.level !== matched.level) {
          newMoodles = newMoodles.map((m: any) => m.id === def.id ? { ...m, level: matched.level } : m)
        }
      } else if (existing && t.remove_condition === 'hp_above_pct' && hpPct >= (t.remove_value ?? 30)) {
        newMoodles = newMoodles.filter((m: any) => m.id !== def.id)
      }
    }

    // ── hp_below_pct_and_kills (คลั่ง) ──────────────────────────
    if (t.condition === 'hp_below_pct_and_kills') {
      const killMin = t.kill_value ?? 4
      const playerKillCount = (player as any).kill_count ?? 0
      const killConditionMet = playerKillCount > killMin
      const hpConditionMet = hpPct < (t.hp_value ?? 30)
      if (hpConditionMet && killConditionMet) {
        if (!existing) {
          newMoodles = [...newMoodles, { id: def.id, level: 1 }]
        }
      } else if (existing && t.remove_condition === 'hp_above_pct' && hpPct >= (t.remove_value ?? 30)) {
        newMoodles = newMoodles.filter((m: any) => m.id !== def.id)
      }
    }
  }

  if (JSON.stringify(newMoodles) !== JSON.stringify(player.moodles ?? [])) {
    updates.moodles = newMoodles
  }

  return { newMoodles, updates }
}
// ── ตรวจ winner และประกาศ ─────────────────────────────────────
// เรียกหลังผู้เล่นตายทุกครั้ง — ถ้าเหลือ 1 คน จบเกมทันที
export async function checkAndDeclareWinner(supabase: any, gameId: string): Promise<boolean> {
  const { data: alivePlayers } = await supabase
    .from('players')
    .select('id, name, kill_count, student_number')
    .eq('game_id', gameId)
    .eq('is_alive', true)
    .eq('is_banned', false)

  if (!alivePlayers || alivePlayers.length !== 1) return false

  const winner = alivePlayers[0]
  await supabase.from('games').update({
    status: 'จบแล้ว',
    winner_id: winner.id,
    winner_name: winner.name,
  }).eq('id', gameId)

  await supabase.from('events').insert({
    game_id: gameId,
    event_type: 'ชนะ',
    actor_id: winner.id,
    data: {
      winner_name: winner.name,
      kill_count: winner.kill_count ?? 0,
      student_number: winner.student_number,
    },
  })

  return true
}