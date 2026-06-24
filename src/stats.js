#!/usr/bin/env node
const Database = require('better-sqlite3')
const pino     = require('pino')
const path     = require('path')

const log = pino({ transport: { target: 'pino-pretty' } })

// Pilih DB lewat argument: node src/stats.js okx   -> positions.db
//                          node src/stats.js toko  -> positions-toko.db
// Default (tanpa argument): positions.db (OKX)
const target  = process.argv[2] || 'okx'
const dbFile  = target === 'toko' ? 'positions-toko.db' : 'positions.db'
const db      = new Database(path.resolve(__dirname, '..', dbFile), { readonly: true })

console.log(`\n📂 Membaca: ${dbFile}`)

// ─── QUERIES ──────────────────────────────────────────────────────────────────
const all = db.prepare(`SELECT * FROM positions ORDER BY opened_at DESC`).all()
const closed = all.filter(p => p.status === 'closed')
const open   = all.filter(p => p.status === 'open')

const tp  = closed.filter(p => p.closed_reason === 'tp')
const sl  = closed.filter(p => p.closed_reason === 'sl')

// P&L per trade (estimasi dari SL/TP price × size)
function pnl(pos) {
  if (pos.closed_reason === 'tp') return (pos.tp_price - pos.entry_price) * pos.size
  if (pos.closed_reason === 'sl') return (pos.sl_price - pos.entry_price) * pos.size
  return 0
}

const totalPnl  = closed.reduce((acc, p) => acc + pnl(p), 0)
const winrate   = closed.length ? (tp.length / closed.length * 100).toFixed(1) : '-'

// SL hari ini (circuit breaker counter)
const slToday = db.prepare(`
  SELECT COUNT(*) as count FROM positions
  WHERE status = 'closed' AND closed_reason = 'sl'
    AND DATE(closed_at) = DATE('now')
`).get().count

// ─── SUMMARY ──────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════')
console.log('  OKX BOT — STATISTIK')
console.log('════════════════════════════════════════')
console.log(`  Total trade      : ${closed.length}`)
console.log(`  TP (win)         : ${tp.length}`)
console.log(`  SL (loss)        : ${sl.length}`)
console.log(`  Winrate          : ${winrate}%`)
console.log(`  Est. Total P&L   : $${totalPnl.toFixed(2)}`)
console.log(`  Open sekarang    : ${open.length}`)
console.log(`  SL hari ini      : ${slToday} / 2`)
console.log('────────────────────────────────────────')

// ─── RIWAYAT 10 TERAKHIR ──────────────────────────────────────────────────────
console.log('\n  10 TRADE TERAKHIR\n')
console.log('  No  | Tgl Buka            | Entry      | TP/SL      | Hasil  | Est. P&L')
console.log('  ----|---------------------|------------|------------|--------|----------')

const recent = closed.slice(0, 10)
recent.forEach((p, i) => {
  const result   = p.closed_reason === 'tp' ? ' TP ✓' : ' SL ✗'
  const estPnl   = pnl(p)
  const exitPrice = p.closed_reason === 'tp' ? p.tp_price : p.sl_price
  console.log(
    `  ${String(i + 1).padStart(3)} | ${p.opened_at} | ${p.entry_price.toFixed(2).padStart(10)} | ${exitPrice.toFixed(2).padStart(10)} | ${result}  | $${estPnl.toFixed(2)}`
  )
})

// ─── OPEN POSITION ────────────────────────────────────────────────────────────
if (open.length > 0) {
  console.log('\n  POSISI TERBUKA\n')
  open.forEach(p => {
    console.log(`  #${p.id} | Entry: ${p.entry_price} | SL: ${p.sl_price} | TP: ${p.tp_price}`)
    console.log(`       Dibuka: ${p.opened_at}`)
  })
}

// ─── PER HARI ────────────────────────────────────────────────────────────────
const byDay = db.prepare(`
  SELECT
    DATE(closed_at)                                      as hari,
    COUNT(*)                                             as total,
    SUM(CASE WHEN closed_reason='tp' THEN 1 ELSE 0 END) as tp,
    SUM(CASE WHEN closed_reason='sl' THEN 1 ELSE 0 END) as sl
  FROM positions
  WHERE status = 'closed'
  GROUP BY DATE(closed_at)
  ORDER BY hari DESC
  LIMIT 7
`).all()

if (byDay.length > 0) {
  console.log('\n  7 HARI TERAKHIR\n')
  console.log('  Tanggal     | Total | TP | SL')
  console.log('  ------------|-------|----|----')
  byDay.forEach(d => {
    console.log(`  ${d.hari}  |   ${String(d.total).padStart(3)} |  ${String(d.tp).padStart(2)} |  ${d.sl}`)
  })
}

console.log('\n════════════════════════════════════════\n')