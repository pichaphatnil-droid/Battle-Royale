import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getValidPlayer, getActiveGame, applyMoodleTriggers, checkAndDeclareWinner } from '@/lib/action-helpers'

const AP_COST = 20

export async function POST(request: Request) {
  try {
    // ── auth: ใช้ anon client เพื่ออ่าน session ──
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    // ── DB operations: ใช้ service client (bypass RLS) ──
    const supabase = await createServiceClient()

    const body = await request.json()
    const { game_id, x, y } = body
    if (game_id === undefined || x === undefined || y === undefined)
      return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    // ตรวจพิกัด
    if (x < 0 || x > 29 || y < 0 || y > 29)
      return NextResponse.json({ error: 'พิกัดอยู่นอกแผนที่' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    // ตรวจว่าอยู่ติดกัน (Chebyshev distance = 1)
    const dx = Math.abs((player.pos_x ?? 0) - x)
    const dy = Math.abs((player.pos_y ?? 0) - y)
    if (dx > 1 || dy > 1)
      return NextResponse.json({ error: 'เดินได้แค่ช่องติดกัน' }, { status: 400 })

    if (dx === 0 && dy === 0)
      return NextResponse.json({ error: 'อยู่ที่นี่แล้ว' }, { status: 400 })

    // ดึง grid_states และ grids พร้อมกัน
    const [{ data: gridState }, { data: destGrid }] = await Promise.all([
     (supabase as any).from('grid_states').select('*').eq('game_id', game_id).eq('x', x).eq('y', y).maybeSingle(),
     (supabase as any).from('grids').select('terrain').eq('x', x).eq('y', y).maybeSingle(),
    ])

    const isForbidden = gridState?.is_forbidden ?? false

    const isSwamp = destGrid?.terrain === 'หนองน้ำ'
    const hasSwimTrait = (player.traits ?? []).includes('ว่ายน้ำเก่ง')

    const hasFastFeet = (player.traits ?? []).includes('เท้าเร็ว')
    const hasWeakLegs = (player.traits ?? []).includes('ขาอ่อน')
    let baseApCost = AP_COST
    if (hasFastFeet) baseApCost -= 5
    if (hasWeakLegs) baseApCost += 5
    const apCost = isSwamp && !hasSwimTrait ? baseApCost + 15 : baseApCost

    const ap = await spendAP(supabase, player, apCost)
    if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })

    const updateData: Record<string, any> = { pos_x: x, pos_y: y }

    // เขตอันตราย — ลด HP 80% ของ HP ที่เหลือ
    if (isForbidden) {
      const damage = Math.floor(player.hp * 0.8)
      const newHp = Math.max(0, player.hp - damage)
      const died = newHp <= 0
      updateData.hp = newHp
      updateData.is_alive = !died

      // drop inventory เมื่อตาย
      if (died) {
        const deadInventory: Array<{id:string,qty:number}> = player.inventory ?? []
        if (deadInventory.length > 0) {
          const { data: gs } = await supabase
            .from('grid_states').select('*')
            .eq('game_id', game_id).eq('x', x).eq('y', y).maybeSingle()
          const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
          const existingDrops: Array<any> = gs?.dropped_items ?? []
          const newDrops = [
            ...existingDrops,
            ...deadInventory.map(item => ({
              id: item.id, qty: item.qty,
              dropped_by: player.name, dropped_by_id: player.id,
              expires_at: expiresAt,
            }))
          ]
          if (gs) {
            await (supabase as any).from('grid_states')
              .update({ dropped_items: newDrops })
              .eq('game_id', game_id).eq('x', x).eq('y', y)
          } else {
            await (supabase as any).from('grid_states')
              .insert({ game_id, x, y, items: [], dropped_items: newDrops })
          }
          updateData.inventory = []
        }
      }
    }

    if (isSwamp && !hasSwimTrait) {
      const moodles = player.moodles ?? []
      const hasSwampMoodle = moodles.find((m: any) => m.id === 'ลุยน้ำ')
      let newMoodles = hasSwampMoodle ? moodles : [...moodles, {
        id: 'ลุยน้ำ',
        level: 1,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
      }]

      // trigger ป่วย จากหนองน้ำ (15% chance) — อ่านจาก moodle_definitions
      const { newMoodles: moodlesAfterSwamp } = await applyMoodleTriggers(
        supabase, { ...player, moodles: newMoodles }, 'move_swamp', {}
      )
      updateData.moodles = moodlesAfterSwamp
    }

    await (supabase as any).from('players').update(updateData).eq('id', player.id)

    await logEvent(supabase, {
      game_id,
      event_type: 'เดิน',
      actor_id: player.id,
      pos_x: x,
      pos_y: y,
      data: { from_x: player.pos_x, from_y: player.pos_y },
    })

    // ตรวจ winner ถ้าตายจากเขตอันตราย
    if (updateData.is_alive === false) await checkAndDeclareWinner(supabase, game_id)

    return NextResponse.json({ ok: true, pos_x: x, pos_y: y, ap_cost: apCost, swamp: isSwamp && !hasSwimTrait, forbidden: isForbidden, hp: updateData.hp })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
