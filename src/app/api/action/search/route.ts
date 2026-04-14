import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { spendAP, logEvent, getValidPlayer, getActiveGame, rollSpawnTable } from '@/lib/action-helpers'

const AP_COST = 30

function getSearchCooldown(): number {
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  return (thaiHour >= 19 || thaiHour < 7) ? 20 : 60
}

export async function POST(request: Request) {
  try {
    // ── auth: ใช้ anon client เพื่ออ่าน session ──
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'ไม่ได้เข้าสู่ระบบ' }, { status: 401 })

    // ── DB operations: ใช้ service client (bypass RLS) ──
    const supabase = await createServiceClient()

    const { game_id } = await request.json()
    if (!game_id) return NextResponse.json({ error: 'ข้อมูลไม่ครบ' }, { status: 400 })

    const game = await getActiveGame(supabase, game_id)
    if (!game) return NextResponse.json({ error: 'ไม่มีเกมที่กำลังเล่น' }, { status: 400 })

    const { player, error } = await getValidPlayer(supabase, user.id, game_id)
    if (!player) return NextResponse.json({ error }, { status: 400 })

    const px = player.pos_x, py = player.pos_y
    if (px === null || py === null)
      return NextResponse.json({ error: 'ไม่ได้อยู่บนแผนที่' }, { status: 400 })

    // ตรวจ cooldown per-player per-cell จาก searched_by array ใน grid_states
    const { data: gs } = await supabase
      .from('grid_states')
      .select('*')
      .eq('game_id', game_id)
      .eq('x', px)
      .eq('y', py)
      .maybeSingle()

    const cooldown = getSearchCooldown()
    const searchedBy: Array<{player_id:string, searched_at:string}> = gs?.searched_by ?? []
    const mySearch = searchedBy.find(s => s.player_id === player.id)
    if (mySearch) {
      const minsSince = (Date.now() - new Date(mySearch.searched_at).getTime()) / 60_000
      if (minsSince < cooldown) {
        const minsLeft = Math.ceil(cooldown - minsSince)
        return NextResponse.json({ error: `ค้นแล้ว รอ ${minsLeft} นาทีอีกครั้ง` }, { status: 400 })
      }
    }

    const ap = await spendAP(supabase, player, AP_COST)
    if (!ap.ok) return NextResponse.json({ error: ap.msg }, { status: 400 })

    const { data: grid } = await supabase
      .from('grids')
      .select('*')
      .eq('x', px)
      .eq('y', py)
      .single()

    const rawSpawn = grid?.spawn_table ?? []
    const spawnItemIds = rawSpawn.map((i: any) => i.id)
    let craftOnlyIds: string[] = []
    if (spawnItemIds.length > 0) {
      const { data: defs } = await (supabase as any).from('item_definitions').select('id,data').in('id', spawnItemIds)
      craftOnlyIds = (defs ?? []).filter((d: any) => (d.data as any)?.craftable_only).map((d: any) => d.id)
    }
    const spawnTable = rawSpawn.filter((i: any) => !craftOnlyIds.includes(i.id))
    const count = Math.floor(Math.random() * 3) + 1
    const found = rollSpawnTable(spawnTable, count)

    if (found.length > 0) {
      const inventory: Array<{id:string,qty:number}> = player.inventory ?? []
      const newInventory = [...inventory]
      for (const item of found) {
        const existing = newInventory.find(i => i.id === item.id)
        if (existing) existing.qty += item.qty
        else newInventory.push({ id: item.id, qty: item.qty })
      }
      await (supabase as any).from('players')
        .update({ inventory: newInventory })
        .eq('id', player.id)
    }

    // อัปเดต searched_by — บันทึก per-player per-cell
    const now = new Date().toISOString()
    const updatedSearchedBy = [
      ...searchedBy.filter(s => s.player_id !== player.id),
      { player_id: player.id, searched_at: now },
    ]
    if (gs) {
      await (supabase as any).from('grid_states')
        .update({ searched_by: updatedSearchedBy })
        .eq('game_id', game_id).eq('x', px).eq('y', py)
    } else {
      await (supabase as any).from('grid_states')
        .insert({ game_id, x: px, y: py, items: [], searched_by: updatedSearchedBy })
    }

    await logEvent(supabase, {
      game_id,
      event_type: 'ค้นหา',
      actor_id: player.id,
      pos_x: px,
      pos_y: py,
      data: { found_count: found.length },
    })

    return NextResponse.json({ ok: true, found })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
