import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getPlayerAndGame } from '@/lib/action-helpers'

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id, recipe_id } = await request.json()
    if (!game_id || !recipe_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    // ── 1st round trip: player + game + recipe + traitDefs พร้อมกัน ──
    const [{ player, game, error }, { data: recipe }] = await Promise.all([
      getPlayerAndGame(supabase, user.id, game_id),
      (supabase as any).from('craft_recipes').select('*').eq('id', recipe_id).eq('is_active', true).single(),
    ])
    if (!player || !game) return NextResponse.json({ error }, { status: 400 })
    if (!recipe) return NextResponse.json({ error: 'ไม่พบสูตรนี้' }, { status: 400 })

    // trait fx inline (ไม่ต้อง query แยก — ใช้ traits ที่อยู่ใน player แล้ว)
    // craft_int_bonus และ craft_ap_bonus ดึงจาก trait_definitions ถ้ามี
    const traits: string[] = player.traits ?? []
    const isSmartStudent = traits.includes('เรียนเก่ง')
    const isCraftsman = traits.includes('ช่างฝีมือ')

    const effectiveMinInt = Math.max(0, recipe.min_int - (isSmartStudent ? 2 : 0))
    if (player.int < effectiveMinInt)
      return NextResponse.json({ error: `ต้องการ INT ${effectiveMinInt} (มี ${player.int})` }, { status: 400 })

    const inventory: Array<{id:string,qty:number}> = player.inventory ?? []
    for (const ingredient of recipe.ingredients) {
      const item = inventory.find(i => i.id === ingredient.id)
      if (!item || item.qty < ingredient.qty)
        return NextResponse.json({ error: `ขาดวัสดุ: ${ingredient.id} (มี ${item?.qty ?? 0}/${ingredient.qty})` }, { status: 400 })
    }

    const craftApCost = Math.max(0, recipe.ap_cost - (isCraftsman ? 10 : 0))
    const ap = await spendAP(supabase, player, craftApCost)
    if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })

    const CATALYST_IDS = ['ไฟแช็ก']
    let newInventory = [...inventory]
    for (const ingredient of recipe.ingredients) {
      if (CATALYST_IDS.includes(ingredient.id)) continue
      const idx = newInventory.findIndex(i => i.id === ingredient.id)
      newInventory[idx] = { ...newInventory[idx], qty: newInventory[idx].qty - ingredient.qty }
    }
    newInventory = newInventory.filter(i => i.qty > 0)
    const existingResult = newInventory.find(i => i.id === recipe.result_id)
    if (existingResult) existingResult.qty += recipe.result_qty
    else newInventory.push({ id: recipe.result_id, qty: recipe.result_qty })

    const knownRecipes = player.known_recipes ?? []
    const newKnown = knownRecipes.includes(recipe_id) ? knownRecipes : [...knownRecipes, recipe_id]

    await Promise.all([
      (supabase as any).from('players').update({ inventory: newInventory, known_recipes: newKnown }).eq('id', player.id),
      logEvent(supabase, { game_id, event_type: 'คราฟต์', actor_id: player.id, pos_x: player.pos_x ?? undefined, pos_y: player.pos_y ?? undefined, data: { recipe: recipe_id, result: recipe.result_id, qty: recipe.result_qty } }),
    ])

    return NextResponse.json({ ok: true, result: recipe.result_id, qty: recipe.result_qty, msg: `คราฟต์ ${recipe.result_id} ×${recipe.result_qty} สำเร็จ` })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
