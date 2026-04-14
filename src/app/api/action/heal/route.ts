import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getValidPlayer, getActiveGame, applyStatThresholdMoodles } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()

    const { game_id, item_id } = await request.json()
    if (!game_id || !item_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    // ดึง item definition จาก DB
    const { data: itemDef } = await supabase
      .from('item_definitions')
      .select('*')
      .eq('id', item_id)
      .single()

    if (!itemDef) return NextResponse.json({ error: 'ไม่พบไอเทมนี้ในระบบ' }, { status: 400 })

    const effect = itemDef.data as Record<string, any>

    // ตรวจว่ามี effect อะไรสักอย่าง
    const hasEffect = effect && (
      effect.hp ||
      effect.hunger ||
      effect.thirst ||
      effect.removes_moodle ||
      effect.ap_bonus ||
      effect.int_bonus
    )
    if (!hasEffect)
      return NextResponse.json({ error: 'ไอเทมนี้ใช้ไม่ได้' }, { status: 400 })

    const apCost = effect.ap_cost ?? 10

    // คำนวณค่าปัจจุบัน lazy จาก timestamp
    const nowMs = Date.now()
    const traits: string[] = player.traits ?? []
    const hungerRate = traits.includes('กินน้อยอยู่ได้') ? 1.25 : traits.includes('ขี้หิวเป็นพิเศษ') ? 5.0 : 2.5
    const thirstRate = traits.includes('อดน้ำเก่ง') ? 2.0 : traits.includes('คอแห้งตลอดเวลา') ? 8.0 : 4.0
    const hungerHours = (nowMs - new Date(player.hunger_updated_at ?? nowMs).getTime()) / 3_600_000
    const thirstHours = (nowMs - new Date(player.thirst_updated_at ?? nowMs).getTime()) / 3_600_000
    const currentHunger = Math.max(0, Math.round((player.hunger ?? 100) - hungerHours * hungerRate))
    const currentThirst = Math.max(0, Math.round((player.thirst ?? 100) - thirstHours * thirstRate))

    // ตรวจว่าใช้ได้ไหม — อาหาร/น้ำกินได้เสมอแม้เต็ม
    if (effect.hp && player.hp >= player.max_hp)
      return NextResponse.json({ error: 'HP เต็มแล้ว' }, { status: 400 })

    // ตรวจกระเป๋า
    const inventory: Array<{id:string, qty:number}> = player.inventory ?? []
    const itemIdx = inventory.findIndex(i => i.id === item_id)
    if (itemIdx === -1) return NextResponse.json({ error: 'ไม่มีไอเทมนี้ในกระเป๋า' }, { status: 400 })

    // หัก AP เฉพาะถ้า ap_cost > 0 (อาหาร/ยา/ปฐมพยาบาล = ฟรี)
    if (apCost > 0) {
      const ap = await spendAP(supabase, player, apCost)
      if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })
    }

    const updates: Record<string, any> = {}
    const msgs: string[] = []
    const apBonus: number = effect.ap_bonus ?? 0

    // สุ่ม side effect ล่วงหน้า เพื่อใช้ตัดสิน cancel main effect
    const sideEffectTriggered =
      effect.side_effect_moodle &&
      effect.side_effect_chance &&
      Math.random() < (effect.side_effect_chance as number)

    // HP — INT ช่วยเพิ่มประสิทธิภาพ
    if (effect.hp) {
      const intBonus = Math.floor(player.int * 0.3)
      const hasHerbalDoc = (player.traits ?? []).includes('หมอบ้าน')
      const healMult = hasHerbalDoc ? 1.3 : 1.0
      const healed = Math.round(((effect.hp as number) + intBonus) * healMult)
      updates.hp = Math.min(player.hp + healed, player.max_hp)
      msgs.push(`HP +${healed}`)
    }

    // Hunger — ถ้า side_effect_cancels_main และ trigger แล้ว ให้ข้ามไป
    if (effect.hunger && !(effect.side_effect_cancels_main && sideEffectTriggered)) {
      updates.hunger = Math.min(currentHunger + (effect.hunger as number), 100)
      updates.hunger_updated_at = new Date().toISOString()
      msgs.push(`หิว ${currentHunger} → ${updates.hunger}`)
    }

    // Thirst
    if (effect.thirst) {
      updates.thirst = Math.min(currentThirst + (effect.thirst as number), 100)
      updates.thirst_updated_at = new Date().toISOString()
      msgs.push(`กระหาย ${currentThirst} → ${updates.thirst}`)
    }

    // AP bonus (ถ้ามี)
    if (apBonus > 0) {
      const { calcAP } = await import('@/lib/action-helpers')
      const currentAp = calcAP(player.ap, player.ap_updated_at)
      updates.ap = Math.min(currentAp + apBonus, 600)
      updates.ap_updated_at = new Date().toISOString()
      msgs.push(`AP +${apBonus}`)
    }

    // INT bonus จากหนังสือ — cap ที่ 8
    if (effect.int_bonus) {
      const newInt = Math.min((player.int ?? 0) + (effect.int_bonus as number), 8)
      updates.int = newInt
      msgs.push(`INT ${player.int} → ${newInt}`)
    }

    // ลบ moodle
    let newMoodles = [...(player.moodles ?? [])]
    if (effect.removes_moodle) {
      newMoodles = newMoodles.filter((m: any) => m.id !== effect.removes_moodle)
      msgs.push(`หาย ${effect.removes_moodle}`)
    }

    // Side effect moodle (เช่น ท้องเสีย, เป็นพิษ, ติดยา)
    if (sideEffectTriggered) {
      const alreadyHas = newMoodles.some((m: any) => m.id === effect.side_effect_moodle)
      if (!alreadyHas) {
        newMoodles = [...newMoodles, { id: effect.side_effect_moodle, level: 1 }]
      }
      if (effect.side_effect_cancels_main) {
        msgs.push(`ผลเบอร์รี่มีพิษ! ติด ${effect.side_effect_moodle}`)
      } else {
        msgs.push(`ติด ${effect.side_effect_moodle}!`)
      }
    }

    // ดึง moodleDefs ครั้งเดียว เพื่อส่งเข้า applyStatThresholdMoodles ไม่ต้อง query ซ้ำ
    const { data: moodleDefs } = await supabase
      .from('moodle_definitions')
      .select('id, trigger, max_level')
      .eq('is_active', true)
      .not('trigger', 'is', null)

    // apply stat threshold moodles — เช็ค หิว/กระหาย/ปวดมาก หลัง update
    const { newMoodles: finalMoodles } = await applyStatThresholdMoodles(
      supabase,
      { ...player, moodles: newMoodles },
      {
        hunger: updates.hunger ?? undefined,
        thirst: updates.thirst ?? undefined,
        hp: updates.hp ?? undefined,
        maxHp: player.max_hp,
      },
      moodleDefs ?? undefined
    )
    updates.moodles = finalMoodles

    // ลดไอเทมในกระเป๋า
    const newInventory = [...inventory]
    newInventory[itemIdx] = { ...newInventory[itemIdx], qty: newInventory[itemIdx].qty - 1 }
    updates.inventory = newInventory.filter(i => i.qty > 0)

    await supabase.from('players').update(updates).eq('id', player.id)

    await logEvent(supabase, {
      game_id, event_type: 'ใช้ไอเทม',
      actor_id: player.id,
      pos_x: player.pos_x ?? undefined,
      pos_y: player.pos_y ?? undefined,
      data: { item: item_id, effect: updates },
    })

    return NextResponse.json({
      ok: true,
      msg: `ใช้ ${itemDef.name}: ${msgs.join(', ')}`,
      hp: updates.hp,
      hunger: updates.hunger,
      thirst: updates.thirst,
      ap: updates.ap,
      int: updates.int,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}