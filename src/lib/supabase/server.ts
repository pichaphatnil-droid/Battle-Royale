import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import cron from 'node-cron'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  // ── Cron: ทุก 10 นาที → POST /api/cron/tick ──────────────
  cron.schedule('*/10 * * * *', async () => {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
      const res = await fetch(`${baseUrl}/api/cron/tick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': process.env.CRON_SECRET ?? '',
        },
      })
      const data = await res.json()
      console.log('[CRON TICK]', new Date().toISOString(), data)
    } catch (err) {
      console.error('[CRON ERROR]', err)
    }
  }, {
    timezone: 'Asia/Bangkok',
  })

  console.log('[CRON] Scheduled tick every 10 minutes (Asia/Bangkok)')

  // ── HTTP Server ──────────────────────────────────────────
  const port = parseInt(process.env.PORT ?? '3000', 10)
  createServer((req, res) => {
    const parsedUrl = parse(req.url ?? '/', true)
    handle(req, res, parsedUrl)
  }).listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`)
  })
})
