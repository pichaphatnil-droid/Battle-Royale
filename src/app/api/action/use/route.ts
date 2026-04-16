import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = createClient()
  const body = await req.json()
  const { game_id, player_id, item_id } = body

  if (!game_id || !player_id || !item_id) {
    return NextResponse.json({ error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 })
  }

  // 1. ดึงข้อมูลผู้เล่นและไอเทม
  const { data: player } = await supabase.from('players').select('*').eq('id', player_id).single()
  const { data: itemDef } = await supabase.from('item_definitions').select('*').eq('id', item_id).single()

  if (!player || !itemDef) return NextResponse.json({ error: 'ไม่พบผู้เล่นหรือไอเทม' }, { status: 404 })

  // 2. เช็คว่ามีไอเทมในกระเป๋าไหม
  const inventory = player.inventory as Array<{id: string, qty: number}>
  const itemIndex = inventory.findIndex(i => i.id === item_id)
  if (itemIndex === -1 || inventory[itemIndex].qty <= 0) {
    return NextResponse.json({ error: 'คุณไม่มีไอเทมชิ้นนี้' }, { status: 400 })
  }

  const itemData = itemDef.data as any || {}
  const apCost = itemData.ap_cost || 0

  if (player.ap < apCost) {
    return NextResponse.json({ error: `AP ไม่พอ (ต้องการ ${apCost})` }, { status: 400 })
  }

  // 3. อัปเดต Stats แบบ Dynamic (ห้าม Hard code)
  let updates: any = {}
  
  // จัดการ stat_bonus (เช่น {"int": 1, "str": 2})
  if (itemData.stat_bonus) {
    for (const [stat, value] of Object.entries(itemData.stat_bonus)) {
      // เช็คว่ามีคอลัมน์ stat นี้ในตาราง players ไหม เพื่อความปลอดภัย
      if (player[stat] !== undefined) {
        updates[stat] = player[stat] + (value as number)
      }
    }
  }

  // จัดการ AP (หัก cost และบวก bonus)
  const apBonus = itemData.ap_bonus || 0
  updates.ap = Math.min(600, player.ap - apCost + apBonus)

  // หักของออกจากกระเป๋า 1 ชิ้น
  inventory[itemIndex].qty -= 1
  if (inventory[itemIndex].qty <= 0) inventory.splice(itemIndex, 1)
  updates.inventory = inventory

  // 4. บันทึกลงฐานข้อมูล
  const { error } = await supabase.from('players').update(updates).eq('id', player_id)
  
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, message: `ใช้งาน ${item_id} สำเร็จ!` })
}
