require('dotenv').config()

const express   = require('express')
const Database  = require('better-sqlite3')
const path      = require('path')

const PORT = process.env.DASHBOARD_PORT || 3000

const app = express()

// ─── BASIC AUTH ─────────────────────────────────────────────────────────────────
// Set DASHBOARD_USER & DASHBOARD_PASS di .env. Kalau tidak di-set, auth di-skip
// (berguna buat testing lokal), tapi WARNING muncul di log biar kamu sadar.
const AUTH_USER = process.env.DASHBOARD_USER
const AUTH_PASS = process.env.DASHBOARD_PASS

if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization

    if (!header || !header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Trading Bot Dashboard"')
      return res.status(401).send('Auth required')
    }

    const decoded = Buffer.from(header.split(' ')[1], 'base64').toString()
    const [user, pass] = decoded.split(':')

    if (user !== AUTH_USER || pass !== AUTH_PASS) {
      res.set('WWW-Authenticate', 'Basic realm="Trading Bot Dashboard"')
      return res.status(401).send('Invalid credentials')
    }

    next()
  })
} else {
  console.warn('[WARN] DASHBOARD_USER/DASHBOARD_PASS belum di-set di .env — dashboard TANPA password!')
}

app.use(express.static(__dirname))

// ─── DATABASE (dua exchange, baca dari file yang sama dengan bot) ─────────────
const DB_FILES = {
  okx:  'positions.db',
  toko: 'positions-toko.db',
}

const dbs = {}
for (const [key, file] of Object.entries(DB_FILES)) {
  const db = new Database(path.resolve(__dirname, '..', '..', file))
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT    NOT NULL,
      side          TEXT    NOT NULL,
      entry_price   REAL    NOT NULL,
      size          REAL    NOT NULL,
      sl_price      REAL    NOT NULL,
      tp_price      REAL    NOT NULL,
      sl_order_id   TEXT,
      tp_order_id   TEXT,
      oco_list_id   TEXT,
      status        TEXT    NOT NULL DEFAULT 'open',
      closed_reason TEXT,
      opened_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      closed_at     TEXT
    )
  `)
  dbs[key] = db
}

// ─── HITUNG STATISTIK ──────────────────────────────────────────────────────────
const MAX_SL_PER_DAY = 2   // sync manual sama CONFIG.circuitBreaker.maxSLPerDay di bot

function pnl(pos) {
  if (pos.closed_reason === 'tp') return (pos.tp_price - pos.entry_price) * pos.size
  if (pos.closed_reason === 'sl') return (pos.sl_price - pos.entry_price) * pos.size
  return 0
}

function computeStats(exchangeKey) {
  const db = dbs[exchangeKey]

  const all    = db.prepare(`SELECT * FROM positions ORDER BY opened_at DESC`).all()
  const closed = all.filter(p => p.status === 'closed')
  const open   = all.filter(p => p.status === 'open')
  const tp     = closed.filter(p => p.closed_reason === 'tp')
  const sl     = closed.filter(p => p.closed_reason === 'sl')

  const totalPnl = closed.reduce((acc, p) => acc + pnl(p), 0)
  const winrate  = closed.length ? (tp.length / closed.length) * 100 : null

  const slToday = db.prepare(`
    SELECT COUNT(*) as count FROM positions
    WHERE status = 'closed' AND closed_reason = 'sl'
      AND DATE(closed_at) = DATE('now')
  `).get().count

  const byDay = db.prepare(`
    SELECT
      DATE(closed_at) as hari,
      COUNT(*) as total,
      SUM(CASE WHEN closed_reason='tp' THEN 1 ELSE 0 END) as tp,
      SUM(CASE WHEN closed_reason='sl' THEN 1 ELSE 0 END) as sl
    FROM positions
    WHERE status = 'closed'
    GROUP BY DATE(closed_at)
    ORDER BY hari DESC
    LIMIT 7
  `).all().reverse()

  const recent = closed.slice(0, 10).map(p => ({ ...p, pnl: pnl(p) }))

  return {
    exchange:      exchangeKey,
    totalTrades:   closed.length,
    tpCount:       tp.length,
    slCount:       sl.length,
    winrate,
    totalPnl,
    openPositions: open,
    slToday,
    maxSLPerDay:   MAX_SL_PER_DAY,
    circuitActive: slToday >= MAX_SL_PER_DAY,
    byDay,
    recent,
  }
}

// ─── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const exchange = req.query.exchange === 'toko' ? 'toko' : 'okx'
  try {
    res.json(computeStats(exchange))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`Dashboard jalan di http://0.0.0.0:${PORT}`)
})