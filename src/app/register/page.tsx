'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'

export default function RegisterPage() {
  const router = useRouter()
  const supabase = createClient()

  const [อีเมล, setอีเมล] = useState('')
  const [รหัสผ่าน, setรหัสผ่าน] = useState('')
  const [ยืนยันรหัสผ่าน, setยืนยันรหัสผ่าน] = useState('')
  const [กำลังโหลด, setกำลังโหลด] = useState(false)
  const [ข้อผิดพลาด, setข้อผิดพลาด] = useState<string | null>(null)
  const [สำเร็จ, setSำเร็จ] = useState(false)

  async function สมัครสมาชิก(e: React.FormEvent) {
    e.preventDefault()
    setข้อผิดพลาด(null)

    if (รหัสผ่าน !== ยืนยันรหัสผ่าน) {
      setข้อผิดพลาด('รหัสผ่านไม่ตรงกัน')
      return
    }

    if (รหัสผ่าน.length < 6) {
      setข้อผิดพลาด('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร')
      return
    }

    setกำลังโหลด(true)

    const { error } = await supabase.auth.signUp({
      email: อีเมล,
      password: รหัสผ่าน,
    })

    if (error) {
      if (error.message.includes('already registered')) {
        setข้อผิดพลาด('อีเมลนี้มีบัญชีอยู่แล้ว')
      } else {
        setข้อผิดพลาด('เกิดข้อผิดพลาด กรุณาลองใหม่')
      }
      setกำลังโหลด(false)
      return
    }

    setSำเร็จ(true)
    setกำลังโหลด(false)

    // redirect หลัง 2 วินาที
    setTimeout(() => router.push('/login'), 2000)
  }

  if (สำเร็จ) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '40px', marginBottom: '16px' }}>✓</div>
            <h2 style={{ ...styles.title, fontSize: '18px', marginBottom: '8px' }}>
              สมัครสมาชิกสำเร็จ
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
              กำลังพาไปหน้าเข้าสู่ระบบ...
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {/* Logo + Title */}
        <div style={styles.header}>
          <Image
            src="https://iili.io/BfyEfSI.png"
            alt="โปรแกรม"
            width={48}
            height={48}
            style={styles.logo}
            unoptimized
          />
          <h1 style={styles.title}>โปรแกรม</h1>
          <p style={styles.subtitle}>สร้างบัญชีเพื่อเข้าร่วมเกม</p>
        </div>

        <form onSubmit={สมัครสมาชิก} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>อีเมล</label>
            <input
              type="email"
              value={อีเมล}
              onChange={e => setอีเมล(e.target.value)}
              placeholder="your@email.com"
              required
              autoComplete="email"
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>รหัสผ่าน</label>
            <input
              type="password"
              value={รหัสผ่าน}
              onChange={e => setรหัสผ่าน(e.target.value)}
              placeholder="อย่างน้อย 6 ตัวอักษร"
              required
              autoComplete="new-password"
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>ยืนยันรหัสผ่าน</label>
            <input
              type="password"
              value={ยืนยันรหัสผ่าน}
              onChange={e => setยืนยันรหัสผ่าน(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="new-password"
              style={{
                ...styles.input,
                borderColor: ยืนยันรหัสผ่าน && ยืนยันรหัสผ่าน !== รหัสผ่าน
                  ? 'var(--red-bright)'
                  : undefined,
              }}
            />
          </div>

          {ข้อผิดพลาด && (
            <div style={styles.error}>⚠ {ข้อผิดพลาด}</div>
          )}

          <button
            type="submit"
            disabled={กำลังโหลด}
            style={{ ...styles.btn, opacity: กำลังโหลด ? 0.6 : 1 }}
          >
            {กำลังโหลด ? 'กำลังสมัคร...' : 'สมัครสมาชิก'}
          </button>
        </form>

        <div style={styles.footer}>
          <span style={{ color: 'var(--text-secondary)' }}>มีบัญชีแล้ว?</span>
          {' '}
          <Link href="/login" style={styles.link}>เข้าสู่ระบบ</Link>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-primary)',
    padding: '16px',
  },
  card: {
    width: '100%',
    maxWidth: '380px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    padding: '36px 32px',
    boxShadow: '0 0 60px rgba(139,0,0,0.12)',
  },
  header: {
    textAlign: 'center',
    marginBottom: '28px',
  },
  logo: {
    marginBottom: '12px',
    filter: 'drop-shadow(0 0 8px rgba(139,0,0,0.6))',
  },
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: '24px',
    fontWeight: 700,
    color: 'var(--red-bright)',
    letterSpacing: '0.15em',
    textShadow: '0 0 20px rgba(139,0,0,0.4)',
    marginBottom: '6px',
  },
  subtitle: {
    fontSize: '12px',
    color: 'var(--text-secondary)',
    letterSpacing: '0.05em',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: '11px',
    color: 'var(--text-secondary)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  input: {
    padding: '10px 12px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    fontSize: '14px',
    fontFamily: 'var(--font-body)',
    width: '100%',
    transition: 'border-color 0.15s',
  },
  error: {
    padding: '10px 12px',
    background: 'rgba(139,0,0,0.1)',
    border: '1px solid var(--red-blood)',
    borderLeft: '3px solid var(--red-blood)',
    color: 'var(--red-bright)',
    fontSize: '12px',
  },
  btn: {
    padding: '12px',
    background: 'var(--red-blood)',
    border: '1px solid var(--red-bright)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-body)',
    fontSize: '14px',
    fontWeight: 600,
    letterSpacing: '0.05em',
    cursor: 'pointer',
    marginTop: '4px',
    width: '100%',
    transition: 'background 0.15s',
  },
  footer: {
    textAlign: 'center',
    marginTop: '20px',
    fontSize: '12px',
  },
  link: {
    color: 'var(--red-bright)',
    textDecoration: 'none',
    borderBottom: '1px solid var(--red-blood)',
    paddingBottom: '1px',
  },
}
