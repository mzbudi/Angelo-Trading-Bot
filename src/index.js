require('dotenv').config()

const ccxt = require('ccxt')
const { RSI, EMA } = require('technicalindicators')
const Database = require('better-sqlite3')

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  symbol: 'ETH/USDT',
  timeframe: '15m',

  maxPositionUSDT: 500,  // maksimal modal per trade (spot, hard cap)

  rsiPeriod: 14,
  rsiBuyBelow: 35,       // entry signal
  emaPeriod: 200,        // trend filter: hanya buy kalau harga > EMA 200

  slPercent: 0.02,       // Stop Loss  2% di bawah entry
  tpPercent: 0.04,       // Take Profit 4% di atas entry

  circuitBreaker: {
    maxSLPerDay: 2,      // berhenti trading hari ini setelah SL kena X kali
  },
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

// Hitung SL yang kena hari ini (untuk circuit breaker)
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
// function getSignal({ rsi, price, ema200 }) {
//   const uptrend  = price > ema200
//   const oversold = rsi < CONFIG.rsiBuyBelow

//   console.log(`[FILTER] RSI=${rsi.toFixed(2)} oversold=${oversold} | EMA200=${ema200.toFixed(2)} uptrend=${uptrend}`)

//   if (oversold && uptrend) return 'BUY'
//   return 'NONE'
// }

function getSignal({ rsi, price, ema200 }) {
  if (rsi < CONFIG.rsiBuyBelow) return 'BUY'
  return 'NONE'
}

// ─── POSITION SIZE ─────────────────────────────────────────────────────────────
// Pakai 100% balance, tapi maksimal $500 (buat testing/saldo kecil)
function getPositionSize(usdtBalance, price) {
  const capUsdt = Math.min(usdtBalance, CONFIG.maxPositionUSDT)
  const size    = capUsdt / price
  console.log(`[SIZE] Balance=$${usdtBalance.toFixed(2)}, Dipakai=$${capUsdt.toFixed(2)}, Size=${size.toFixed(6)} BTC`)
  return size
}

// ─── SL / TP ───────────────────────────────────────────────────────────────────
function calcSLTP(entryPrice) {
  return {
    sl: entryPrice * (1 - CONFIG.slPercent),
    tp: entryPrice * (1 + CONFIG.tpPercent),
  }
}

// ─── ORDER HELPERS ─────────────────────────────────────────────────────────────
async function placeBuy(symbol, size) {
  console.log(`[BUY] Market buy ${size} ${symbol}`)
  return await exchange.createMarketBuyOrder(symbol, size)
}

// OKX klasik: pakai algo order (trigger order) untuk SL & TP
// SL: trigger saat harga turun ke slPrice, eksekusi market sell
async function placeSL(symbol, size, slPrice) {
  console.log(`[SL ] Pasang algo SL @ ${slPrice.toFixed(2)}`)
  return await exchange.createOrder(symbol, 'market', 'sell', size, undefined, {
    triggerPrice: slPrice,
    triggerPriceType: 'last',
    orderType: 'trigger',         // OKX algo order
  })
}

// TP: trigger saat harga naik ke tpPrice, eksekusi market sell
async function placeTP(symbol, size, tpPrice) {
  console.log(`[TP ] Pasang algo TP @ ${tpPrice.toFixed(2)}`)
  return await exchange.createOrder(symbol, 'market', 'sell', size, undefined, {
    triggerPrice: tpPrice,
    triggerPriceType: 'last',
    orderType: 'trigger',         // OKX algo order
  })
}

async function cancelOrder(symbol, orderId) {
  try {
    await exchange.cancelOrder(orderId, symbol)
    console.log(`[CANCEL] Order ${orderId} dibatalkan`)
  } catch (e) {
    // Order mungkin sudah terisi atau sudah dicancel — aman diabaikan
    console.warn(`[WARN] Gagal cancel order ${orderId}:`, e.message)
  }
}

// ─── CEK POSISI TERTUTUP (OCO) ────────────────────────────────────────────────
// Algo order OKX harus di-fetch via fetchAlgoOrders, bukan fetchOrder biasa
async function fetchAlgoOrderStatus(symbol, algoOrderId) {
  try {
    // Cek di open algo orders dulu
    const openAlgos = await exchange.fetchOpenOrders(symbol, undefined, undefined, {
      ordType: 'trigger',
    })
    const found = openAlgos.find(o => o.id === algoOrderId)
    if (found) return found.status  // 'open' = belum kena

    // Tidak ada di open → cek di history algo orders
    const historyAlgos = await exchange.fetchCanceledAndClosedOrders(symbol, undefined, undefined, undefined, {
      ordType: 'trigger',
    })
    const hist = historyAlgos.find(o => o.id === algoOrderId)
    if (hist) return hist.status    // 'closed' = sudah ter-trigger, 'canceled' = dicancel

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

// Kalau SL kena → cancel TP, dan sebaliknya
async function checkIfClosed(position) {
  // Cek SL
  if (position.sl_order_id) {
    const status = await fetchAlgoOrderStatus(position.symbol, position.sl_order_id)
    if (status === 'closed') {
      console.log(`[CLOSED] SL hit — posisi #${position.id}`)
      stmtCloseWithReason.run({ id: position.id, reason: 'sl' })
      if (position.tp_order_id) await cancelAlgoOrder(position.symbol, position.tp_order_id)
      return true
    }
  }

  // Cek TP
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

    // 1. Circuit breaker — cek paling awal
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
      // Setelah posisi tutup karena SL, cek circuit breaker lagi
      if (isCircuitBreakerActive(CONFIG.symbol)) return
    }

    // 3. Ambil data market (250 candle untuk EMA 200)
    const balance = await exchange.fetchBalance()
    const usdt    = balance.USDT.free

    const candles = await exchange.fetchOHLCV(CONFIG.symbol, CONFIG.timeframe, undefined, 250)
    const closes  = candles.map(c => c[4])

    const rsiArr = RSI.calculate({ values: closes, period: CONFIG.rsiPeriod })
    const emaArr = EMA.calculate({ values: closes, period: CONFIG.emaPeriod })

    const rsi    = rsiArr[rsiArr.length - 1]
    const ema200 = emaArr[emaArr.length - 1]
    const price  = closes[closes.length - 1]

    console.log(`[DATA] Price=${price}  RSI=${rsi.toFixed(2)}  EMA200=${ema200.toFixed(2)}  USDT=$${usdt.toFixed(2)}`)

    // 4. Sinyal
    const signal = getSignal({ rsi, price, ema200 })
    console.log(`[SIGNAL] ${signal}`)
    if (signal !== 'BUY') return

    // 5. Hitung size
    const size       = getPositionSize(usdt, price)
    const { sl, tp } = calcSLTP(price)

    console.log(`[ORDER] SL=${sl.toFixed(2)}, TP=${tp.toFixed(2)}`)

    // 6. Entry
    const buyOrder   = await placeBuy(CONFIG.symbol, size)
    const entryPrice = buyOrder.average ?? price

    // 7. Tunggu 2 detik supaya balance ETH settle dulu di exchange
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
console.log(`Symbol : ${CONFIG.symbol}`)
console.log(`Max    : $${CONFIG.maxPositionUSDT} per trade`)
console.log(`SL/TP  : ${CONFIG.slPercent * 100}% / ${CONFIG.tpPercent * 100}%`)
console.log(`CB     : stop setelah SL ${CONFIG.circuitBreaker.maxSLPerDay}x hari ini`)
runBot()
setInterval(runBot, 15_000)