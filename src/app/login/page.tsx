'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()

  const [อีเมล, setอีเมล] = useState('')
  const [รหัสผ่าน, setรหัสผ่าน] = useState('')
  const [กำลังโหลด, setกำลังโหลด] = useState(false)
  const [ข้อผิดพลาด, setข้อผิดพลาด] = useState<string | null>(null)

  async function เข้าสู่ระบบ(e: React.FormEvent) {
    e.preventDefault()
    setกำลังโหลด(true)
    setข้อผิดพลาด(null)

    const { error } = await supabase.auth.signInWithPassword({
      email: อีเมล,
      password: รหัสผ่าน,
    })

    if (error) {
      setข้อผิดพลาด('อีเมลหรือรหัสผ่านไม่ถูกต้อง')
      setกำลังโหลด(false)
      return
    }

    router.push('/')
    router.refresh()
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
          <p style={styles.subtitle}>เข้าสู่ระบบเพื่อเข้าร่วมเกม</p>
        </div>

        {/* Form */}
        <form onSubmit={เข้าสู่ระบบ} style={styles.form}>
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
              placeholder="••••••••"
              required
              autoComplete="current-password"
              style={styles.input}
            />
          </div>

          {ข้อผิดพลาด && (
            <div style={styles.error}>
              ⚠ {ข้อผิดพลาด}
            </div>
          )}

          <button
            type="submit"
            disabled={กำลังโหลด}
            style={{
              ...styles.btn,
              opacity: กำลังโหลด ? 0.6 : 1,
            }}
          >
            {กำลังโหลด ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>

        {/* Footer */}
        <div style={styles.footer}>
          <span style={{ color: 'var(--text-secondary)' }}>ยังไม่มีบัญชี?</span>
          {' '}
          <Link href="/register" style={styles.link}>สมัครสมาชิก</Link>
        </div>
      </div>

      {/* Decorative blood line */}
      <div style={styles.bloodLine} />
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
    position: 'relative',
    overflow: 'hidden',
  },
  card: {
    width: '100%',
    maxWidth: '380px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    padding: '36px 32px',
    boxShadow: '0 0 60px rgba(139,0,0,0.12)',
    position: 'relative',
    zIndex: 1,
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
    color: 'var(--red-bright)',
    fontSize: '12px',
    borderLeft: '3px solid var(--red-blood)',
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
    transition: 'background 0.15s',
    width: '100%',
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
  bloodLine: {
    position: 'absolute',
    top: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    width: '1px',
    height: '100vh',
    background: 'linear-gradient(to bottom, transparent, rgba(139,0,0,0.15), transparent)',
    pointerEvents: 'none',
  },
}
