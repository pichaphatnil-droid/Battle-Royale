import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getValidPlayer, getActiveGame, isCombatTime, applyMoodleTriggers, applyStatThresholdMoodles, checkAndDeclareWinner } from '@/lib/action-helpers'

const AP_COST_BASE = 30

export async function POST(request: Request) {
  try {
    // ── auth: ใช้ anon client เพื่ออ่าน session ──
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    // ── DB operations: ใช้ service client (bypass RLS) ──
    const supabase = await createServiceClient()

    const { game_id, target_player_id, weapon_id } = await request.json()
    if (!game_id || !target_player_id)
      return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    // เช็คเวลาต่อสู้ — ข้ามถ้าแอดมินเปิด force_combat
    if (!isCombatTime() && !(game as any).force_combat)
      return NextResponse.json({ error: 'ยังไม่ถึงเวลาต่อสู้ (19:00–00:00 น.)' }, { status: 400 })

    const { player: attacker, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!attacker) return NextResponse.json({ error }, { status: 400 })

    const { data: allTargets } = await supabase
      .from('players')
      .select('*')
      .eq('id', target_player_id)

    const target = allTargets?.[0]
    if (!target) return NextResponse.json({ error: 'ไม่พบเป้าหมาย' }, { status: 400 })
    if (!target.is_alive) return NextResponse.json({ error: 'เป้าหมายเสียชีวิตแล้ว' }, { status: 400 })
    if (target.id === attacker.id) return NextResponse.json({ error: 'โจมตีตัวเองไม่ได้' }, { status: 400 })

    if (attacker.pos_x === null || attacker.pos_y === null ||
        target.pos_x === null || target.pos_y === null)
      return NextResponse.json({ error: 'ตำแหน่งไม่ถูกต้อง' }, { status: 400 })

    let weaponData: any = { damage: 10, crit_chance: 5, range: 1, ap_cost: AP_COST_BASE, type: 'blunt' }
    let weaponName = 'มือเปล่า'

    if (weapon_id) {
      const weapon = attacker.inventory.find((i: any) => i.id === weapon_id)
      if (!weapon) return NextResponse.json({ error: 'ไม่มีอาวุธนี้ในกระเป๋า' }, { status: 400 })

      const { data: weaponDef } = await supabase
        .from('item_definitions')
        .select('*')
        .eq('id', weapon_id)
        .single()

      if (weaponDef?.data) {
        weaponData = { ...weaponDef.data, ap_cost: weaponDef.data.ap_cost ?? AP_COST_BASE }
        weaponName = weaponDef.name
      }
    }

    const weaponRange = weaponData.range ?? 1
    const dist = Math.max(
      Math.abs(attacker.pos_x - target.pos_x),
      Math.abs(attacker.pos_y - target.pos_y)
    )
    if (dist > weaponRange)
      return NextResponse.json({ error: `เป้าหมายอยู่ไกลเกินระยะอาวุธ (${dist}/${weaponRange} ช่อง)` }, { status: 400 })

    const apCost = weaponData.ap_cost ?? AP_COST_BASE
    const ap = await spendAP(supabase, attacker, apCost)
    if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })

    const baseDamage: number = weaponData.damage ?? 10
    const strBonus = weaponData.type === 'firearm' || weaponData.type === 'ranged'
      ? Math.floor(attacker.per * 0.5)
      : Math.floor(attacker.str * 0.8)
    const dodgeChance = Math.min(attacker.agi * 2 + attacker.stl * 1.5 + attacker.cha * 0.5, 40)
    const dodged = Math.random() * 100 < dodgeChance

    if (dodged) {
      await logEvent(supabase, {
        game_id, event_type: 'โจมตี-หลบ',
        actor_id: attacker.id, target_id: target.id,
        pos_x: attacker.pos_x, pos_y: attacker.pos_y,
        data: { weapon: weaponName, dodged: true },
      })
      return NextResponse.json({ ok: true, dodged: true, damage: 0, msg: `${target.name} หลบหนีการโจมตี` })
    }

    const hasTrembleHands = (attacker.traits ?? []).includes('มือสั่น')
    const critChance: number = Math.max(0, (weaponData.crit_chance ?? 5) + Math.floor(attacker.lck * 1.5) - (hasTrembleHands ? 5 : 0))
    const isCrit = Math.random() * 100 < critChance
    const critMult = isCrit ? 1.5 : 1.0

    // คำนวณ defense จากไอเทม passive ในกระเป๋าของ target
    const targetInventory: Array<{id:string,qty:number}> = target.inventory ?? []
    let totalDefense = 0
    if (targetInventory.length > 0) {
      const itemIds = targetInventory.map((i: any) => i.id)
      const { data: defItems } = await supabase
        .from('item_definitions').select('id,data')
        .in('id', itemIds)
      if (defItems) {
        for (const def of defItems) {
          const defense = (def.data as any)?.defense ?? 0
          if (defense > 0) totalDefense += defense
        }
      }
    }

    const hasThickSkin = (target.traits ?? []).includes('ผิวหนาเหมือหนัง')
    if (hasThickSkin) totalDefense = Math.min(80, totalDefense + 5)
    const defenseReduction = Math.min(totalDefense, 80) / 100
    const rawDamage = Math.round((baseDamage + strBonus) * critMult)
    let damage = Math.max(1, Math.round(rawDamage * (1 - defenseReduction)))

    const bleedChance: number = weaponData.bleed_chance ?? 0
    const bleeding = Math.random() * 100 < bleedChance
    const boneBreakChance: number = weaponData.bone_break_chance ?? 0
    const stunChance: number = weaponData.stun_chance ?? 0
    const stunned = Math.random() * 100 < stunChance

    const newHp = Math.max(0, target.hp - damage)
    const died = newHp <= 0

    await (supabase as any).from('players').update({ hp: newHp, is_alive: !died })
      .eq('id', target.id)

    // ── apply moodle triggers สำหรับ target (attack_received) ──
    const { newMoodles: targetMoodles } = await applyMoodleTriggers(
      supabase, target, 'attack_received',
      { weaponBleedChance: bleedChance, weaponBoneBreakChance: boneBreakChance }
    )
    // ── apply stat threshold moodles (ปวดมาก เมื่อ HP < 30%) ──
    const { newMoodles: targetMoodlesAfterHp, updates: targetHpUpdates } = await applyStatThresholdMoodles(
      supabase, { ...target, moodles: targetMoodles }, { hp: newHp, maxHp: target.max_hp }
    )
    if (!died) {
      await (supabase as any).from('players').update({ moodles: targetMoodlesAfterHp })
        .eq('id', target.id)
    }

    if (died) {
      await (supabase as any).from('players').update({ kill_count: attacker.kill_count + 1 })
        .eq('id', attacker.id)

      // ── apply moodle triggers สำหรับ attacker (attack_dealt) ──
      const newKillCount = attacker.kill_count + 1
      const { newMoodles: attackerMoodles } = await applyMoodleTriggers(
        supabase, attacker, 'attack_dealt',
        { killCount: newKillCount } // ส่ง kill_count หลัง +1 แล้ว
      )
      await (supabase as any).from('players').update({ moodles: attackerMoodles })
        .eq('id', attacker.id)

      // drop inventory ของผู้ตายลงพื้น
      const deadInventory: Array<{id:string,qty:number}> = target.inventory ?? []
      if (deadInventory.length > 0 && target.pos_x !== null && target.pos_y !== null) {
        const { data: gs } = await supabase
          .from('grid_states').select('*')
          .eq('game_id', game_id).eq('x', target.pos_x).eq('y', target.pos_y)
          .maybeSingle()

        const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString() // หายใน19060 นาที
        const existingDrops: Array<any> = gs?.dropped_items ?? []
        const newDrops = [
          ...existingDrops,
          ...deadInventory.map(item => ({
            id: item.id,
            qty: item.qty,
            dropped_by: target.name,
            dropped_by_id: target.id,
            expires_at: expiresAt,
          }))
        ]

        if (gs) {
          await (supabase as any).from('grid_states')
            .update({ dropped_items: newDrops })
            .eq('game_id', game_id).eq('x', target.pos_x).eq('y', target.pos_y)
        } else {
          await (supabase as any).from('grid_states')
            .insert({ game_id, x: target.pos_x, y: target.pos_y, items: [], dropped_items: newDrops })
        }

        // ล้าง inventory ของผู้ตาย
        await (supabase as any).from('players').update({ inventory: [] }).eq('id', target.id)
      }
    }

    await logEvent(supabase, {
      game_id,
      event_type: died ? 'ตาย' : 'โจมตี',
      actor_id: attacker.id,
      target_id: target.id,
      pos_x: attacker.pos_x,
      pos_y: attacker.pos_y,
      data: { weapon: weaponName, damage, crit: isCrit, bleeding, stunned, hp_left: newHp, defense: totalDefense },
    })

    // ตรวจ winner ทันทีหลังคนตาย
    if (died) await checkAndDeclareWinner(supabase, game_id)

    const msg = [
      `${attacker.name} โจมตี ${target.name} ด้วย${weaponName}`,
      isCrit ? ' [คริติคอล!]' : '',
      ` สร้างความเสียหาย ${damage}`,
      bleeding ? ' [เลือดออก]' : '',
      stunned ? ' [มึนงง]' : '',
      died ? ` — ${target.name} เสียชีวิต!` : ` (HP เหลือ ${newHp})`,
    ].join('')

    return NextResponse.json({ ok: true, damage, crit: isCrit, bleeding, stunned, died, hp_left: newHp, msg })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
