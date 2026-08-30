# Trading Boy Bot

A standalone AI trading signal site that connects to your **Gain EX** platform's market data API.

## Files

| File        | Purpose                                       |
|-------------|-----------------------------------------------|
| `index.html`| Main bot UI (auth screen + bot screen)        |
| `bot.css`   | All styling — premium dark theme              |
| `bot.js`    | Bot engine: signal analysis, ticker, log      |

## How to Deploy

### Option A — On same Hostinger account (subfolder)

1. Upload all 3 files to a subfolder on your hosting, e.g. `/public_html/tradingboybot/`
2. Access it at: `https://yourdomain.com/tradingboybot/`
3. In `bot.js`, set `GAINEX_API` to **an empty string `''`** (same domain, no CORS needed)

### Option B — On a separate domain

1. Upload all 3 files to a new hosting account/domain
2. Open `bot.js` and at the top, change:
   ```js
   const GAINEX_API = (function () {
     const saved = localStorage.getItem('tbb_api_url');
     if (saved) return saved.replace(/\/$/, '');
     return 'https://YOUR-GAINEX-DOMAIN.com';   // ← put your Gain EX URL here
   })();
   ```
3. Deploy to your separate host

## API Endpoints Used (Gain EX side)

These three endpoints are already live on your Gain EX server (no auth needed):

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/public/bot/validate-key` | Validates user's activation key |
| GET  | `/api/public/bot/price/:asset` | Gets live price for an asset |
| GET  | `/api/public/bot/candles/:asset?timeframe=1m` | Gets candle data for analysis |

## Activation Keys

Keys are managed in the **Gain EX Staff Panel → AI Bot Keys** section.
Only keys that have been **activated** (marked as used) will work.

## Features

- 🔑 Key-based access (same keys from the Gain EX staff panel)
- 📡 Live price ticker for BTC, ETH, BNB, SOL, XRP, EUR/USD, GBP/USD
- 🤖 RSI + EMA technical analysis on Gain EX real candle data
- 🚀 Autopilot mode — automatic signal display
- 🎯 Copilot mode — confirm each signal before acting
- 📊 Win/Loss/P&L manual tracking
- 📋 Full activity log
- 📱 Fully mobile-responsive
