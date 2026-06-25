# Angelo Trading Bot

Bot trading otomatis untuk OKX & Tokocrypto, strategi **Bollinger Band + RSI**, lengkap dengan auto SL/TP, circuit breaker, dan dashboard monitoring.

> ⚠️ **DISCLAIMER**
> Aku nggak bertanggung jawab atas dana kamu. Bot ini bisa rugi, bisa untung, bisa juga error di tengah jalan. **DYOR. DWYOR.** Selalu mulai dari modal kecil yang siap hilang, bukan modal yang kamu butuhin.

---

## Daftar Isi

- [Fitur](#fitur)
- [Struktur Project](#struktur-project)
- [Requirements](#requirements)
- [Instalasi](#instalasi)
- [Konfigurasi (.env)](#konfigurasi-env)
- [Strategi Trading](#strategi-trading)
- [Cara Jalanin](#cara-jalanin)
- [Monitoring](#monitoring)
- [Keamanan](#keamanan)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)

---

## Fitur

- ✅ Strategi **Bollinger Band (20, 2σ) + RSI(14)** — entry pas harga bounce dari lower band & RSI oversold
- ✅ **Native OCO order** (OKX algo order / Tokocrypto OCO) — SL & TP satu order, exchange yang jamin one-cancels-other
- ✅ **Multi-pair** — bisa jalanin beberapa pair sekaligus (`SOL/USDT`, `ETH/USDT`, dst), circuit breaker per-pair
- ✅ **Circuit breaker** — auto stop trading satu pair kalau udah kena SL 2x dalam sehari
- ✅ **Capital guard** — modal per-trade dibatasi (`maxPositionUSDT`), skip entry kalau saldo nggak cukup
- ✅ **Dual exchange** — OKX (via ccxt) & Tokocrypto (native REST API, tanpa ccxt)
- ✅ **Persistent tracking** — semua posisi tersimpan di SQLite, survive restart
- ✅ **Dashboard web** — monitoring real-time dengan basic auth, breakdown per-pair
- ✅ **CLI stats** — cek performa langsung dari terminal

---

## Struktur Project

```
Angelo-Trading-Bot/
├── positions.db            # SQLite — posisi bot OKX
├── positions-toko.db       # SQLite — posisi bot Tokocrypto
├── .env                    # API keys & credentials (JANGAN di-commit ke git!)
├── package.json
└── src/
    ├── okx.js               # Bot OKX (multi-pair, native OCO)
    ├── tokocrypto-bot.js    # Bot Tokocrypto (native REST API)
    ├── stats.js             # CLI buat cek statistik
    └── frontend/
        ├── server.js        # Backend dashboard (Express)
        └── index.html       # Tampilan dashboard
```

---

## Requirements

- **Node.js v18+** (pakai `fetch` & `dns` bawaan — sudah dites di v22)
- Akun **OKX** dan/atau **Tokocrypto**, sudah ada saldo USDT di Trading account
- API key dengan permission **Trade + Read** — **JANGAN aktifkan Withdraw**
- VPS (disarankan, untuk 24/7) — laptop lokal juga bisa buat testing

---

## Instalasi

```bash
git clone <repo-kamu>
cd Angelo-Trading-Bot
npm install
```

Dependencies yang dipakai:

| Package | Fungsi |
|---|---|
| `ccxt` | Koneksi ke OKX |
| `technicalindicators` | Hitung RSI |
| `better-sqlite3` | Database posisi |
| `dotenv` | Load `.env` |
| `express` | Dashboard backend |
| `pino` + `pino-pretty` | Logging (stats.js) |
| `nodemon` | Auto-restart saat dev |

> ⚠️ Kalau install di **Termux/Android**, `better-sqlite3` sering gagal build (native compile issue). Jalanin di VPS/PC biasa untuk produksi.

---

## Konfigurasi (.env)

```env
# OKX
OKX_API_KEY=xxx
OKX_SECRET=xxx
OKX_PASSPHRASE=xxx

# Tokocrypto
TKO_API_KEY=xxx
TKO_SECRET=xxx

# Dashboard (basic auth)
DASHBOARD_USER=pilih_username
DASHBOARD_PASS=pilih_password_unik
DASHBOARD_PORT=3000
```

**Penting:**
- Kalau OKX API key kamu pakai **IP whitelist**, pastikan IP VPS (IPv4 **dan** IPv6 kalau ada) udah ditambahin di OKX → API Management. Error `code: 50110` = ini sumbernya.
- `DASHBOARD_USER`/`PASS` kalau nggak di-set, dashboard jalan **tanpa password** — akan ada warning di log pm2.

---

## Strategi Trading

**Entry (BUY):**
1. Candle sebelumnya close **di bawah** lower Bollinger Band
2. Candle sekarang close **balik di atas** lower Bollinger Band (bounce)
3. **DAN** RSI(14) candle sekarang **< 30** (oversold)

**Exit:**
- **Stop Loss**: 1.2% di bawah harga entry (fixed)
- **Take Profit**: MA20 / garis tengah Bollinger Band (dinamis, dihitung saat entry)
- Keduanya dipasang sebagai **satu native OCO order** — begitu salah satu kena, sisi lain otomatis cancel oleh exchange, bukan logic manual bot.

**Risk management:**
- Modal per-trade dibatasi `maxPositionUSDT` (default $200), pakai whichever lebih kecil antara itu dan saldo aktual
- Skip entry kalau saldo tersisa di bawah `minOrderUSDT` (default $10)
- **Circuit breaker per-pair**: kena SL 2x dalam sehari → pair itu berhenti trading sampai besok (reset otomatis jam 00:00 sesuai timezone server)

Semua angka di atas bisa diubah di `CONFIG` masing-masing file bot.

---

## Cara Jalanin

### Development / testing
```bash
npx nodemon src/okx.js
npx nodemon src/tokocrypto-bot.js
```

### Production (pakai pm2)
```bash
npm install -g pm2

pm2 start src/okx.js --name okx-bot
pm2 start src/tokocrypto-bot.js --name toko-bot
pm2 start src/frontend/server.js --name dashboard

pm2 save              # biar auto-restart kalau VPS reboot
pm2 startup
```

### Command pm2 yang sering kepake
```bash
pm2 list                  # lihat semua proses
pm2 logs okx-bot           # lihat log realtime
pm2 restart okx-bot         # restart setelah update kode
pm2 delete okx-bot           # hapus proses (perlu kalau rename file)
```

> Update kode bot (`okx.js`, `tokocrypto-bot.js`, `frontend/server.js`) **wajib** `pm2 restart`. Update `stats.js` atau `index.html` **tidak perlu** restart apapun — langsung kepake pas dipanggil/di-load ulang.

---

## Monitoring

### CLI
```bash
node src/stats.js okx     # baca positions.db
node src/stats.js toko    # baca positions-toko.db
```

### Dashboard web
```
http://IP_VPS_KAMU:3000
```
Browser bakal minta username/password (sesuai `.env`) sekali per sesi. Toggle **OKX / TOKOCRYPTO** di kanan atas buat pindah exchange. Ada breakdown **per-pair** (winrate, P&L, status circuit breaker masing-masing), riwayat trade, dan grafik 7 hari terakhir. Auto-refresh tiap 15 detik.

---

## Keamanan

Checklist sebelum live dengan dana sungguhan:

- [ ] API key OKX/Tokocrypto: permission **Trade + Read** saja, **Withdraw OFF**
- [ ] Firewall VPS aktif (`ufw`), cuma buka port SSH + port dashboard
  ```bash
  sudo ufw allow OpenSSH
  sudo ufw allow 3000
  sudo ufw enable
  ```
- [ ] Dashboard ada `DASHBOARD_USER`/`DASHBOARD_PASS` di `.env`
- [ ] `.env` **tidak** ke-commit ke git (cek `.gitignore`)
- [ ] Modal yang dipakai bot cuma sebagian dari total saldo (sisanya di Funding account / dompet lain)

---

## Troubleshooting

| Error / Simptom | Penyebab | Solusi |
|---|---|---|
| `code: 50110` IP not in whitelist | IP VPS (sering IPv6) belum ditambahin ke API key | Whitelist IP VPS di OKX, atau whitelist "semua IP" kalau cuma testing |
| `Total order value should be more than 5 USDT` | Saldo kurang dari minimum order, atau parameter order salah | Cek saldo, pastikan `quantity` terkirim benar (bukan `quoteOrderQty` kalau exchange nggak support) |
| SL/TP kejual sebagian-sebagian, nggak bersih | Pakai 2 order trigger terpisah (bukan native OCO) | Pastikan pakai `placeOCO()` — satu request, satu algoId |
| Dashboard nggak update status closed | Gagal deteksi status order tertutup | Cek `isOcoStillOpen()` — kalau order udah nggak ada di `fetchOpenOrders`, posisi dianggap closed |
| `fetchCanceledAndClosedOrders() is not supported` | Method ccxt itu nggak didukung OKX | Jangan dipakai — pakai pendekatan `fetchOpenOrders` + klasifikasi by price (lihat `okx.js`) |
| Tokocrypto request timeout ke `api.binance.com` | ccxt Tokocrypto narik data publik dari domain Binance, yang sering diblokir ISP Indonesia | Pakai native REST API Tokocrypto (`tokocrypto-bot.js`), bukan ccxt |
| `better-sqlite3` gagal install di Termux | Native module butuh kompilasi C++ yang nggak stabil di Android | Jalanin di VPS/PC, atau ganti ke storage berbasis JSON |
| `MODULE_NOT_FOUND` pas start dashboard | `express` belum di-install | `npm install express` dari root project |

---

## Known Limitations

- **Klasifikasi SL/TP berbasis harga saat deteksi**, bukan dari data fill order langsung — akurat untuk kondisi normal, tapi ada celah ambiguitas kalau harga sempat melewati kedua level dalam satu interval cek (jarang terjadi, tapi bukan nol).
- **P&L di dashboard itu estimasi** (`(exit_price - entry_price) × size`), belum termasuk fee trading exchange.
- **`maxPositionUSDT` itu per-trade, bukan per-bot** — kalau jalanin banyak pair dan saldo besar, total exposure bisa lebih dari satu `maxPositionUSDT` kalau beberapa pair entry bersamaan.
- Strategi ini **mean-reversion** (RSI oversold) — performanya jelek di strong downtrend/black swan, karena RSI bisa "stuck" oversold berhari-hari. Circuit breaker membantu, tapi nggak menghilangkan risiko ini sepenuhnya.
- Dashboard web jalan di HTTP biasa (bukan HTTPS) kalau belum pakai domain — cukup aman untuk monitoring personal, tapi bukan "bank-grade security".

---

## Lisensi / Pemakaian

Project pribadi, dipakai dengan risiko sendiri. Modifikasi sesukanya — tapi kalau rugi, ya tanggung jawab masing-masing ya. 😄

**DYOR. DWYOR.**