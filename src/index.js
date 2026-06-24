require('dotenv').config()

const ccxt                 = require('ccxt')
const { RSI }              = require('technicalindicators')
const Database             = require('better-sqlite3')

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  exchange:  'okx',          // 'okx' atau 'tokocrypto' — tinggal ganti ini

  symbol:    'SOL/USDT',
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

// ─── EXCHANGE SELECTION ────────────────────────────────────────────────────────
// Dibangun otomatis berdasarkan CONFIG.exchange. Tinggal ganti CONFIG.exchange
// di atas — tidak perlu comment/uncomment kode lagi.
function buildExchange(name) {
  if (name === 'okx') {
    return new ccxt.okx({
      apiKey:   process.env.OKX_API_KEY,
      secret:   process.env.OKX_SECRET,
      password: process.env.OKX_PASSPHRASE,
    })
  }

  if (name === 'tokocrypto') {
    return new ccxt.tokocrypto({
      apiKey: process.env.TKO_API_KEY,
      secret: process.env.TKO_SECRET,
    })
  }

  throw new Error(`CONFIG.exchange '${name}' tidak dikenali. Pakai 'okx' atau 'tokocrypto'.`)
}

const exchange     = buildExchange(CONFIG.exchange)
const EXCHANGE_NAME = CONFIG.exchange

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
// Rules entry:
//   1. Candle [N-1] close DI BAWAH lower Bollinger Band
//   2. Candle [N]   close DI ATAS  lower Bollinger Band (balik masuk)
//   3. RSI [N] < 30
//
function getSignal({ closes, rsiArr, bbArr }) {
  if (closes.length < 2 || bbArr.length < 2) return 'NONE'

  const prevClose = closes[closes.length - 2]
  const currClose = closes[closes.length - 1]

  const prevBB = bbArr[bbArr.length - 2]
  const currBB = bbArr[bbArr.length - 1]

  const rsi = rsiArr[rsiArr.length - 1]

  const prevBelowLower = prevClose < prevBB.lower
  const currAboveLower = currClose > currBB.lower
  const bbBounce       = prevBelowLower && currAboveLower

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
function calcSLTP(entryPrice, ma20) {
  return {
    sl: entryPrice * (1 - CONFIG.slPercent),
    tp: ma20,   // target TP = garis tengah Bollinger saat entry
  }
}

// ─── ORDER HELPERS (exchange-aware) ────────────────────────────────────────────
async function placeBuy(symbol, size) {
  console.log(`[BUY] Market buy ${size.toFixed(6)} ${symbol}`)
  return await exchange.createMarketBuyOrder(symbol, size)
}

// OKX: pakai algo/trigger order. Tokocrypto (gaya Binance): pakai STOP_LOSS_LIMIT.
async function placeSL(symbol, size, slPrice) {
  if (EXCHANGE_NAME === 'okx') {
    console.log(`[SL ] Pasang algo SL (OKX) @ ${slPrice.toFixed(2)}`)
    return await exchange.createOrder(symbol, 'market', 'sell', size, undefined, {
      triggerPrice:     slPrice,
      triggerPriceType: 'last',
      orderType:        'trigger',
    })
  }

  if (EXCHANGE_NAME === 'tokocrypto') {
    console.log(`[SL ] Pasang STOP_LOSS_LIMIT (Tokocrypto) @ ${slPrice.toFixed(2)}`)
    return await exchange.createOrder(symbol, 'STOP_LOSS_LIMIT', 'sell', size, slPrice, {
      stopPrice: slPrice,
    })
  }

  throw new Error(`Exchange ${EXCHANGE_NAME} belum di-handle di placeSL`)
}

async function placeTP(symbol, size, tpPrice) {
  if (EXCHANGE_NAME === 'okx') {
    console.log(`[TP ] Pasang algo TP (OKX) @ ${tpPrice.toFixed(2)}`)
    return await exchange.createOrder(symbol, 'market', 'sell', size, undefined, {
      triggerPrice:     tpPrice,
      triggerPriceType: 'last',
      orderType:        'trigger',
    })
  }

  if (EXCHANGE_NAME === 'tokocrypto') {
    console.log(`[TP ] Pasang TAKE_PROFIT_LIMIT (Tokocrypto) @ ${tpPrice.toFixed(2)}`)
    return await exchange.createOrder(symbol, 'TAKE_PROFIT_LIMIT', 'sell', size, tpPrice, {
      stopPrice: tpPrice,
    })
  }

  throw new Error(`Exchange ${EXCHANGE_NAME} belum di-handle di placeTP`)
}

// Cek status order, dengan cara yang sesuai exchange aktif
async function checkOrderStatus(symbol, orderId) {
  if (EXCHANGE_NAME === 'okx') {
    // OKX algo order tidak bisa fetchOrder biasa — harus cek open lalu history
    try {
      const openAlgos = await exchange.fetchOpenOrders(symbol, undefined, undefined, {
        ordType: 'trigger',
      })
      const found = openAlgos.find(o => o.id === orderId)
      if (found) return found.status

      const historyAlgos = await exchange.fetchCanceledAndClosedOrders(symbol, undefined, undefined, undefined, {
        ordType: 'trigger',
      })
      const hist = historyAlgos.find(o => o.id === orderId)
      if (hist) return hist.status

      return 'unknown'
    } catch (e) {
      console.warn(`[WARN] Gagal fetch algo order ${orderId}:`, e.message)
      return 'unknown'
    }
  }

  // Tokocrypto (gaya Binance): fetchOrder biasa sudah cukup
  try {
    const order = await exchange.fetchOrder(orderId, symbol)
    return order.status
  } catch (e) {
    console.warn(`[WARN] Gagal fetch order ${orderId}:`, e.message)
    return 'unknown'
  }
}

// Cancel order, dengan cara yang sesuai exchange aktif
async function cancelOrderUnified(symbol, orderId) {
  try {
    if (EXCHANGE_NAME === 'okx') {
      await exchange.cancelOrder(orderId, symbol, { ordType: 'trigger' })
    } else {
      await exchange.cancelOrder(orderId, symbol)
    }
    console.log(`[CANCEL] Order ${orderId} dibatalkan`)
  } catch (e) {
    // Order mungkin sudah terisi/tercancel — aman diabaikan
    console.warn(`[WARN] Gagal cancel order ${orderId}:`, e.message)
  }
}

// ─── CEK POSISI TERTUTUP (OCO) ────────────────────────────────────────────────
async function checkIfClosed(position) {
  if (position.sl_order_id) {
    const status = await checkOrderStatus(position.symbol, position.sl_order_id)
    if (status === 'closed') {
      console.log(`[CLOSED] SL hit — posisi #${position.id}`)
      stmtCloseWithReason.run({ id: position.id, reason: 'sl' })
      if (position.tp_order_id) await cancelOrderUnified(position.symbol, position.tp_order_id)
      return true
    }
  }

  if (position.tp_order_id) {
    const status = await checkOrderStatus(position.symbol, position.tp_order_id)
    if (status === 'closed') {
      console.log(`[CLOSED] TP hit — posisi #${position.id}`)
      stmtCloseWithReason.run({ id: position.id, reason: 'tp' })
      if (position.sl_order_id) await cancelOrderUnified(position.symbol, position.sl_order_id)
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
    console.log(`[${new Date().toISOString()}] Tick ${CONFIG.symbol} (${EXCHANGE_NAME})`)

    if (isCircuitBreakerActive(CONFIG.symbol)) return

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

    const candleLimit = CONFIG.bbPeriod + 50
    const candles     = await exchange.fetchOHLCV(CONFIG.symbol, CONFIG.timeframe, undefined, candleLimit)
    const closes      = candles.map(c => c[4])

    const rsiArr = RSI.calculate({ values: closes, period: CONFIG.rsiPeriod })

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

    const signal = getSignal({ closes, rsiArr, bbArr })
    console.log(`[SIGNAL] ${signal}`)
    if (signal !== 'BUY') return

    const size       = getPositionSize(usdt, currPrice)
    const { sl, tp } = calcSLTP(currPrice, currBB.middle)

    if (tp <= currPrice) {
      console.log(`[SKIP] TP (MA20=${tp.toFixed(2)}) <= entry price — sinyal tidak valid`)
      return
    }

    console.log(`[ORDER] Entry=${currPrice.toFixed(2)}, SL=${sl.toFixed(2)}, TP=${tp.toFixed(2)}`)

    const buyOrder   = await placeBuy(CONFIG.symbol, size)
    const entryPrice = buyOrder.average ?? currPrice

    await new Promise(r => setTimeout(r, 2000))

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
console.log(`=== Bot Started (${EXCHANGE_NAME.toUpperCase()}) ===`)
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
setInterval(runBot, 5 * 60 * 1000)