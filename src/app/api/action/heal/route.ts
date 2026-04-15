import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getPlayerAndGame, applyStatThresholdMoodles, calcAP } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id, item_id } = await request.json()
    if (!game_id || !item_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    // ── 1st round trip: player + game + itemDef + traitDefs + moodleDefs พร้อมกัน ──
    const { player, game, error } = await getPlayerAndGame(supabase, user.id, game_id)
    if (!player || !game) return NextResponse.json({ error }, { status: 400 })

    const traits: string[] = player.traits ?? []
    const [
      { data: itemDef },
      { data: traitDefs },
      { data: moodleDefs },
    ] = await Promise.all([
      (supabase as any).from('item_definitions').select('*').eq('id', item_id).single(),
      traits.length > 0
        ? (supabase as any).from('trait_definitions').select('id,special_effects').in('id', traits)
        : Promise.resolve({ data: [] }),
      (supabase as any).from('moodle_definitions').select('id,trigger,max_level').eq('is_active', true).not('trigger', 'is', null),
    ])

    if (!itemDef) return NextResponse.json({ error: 'ไม่พบไอเทมนี้ในระบบ' }, { status: 400 })
    const effect = itemDef.data as Record<string, any>
    const hasEffect = effect && (effect.hp || effect.hunger || effect.thirst || effect.removes_moodle || effect.ap_bonus || effect.int_bonus)
    if (!hasEffect) return NextResponse.json({ error: 'ไอเทมนี้ใช้ไม่ได้' }, { status: 400 })
    if (effect.hp && player.hp >= player.max_hp) return NextResponse.json({ error: 'HP เต็มแล้ว' }, { status: 400 })

    const inventory: Array<{id:string,qty:number}> = player.inventory ?? []
    const itemIdx = inventory.findIndex(i => i.id === item_id)
    if (itemIdx === -1) return NextResponse.json({ error: 'ไม่มีไอเทมนี้ในกระเป๋า' }, { status: 400 })

    const apCost = effect.ap_cost ?? 10
    if (apCost > 0) {
      const ap = await spendAP(supabase, player, apCost)
      if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })
    }

    // trait fx
    const traitFxMap = new Map((traitDefs ?? []).map((t: any) => [t.id, t.special_effects ?? {}]))
    let hungerMult = 1, thirstMult = 1, healMult = 1
    for (const tid of traits) {
      const fx: any = traitFxMap.get(tid) ?? {}
      if (fx.hunger_rate) hungerMult *= fx.hunger_rate
      if (fx.thirst_rate) thirstMult *= fx.thirst_rate
      if (fx.heal_multiplier) healMult = fx.heal_multiplier
    }

    // lazy hunger/thirst
    const nowMs = Date.now()
    const hungerHours = (nowMs - new Date(player.hunger_updated_at ?? nowMs).getTime()) / 3_600_000
    const thirstHours = (nowMs - new Date(player.thirst_updated_at ?? nowMs).getTime()) / 3_600_000
    const currentHunger = Math.max(0, Math.round((player.hunger ?? 100) - hungerHours * 5.0 * hungerMult))
    const currentThirst = Math.max(0, Math.round((player.thirst ?? 100) - thirstHours * 8.0 * thirstMult))

    const sideEffectTriggered = effect.side_effect_moodle && effect.side_effect_chance && Math.random() < (effect.side_effect_chance as number)
    const updates: Record<string, any> = {}
    const msgs: string[] = []

    if (effect.hp) {
      const healed = Math.round(((effect.hp as number) + Math.floor(player.int * 0.3)) * healMult)
      updates.hp = Math.min(player.hp + healed, player.max_hp)
      msgs.push(`HP +${healed}`)
    }
    if (effect.hunger && !(effect.side_effect_cancels_main && sideEffectTriggered)) {
      updates.hunger = Math.min(currentHunger + (effect.hunger as number), 100)
      updates.hunger_updated_at = new Date().toISOString()
      msgs.push(`หิว ${currentHunger}→${updates.hunger}`)
    }
    if (effect.thirst) {
      updates.thirst = Math.min(currentThirst + (effect.thirst as number), 100)
      updates.thirst_updated_at = new Date().toISOString()
      msgs.push(`กระหาย ${currentThirst}→${updates.thirst}`)
    }
    if ((effect.ap_bonus ?? 0) > 0) {
      updates.ap = Math.min(calcAP(player.ap, player.ap_updated_at) + (effect.ap_bonus as number), 600)
      updates.ap_updated_at = new Date().toISOString()
      msgs.push(`AP +${effect.ap_bonus}`)
    }
    if (effect.int_bonus) {
      updates.int = Math.min((player.int ?? 0) + (effect.int_bonus as number), 8)
      msgs.push(`INT ${player.int}→${updates.int}`)
    }

    let newMoodles = [...(player.moodles ?? [])]
    if (effect.removes_moodle) { newMoodles = newMoodles.filter((m: any) => m.id !== effect.removes_moodle); msgs.push(`หาย ${effect.removes_moodle}`) }
    if (sideEffectTriggered && !newMoodles.some((m: any) => m.id === effect.side_effect_moodle)) {
      newMoodles = [...newMoodles, { id: effect.side_effect_moodle, level: 1 }]
      msgs.push(effect.side_effect_cancels_main ? `ผลเบอร์รี่มีพิษ! ติด ${effect.side_effect_moodle}` : `ติด ${effect.side_effect_moodle}!`)
    }

    const { newMoodles: finalMoodles } = await applyStatThresholdMoodles(supabase, { ...player, moodles: newMoodles }, { hunger: updates.hunger, thirst: updates.thirst, hp: updates.hp, maxHp: player.max_hp }, moodleDefs ?? undefined)
    updates.moodles = finalMoodles

    const newInventory = [...inventory]
    newInventory[itemIdx] = { ...newInventory[itemIdx], qty: newInventory[itemIdx].qty - 1 }
    updates.inventory = newInventory.filter(i => i.qty > 0)

    await Promise.all([
      (supabase as any).from('players').update(updates).eq('id', player.id),
      logEvent(supabase, { game_id, event_type: 'ใช้ไอเทม', actor_id: player.id, pos_x: player.pos_x ?? undefined, pos_y: player.pos_y ?? undefined, data: { item: item_id } }),
    ])

    return NextResponse.json({ ok: true, msg: `ใช้ ${itemDef.name}: ${msgs.join(', ')}`, hp: updates.hp, hunger: updates.hunger, thirst: updates.thirst, ap: updates.ap, int: updates.int })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
