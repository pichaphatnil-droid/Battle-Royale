'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game, Player, ItemDefinition, TraitDefinition, MoodleDefinition, CraftRecipe } from '@/lib/supabase/types'

type AdminTab = 'เกม' | 'ผู้เล่น' | 'ไอเทม' | 'นิสัย' | 'moodles' | 'สูตรคราฟต์' | 'แผนที่' | 'ประกาศ'

interface Props {
  currentUserId: string
  games: Game[]
  players: Player[]
  items: ItemDefinition[]
  traits: TraitDefinition[]
  moodles: MoodleDefinition[]
  recipes: CraftRecipe[]
}

export default function AdminClient({ currentUserId, games, players, items: initialItems, traits, moodles: initialMoodles, recipes: initialRecipes }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [tab, setTab] = useState<AdminTab>('เกม')
  const [items, setItems] = useState(initialItems)
  const [moodles, setMoodles] = useState(initialMoodles)
  const [showAddItem, setShowAddItem] = useState(false)
  const [showAddMoodle, setShowAddMoodle] = useState(false)
  const [editMoodle, setEditMoodle] = useState<MoodleDefinition | null>(null)
  const [editItem, setEditItem] = useState<ItemDefinition | null>(null)
  const [newItem, setNewItem] = useState({ id:'', name:'', category:'อาหาร', description:'', photo_url:'', weight:'0.1', data:'{"ap_cost":0}' })
  const [recipes, setRecipes] = useState(initialRecipes)
  const [showAddRecipe, setShowAddRecipe] = useState(false)
  const [msg, setMsg] = useState<{text:string, ok:boolean}|null>(null)
  const [grids, setGrids] = useState<any[]>([])
  const [gridsLoaded, setGridsLoaded] = useState(false)
  const [gridsLoading, setGridsLoading] = useState(false)
  const [gridSearch, setGridSearch] = useState('')
  const [editGrid, setEditGrid] = useState<any | null>(null)

  function notify(text: string, ok = true) {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 3000)
  }

  async function reload() { router.refresh() }

  // ── GAME ACTIONS ──────────────────────────────────────────
  async function createGame() {
    const { error } = await (supabase as any).from('games').insert({ status: 'รอผู้เล่น', paused_duration: '0' })
    if (error) notify('❌ ' + error.message, false)
    else { notify('✅ สร้างเกมแล้ว'); reload() }
  }

  async function startGame(id: string, endsAt: string) {
    const { error: rpcError } = await (supabase as any).rpc('เริ่มเกมใหม่', { game_id: id })
    if (rpcError) { notify('❌ ' + rpcError.message, false); return }
    // อัปเดตเวลาจบ
    const { error } = await (supabase as any).from('games').update({ ends_at: endsAt }).eq('id', id)
    if (error) notify('❌ ' + error.message, false)
    else { notify('✅ เริ่มเกมแล้ว'); reload() }
  }

  async function pauseGame(id: string, isPaused: boolean) {
    const { error } = await (supabase as any).from('games').update({
      status: isPaused ? 'กำลังเล่น' : 'หยุดชั่วคราว',
      paused_at: isPaused ? null : new Date().toISOString(),
    }).eq('id', id)
    if (error) notify('❌ ' + error.message, false)
    else { notify(isPaused ? '✅ เล่นต่อ' : '✅ หยุดชั่วคราว'); reload() }
  }

  async function endGame(id: string) {
    if (!confirm('ยืนยันจบเกม?')) return
    const { error } = await (supabase as any).from('games').update({ status: 'จบแล้ว' }).eq('id', id)
    if (error) notify('❌ ' + error.message, false)
    else { notify('✅ จบเกมแล้ว'); reload() }
  }

  async function resetGame(gameId: string) {
    if (!confirm('⚠️ ยืนยันรีเซ็ตเกม?\n\nจะลบเกมนี้ทิ้งทั้งหมด รวมถึงผู้เล่นและแผนที่')) return
    // ลบ events ก่อน (FK → players)
    const { error: e1 } = await (supabase as any).from('events').delete().eq('game_id', gameId)
    if (e1) { notify('❌ ล้าง events ไม่ได้: ' + e1.message, false); return }
    // ลบ chat_messages
    await (supabase as any).from('chat_messages').delete().eq('game_id', gameId)
    // ลบ announcements
    await (supabase as any).from('announcements').delete().eq('game_id', gameId)
    // ลบ players
    const { error: e2 } = await (supabase as any).from('players').delete().eq('game_id', gameId)
    if (e2) { notify('❌ ลบ players ไม่ได้: ' + e2.message, false); return }
    // ลบ grid_states
    await (supabase as any).from('grid_states').delete().eq('game_id', gameId)
    // ลบ game
    const { error: e3 } = await (supabase as any).from('games').delete().eq('id', gameId)
    if (e3) { notify('❌ ลบเกมไม่ได้: ' + e3.message, false); return }
    notify('✅ ลบเกมแล้ว')
    reload()
  }

  async function declareZone(gameId: string, x: number, y: number, warn: boolean) {
    const { error } = await (supabase as any).from('grid_states')
      .update(warn ? { warn_forbidden: true } : { is_forbidden: true, warn_forbidden: false })
      .eq('game_id', gameId).eq('x', x).eq('y', y)
    if (error) { notify('❌ ' + error.message, false); return }

    // ประกาศใน events
    await (supabase as any).from('events').insert({
      game_id: gameId,
      event_type: warn ? 'เตือนเขตอันตราย' : 'ปิดเขตอันตราย',
      pos_x: x, pos_y: y,
      data: { x, y, warn },
    })

    // ส่งประกาศให้ผู้เล่นทุกคน
    await fetch('/api/admin/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game_id: gameId,
        ann_type: 'อาจารย์ผู้ควบคุม',
        message: warn
          ? `⚠️ เขต [${x},${y}] กำลังจะเป็นเขตอันตราย เตรียมอพยพ!`
          : `🚫 เขต [${x},${y}] เป็นเขตอันตราย ห้ามเข้า!`,
      }),
    })
    notify(`✅ ประกาศเขต [${x},${y}]`)
  }

  // ── PLAYER ACTIONS ────────────────────────────────────────
  async function banPlayer(id: string, ban: boolean) {
    const { error } = await (supabase as any).from('players').update({ is_banned: ban }).eq('id', id)
    if (error) notify('❌ ' + error.message, false)
    else { notify(ban ? '✅ แบนแล้ว' : '✅ ยกเลิกแบนแล้ว'); reload() }
  }

  async function mutePlayer(id: string, mute: boolean) {
    const { error } = await (supabase as any).from('players').update({ chat_muted: mute }).eq('id', id)
    if (error) notify('❌ ' + error.message, false)
    else { notify(mute ? '✅ ปิดแชทแล้ว' : '✅ เปิดแชทแล้ว'); reload() }
  }

  async function killPlayer(id: string) {
    if (!confirm('ยืนยันฆ่าผู้เล่น?')) return
    const player = players.find(p => p.id === id)
    const { error } = await (supabase as any).from('players').update({ is_alive: false, hp: 0 }).eq('id', id)
    if (error) { notify('❌ ' + error.message, false); return }
    // insert event ตาย เพื่อให้ death modal ขึ้นสำหรับทุกคน
    if (currentGame) {
      await (supabase as any).from('events').insert({
        game_id: currentGame.id,
        event_type: 'ตาย',
        actor_id: id,
        target_id: id,
        pos_x: player?.pos_x ?? null,
        pos_y: player?.pos_y ?? null,
        data: { name: player?.name ?? '?', cause: 'ปลอกคอระเบิด' },
      })
    }
    notify('✅ ดำเนินการแล้ว'); reload()
  }

  async function fillAP(id: string) {
    const { error } = await (supabase as any).from('players')
      .update({ ap: 600, ap_updated_at: new Date().toISOString() }).eq('id', id)
    if (error) notify('❌ ' + error.message, false)
    else notify('✅ เติม AP เต็มแล้ว')
  }

  async function fillHP(id: string, maxHp: number) {
    const { error } = await (supabase as any).from('players')
      .update({ hp: maxHp }).eq('id', id)
    if (error) notify('❌ ' + error.message, false)
    else notify('✅ เติม HP เต็มแล้ว')
  }

  async function teleportPlayer(id: string, x: number, y: number) {
    const { error } = await (supabase as any).from('players').update({ pos_x: x, pos_y: y }).eq('id', id)
    if (error) notify('❌ ' + error.message, false)
    else notify(`✅ ย้ายไป [${x},${y}]`)
  }

  // ── ITEM ACTIONS ──────────────────────────────────────────
  async function giveItem(playerId: string, gameId: string, itemId: string, qty: number) {
    const { data: p } = await (supabase as any).from('players').select('inventory').eq('id', playerId).single()
    const inv: Array<{id:string,qty:number}> = p?.inventory ?? []
    const existing = inv.find((i: any) => i.id === itemId)
    const newInv = existing
      ? inv.map((i: any) => i.id === itemId ? { ...i, qty: i.qty + qty } : i)
      : [...inv, { id: itemId, qty }]
    const { error } = await (supabase as any).from('players').update({ inventory: newInv }).eq('id', playerId)
    if (error) notify('❌ ' + error.message, false)
    else notify(`✅ เสก ${itemId} ×${qty} ให้แล้ว`)
  }

  async function createAirdrop(gameId: string, x: number, y: number, items: Array<{id:string,qty:number}>, expiresMins: number) {
    const expiresAt = new Date(Date.now() + expiresMins * 60_000).toISOString()
    const { data: gs } = await (supabase as any).from('grid_states').select('*')
      .eq('game_id', gameId).eq('x', x).eq('y', y).maybeSingle()
    const drops = [
      ...(gs?.dropped_items ?? []),
      ...items.map(item => ({ ...item, dropped_by: 'Airdrop', dropped_by_id: null, expires_at: expiresAt }))
    ]
    if (gs) {
      await (supabase as any).from('grid_states').update({ dropped_items: drops }).eq('game_id', gameId).eq('x', x).eq('y', y)
    } else {
      await (supabase as any).from('grid_states').insert({ game_id: gameId, x, y, items: [], dropped_items: drops })
    }
    await (supabase as any).from('announcements').insert({
      game_id: gameId, ann_type: 'อาจารย์ผู้ควบคุม',
      message: `📦 Airdrop ที่ [${x},${y}]! ขอให้โชคดีละพวกเด็กนรก!`,
    })
    notify(`✅ Airdrop ที่ [${x},${y}] สำเร็จ (หายใน ${expiresMins} นาที)`)
  }

  async function saveItem(item: Partial<ItemDefinition> & { id: string }, isNew: boolean) {
    if (isNew) {
      const { error } = await (supabase as any).from('item_definitions').insert(item)
      if (error) { notify('❌ ' + error.message, false); return }
      notify('✅ เพิ่มไอเทมแล้ว')
    } else {
      const { error } = await (supabase as any).from('item_definitions').update(item).eq('id', item.id)
      if (error) { notify('❌ ' + error.message, false); return }
      notify('✅ อัปเดตไอเทมแล้ว')
    }
    const { data } = await (supabase as any).from('item_definitions').select('*').order('id')
    if (data) setItems(data)
  }

  async function deleteItem(id: string) {
    if (!confirm(`ลบ "${id}"?`)) return
    const { error } = await (supabase as any).from('item_definitions').delete().eq('id', id)
    if (error) { notify('❌ ' + error.message, false); return }
    notify('✅ ลบแล้ว')
    setItems(prev => prev.filter(i => i.id !== id))
  }

  const currentGame = games.find(g => ['รอผู้เล่น','กำลังเล่น','หยุดชั่วคราว'].includes(g.status))
  const gamePlayers = players.filter(p => p.game_id === currentGame?.id)

  return (
    <>
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <span style={s.title}>⚙ แผงควบคุม</span>
        <div style={{ flex: 1 }} />
        {msg && (
          <div style={{ padding: '5px 12px', background: msg.ok ? 'rgba(45,90,39,0.3)' : 'rgba(139,0,0,0.3)', border: `1px solid ${msg.ok ? 'var(--green-bright)' : 'var(--red-bright)'}`, fontSize: '12px', color: msg.ok ? 'var(--green-bright)' : 'var(--red-bright)' }}>
            {msg.text}
          </div>
        )}
        <button onClick={() => router.push('/')} style={s.backBtn}>← กลับ</button>
      </div>

      {/* Tabs */}
      <div style={s.tabBar}>
        {(['เกม','ผู้เล่น','ไอเทม','นิสัย','moodles','สูตรคราฟต์','แผนที่','ประกาศ'] as AdminTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...s.tabBtn,
            borderBottom: tab === t ? '2px solid var(--red-bright)' : '2px solid transparent',
            color: tab === t ? 'var(--red-bright)' : 'var(--text-secondary)',
          }}>{t}</button>
        ))}
      </div>

      <div style={s.body}>

        {/* ── TAB: เกม ── */}
        {tab === 'เกม' && (
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span>จัดการเกม</span>
              <button onClick={createGame} style={s.addBtn}>+ สร้างเกมใหม่</button>
            </div>

            {games.length === 0 && <div style={s.empty}>ยังไม่มีเกม</div>}

            {games.map(game => (
              <div key={game.id} style={s.card}>
                <div style={s.cardRow}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)' }}>
                    {game.id.slice(0,8)}...
                  </span>
                  <StatusBadge status={game.status} />
                </div>
                <div style={s.cardRow}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    สร้าง: {new Date(game.created_at).toLocaleString('th-TH')}
                  </span>
                  {game.started_at && (
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      เริ่ม: {new Date(game.started_at).toLocaleString('th-TH')}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                  {game.status === 'รอผู้เล่น' && (
                    <StartGamePanel gameId={game.id} onStart={startGame} />
                  )}
                  {game.status === 'กำลังเล่น' && (
                    <button onClick={() => pauseGame(game.id, false)} style={s.yellowBtn}>⏸ หยุดชั่วคราว</button>
                  )}
                  {game.status === 'หยุดชั่วคราว' && (
                    <button onClick={() => pauseGame(game.id, true)} style={s.greenBtn}>▶ เล่นต่อ</button>
                  )}
                  {['กำลังเล่น','หยุดชั่วคราว'].includes(game.status) && (
                    <button onClick={() => endGame(game.id)} style={s.redBtn}>■ จบเกม</button>
                  )}
                  {game.status === 'จบแล้ว' && (
                    <button onClick={() => resetGame(game.id)} style={{ ...s.redBtn, borderColor:'#FF6B00', color:'#FF6B00' }}>🗑 ลบเกมนี้</button>
                  )}
                </div>

                {/* winner display */}
                {game.status === 'จบแล้ว' && (game as any).winner_name && (
                  <div style={{ marginTop:'10px', padding:'10px 12px', background:'rgba(180,140,0,0.08)', border:'1px solid var(--text-gold)', display:'flex', alignItems:'center', gap:'10px' }}>
                    <span style={{ fontSize:'20px' }}>👑</span>
                    <div>
                      <div style={{ fontSize:'11px', color:'var(--text-gold)', letterSpacing:'0.1em' }}>ผู้รอดชีวิตคนสุดท้าย</div>
                      <div style={{ fontSize:'14px', fontWeight:600, color:'var(--text-primary)' }}>{(game as any).winner_name}</div>
                    </div>
                  </div>
                )}

                {/* เขตอันตราย */}
                {['กำลังเล่น','หยุดชั่วคราว'].includes(game.status) && (
                  <div style={{ marginTop: '10px', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
                    <div style={s.miniLabel}>ประกาศเขตอันตราย</div>
                    <ZoneDeclare gameId={game.id} onDeclare={declareZone} notify={notify} />
                    <div style={{ marginTop: '10px', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
                      <div style={s.miniLabel}>Airdrop</div>
                      <AirdropPanel gameId={game.id} items={items} onDrop={createAirdrop} notify={notify} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── TAB: ผู้เล่น ── */}
        {tab === 'ผู้เล่น' && (
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span>ผู้เล่นในเกม ({gamePlayers.length} คน)</span>
            </div>
            {gamePlayers.length === 0 && <div style={s.empty}>ไม่มีผู้เล่น</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {gamePlayers.map(p => (
                <PlayerRow key={p.id} player={p}
                  onBan={() => banPlayer(p.id, !p.is_banned)}
                  onMute={() => mutePlayer(p.id, !p.chat_muted)}
                  onKill={() => killPlayer(p.id)}
                  onFillAP={() => fillAP(p.id)}
                  onFillHP={() => fillHP(p.id, p.max_hp)}
                  onTeleport={(x,y) => teleportPlayer(p.id, x, y)}
                  onGiveItem={(itemId, qty) => giveItem(p.id, p.game_id, itemId, qty)}
                  items={items}
                  moodles={moodles}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Add Item Modal ── */}
      {showAddRecipe && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setShowAddRecipe(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-secondary)', border:'1px solid var(--red-blood)', padding:'20px', width:'480px', maxWidth:'95vw', maxHeight:'90vh', overflow:'auto', display:'flex', flexDirection:'column', gap:'12px' }}>
            <div style={{ fontFamily:'var(--font-display)', fontSize:'14px', color:'var(--red-bright)', letterSpacing:'0.1em' }}>+ เพิ่มสูตรคราฟต์</div>
            <AddRecipeForm items={items} onSave={async (recipe) => {
              const { error } = await (supabase as any).from('craft_recipes').insert(recipe)
              if (error) { notify('❌ ' + error.message, false); return }
              const { data } = await (supabase as any).from('craft_recipes').select('*').order('id')
              if (data) setRecipes(data)
              setShowAddRecipe(false)
              notify('✅ เพิ่มสูตรแล้ว')
            }} onCancel={() => setShowAddRecipe(false)} />
          </div>
        </div>
      )}

      {editItem && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setEditItem(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-secondary)', border:'1px solid var(--red-blood)', padding:'20px', width:'420px', maxWidth:'90vw', maxHeight:'90vh', overflow:'auto', display:'flex', flexDirection:'column', gap:'12px' }}>
            <div style={{ fontFamily:'var(--font-display)', fontSize:'14px', color:'var(--text-gold)', letterSpacing:'0.1em' }}>✏️ แก้ไข: {editItem.id}</div>
            <EditItemForm item={editItem} moodles={moodles} onSave={async (updated) => { await saveItem(updated, false); setEditItem(null) }} onCancel={() => setEditItem(null)} />
          </div>
        </div>
      )}

      {showAddItem && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setShowAddItem(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-secondary)', border:'1px solid var(--red-blood)', padding:'20px', width:'420px', maxWidth:'90vw', display:'flex', flexDirection:'column', gap:'12px' }}>
            <div style={{ fontFamily:'var(--font-display)', fontSize:'14px', color:'var(--red-bright)', letterSpacing:'0.1em' }}>+ เพิ่มไอเทมใหม่</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
              <div>
                <div style={s.miniLabel}>ID (ภาษาไทย)</div>
                <input value={newItem.id} onChange={e => setNewItem(p=>({...p,id:e.target.value,name:e.target.value}))} style={s.input} placeholder="เช่น มีดพก" />
              </div>
              <div>
                <div style={s.miniLabel}>ชื่อแสดง</div>
                <input value={newItem.name} onChange={e => setNewItem(p=>({...p,name:e.target.value}))} style={s.input} />
              </div>
              <div>
                <div style={s.miniLabel}>หมวดหมู่</div>
                <select value={newItem.category} onChange={e => {
                  const cat = e.target.value
                  const defaultData: Record<string,string> = {
                    'อาหาร': '{"hunger":40,"ap_cost":0}',
                    'น้ำ':   '{"thirst":40,"ap_cost":0}',
                    'ยา':    '{"hp":0,"ap_cost":0}',
                    'อาวุธ': '{"type":"blunt","range":1,"damage":20,"ap_cost":28,"crit_chance":10,"stun_chance":0,"bleed_chance":0}',
                    'วัสดุ': '{}',
                    'อุปกรณ์': '{}',
                  }
                  setNewItem(p => ({ ...p, category: cat, data: defaultData[cat] ?? '{}' }))
                }} style={s.input}>
                  {['อาหาร','น้ำ','ยา','อาวุธ','วัสดุ','อุปกรณ์'].map(c=><option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <div style={s.miniLabel}>น้ำหนัก (กก.)</div>
                <input type="number" value={newItem.weight} onChange={e => setNewItem(p=>({...p,weight:e.target.value}))} style={s.input} step="0.1" />
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <div style={s.miniLabel}>คำอธิบาย</div>
                <input value={newItem.description} onChange={e => setNewItem(p=>({...p,description:e.target.value}))} style={s.input} />
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <div style={s.miniLabel}>URL รูปภาพ</div>
                <input value={newItem.photo_url} onChange={e => setNewItem(p=>({...p,photo_url:e.target.value}))} style={s.input} placeholder="https://..." />
              </div>
                {/* fields ตามหมวดหมู่ */}
              {newItem.category === 'อาวุธ' && <>
                <div>
                  <div style={s.miniLabel}>ความเสียหาย</div>
                  <input type="number" defaultValue={10} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.damage=parseInt(e.target.value)||0;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>คริติคอล %</div>
                  <input type="number" defaultValue={5} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.crit_chance=parseInt(e.target.value)||0;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>ระยะโจมตี (ช่อง)</div>
                  <input type="number" defaultValue={1} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.range=parseInt(e.target.value)||1;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>AP ที่ใช้</div>
                  <input type="number" defaultValue={30} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.ap_cost=parseInt(e.target.value)||30;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>เลือดออก %</div>
                  <input type="number" defaultValue={0} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.bleed_chance=parseInt(e.target.value)||0;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>มึนงง %</div>
                  <input type="number" defaultValue={0} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.stun_chance=parseInt(e.target.value)||0;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>ประเภท</div>
                  <select onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.type=e.target.value;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}>
                    <option value="blunt">ทื่อ (blunt)</option>
                    <option value="sharp">มีคม (sharp)</option>
                    <option value="ranged">ระยะไกล</option>
                    <option value="firearm">ปืน</option>
                    <option value="throwable">ขว้าง</option>
                  </select>
                </div>
              </>}
              {newItem.category === 'อาหาร' && <>
                <div>
                  <div style={s.miniLabel}>เพิ่มความอิ่ม</div>
                  <input type="number" value={(() => { try { return JSON.parse(newItem.data).hunger ?? 40 } catch { return 40 } })()} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.hunger=parseInt(e.target.value)||0;d.ap_cost=0;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>เพิ่ม AP (ถ้ามี)</div>
                  <input type="number" value={(() => { try { return JSON.parse(newItem.data).ap_bonus ?? 0 } catch { return 0 } })()} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');const v=parseInt(e.target.value)||0;if(v>0)d.ap_bonus=v;else delete d.ap_bonus;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
              </>}
              {newItem.category === 'น้ำ' && <>
                <div>
                  <div style={s.miniLabel}>เพิ่มความชุ่มชื่น</div>
                  <input type="number" value={(() => { try { return JSON.parse(newItem.data).thirst ?? 40 } catch { return 40 } })()} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.thirst=parseInt(e.target.value)||0;d.ap_cost=0;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>เพิ่ม AP (ถ้ามี)</div>
                  <input type="number" value={(() => { try { return JSON.parse(newItem.data).ap_bonus ?? 0 } catch { return 0 } })()} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');const v=parseInt(e.target.value)||0;if(v>0)d.ap_bonus=v;else delete d.ap_bonus;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
              </>}
              {newItem.category === 'ยา' && <>
                <div>
                  <div style={s.miniLabel}>ฟื้นฟู HP</div>
                  <input type="number" value={(() => { try { return JSON.parse(newItem.data).hp ?? 0 } catch { return 0 } })()} onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');d.hp=parseInt(e.target.value)||0;d.ap_cost=0;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}/>
                </div>
                <div>
                  <div style={s.miniLabel}>รักษา moodle</div>
                  <select onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');if(e.target.value)d.removes_moodle=e.target.value;else delete d.removes_moodle;return{...p,data:JSON.stringify(d)}}catch{return p}})} style={s.input}>
                    <option value="">— ไม่มี —</option>
                    {moodles.map(m=><option key={m.id} value={m.id}>{m.id} ({m.type})</option>)}
                  </select>
                </div>
              </>}
              {newItem.category === 'อุปกรณ์' && (
                <div>
                  <div style={s.miniLabel}>ป้องกันความเสียหาย (defense)</div>
                  <input type='number' defaultValue={0} min={0}
                    onChange={e=>setNewItem(p=>{try{const d=JSON.parse(p.data||'{}');const v=parseInt(e.target.value)||0;if(v>0)d.defense=v;else delete d.defense;return{...p,data:JSON.stringify(d)}}catch{return p}})}
                    style={s.input} placeholder='0 = ไม่มีป้องกัน'/>
                </div>
              )}
              {newItem.category === 'วัสดุ' && (
                <div style={{ gridColumn:'1/-1' }}>
                  <p style={{ fontSize:'12px', color:'var(--text-secondary)' }}>ใช้เป็นวัสดุคราฟต์เท่านั้น</p>
                </div>
              )}
            </div>
            <div style={{ display:'flex', gap:'8px' }}>
              <button onClick={async () => {
                if (!newItem.id.trim()) { notify('❌ ต้องมี ID', false); return }
                let parsedData = {}
                try { parsedData = JSON.parse(newItem.data || '{}') } catch { notify('❌ data ไม่ใช่ JSON ที่ถูกต้อง', false); return }
                await saveItem({
                  id: newItem.id.trim(),
                  name: newItem.name.trim() || newItem.id.trim(),
                  category: newItem.category as any,
                  description: newItem.description || null,
                  photo_url: newItem.photo_url || null,
                  weight: parseFloat(newItem.weight) || 0.1,
                  data: parsedData,
                }, true)
                setShowAddItem(false)
                setNewItem({ id:'', name:'', category:'อาหาร', description:'', photo_url:'', weight:'0.1', data:'{}' })
              }} style={{ ...s.greenBtn, flex:1, padding:'10px' }}>💾 บันทึก</button>
              <button onClick={() => setShowAddItem(false)} style={{ ...s.yellowBtn, padding:'10px 16px' }}>ยกเลิก</button>
            </div>
          </div>
        </div>
      )}

      {/* ── TAB: ไอเทม ── */}
        {tab === 'ไอเทม' && (
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span>ไอเทมทั้งหมด ({items.length})</span>
              <button onClick={() => setShowAddItem(true)} style={s.addBtn}>+ เพิ่มไอเทม</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {items.map(item => (
                <ItemRow key={item.id} item={item} onEdit={setEditItem} onDelete={deleteItem} />
              ))}
            </div>
          </div>
        )}

        {/* ── TAB: นิสัย ── */}
        {tab === 'นิสัย' && (
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span>นิสัยทั้งหมด ({traits.length})</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {traits.map(trait => (
                <div key={trait.id} style={s.card}>
                  <div style={s.cardRow}>
                    {trait.icon_url ? (
                      <img src={trait.icon_url} alt="" style={{ width:'28px', height:'28px', borderRadius:'4px', border:'1px solid var(--border)', objectFit:'cover', flexShrink:0 }} />
                    ) : (
                      <div style={{ width:'28px', height:'28px', borderRadius:'4px', border:'1px solid var(--border)', background:'var(--bg-tertiary)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>?</span>
                      </div>
                    )}
                    <span style={{ fontSize: '13px', fontWeight: 600, color: trait.type === 'ลบ' ? 'var(--red-bright)' : 'var(--text-primary)' }}>
                      {trait.id}
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                      {trait.type}
                      {trait.type === 'ลบ' && ` | +${trait.bonus_points} แต้ม`}
                    </span>
                    <span style={{ fontSize: '11px', padding: '2px 6px', background: trait.is_active ? 'rgba(45,90,39,0.2)' : 'rgba(100,100,100,0.2)', color: trait.is_active ? 'var(--green-bright)' : 'var(--text-secondary)', border: '1px solid currentColor' }}>
                      {trait.is_active ? 'เปิด' : 'ปิด'}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{trait.description}</div>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <input placeholder="URL ไอคอน" defaultValue={trait.icon_url ?? ''} style={{ ...s.smallInput, flex: 1 }}
                      onBlur={async e => {
                        await (supabase as any).from('trait_definitions').update({ icon_url: e.target.value || null }).eq('id', trait.id)
                        notify('✅ อัปเดต icon แล้ว')
                      }} />
                    <button onClick={async () => {
                      await (supabase as any).from('trait_definitions').update({ is_active: !trait.is_active }).eq('id', trait.id)
                      notify('✅ อัปเดตแล้ว'); reload()
                    }} style={trait.is_active ? s.redBtn : s.greenBtn}>
                      {trait.is_active ? 'ปิด' : 'เปิด'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TAB: moodles ── */}
        {tab === 'moodles' && (
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span>Moodles ทั้งหมด ({moodles.length})</span>
              <button onClick={() => { setEditMoodle(null); setShowAddMoodle(true) }} style={s.addBtn}>+ เพิ่ม moodle</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {moodles.map(m => (
                <div key={m.id} style={{ ...s.card, borderLeft: `3px solid ${m.border_color ?? 'var(--border)'}` }}>
                  <div style={s.cardRow}>
                    {m.icon_url ? (
                      <img src={m.icon_url} alt="" style={{ width:'28px', height:'28px', objectFit:'contain', flexShrink:0 }} />
                    ) : (
                      <div style={{ width:'28px', height:'28px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'4px', flexShrink:0 }} />
                    )}
                    <span style={{ fontSize:'13px', fontWeight:600, color: m.border_color ?? 'var(--text-primary)' }}>{m.id}</span>
                    <span style={{ fontSize:'11px', color:'var(--text-secondary)', border:'1px solid var(--border)', padding:'1px 6px' }}>{m.type}</span>
                    <span style={{ fontSize:'11px', color:'var(--text-secondary)', fontFamily:'var(--font-mono)' }}>max Lv.{m.max_level}</span>
                    <span style={{ fontSize:'11px', padding:'2px 6px', background: m.is_active ? 'rgba(45,90,39,0.2)' : 'rgba(100,100,100,0.2)', color: m.is_active ? 'var(--green-bright)' : 'var(--text-secondary)', border:'1px solid currentColor' }}>
                      {m.is_active ? 'เปิด' : 'ปิด'}
                    </span>
                    <div style={{ flex:1 }} />
                    <button onClick={() => { setEditMoodle(m); setShowAddMoodle(true) }} style={s.yellowBtn}>แก้ไข</button>
                    <button onClick={async () => {
                      if (!confirm(`ลบ moodle "${m.id}"?`)) return
                      const { error } = await (supabase as any).from('moodle_definitions').delete().eq('id', m.id)
                      if (error) { notify('❌ ' + error.message, false); return }
                      setMoodles(prev => prev.filter(x => x.id !== m.id))
                      notify('✅ ลบแล้ว')
                    }} style={s.redBtn}>ลบ</button>
                  </div>
                  {(m.cause || m.treatment) && (
                    <div style={{ fontSize:'11px', color:'var(--text-secondary)', marginTop:'3px', display:'flex', gap:'12px' }}>
                      {m.cause && <span>สาเหตุ: {m.cause}</span>}
                      {m.treatment && <span>รักษา: {m.treatment}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TAB: สูตรคราฟต์ ── */}
        {tab === 'สูตรคราฟต์' && (
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span>สูตรคราฟต์ ({recipes.length})</span>
              <button onClick={() => setShowAddRecipe(true)} style={s.addBtn}>+ เพิ่มสูตร</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {recipes.map(r => (
                <div key={r.id} style={s.card}>
                  <div style={s.cardRow}>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{r.id}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-gold)' }}>
                      {r.ap_cost} AP | INT {r.min_int}+
                    </span>
                    <span style={{ fontSize: '11px', padding: '2px 6px', background: r.is_active ? 'rgba(45,90,39,0.2)' : 'rgba(100,100,100,0.2)', color: r.is_active ? 'var(--green-bright)' : 'var(--text-secondary)', border: '1px solid currentColor' }}>
                      {r.is_active ? 'เปิด' : 'ปิด'}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                    วัสดุ: {r.ingredients.map(i => `${i.id}×${i.qty}`).join(', ')} → {r.result_id}×{r.result_qty}
                  </div>
                  <div style={{ display:'flex', gap:'6px', marginTop:'6px' }}>
                    <button onClick={async () => {
                      await (supabase as any).from('craft_recipes').update({ is_active: !r.is_active }).eq('id', r.id)
                      const { data } = await (supabase as any).from('craft_recipes').select('*').order('id')
                      if (data) setRecipes(data)
                      notify('✅ อัปเดตแล้ว')
                    }} style={r.is_active ? s.redBtn : s.greenBtn}>
                      {r.is_active ? 'ปิดสูตร' : 'เปิดสูตร'}
                    </button>
                    <button onClick={async () => {
                      if (!confirm('ลบสูตร "' + r.id + '"?')) return
                      await (supabase as any).from('craft_recipes').delete().eq('id', r.id)
                      setRecipes(prev => prev.filter(x => x.id !== r.id))
                      notify('✅ ลบแล้ว')
                    }} style={s.redBtn}>ลบ</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TAB: แผนที่ ── */}
        {tab === 'แผนที่' && (
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span>spawn table แต่ละช่อง</span>
              <button onClick={async () => {
                if (gridsLoaded) return
                setGridsLoading(true)
                const { data } = await (supabase as any).from('grids').select('*').order('zone_name').order('x').order('y')
                setGrids(data ?? [])
                setGridsLoaded(true)
                setGridsLoading(false)
              }} style={s.addBtn} disabled={gridsLoaded}>
                {gridsLoaded ? `โหลดแล้ว (${grids.length} ช่อง)` : gridsLoading ? 'กำลังโหลด...' : '📥 โหลดข้อมูล'}
              </button>
            </div>

            {gridsLoaded && (
              <>
                <input
                  value={gridSearch}
                  onChange={e => setGridSearch(e.target.value)}
                  placeholder="ค้นหาด้วยชื่อเขต, terrain หรือพิกัด เช่น 24,10"
                  style={{ ...s.input, marginBottom: '8px' }}
                />
                <div style={{ display:'flex', flexDirection:'column', gap:'4px' }}>
                  {grids
                    .filter(g => {
                      const q = gridSearch.toLowerCase()
                      if (!q) return true
                      if (`${g.x},${g.y}`.includes(q)) return true
                      if ((g.zone_name ?? '').toLowerCase().includes(q)) return true
                      if ((g.terrain ?? '').toLowerCase().includes(q)) return true
                      return false
                    })
                    .map(g => (
                      <div key={`${g.x}-${g.y}`} style={s.card}>
                        <div style={s.cardRow}>
                          <span style={{ fontFamily:'var(--font-mono)', fontSize:'12px', color:'var(--text-gold)', minWidth:'60px' }}>[{g.x},{g.y}]</span>
                          <span style={{ fontSize:'12px', fontWeight:600 }}>{g.zone_name ?? '—'}</span>
                          <span style={{ fontSize:'11px', color:'var(--text-secondary)', border:'1px solid var(--border)', padding:'1px 6px' }}>{g.terrain ?? '—'}</span>
                          <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>👁 {g.visibility ?? 2}</span>
                          <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>
                            {(g.spawn_table ?? []).length} item{(g.spawn_table ?? []).length !== 1 ? 's' : ''}
                          </span>
                          <div style={{ flex:1 }} />
                          <button onClick={() => setEditGrid(g)} style={s.yellowBtn}>แก้ไข spawn</button>
                        </div>
                        {(g.spawn_table ?? []).length > 0 && (
                          <div style={{ fontSize:'11px', color:'var(--text-secondary)', marginTop:'3px' }}>
                            {(g.spawn_table as any[]).map((it: any) => `${it.id}(${it['น้ำหนัก'] ?? it.weight ?? 1})`).join(' · ')}
                          </div>
                        )}
                      </div>
                    ))
                  }
                </div>
              </>
            )}
          </div>
        )}

        {/* ── TAB: ประกาศ ── */}
        {tab === 'ประกาศ' && (
          <div style={s.section}>
            <div style={s.sectionHeader}><span>ส่งประกาศ</span></div>
            {!currentGame ? (
              <div style={s.empty}>ไม่มีเกมที่กำลังเล่น</div>
            ) : (
              <AnnouncementForm gameId={currentGame.id} players={gamePlayers} notify={notify} />
            )}
          </div>
        )}

      </div>
    </div>

    {/* ── Add/Edit Moodle Modal ── */}
    {showAddMoodle && (
      <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center' }}
        onClick={() => { setShowAddMoodle(false); setEditMoodle(null) }}>
        <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-secondary)', border:'1px solid var(--red-blood)', padding:'20px', width:'500px', maxWidth:'95vw', maxHeight:'90vh', overflow:'auto', display:'flex', flexDirection:'column', gap:'12px' }}>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'14px', color:'var(--red-bright)', letterSpacing:'0.1em' }}>
            {editMoodle ? `✏️ แก้ไข: ${editMoodle.id}` : '+ เพิ่ม moodle ใหม่'}
          </div>
          <MoodleForm
            moodle={editMoodle}
            onSave={async (data) => {
              if (editMoodle) {
                const { error } = await (supabase as any).from('moodle_definitions').update(data).eq('id', editMoodle.id)
                if (error) { notify('❌ ' + error.message, false); return }
                notify('✅ อัปเดตแล้ว')
              } else {
                const { error } = await (supabase as any).from('moodle_definitions').insert(data)
                if (error) { notify('❌ ' + error.message, false); return }
                notify('✅ เพิ่มแล้ว')
              }
              const { data: fresh } = await (supabase as any).from('moodle_definitions').select('*').order('id')
              if (fresh) setMoodles(fresh)
              setShowAddMoodle(false); setEditMoodle(null)
            }}
            onCancel={() => { setShowAddMoodle(false); setEditMoodle(null) }}
          />
        </div>
      </div>
    )}

    {/* ── Edit Grid Spawn Modal ── */}
    {editGrid && (
      <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center' }}
        onClick={() => setEditGrid(null)}>
        <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-secondary)', border:'1px solid var(--red-blood)', padding:'20px', width:'520px', maxWidth:'95vw', maxHeight:'90vh', overflow:'auto', display:'flex', flexDirection:'column', gap:'12px' }}>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'14px', color:'var(--red-bright)', letterSpacing:'0.1em' }}>
            ✏️ spawn table [{editGrid.x},{editGrid.y}] — {editGrid.zone_name}
          </div>
          <GridSpawnEditor
            grid={editGrid}
            items={items}
            onSave={async (newSpawnTable) => {
              const { error } = await (supabase as any).from('grids')
                .update({ spawn_table: newSpawnTable })
                .eq('x', editGrid.x).eq('y', editGrid.y)
              if (error) { notify('❌ ' + error.message, false); return }
              setGrids(prev => prev.map(g => g.x === editGrid.x && g.y === editGrid.y ? { ...g, spawn_table: newSpawnTable } : g))
              notify('✅ อัปเดต spawn table แล้ว')
              setEditGrid(null)
            }}
            onCancel={() => setEditGrid(null)}
          />
        </div>
      </div>
    )}
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    'รอผู้เล่น': 'var(--text-gold)',
    'กำลังเล่น': 'var(--green-bright)',
    'หยุดชั่วคราว': '#E67E22',
    'จบแล้ว': 'var(--text-secondary)',
  }
  return (
    <span style={{ fontSize: '11px', color: colors[status] ?? 'var(--text-secondary)', border: '1px solid currentColor', padding: '2px 8px' }}>
      {status}
    </span>
  )
}

function PlayerRow({ player, onBan, onMute, onKill, onFillAP, onFillHP, onTeleport, onGiveItem, items, moodles }: {
  player: Player
  onBan: () => void; onMute: () => void; onKill: () => void
  onFillAP: () => void; onFillHP: () => void
  onTeleport: (x: number, y: number) => void
  onGiveItem: (itemId: string, qty: number) => void
  items: ItemDefinition[]
  moodles: MoodleDefinition[]
}) {
  const supabase = createClient()
  const [tpX, setTpX] = useState(player.pos_x?.toString() ?? '10')
  const [tpY, setTpY] = useState(player.pos_y?.toString() ?? '10')
  const [giveItemId, setGiveItemId] = useState('')
  const [giveQty, setGiveQty] = useState('1')
  const [showGive, setShowGive] = useState(false)
  const [giveSearch, setGiveSearch] = useState('')
  const [showGiveSuggestions, setShowGiveSuggestions] = useState(false)
  const [showMoodle, setShowMoodle] = useState(false)
  const [currentMoodles, setCurrentMoodles] = useState<any[]>(player.moodles ?? [])
  const [addMoodleId, setAddMoodleId] = useState('')

  async function saveMoodles(updated: any[]) {
    const { error } = await (supabase as any).from('players').update({ moodles: updated }).eq('id', player.id)
    if (!error) setCurrentMoodles(updated)
  }

  return (
    <div style={s.card}>
      <div style={s.cardRow}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)' }}>
          #{String(player.student_number).padStart(2,'0')}
        </span>
        <span style={{ fontSize: '13px', fontWeight: 600, color: player.is_alive ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          {player.name}
        </span>
        <span style={{ fontSize: '11px', color: player.is_alive ? 'var(--green-bright)' : 'var(--red-danger)' }}>
          {player.is_alive ? `HP ${player.hp}/${player.max_hp}` : '✕ ตาย'}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          [{player.pos_x ?? '?'},{player.pos_y ?? '?'}]
        </span>
        {player.is_banned && <span style={{ fontSize: '10px', color: 'var(--red-bright)', border: '1px solid var(--red-bright)', padding: '1px 5px' }}>แบน</span>}
        {player.chat_muted && <span style={{ fontSize: '10px', color: '#E67E22', border: '1px solid #E67E22', padding: '1px 5px' }}>ปิดแชท</span>}
      </div>

      {/* Moodle ปัจจุบัน */}
      {currentMoodles.length > 0 && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:'4px', marginTop:'5px' }}>
          {currentMoodles.map((m: any) => {
            const def = moodles.find(d => d.id === m.id)
            return (
              <span key={m.id} style={{
                display:'flex', alignItems:'center', gap:'4px',
                padding:'2px 7px', border:`1px solid ${def?.border_color ?? 'var(--border)'}`,
                color: def?.border_color ?? 'var(--text-secondary)',
                background:'var(--bg-tertiary)', fontSize:'11px',
              }}>
                {m.id} Lv.{m.level ?? 1}
                <button onClick={() => saveMoodles(currentMoodles.filter((x: any) => x.id !== m.id))}
                  style={{ background:'none', border:'none', color:'inherit', cursor:'pointer', fontSize:'12px', padding:'0 0 0 2px', lineHeight:1 }}>✕</button>
              </span>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'center' }}>
        <button onClick={onBan} style={player.is_banned ? s.greenBtn : s.redBtn}>
          {player.is_banned ? 'ยกเลิกแบน' : 'แบน'}
        </button>
        <button onClick={onMute} style={s.yellowBtn}>
          {player.chat_muted ? 'เปิดแชท' : 'ปิดแชท'}
        </button>
        {player.is_alive && <>
          <button onClick={onKill} style={s.redBtn}>ฆ่า</button>
          <button onClick={onFillAP} style={s.yellowBtn}>⚡ เติม AP</button>
          <button onClick={onFillHP} style={s.greenBtn}>❤ เติม HP</button>
          <button onClick={() => setShowGive(p => !p)} style={{ ...s.yellowBtn, fontSize:'11px' }}>🎁 เสกของ</button>
        </>}
        <button onClick={() => setShowMoodle(p => !p)} style={{
          ...s.yellowBtn, fontSize:'11px',
          borderColor: showMoodle ? 'var(--red-bright)' : undefined,
          color: showMoodle ? 'var(--red-bright)' : undefined,
        }}>🩹 moodle{currentMoodles.length > 0 ? ` (${currentMoodles.length})` : ''}</button>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginLeft: '8px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>ย้ายไป:</span>
          <input value={tpX} onChange={e => setTpX(e.target.value)} style={{ ...s.smallInput, width: '36px' }} placeholder="X" />
          <input value={tpY} onChange={e => setTpY(e.target.value)} style={{ ...s.smallInput, width: '36px' }} placeholder="Y" />
          <button onClick={() => onTeleport(parseInt(tpX), parseInt(tpY))} style={s.yellowBtn}>ย้าย</button>
        </div>
      </div>

      {/* เสกของ */}
      {showGive && (
        <div style={{ marginTop:'8px', paddingTop:'8px', borderTop:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:'6px' }}>
          <div style={{ display:'flex', gap:'6px', alignItems:'center', flexWrap:'wrap' }}>
            {/* Autocomplete */}
            <div style={{ flex:1, minWidth:'160px', position:'relative' }}>
              <input
                value={giveSearch}
                onChange={e => {
                  setGiveSearch(e.target.value)
                  setGiveItemId('')
                  setShowGiveSuggestions(true)
                }}
                onFocus={() => setShowGiveSuggestions(true)}
                onBlur={() => setTimeout(() => setShowGiveSuggestions(false), 150)}
                placeholder='พิมพ์ชื่อไอเทม...'
                style={{ ...s.smallInput, width:'100%' }}
              />
              {showGiveSuggestions && giveSearch.length > 0 && (() => {
                const filtered = items.filter(it =>
                  it.name.toLowerCase().includes(giveSearch.toLowerCase()) ||
                  it.id.toLowerCase().includes(giveSearch.toLowerCase())
                ).slice(0, 8)
                if (filtered.length === 0) return null
                return (
                  <div style={{
                    position:'absolute', top:'100%', left:0, right:0, zIndex:100,
                    background:'var(--bg-secondary)', border:'1px solid var(--border)',
                    maxHeight:'200px', overflow:'auto',
                  }}>
                    {filtered.map(it => (
                      <div key={it.id} onMouseDown={() => {
                        setGiveItemId(it.id)
                        setGiveSearch(it.name)
                        setShowGiveSuggestions(false)
                      }} style={{
                        display:'flex', alignItems:'center', gap:'8px',
                        padding:'6px 10px', cursor:'pointer',
                        borderBottom:'1px solid var(--border)',
                        background: giveItemId === it.id ? 'rgba(139,0,0,0.15)' : 'transparent',
                      }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                        onMouseLeave={e => (e.currentTarget.style.background = giveItemId === it.id ? 'rgba(139,0,0,0.15)' : 'transparent')}
                      >
                        {it.photo_url ? (
                          <img src={it.photo_url} alt="" style={{ width:'24px', height:'24px', objectFit:'cover', borderRadius:'2px', border:'1px solid var(--border)', flexShrink:0 }} />
                        ) : (
                          <div style={{ width:'24px', height:'24px', background:'var(--bg-primary)', border:'1px solid var(--border)', borderRadius:'2px', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'12px' }}>
                            {it.category === 'อาวุธ' ? '⚔' : it.category === 'ยา' ? '💊' : it.category === 'อาหาร' ? '🍖' : it.category === 'น้ำ' ? '💧' : '📦'}
                          </div>
                        )}
                        <div>
                          <div style={{ fontSize:'12px', color:'var(--text-primary)' }}>{it.name}</div>
                          <div style={{ fontSize:'10px', color:'var(--text-secondary)' }}>{it.category} · {it.weight} กก.</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
            <input type='number' min={1} max={99} value={giveQty} onChange={e => setGiveQty(e.target.value)}
              style={{ ...s.smallInput, width:'48px' }} placeholder='จำนวน' />
            <button onClick={() => {
              if (!giveItemId) return
              onGiveItem(giveItemId, parseInt(giveQty) || 1)
              setShowGive(false); setGiveItemId(''); setGiveSearch('')
            }} disabled={!giveItemId} style={{ ...s.greenBtn, opacity: giveItemId ? 1 : 0.4 }}>✅ ให้</button>
            <button onClick={() => { setShowGive(false); setGiveSearch(''); setGiveItemId('') }} style={s.yellowBtn}>ยกเลิก</button>
          </div>
          {giveItemId && (() => {
            const sel = items.find(it => it.id === giveItemId)
            if (!sel) return null
            return (
              <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'6px 8px', background:'rgba(139,0,0,0.1)', border:'1px solid var(--red-blood)', fontSize:'12px' }}>
                {sel.photo_url && <img src={sel.photo_url} alt="" style={{ width:'28px', height:'28px', objectFit:'cover', borderRadius:'2px' }} />}
                <span style={{ color:'var(--text-gold)' }}>{sel.name}</span>
                <span style={{ color:'var(--text-secondary)' }}>{sel.category} · {sel.weight} กก.</span>
              </div>
            )
          })()}
        </div>
      )}

      {/* จัดการ Moodle */}
      {showMoodle && (
        <div style={{ marginTop:'8px', paddingTop:'8px', borderTop:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:'8px' }}>
          <div style={{ display:'flex', gap:'6px', alignItems:'center', flexWrap:'wrap' }}>
            <select value={addMoodleId} onChange={e => setAddMoodleId(e.target.value)}
              style={{ ...s.smallInput, flex:1, minWidth:'160px' }}>
              <option value=''>— เลือก moodle ที่จะเพิ่ม —</option>
              {moodles.filter(m => !currentMoodles.find((c: any) => c.id === m.id)).map(m => (
                <option key={m.id} value={m.id}>{m.id} ({m.type})</option>
              ))}
            </select>
            <button disabled={!addMoodleId} onClick={() => {
              if (!addMoodleId) return
              saveMoodles([...currentMoodles, { id: addMoodleId, level: 1 }])
              setAddMoodleId('')
            }} style={{ ...s.greenBtn, opacity: addMoodleId ? 1 : 0.4 }}>+ เพิ่ม</button>
            {currentMoodles.length > 0 && (
              <button onClick={() => { if (confirm('ล้าง moodle ทั้งหมดของ ' + player.name + '?')) saveMoodles([]) }}
                style={{ ...s.redBtn, fontSize:'11px' }}>🗑 ล้างทั้งหมด</button>
            )}
          </div>
          {currentMoodles.length === 0 && (
            <span style={{ fontSize:'12px', color:'var(--text-secondary)' }}>ไม่มี moodle</span>
          )}
        </div>
      )}
    </div>
  )
}

function ItemRow({ item, onEdit, onDelete }: {
  item: ItemDefinition
  onEdit: (item: ItemDefinition) => void
  onDelete: (id: string) => void
}) {
  return (
    <div style={s.card}>
      <div style={s.cardRow}>
        {item.photo_url ? (
          <img src={item.photo_url} alt={item.name} style={{ width:'36px', height:'36px', objectFit:'cover', borderRadius:'3px', border:'1px solid var(--border)', flexShrink:0 }} />
        ) : (
          <div style={{ width:'36px', height:'36px', background:'var(--bg-primary)', border:'1px solid var(--border)', borderRadius:'3px', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'16px' }}>
            {item.category === 'อาวุธ' ? '⚔' : item.category === 'ยา' ? '💊' : item.category === 'อาหาร' ? '🍖' : item.category === 'น้ำ' ? '💧' : '📦'}
          </div>
        )}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-gold)' }}>{item.id}</span>
        <span style={{ fontSize: '13px' }}>{item.name}</span>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '1px 6px' }}>{item.category}</span>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{item.weight} กก.</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => onEdit(item)} style={s.yellowBtn}>แก้ไข</button>
        <button onClick={() => onDelete(item.id)} style={s.redBtn}>ลบ</button>
      </div>
      {item.description && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{item.description}</div>}
    </div>
  )
}

function EditItemForm({ item, onSave, onCancel, moodles }: {
  item: ItemDefinition
  onSave: (item: any) => void
  onCancel: () => void
  moodles: MoodleDefinition[]
}) {
  const d = (item.data ?? {}) as Record<string,any>
  const [name, setName] = useState(item.name)
  const [category, setCategory] = useState(item.category)
  const [description, setDescription] = useState(item.description ?? '')
  const [photoUrl, setPhotoUrl] = useState(item.photo_url ?? '')
  const [weight, setWeight] = useState(item.weight.toString())
  // weapon fields
  const [damage, setDamage] = useState(String(d.damage ?? 10))
  const [crit, setCrit] = useState(String(d.crit_chance ?? 5))
  const [range, setRange] = useState(String(d.range ?? 1))
  const [apCost, setApCost] = useState(String(d.ap_cost ?? 30))
  const [bleed, setBleed] = useState(String(d.bleed_chance ?? 0))
  const [stun, setStun] = useState(String(d.stun_chance ?? 0))
  const [wtype, setWtype] = useState(d.type ?? 'blunt')
  // food/water/heal fields
  const [hunger, setHunger] = useState(String(d.hunger ?? 0))
  const [thirst, setThirst] = useState(String(d.thirst ?? 0))
  const [hp, setHp] = useState(String(d.hp ?? 0))
  const [apBonus, setApBonus] = useState(String(d.ap_bonus ?? 0))
  const [removesMoodle, setRemovesMoodle] = useState(d.removes_moodle ?? '')
  const [defense, setDefense] = useState(String(d.defense ?? 0))
  const [craftableOnly, setCraftableOnly] = useState(!!(d as any).craftable_only)

  function buildData(): Record<string,any> {
    if (category === 'อาวุธ') return {
      damage: parseInt(damage)||10, crit_chance: parseInt(crit)||5,
      range: parseInt(range)||1, ap_cost: parseInt(apCost)||30,
      bleed_chance: parseInt(bleed)||0, stun_chance: parseInt(stun)||0, type: wtype,
    }
    if (category === 'อาหาร') {
      const r: any = { hunger: parseInt(hunger)||0, ap_cost: 0 }
      if (parseInt(apBonus) > 0) r.ap_bonus = parseInt(apBonus)
      return r
    }
    if (category === 'น้ำ') {
      const r: any = { thirst: parseInt(thirst)||0, ap_cost: 0 }
      if (parseInt(apBonus) > 0) r.ap_bonus = parseInt(apBonus)
      return r
    }
    if (category === 'ยา') {
      const r: any = { hp: parseInt(hp)||0, ap_cost: 0 }
      if (removesMoodle) r.removes_moodle = removesMoodle
      return r
    }
    if (category === 'อุปกรณ์') {
      const r: any = {}
      if (parseInt(defense) > 0) r.defense = parseInt(defense)
      return r
    }
    const base: any = {}
    if (craftableOnly) base.craftable_only = true
    return base
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
        <div><div style={s.miniLabel}>ชื่อแสดง</div><input value={name} onChange={e=>setName(e.target.value)} style={s.input}/></div>
        <div><div style={s.miniLabel}>หมวดหมู่</div>
          <select value={category} onChange={e=>setCategory(e.target.value as any)} style={s.input}>
            {['อาหาร','น้ำ','ยา','อาวุธ','วัสดุ','อุปกรณ์'].map(c=><option key={c}>{c}</option>)}
          </select>
        </div>
        <div><div style={s.miniLabel}>น้ำหนัก (กก.)</div><input type='number' value={weight} onChange={e=>setWeight(e.target.value)} style={s.input} step='0.1'/></div>
        <div><div style={s.miniLabel}>URL รูปภาพ</div><input value={photoUrl} onChange={e=>setPhotoUrl(e.target.value)} style={s.input} placeholder='https://...'/></div>
        <div style={{ gridColumn:'1/-1' }}><div style={s.miniLabel}>คำอธิบาย</div><textarea value={description} onChange={e=>setDescription(e.target.value)} style={{ ...s.input, height:'50px', resize:'vertical' }}/></div>
        {/* fields ตามหมวดหมู่ */}
        {category === 'อาวุธ' && <>
          <div><div style={s.miniLabel}>ความเสียหาย</div><input type='number' value={damage} onChange={e=>setDamage(e.target.value)} style={s.input}/></div>
          <div><div style={s.miniLabel}>คริติคอล %</div><input type='number' value={crit} onChange={e=>setCrit(e.target.value)} style={s.input}/></div>
          <div><div style={s.miniLabel}>ระยะโจมตี (ช่อง)</div><input type='number' value={range} onChange={e=>setRange(e.target.value)} style={s.input}/></div>
          <div><div style={s.miniLabel}>AP ที่ใช้</div><input type='number' value={apCost} onChange={e=>setApCost(e.target.value)} style={s.input}/></div>
          <div><div style={s.miniLabel}>เลือดออก %</div><input type='number' value={bleed} onChange={e=>setBleed(e.target.value)} style={s.input}/></div>
          <div><div style={s.miniLabel}>มึนงง %</div><input type='number' value={stun} onChange={e=>setStun(e.target.value)} style={s.input}/></div>
          <div style={{ gridColumn:'1/-1' }}><div style={s.miniLabel}>ประเภท</div>
            <select value={wtype} onChange={e=>setWtype(e.target.value)} style={s.input}>
              <option value='blunt'>ทื่อ (blunt)</option><option value='sharp'>มีคม (sharp)</option>
              <option value='ranged'>ระยะไกล</option><option value='firearm'>ปืน</option><option value='throwable'>ขว้าง</option>
            </select>
          </div>
        </>}
        {category === 'อาหาร' && <>
          <div><div style={s.miniLabel}>เพิ่มความอิ่ม</div><input type='number' value={hunger} onChange={e=>setHunger(e.target.value)} style={s.input}/></div>
          <div><div style={s.miniLabel}>เพิ่ม AP (ถ้ามี)</div><input type='number' value={apBonus} onChange={e=>setApBonus(e.target.value)} style={s.input}/></div>
        </>}
        {category === 'น้ำ' && <>
          <div><div style={s.miniLabel}>เพิ่มความชุ่มชื่น</div><input type='number' value={thirst} onChange={e=>setThirst(e.target.value)} style={s.input}/></div>
          <div><div style={s.miniLabel}>เพิ่ม AP (ถ้ามี)</div><input type='number' value={apBonus} onChange={e=>setApBonus(e.target.value)} style={s.input}/></div>
        </>}
        {category === 'อุปกรณ์' && (
          <div style={{ gridColumn:'1/-1' }}>
            <div style={s.miniLabel}>ป้องกันความเสียหาย (defense)</div>
            <input type='number' min={0} value={defense} onChange={e=>setDefense(e.target.value)} style={s.input} placeholder='0 = ไม่มีป้องกัน'/>
          </div>
        )}
        {category === 'ยา' && <>
          <div><div style={s.miniLabel}>ฟื้นฟู HP</div><input type='number' value={hp} onChange={e=>setHp(e.target.value)} style={s.input}/></div>
          <div><div style={s.miniLabel}>รักษา moodle</div>
            <select value={removesMoodle} onChange={e=>setRemovesMoodle(e.target.value)} style={s.input}>
              <option value=''>— ไม่มี —</option>
              {moodles.map(m=><option key={m.id} value={m.id}>{m.id} ({m.type})</option>)}
            </select>
          </div>
        </>}
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'8px', background:'var(--bg-primary)', border:'1px solid var(--border)' }}>
        <input type='checkbox' id='craftable_only' checked={craftableOnly} onChange={e=>setCraftableOnly(e.target.checked)}/>
        <label htmlFor='craftable_only' style={{ fontSize:'12px', color:'var(--text-secondary)', cursor:'pointer' }}>
          คราฟต์เท่านั้น — ไม่สามารถค้นหาได้ในแมป
        </label>
      </div>
      <div style={{ display:'flex', gap:'8px' }}>
        <button onClick={() => onSave({
          ...item, name, category: category as any,
          description: description || null,
          photo_url: photoUrl || null,
          weight: parseFloat(weight) || 0.1,
          data: buildData(),
        })} style={{ ...s.greenBtn, flex:1, padding:'10px' }}>💾 บันทึก</button>
        <button onClick={onCancel} style={{ ...s.yellowBtn, padding:'10px 16px' }}>ยกเลิก</button>
      </div>
    </div>
  )
}

function StartGamePanel({ gameId, onStart }: {
  gameId: string
  onStart: (id: string, endsAt: string) => void
}) {
  const [mode, setMode] = useState<'hours'|'days'|'date'>('days')
  const [value, setValue] = useState('4')
  const [dateVal, setDateVal] = useState('')

  function calcEndsAt(): string {
    if (mode === 'date') return new Date(dateVal).toISOString()
    const hours = mode === 'hours' ? parseFloat(value) : parseFloat(value) * 24
    return new Date(Date.now() + hours * 3_600_000).toISOString()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>จบใน:</span>
        <select value={mode} onChange={e => setMode(e.target.value as any)} style={s.smallInput}>
          <option value="hours">ชั่วโมง</option>
          <option value="days">วัน</option>
          <option value="date">วันที่</option>
        </select>
        {mode !== 'date' ? (
          <input type="number" value={value} onChange={e => setValue(e.target.value)}
            style={{ ...s.smallInput, width: '60px' }} min="1" step="0.5" />
        ) : (
          <input type="datetime-local" value={dateVal} onChange={e => setDateVal(e.target.value)}
            style={s.smallInput} />
        )}
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
          {mode === 'hours' ? `~${value} ชม.` : mode === 'days' ? `~${value} วัน` : ''}
        </span>
      </div>
      <button onClick={() => onStart(gameId, calcEndsAt())} style={s.greenBtn}>
        ▶ เริ่มเกม
      </button>
    </div>
  )
}

function AddRecipeForm({ items, onSave, onCancel }: {
  items: ItemDefinition[]
  onSave: (recipe: any) => void
  onCancel: () => void
}) {
  const [id, setId] = useState('')
  const [resultId, setResultId] = useState('')
  const [resultQty, setResultQty] = useState('1')
  const [apCost, setApCost] = useState('30')
  const [minInt, setMinInt] = useState('0')
  const [ingredients, setIngredients] = useState<Array<{id:string,qty:number}>>([])
  const [ingId, setIngId] = useState('')
  const [ingQty, setIngQty] = useState('1')
  const [resultSearch, setResultSearch] = useState('')
  const [ingSearch, setIngSearch] = useState('')

  function addIng() {
    if (!ingId || !items.find(i => i.id === ingId)) return
    const ex = ingredients.find(i => i.id === ingId)
    if (ex) setIngredients(prev => prev.map(i => i.id === ingId ? { ...i, qty: i.qty + (parseInt(ingQty)||1) } : i))
    else setIngredients(prev => [...prev, { id: ingId, qty: parseInt(ingQty)||1 }])
    setIngId(''); setIngSearch(''); setIngQty('1')
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
        <div style={{ gridColumn:'1/-1' }}>
          <div style={s.miniLabel}>ID สูตร (ภาษาไทย)</div>
          <input value={id} onChange={e=>setId(e.target.value)} style={s.input} placeholder='เช่น ปืนไฟฟ้า-เครื่องกำเนิดไฟ'/>
        </div>
        <div><div style={s.miniLabel}>AP ที่ใช้</div><input type='number' value={apCost} onChange={e=>setApCost(e.target.value)} style={s.input}/></div>
        <div><div style={s.miniLabel}>INT ขั้นต่ำ</div><input type='number' value={minInt} onChange={e=>setMinInt(e.target.value)} style={s.input}/></div>
      </div>
      <div>
        <div style={s.miniLabel}>ไอเทมที่ได้ (ผลลัพธ์)</div>
        <div style={{ display:'flex', gap:'6px' }}>
          <div style={{ flex:1, position:'relative' }}>
            <input value={resultSearch} onChange={e=>{ setResultSearch(e.target.value); setResultId(e.target.value) }}
              placeholder='พิมพ์ชื่อไอเทม...' style={{ ...s.input }}/>
            {resultSearch.trim() && !items.find(i=>i.id===resultSearch) && (() => {
              const f = items.filter(it => it.id.includes(resultSearch)||it.name.includes(resultSearch)).slice(0,6)
              if (!f.length) return null
              return <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:50, background:'var(--bg-secondary)', border:'1px solid var(--border)' }}>
                {f.map(it => <div key={it.id} onClick={()=>{ setResultId(it.id); setResultSearch(it.id) }}
                  style={{ padding:'5px 10px', cursor:'pointer', fontSize:'12px', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ color:'var(--text-gold)' }}>{it.id}</span> <span style={{ color:'var(--text-secondary)', fontSize:'11px' }}>({it.name})</span>
                </div>)}
              </div>
            })()}
          </div>
          <input type='number' min={1} value={resultQty} onChange={e=>setResultQty(e.target.value)} style={{ ...s.input, width:'60px' }} placeholder='จำนวน'/>
        </div>
      </div>
      <div>
        <div style={s.miniLabel}>วัสดุที่ต้องใช้</div>
        {ingredients.length > 0 && (
          <div style={{ display:'flex', flexWrap:'wrap', gap:'4px', marginBottom:'6px' }}>
            {ingredients.map((ing, i) => (
              <span key={i} style={{ fontSize:'11px', padding:'2px 8px', background:'rgba(45,90,39,0.1)', border:'1px solid var(--green-bright)', color:'var(--green-bright)', display:'flex', alignItems:'center', gap:'4px' }}>
                {ing.id}×{ing.qty}
                <button onClick={()=>setIngredients(prev=>prev.filter((_,j)=>j!==i))}
                  style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-secondary)', padding:'0 2px' }}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display:'flex', gap:'6px' }}>
          <div style={{ flex:1, position:'relative' }}>
            <input value={ingSearch} onChange={e=>{ setIngSearch(e.target.value); setIngId(e.target.value) }}
              placeholder='เพิ่มวัสดุ...' style={{ ...s.input }}/>
            {ingSearch.trim() && !items.find(i=>i.id===ingSearch) && (() => {
              const f = items.filter(it => it.id.includes(ingSearch)||it.name.includes(ingSearch)).slice(0,6)
              if (!f.length) return null
              return <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:50, background:'var(--bg-secondary)', border:'1px solid var(--border)' }}>
                {f.map(it => <div key={it.id} onClick={()=>{ setIngId(it.id); setIngSearch(it.id) }}
                  style={{ padding:'5px 10px', cursor:'pointer', fontSize:'12px', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ color:'var(--text-gold)' }}>{it.id}</span> <span style={{ color:'var(--text-secondary)', fontSize:'11px' }}>({it.name})</span>
                </div>)}
              </div>
            })()}
          </div>
          <input type='number' min={1} value={ingQty} onChange={e=>setIngQty(e.target.value)} style={{ ...s.input, width:'60px' }}/>
          <button onClick={addIng} style={s.yellowBtn}>+ เพิ่ม</button>
        </div>
      </div>
      <div style={{ display:'flex', gap:'8px' }}>
        <button onClick={() => {
          if (!id.trim() || !resultId || ingredients.length === 0) { return }
          onSave({ id: id.trim(), name: id.trim(), result_id: resultId, result_qty: parseInt(resultQty)||1,
            ap_cost: parseInt(apCost)||30, min_int: parseInt(minInt)||0,
            ingredients, is_active: true })
        }} style={{ ...s.greenBtn, flex:1, padding:'10px' }}>💾 บันทึก</button>
        <button onClick={onCancel} style={{ ...s.yellowBtn, padding:'10px 16px' }}>ยกเลิก</button>
      </div>
    </div>
  )
}

function AirdropPanel({ gameId, items, onDrop, notify }: {
  gameId: string; items: ItemDefinition[]
  onDrop: (gameId: string, x: number, y: number, items: Array<{id:string,qty:number}>, mins: number) => void
  notify: (t: string, ok?: boolean) => void
}) {
  const [x, setX] = useState('10')
  const [y, setY] = useState('10')
  const [expMins, setExpMins] = useState('60')
  const [dropItems, setDropItems] = useState<Array<{id:string,qty:number}>>([])
  const [selId, setSelId] = useState('')
  const [selQty, setSelQty] = useState('1')

  function addItem() {
    const found = items.find(it => it.id === selId)
    if (!found) return
    const existing = dropItems.find(i => i.id === selId)
    if (existing) setDropItems(prev => prev.map(i => i.id === selId ? { ...i, qty: i.qty + (parseInt(selQty)||1) } : i))
    else setDropItems(prev => [...prev, { id: selId, qty: parseInt(selQty)||1 }])
    setSelId(''); setSelQty('1')
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
      <div style={{ display:'flex', gap:'6px', alignItems:'center', flexWrap:'wrap' }}>
        <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>พิกัด X:</span>
        <input value={x} onChange={e=>setX(e.target.value)} style={{ ...s.smallInput, width:'40px' }}/>
        <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>Y:</span>
        <input value={y} onChange={e=>setY(e.target.value)} style={{ ...s.smallInput, width:'40px' }}/>
        <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>หายใน:</span>
        <input type='number' value={expMins} onChange={e=>setExpMins(e.target.value)} style={{ ...s.smallInput, width:'50px' }}/>
        <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>นาที</span>
      </div>
      <div style={{ display:'flex', gap:'6px', alignItems:'center', flexWrap:'wrap' }}>
        <div style={{ flex:1, minWidth:'150px', position:'relative' }}>
          <input value={selId} onChange={e=>setSelId(e.target.value)}
            placeholder='พิมพ์ชื่อไอเทม...'
            style={{ ...s.smallInput, width:'100%' }}/>
          {selId.trim() && (() => {
            const filtered = items.filter(it => it.id.includes(selId) || it.name.includes(selId)).slice(0, 8)
            if (filtered.length === 0) return null
            return (
              <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:50, background:'var(--bg-secondary)', border:'1px solid var(--border)', maxHeight:'200px', overflow:'auto' }}>
                {filtered.map(it => (
                  <div key={it.id} onClick={() => setSelId(it.id)}
                    style={{ padding:'6px 10px', cursor:'pointer', fontSize:'12px', borderBottom:'1px solid var(--border)' }}
                    onMouseEnter={e=>(e.currentTarget.style.background='var(--bg-tertiary)')}
                    onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>
                    <span style={{ color:'var(--text-gold)' }}>{it.id}</span>
                    <span style={{ color:'var(--text-secondary)', marginLeft:'6px', fontSize:'11px' }}>({it.category})</span>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
        <input type='number' min={1} value={selQty} onChange={e=>setSelQty(e.target.value)} style={{ ...s.smallInput, width:'48px' }}/>
        <button onClick={addItem} style={s.yellowBtn}>+เพิ่ม</button>
      </div>
      {dropItems.length > 0 && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:'4px' }}>
          {dropItems.map((it, i) => (
            <span key={i} style={{ fontSize:'11px', padding:'2px 8px', background:'rgba(230,126,34,0.1)', border:'1px solid #E67E22', color:'#E67E22', display:'flex', alignItems:'center', gap:'4px' }}>
              {it.id}×{it.qty}
              <button onClick={()=>setDropItems(prev=>prev.filter((_,j)=>j!==i))}
                style={{ background:'none', border:'none', color:'var(--text-secondary)', cursor:'pointer', padding:'0 2px' }}>✕</button>
            </span>
          ))}
        </div>
      )}
      {dropItems.length === 0 && <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>ยังไม่ได้เลือกของ</span>}
      <button disabled={dropItems.length === 0} onClick={() => {
        onDrop(gameId, parseInt(x)||0, parseInt(y)||0, dropItems, parseInt(expMins)||60)
        setDropItems([])
      }} style={{ ...s.greenBtn, opacity: dropItems.length === 0 ? 0.4 : 1 }}>📦 ส่ง Airdrop</button>
    </div>
  )
}

function ZoneDeclare({ gameId, onDeclare, notify }: {
  gameId: string
  onDeclare: (gameId: string, x: number, y: number, warn: boolean) => void
  notify: (t: string, ok?: boolean) => void
}) {
  const supabase = createClient()
  const COUNT = 4
  const [stage, setStage] = useState<'idle'|'warned'>('idle')
  const [zones, setZones] = useState<{x:number,y:number}[]>([])
  const [countdown, setCountdown] = useState(0)
  const [warnedZones, setWarnedZones] = useState<{x:number,y:number}[]>([])
  const [forbiddenZones, setForbiddenZones] = useState<{x:number,y:number}[]>([])

  useEffect(() => {
    (supabase as any).from('grid_states').select('x,y,warn_forbidden,is_forbidden')
      .eq('game_id', gameId).or('warn_forbidden.eq.true,is_forbidden.eq.true')
      .then(({ data }: { data: any }) => {
        if (!data) return
        setWarnedZones(data.filter((d: any) => d.warn_forbidden && !d.is_forbidden))
        setForbiddenZones(data.filter((d: any) => d.is_forbidden))
      })
  }, [gameId])

  useEffect(() => {
    if (stage !== 'warned' || countdown <= 0) return
    const t = setInterval(() => {
      setCountdown(p => {
        if (p <= 1) {
          zones.forEach(z => onDeclare(gameId, z.x, z.y, false))
          setForbiddenZones(prev => [...prev, ...zones])
          setWarnedZones(prev => prev.filter(w => !zones.some(z => z.x === w.x && z.y === w.y)))
          setStage('idle'); setZones([])
          notify('🚫 ปิดเขตอัตโนมัติเพราะหมดเวลา')
          return 0
        }
        return p - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [stage, countdown])

  function genZones() {
    const result: {x:number,y:number}[] = []
    const used = new Set<string>()
    while (result.length < COUNT) {
      const x = Math.floor(Math.random() * 26) + 2
      const y = Math.floor(Math.random() * 26) + 2
      const key = `${x},${y}`
      if (!used.has(key)) { used.add(key); result.push({ x, y }) }
    }
    return result
  }

  async function doWarn() {
    const z = genZones()
    setZones(z)
    for (const pos of z) await onDeclare(gameId, pos.x, pos.y, true)
    setWarnedZones(prev => [...prev, ...z])
    setStage('warned')
    setCountdown(600)
  }

  async function doClose() {
    for (const z of zones) await onDeclare(gameId, z.x, z.y, false)
    setForbiddenZones(prev => [...prev, ...zones])
    setWarnedZones(prev => prev.filter(w => !zones.some(z => z.x === w.x && z.y === w.y)))
    setStage('idle'); setZones([]); setCountdown(0)
  }

  async function doClearAll() {
    if (!confirm('ยืนยันล้างเขตทั้งหมด?')) return
    await (supabase as any).from('grid_states')
      .update({ is_forbidden: false, warn_forbidden: false })
      .eq('game_id', gameId).or('is_forbidden.eq.true,warn_forbidden.eq.true')
    setForbiddenZones([]); setWarnedZones([])
    setStage('idle'); setZones([]); setCountdown(0)
    notify('✅ ล้างเขตทั้งหมดแล้ว')
  }

  const mins = Math.floor(countdown / 60)
  const secs = countdown % 60

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {(warnedZones.length > 0 || forbiddenZones.length > 0) && (
        <div style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {warnedZones.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '11px', color: '#E67E22' }}>⚠️ เฝ้าระวัง:</span>
              {warnedZones.map((z, i) => <span key={i} style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: '#E67E22', background: 'rgba(230,126,34,0.1)', border: '1px solid #E67E22', padding: '1px 6px' }}>[{z.x},{z.y}]</span>)}
            </div>
          )}
          {forbiddenZones.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '11px', color: 'var(--red-bright)' }}>🚫 อันตราย:</span>
              {forbiddenZones.map((z, i) => <span key={i} style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--red-bright)', background: 'rgba(139,0,0,0.15)', border: '1px solid var(--red-bright)', padding: '1px 6px' }}>[{z.x},{z.y}]</span>)}
            </div>
          )}
        </div>
      )}
      {stage === 'idle' && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={doWarn} style={s.yellowBtn}>🎲 สุ่มและเตือน {COUNT} ช่อง</button>
          {(warnedZones.length > 0 || forbiddenZones.length > 0) && (
            <button onClick={doClearAll} style={{ ...s.redBtn, opacity: 0.7, fontSize: '11px' }}>🗑 ล้างทั้งหมด</button>
          )}
        </div>
      )}
      {stage === 'warned' && (
        <>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-gold)', fontFamily: 'var(--font-mono)' }}>
              ⏱ ปิดอัตโนมัติใน {mins}:{secs.toString().padStart(2,'0')}
            </span>
            <button onClick={doClose} style={s.redBtn}>🚫 ปิดเขตทันที</button>
            <button onClick={doClearAll} style={{ ...s.redBtn, opacity: 0.7, fontSize: '11px' }}>🗑 ล้างทั้งหมด</button>
            <button onClick={() => { setStage('idle'); setZones([]); setCountdown(0) }} style={{ ...s.yellowBtn, opacity:0.6 }}>ยกเลิก</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {zones.map((z, i) => (
              <span key={i} style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: '#E67E22', background: 'rgba(230,126,34,0.1)', border: '1px solid #E67E22', padding: '2px 8px' }}>
                ⚠ [{z.x},{z.y}]
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
function AnnouncementForm({ gameId, players, notify }: {
  gameId: string; players: Player[]
  notify: (t: string, ok?: boolean) => void
}) {
  const supabase = createClient()
  const [annType, setAnnType] = useState<'ทั่วไป'|'อาจารย์ผู้ควบคุม'|'ส่วนตัว'>('ทั่วไป')
  const [msg, setMsg] = useState('')
  const [targetId, setTargetId] = useState('')

  async function send() {
    if (!msg.trim()) return
    const res = await fetch('/api/admin/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game_id: gameId,
        ann_type: annType,
        message: msg.trim(),
        target_id: annType === 'ส่วนตัว' ? targetId || null : null,
      }),
    })
    const data = await res.json()
    if (!data.ok) { notify('❌ ' + data.error, false); return }
    notify('✅ ส่งประกาศแล้ว')
    setMsg('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '500px' }}>
      <div>
        <div style={s.miniLabel}>ประเภทประกาศ</div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['ทั่วไป','อาจารย์ผู้ควบคุม','ส่วนตัว'] as const).map(t => (
            <button key={t} onClick={() => setAnnType(t)} style={{
              padding: '6px 12px', border: '1px solid', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-body)',
              borderColor: annType === t ? 'var(--red-bright)' : 'var(--border)',
              color: annType === t ? 'var(--red-bright)' : 'var(--text-secondary)',
              background: annType === t ? 'rgba(139,0,0,0.1)' : 'var(--bg-tertiary)',
            }}>{t}</button>
          ))}
        </div>
      </div>

      {annType === 'ส่วนตัว' && (
        <div>
          <div style={s.miniLabel}>ส่งถึง</div>
          <select value={targetId} onChange={e => setTargetId(e.target.value)} style={s.input}>
            <option value="">-- เลือกผู้เล่น --</option>
            {players.map(p => (
              <option key={p.id} value={p.id}>#{String(p.student_number).padStart(2,'0')} {p.name}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <div style={s.miniLabel}>ข้อความ</div>
        <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={4}
          placeholder="พิมพ์ประกาศ..."
          style={{ ...s.input, width: '100%', resize: 'vertical' }} />
      </div>

      <button onClick={send} style={{ ...s.greenBtn, padding: '10px 20px', fontSize: '13px' }}>
        📢 ส่งประกาศ
      </button>
    </div>
  )
}

// ── MOODLE FORM ───────────────────────────────────────────────
function MoodleForm({ moodle, onSave, onCancel }: {
  moodle: MoodleDefinition | null
  onSave: (data: any) => void
  onCancel: () => void
}) {
  const [id, setId] = useState(moodle?.id ?? '')
  const [name, setName] = useState(moodle?.name ?? '')
  const [type, setType] = useState(moodle?.type ?? 'กาย')
  const [iconUrl, setIconUrl] = useState(moodle?.icon_url ?? '')
  const [borderColor, setBorderColor] = useState(moodle?.border_color ?? '#CC2222')
  const [maxLevel, setMaxLevel] = useState(moodle?.max_level ?? 1)
  const [cause, setCause] = useState(moodle?.cause ?? '')
  const [treatment, setTreatment] = useState(moodle?.treatment ?? '')
  const [isActive, setIsActive] = useState(moodle?.is_active ?? true)

  // level effects — แต่ละ level มี desc + ค่า effect ที่กรอกได้
  const initLevels = () => {
    const existing: any[] = moodle?.level_effects ?? []
    return Array.from({ length: moodle?.max_level ?? 1 }, (_, i) => {
      const found = existing.find((e: any) => e['ระดับ'] === i + 1)
      return {
        desc: found?.['คำอธิบาย'] ?? '',
        ap_cost_bonus: found?.['ผล']?.ap_cost_bonus ?? 0,
        thirst_rate_multiplier: found?.['ผล']?.thirst_rate_multiplier ?? 0,
        hunger_rate_multiplier: found?.['ผล']?.hunger_rate_multiplier ?? 0,
        hp_per_min: found?.['ผล']?.['พลังชีวิตต่อนาที'] ?? 0,
      }
    })
  }
  const [levels, setLevels] = useState<any[]>(initLevels)

  // sync levels array เมื่อ maxLevel เปลี่ยน
  function handleMaxLevelChange(n: number) {
    setMaxLevel(n)
    setLevels(prev => {
      const next = [...prev]
      while (next.length < n) next.push({ desc:'', ap_cost_bonus:0, thirst_rate_multiplier:0, hunger_rate_multiplier:0, hp_per_min:0 })
      return next.slice(0, n)
    })
  }

  function updateLevel(i: number, field: string, val: any) {
    setLevels(prev => prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l))
  }

  function buildLevelEffects() {
    return levels.map((l, i) => {
      const ผล: Record<string,any> = {}
      if (l.ap_cost_bonus > 0) ผล['ap_cost_bonus'] = l.ap_cost_bonus
      if (l.thirst_rate_multiplier > 0) ผล['thirst_rate_multiplier'] = l.thirst_rate_multiplier
      if (l.hunger_rate_multiplier > 0) ผล['hunger_rate_multiplier'] = l.hunger_rate_multiplier
      if (l.hp_per_min !== 0) ผล['พลังชีวิตต่อนาที'] = l.hp_per_min
      return { 'ระดับ': i + 1, 'ผล': ผล, 'คำอธิบาย': l.desc }
    })
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'12px' }}>
      {/* ── ข้อมูลพื้นฐาน ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
        <div>
          <div style={s.miniLabel}>ID (ภาษาไทย)</div>
          <input value={id} onChange={e => setId(e.target.value)} style={s.input} placeholder="เช่น ท้องเสีย" disabled={!!moodle} />
        </div>
        <div>
          <div style={s.miniLabel}>ชื่อแสดง</div>
          <input value={name} onChange={e => setName(e.target.value)} style={s.input} />
        </div>
        <div>
          <div style={s.miniLabel}>ประเภท</div>
          <select value={type} onChange={e => setType(e.target.value as any)} style={s.input}>
            {['กาย','จิตใจ','สังคม'].map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <div style={s.miniLabel}>จำนวน Level สูงสุด</div>
          <input type='number' min={1} max={5} value={maxLevel}
            onChange={e => handleMaxLevelChange(parseInt(e.target.value) || 1)} style={s.input} />
        </div>
        <div>
          <div style={s.miniLabel}>สี Border (hex)</div>
          <div style={{ display:'flex', gap:'6px', alignItems:'center' }}>
            <input value={borderColor} onChange={e => setBorderColor(e.target.value)} style={{ ...s.input, flex:1 }} />
            <input type='color' value={borderColor} onChange={e => setBorderColor(e.target.value)}
              style={{ width:'36px', height:'36px', border:'1px solid var(--border)', cursor:'pointer', padding:'2px' }} />
          </div>
        </div>
        <div>
          <div style={s.miniLabel}>Preview</div>
          <span style={{ padding:'4px 10px', border:`1px solid ${borderColor}`, color:borderColor, fontSize:'12px', background:'var(--bg-tertiary)', display:'inline-flex', alignItems:'center', gap:'5px' }}>
            {iconUrl && <img src={iconUrl} alt="" style={{ width:'14px', height:'14px', objectFit:'contain' }} />}
            {name || id || 'moodle'}
          </span>
        </div>
        <div style={{ gridColumn:'1/-1' }}>
          <div style={s.miniLabel}>URL ไอคอน (icons8.com แนะนำ)</div>
          <input value={iconUrl} onChange={e => setIconUrl(e.target.value)} style={s.input} placeholder="https://img.icons8.com/emoji/48/..." />
        </div>
        <div>
          <div style={s.miniLabel}>สาเหตุ</div>
          <input value={cause} onChange={e => setCause(e.target.value)} style={s.input} placeholder="เช่น กินเนื้อดิบ" />
        </div>
        <div>
          <div style={s.miniLabel}>วิธีรักษา</div>
          <input value={treatment} onChange={e => setTreatment(e.target.value)} style={s.input} placeholder="เช่น ยาท้องเสีย" />
        </div>
      </div>

      {/* ── Level Effects ── */}
      <div>
        <div style={s.miniLabel}>ผลแต่ละ Level</div>
        <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
          {levels.map((l, i) => (
            <div key={i} style={{ padding:'10px', background:'var(--bg-primary)', border:`1px solid ${borderColor}44`, display:'flex', flexDirection:'column', gap:'6px' }}>
              <div style={{ fontSize:'12px', color:borderColor, fontWeight:600 }}>Level {i + 1}</div>
              <div>
                <div style={s.miniLabel}>คำอธิบาย</div>
                <input value={l.desc} onChange={e => updateLevel(i, 'desc', e.target.value)} style={s.input} placeholder="เช่น AP ทุก action +5" />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px' }}>
                <div>
                  <div style={s.miniLabel}>AP cost เพิ่ม (ap_cost_bonus)</div>
                  <input type='number' min={0} value={l.ap_cost_bonus} onChange={e => updateLevel(i, 'ap_cost_bonus', parseInt(e.target.value)||0)} style={s.input} placeholder="0" />
                </div>
                <div>
                  <div style={s.miniLabel}>HP ต่อนาที (ลบ = เสียเลือด)</div>
                  <input type='number' value={l.hp_per_min} onChange={e => updateLevel(i, 'hp_per_min', parseInt(e.target.value)||0)} style={s.input} placeholder="0 หรือ -2" />
                </div>
                <div>
                  <div style={s.miniLabel}>thirst เร็วขึ้น x เท่า</div>
                  <input type='number' min={0} step={0.5} value={l.thirst_rate_multiplier} onChange={e => updateLevel(i, 'thirst_rate_multiplier', parseFloat(e.target.value)||0)} style={s.input} placeholder="0 = ไม่มีผล, 2 = 2x" />
                </div>
                <div>
                  <div style={s.miniLabel}>hunger เร็วขึ้น x เท่า</div>
                  <input type='number' min={0} step={0.5} value={l.hunger_rate_multiplier} onChange={e => updateLevel(i, 'hunger_rate_multiplier', parseFloat(e.target.value)||0)} style={s.input} placeholder="0 = ไม่มีผล, 2 = 2x" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'8px', background:'var(--bg-primary)', border:'1px solid var(--border)' }}>
        <input type='checkbox' id='moodle_active' checked={isActive} onChange={e => setIsActive(e.target.checked)} />
        <label htmlFor='moodle_active' style={{ fontSize:'12px', color:'var(--text-secondary)', cursor:'pointer' }}>เปิดใช้งาน</label>
      </div>

      <div style={{ display:'flex', gap:'8px' }}>
        <button onClick={() => {
          if (!id.trim()) return
          onSave({
            id: id.trim(), name: name.trim() || id.trim(),
            type, icon_url: iconUrl || null,
            border_color: borderColor,
            max_level: maxLevel,
            level_effects: buildLevelEffects(),
            cause: cause || null, treatment: treatment || null,
            is_active: isActive,
          })
        }} style={{ ...s.greenBtn, flex:1, padding:'10px' }}>💾 บันทึก</button>
        <button onClick={onCancel} style={{ ...s.yellowBtn, padding:'10px 16px' }}>ยกเลิก</button>
      </div>
    </div>
  )
}

// ── GRID SPAWN EDITOR ─────────────────────────────────────────
function GridSpawnEditor({ grid, items, onSave, onCancel }: {
  grid: any
  items: ItemDefinition[]
  onSave: (spawn: any[]) => void
  onCancel: () => void
}) {
  const [rows, setRows] = useState<{id:string, weight:number}[]>(() =>
    (grid.spawn_table ?? []).map((it: any) => ({
      id: it.id,
      weight: it['น้ำหนัก'] ?? it.weight ?? 1,
    }))
  )
  const [addSearch, setAddSearch] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)

  function updateWeight(idx: number, val: number) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, weight: val } : r))
  }

  function removeRow(idx: number) {
    setRows(prev => prev.filter((_, i) => i !== idx))
  }

  function addItem(itemId: string) {
    if (rows.find(r => r.id === itemId)) return
    setRows(prev => [...prev, { id: itemId, weight: 10 }])
    setAddSearch('')
    setShowSuggestions(false)
  }

  const totalWeight = rows.reduce((s, r) => s + r.weight, 0)

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
      {/* รายการ item ปัจจุบัน */}
      <div style={{ display:'flex', flexDirection:'column', gap:'4px', maxHeight:'300px', overflow:'auto' }}>
        {rows.length === 0 && <div style={{ fontSize:'12px', color:'var(--text-secondary)', padding:'8px' }}>ยังไม่มี item</div>}
        {rows.map((r, i) => {
          const def = items.find(it => it.id === r.id)
          const pct = totalWeight > 0 ? ((r.weight / totalWeight) * 100).toFixed(1) : '0'
          return (
            <div key={r.id} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'6px 8px', background:'var(--bg-primary)', border:'1px solid var(--border)' }}>
              {def?.photo_url ? (
                <img src={def.photo_url} alt="" style={{ width:'22px', height:'22px', objectFit:'cover', borderRadius:'2px', flexShrink:0 }} />
              ) : (
                <div style={{ width:'22px', height:'22px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'2px', flexShrink:0, fontSize:'11px', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {def?.category === 'อาวุธ' ? '⚔' : def?.category === 'ยา' ? '💊' : '📦'}
                </div>
              )}
              <span style={{ flex:1, fontSize:'12px' }}>{r.id}</span>
              <span style={{ fontSize:'10px', color:'var(--text-secondary)', minWidth:'40px', textAlign:'right' }}>{pct}%</span>
              <div style={{ display:'flex', alignItems:'center', gap:'4px' }}>
                <span style={{ fontSize:'10px', color:'var(--text-secondary)' }}>น้ำหนัก:</span>
                <input
                  type='number' min={1} max={999} value={r.weight}
                  onChange={e => updateWeight(i, parseInt(e.target.value) || 1)}
                  style={{ ...s.smallInput, width:'52px', textAlign:'center' }}
                />
              </div>
              <button onClick={() => removeRow(i)} style={{ ...s.redBtn, fontSize:'11px', padding:'2px 8px' }}>✕</button>
            </div>
          )
        })}
      </div>

      {/* เพิ่ม item */}
      <div style={{ position:'relative' }}>
        <div style={s.miniLabel}>เพิ่มไอเทม</div>
        <input
          value={addSearch}
          onChange={e => { setAddSearch(e.target.value); setShowSuggestions(true) }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder='พิมพ์ชื่อไอเทม...'
          style={s.input}
        />
        {showSuggestions && addSearch.length > 0 && (() => {
          const filtered = items
            .filter(it => !rows.find(r => r.id === it.id))
            .filter(it => it.name.toLowerCase().includes(addSearch.toLowerCase()) || it.id.toLowerCase().includes(addSearch.toLowerCase()))
            .slice(0, 8)
          if (filtered.length === 0) return null
          return (
            <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:100, background:'var(--bg-secondary)', border:'1px solid var(--border)', maxHeight:'200px', overflow:'auto' }}>
              {filtered.map(it => (
                <div key={it.id} onMouseDown={() => addItem(it.id)} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'6px 10px', cursor:'pointer', borderBottom:'1px solid var(--border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {it.photo_url && <img src={it.photo_url} alt="" style={{ width:'20px', height:'20px', objectFit:'cover', borderRadius:'2px' }} />}
                  <div>
                    <div style={{ fontSize:'12px' }}>{it.name}</div>
                    <div style={{ fontSize:'10px', color:'var(--text-secondary)' }}>{it.category}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        })()}
      </div>

      {/* สรุป */}
      {rows.length > 0 && (
        <div style={{ fontSize:'11px', color:'var(--text-secondary)', padding:'6px 8px', background:'var(--bg-primary)', border:'1px solid var(--border)' }}>
          รวม {rows.length} item · น้ำหนักรวม {totalWeight}
        </div>
      )}

      <div style={{ display:'flex', gap:'8px' }}>
        <button onClick={() => onSave(rows.map(r => ({ id: r.id, 'น้ำหนัก': r.weight })))}
          style={{ ...s.greenBtn, flex:1, padding:'10px' }}>💾 บันทึก</button>
        <button onClick={onCancel} style={{ ...s.yellowBtn, padding:'10px 16px' }}>ยกเลิก</button>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column' },
  header: { height: '48px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--red-blood)', display: 'flex', alignItems: 'center', gap: '12px', padding: '0 16px', flexShrink: 0 },
  title: { fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700, color: 'var(--red-bright)', letterSpacing: '0.1em' },
  backBtn: { background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '5px 12px', fontSize: '12px', cursor: 'pointer' },
  tabBar: { display: 'flex', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  tabBtn: { padding: '10px 16px', background: 'none', border: 'none', fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-body)' },
  body: { flex: 1, overflow: 'auto', padding: '16px' },
  section: { maxWidth: '800px' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  card: { background: 'var(--bg-secondary)', border: '1px solid var(--border)', padding: '12px', marginBottom: '6px' },
  cardRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  empty: { color: 'var(--text-secondary)', fontSize: '13px', padding: '20px', textAlign: 'center', border: '1px dashed var(--border)' },
  miniLabel: { fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' },
  input: { padding: '8px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'var(--font-body)', width: '100%' },
  smallInput: { padding: '5px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'var(--font-body)' },
  addBtn: { padding: '6px 14px', background: 'var(--green-safe)', border: '1px solid var(--green-bright)', color: 'var(--text-primary)', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-body)' },
  greenBtn: { padding: '5px 12px', background: 'rgba(45,90,39,0.3)', border: '1px solid var(--green-bright)', color: 'var(--green-bright)', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-body)' },
  redBtn: { padding: '5px 12px', background: 'rgba(139,0,0,0.3)', border: '1px solid var(--red-bright)', color: 'var(--red-bright)', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-body)' },
  yellowBtn: { padding: '5px 12px', background: 'rgba(184,134,11,0.2)', border: '1px solid var(--text-gold)', color: 'var(--text-gold)', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-body)' },
}