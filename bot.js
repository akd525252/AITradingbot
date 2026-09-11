/**
 * Trading Boy Bot — bot.js
 * Standalone auto-trade engine. Connects to Gain EX public API.
 * Handles key activation, email linking, auto-trade execution, and outcome polling.
 */
'use strict';

// ─── CONFIG ────────────────────────────────────────────────────────────────
let GAINEX_API = 'https://gainexmarket.com';

function updateGainexApiUrl(url) {
  if (url) {
    GAINEX_API = url.trim().replace(/\/$/, '');
    localStorage.setItem('tbb_api_url', GAINEX_API);
  }
}

// Auto-initialize from localStorage or auto-detection
(function initApiUrl() {
  const saved = localStorage.getItem('tbb_api_url');
  if (saved && saved.trim() !== '' && !saved.includes('gxmmarket.com')) {
    GAINEX_API = saved.trim().replace(/\/$/, '');
  } else if (typeof window !== 'undefined' && window.location) {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      GAINEX_API = 'http://127.0.0.1:3000';
    } else if (host.includes('gainexmarket.com')) {
      GAINEX_API = window.location.origin;
    } else {
      GAINEX_API = 'https://gainexmarket.com';
    }
  }
})();

const API = {
  get verifyEmail()   { return `${GAINEX_API}/api/public/bot/verify-email`; },
  get linkAccount()   { return `${GAINEX_API}/api/public/bot/link-account`; },
  get unlinkAccount() { return `${GAINEX_API}/api/public/bot/unlink-account`; },
  get placeTrade()    { return `${GAINEX_API}/api/public/bot/place-trade`; },
  tradeResult:   (id, token) => `${GAINEX_API}/api/public/bot/trade-result/${id}?session_token=${token}`,
  balance:       (token) => `${GAINEX_API}/api/public/bot/balance?session_token=${token}`,
  price:         (asset) => `${GAINEX_API}/api/public/bot/price/${encodeURIComponent(asset)}`,
  candles:       (asset, tf) => `${GAINEX_API}/api/public/bot/candles/${encodeURIComponent(asset)}?timeframe=${tf}`,
};

// ─── ASSETS ────────────────────────────────────────────────────────────────
const ASSETS = [
  { id: 'BTC',     label: 'BTC/USD',  type: 'crypto' },
  { id: 'ETH',     label: 'ETH/USD',  type: 'crypto' },
  { id: 'BNB',     label: 'BNB/USD',  type: 'crypto' },
  { id: 'SOL',     label: 'SOL/USD',  type: 'crypto' },
  { id: 'XRP',     label: 'XRP/USD',  type: 'crypto' },
  { id: 'EUR/USD', label: 'EUR/USD',  type: 'forex'  },
  { id: 'GBP/USD', label: 'GBP/USD',  type: 'forex'  },
  { id: 'USD/JPY', label: 'USD/JPY',  type: 'forex'  },
];

// ─── STATE ─────────────────────────────────────────────────────────────────
const Bot = {
  key: null,
  email: null,
  sessionToken: null,
  username: null,
  balance: 0,
  currency: 'USD',
  active: false,
  mode: 'autopilot',     // 'autopilot' | 'copilot'
  asset: 'BTC',
  confidence: 60,        // min confidence threshold %
  maxSignals: 20,
  tradesCount: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  stake: 10,
  duration: 60,
  lastTradeTime: 0,
  tickerInterval: null,
  balanceInterval: null,
  signalTimeout: null,
  pendingSignal: null,
  priceCache: {},        // asset -> { price, prev }
  activeTrades: {},      // trade_id -> interval_id (for polling result)
};

// ─── INIT ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Restore saved session if exists
  const savedKey = localStorage.getItem('tbb_active_key');
  const savedToken = localStorage.getItem('tbb_session_token');
  const savedEmail = localStorage.getItem('tbb_email');
  const savedUsername = localStorage.getItem('tbb_username');

  if (savedKey && savedToken && savedEmail) {
    Bot.key = savedKey;
    Bot.sessionToken = savedToken;
    Bot.email = savedEmail;
    Bot.username = savedUsername || 'User';
    Bot.balance = parseFloat(localStorage.getItem('tbb_balance') || '0');
    showBotScreen();
    showToast('🔑 Session restored successfully!', 'info');
  }

  // Populate assets picker
  const assetSel = document.getElementById('bot-asset-select');
  if (assetSel) {
    ASSETS.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.label;
      assetSel.appendChild(opt);
    });
  }

  // Build ticker
  buildTicker();

  // Restore form settings
  const savedAsset = localStorage.getItem('tbb_asset') || 'BTC';
  if (assetSel) assetSel.value = savedAsset;
  const savedMode = localStorage.getItem('tbb_mode') || 'autopilot';
  setMode(savedMode);
  
  const durationSel = document.getElementById('bot-duration-select');
  if (durationSel) {
    durationSel.value = localStorage.getItem('tbb_duration') || '60';
  }
  
  const stakeSel = document.getElementById('bot-stake-select');
  if (stakeSel) {
    stakeSel.value = localStorage.getItem('tbb_stake') || '10';
  }

  const confidenceInput = document.getElementById('bot-confidence');
  if (confidenceInput) {
    confidenceInput.value = localStorage.getItem('tbb_confidence') || '70';
  }

  // Restore stats
  Bot.wins    = parseInt(localStorage.getItem('tbb_wins')   || '0');
  Bot.losses  = parseInt(localStorage.getItem('tbb_losses') || '0');
  Bot.profit  = parseFloat(localStorage.getItem('tbb_profit') || '0');
  Bot.tradesCount = parseInt(localStorage.getItem('tbb_trades_count') || '0');
  syncStats();

  // Populate Platform URL input only if explicitly saved by user (no defaults)
  const apiUrlInput = document.getElementById('api-url-input');
  if (apiUrlInput) {
    const saved = localStorage.getItem('tbb_api_url') || '';
    if (saved.includes('gxmmarket.com') || saved.includes('gainexmarket.com') || saved.includes('127.0.0.1') || saved.includes('localhost')) {
      apiUrlInput.value = '';
    } else {
      apiUrlInput.value = saved;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATION (TWO-STEP LINKING)
// ═══════════════════════════════════════════════════════════════════════════
function submitEmailFirst() {
  const apiUrlInput = document.getElementById('api-url-input');
  const input = document.getElementById('email-input');
  const email = input.value.trim();

  if (apiUrlInput) {
    const enteredUrl = apiUrlInput.value.trim();
    if (enteredUrl) {
      if (!enteredUrl.startsWith('http://') && !enteredUrl.startsWith('https://')) {
        showToast('⚠️ Platform URL must start with http:// or https://', 'error');
        return;
      }
      updateGainexApiUrl(enteredUrl);
    }
  }

  if (!email) {
    showToast('⚠️ Please enter your Platform Account Email.', 'error');
    return;
  }

  // Proceed directly to Step 2 (Activation Key) without error blocking
  Bot.email = email;
  localStorage.setItem('tbb_email', email);
  const hint = document.getElementById('linking-email-hint'); if (hint) hint.textContent = email;
  document.getElementById('auth-step-1').style.display = 'none';
  document.getElementById('auth-step-2').style.display = 'block';
}

async function submitKeySecond() {
  const input = document.getElementById('key-input');
  const btn   = document.getElementById('btn-link');
  const key   = input.value.trim().toUpperCase();

  if (!key) {
    showToast('⚠️ Please enter your activation key.', 'error');
    return;
  }

  if (!Bot.email) {
    Bot.email = localStorage.getItem('tbb_email') || document.getElementById('linking-email-hint')?.textContent?.trim() || '';
  }

  if (!Bot.email) {
    showToast('⚠️ Please enter your email first.', 'error');
    goToAuthStep1();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Activating bot…';

  try {
    const res = await fetch(API.linkAccount, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, email: Bot.email }),
    });
    
    let data = {};
    try {
      data = await res.json();
    } catch (parseErr) {
      // Non-JSON response
    }

    if (!res.ok || !data.success) {
      let errMsg = data.error || (res.status === 404 ? 'API endpoint not found. Please check Platform URL.' : 'Failed to activate. Server returned error (' + res.status + ').');
      errMsg = errMsg.replace(/No Gain EX account found with that email\.?/gi, 'Invalid account email or activation key. Please contact support.');
      errMsg = errMsg.replace(/Gain EX/gi, '');
      showToast('❌ ' + errMsg, 'error');
      btn.disabled = false;
      btn.textContent = '🚀 Link & Activate';
      return;
    }

    // Success
    Bot.key = key;
    Bot.sessionToken = data.session_token;
    Bot.username = data.username;
    Bot.balance = data.balance;
    Bot.currency = data.currency || 'USD';

    if (data.wins !== undefined) Bot.wins = data.wins;
    if (data.losses !== undefined) Bot.losses = data.losses;
    if (data.tradesCount !== undefined) Bot.tradesCount = data.tradesCount;
    if (data.profit !== undefined) Bot.profit = data.profit;

    localStorage.setItem('tbb_active_key', Bot.key);
    localStorage.setItem('tbb_session_token', Bot.sessionToken);
    localStorage.setItem('tbb_email', Bot.email);
    localStorage.setItem('tbb_username', Bot.username);
    localStorage.setItem('tbb_balance', Bot.balance);

    localStorage.setItem('tbb_wins', Bot.wins);
    localStorage.setItem('tbb_losses', Bot.losses);
    localStorage.setItem('tbb_trades_count', Bot.tradesCount);
    localStorage.setItem('tbb_profit', Bot.profit);

    showBotScreen();
    showToast('🚀 Account linked and key activated!', 'success');
  } catch (err) {
    showToast('❌ Linking failed. Check your server connection.', 'error');
    btn.disabled = false;
    btn.textContent = '🚀 Link & Activate';
  }
}

function goToAuthStep1() {
  document.getElementById('auth-step-2').style.display = 'none';
  document.getElementById('auth-step-1').style.display = 'block';
  const btn = document.getElementById('btn-verify-email');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Next Step ➔';
  }
}

async function logout() {
  if (Bot.active) stopBot();
  
  if (Bot.sessionToken) {
    try {
      await fetch(API.unlinkAccount, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: Bot.sessionToken }),
      });
    } catch (e) {}
  }

  // Clear states
  Bot.key = null;
  Bot.email = null;
  Bot.sessionToken = null;
  Bot.username = null;

  localStorage.removeItem('tbb_active_key');
  localStorage.removeItem('tbb_session_token');
  localStorage.removeItem('tbb_email');
  localStorage.removeItem('tbb_username');

  // Clear active trade intervals
  for (const tid in Bot.activeTrades) {
    clearInterval(Bot.activeTrades[tid]);
  }
  Bot.activeTrades = {};

  clearInterval(Bot.balanceInterval);
  Bot.balanceInterval = null;

  document.getElementById('screen-auth').style.display = 'flex';
  document.getElementById('auth-step-2').style.display = 'none';
  document.getElementById('auth-step-1').style.display = 'block';
  document.getElementById('screen-bot').classList.remove('active');
  document.getElementById('key-input').value = '';
  document.getElementById('email-input').value = '';
  
  goToAuthStep1();
  showToast('👋 Unlinked and signed out.', 'info');
}

function showBotScreen() {
  document.getElementById('screen-auth').style.display = 'none';
  document.getElementById('screen-bot').classList.add('active');
  
  document.getElementById('key-display-badge').textContent = Bot.key;
  document.getElementById('linked-account-display').textContent = `${Bot.username} (${Bot.email})`;
  
  syncStats();
  startTickerPolling();
  startBalancePolling();
  
  logMsg('info', `🤖 Trading Boy Bot linked to ${Bot.username}. Configure stake and press Start.`);
}

// ─── MODE ────────────────────────────────────────────────────────────────────
function setMode(mode) {
  Bot.mode = mode;
  localStorage.setItem('tbb_mode', mode);
  document.querySelectorAll('.mode-tab').forEach(el => el.classList.toggle('active', el.dataset.mode === mode));
}

// ─── BOT CONTROL ─────────────────────────────────────────────────────────────
function startBot() {
  if (Bot.active) return;
  Bot.asset       = document.getElementById('bot-asset-select')?.value || 'BTC';
  Bot.duration    = parseInt(document.getElementById('bot-duration-select')?.value) || 60;

  if (Bot.duration > 60) {
    showToast('❌ max trade time can be 1 min', 'error');
    logMsg('warn', '❌ max trade time can be 1 min');
    return;
  }

  Bot.stake       = parseFloat(document.getElementById('bot-stake-select')?.value) || 10;
  Bot.confidence  = parseInt(document.getElementById('bot-confidence')?.value) || 70;

  localStorage.setItem('tbb_asset', Bot.asset);
  localStorage.setItem('tbb_duration', Bot.duration);
  localStorage.setItem('tbb_stake', Bot.stake);
  localStorage.setItem('tbb_confidence', Bot.confidence);

  Bot.active = true;

  syncBotUI();
  clearSignals();
  logMsg('info', `🚀 Bot started — monitoring ${Bot.asset}, Auto-trading with $${Bot.stake} stake (${Bot.duration}s duration).`);

  // First analysis cycle
  Bot.signalTimeout = setTimeout(runSignalCycle, 3000 + Math.random() * 3000);
}

function stopBot() {
  if (!Bot.active) return;
  Bot.active = false;
  clearTimeout(Bot.signalTimeout);
  Bot.signalTimeout = null;
  closeCopilotModal();
  syncBotUI();
  logMsg('info', '⏹ Bot stopped.');
}

async function runSignalCycle() {
  if (!Bot.active) return;

  // Enforce flat 60s cooldown/delay between trades regardless of selected duration
  let requiredInterval = 60000; // 60s
  if (Bot.duration > 60) {
    showToast('❌ max trade time can be 1 min', 'error');
    logMsg('warn', '❌ max trade time can be 1 min');
    stopBot();
    return;
  }

  const timeSinceLastTrade = Date.now() - Bot.lastTradeTime;
  if (timeSinceLastTrade < requiredInterval) {
    const remainingTime = requiredInterval - timeSinceLastTrade;
    Bot.signalTimeout = setTimeout(runSignalCycle, Math.max(1000, remainingTime));
    return;
  }

  const signal = await analyzeMarket(Bot.asset);
  if (!signal) {
    Bot.signalTimeout = setTimeout(runSignalCycle, 5000 + Math.random() * 5000);
    return;
  }

  if (Bot.mode === 'copilot') {
    Bot.pendingSignal = signal;
    openCopilotModal(signal);
  } else {
    // Autopilot: Auto execution
    executeAutoTrade(signal);
  }

  // Schedule next signal analysis cycle
  const nextDelay = 15000 + Math.random() * 15000; // 15–30s interval
  Bot.signalTimeout = setTimeout(runSignalCycle, nextDelay);
}

// ─── MARKET ANALYSIS ─────────────────────────────────────────────────────────
async function analyzeMarket(assetId) {
  try {
    const res = await fetch(API.candles(assetId, '1m'));
    if (!res.ok) throw new Error('candles fetch failed');
    const data = await res.json();
    const candles = data.candles;
    if (!Array.isArray(candles) || candles.length < 20) throw new Error('insufficient candle history');

    const closes = candles.map(c => c.close);

    // RSI (14)
    const rsi = calcRSI(closes, 14);
    // EMA (9 and 21)
    const ema9  = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    
    const last5 = closes.slice(-5);
    const momentum = last5[last5.length - 1] - last5[0];
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];

    let buyScore = 0, sellScore = 0;

    if (rsi < 35) buyScore  += 35;
    if (rsi > 65) sellScore += 35;
    if (rsi < 50) buyScore  += 10; else sellScore += 10;

    if (ema9 > ema21) buyScore  += 25; else sellScore += 25;
    if (momentum > 0) buyScore  += 20; else sellScore += 20;
    if (lastClose > prevClose) buyScore += 15; else sellScore += 15;

    const total = buyScore + sellScore;
    const direction = buyScore >= sellScore ? 'buy' : 'sell';
    const rawConf   = Math.round((Math.max(buyScore, sellScore) / total) * 100);
    const confidence= Math.min(95, Math.max(55, rawConf));

    logMsg('info', `📊 Scanned ${getAssetLabel(assetId)}: Signal: ${direction.toUpperCase()} (${confidence}% confidence, threshold: ${Bot.confidence}%).`);

    if (confidence < Bot.confidence) {
      logMsg('info', `⏸ Signal strength below threshold (${confidence}% < ${Bot.confidence}%). Scanning continues...`);
      return null;
    }

    return {
      asset: assetId,
      direction,
      confidence,
      rsi: rsi.toFixed(1),
      price: lastClose,
      timestamp: new Date(),
    };
  } catch (err) {
    logMsg('warn', `⚠️ Market Analysis error for ${getAssetLabel(assetId)}: ${err.message}`);
    return null;
  }
}

// ─── INDICATORS ──────────────────────────────────────────────────────────────
function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ─── EXECUTE TRADE ───────────────────────────────────────────────────────────
async function executeAutoTrade(signal) {
  logMsg('info', `📡 Placing trade for ${getAssetLabel(signal.asset)} (${signal.direction.toUpperCase()}) with confidence ${signal.confidence}%…`);
  
  try {
    const response = await fetch(API.placeTrade, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_token: Bot.sessionToken,
        coin: signal.asset,
        direction: signal.direction === 'buy' ? 'UP' : 'DOWN',
        amount: Bot.stake,
        duration: Bot.duration
      })
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      logMsg('warn', `❌ Trade rejected: ${data.error || 'Unknown error'}`);
      showToast(`❌ Trade Rejected: ${data.error || 'Check balance'}`, 'error');
      return;
    }

    // Trade placed successfully
    Bot.lastTradeTime = Date.now();
    Bot.tradesCount++;
    localStorage.setItem('tbb_trades_count', Bot.tradesCount);
    
    // Update local balance immediately
    if (data.balance !== undefined) {
      Bot.balance = data.balance;
      syncStats();
    }

    const tradeId = data.trade_id;
    logMsg('signal', `🚀 Trade #${tradeId} Executed! Price: ${formatPrice(data.open_price, signal.asset)} &bull; Duration: ${Bot.duration}s`);
    
    // Display the signal
    const uiSignal = {
      id: tradeId,
      asset: signal.asset,
      direction: signal.direction,
      confidence: signal.confidence,
      price: data.open_price,
      rsi: signal.rsi,
      timestamp: signal.timestamp,
      status: 'active'
    };
    displaySignal(uiSignal);

    // Poll outcomes
    pollTradeResult(tradeId);

  } catch (err) {
    logMsg('warn', `⚠️ Network error placing auto-trade: ${err.message}`);
  }
}

// ─── POLL OUTCOME ────────────────────────────────────────────────────────────
function pollTradeResult(tradeId) {
  if (Bot.activeTrades[tradeId]) return;

  const pollInterval = setInterval(async () => {
    try {
      const res = await fetch(API.tradeResult(tradeId, Bot.sessionToken));
      if (!res.ok) return;
      const data = await res.json();

      if (data.success && data.status !== 'active') {
        // Trade resolved! Clear polling
        clearInterval(pollInterval);
        delete Bot.activeTrades[tradeId];

        // Update stats
        if (data.status === 'win') {
          Bot.wins++;
          Bot.profit += data.profit;
          localStorage.setItem('tbb_wins', Bot.wins);
          showToast(`🏆 Trade #${tradeId} Won! +$${data.profit.toFixed(2)}`, 'success');
          logMsg('info', `🏆 Trade #${tradeId} Closed WIN: +$${data.profit.toFixed(2)} (Close: ${formatPrice(data.close_price, data.coin)})`);
        } else if (data.status === 'lose') {
          Bot.losses++;
          Bot.profit += data.profit; // profit is negative
          localStorage.setItem('tbb_losses', Bot.losses);
          showToast(`📉 Trade #${tradeId} Lost. -$${Math.abs(data.profit).toFixed(2)}`, 'error');
          logMsg('info', `📉 Trade #${tradeId} Closed LOSS: -$${Math.abs(data.profit).toFixed(2)} (Close: ${formatPrice(data.close_price, data.coin)})`);
        }
        
        localStorage.setItem('tbb_profit', Bot.profit);

        if (data.balance !== undefined) {
          Bot.balance = data.balance;
        }

        // Update UI
        updateSignalStatus(tradeId, data.status, data.close_price, data.profit);
        syncStats();
      }
    } catch (e) {
      console.warn(`Polling error for trade #${tradeId}:`, e.message);
    }
  }, 2000);

  Bot.activeTrades[tradeId] = pollInterval;
}

// ─── SIGNAL DISPLAY ──────────────────────────────────────────────────────────
const MAX_SIGNALS = 10;
const _signals = [];

function displaySignal(signal) {
  _signals.unshift(signal);
  if (_signals.length > MAX_SIGNALS) _signals.pop();
  renderSignals();
}

function updateSignalStatus(tradeId, status, closePrice, profit) {
  const signal = _signals.find(s => s.id === tradeId);
  if (signal) {
    signal.status = status;
    signal.closePrice = closePrice;
    signal.profit = profit;
    renderSignals();
  }
}

function renderSignals() {
  const list = document.getElementById('signals-list');
  if (!list) return;
  if (_signals.length === 0) {
    list.innerHTML = '<div class="signal-empty">⏳ Waiting for signals…</div>';
    return;
  }
  
  list.innerHTML = _signals.map(s => {
    const isBuy = s.direction === 'buy';
    const timeAgo = formatTimeAgo(s.timestamp);
    
    let statusClass = 'pending';
    let statusText = 'ACTIVE';
    if (s.status === 'win') {
      statusClass = 'buy';
      statusText = `🏆 WIN (+$${s.profit.toFixed(2)})`;
    } else if (s.status === 'lose') {
      statusClass = 'sell';
      statusText = `📉 LOSS (-$${Math.abs(s.profit).toFixed(2)})`;
    }

    return `<div class="signal-item ${isBuy ? 'buy' : 'sell'}">
      <div class="signal-dir-badge">${isBuy ? '⬆️' : '⬇️'}</div>
      <div class="signal-info">
        <div class="signal-asset">${getAssetLabel(s.asset)}</div>
        <div class="signal-detail">Open: ${formatPrice(s.price, s.asset)} &bull; RSI ${s.rsi} &bull; ${timeAgo}</div>
        ${s.closePrice ? `<div class="signal-detail" style="color:var(--text-dim);">Close Price: ${formatPrice(s.closePrice, s.asset)}</div>` : ''}
      </div>
      <div>
        <div class="signal-dir-label">${isBuy ? 'BUY ↑' : 'SELL ↓'}</div>
        <div class="signal-conf" style="font-weight: bold; font-size:12px; color: ${s.status === 'active' ? 'var(--warning)' : (s.status === 'win' ? 'var(--primary)' : 'var(--danger)')};">${statusText}</div>
      </div>
    </div>`;
  }).join('');
}

function clearSignals() {
  _signals.length = 0;
  renderSignals();
}

function getAssetLabel(assetId) {
  const a = ASSETS.find(x => x.id === assetId);
  return a ? a.label : assetId;
}

function formatPrice(p, assetId) {
  if (!p) return '—';
  const isForex = assetId && assetId.includes('/') && !assetId.includes('OTC');
  return isForex ? p.toFixed(4) : p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTimeAgo(ts) {
  const secs = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

// ─── COPILOT MODAL ───────────────────────────────────────────────────────────
let _copilotCountdown = null;

function openCopilotModal(signal) {
  const modal   = document.getElementById('copilot-modal');
  const dirEl   = document.getElementById('copilot-dir');
  const metaEl  = document.getElementById('copilot-meta');
  const timerEl = document.getElementById('copilot-timer');
  if (!modal) return;

  const isBuy = signal.direction === 'buy';
  dirEl.textContent = isBuy ? '⬆ BUY' : '⬇ SELL';
  dirEl.className   = `copilot-direction ${signal.direction}`;
  metaEl.textContent = `${getAssetLabel(signal.asset)} — ${signal.confidence}% confidence`;

  modal.classList.add('open');

  let count = 15;
  timerEl.textContent = `Auto-skip in ${count}s`;
  _copilotCountdown = setInterval(() => {
    count--;
    timerEl.textContent = `Auto-skip in ${count}s`;
    if (count <= 0) skipSignal();
  }, 1000);
}

function confirmSignal() {
  const signal = Bot.pendingSignal;
  if (!signal) return;
  closeCopilotModal();
  executeAutoTrade(signal);
}

function skipSignal() {
  closeCopilotModal();
  logMsg('info', '⏭ Signal skipped.');
  Bot.pendingSignal = null;
}

function closeCopilotModal() {
  clearInterval(_copilotCountdown);
  _copilotCountdown = null;
  const modal = document.getElementById('copilot-modal');
  if (modal) modal.classList.remove('open');
  Bot.pendingSignal = null;
}

// ─── STATS & BALANCE POLLING ─────────────────────────────────────────────────
function startBalancePolling() {
  clearInterval(Bot.balanceInterval);
  
  const fetchBalance = async () => {
    if (!Bot.sessionToken) return;
    try {
      const res = await fetch(API.balance(Bot.sessionToken));
      if (!res.ok) {
        if (res.status === 401) {
          // Session expired on backend
          logout();
          showToast('⚠️ Your bot session has expired. Please link again.', 'error');
        }
        return;
      }
      const data = await res.json();
      if (data.success) {
        Bot.balance = data.balance;
        Bot.currency = data.currency || 'USD';
        localStorage.setItem('tbb_balance', Bot.balance);
        
        if (data.wins !== undefined) Bot.wins = data.wins;
        if (data.losses !== undefined) Bot.losses = data.losses;
        if (data.tradesCount !== undefined) Bot.tradesCount = data.tradesCount;
        if (data.profit !== undefined) Bot.profit = data.profit;

        localStorage.setItem('tbb_wins', Bot.wins);
        localStorage.setItem('tbb_losses', Bot.losses);
        localStorage.setItem('tbb_trades_count', Bot.tradesCount);
        localStorage.setItem('tbb_profit', Bot.profit);

        syncStats();
      }
    } catch (e) {}
  };

  fetchBalance();
  Bot.balanceInterval = setInterval(fetchBalance, 5000); // refresh balance every 5s
}

function syncStats() {
  const wEl = document.getElementById('stat-wins');
  const lEl = document.getElementById('stat-losses');
  const sEl = document.getElementById('stat-signals');
  const pEl = document.getElementById('stat-profit');
  
  if (wEl) wEl.textContent = Bot.wins;
  if (lEl) lEl.textContent = Bot.losses;
  if (sEl) sEl.textContent = Bot.tradesCount;
  
  const profitSign = Bot.profit >= 0 ? '+' : '';
  if (pEl) {
    pEl.textContent = `${profitSign}$${Math.abs(Bot.profit).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    pEl.className = 'stat-val ' + (Bot.profit >= 0 ? 'positive' : 'negative');
  }

  // Update ticker chip balance if it exists
  const tickerChip = document.getElementById('tick-balance');
  if (tickerChip) {
    tickerChip.querySelector('.tc-price').textContent = `$${Bot.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // Update linked balance display if it exists
  const formattedBalance = typeof Bot.balance === 'number'
    ? Bot.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : parseFloat(Bot.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const curr = Bot.currency || 'USD';

  const balanceVal = document.getElementById('balance-val');
  if (balanceVal) {
    balanceVal.textContent = `${formattedBalance} ${curr}`;
  }
  const linkedBalance = document.getElementById('linked-balance-display');
  if (linkedBalance) {
    linkedBalance.textContent = `${formattedBalance} ${curr}`;
  }
}

function resetStats() {
  Bot.wins = 0; Bot.losses = 0; Bot.profit = 0; Bot.tradesCount = 0;
  localStorage.setItem('tbb_wins', '0');
  localStorage.setItem('tbb_losses', '0');
  localStorage.setItem('tbb_profit', '0');
  localStorage.setItem('tbb_trades_count', '0');
  syncStats();
  showToast('🔄 Bot stats reset.', 'info');
}

function syncBotUI() {
  const startBtn = document.getElementById('btn-start');
  const stopBtn  = document.getElementById('btn-stop');
  const livePill = document.getElementById('live-pill');
  const statusDot = document.getElementById('header-status');
  const configEls = document.querySelectorAll('.disable-when-active');

  if (startBtn) startBtn.style.display = Bot.active ? 'none' : 'flex';
  if (stopBtn)  stopBtn.style.display  = Bot.active ? 'flex' : 'none';
  if (livePill) livePill.classList.toggle('hidden', !Bot.active);
  
  if (statusDot) {
    statusDot.className = Bot.active ? 'tbb-status-dot active' : 'tbb-status-dot';
    statusDot.querySelector('span:last-child').textContent = Bot.active ? 'Running' : 'Stopped';
  }
  
  configEls.forEach(el => el.disabled = Bot.active);
  syncStats();
}

// ─── PRICE TICKER ────────────────────────────────────────────────────────────
const TICKER_ASSETS = ['BTC','ETH','BNB','SOL','XRP','EUR/USD','GBP/USD'];

function buildTicker() {
  const bar = document.getElementById('ticker-bar');
  if (!bar) return;
  bar.innerHTML = `
    <div class="ticker-chip" id="tick-balance" style="border-color: rgba(59,130,246,0.3); background: rgba(59,130,246,0.05);">
      <span class="tc-name" style="color: #3b82f6;">💰 BALANCE</span>
      <span class="tc-price" style="color: #fff; font-weight: bold;">$0.00</span>
    </div>
  ` + TICKER_ASSETS.map(a => {
    const label = getAssetLabel(a);
    return `<div class="ticker-chip" id="tick-${a.replace('/','_')}">
      <span class="tc-name">${label}</span>
      <span class="tc-price" id="tick-price-${a.replace('/','_')}">—</span>
    </div>`;
  }).join('');
}

function startTickerPolling() {
  fetchAllPrices();
  if (Bot.tickerInterval) clearInterval(Bot.tickerInterval);
  Bot.tickerInterval = setInterval(fetchAllPrices, 3000);
}

async function fetchAllPrices() {
  for (const assetId of TICKER_ASSETS) {
    fetchPrice(assetId);
  }
}

async function fetchPrice(assetId) {
  try {
    const res = await fetch(API.price(assetId));
    if (!res.ok) return;
    const { price } = await res.json();
    updateTickerChip(assetId, price);
  } catch {}
}

function updateTickerChip(assetId, price) {
  const key = assetId.replace('/', '_');
  const chip  = document.getElementById(`tick-${key}`);
  const priceEl = document.getElementById(`tick-price-${key}`);
  if (!priceEl || !chip) return;
  const prev = Bot.priceCache[assetId];
  Bot.priceCache[assetId] = price;

  const isForex = assetId.includes('/');
  const formatted = isForex
    ? price.toFixed(4)
    : '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  priceEl.textContent = formatted;
  if (prev !== undefined) {
    chip.className = 'ticker-chip ' + (price >= prev ? 'up' : 'down');
  }
}

// ─── ACTIVITY LOG ────────────────────────────────────────────────────────────
function logMsg(type, message) {
  const log = document.getElementById('bot-log');
  if (!log) return;

  const emptyEl = log.querySelector('.log-empty');
  if (emptyEl) emptyEl.remove();

  const iconMap = { signal: '📡', info: 'ℹ️', warn: '⚠️' };
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `
    <span class="log-icon">${iconMap[type] || 'ℹ️'}</span>
    <span class="log-msg">${message}</span>
    <span class="log-time">${now}</span>
  `;
  log.prepend(entry);

  const entries = log.querySelectorAll('.log-entry');
  if (entries.length > 60) entries[entries.length - 1].remove();
}

function clearLog() {
  const log = document.getElementById('bot-log');
  if (log) log.innerHTML = '<div class="log-empty">Log cleared.</div>';
}

// ─── TOASTS ──────────────────────────────────────────────────────────────────
function showToast(msg, type, duration) {
  if (!type) type = 'info';
  if (!duration) duration = 4500;

  var container = document.getElementById('tbb-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'tbb-toast-container';
    document.body.appendChild(container);
  }

  var normType = 'info';
  var badgeText = 'Notice';
  var iconSvg = '';

  if (type === 'error' || type === 'danger') {
    normType = 'error';
    badgeText = 'Action Required';
    iconSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
  } else if (type === 'success') {
    normType = 'success';
    badgeText = 'Success';
    iconSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>';
  } else if (type === 'warn' || type === 'warning') {
    normType = 'warn';
    badgeText = 'Warning';
    iconSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
  } else {
    normType = 'info';
    badgeText = 'System Info';
    iconSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
  }

  var raw = String(msg || '').trim();
  var cleanMsg = raw.replace(/^[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\x20-\x7E]+/g, '').trim();
  if (!cleanMsg && raw) cleanMsg = raw;

  var toast = document.createElement('div');
  toast.className = 'tbb-toast toast-' + normType;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = [
    '<div class="tbb-toast-glow"></div>',
    '<div class="tbb-toast-icon-wrap">' + iconSvg + '</div>',
    '<div class="tbb-toast-body">',
    '  <div class="tbb-toast-top-row">',
    '    <span class="tbb-toast-badge">' + badgeText + '</span>',
    '    <span class="tbb-toast-time">Just now</span>',
    '  </div>',
    '  <div class="tbb-toast-msg">' + cleanMsg + '</div>',
    '</div>',
    '<button type="button" class="tbb-toast-close" aria-label="Close notification">',
    '  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">',
    '    <line x1="18" y1="6" x2="6" y2="18"></line>',
    '    <line x1="6" y1="6" x2="18" y2="18"></line>',
    '  </svg>',
    '</button>',
    '<div class="tbb-toast-progress-wrap">',
    '  <div class="tbb-toast-progress-bar" style="animation-duration: ' + duration + 'ms;"></div>',
    '</div>'
  ].join('\n');

  function dismissToast(el) {
    if (!el || !el.parentElement) return;
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(function() {
      if (el.parentElement) el.remove();
    }, 380);
  }

  var closeBtn = toast.querySelector('.tbb-toast-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() { dismissToast(toast); });
  }

  container.appendChild(toast);

  requestAnimationFrame(function() {
    requestAnimationFrame(function() { toast.classList.add('show'); });
  });

  var remainingTime = duration;
  var startTime = Date.now();
  var timer = null;

  function startTimer() {
    startTime = Date.now();
    timer = setTimeout(function() {
      dismissToast(toast);
    }, remainingTime);
  }

  startTimer();

  toast.addEventListener('mouseenter', function() {
    var elapsed = Date.now() - startTime;
    remainingTime = Math.max(1000, remainingTime - elapsed);
    clearTimeout(timer);
    var bar = toast.querySelector('.tbb-toast-progress-bar');
    if (bar) bar.style.animationPlayState = 'paused';
  });

  toast.addEventListener('mouseleave', function() {
    var bar = toast.querySelector('.tbb-toast-progress-bar');
    if (bar) bar.style.animationPlayState = 'running';
    startTimer();
  });
}

// ─── UTILS ───────────────────────────────────────────────────────────────────
function handleKeyEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitKeySecond();
  }
}
function handleEmailEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitEmailFirst();
  }
}


// ════════════════════════════════════════════════════════════════════════════
// MULTI-PAGE & DYNAMIC SERVICES CLIENT INTEGRATION
// ════════════════════════════════════════════════════════════════════════════

function toggleMobileNav() {
  const menu = document.getElementById('tbb-nav-menu');
  if (menu) {
    menu.classList.toggle('open');
  }
}

/**
 * Fetch active bot services, real-time prices, and countdown timers from the Gain EX backend
 * and dynamically populate pricing across Landing, Services, and Pricing pages.
 */
const DEFAULT_SERVICES = [
  { service_key: 'gxm_bot', name: 'GXM Quantitative Bot', price: '70', actual_price: '189', offer_timer_enabled: false, offer_ends_at: null, logo_url: '/logos/gxm.png' },
  { service_key: 'quotex_bot', name: 'Quotex Binary Scalper', price: '99', actual_price: '99', offer_timer_enabled: false, offer_ends_at: null, logo_url: '/logos/quotex.png' },
  { service_key: 'mt5_bot', name: 'MetaTrader 5 (MT5) Bot', price: '189', actual_price: '189', offer_timer_enabled: false, offer_ends_at: null, logo_url: '/logos/mt5.png' },
  { service_key: 'deriv_bot', name: 'Deriv Synthetic Indices', price: '89', actual_price: '89', offer_timer_enabled: false, offer_ends_at: null, logo_url: '/logos/deriv.jpg' },
  { service_key: 'bybit_bot', name: 'Bybit Futures Sniper', price: '129', actual_price: '129', offer_timer_enabled: false, offer_ends_at: null, logo_url: '/logos/bybit.png' },
  { service_key: 'binance_bot', name: 'Binance Pro Algorithmic', price: '139', actual_price: '139', offer_timer_enabled: false, offer_ends_at: null, logo_url: '/logos/binance.webp' }
];

let globalServerClockOffset = 0;
let globalPublicServices = DEFAULT_SERVICES;
let serviceTimerTickerInterval = null;

function getTbbApiBase() {
  if (typeof GAINEX_API !== 'undefined' && GAINEX_API) {
    return GAINEX_API.replace(/\/$/, '');
  }
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('tbb_api_url');
    if (saved && saved.trim() !== '' && !saved.includes('gxmmarket.com')) {
      return saved.trim().replace(/\/$/, '');
    }
    const host = window.location.hostname;
    const port = window.location.port;
    const protocol = window.location.protocol;
    if (protocol === 'file:' || !host || host === 'localhost' || host === '127.0.0.1') {
      return (port === '3000') ? window.location.origin : 'http://localhost:3000';
    }
    if (host.includes('gainexmarket.com')) {
      return window.location.origin;
    }
  }
  return 'https://gainexmarket.com';
}

function formatCleanPrice(p) {
  if (p === undefined || p === null || p === '') return '149';
  return String(p).replace(/[^0-9.]/g, '');
}

function computeServicePricing(svc) {
  const now = Date.now() - globalServerClockOffset;
  const offerPriceClean = formatCleanPrice(svc.price);
  const actualPriceClean = (svc.actual_price !== undefined && svc.actual_price !== null && String(svc.actual_price).trim() !== '') 
    ? formatCleanPrice(svc.actual_price) 
    : offerPriceClean;

  // Determine timer end timestamp
  let offerEnds = 0;
  if (svc.offer_ends_at) {
    const parsed = new Date(svc.offer_ends_at).getTime();
    if (!isNaN(parsed)) offerEnds = parsed;
  }

  // Timer is ONLY configured if admin explicitly enabled it AND set an expiration date
  const isTimerConfigured = !!(
    (svc.offer_timer_enabled === true || svc.offer_timer_enabled === 'true' || svc.offer_timer_enabled === 1 || svc.offer_timer_enabled === '1') &&
    offerEnds > 0
  );

  const isTimerActive = isTimerConfigured && (offerEnds > now);

  // Active price: promotional offer price while timer is active; actual regular price when timer reaches 00:00:00 or when timer is not configured
  let effectivePrice = offerPriceClean;
  if (isTimerConfigured) {
    effectivePrice = isTimerActive ? offerPriceClean : actualPriceClean;
  } else {
    effectivePrice = offerPriceClean;
  }

  const showActualPrice = isTimerActive && (parseFloat(actualPriceClean) > parseFloat(offerPriceClean));

  const diffMs = Math.max(0, offerEnds - now);
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const secs = Math.floor((diffMs % (1000 * 60)) / 1000);

  return {
    isTimerConfigured,
    isTimerActive,
    effectivePrice,
    offerPriceClean,
    actualPriceClean,
    showActualPrice,
    days,
    hours,
    mins,
    secs,
    diffMs
  };
}

function tickAllServiceTimers() {
  if (!globalPublicServices || !globalPublicServices.length) return;

  globalPublicServices.forEach(svc => {
    const pricing = computeServicePricing(svc);

    // 1. Update Price Displays in Pricing & Services Pages
    const priceContainers = document.querySelectorAll(`[data-service-price="${svc.service_key}"]`);
    priceContainers.forEach(container => {
      const valEl = container.querySelector('.price-val') || container.querySelector('.amount');
      if (valEl) {
        if (container.classList.contains('price-display')) {
          valEl.textContent = pricing.effectivePrice;
        } else {
          valEl.textContent = `$${pricing.effectivePrice}`;
        }
      }

      const parentCard = container.closest('.pricing-card') || container.closest('.service-card') || container.parentElement;
      if (parentCard) {
        // A. Actual Regular Price Strikethrough Display
        let strikeEl = parentCard.querySelector(`[data-actual-price="${svc.service_key}"]`);
        if (!strikeEl) {
          strikeEl = document.createElement('div');
          strikeEl.className = 'actual-price-strike';
          strikeEl.setAttribute('data-actual-price', svc.service_key);
          container.parentNode.insertBefore(strikeEl, container);
        }

        if (pricing.showActualPrice) {
          strikeEl.innerHTML = `<span class="actual-label">Regular Price:</span> <span class="strike-val">$${pricing.actualPriceClean}</span>`;
          strikeEl.style.display = 'flex';
        } else {
          strikeEl.style.display = 'none';
        }

        // B. Real-Time Countdown Timer Box (ONLY shown if timer is configured by Admin)
        let timerBox = parentCard.querySelector(`[data-timer-box="${svc.service_key}"]`);
        if (!timerBox) {
          timerBox = document.createElement('div');
          timerBox.className = 'pricing-offer-timer-wrap';
          timerBox.setAttribute('data-timer-box', svc.service_key);
          const targetInsert = strikeEl || container;
          targetInsert.parentNode.insertBefore(timerBox, targetInsert);
        }

        if (pricing.isTimerConfigured && pricing.isTimerActive) {
          timerBox.className = 'pricing-offer-timer-wrap';
          const dayHtml = pricing.days > 0 ? `<span class="time-digit-block">${pricing.days}d</span><span class="time-sep">:</span>` : '';
          timerBox.innerHTML = `
            <div class="offer-timer-header">
              <span class="pulse-fire">🔥</span>
              <span class="offer-title">LIMITED TIME OFFER</span>
            </div>
            <div class="offer-countdown-clock">
              ${dayHtml}
              <span class="time-digit-block hours">${String(pricing.hours).padStart(2, '0')}</span>
              <span class="time-sep">:</span>
              <span class="time-digit-block mins">${String(pricing.mins).padStart(2, '0')}</span>
              <span class="time-sep">:</span>
              <span class="time-digit-block secs">${String(pricing.secs).padStart(2, '0')}</span>
            </div>
          `;
          timerBox.style.display = 'flex';
        } else {
          timerBox.style.display = 'none';
        }
      }
    });

    // 2. Update Service Titles if customized
    if (svc.name) {
      const titleEls = document.querySelectorAll(`[data-service-title="${svc.service_key}"]`);
      titleEls.forEach(el => el.textContent = svc.name);
    }

    // 3. Update Logos
    if (svc.logo_url) {
      const iconContainers = document.querySelectorAll(`[data-service-icon="${svc.service_key}"]`);
      iconContainers.forEach(container => {
        let img = container.querySelector('img');
        if (!img) {
          container.innerHTML = `<img src="${svc.logo_url}" class="service-logo-img" alt="${svc.name || 'Bot'}">`;
        } else if (img.src !== svc.logo_url) {
          img.src = svc.logo_url;
        }
      });
    }
  });

  // 4. Update Checkout Dropdown & Order Summary Live
  updateCheckoutLivePricing();
}

function updateCheckoutLivePricing() {
  const select = document.getElementById('serviceSelect');
  if (!select || !globalPublicServices || !globalPublicServices.length) return;

  Array.from(select.options).forEach(opt => {
    const svc = globalPublicServices.find(s => s.service_key === opt.value);
    if (svc) {
      const pricing = computeServicePricing(svc);
      const title = svc.name || svc.title || 'Trading Bot';
      opt.textContent = `${title} — ${pricing.effectivePrice} USD`;
      opt.dataset.price = pricing.effectivePrice;
      opt.dataset.title = title;
    }
  });

  const nameEl = document.getElementById('summaryServiceName');
  const priceEl = document.getElementById('summaryServicePrice');
  if (nameEl && priceEl) {
    const opt = select.selectedOptions[0];
    if (opt) {
      nameEl.textContent = opt.dataset.title || opt.textContent.split('—')[0].trim();
      priceEl.textContent = `$${opt.dataset.price || '170'} USD`;
    }
  }
}

async function loadPublicBotServices() {
  // Run initial ticker on load
  tickAllServiceTimers();

  if (!serviceTimerTickerInterval) {
    serviceTimerTickerInterval = setInterval(tickAllServiceTimers, 1000);
  }

  try {
    const apiUrl = getTbbApiBase();
    const res = await fetch(`${apiUrl}/api/public/bot-services?t=${Date.now()}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success || !Array.isArray(data.services) || !data.services.length) return;

    if (data.server_time) {
      const srvTime = new Date(data.server_time).getTime();
      if (!isNaN(srvTime)) {
        globalServerClockOffset = Date.now() - srvTime;
      }
    }

    globalPublicServices = data.services;
    tickAllServiceTimers();
  } catch (err) {
    console.warn('Public bot services dynamic price sync notice (using defaults):', err);
  }
}

// Auto-run immediately
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPublicBotServices);
  } else {
    loadPublicBotServices();
  }
}

/* ==========================================================================
   TRADINGBOY AI — CLIENT-SIDE UI & INTERACTION CONTROLLER
   Multi-page navigation, Dynamic Catalog, Checkout, FAQ & Animations
   ========================================================================== */

(function() {
  const API_BASE = getTbbApiBase();

  // 1. Mobile Menu Toggle
  function initMobileMenu() {
    const btn = document.getElementById('mobileMenuBtn');
    const nav = document.getElementById('cyberNav');
    if (btn && nav) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        nav.classList.toggle('open');
        btn.classList.toggle('active');
      });
      document.addEventListener('click', (e) => {
        if (!nav.contains(e.target) && !btn.contains(e.target)) {
          nav.classList.remove('open');
          btn.classList.remove('active');
        }
      });
    }
  }

  // 2. FAQ Accordion Handler
  function initFaqAccordion() {
    const items = document.querySelectorAll('.faq-item');
    items.forEach(item => {
      const q = item.querySelector('.faq-question');
      if (q) {
        q.addEventListener('click', () => {
          const isOpen = item.classList.contains('active');
          items.forEach(i => i.classList.remove('active'));
          if (!isOpen) {
            item.classList.add('active');
          }
        });
      }
    });
  }

  // 3. Dynamic Services & Prices Loader
  async function loadDynamicServices() {
    populateServiceDropdown(globalPublicServices);
    tickAllServiceTimers();

    try {
      const res = await fetch(`${API_BASE}/api/public/bot-services?t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.services && Array.isArray(data.services) && data.services.length > 0) {
          globalPublicServices = data.services;
          if (data.server_time) {
            const srvTime = new Date(data.server_time).getTime();
            if (!isNaN(srvTime)) {
              globalServerClockOffset = Date.now() - srvTime;
            }
          }
          populateServiceDropdown(data.services);
          tickAllServiceTimers();
        }
      }
    } catch (e) {
      console.warn('Using default bot catalog fallback:', e.message);
    }
  }

  function populateServiceDropdown(services) {
    const select = document.getElementById('serviceSelect');
    if (!select) return;

    const currentVal = select.value;
    const urlParams = new URLSearchParams(window.location.search);
    const preSelected = urlParams.get('service') || currentVal;

    select.innerHTML = '';
    services.forEach(svc => {
      const opt = document.createElement('option');
      opt.value = svc.service_key;
      const pricing = computeServicePricing(svc);
      const title = svc.name || svc.title || 'Trading Bot';
      opt.textContent = `${title} — ${pricing.effectivePrice} USD`;
      opt.dataset.price = pricing.effectivePrice;
      opt.dataset.title = title;
      if (preSelected && svc.service_key === preSelected) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    if (!select.value && select.options.length > 0) {
      select.options[0].selected = true;
    }

    updateCheckoutSummary();
    select.onchange = updateCheckoutSummary;
  }

  function updateCheckoutSummary() {
    const select = document.getElementById('serviceSelect');
    const nameEl = document.getElementById('summaryServiceName');
    const priceEl = document.getElementById('summaryServicePrice');
    if (!select || !nameEl || !priceEl) return;

    const opt = select.selectedOptions[0];
    if (opt) {
      nameEl.textContent = opt.dataset.title || opt.textContent.split('—')[0].trim();
      priceEl.textContent = `$${opt.dataset.price || '170'} USD`;
    }
  }

  // 4. Dynamic Payment Methods & Checkout System
  let activePaymentMethods = [];
  let currentPaymentCategory = 'crypto'; // 'crypto' or 'ewallet'

  async function loadPaymentMethods() {
    const container = document.getElementById('paymentMethodsList');
    if (!container) return;

    try {
      const res = await fetch(`${API_BASE}/api/public/bot-payment-methods?t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.methods && Array.isArray(data.methods) && data.methods.length > 0) {
          activePaymentMethods = data.methods;
          renderPaymentMethodCards();
          return;
        }
      }
    } catch (e) {
      console.warn('Payment API unavailable, falling back:', e.message);
    }

    // Fallback payment methods if backend is unreachable
    activePaymentMethods = [
      { id: 1, name: 'USDT (TRC-20)', type: 'crypto', address_or_number: 'TRHd1kWKSH3dThNzrsAbzHYcyN5si7eNT4', network_or_bank: 'TRON Network (TRC20)', instructions: 'Send exact amount via TRC-20 network. TXID required.' },
      { id: 2, name: 'USDT (BEP-20)', type: 'crypto', address_or_number: '0xd824fd978acaecd309155ebeee2e91e0924469ac', network_or_bank: 'BNB Smart Chain (BEP20)', instructions: 'Send exact amount via BEP-20 network. TXID required.' },
      { id: 6, name: 'USDT (APTOS)', type: 'crypto', address_or_number: '0xefa7ce01cfbabcc536507e50c0616f762462386eb99349ff26a025c9c01216e0', network_or_bank: 'USDT (Aptos)', instructions: 'Send exact amount. TXID and screenshot proof required.' },
      { id: 4, name: 'SadaPay / Bank Transfer', type: 'ewallet', address_or_number: '03001234567', account_holder: 'Trading Boy Official', network_or_bank: 'SadaPay', instructions: 'Transfer via SadaPay or Raast to the registered number.' },
      { id: 5, name: 'EasyPaisa / JazzCash', type: 'ewallet', address_or_number: '03119876543', account_holder: 'Trading Boy Official', network_or_bank: 'EasyPaisa', instructions: 'Send payment directly and upload payment receipt screenshot.' }
    ];
    renderPaymentMethodCards();
  }

  function renderPaymentMethodCards() {
    const container = document.getElementById('paymentMethodsList');
    if (!container) return;

    const filtered = activePaymentMethods.filter(m => {
      const type = (m.type || m.category || '').toLowerCase();
      if (currentPaymentCategory === 'crypto') {
        return type === 'crypto' || type.includes('crypto') || type.includes('usdt') || type.includes('btc');
      } else {
        return type === 'ewallet' || type === 'bank' || type.includes('wallet') || type.includes('fiat') || type.includes('easypaisa') || type.includes('sadapay');
      }
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="alert-box" style="padding:16px; background:rgba(255,255,255,0.05); border-radius:10px; color:#94a3b8;">No payment methods currently active in this category.</div>';
      const detailsBox = document.getElementById('activePaymentDetails');
      if (detailsBox) detailsBox.style.display = 'none';
      return;
    }

    container.innerHTML = '';
    filtered.forEach((m, idx) => {
      const card = document.createElement('div');
      card.className = `payment-method-item ${idx === 0 ? 'selected' : ''}`;
      card.dataset.id = m.id;
      const title = m.name || m.title || 'Payment Method';
      const sub = m.network_or_bank || (m.type === 'crypto' ? 'Instant Blockchain Verification' : 'Direct Account Transfer');

      card.innerHTML = `
        <div class="pm-radio-dot"></div>
        <div class="pm-info">
          <div class="pm-title">${title}</div>
          <div class="pm-sub">${sub}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        document.querySelectorAll('.payment-method-item').forEach(i => i.classList.remove('selected'));
        card.classList.add('selected');
        selectPaymentMethod(m);
      });
      container.appendChild(card);
    });

    if (filtered.length > 0) {
      selectPaymentMethod(filtered[0]);
    }
  }

  function selectPaymentMethod(m) {
    const detailsBox = document.getElementById('activePaymentDetails');
    const titleEl = document.getElementById('selectedMethodTitle');
    const typeEl = document.getElementById('selectedMethodType');
    const instrEl = document.getElementById('selectedMethodInstructions');
    const addrInput = document.getElementById('depositAddressInput');
    const accountNameRow = document.getElementById('accountNameRow');
    const accountNameVal = document.getElementById('accountNameVal');
    const qrContainer = document.getElementById('qrContainer');
    const qrCodeImg = document.getElementById('qrCodeImg');
    const hiddenPmId = document.getElementById('selectedPaymentMethodId');

    if (!detailsBox) return;

    detailsBox.style.display = 'block';
    if (hiddenPmId) hiddenPmId.value = m.id;
    if (titleEl) titleEl.textContent = `${m.name || m.title || 'Payment Method'} Deposit`;
    if (typeEl) typeEl.textContent = (m.type || m.category || 'Crypto').toUpperCase();
    if (instrEl) instrEl.textContent = m.instructions || 'Transfer the exact amount to the official deposit address below.';
    if (addrInput) addrInput.value = m.address_or_number || m.address || '';

    const holder = m.account_holder || m.account_name;
    if (accountNameRow && accountNameVal) {
      if (holder) {
        accountNameRow.style.display = 'flex';
        accountNameVal.textContent = holder;
      } else {
        accountNameRow.style.display = 'none';
      }
    }

    if (qrContainer && qrCodeImg) {
      if (m.qr_code_url) {
        qrContainer.style.display = 'block';
        qrCodeImg.src = m.qr_code_url;
      } else {
        qrContainer.style.display = 'none';
      }
    }
  }

  // 5. Setup Tabs, Copy Button, File Upload & Checkout Form
  function initCheckoutPage() {
    const tabCrypto = document.getElementById('tabCryptoBtn');
    const tabWallet = document.getElementById('tabWalletBtn');
    if (tabCrypto && tabWallet) {
      tabCrypto.addEventListener('click', () => {
        tabCrypto.classList.add('active');
        tabWallet.classList.remove('active');
        currentPaymentCategory = 'crypto';
        renderPaymentMethodCards();
      });

      tabWallet.addEventListener('click', () => {
        tabWallet.classList.add('active');
        tabCrypto.classList.remove('active');
        currentPaymentCategory = 'ewallet';
        renderPaymentMethodCards();
      });
    }

    // 1-Click Copy Button
    const copyBtn = document.getElementById('copyAddressBtn');
    const copyBtnText = document.getElementById('copyBtnText');
    const addrInput = document.getElementById('depositAddressInput');
    if (copyBtn && addrInput) {
      copyBtn.addEventListener('click', () => {
        const text = addrInput.value;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
          if (copyBtnText) copyBtnText.textContent = '✓ Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            if (copyBtnText) copyBtnText.textContent = 'Copy Address';
            copyBtn.classList.remove('copied');
          }, 2000);
        }).catch(() => {
          addrInput.select();
          document.execCommand('copy');
          if (copyBtnText) copyBtnText.textContent = '✓ Copied!';
          setTimeout(() => {
            if (copyBtnText) copyBtnText.textContent = 'Copy Address';
          }, 2000);
        });
      });
    }

    // File Drop Zone & Screenshot Upload
    const dropZone = document.getElementById('proofDropZone');
    const fileInput = document.getElementById('proofFileInput');
    const proofHiddenInput = document.getElementById('proofImageData');
    const previewWrap = document.getElementById('proofPreviewWrap');
    const previewImg = document.getElementById('proofPreviewImg');
    const dropContent = document.getElementById('dropZoneContent');
    const removeProofBtn = document.getElementById('removeProofBtn');

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', (e) => {
        if (e.target !== removeProofBtn) {
          fileInput.click();
        }
      });

      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
          handleProofFile(file);
        }
      });

      if (removeProofBtn) {
        removeProofBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          fileInput.value = '';
          if (proofHiddenInput) proofHiddenInput.value = '';
          if (previewWrap) previewWrap.style.display = 'none';
          if (dropContent) dropContent.style.display = 'flex';
        });
      }
    }

    function handleProofFile(file) {
      if (!file.type.startsWith('image/')) {
        alert('Please upload a valid image file (PNG, JPG, WEBP).');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        if (proofHiddenInput) proofHiddenInput.value = dataUrl;
        if (previewImg) previewImg.src = dataUrl;
        if (previewWrap) previewWrap.style.display = 'block';
        if (dropContent) dropContent.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }

    // Checkout Form Submission
    const checkoutForm = document.getElementById('checkoutForm');
    if (checkoutForm) {
      checkoutForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('submitOrderBtn');
        const originalBtnHtml = submitBtn.innerHTML;

        const serviceKey = document.getElementById('serviceSelect').value;
        const email = document.getElementById('userEmail').value.trim();
        const phone = document.getElementById('userPhone').value.trim();
        const txid = document.getElementById('txidInput').value.trim();
        const paymentMethodId = document.getElementById('selectedPaymentMethodId').value;
        const proofData = document.getElementById('proofImageData').value;

        if (!serviceKey || !email || !txid) {
          alert('Please fill out all required fields.');
          return;
        }

        if (!proofData) {
          alert('Please upload a screenshot of your payment transfer.');
          return;
        }

        try {
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<span class="spinner" style="display:inline-block;width:18px;height:18px;vertical-align:middle;margin-right:8px;"></span> Submitting Order...';

          const res = await fetch(`${API_BASE}/api/public/bot-checkout/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              service_key: serviceKey,
              payment_method_id: paymentMethodId,
              email: email,
              phone: phone,
              txid: txid,
              proof_image_data: proofData
            })
          });

          const result = await res.json();
          if (res.ok && result.success) {
            const modal = document.getElementById('orderSuccessModal');
            const orderIdEl = document.getElementById('successOrderId');
            const emailEl = document.getElementById('successUserEmail');
            if (orderIdEl) orderIdEl.textContent = `TB-${result.order_id || 'PROCESSED'}`;
            if (emailEl) emailEl.textContent = email;
            if (modal) modal.classList.add('active');
            checkoutForm.reset();
            if (previewWrap) previewWrap.style.display = 'none';
            if (dropContent) dropContent.style.display = 'flex';
          } else {
            alert(result.error || 'Failed to submit order. Please try again.');
          }
        } catch (err) {
          console.error('Submit error:', err);
          alert('Error connecting to checkout server. Please check your connection.');
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalBtnHtml;
        }
      });
    }

    // Contact Form Handler (Connected to Real Backend)
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
      contactForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('sendContactBtn');
        const alertEl = document.getElementById('contactSuccessAlert');
        const originalBtnHtml = submitBtn ? submitBtn.innerHTML : 'Send Priority Ticket';

        const name = document.getElementById('contactName')?.value?.trim();
        const email = document.getElementById('contactEmail')?.value?.trim();
        const category = document.getElementById('contactTopic')?.value?.trim() || 'general';
        const phone = document.getElementById('contactPhone')?.value?.trim() || '';
        const subject = document.getElementById('contactSubject')?.value?.trim();
        const message = document.getElementById('contactMessage')?.value?.trim();

        if (!name || !email || !subject || !message) {
          alert('Please fill in all required fields.');
          return;
        }

        try {
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span class="spinner" style="display:inline-block;width:16px;height:16px;vertical-align:middle;margin-right:8px;"></span> Sending Ticket...';
          }

          const res = await fetch(`${API_BASE}/api/public/bot-contact/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, category, phone, subject, message })
          });

          const data = await res.json();
          if (res.ok && data.success) {
            if (alertEl) alertEl.style.display = 'block';
            contactForm.reset();
          } else {
            alert(data.error || 'Failed to submit ticket. Please try again.');
          }
        } catch (err) {
          console.error('Contact submit error:', err);
          if (alertEl) alertEl.style.display = 'block';
          contactForm.reset();
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnHtml;
          }
        }
      });
    }
  }

  // Initialize on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    initMobileMenu();
    initFaqAccordion();
    loadDynamicServices();
    loadPaymentMethods();
    initCheckoutPage();
  });
})();


// Expose global auth helpers to window
window.submitEmailFirst = typeof submitEmailFirst !== 'undefined' ? submitEmailFirst : function(){};
window.handleEmailStep = window.submitEmailFirst;
window.submitKeySecond = typeof submitKeySecond !== 'undefined' ? submitKeySecond : function(){};
window.handleKeyStep = window.submitKeySecond;
window.goToAuthStep1 = typeof goToAuthStep1 !== 'undefined' ? goToAuthStep1 : function(){};
window.backToEmailStep = window.goToAuthStep1;
window.logout = typeof logout !== 'undefined' ? logout : function(){};
window.disconnectWallet = window.logout;
