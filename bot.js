/**
 * Trading Boy Bot — bot.js
 * Standalone auto-trade engine. Connects to Gain EX public API.
 * Handles key activation, email linking, auto-trade execution, and outcome polling.
 */
'use strict';

// ─── CONFIG ────────────────────────────────────────────────────────────────
let GAINEX_API = 'http://127.0.0.1:3000';

function updateGainexApiUrl(url) {
  if (url) {
    GAINEX_API = url.trim().replace(/\/$/, '');
    localStorage.setItem('tbb_api_url', GAINEX_API);
  }
}

// Auto-initialize from localStorage or auto-detection
(function initApiUrl() {
  const saved = localStorage.getItem('tbb_api_url');
  if (saved) {
    GAINEX_API = saved.trim().replace(/\/$/, '');
  } else if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    // If hosted on a live domain (e.g. same Hostinger server), auto-detect
    GAINEX_API = window.location.origin;
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

  // Populate Platform URL input if saved
  const apiUrlInput = document.getElementById('api-url-input');
  if (apiUrlInput) {
    apiUrlInput.value = localStorage.getItem('tbb_api_url') || '';
  }
});

// ─── AUTHENTICATION (TWO-STEP LINKING) ──────────────────────────────────────
async function submitEmailFirst() {
  const apiUrlInput = document.getElementById('api-url-input');
  const input = document.getElementById('email-input');
  const btn   = document.getElementById('btn-verify-email');
  const email = input.value.trim();

  if (apiUrlInput) {
    const enteredUrl = apiUrlInput.value.trim();
    if (!enteredUrl) {
      showToast('⚠️ Please enter your Gain EX Platform URL.', 'error');
      return;
    }
    if (!enteredUrl.startsWith('http://') && !enteredUrl.startsWith('https://')) {
      showToast('⚠️ Platform URL must start with http:// or https://', 'error');
      return;
    }
    updateGainexApiUrl(enteredUrl);
  }

  if (!email) { showToast('⚠️ Please enter your Gain EX account email.', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Verifying email…';

  try {
    const res = await fetch(API.verifyEmail, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      showToast('❌ ' + (data.error || 'Invalid account email.'), 'error');
      btn.disabled = false;
      btn.textContent = 'Next Step ➔';
      return;
    }

    // Email is verified. Proceed to Step 2
    Bot.email = data.email;
    document.getElementById('linking-email-hint').textContent = data.email;
    document.getElementById('auth-step-1').style.display = 'none';
    document.getElementById('auth-step-2').style.display = 'block';
    showToast('📧 Email verified! Now enter activation key.', 'success');
  } catch (err) {
    showToast('⚠️ Could not reach server. Check your connection.', 'error');
    btn.disabled = false;
    btn.textContent = 'Next Step ➔';
  }
}

async function submitKeySecond() {
  const input = document.getElementById('key-input');
  const btn   = document.getElementById('btn-link');
  const key   = input.value.trim().toUpperCase();

  if (!key) { showToast('⚠️ Please enter your activation key.', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Activating bot…';

  try {
    const res = await fetch(API.linkAccount, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, email: Bot.email }),
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      showToast('❌ ' + (data.error || 'Failed to activate.'), 'error');
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

    localStorage.setItem('tbb_wins', Bot.wins);
    localStorage.setItem('tbb_losses', Bot.losses);
    localStorage.setItem('tbb_trades_count', Bot.tradesCount);
    localStorage.setItem('tbb_profit', Bot.profit);

    showBotScreen();
    showToast('🚀 Account linked and key activated!', 'success');
  } catch (err) {
    showToast('⚠️ Linking failed. Check your server connection.', 'error');
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
  const linkedBalance = document.getElementById('linked-balance-display');
  if (linkedBalance) {
    linkedBalance.textContent = `$${Bot.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${Bot.currency}`;
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
function showToast(msg, type = 'info', duration = 4000) {
  let container = document.getElementById('tbb-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'tbb-toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `tbb-toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, duration);
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
