require('dotenv').config()

const ccxt                 = require('ccxt')
const { RSI }              = require('technicalindicators')
const Database             = require('better-sqlite3')

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  symbol:    'ETH/USDT',
  timeframe: '15m',          // ganti ke '1h', '4h' dll tanpa ubah logic

  maxPositionUSDT: 200,      // modal per trade (hard cap)

  // RSI
  rsiPeriod:   14,
  rsiBuyBelow: 30,           // entry hanya kalau RSI < 30

  // Bollinger Band
  bbPeriod:   20,            // periode MA (juga dipakai sebagai TP target = MA20)
  bbStdDev:   2,             // standar deviasi

  // Exit
  slPercent: 0.012,          // Stop Loss 1.2% di bawah entry
  // TP = harga menyentuh MA20 (garis tengah Bollinger), dihitung dinamis per tick

  circuitBreaker: {
    maxSLPerDay: 2,          // berhenti trading hari ini setelah SL kena X kali
  },
}

// ─── BOLLINGER BAND HELPER ────────────────────────────────────────────────────
// Hitung MA dan StdDev dari array closes
function calcBB(closes, period, stdDevMult) {
  if (closes.length < period) return null

  const slice = closes.slice(-period)
  const ma    = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - ma, 2), 0) / period
  const stdDev   = Math.sqrt(variance)

  return {
    upper: ma + stdDevMult * stdDev,
    middle: ma,                          // MA20 = target TP
    lower:  ma - stdDevMult * stdDev,
  }
}

// ─── DATABASE ──────────────────────────────────────────────────────────────────
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

// ─── EXCHANGE ──────────────────────────────────────────────────────────────────
const exchange = new ccxt.okx({
  apiKey:   process.env.OKX_API_KEY,
  secret:   process.env.OKX_SECRET,
  password: process.env.OKX_PASSPHRASE,
})

// ─── CIRCUIT BREAKER ───────────────────────────────────────────────────────────
function isCircuitBreakerActive(symbol) {
  const { count } = stmtSLToday.get(symbol)
  if (count >= CONFIG.circuitBreaker.maxSLPerDay) {
    console.log(`[CIRCUIT BREAKER] SL kena ${count}x hari ini — bot berhenti sampai besok`)
    return true
  }
  return false
}

// ─── SIGNAL ────────────────────────────────────────────────────────────────────
//
// Rules entry yang disepakati:
//   1. Candle [N-1] close DI BAWAH lower Bollinger Band
//   2. Candle [N]   close DI ATAS  lower Bollinger Band (balik masuk)
//   3. RSI [N] < 30
//
// Entry dieksekusi di awal candle [N+1]
//
function getSignal({ closes, rsiArr, bbArr }) {
  // Butuh minimal 2 candle terakhir dan BB yang valid
  if (closes.length < 2 || bbArr.length < 2) return 'NONE'

  const prevClose = closes[closes.length - 2]
  const currClose = closes[closes.length - 1]

  const prevBB = bbArr[bbArr.length - 2]
  const currBB = bbArr[bbArr.length - 1]

  const rsi = rsiArr[rsiArr.length - 1]

  // Kondisi Bollinger Band: candle sebelumnya di bawah lower, sekarang balik masuk
  const prevBelowLower = prevClose < prevBB.lower
  const currAboveLower = currClose > currBB.lower
  const bbBounce       = prevBelowLower && currAboveLower

  // Kondisi RSI
  const oversold = rsi < CONFIG.rsiBuyBelow

  console.log(`[SIGNAL CHECK]`)
  console.log(`  Prev close=${prevClose.toFixed(2)} | Prev lower BB=${prevBB.lower.toFixed(2)} | Below? ${prevBelowLower}`)
  console.log(`  Curr close=${currClose.toFixed(2)} | Curr lower BB=${currBB.lower.toFixed(2)} | Above? ${currAboveLower}`)
  console.log(`  BB Bounce=${bbBounce} | RSI=${rsi.toFixed(2)} | Oversold=${oversold}`)

  if (bbBounce && oversold) return 'BUY'
  return 'NONE'
}

// ─── POSITION SIZE ─────────────────────────────────────────────────────────────
function getPositionSize(usdtBalance, price) {
  const capUsdt = Math.min(usdtBalance, CONFIG.maxPositionUSDT)
  const size    = capUsdt / price
  console.log(`[SIZE] Balance=$${usdtBalance.toFixed(2)}, Dipakai=$${capUsdt.toFixed(2)}, Size=${size.toFixed(6)} ETH`)
  return size
}

// ─── SL / TP ───────────────────────────────────────────────────────────────────
// SL: fixed 1.2% di bawah entry
// TP: MA20 saat ini (garis tengah Bollinger) — dinamis, dihitung dari data terbaru
function calcSLTP(entryPrice, ma20) {
  return {
    sl: entryPrice * (1 - CONFIG.slPercent),
    tp: ma20,   // target TP = garis tengah Bollinger saat entry
  }
}

// ─── ORDER HELPERS ─────────────────────────────────────────────────────────────
async function placeBuy(symbol, size) {
  console.log(`[BUY] Market buy ${size.toFixed(6)} ${symbol}`)
  return await exchange.createMarketBuyOrder(symbol, size)
}

async function placeSL(symbol, size, slPrice) {
  console.log(`[SL ] Pasang algo SL @ ${slPrice.toFixed(2)}`)
  return await exchange.createOrder(symbol, 'market', 'sell', size, undefined, {
    triggerPrice:     slPrice,
    triggerPriceType: 'last',
    orderType:        'trigger',
  })
}

async function placeTP(symbol, size, tpPrice) {
  console.log(`[TP ] Pasang algo TP @ ${tpPrice.toFixed(2)}`)
  return await exchange.createOrder(symbol, 'market', 'sell', size, undefined, {
    triggerPrice:     tpPrice,
    triggerPriceType: 'last',
    orderType:        'trigger',
  })
}

// ─── CEK STATUS ALGO ORDER ────────────────────────────────────────────────────
async function fetchAlgoOrderStatus(symbol, algoOrderId) {
  try {
    const openAlgos = await exchange.fetchOpenOrders(symbol, undefined, undefined, {
      ordType: 'trigger',
    })
    const found = openAlgos.find(o => o.id === algoOrderId)
    if (found) return found.status

    const historyAlgos = await exchange.fetchCanceledAndClosedOrders(symbol, undefined, undefined, undefined, {
      ordType: 'trigger',
    })
    const hist = historyAlgos.find(o => o.id === algoOrderId)
    if (hist) return hist.status

    return 'unknown'
  } catch (e) {
    console.warn(`[WARN] Gagal fetch algo order ${algoOrderId}:`, e.message)
    return 'unknown'
  }
}

async function cancelAlgoOrder(symbol, algoOrderId) {
  try {
    await exchange.cancelOrder(algoOrderId, symbol, { ordType: 'trigger' })
    console.log(`[CANCEL] Algo order ${algoOrderId} dibatalkan`)
  } catch (e) {
    console.warn(`[WARN] Gagal cancel algo order ${algoOrderId}:`, e.message)
  }
}

// Cek apakah SL atau TP sudah kena, lalu tutup posisi dan cancel order yang tersisa
async function checkIfClosed(position) {
  if (position.sl_order_id) {
    const status = await fetchAlgoOrderStatus(position.symbol, position.sl_order_id)
    if (status === 'closed') {
      console.log(`[CLOSED] SL hit — posisi #${position.id}`)
      stmtCloseWithReason.run({ id: position.id, reason: 'sl' })
      if (position.tp_order_id) await cancelAlgoOrder(position.symbol, position.tp_order_id)
      return true
    }
  }

  if (position.tp_order_id) {
    const status = await fetchAlgoOrderStatus(position.symbol, position.tp_order_id)
    if (status === 'closed') {
      console.log(`[CLOSED] TP hit — posisi #${position.id}`)
      stmtCloseWithReason.run({ id: position.id, reason: 'tp' })
      if (position.sl_order_id) await cancelAlgoOrder(position.symbol, position.sl_order_id)
      return true
    }
  }

  return false
}

function hasOpenPosition(symbol) {
  return stmtGetOpen.get(symbol) ?? null
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function runBot() {
  try {
    console.log('\n─────────────────────────────────────────')
    console.log(`[${new Date().toISOString()}] Tick ${CONFIG.symbol}`)

    // 1. Circuit breaker
    if (isCircuitBreakerActive(CONFIG.symbol)) return

    // 2. Cek posisi aktif
    const openPos = hasOpenPosition(CONFIG.symbol)
    if (openPos) {
      console.log(`[POS] Open: entry=${openPos.entry_price}, SL=${openPos.sl_price}, TP=${openPos.tp_price}`)
      const closed = await checkIfClosed(openPos)
      if (!closed) {
        console.log('[SKIP] Posisi masih open, tidak entry baru')
        return
      }
      if (isCircuitBreakerActive(CONFIG.symbol)) return
    }

    // 3. Ambil data market
    // Butuh minimal bbPeriod + 2 candle untuk kalkulasi BB yang valid
    const candleLimit = CONFIG.bbPeriod + 50
    const candles     = await exchange.fetchOHLCV(CONFIG.symbol, CONFIG.timeframe, undefined, candleLimit)
    const closes      = candles.map(c => c[4])

    // 4. Hitung indikator
    const rsiArr = RSI.calculate({ values: closes, period: CONFIG.rsiPeriod })

    // Hitung BB untuk setiap candle secara sliding window
    const bbArr = []
    for (let i = CONFIG.bbPeriod - 1; i < closes.length; i++) {
      const slice = closes.slice(i - CONFIG.bbPeriod + 1, i + 1)
      const ma    = slice.reduce((a, b) => a + b, 0) / CONFIG.bbPeriod
      const variance = slice.reduce((acc, v) => acc + Math.pow(v - ma, 2), 0) / CONFIG.bbPeriod
      const stdDev   = Math.sqrt(variance)
      bbArr.push({
        upper:  ma + CONFIG.bbStdDev * stdDev,
        middle: ma,
        lower:  ma - CONFIG.bbStdDev * stdDev,
      })
    }

    const currBB    = bbArr[bbArr.length - 1]
    const currRSI   = rsiArr[rsiArr.length - 1]
    const currPrice = closes[closes.length - 1]

    const balance = await exchange.fetchBalance()
    const usdt    = balance.USDT.free

    console.log(`[DATA] Price=${currPrice.toFixed(2)} | RSI=${currRSI.toFixed(2)} | BB Lower=${currBB.lower.toFixed(2)} | BB Mid=${currBB.middle.toFixed(2)} | USDT=$${usdt.toFixed(2)}`)

    // 5. Cek sinyal
    const signal = getSignal({ closes, rsiArr, bbArr })
    console.log(`[SIGNAL] ${signal}`)
    if (signal !== 'BUY') return

    // 6. Hitung size & SL/TP
    const size       = getPositionSize(usdt, currPrice)
    const { sl, tp } = calcSLTP(currPrice, currBB.middle)

    // Validasi: TP harus di atas entry (jangan entry kalau MA20 di bawah harga)
    if (tp <= currPrice) {
      console.log(`[SKIP] TP (MA20=${tp.toFixed(2)}) <= entry price — sinyal tidak valid`)
      return
    }

    console.log(`[ORDER] Entry=${currPrice.toFixed(2)}, SL=${sl.toFixed(2)}, TP=${tp.toFixed(2)}`)

    // 7. Entry
    const buyOrder   = await placeBuy(CONFIG.symbol, size)
    const entryPrice = buyOrder.average ?? currPrice

    // Tunggu balance settle
    await new Promise(r => setTimeout(r, 2000))

    // 8. Pasang SL & TP
    let slOrderId = null
    let tpOrderId = null

    try {
      const slOrder = await placeSL(CONFIG.symbol, size, sl)
      slOrderId = slOrder.id
    } catch (e) {
      console.warn('[WARN] Gagal pasang SL:', e.message)
    }

    try {
      const tpOrder = await placeTP(CONFIG.symbol, size, tp)
      tpOrderId = tpOrder.id
    } catch (e) {
      console.warn('[WARN] Gagal pasang TP:', e.message)
    }

    // 9. Simpan ke DB
    const posId = stmtInsert.run({
      symbol:      CONFIG.symbol,
      side:        'buy',
      entry_price: entryPrice,
      size,
      sl_price:    sl,
      tp_price:    tp,
      sl_order_id: slOrderId,
      tp_order_id: tpOrderId,
    }).lastInsertRowid

    console.log(`[SAVED] Posisi #${posId} disimpan ke DB`)

  } catch (err) {
    console.error('[ERROR]', err.message)
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
console.log('=== OKX Bot Started ===')
console.log(`Symbol    : ${CONFIG.symbol}`)
console.log(`Timeframe : ${CONFIG.timeframe}`)
console.log(`Max Modal : $${CONFIG.maxPositionUSDT} per trade`)
console.log(`RSI Buy   : < ${CONFIG.rsiBuyBelow}`)
console.log(`BB Period : ${CONFIG.bbPeriod}`)
console.log(`SL        : ${CONFIG.slPercent * 100}%`)
console.log(`TP        : MA20 (garis tengah Bollinger)`)
console.log(`CB        : stop setelah SL ${CONFIG.circuitBreaker.maxSLPerDay}x hari ini`)
console.log(`Interval  : 5 menit`)

runBot()
setInterval(runBot, 5 * 60 * 1000) // cek setiap 5 menit