require('dotenv').config()

const crypto    = require('crypto')
const { RSI }   = require('technicalindicators')
const Database  = require('better-sqlite3')

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  symbol:    'SOL/USDT',     // internal format, dikonversi otomatis ke ETH_USDT / ETHUSDT
  timeframe: '15m',

  maxPositionUSDT: 200,      // modal per trade (hard cap)

  // RSI
  rsiPeriod:   14,
  rsiBuyBelow: 30,

  // Bollinger Band
  bbPeriod: 20,
  bbStdDev: 2,

  // Exit
  slPercent:    0.012,       // Stop Loss trigger 1.2% di bawah entry
  slLimitBuffer: 0.002,      // limit price SL sedikit di bawah trigger, biar pasti fill
  // TP = MA20 (garis tengah Bollinger), dipakai sebagai limit price OCO

  circuitBreaker: {
    maxSLPerDay: 2,
  },
}

// ─── TOKOCRYPTO API (native, tanpa ccxt) ──────────────────────────────────────
// Base endpoint untuk semua signed endpoint (order, account, wallet)
const API_BASE    = 'https://www.tokocrypto.com'
// Base endpoint khusus market data (klines, depth, trades) untuk symbolType 1
const MARKET_BASE = 'https://www.tokocrypto.site'

const API_KEY = process.env.TKO_API_KEY
const SECRET  = process.env.TKO_SECRET

const ORDER_TYPE = { LIMIT: 1, MARKET: 2, STOP_LOSS: 3, STOP_LOSS_LIMIT: 4, TAKE_PROFIT: 5, TAKE_PROFIT_LIMIT: 6, LIMIT_MAKER: 7 }
const ORDER_SIDE = { BUY: 0, SELL: 1 }
const ORDER_STATUS = { SYSTEM_PROCESSING: -2, NEW: 0, PARTIALLY_FILLED: 1, FILLED: 2, CANCELED: 3, PENDING_CANCEL: 4, REJECTED: 5, EXPIRED: 6 }

function symbolUnderscore(sym) { return sym.replace('/', '_') }   // ETH_USDT  → dipakai di order endpoint
function symbolNoSep(sym)      { return sym.replace('/', '') }    // ETHUSDT   → dipakai di market data endpoint

function buildQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
}

function sign(queryString) {
  return crypto.createHmac('sha256', SECRET).update(queryString).digest('hex')
}

// Signed request (order, account, wallet) — selalu ke API_BASE
async function signedRequest(method, path, params = {}) {
  const allParams    = { ...params, timestamp: Date.now(), recvWindow: 5000 }
  const queryString  = buildQueryString(allParams)
  const signature     = sign(queryString)
  const url           = `${API_BASE}${path}?${queryString}&signature=${signature}`

  const res  = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } })
  const json = await res.json()

  if (json.code !== 0) {
    throw new Error(`Tokocrypto error [${path}]: ${json.msg || json.message} (code ${json.code})`)
  }
  return json.data
}

// Public request (market data) — ke MARKET_BASE
async function publicRequest(path, params = {}) {
  const queryString = buildQueryString(params)
  const url          = `${MARKET_BASE}${path}?${queryString}`

  const res  = await fetch(url)
  const json = await res.json()

  // Beberapa endpoint market data symbolType 1 (misal klines) balikin array
  // mentah ala Binance, bukan dibungkus {code, msg, data}
  if (Array.isArray(json)) return json

  if (json.code !== undefined && json.code !== 0) {
    throw new Error(`Tokocrypto public error [${path}]: ${json.msg} (code ${json.code})`)
  }

  if (json.data !== undefined) return json.data

  // Bentuk response tidak dikenali — print biar mudah debug
  console.warn(`[WARN] Response tidak dikenali dari ${path}:`, JSON.stringify(json).slice(0, 300))
  return json
}

// ─── API HELPERS ───────────────────────────────────────────────────────────────
async function getUsdtBalance() {
  const data = await signedRequest('GET', '/open/v1/account/spot')
  const usdt = data.accountAssets.find(a => a.asset === 'USDT')
  return usdt ? parseFloat(usdt.free) : 0
}

async function getKlines(symbol, interval, limit) {
  // symbol di sini TANPA underscore (format Binance-style), sesuai docs Tokocrypto untuk symbolType 1
  return await publicRequest('/api/v3/klines', { symbol: symbolNoSep(symbol), interval, limit })
}

async function placeMarketBuy(symbol, quantity) {
  return await signedRequest('POST', '/open/v1/orders', {
    symbol:   symbolUnderscore(symbol),
    side:     ORDER_SIDE.BUY,
    type:     ORDER_TYPE.MARKET,
    quantity: quantity.toFixed(6),   // jumlah koin, bukan nilai USDT — lebih pasti didukung
  })
}

async function getOrderDetail(orderId) {
  return await signedRequest('GET', '/open/v1/orders/detail', { orderId })
}

// Native OCO: satu request, Tokocrypto yang urus "kalau satu kena yang lain auto cancel"
async function placeOCO(symbol, quantity, limitPrice, stopPrice, stopLimitPrice) {
  const limitClientId = `tp_${Date.now()}`
  const stopClientId  = `sl_${Date.now()}`

  const result = await signedRequest('POST', '/open/v1/orders/oco', {
    symbol:         symbolUnderscore(symbol),
    side:           ORDER_SIDE.SELL,
    quantity,
    price:          limitPrice.toFixed(2),       // TP — limit sell
    stopPrice:      stopPrice.toFixed(2),        // SL — trigger
    stopLimitPrice: stopLimitPrice.toFixed(2),   // SL — limit price setelah trigger
    limitClientId,
    stopClientId,
  })

  const tpOrder = result.orders.find(o => o.clientId === limitClientId)
  const slOrder = result.orders.find(o => o.clientId === stopClientId)

  return {
    bOrderListId: result.bOrderListId,
    tpOrderId:    tpOrder?.orderId,
    slOrderId:    slOrder?.orderId,
  }
}

// ─── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Database('positions-toko.db')

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

const stmtInsert = db.prepare(`
  INSERT INTO positions (symbol, side, entry_price, size, sl_price, tp_price, sl_order_id, tp_order_id, oco_list_id)
  VALUES (@symbol, @side, @entry_price, @size, @sl_price, @tp_price, @sl_order_id, @tp_order_id, @oco_list_id)
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
function getSignal({ closes, rsiArr, bbArr }) {
  if (closes.length < 2 || bbArr.length < 2) return 'NONE'

  const prevClose = closes[closes.length - 2]
  const currClose = closes[closes.length - 1]
  const prevBB    = bbArr[bbArr.length - 2]
  const currBB    = bbArr[bbArr.length - 1]
  const rsi       = rsiArr[rsiArr.length - 1]

  const prevBelowLower = prevClose < prevBB.lower
  const currAboveLower = currClose > currBB.lower
  const bbBounce        = prevBelowLower && currAboveLower
  const oversold         = rsi < CONFIG.rsiBuyBelow

  console.log(`[SIGNAL CHECK]`)
  console.log(`  Prev close=${prevClose.toFixed(2)} | Prev lower BB=${prevBB.lower.toFixed(2)} | Below? ${prevBelowLower}`)
  console.log(`  Curr close=${currClose.toFixed(2)} | Curr lower BB=${currBB.lower.toFixed(2)} | Above? ${currAboveLower}`)
  console.log(`  BB Bounce=${bbBounce} | RSI=${rsi.toFixed(2)} | Oversold=${oversold}`)

  if (bbBounce && oversold) return 'BUY'
  return 'NONE'
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function runBot() {
  try {
    console.log('\n─────────────────────────────────────────')
    console.log(`[${new Date().toISOString()}] Tick ${CONFIG.symbol} (tokocrypto native)`)

    if (isCircuitBreakerActive(CONFIG.symbol)) return

    const openPos = hasOpenPosition(CONFIG.symbol)
    if (openPos) {
      console.log(`[POS] Open: entry=${openPos.entry_price}, SL=${openPos.sl_price}, TP=${openPos.tp_price}`)

      // OCO: cukup cek salah satu kaki. Kalau TP filled -> TP hit. Kalau SL filled -> SL hit.
      // Yang tidak kena otomatis CANCELED oleh Tokocrypto sendiri, tidak perlu manual cancel.
      const tpStatus = await getOrderDetail(openPos.tp_order_id).catch(() => null)
      if (tpStatus?.status === ORDER_STATUS.FILLED) {
        console.log(`[CLOSED] TP hit — posisi #${openPos.id}`)
        stmtCloseWithReason.run({ id: openPos.id, reason: 'tp' })
        return
      }

      const slStatus = await getOrderDetail(openPos.sl_order_id).catch(() => null)
      if (slStatus?.status === ORDER_STATUS.FILLED) {
        console.log(`[CLOSED] SL hit — posisi #${openPos.id}`)
        stmtCloseWithReason.run({ id: openPos.id, reason: 'sl' })
        if (isCircuitBreakerActive(CONFIG.symbol)) return
      } else {
        console.log('[SKIP] Posisi masih open, tidak entry baru')
        return
      }
    }

    // Ambil candle (butuh bbPeriod + buffer untuk BB valid)
    const candleLimit = CONFIG.bbPeriod + 50
    const klines       = await getKlines(CONFIG.symbol, CONFIG.timeframe, candleLimit)
    const closes        = klines.map(k => parseFloat(k[4]))   // index 4 = close price

    const rsiArr = RSI.calculate({ values: closes, period: CONFIG.rsiPeriod })

    const bbArr = []
    for (let i = CONFIG.bbPeriod - 1; i < closes.length; i++) {
      const slice    = closes.slice(i - CONFIG.bbPeriod + 1, i + 1)
      const ma        = slice.reduce((a, b) => a + b, 0) / CONFIG.bbPeriod
      const variance  = slice.reduce((acc, v) => acc + Math.pow(v - ma, 2), 0) / CONFIG.bbPeriod
      const stdDev    = Math.sqrt(variance)
      bbArr.push({ upper: ma + CONFIG.bbStdDev * stdDev, middle: ma, lower: ma - CONFIG.bbStdDev * stdDev })
    }

    const currBB    = bbArr[bbArr.length - 1]
    const currPrice = closes[closes.length - 1]
    const usdt       = await getUsdtBalance()

    console.log(`[DATA] Price=${currPrice.toFixed(2)} | RSI=${rsiArr[rsiArr.length - 1].toFixed(2)} | BB Lower=${currBB.lower.toFixed(2)} | BB Mid=${currBB.middle.toFixed(2)} | USDT=$${usdt.toFixed(2)}`)

    const signal = getSignal({ closes, rsiArr, bbArr })
    console.log(`[SIGNAL] ${signal}`)
    if (signal !== 'BUY') return

    const tpPrice = currBB.middle
    if (tpPrice <= currPrice) {
      console.log(`[SKIP] TP (MA20=${tpPrice.toFixed(2)}) <= entry price — sinyal tidak valid`)
      return
    }

    const slTriggerPrice = currPrice * (1 - CONFIG.slPercent)
    const slLimitPrice   = slTriggerPrice * (1 - CONFIG.slLimitBuffer)
    const capUsdt          = Math.min(usdt, CONFIG.maxPositionUSDT)

    console.log(`[ORDER] Modal=$${capUsdt.toFixed(2)}, TP=${tpPrice.toFixed(2)}, SL trigger=${slTriggerPrice.toFixed(2)}, SL limit=${slLimitPrice.toFixed(2)}`)

    // 1. Market buy (pakai quoteOrderQty, jadi size dihitung otomatis oleh exchange)
    const buyResult = await placeMarketBuy(CONFIG.symbol, capUsdt)
    const orderId    = buyResult.orderId

    // 2. Tunggu sebentar, lalu query ulang buat dapat executedQty/executedPrice yang akurat
    await new Promise(r => setTimeout(r, 1500))
    const filled = await getOrderDetail(orderId)

    const entryPrice = parseFloat(filled.executedPrice) || currPrice
    const size         = parseFloat(filled.executedQty)

    if (!size || size <= 0) {
      console.warn('[WARN] Buy order belum filled / executedQty 0, skip pasang OCO')
      return
    }

    console.log(`[BUY] Filled: entry=${entryPrice}, size=${size}`)

    // 3. Pasang native OCO (TP limit + SL stop-limit dalam 1 request)
    const oco = await placeOCO(CONFIG.symbol, size, tpPrice, slTriggerPrice, slLimitPrice)

    // 4. Simpan ke DB
    const posId = stmtInsert.run({
      symbol:       CONFIG.symbol,
      side:         'buy',
      entry_price:  entryPrice,
      size,
      sl_price:     slTriggerPrice,
      tp_price:     tpPrice,
      sl_order_id:  oco.slOrderId,
      tp_order_id:  oco.tpOrderId,
      oco_list_id:  oco.bOrderListId,
    }).lastInsertRowid

    console.log(`[SAVED] Posisi #${posId} disimpan ke DB (OCO list #${oco.bOrderListId})`)

  } catch (err) {
    console.error('[ERROR]', err.message)
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
console.log('=== Tokocrypto Native Bot Started ===')
console.log(`Symbol    : ${CONFIG.symbol}`)
console.log(`Timeframe : ${CONFIG.timeframe}`)
console.log(`Max Modal : $${CONFIG.maxPositionUSDT} per trade`)
console.log(`RSI Buy   : < ${CONFIG.rsiBuyBelow}`)
console.log(`BB Period : ${CONFIG.bbPeriod}`)
console.log(`SL        : ${CONFIG.slPercent * 100}% (trigger), buffer limit ${CONFIG.slLimitBuffer * 100}%`)
console.log(`TP        : MA20 (garis tengah Bollinger)`)
console.log(`CB        : stop setelah SL ${CONFIG.circuitBreaker.maxSLPerDay}x hari ini`)
console.log(`Interval  : 5 menit`)
console.log(`API       : native REST Tokocrypto (tanpa ccxt, tanpa dependency ke domain Binance)`)

runBot()
setInterval(runBot, 5 * 60 * 1000)