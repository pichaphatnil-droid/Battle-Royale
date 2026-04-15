import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getPlayerAndGame, rollSpawnTable } from '@/lib/action-helpers'

const AP_COST = 30

function getSearchCooldown(): number {
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  return (thaiHour >= 19 || thaiHour < 7) ? 20 : 60
}

export async function POST(request: Request) {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    const supabase = createServiceClient()
    const { game_id } = await request.json()
    if (!game_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const { player, game, error } = await getPlayerAndGame(supabase, user.id, game_id)
    if (!player || !game) return NextResponse.json({ error }, { status: 400 })

    const px = player.pos_x, py = player.pos_y
    if (px === null || py === null) return NextResponse.json({ error: 'ไม่ได้อยู่บนแผนที่' }, { status: 400 })

    // ── 2nd round trip: grid + grid_state พร้อมกัน ──
    const [{ data: gs }, { data: grid }] = await Promise.all([
      (supabase as any).from('grid_states').select('*').eq('game_id', game_id).eq('x', px).eq('y', py).maybeSingle(),
      (supabase as any).from('grids').select('*').eq('x', px).eq('y', py).single(),
    ])

    const cooldown = getSearchCooldown()
    const searchedBy: Array<{player_id:string, searched_at:string}> = gs?.searched_by ?? []
    const mySearch = searchedBy.find(s => s.player_id === player.id)
    if (mySearch) {
      const minsSince = (Date.now() - new Date(mySearch.searched_at).getTime()) / 60_000
      if (minsSince < cooldown) return NextResponse.json({ error: `ค้นแล้ว รอ ${Math.ceil(cooldown - minsSince)} นาทีอีกครั้ง` }, { status: 400 })
    }

    const ap = await spendAP(supabase, player, AP_COST)
    if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })

    const rawSpawn = grid?.spawn_table ?? []
    const spawnItemIds = rawSpawn.map((i: any) => i.id)
    let spawnTable = rawSpawn
    if (spawnItemIds.length > 0) {
      const { data: defs } = await (supabase as any).from('item_definitions').select('id,data').in('id', spawnItemIds)
      const craftOnlyIds = (defs ?? []).filter((d: any) => (d.data as any)?.craftable_only).map((d: any) => d.id)
      spawnTable = rawSpawn.filter((i: any) => !craftOnlyIds.includes(i.id))
    }

    const found = rollSpawnTable(spawnTable, Math.floor(Math.random() * 3) + 1)
    const updatedSearchedBy = [...searchedBy.filter(s => s.player_id !== player.id), { player_id: player.id, searched_at: new Date().toISOString() }]

    // ── Final writes พร้อมกัน ──
    const writes: Promise<any>[] = [
      (supabase as any).from('grid_states').upsert(
        { game_id, x: px, y: py, items: [], searched_by: updatedSearchedBy },
        { onConflict: 'game_id,x,y' }
      ),
      logEvent(supabase, { game_id, event_type: 'ค้นหา', actor_id: player.id, pos_x: px, pos_y: py, data: { found_count: found.length } }),
    ]
    if (found.length > 0) {
      const inventory: Array<{id:string,qty:number}> = player.inventory ?? []
      const newInventory = [...inventory]
      for (const item of found) {
        const existing = newInventory.find(i => i.id === item.id)
        if (existing) existing.qty += item.qty
        else newInventory.push({ id: item.id, qty: item.qty })
      }
      writes.push((supabase as any).from('players').update({ inventory: newInventory }).eq('id', player.id))
    }
    await Promise.all(writes)

    return NextResponse.json({ ok: true, found })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
