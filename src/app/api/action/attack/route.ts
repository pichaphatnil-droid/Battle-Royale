import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getPlayerAndGame, isCombatTime, applyMoodleTriggers, applyStatThresholdMoodles, checkAndDeclareWinner } from '@/lib/action-helpers'

const AP_COST_BASE = 30

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id, target_player_id, weapon_id } = await request.json()
    if (!game_id || !target_player_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    // ── 1st round trip: attacker + game + target พร้อมกัน ──
    const [
      { player: attacker, game, error },
      { data: targetArr },
    ] = await Promise.all([
      getPlayerAndGame(supabase, user.id, game_id),
      (supabase as any).from('players').select('*').eq('id', target_player_id).limit(1),
    ])
    if (!attacker || !game) return NextResponse.json({ error }, { status: 400 })
    if (!isCombatTime() && !(game as any).force_combat)
      return NextResponse.json({ error: 'ยังไม่ถึงเวลาต่อสู้ (19:00–00:00 น.)' }, { status: 400 })

    const target = targetArr?.[0]
    if (!target) return NextResponse.json({ error: 'ไม่พบเป้าหมาย' }, { status: 400 })
    if (!target.is_alive) return NextResponse.json({ error: 'เป้าหมายเสียชีวิตแล้ว' }, { status: 400 })
    if (target.id === attacker.id) return NextResponse.json({ error: 'โจมตีตัวเองไม่ได้' }, { status: 400 })
    if (attacker.pos_x === null || attacker.pos_y === null || target.pos_x === null || target.pos_y === null)
      return NextResponse.json({ error: 'ตำแหน่งไม่ถูกต้อง' }, { status: 400 })

    // ── 2nd round trip: weapon def + attacker traits + target traits + target items พร้อมกัน ──
    const attackerTraits: string[] = attacker.traits ?? []
    const targetTraits: string[] = target.traits ?? []
    const targetItemIds = (target.inventory ?? []).map((i: any) => i.id)
    const allTraitIds = [...new Set([...attackerTraits, ...targetTraits])]

    const [
      weaponDefResult,
      { data: allTraitDefs },
      { data: defItemDefs },
    ] = await Promise.all([
      weapon_id
        ? (supabase as any).from('item_definitions').select('*').eq('id', weapon_id).single()
        : Promise.resolve({ data: null }),
      allTraitIds.length > 0
        ? (supabase as any).from('trait_definitions').select('id,special_effects').in('id', allTraitIds)
        : Promise.resolve({ data: [] }),
      targetItemIds.length > 0
        ? (supabase as any).from('item_definitions').select('id,data').in('id', targetItemIds)
        : Promise.resolve({ data: [] }),
    ])

    // weapon
    let weaponData: any = { damage: 10, crit_chance: 5, range: 1, ap_cost: AP_COST_BASE, type: 'blunt' }
    let weaponName = 'มือเปล่า'
    if (weapon_id) {
      if (!attacker.inventory.find((i: any) => i.id === weapon_id))
        return NextResponse.json({ error: 'ไม่มีอาวุธนี้ในกระเป๋า' }, { status: 400 })
      const wd = weaponDefResult?.data
      if (wd?.data) { weaponData = { ...wd.data, ap_cost: wd.data.ap_cost ?? AP_COST_BASE }; weaponName = wd.name }
    }

    // trait fx map
    const traitFxMap = new Map((allTraitDefs ?? []).map((t: any) => [t.id, t.special_effects ?? {}]))
    const getFx = (traits: string[]) => {
      const merged: Record<string, any> = {}
      for (const tid of traits) {
        const fx: any = traitFxMap.get(tid) ?? {}
        for (const [k, v] of Object.entries(fx)) {
          if (typeof v === 'number') merged[k] = (merged[k] ?? 0) + v
          else merged[k] = v
        }
      }
      return merged
    }
    const attackerFx = getFx(attackerTraits)
    const targetFx = getFx(targetTraits)

    const rangedBonus = (weaponData.type === 'firearm' || weaponData.type === 'ranged') ? (attackerFx.ranged_range_bonus ?? 0) : 0
    const effectiveRange = (weaponData.range ?? 1) + rangedBonus
    const dist = Math.max(Math.abs(attacker.pos_x - target.pos_x), Math.abs(attacker.pos_y - target.pos_y))
    if (dist > effectiveRange)
      return NextResponse.json({ error: `เป้าหมายอยู่ไกลเกินระยะอาวุธ (${dist}/${effectiveRange} ช่อง)` }, { status: 400 })

    const ap = await spendAP(supabase, attacker, weaponData.ap_cost ?? AP_COST_BASE)
    if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })

    const strBonus = weaponData.type === 'firearm' || weaponData.type === 'ranged'
      ? Math.floor(attacker.per * 0.5) : Math.floor(attacker.str * 0.8)
    const dodgeChance = Math.min(target.agi * 2 + target.stl * 1.5 + target.cha * 0.5, 40)
    const dodged = Math.random() * 100 < dodgeChance

    if (dodged) {
      await logEvent(supabase, { game_id, event_type: 'โจมตี-หลบ', actor_id: attacker.id, target_id: target.id, pos_x: attacker.pos_x, pos_y: attacker.pos_y, data: { weapon: weaponName, dodged: true } })
      return NextResponse.json({ ok: true, dodged: true, damage: 0, msg: `${target.name} หลบหนีการโจมตี` })
    }

    const critChance = Math.max(0, (weaponData.crit_chance ?? 5) + Math.floor(attacker.lck * 1.5) - (attackerFx.crit_penalty ?? 0))
    const isCrit = Math.random() * 100 < critChance
    const critMult = isCrit ? 1.5 : 1.0

    let totalDefense = 0
    for (const def of defItemDefs ?? []) {
      const defense = (def.data as any)?.defense ?? 0
      if (defense > 0) totalDefense += defense
    }
    if ((targetFx.passive_defense ?? 0) > 0) totalDefense = Math.min(80, totalDefense + targetFx.passive_defense)
    const defenseReduction = Math.min(totalDefense, 80) / 100

    const baseDamage: number = weaponData.damage ?? 10
    const damage = Math.max(1, Math.round((baseDamage + strBonus) * critMult * (1 - defenseReduction)))
    const bleedChance: number = weaponData.bleed_chance ?? 0
    const bleeding = Math.random() * 100 < bleedChance
    const stunned = Math.random() * 100 < (weaponData.stun_chance ?? 0)
    const newHp = Math.max(0, target.hp - damage)
    const died = newHp <= 0

    // ── moodle triggers (parallel where possible) ──
    const [{ newMoodles: targetMoodles }] = await Promise.all([
      applyMoodleTriggers(supabase, target, 'attack_received', { weaponBleedChance: bleedChance, weaponBoneBreakChance: weaponData.bone_break_chance ?? 0 }),
    ])
    const { newMoodles: targetMoodlesAfterHp } = await applyStatThresholdMoodles(supabase, { ...target, moodles: targetMoodles }, { hp: newHp, maxHp: target.max_hp })

    const targetUpdate: any = { hp: newHp, is_alive: !died, moodles: targetMoodlesAfterHp }
    if (died) targetUpdate.inventory = []

    // ── Final writes: all parallel ──
    const writes: Promise<any>[] = [
      (supabase as any).from('players').update(targetUpdate).eq('id', target.id),
      logEvent(supabase, {
        game_id, event_type: died ? 'ตาย' : 'โจมตี',
        actor_id: attacker.id, target_id: target.id,
        pos_x: attacker.pos_x, pos_y: attacker.pos_y,
        data: { weapon: weaponName, damage, crit: isCrit, bleeding, stunned, hp_left: newHp, defense: totalDefense },
      }),
    ]

    if (died) {
      // drop inventory + attacker kill_count + attacker moodle
      const deadInventory: any[] = target.inventory ?? []
      if (deadInventory.length > 0 && target.pos_x !== null) {
        const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
        writes.push(
          (supabase as any).from('grid_states').upsert(
            { game_id, x: target.pos_x, y: target.pos_y, items: [], dropped_items: deadInventory.map((item: any) => ({ id: item.id, qty: item.qty, dropped_by: target.name, dropped_by_id: target.id, expires_at: expiresAt })) },
            { onConflict: 'game_id,x,y', ignoreDuplicates: false }
          )
        )
      }
      writes.push((supabase as any).from('players').update({ kill_count: attacker.kill_count + 1 }).eq('id', attacker.id))
    }

    await Promise.all(writes)
    if (died) await checkAndDeclareWinner(supabase, game_id)

    const msg = [`${attacker.name} โจมตี ${target.name} ด้วย${weaponName}`, isCrit ? ' [คริติคอล!]' : '', ` สร้างความเสียหาย ${damage}`, bleeding ? ' [เลือดออก]' : '', stunned ? ' [มึนงง]' : '', died ? ` — ${target.name} เสียชีวิต!` : ` (HP เหลือ ${newHp})`].join('')
    return NextResponse.json({ ok: true, damage, crit: isCrit, bleeding, stunned, died, hp_left: newHp, msg })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
