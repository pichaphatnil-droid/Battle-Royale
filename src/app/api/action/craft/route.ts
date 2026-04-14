import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getValidPlayer, getActiveGame } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()

    const { game_id, recipe_id } = await request.json()
    if (!game_id || !recipe_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    // ดึงสูตร
    const { data: recipe } = await (supabase as any)
      .from('craft_recipes')
      .select('*')
      .eq('id', recipe_id)
      .eq('is_active', true)
      .single()

    if (!recipe) return NextResponse.json({ error: 'ไม่พบสูตรนี้' }, { status: 400 })

    // ตรวจ INT ขั้นต่ำ
    const isSmartStudent = (player.traits ?? []).includes('เรียนเก่ง')
    const effectiveMinInt = Math.max(0, recipe.min_int - (isSmartStudent ? 2 : 0))
    if (player.int < effectiveMinInt)
      return NextResponse.json({ error: `ต้องการ INT ${effectiveMinInt} (มี ${player.int})` }, { status: 400 })

    // ตรวจวัสดุ
    const inventory: Array<{id:string, qty:number}> = player.inventory ?? []
    for (const ingredient of recipe.ingredients) {
      const item = inventory.find(i => i.id === ingredient.id)
      if (!item || item.qty < ingredient.qty)
        return NextResponse.json({
          error: `ขาดวัสดุ: ${ingredient.id} (มี ${item?.qty ?? 0}/${ingredient.qty})`
        }, { status: 400 })
    }

    // หักแต้ม AP
    const isCraftsman = (player.traits ?? []).includes('ช่างฝีมือ')
    const craftApCost = Math.max(0, recipe.ap_cost - (isCraftsman ? 10 : 0))
    const ap = await spendAP(supabase, player, craftApCost)
    if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })

    // ลดวัสดุจากกระเป๋า (ไฟแช็กเป็น catalyst — ไม่หาย)
    const CATALYST_IDS = ['ไฟแช็ก']
    let newInventory = [...inventory]
    for (const ingredient of recipe.ingredients) {
      if (CATALYST_IDS.includes(ingredient.id)) continue
      const idx = newInventory.findIndex(i => i.id === ingredient.id)
      newInventory[idx] = { ...newInventory[idx], qty: newInventory[idx].qty - ingredient.qty }
    }
    newInventory = newInventory.filter(i => i.qty > 0)

    // เพิ่มของที่คราฟต์
    const existingResult = newInventory.find(i => i.id === recipe.result_id)
    if (existingResult) {
      existingResult.qty += recipe.result_qty
    } else {
      newInventory.push({ id: recipe.result_id, qty: recipe.result_qty })
    }

    // บันทึกสูตรที่รู้จัก (ถ้ายังไม่รู้)
    const knownRecipes = player.known_recipes ?? []
    const newKnown = knownRecipes.includes(recipe_id)
      ? knownRecipes
      : [...knownRecipes, recipe_id]

    // อัปเดต player
    await (supabase as any).from('players').update({
      inventory: newInventory,
      known_recipes: newKnown,
    }).eq('id', player.id)

    // บันทึก event
    await logEvent(supabase, {
      game_id,
      event_type: 'คราฟต์',
      actor_id: player.id,
      pos_x: player.pos_x ?? undefined,
      pos_y: player.pos_y ?? undefined,
      data: { recipe: recipe_id, result: recipe.result_id, qty: recipe.result_qty },
    })

    return NextResponse.json({
      ok: true,
      result: recipe.result_id,
      qty: recipe.result_qty,
      msg: `คราฟต์ ${recipe.result_id} ×${recipe.result_qty} สำเร็จ`
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
