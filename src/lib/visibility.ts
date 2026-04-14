import type { Grid, Player } from './supabase/types'

export function isCombatTime(): boolean {
  const hour = (new Date().getUTCHours() + 7) % 24
  return hour >= 19 && hour < 24
}

export function isNight(): boolean {
  const hour = (new Date().getUTCHours() + 7) % 24
  return hour >= 19 || hour < 6
}

export function getVisibilityRange(grid: Grid, traits: string[], equipment: string[]): number {
  let range = grid.visibility
  if (isNight()) range -= 1
  if (equipment.includes('กล้องมองกลางคืน') && isNight()) range += 1
  if (equipment.includes('กล้องส่องทางไกล')) range += 2
  if (equipment.includes('ไฟฉาย') && (isNight() || grid.terrain === 'ถ้ำ')) range += 1
  if (traits.includes('นักล่า')) range += 1
  if (traits.includes('ช่างสังเกต')) range += 1
  if (traits.includes('นักสำรวจ')) range += 1
  if (traits.includes('ตาฝ้าฟาง')) range -= 1
  return Math.max(0, range)
}

export function cellsInRange(x: number, y: number, range: number): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = []
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      const nx = x + dx, ny = y + dy
      if (nx >= 0 && nx < 30 && ny >= 0 && ny < 30) result.push({ x: nx, y: ny })
    }
  }
  return result
}

export function isInRange(px: number, py: number, tx: number, ty: number, range: number): boolean {
  return Math.abs(px - tx) <= range && Math.abs(py - ty) <= range
}

export function canSeeEvent(params: {
  event: { actor_id: string | null; pos_x: number | null; pos_y: number | null; event_type: string }
  player: { id: string; pos_x: number | null; pos_y: number | null }
  allyIds: string[]
  visibilityRange: number
}): boolean {
  const { event, player, allyIds, visibilityRange } = params
  const systemEvents = ['ประกาศ', 'เขตอันตราย', 'ตาย', 'ผลคะแนน']
  if (systemEvents.some(t => event.event_type.includes(t))) return true
  if (event.actor_id === player.id) return true
  if (event.actor_id && allyIds.includes(event.actor_id)) return true
  if (event.pos_x !== null && event.pos_y !== null && player.pos_x !== null && player.pos_y !== null) {
    return isInRange(player.pos_x, player.pos_y, event.pos_x, event.pos_y, visibilityRange)
  }
  return false
}