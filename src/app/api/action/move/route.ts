import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getPlayerAndGame, applyMoodleTriggers, checkAndDeclareWinner } from '@/lib/action-helpers'

const AP_COST = 5

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id, x, y } = await request.json()
    if (game_id === undefined || x === undefined || y === undefined)
      return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })
    if (x < 0 || x > 29 || y < 0 || y > 29)
      return NextResponse.json({ error: 'พิกัดอยู่นอกแผนที่' }, { status: 400 })

    // ── 1 round trip: player + game พร้อมกัน ──
    const { player, game, error } = await getPlayerAndGame(supabase, user.id, game_id)
    if (!player || !game) return NextResponse.json({ error }, { status: 400 })

    const dx = Math.abs((player.pos_x ?? 0) - x)
    const dy = Math.abs((player.pos_y ?? 0) - y)
    if (dx > 1 || dy > 1) return NextResponse.json({ error: 'เดินได้แค่ช่องติดกัน' }, { status: 400 })
    if (dx === 0 && dy === 0) return NextResponse.json({ error: 'อยู่ที่นี่แล้ว' }, { status: 400 })

    // ── 2nd round trip: grid + grid_state + trait_effects พร้อมกัน ──
    const traits: string[] = player.traits ?? []
    const [
      { data: gridState },
      { data: destGrid },
      { data: traitDefs },
    ] = await Promise.all([
      (supabase as any).from('grid_states').select('is_forbidden,dropped_items').eq('game_id', game_id).eq('x', x).eq('y', y).maybeSingle(),
      (supabase as any).from('grids').select('terrain').eq('x', x).eq('y', y).maybeSingle(),
      traits.length > 0
        ? (supabase as any).from('trait_definitions').select('id,special_effects').in('id', traits)
        : Promise.resolve({ data: [] }),
    ])

    // รวม trait special_effects จาก map
    const traitFxMap = new Map((traitDefs ?? []).map((t: any) => [t.id, t.special_effects ?? {}]))
    let moveApBonus = 0, swimTrait = false
    for (const tid of traits) {
      const fx: any = traitFxMap.get(tid) ?? {}
      if (fx.move_ap_bonus) moveApBonus += fx.move_ap_bonus
      if (fx.swim) swimTrait = true
    }

    const isForbidden = gridState?.is_forbidden ?? false
    const isSwamp = destGrid?.terrain === 'หนองน้ำ'
    const baseApCost = Math.max(0, AP_COST + moveApBonus)
    const apCost = isSwamp && !swimTrait ? baseApCost + 15 : baseApCost

    const ap = await spendAP(supabase, player, apCost)
    if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })

    const updateData: Record<string, any> = { pos_x: x, pos_y: y }

    if (isForbidden) {
      const newHp = Math.max(0, player.hp - Math.floor(player.hp * 0.8))
      const died = newHp <= 0
      updateData.hp = newHp
      updateData.is_alive = !died
      if (died && (player.inventory ?? []).length > 0) {
        const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
        const existingDrops: any[] = gridState?.dropped_items ?? []
        const newDrops = [...existingDrops, ...(player.inventory ?? []).map((item: any) => ({
          id: item.id, qty: item.qty,
          dropped_by: player.name, dropped_by_id: player.id, expires_at: expiresAt,
        }))]
        await Promise.all([
          (supabase as any).from('grid_states').upsert(
            { game_id, x, y, items: [], dropped_items: newDrops },
            { onConflict: 'game_id,x,y' }
          ),
        ])
        updateData.inventory = []
      }
    }

    if (isSwamp && !swimTrait) {
      const moodles = player.moodles ?? []
      const newMoodles = moodles.find((m: any) => m.id === 'ลุยน้ำ') ? moodles : [
        ...moodles, { id: 'ลุยน้ำ', level: 1, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }
      ]
      const { newMoodles: moodlesAfter } = await applyMoodleTriggers(supabase, { ...player, moodles: newMoodles }, 'move_swamp', {})
      updateData.moodles = moodlesAfter
    }

    // ── Final: update player + log event พร้อมกัน ──
    await Promise.all([
      (supabase as any).from('players').update(updateData).eq('id', player.id),
      logEvent(supabase, { game_id, event_type: 'เดิน', actor_id: player.id, pos_x: x, pos_y: y, data: { from_x: player.pos_x, from_y: player.pos_y } }),
    ])

    if (updateData.is_alive === false) await checkAndDeclareWinner(supabase, game_id)

    return NextResponse.json({ ok: true, pos_x: x, pos_y: y, ap_cost: apCost, swamp: isSwamp && !swimTrait, forbidden: isForbidden, hp: updateData.hp })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
