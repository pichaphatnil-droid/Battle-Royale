import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { applyStatThresholdMoodles, checkAndDeclareWinner } from '@/lib/action-helpers'

const HUNGER_PER_HOUR = 5.0
const THIRST_PER_HOUR = 8.0
const TICK_MINUTES = 10

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ใช้ service client เพื่อ bypass RLS
  const supabase = await createServiceClient()
  const results: Record<string, unknown> = {}

  try {
    // ── ดึงเกมที่กำลังเล่น ────────────────────────────────────
    const { data: games } = await (supabase as any)
      .from('games')
      .select('id')
      .eq('status', 'กำลังเล่น')

    // ── ดึง moodle_definitions ที่มี level_effects มีผล HP ──
    // ใช้ครั้งเดียวนอก loop เพื่อประหยัด query
    const { data: moodleDefs } = await (supabase as any)
      .from('moodle_definitions')
      .select('id, level_effects, trigger')
      .eq('is_active', true)

    for (const game of games ?? []) {
      const { data: players } = await (supabase as any)
        .from('players')
        .select('*')
        .eq('game_id', game.id)
        .eq('is_alive', true)
        .eq('is_banned', false)

      for (const player of players ?? []) {
        const updates: Record<string, unknown> = {}
        const now = Date.now()

        // ── คำนวณ hunger/thirst แบบ lazy จาก timestamp ──────────
        const hungerSavedAt = player.hunger_updated_at ?? new Date().toISOString()
        const thirstSavedAt = player.thirst_updated_at ?? new Date().toISOString()
        const hoursSinceHunger = (now - new Date(hungerSavedAt).getTime()) / 3_600_000
        const hoursSinceThirst = (now - new Date(thirstSavedAt).getTime()) / 3_600_000

        // คำนวณ rate จาก trait special_effects
        const traits: string[] = player.traits ?? []
        // หา hunger_rate และ thirst_rate multiplier จาก trait_definitions
        let traitHungerMult = 1.0
        let traitThirstMult = 1.0
        if (traits.length > 0) {
          const { data: traitDefs } = await (supabase as any)
            .from('trait_definitions')
            .select('id, special_effects')
            .in('id', traits)
          for (const td of traitDefs ?? []) {
            const fx = td.special_effects as Record<string, any> ?? {}
            if (fx.hunger_rate) traitHungerMult *= fx.hunger_rate
            if (fx.thirst_rate) traitThirstMult *= fx.thirst_rate
          }
        }
        const hungerRate = HUNGER_PER_HOUR * traitHungerMult
        const thirstRate = THIRST_PER_HOUR * traitThirstMult

        // คำนวณ moodle ท้องเสีย thirst multiplier
        const currentMoodles: any[] = player.moodles ?? []
        const thirstMult = currentMoodles.reduce((mult: number, m: any) => {
          const def = moodleDefs?.find((d: any) => d.id === m.id)
          const level = m.level ?? 1
          const fx = def?.level_effects?.find((e: any) => e['ระดับ'] === level)
          const tm = fx?.['ผล']?.thirst_rate_multiplier ?? 1
          return mult * (tm > 0 ? tm : 1)
        }, 1)

        const newHunger = Math.max(0, Math.round((player.hunger ?? 100) - hoursSinceHunger * hungerRate))
        const newThirst = Math.max(0, Math.round((player.thirst ?? 100) - hoursSinceThirst * thirstRate * thirstMult))
        updates.hunger = newHunger
        updates.thirst = newThirst
        updates.hunger_updated_at = new Date().toISOString()
        updates.thirst_updated_at = new Date().toISOString()

        // ── หมด Moodle ที่หมดเวลา ────────────────────────────────
        let newMoodles = currentMoodles.filter((m: any) => {
          if (!m.expires_at) return true
          return new Date(m.expires_at).getTime() > now
        })

        // ── apply stat threshold moodles (หิว, กระหาย, ปวดมาก) ──
        // ส่ง moodleDefs ที่ดึงมาแล้วเข้าไปเลย ไม่ต้อง query ซ้ำ
        const { newMoodles: moodlesAfterThreshold } = await applyStatThresholdMoodles(
          supabase,
          { ...player, moodles: newMoodles },
          { hunger: newHunger, thirst: newThirst, hp: player.hp, maxHp: player.max_hp },
          moodleDefs ?? undefined
        )
        newMoodles = moodlesAfterThreshold

        // ── ลด HP จาก level_effects ของ moodle ──────────────────
        // อ่านจาก DB ไม่ hardcode — ดึง "พลังชีวิตต่อนาที" จาก level_effects
        let hpDropPerMin = 0
        for (const m of newMoodles) {
          const def = moodleDefs?.find((d: any) => d.id === m.id)
          if (!def) continue
          const level = m.level ?? 1
          const fx = def.level_effects?.find((e: any) => e['ระดับ'] === level)
          const hpPerMin = fx?.['ผล']?.['พลังชีวิตต่อนาที'] ?? 0
          if (hpPerMin < 0) hpDropPerMin += Math.abs(hpPerMin)
        }

        // บวก HP drop จาก hunger/thirst ขั้นวิกฤต
        if (newThirst === 0) hpDropPerMin += 5 / 60
        if (newHunger === 0) hpDropPerMin += 3 / 60

        const hpDrop = hpDropPerMin * TICK_MINUTES
        const newHp = Math.max(0, player.hp - hpDrop)
        updates.hp = Math.round(newHp)
        updates.moodles = newMoodles

        // ── ตาย ────────────────────────────────────────────────
        if (newHp <= 0) {
          updates.is_alive = false
          updates.hp = 0
          await (supabase as any).from('events').insert({
            game_id: game.id,
            event_type: 'ตาย',
            actor_id: null,
            target_id: player.id,
            pos_x: player.pos_x,
            pos_y: player.pos_y,
            data: { cause: hpDrop > 0 ? 'สภาพแวดล้อม' : 'unknown', name: player.name },
          })
        }

        await (supabase as any).from('players').update(updates).eq('id', player.id)
      }

      // ── ตรวจ winner หลัง update ทุกคนแล้ว ───────────────────
      await checkAndDeclareWinner(supabase, game.id)
    }

    // ── รีสปอว์น grid ─────────────────────────────────────────
    const { error: respawnError } = await (supabase as any).rpc('ตรวจรีสปอว์นทั้งหมด')
    results.respawn = respawnError ? `error: ${respawnError.message}` : 'ok'

    // ── ลบของทิ้งที่หมดอายุ (เฉพาะเกมที่กำลังเล่น) ──────────────
    const activeGameIds = (games ?? []).map((g: any) => g.id)
    if (activeGameIds.length > 0) {
      const { data: allGs } = await (supabase as any)
        .from('grid_states').select('id, dropped_items')
        .in('game_id', activeGameIds)
      let cleanedCount = 0
      for (const gs of (allGs ?? []) as any[]) {
        const drops: any[] = (gs as any).dropped_items ?? []
        const validDrops = drops.filter((d: any) =>
          !d.expires_at || new Date(d.expires_at).getTime() > Date.now()
        )
        if (validDrops.length !== drops.length) {
          await (supabase as any).from('grid_states')
            .update({ dropped_items: validDrops }).eq('id', gs.id)
          cleanedCount += drops.length - validDrops.length
        }
      }
      results.cleaned_drops = cleanedCount
    } else {
      results.cleaned_drops = 0
    }

    // ── ทรยศ ──────────────────────────────────────────────────
    const { data: betrayals } = await (supabase as any)
      .from('betrayal_queue')
      .select('*, alliances(*)')
      .lte('takes_effect_at', new Date().toISOString())

    for (const b of betrayals ?? []) {
      await (supabase as any).from('alliances')
        .update({ disbanded_at: new Date().toISOString() })
        .eq('id', b.alliance_id)
      await (supabase as any).from('betrayal_queue').delete().eq('id', b.id)
      const alliance = b.alliances as { game_id: string } | null
      if (alliance) {
        await (supabase as any).from('events').insert({
          game_id: alliance.game_id,
          event_type: 'ทรยศ',
          actor_id: b.betrayer_id,
          data: { alliance_id: b.alliance_id },
        })
      }
    }
    results.betrayals = `processed ${betrayals?.length ?? 0}`
    results.games = games?.length ?? 0

    return NextResponse.json({ ok: true, ...results })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
