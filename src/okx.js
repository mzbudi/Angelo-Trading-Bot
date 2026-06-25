require('dotenv').config()

const ccxt      = require('ccxt')
const { RSI }   = require('technicalindicators')
const Database  = require('better-sqlite3')

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  symbols:   ['SOL/USDT', 'ETH/USDT'],  // tambah/kurangi pair di sini
  timeframe: '15m',                      // BB & RSI dihitung MURNI dari timeframe ini

  maxPositionUSDT: 200,
  minOrderUSDT:    10,        // skip entry kalau saldo tersisa di bawah ini

  rsiPeriod:   14,
  rsiBuyBelow: 30,

  bbPeriod:   20,
  bbStdDev:   2,

  slPercent: 0.012,           // SL 1.2% di bawah entry
  // TP = MA20 (garis tengah Bollinger) saat entry, dihitung dinamis

  circuitBreaker: {
    maxSLPerDay: 2,           // per-pair
  },
}

// ─── EXCHANGE ──────────────────────────────────────────────────────────────────
const exchange = new ccxt.okx({
  apiKey:   process.env.OKX_API_KEY,
  secret:   process.env.OKX_SECRET,
  password: process.env.OKX_PASSPHRASE,
})

// ─── DATABASE ──────────────────────────────────────────────────────────────────
// Skema TIDAK berubah dari versi sebelumnya — sl_order_id & tp_order_id sekarang
// menyimpan algoId OCO yang SAMA (satu order, bukan dua), jadi dashboard/stats.js
// lama tetap kompatibel tanpa migrasi apapun.
const db = new Database('positions.db')

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
    status        TEXT    NOT NULL DEFAULT 'open',
    closed_reason TEXT,
    opened_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    closed_at     TEXT
  )
`)

const stmtInsert = db.prepare(`
  INSERT INTO positions (symbol, side, entry_price, size, sl_price, tp_price, sl_order_id, tp_order_id)
  VALUES (@symbol, @side, @entry_price, @size, @sl_price, @tp_price, @sl_order_id, @tp_order_id)
`)

const stmtGetOpen = db.prepare(`
  SELECT * FROM positions WHERE symbol = ? AND status = 'open' LIMIT 1
`)

const stmtCloseWithReason = db.prepare(`
  UPDATE positions
  SET status = 'closed', closed_at = datetime('now'), closed_reason = @reason
  WHERE id = @id
`)

const stmtSLToday = db.prepare(`
  SELECT COUNT(*) as count FROM positions
  WHERE symbol = ?
    AND status = 'closed'
    AND closed_reason = 'sl'
    AND DATE(closed_at) = DATE('now')
`)

function hasOpenPosition(symbol) {
  return stmtGetOpen.get(symbol) ?? null
}

// ─── CIRCUIT BREAKER (per-symbol) ──────────────────────────────────────────────
function isCircuitBreakerActive(symbol) {
  const { count } = stmtSLToday.get(symbol)
  if (count >= CONFIG.circuitBreaker.maxSLPerDay) {
    console.log(`  [CIRCUIT BREAKER] ${symbol} — SL kena ${count}x hari ini, skip sampai besok`)
    return true
  }
  return false
}

// ─── SIGNAL (murni dari CONFIG.timeframe, sekarang 15m) ───────────────────────
function getSignal({ closes, rsiArr, bbArr }) {
  if (closes.length < 2 || bbArr.length < 2) return 'NONE'

  const prevClose = closes[closes.length - 2]
  const currClose = closes[closes.length - 1]
  const prevBB    = bbArr[bbArr.length - 2]
  const currBB    = bbArr[bbArr.length - 1]
  const rsi       = rsiArr[rsiArr.length - 1]

  const prevBelowLower = prevClose < prevBB.lower
  const currAboveLower = currClose > currBB.lower
  const bbBounce       = prevBelowLower && currAboveLower
  const oversold        = rsi < CONFIG.rsiBuyBelow

  console.log(`  [SIGNAL CHECK] BB Bounce=${bbBounce} (prev<lower:${prevBelowLower}, curr>lower:${currAboveLower}) | RSI=${rsi.toFixed(2)} Oversold=${oversold}`)

  if (bbBounce && oversold) return 'BUY'
  return 'NONE'
}

// ─── POSITION SIZE ─────────────────────────────────────────────────────────────
function getPositionSize(usdtBalance, price, symbol) {
  const capUsdt = Math.min(usdtBalance, CONFIG.maxPositionUSDT)
  const size    = capUsdt / price
  const base    = symbol.split('/')[0]
  console.log(`  [SIZE] Balance=$${usdtBalance.toFixed(2)}, Dipakai=$${capUsdt.toFixed(2)}, Size=${size.toFixed(6)} ${base}`)
  return { size, capUsdt }
}

function calcSLTP(entryPrice, ma20) {
  return {
    sl: entryPrice * (1 - CONFIG.slPercent),
    tp: ma20,
  }
}

// ─── ORDER HELPERS ─────────────────────────────────────────────────────────────
async function placeBuy(symbol, size) {
  console.log(`  [BUY] Market buy ${size.toFixed(6)} ${symbol}`)
  return await exchange.createMarketBuyOrder(symbol, size)
}

// Native OCO OKX — SATU request, SATU algoId. OKX yang jamin one-cancels-other
// di sisi server, bukan logic manual kita lagi. Ini fix utama hari ini.
async function placeOCO(symbol, size, slPrice, tpPrice) {
  console.log(`  [OCO] Pasang native OCO — SL@${slPrice.toFixed(2)} / TP@${tpPrice.toFixed(2)}`)
  return await exchange.createOrder(symbol, 'market', 'sell', size, undefined, {
    stopLossPrice:   slPrice,
    takeProfitPrice: tpPrice,
  })
}

// Cek apakah OCO masih nyangkut di "open algo orders". Begitu hilang dari
// situ, berarti udah ke-trigger (TP atau SL — OKX yang nentuin via OCO logic
// sendiri, kita nggak perlu history lookup yang kemarin error).
async function isOcoStillOpen(symbol, ocoId) {
  try {
    const openAlgos = await exchange.fetchOpenOrders(symbol, undefined, undefined, { ordType: 'oco' })
    return openAlgos.some(o => o.id === ocoId)
  } catch (e) {
    console.warn(`  [WARN] Gagal fetch status OCO ${ocoId}:`, e.message)
    return true   // gagal fetch → anggap masih open, lebih aman daripada salah buka entry baru
  }
}

// ─── PROSES 1 SYMBOL ───────────────────────────────────────────────────────────
async function processSymbol(symbol) {
  console.log(`\n── ${symbol} ──`)

  if (isCircuitBreakerActive(symbol)) return

  // Candle & indikator diambil duluan — dipakai juga buat klasifikasi
  // TP/SL kalau ternyata ada posisi yang baru ketutup.
  const candleLimit = CONFIG.bbPeriod + 50
  const candles      = await exchange.fetchOHLCV(symbol, CONFIG.timeframe, undefined, candleLimit)
  const closes        = candles.map(c => c[4])

  const rsiArr = RSI.calculate({ values: closes, period: CONFIG.rsiPeriod })

  const bbArr = []
  for (let i = CONFIG.bbPeriod - 1; i < closes.length; i++) {
    const slice    = closes.slice(i - CONFIG.bbPeriod + 1, i + 1)
    const ma       = slice.reduce((a, b) => a + b, 0) / CONFIG.bbPeriod
    const variance = slice.reduce((acc, v) => acc + Math.pow(v - ma, 2), 0) / CONFIG.bbPeriod
    const stdDev   = Math.sqrt(variance)
    bbArr.push({ upper: ma + CONFIG.bbStdDev * stdDev, middle: ma, lower: ma - CONFIG.bbStdDev * stdDev })
  }

  const currBB    = bbArr[bbArr.length - 1]
  const currRSI   = rsiArr[rsiArr.length - 1]
  const currPrice = closes[closes.length - 1]

  // ── Cek posisi aktif ──
  const openPos = hasOpenPosition(symbol)
  if (openPos) {
    console.log(`  [POS] Open: entry=${openPos.entry_price}, SL=${openPos.sl_price}, TP=${openPos.tp_price}`)

    const stillOpen = await isOcoStillOpen(symbol, openPos.sl_order_id)
    if (stillOpen) {
      console.log('  [SKIP] Posisi masih open, tidak entry baru')
      return
    }

    // OCO udah nggak ada di open orders → udah ke-trigger salah satu sisi.
    // Klasifikasi pakai harga sekarang: lebih dekat ke level mana.
    const reason = Math.abs(currPrice - openPos.sl_price) < Math.abs(currPrice - openPos.tp_price) ? 'sl' : 'tp'
    console.log(`  [CLOSED] OCO selesai — diklasifikasi ${reason.toUpperCase()} (price sekarang ${currPrice.toFixed(2)})`)
    stmtCloseWithReason.run({ id: openPos.id, reason })

    if (isCircuitBreakerActive(symbol)) return
  }

  // ── Data & sinyal ──
  const balance = await exchange.fetchBalance()
  const usdt    = balance.USDT.free

  console.log(`  [DATA] Price=${currPrice.toFixed(2)} | RSI=${currRSI.toFixed(2)} | BB Lower=${currBB.lower.toFixed(2)} | BB Mid=${currBB.middle.toFixed(2)} | USDT=$${usdt.toFixed(2)}`)

  const signal = getSignal({ closes, rsiArr, bbArr })
  console.log(`  [SIGNAL] ${signal}`)
  if (signal !== 'BUY') return

  const { size, capUsdt } = getPositionSize(usdt, currPrice, symbol)

  if (capUsdt < CONFIG.minOrderUSDT) {
    console.log(`  [SKIP] Saldo tersisa $${capUsdt.toFixed(2)} di bawah minimum order $${CONFIG.minOrderUSDT}, skip entry`)
    return
  }

  const { sl, tp } = calcSLTP(currPrice, currBB.middle)

  if (tp <= currPrice) {
    console.log(`  [SKIP] TP (MA20=${tp.toFixed(2)}) <= entry price — sinyal tidak valid`)
    return
  }

  console.log(`  [ORDER] Entry=${currPrice.toFixed(2)}, SL=${sl.toFixed(2)}, TP=${tp.toFixed(2)}`)

  const buyOrder   = await placeBuy(symbol, size)
  const entryPrice = buyOrder.average ?? currPrice

  await new Promise(r => setTimeout(r, 2000))

  let ocoId = null
  try {
    const ocoOrder = await placeOCO(symbol, size, sl, tp)
    ocoId = ocoOrder.id
  } catch (e) {
    console.warn('  [WARN] Gagal pasang OCO:', e.message)
  }

  const posId = stmtInsert.run({
    symbol,
    side:        'buy',
    entry_price: entryPrice,
    size,
    sl_price:    sl,
    tp_price:    tp,
    sl_order_id: ocoId,   // simpan algoId yang sama di kedua kolom (skema lama, no migration)
    tp_order_id: ocoId,
  }).lastInsertRowid

  console.log(`  [SAVED] Posisi #${posId} disimpan ke DB (OCO #${ocoId})`)
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function runBot() {
  console.log('\n═════════════════════════════════════════')
  console.log(`[${new Date().toISOString()}] Tick semua pair (okx)`)

  for (const symbol of CONFIG.symbols) {
    try {
      await processSymbol(symbol)
    } catch (err) {
      console.error(`  [ERROR] ${symbol}:`, err.message)
    }
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
console.log('=== OKX Bot Started (multi-pair, native OCO) ===')
console.log(`Pairs     : ${CONFIG.symbols.join(', ')}`)
console.log(`Timeframe : ${CONFIG.timeframe}`)
console.log(`Max Modal : $${CONFIG.maxPositionUSDT} per trade (min order $${CONFIG.minOrderUSDT})`)
console.log(`RSI Buy   : < ${CONFIG.rsiBuyBelow}`)
console.log(`BB Period : ${CONFIG.bbPeriod}`)
console.log(`SL        : ${CONFIG.slPercent * 100}%`)
console.log(`TP        : MA20 (garis tengah Bollinger)`)
console.log(`CB        : per-pair, stop setelah SL ${CONFIG.circuitBreaker.maxSLPerDay}x hari ini`)
console.log(`Interval  : 5 menit`)

runBot()
setInterval(runBot, 5 * 60 * 1000)