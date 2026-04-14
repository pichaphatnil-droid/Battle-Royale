'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import type { TraitDefinition, TraitType } from '@/lib/supabase/types'

const STATS = ['str','agi','int','per','cha','end_stat','stl','lck'] as const
type Stat = typeof STATS[number]

const STAT_LABEL: Record<Stat, string> = {
  str: 'แข็งแกร่ง', agi: 'คล่องแคล่ว', int: 'ฉลาด',
  per: 'รับรู้', cha: 'เสน่ห์', end_stat: 'อดทน', stl: 'พรางตัว', lck: 'โชค',
}

const TOTAL_STAT = 45
const TOTAL_TRAIT_POINTS = 5
const MIN_STAT = 1
const MAX_STAT = 8

// ใช้ bonus_points จาก DB แทน hardcode
// helper เรียกใช้ใน component

const BACKGROUNDS: Array<{
  id: string; name: string; desc: string
  startTraits: string[]
  bonus: Partial<Record<Stat, number>>
}> = [
  { id:'นักกีฬา',       name:'นักกีฬา',         desc:'เล่นกีฬามาตลอด ร่างกายดี ขาแข็งแรง',          startTraits:['น่องเหล็ก','แข็งแรง'],          bonus:{ str:1, end_stat:1 } },
  { id:'อันธพาล',       name:'อันธพาล',         desc:'ชีวิตช่วงมัธยมฯ ไม่ค่อยสงบ ต่อยเก่งเป็นพิเศษ', startTraits:['บ้าระห่ำ','สายซุ่ม'],           bonus:{ str:2 } },
  { id:'นักเรียนตัวอย่าง',   name:'นักเรียนตัวอย่าง',     desc:'เป็นผู้นำตั้งแต่เด็ก ทุกคนเชื่อฟัง',          startTraits:['พหูสูต','หยั่งรู้'],            bonus:{ cha:1, per:1 } },
  { id:'เด็กห้องสมุด',  name:'เด็กห้องสมุด',    desc:'อ่านหนังสือทุกวัน ความรู้ท่วมหัวอาจเอาตัวไม่รอด',        startTraits:['เรียนเก่ง','อัจฉริยะจอมขี้เกียจ'], bonus:{ int:2 } },
  { id:'นักเรียนพยาบาล',name:'นักเรียนพยาบาล',  desc:'เรียนมาทางสายสุขภาพ รู้จักยาทุกชนิด',          startTraits:['ผู้รักษา','ช่างฝีมือ'],          bonus:{ int:1, end_stat:1 } },
  { id:'ดาวโรงเรียน',   name:'ดาวโรงเรียน',     desc:'เป็นที่รู้จักทั่วโรงเรียน ใคร ๆ ก็ชอบ',        startTraits:['ดาวโรงเรียน','นักเจรจา'],        bonus:{ cha:2 } },
  { id:'โอตาคุ',        name:'โอตาคุ',          desc:'ดูอนิเมะมาเยอะ รู้กลยุทธ์การซุ่มโจมตีดี',      startTraits:['นกฮูกกลางคืน','สายซุ่ม'],        bonus:{ stl:2 } },
  { id:'สายมู',     name:'สายมู',       desc:'ดวงดีสุดในห้อง สอบตกก็ยังรอดได้ทุกครั้ง',    startTraits:['โชคช่วย','ใช้มือเก่ง'],          bonus:{ lck:2 } },
  { id:'นักเรียนแลกเปลี่ยน', name:'นักเรียนแลกเปลี่ยน', desc:'ผ่านโลกมามาก อ่านคนออก สื่อสารเก่ง', startTraits:['พี่เลี้ยง','สายตาเหยี่ยว'],      bonus:{ cha:1, per:1 } },
  { id:'ลูกเสือ',       name:'ลูกเสือ',         desc:'เข้าค่ายมาเยอะ ทนทาน แบกของไหวแน่นอน',            startTraits:['บ้าหอบฟาง','ว่ายน้ำเก่ง'],        bonus:{ str:1, end_stat:1 } },
]

const TYPE_LABEL: Record<TraitType, string> = {
  'กาย':'⚔ กาย', 'จิตใจและสังคม':'🧠 จิตใจ', 'ทักษะ':'🔧 ทักษะ', 'ลบ':'💀 นิสัยเสีย',
}

interface Props {
  gameId: string; userId: string
  availableMaleNumbers: number[]
  availableFemaleNumbers: number[]
  traits: TraitDefinition[]
  weapons: any[]
  startPos: { x: number; y: number }
}

export default function CreateCharacterClient({ gameId, userId, availableMaleNumbers, availableFemaleNumbers, traits, weapons, startPos }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [step, setStep] = useState<1|2|3|4>(1)

  // Step 1
  const [name, setName] = useState('')
  const [gender, setGender] = useState<'ชาย'|'หญิง'>('ชาย')
  const availableNumbers = gender === 'ชาย' ? availableMaleNumbers : availableFemaleNumbers
  const [studentNum, setStudentNum] = useState(availableMaleNumbers[0] ?? 1)
  const [photoUrl, setPhotoUrl] = useState('')
  const [photoPreview, setPhotoPreview] = useState('')
  const [bg, setBg] = useState(BACKGROUNDS[0])

  // Step 2: Traits
  const [selectedTraits, setSelectedTraits] = useState<string[]>([])

  // Step 3: Stats
  const [stats, setStats] = useState<Record<Stat, number>>(
    Object.fromEntries(STATS.map(s => [s, MIN_STAT])) as Record<Stat, number>
  )

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string|null>(null)

  // คำนวณแต้มนิสัย — บวกใช้แต้ม 2, ลบคืนแต้มตาม bonus_points
  const getTraitCost = (id: string) => {
    const def = traits.find(t => t.id === id)
    if (!def) return 0
    return def.type === 'ลบ' ? 0 : 2
  }
  const getTraitRefund = (id: string) => {
    const def = traits.find(t => t.id === id)
    if (!def || def.type !== 'ลบ') return 0
    return def.bonus_points ?? 2
  }
  const traitPointsUsed = selectedTraits.reduce((acc, id) => {
    return acc + getTraitCost(id) - getTraitRefund(id)
  }, 0)
  const traitPointsLeft = TOTAL_TRAIT_POINTS - traitPointsUsed

  // คำนวณแต้มสถานะ
  const statPointsUsed = Object.values(stats).reduce((a, b) => a + b, 0)
  const statPointsLeft = TOTAL_STAT - statPointsUsed

  function setStat(s: Stat, val: number) {
    const clamped = Math.max(MIN_STAT, Math.min(MAX_STAT, val))
    const newStats = { ...stats, [s]: clamped }
    if (Object.values(newStats).reduce((a, b) => a + b, 0) > TOTAL_STAT) return
    setStats(newStats)
  }

  const handlePhoto = useCallback((url: string) => {
    setPhotoUrl(url); setPhotoPreview(url)
  }, [])

  function toggleTrait(id: string) {
    if (bg.startTraits.includes(id)) return
    const def = traits.find(t => t.id === id)
    const isNeg = def?.type === 'ลบ'
    const isSelected = selectedTraits.includes(id)
    if (isSelected) { setSelectedTraits(prev => prev.filter(x => x !== id)); return }
    if (!isNeg && traitPointsLeft < 2) return
    setSelectedTraits(prev => [...prev, id])
  }

  const allTraits = [...new Set([...bg.startTraits, ...selectedTraits])]

  // ── ไอเทมเริ่มต้น — สุ่มอาวุธไม่ซ้ำกัน ──────────────────────
  function getStarterItems(): Array<{id:string,qty:number}> {
    const base = [
      { id: 'ขวดน้ำ', qty: 2 },
      { id: 'อาหารกระป๋อง', qty: 2 },
      { id: 'ผ้าพันแผล', qty: 1 },
    ]
    if (weapons.length === 0) return base

    // สุ่มอาวุธ 1 ชิ้นจากทั้งหมด
    const shuffled = [...weapons].sort(() => Math.random() - 0.5)
    const picked = shuffled[0]
    return [...base, { id: picked.id, qty: 1 }]
  }

  async function submit() {
    setLoading(true); setError(null)
    const bonusStats = bg.bonus
    const { error: err } = await supabase.from('players').insert({
      game_id: gameId, user_id: userId,
      name: name.trim(), student_number: studentNum, gender,
      photo_url: photoUrl || null,
      max_hp: 50 + (stats.end_stat + (bonusStats.end_stat ?? 0)) * 5,
      hp:     50 + (stats.end_stat + (bonusStats.end_stat ?? 0)) * 5,
      str:      stats.str      + (bonusStats.str      ?? 0),
      agi:      stats.agi      + (bonusStats.agi      ?? 0),
      int:      stats.int      + (bonusStats.int      ?? 0),
      per:      stats.per      + (bonusStats.per      ?? 0),
      cha:      stats.cha      + (bonusStats.cha      ?? 0),
      end_stat: stats.end_stat + (bonusStats.end_stat ?? 0),
      stl:      stats.stl      + (bonusStats.stl      ?? 0),
      lck:      stats.lck      + (bonusStats.lck      ?? 0),
      traits: allTraits, inventory: getStarterItems(), moodles: [], known_recipes: [],
      pos_x: startPos.x, pos_y: startPos.y,
    })
    if (err) {
      setError(err.message.includes('unique') ? 'หมายเลขนักเรียนนี้ถูกใช้ไปแล้ว' : 'เกิดข้อผิดพลาด: ' + err.message)
      setLoading(false); return
    }
    router.push('/lobby')
  }

  const traitGroups = (['กาย','จิตใจและสังคม','ทักษะ','ลบ'] as TraitType[]).map(type => ({
    type, list: traits.filter(t => t.type === type && !bg.startTraits.includes(t.id)),
  }))

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Image src="https://iili.io/BfyEfSI.png" alt="" width={24} height={24}
          style={{ filter:'drop-shadow(0 0 6px rgba(139,0,0,0.7))' }} unoptimized />
        <span style={s.headerTitle}>สร้างตัวละคร</span>
        <div style={{ display:'flex', gap:'6px' }}>
          {[1,2,3,4].map(n => (
            <div key={n} style={{ width:'8px', height:'8px', borderRadius:'50%', transition:'background 0.2s',
              background: n <= step ? 'var(--red-bright)' : 'var(--border)' }} />
          ))}
        </div>
      </div>

      <div style={s.body}>

        {/* STEP 1 */}
        {step === 1 && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>ข้อมูลพื้นฐาน</h2>

            <div style={s.field}>
              <label style={s.label}>URL รูปภาพ (ไม่บังคับ)</label>
              <div style={{ display:'flex', gap:'8px' }}>
                <input type="url" value={photoUrl} onChange={e => handlePhoto(e.target.value)}
                  placeholder="https://..." style={{ ...s.input, flex:1 }} />
                <div style={s.avatarBox}>
                  {photoPreview ? (
                    <Image src={photoPreview} alt="" width={48} height={48}
                      style={{ borderRadius:'50%', objectFit:'cover', width:'100%', height:'100%' }}
                      onError={() => setPhotoPreview('')} unoptimized />
                  ) : <span style={{ color:'var(--border-bright)', fontSize:'20px' }}>?</span>}
                </div>
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>ชื่อตัวละคร <span style={{ color:'var(--red-bright)' }}>*</span></label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="ชื่อ 2–20 ตัวอักษร" maxLength={20} style={s.input} />
              <span style={{ fontSize:'10px', color:'var(--border-bright)' }}>{name.length}/20</span>
            </div>

            <div style={s.field}>
              <label style={s.label}>เพศ</label>
              <div style={{ display:'flex', gap:'8px' }}>
                {(['ชาย','หญิง'] as const).map(g => (
                  <button key={g} onClick={() => {
                      setGender(g)
                      const nums = g === 'ชาย' ? availableMaleNumbers : availableFemaleNumbers
                      setStudentNum(nums[0] ?? 1)
                    }} style={{
                    ...s.toggleBtn,
                    borderColor: gender===g ? 'var(--red-bright)' : 'var(--border)',
                    color: gender===g ? 'var(--red-bright)' : 'var(--text-secondary)',
                    background: gender===g ? 'rgba(139,0,0,0.1)' : 'var(--bg-tertiary)',
                  }}>{g==='ชาย' ? '♂ ชาย' : '♀ หญิง'}</button>
                ))}
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>หมายเลขนักเรียน</label>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(10,1fr)', gap:'4px' }}>
                {availableNumbers.map(n => (
                  <button key={n} onClick={() => setStudentNum(n)} style={{
                    padding:'6px 4px', border:'1px solid', fontSize:'11px', cursor:'pointer',
                    fontFamily:'var(--font-mono)', textAlign:'center',
                    borderColor: studentNum===n ? 'var(--red-bright)' : 'var(--border)',
                    color: studentNum===n ? 'var(--red-bright)' : 'var(--text-secondary)',
                    background: studentNum===n ? 'rgba(139,0,0,0.1)' : 'var(--bg-tertiary)',
                  }}>{String(n).padStart(2,'0')}</button>
                ))}
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>ภูมิหลัง</label>
              <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
                {BACKGROUNDS.map(b => (
                  <button key={b.id} onClick={() => { setBg(b); setSelectedTraits([]) }} style={{
                    width:'100%', padding:'10px 12px', border:'1px solid', cursor:'pointer',
                    textAlign:'left', fontFamily:'var(--font-body)',
                    borderColor: bg.id===b.id ? 'var(--red-bright)' : 'var(--border)',
                    background: bg.id===b.id ? 'rgba(139,0,0,0.08)' : 'var(--bg-tertiary)',
                  }}>
                    <div style={{ display:'flex', justifyContent:'space-between' }}>
                      <span style={{ fontSize:'13px', fontWeight:600,
                        color: bg.id===b.id ? 'var(--red-bright)' : 'var(--text-primary)' }}>{b.name}</span>
                      <span style={{ fontSize:'10px', color:'var(--text-gold)', fontFamily:'var(--font-mono)' }}>
                        {Object.entries(b.bonus).map(([k,v]) => `${STAT_LABEL[k as Stat]}+${v}`).join(' ')}
                      </span>
                    </div>
                    <div style={{ fontSize:'11px', color:'var(--text-secondary)', marginTop:'2px' }}>{b.desc}</div>
                    <div style={{ display:'flex', gap:'4px', marginTop:'6px', flexWrap:'wrap' }}>
                      {b.startTraits.map(t => <span key={t} style={s.chip}>{t}</span>)}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <button onClick={() => setStep(2)} disabled={name.trim().length < 2} style={{ ...s.nextBtn, opacity: name.trim().length >= 2 ? 1 : 0.4 }}>
              ถัดไป — เลือกนิสัย →
            </button>
          </div>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>เลือกนิสัย</h2>

            <div style={s.pointBox}>
              <span style={{ color:'var(--text-secondary)', fontSize:'12px' }}>แต้มนิสัยที่เหลือ</span>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:'32px', fontWeight:700,
                color: traitPointsLeft < 0 ? 'var(--red-danger)' : traitPointsLeft===0 ? 'var(--text-gold)' : 'var(--text-primary)' }}>
                {traitPointsLeft}
              </span>
              <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>
                เริ่มต้น {TOTAL_TRAIT_POINTS} แต้ม — นิสัยดีใช้แต้ม / นิสัยเสียคืนแต้ม
              </span>
            </div>

            <div>
              <div style={s.groupLabel}>นิสัยจากภูมิหลัง (ฟรี)</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'4px' }}>
                {bg.startTraits.map(id => (
                  <span key={id} style={{ ...s.chip, borderColor:'var(--text-gold)', color:'var(--text-gold)' }}>{id}</span>
                ))}
              </div>
            </div>

            {traitGroups.map(group => (
              <div key={group.type}>
                <div style={s.groupLabel}>{TYPE_LABEL[group.type]}</div>
                <div style={{ display:'flex', flexDirection:'column', gap:'4px' }}>
                  {group.list.map(trait => {
                    const isNeg = trait.type === 'ลบ'
                    const isSelected = selectedTraits.includes(trait.id)
                    const cost = isNeg ? (trait.bonus_points ?? 2) : 2
                    const canAfford = isNeg || isSelected || traitPointsLeft >= 2
                    return (
                      <button key={trait.id} onClick={() => toggleTrait(trait.id)} style={{
                        width:'100%', padding:'8px 10px', border:'1px solid', textAlign:'left',
                        fontFamily:'var(--font-body)', transition:'all 0.15s',
                        opacity: !canAfford ? 0.35 : 1,
                        cursor: !canAfford ? 'not-allowed' : 'pointer',
                        borderColor: isSelected ? (isNeg ? 'var(--red-bright)' : 'var(--green-bright)') : 'var(--border)',
                        background: isSelected ? (isNeg ? 'rgba(204,34,34,0.08)' : 'rgba(45,90,39,0.1)') : 'var(--bg-tertiary)',
                      }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:'8px' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:'8px', flex:1, minWidth:0 }}>
                            {trait.icon_url && (
                              <img src={trait.icon_url} alt="" style={{ width:'24px', height:'24px', objectFit:'contain', flexShrink:0, imageRendering:'pixelated' }} />
                            )}
                            <span style={{ fontSize:'13px', fontWeight: isSelected ? 600 : 400,
                              color: isSelected ? (isNeg ? 'var(--red-bright)' : 'var(--green-bright)') : 'var(--text-primary)' }}>
                              {trait.name}
                            </span>
                          </div>
                          <span style={{ fontSize:'11px', fontFamily:'var(--font-mono)', flexShrink:0,
                            color: isNeg ? 'var(--red-bright)' : 'var(--text-gold)' }}>
                            {isNeg ? `+${cost} แต้ม` : `${cost} แต้ม`}
                          </span>
                        </div>
                        <div style={{ fontSize:'11px', color:'var(--text-secondary)', marginTop:'2px', textAlign:'left' }}>
                          {trait.description}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}

            <div style={{ display:'flex', gap:'8px' }}>
              <button onClick={() => setStep(1)} style={s.backBtn}>← กลับ</button>
              <button onClick={() => setStep(3)} disabled={traitPointsLeft < 0}
                style={{ ...s.nextBtn, flex:1, opacity: traitPointsLeft >= 0 ? 1 : 0.4 }}>
                ถัดไป — แจกแต้มสถานะ →
              </button>
            </div>
          </div>
        )}

        {/* STEP 3 */}
        {step === 3 && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>แจกแต้มสถานะ</h2>

            <div style={s.pointBox}>
              <span style={{ color:'var(--text-secondary)', fontSize:'12px' }}>แต้มที่เหลือ</span>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:'32px', fontWeight:700,
                color: statPointsLeft < 0 ? 'var(--red-danger)' : statPointsLeft===0 ? 'var(--green-bright)' : 'var(--text-primary)' }}>
                {statPointsLeft}
              </span>
            </div>

            <div style={{ display:'flex', flexDirection:'column', gap:'4px', padding:'10px', background:'var(--bg-primary)', border:'1px solid var(--border)', fontSize:'11px', color:'var(--text-secondary)', lineHeight:'1.7' }}>
              <div>⚔ <b style={{ color:'var(--text-primary)' }}>STR (แข็งแกร่ง)</b> — เพิ่มความเสียหายโจมตีระยะประชิด และน้ำหนักที่แบกได้</div>
              <div>🏃 <b style={{ color:'var(--text-primary)' }}>AGI (คล่องแคล่ว)</b> — เพิ่มโอกาสหลบการโจมตี</div>
              <div>🧠 <b style={{ color:'var(--text-primary)' }}>INT (ฉลาด)</b> — ปลดล็อกสูตรคราฟต์ที่ซับซ้อน และเพิ่มประสิทธิภาพของยา</div>
              <div>👁 <b style={{ color:'var(--text-primary)' }}>PER (รับรู้)</b> — เพิ่มระยะมองเห็นบนแผนที่ และความเสียหายโจมตีระยะไกล</div>
              <div>💬 <b style={{ color:'var(--text-primary)' }}>CHA (เสน่ห์)</b> — เพิ่มโอกาสหลบเล็กน้อย เพราะอ่านจังหวะคนออก และใช้ในระบบพันธมิตร</div>
              <div>❤ <b style={{ color:'var(--text-primary)' }}>END (อดทน)</b> — เพิ่ม HP สูงสุด +5 ต่อ 1 แต้ม และลดความเสียหายที่รับ</div>
              <div>🌑 <b style={{ color:'var(--text-primary)' }}>STL (พรางตัว)</b> — เพิ่มโอกาสหลบการโจมตี และทำให้ศัตรูตรวจจับได้ยากขึ้น</div>
              <div>🍀 <b style={{ color:'var(--text-primary)' }}>LCK (โชค)</b> — เพิ่มโอกาสโจมตีคริติคอล (คูณความเสียหาย ×2)</div>
            </div>

            <div style={{ display:'flex', flexDirection:'column', gap:'8px', marginBottom:'16px' }}>
              {STATS.map(stat => {
                const base = stats[stat]
                const bonus = bg.bonus[stat] ?? 0
                const total = base + bonus
                return (
                  <div key={stat} style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                    <span style={{ fontSize:'11px', color:'var(--text-secondary)', width:'72px', flexShrink:0 }}>
                      {STAT_LABEL[stat]}
                    </span>
                    <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                      <button onClick={() => setStat(stat, base-1)} style={s.statBtn}>−</button>
                      <span style={{ fontFamily:'var(--font-mono)', fontSize:'16px', fontWeight:700,
                        minWidth:'28px', textAlign:'center' }}>{total}</span>
                      <button onClick={() => setStat(stat, base+1)} style={s.statBtn}>+</button>
                    </div>
                    <div style={{ flex:1, height:'4px', background:'var(--bg-primary)', border:'1px solid var(--border)', marginLeft:'8px' }}>
                      <div style={{ height:'100%', background:'var(--red-bright)', width:`${total*10}%`, transition:'width 0.2s' }} />
                    </div>
                    {bonus > 0 && (
                      <span style={{ fontSize:'10px', color:'var(--text-gold)', fontFamily:'var(--font-mono)', marginLeft:'6px' }}>+{bonus}</span>
                    )}
                  </div>
                )
              })}
            </div>

            <div style={{ display:'flex', gap:'8px' }}>
              <button onClick={() => setStep(2)} style={s.backBtn}>← กลับ</button>
              <button onClick={() => setStep(4)} disabled={statPointsLeft < 0}
                style={{ ...s.nextBtn, flex:1, opacity: statPointsLeft >= 0 ? 1 : 0.4 }}>
                ถัดไป — ยืนยัน →
              </button>
            </div>
          </div>
        )}

        {/* STEP 4 */}
        {step === 4 && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>ยืนยันตัวละคร</h2>

            <div style={{ display:'flex', alignItems:'center', gap:'16px', marginBottom:'20px' }}>
              <div style={{ width:'64px', height:'64px', borderRadius:'50%', overflow:'hidden',
                border:'2px solid var(--red-blood)', flexShrink:0, background:'var(--bg-tertiary)',
                display:'flex', alignItems:'center', justifyContent:'center' }}>
                {photoPreview ? (
                  <Image src={photoPreview} alt="" width={64} height={64} style={{ objectFit:'cover' }} unoptimized />
                ) : (
                  <span style={{ fontFamily:'var(--font-display)', fontSize:'24px', color:'var(--red-bright)' }}>
                    {name.charAt(0)}
                  </span>
                )}
              </div>
              <div>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:'11px', color:'var(--text-secondary)' }}>
                  นักเรียน #{String(studentNum).padStart(2,'0')} — {gender}
                </div>
                <div style={{ fontSize:'20px', fontWeight:700 }}>{name}</div>
                <div style={{ fontSize:'11px', color:'var(--text-gold)', marginTop:'2px' }}>{bg.name}</div>
              </div>
            </div>

            <div style={s.groupLabel}>ค่าสถานะ</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px', marginBottom:'16px' }}>
              {STATS.map(stat => (
                <div key={stat} style={{ display:'flex', justifyContent:'space-between', padding:'4px 8px',
                  background:'var(--bg-tertiary)', border:'1px solid var(--border)' }}>
                  <span style={{ fontSize:'11px', color:'var(--text-secondary)' }}>{STAT_LABEL[stat]}</span>
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:'13px', fontWeight:700 }}>
                    {stats[stat] + (bg.bonus[stat] ?? 0)}
                  </span>
                </div>
              ))}
            </div>

            <div style={s.groupLabel}>นิสัยทั้งหมด</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'4px', marginBottom:'20px' }}>
              {allTraits.map(id => (
                <span key={id} style={{ ...s.chip,
                  borderColor: traits.find(t=>t.id===id)?.type === 'ลบ' ? 'var(--red-bright)' : 'var(--border-bright)',
                  color: traits.find(t=>t.id===id)?.type === 'ลบ' ? 'var(--red-bright)' : 'var(--text-primary)' }}>{id}</span>
              ))}
            </div>

            {error && (
              <div style={{ padding:'10px 12px', background:'rgba(139,0,0,0.1)', borderLeft:'3px solid var(--red-blood)',
                border:'1px solid var(--red-blood)', color:'var(--red-bright)', fontSize:'12px', marginBottom:'12px' }}>
                ⚠ {error}
              </div>
            )}

            <div style={{ display:'flex', gap:'8px' }}>
              <button onClick={() => setStep(3)} style={s.backBtn}>← กลับ</button>
              <button onClick={submit} disabled={loading}
                style={{ ...s.nextBtn, flex:1, opacity: loading ? 0.6 : 1 }}>
                {loading ? 'กำลังสร้าง...' : '✓ ยืนยันสร้างตัวละคร'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { minHeight:'100vh', background:'var(--bg-primary)', display:'flex', flexDirection:'column' },
  header: { display:'flex', alignItems:'center', gap:'10px', padding:'0 16px', height:'48px',
    background:'var(--bg-secondary)', borderBottom:'1px solid var(--red-blood)', flexShrink:0 },
  headerTitle: { fontFamily:'var(--font-display)', fontSize:'15px', fontWeight:700, color:'var(--red-bright)', letterSpacing:'0.1em', flex:1 },
  body: { flex:1, maxWidth:'520px', width:'100%', margin:'0 auto', padding:'24px 16px' },
  card: { background:'var(--bg-secondary)', border:'1px solid var(--border)', padding:'24px', display:'flex', flexDirection:'column', gap:'16px' },
  cardTitle: { fontFamily:'var(--font-display)', fontSize:'18px', fontWeight:700, color:'var(--text-primary)', borderBottom:'1px solid var(--border)', paddingBottom:'12px' },
  field: { display:'flex', flexDirection:'column', gap:'6px' },
  label: { fontSize:'11px', color:'var(--text-secondary)', letterSpacing:'0.1em', textTransform:'uppercase' },
  input: { padding:'10px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'14px', fontFamily:'var(--font-body)', width:'100%' },
  avatarBox: { width:'48px', height:'48px', borderRadius:'50%', border:'1px solid var(--border)', flexShrink:0, background:'var(--bg-tertiary)', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' },
  toggleBtn: { flex:1, padding:'10px', border:'1px solid', fontSize:'14px', cursor:'pointer', fontFamily:'var(--font-body)' },
  chip: { padding:'2px 8px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', fontSize:'11px', color:'var(--text-secondary)' },
  pointBox: { display:'flex', flexDirection:'column', alignItems:'center', padding:'16px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', gap:'4px' },
  groupLabel: { fontSize:'10px', letterSpacing:'0.12em', color:'var(--text-secondary)', textTransform:'uppercase', borderBottom:'1px solid var(--border)', paddingBottom:'6px', marginBottom:'8px' },
  statBtn: { width:'28px', height:'28px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', color:'var(--text-primary)', fontSize:'16px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' },
  nextBtn: { padding:'12px', background:'var(--red-blood)', border:'1px solid var(--red-bright)', color:'var(--text-primary)', fontFamily:'var(--font-body)', fontSize:'14px', fontWeight:600, cursor:'pointer' },
  backBtn: { padding:'12px 16px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', color:'var(--text-secondary)', fontFamily:'var(--font-body)', fontSize:'13px', cursor:'pointer' },
}