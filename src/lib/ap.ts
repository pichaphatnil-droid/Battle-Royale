const AP_PER_MINUTE = 10
const AP_MAX = 600

export function calculateCurrentAP(savedAP: number, savedAt: string | Date, apRegenRate = 1.0): number {
  const savedTime = new Date(savedAt).getTime()
  const minutesPassed = (Date.now() - savedTime) / 60_000
  return Math.min(savedAP + Math.floor(minutesPassed * AP_PER_MINUTE * apRegenRate), AP_MAX)
}

export function apToPercent(ap: number): number {
  return Math.round((ap / AP_MAX) * 100)
}

export function timeUntilFull(savedAP: number, savedAt: string | Date): Date | null {
  const current = calculateCurrentAP(savedAP, savedAt)
  if (current >= AP_MAX) return null
  const minutesNeeded = (AP_MAX - current) / AP_PER_MINUTE
  return new Date(Date.now() + minutesNeeded * 60_000)
}

export { AP_MAX, AP_PER_MINUTE }

// ── Hunger / Thirst lazy calculation ─────────────────────────
const HUNGER_PER_HOUR = 5.0
const THIRST_PER_HOUR = 8.0

export function calculateCurrentHunger(saved: number, savedAt: string, traits: string[] = [], traitFx?: Record<string,any>): number {
  const hours = (Date.now() - new Date(savedAt).getTime()) / 3_600_000
  const mult = traitFx?.hunger_rate ?? (
    traits.includes('กินน้อยอยู่ได้') ? 0.5
    : traits.includes('ตะกละตะกลาม') ? 2
    : traits.includes('กระเพาะเล็ก') ? 0.5
    : traits.includes('ขี้หิวเป็นพิเศษ') ? 2
    : 1
  )
  return Math.max(0, Math.round(saved - hours * HUNGER_PER_HOUR * mult))
}

export function calculateCurrentThirst(saved: number, savedAt: string, traits: string[] = [], traitFx?: Record<string,any>): number {
  const hours = (Date.now() - new Date(savedAt).getTime()) / 3_600_000
  const mult = traitFx?.thirst_rate ?? (
    traits.includes('อดน้ำเก่ง') ? 0.5
    : traits.includes('คอแห้ง') ? 2
    : traits.includes('ชุ่มชื้น') ? 0.5
    : traits.includes('คอแห้งตลอดเวลา') ? 2
    : 1
  )
  return Math.max(0, Math.round(saved - hours * THIRST_PER_HOUR * mult))
}

export function hungerColor(val: number): string {
  if (val < 25) return 'var(--red-bright)'
  if (val < 50) return '#E67E22'
  return '#8B6914'
}

export function thirstColor(val: number): string {
  if (val < 25) return 'var(--red-bright)'
  if (val < 50) return '#E67E22'
  return '#2A5A8A'
}
