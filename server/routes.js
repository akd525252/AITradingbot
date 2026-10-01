const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
let { getDB } = require('./db');
const originalGetDB = getDB;
getDB = function() {
  const dbPromise = originalGetDB();
  dbPromise.query = async function(sql, params = []) {
    const db = await dbPromise;
    return db.all(sql, params);
  };
  return dbPromise;
};

const JWT_SECRET = process.env.JWT_SECRET || 'gainex-secret-super-key-123';
const telegramService = require('./services/telegramService');
const whatsappService = require('./services/whatsappService');
const { sendPushNotification } = require('./services/notificationService');
const aiSupportService = require('./services/aiSupportService');

// Initialize AI bot support user on startup
aiSupportService.initSupportBotUser();

const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
}

async function uploadToSupabase(file, bucketName = 'gainex-uploads') {
  if (!supabase) {
    console.warn('[SUPABASE UPLOAD] Supabase is not configured. Falling back to local filepath.');
    return `/uploads/${file.filename}`;
  }

  try {
    const fileBuffer = fs.readFileSync(file.path);
    const fileName = `${Date.now()}-${file.filename || file.originalname}`;
    
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(fileName, fileBuffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (error) {
      if (error.message && error.message.includes('bucket not found')) {
        try {
          await supabase.storage.createBucket(bucketName, { public: true });
          const retryUpload = await supabase.storage.from(bucketName).upload(fileName, fileBuffer, {
            contentType: file.mimetype,
            upsert: true
          });
          if (retryUpload.error) throw retryUpload.error;
          const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl(fileName);
          return publicUrlData.publicUrl;
        } catch (createBucketErr) {
          console.error('[SUPABASE STORAGE] Failed to create bucket or retry upload:', createBucketErr.message);
          throw error;
        }
      }
      throw error;
    }

    const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl(fileName);
    
    // Clean up local temp file
    try {
      fs.unlinkSync(file.path);
    } catch(err) {}

    return publicUrlData.publicUrl;
  } catch (err) {
    console.error('[SUPABASE UPLOAD ERROR]:', err.message);
    return `/uploads/${file.filename}`;
  }
}


// Setup file upload for deposit slip
const uploadDir = fs.existsSync('/data')
  ? '/data/uploads'
  : path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Global In-Memory Stores
const candleStore = {};
const priceCache = {};
const priceCacheTime = {};
const activeManipulations = {};
const activeTradeCache = {};
const activeTradeCacheTime = {};

function clearActiveTradeCache(userId) {
  const prefix = `${userId}_`;
  for (const key in activeTradeCache) {
    if (key.startsWith(prefix)) {
      delete activeTradeCache[key];
      delete activeTradeCacheTime[key];
    }
  }
}

async function updateBinancePrices() {
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price');
    if (!response.ok) throw new Error('Binance all-prices fetch failed');
    const tickers = await response.json();
    const now = Date.now();
    for (const item of tickers) {
      if (item.symbol.endsWith('USDT')) {
        const coin = item.symbol.replace('USDT', '');
        const parsedPrice = parseFloat(item.price);
        if (!isNaN(parsedPrice) && parsedPrice > 0) {
          priceCache[coin] = parsedPrice;
          priceCacheTime[coin] = now;
        }
      }
    }
  } catch (error) {
    console.error('[BINANCE TICKER ERROR]:', error.message);
  }
}

// Initial run
updateBinancePrices().catch(err => console.error('Failed initial Binance fetch:', err.message));
// Repeat every 1.5s
setInterval(updateBinancePrices, 1500);

const ALL_FOREX_PAIRS = [
  'EUR/USD','GBP/USD','USD/JPY','USD/CAD','AUD/USD','USD/CHF','NZD/USD',
  'EUR/GBP','EUR/JPY','GBP/JPY','USD/INR','USD/PKR','USD/BDT','GBP/CHF'
];

const FOREX_BASE_PRICES = {
  'EUR/USD': 1.0825,
  'USD/CAD': 1.3650,
  'GBP/USD': 1.2740,
  'USD/JPY': 156.80,
  'AUD/USD': 0.6650,
  'USD/CHF': 0.8980,
  'NZD/USD': 0.6120,
  'EUR/GBP': 0.8490,
  'EUR/JPY': 169.80,
  'GBP/JPY': 200.00,
  'USD/INR': 83.50,
  'USD/PKR': 278.00,
  'USD/BDT': 117.00,
  'GBP/CHF': 1.1440
};

const ALL_CRYPTO = [
  'BTC','ETH','SOL','BNB','DOGE','XRP','ADA','AVAX','MATIC','LINK','LTC','DOT','TRX','UNI','ATOM'
];

// Active manipulation cleaning worker (runs every 30s)
setInterval(() => {
  const now = Date.now();
  for (const tradeId in activeManipulations) {
    const expiresMs = new Date(activeManipulations[tradeId].expiresAt).getTime();
    if (now - expiresMs > 30000) {
      delete activeManipulations[tradeId];
    }
  }
}, 30000);

function cleanSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/\s*\(OTC\)/gi, '').trim().toUpperCase();
}

function isForexPair(symbol) {
  if (!symbol) return false;
  const cleaned = cleanSymbol(symbol);
  return ALL_FOREX_PAIRS.includes(cleaned) || cleaned.includes('/');
}

function getCoinBaseSymbol(symbol) {
  if (!symbol) return '';
  const cleaned = cleanSymbol(symbol);
  return cleaned.split('/')[0].split('-')[0].trim().toUpperCase();
}

function mapTimeframeToBinance(tf) {
  const map = {
    '1m': '1m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1h',
    '1d': '1d',
    '1w': '1w',
    '1mo': '1M'
  };
  return map[tf] || '1m';
}

async function getUserExchangeRate(db, userId) {
  try {
    const user = await db.get('SELECT currency FROM users WHERE id = ?', [userId]);
    if (!user || !user.currency || user.currency.toUpperCase() === 'USD') {
      return 1.0;
    }
    const rateRow = await db.get('SELECT value FROM settings WHERE key = ?', [`currency_rate_${user.currency.toUpperCase()}`]);
    if (rateRow) {
      const parsedRate = parseFloat(rateRow.value);
      if (!isNaN(parsedRate) && parsedRate > 0) {
        return parsedRate;
      }
    }
  } catch (err) {
    console.error('Error fetching exchange rate:', err);
  }
  return 1.0;
}

function formatPriceNum(val, basePrice) {
  if (basePrice < 1) return Number(val.toFixed(6));
  if (basePrice < 10) return Number(val.toFixed(4));
  return Number(val.toFixed(2));
}

function initCandleStore(asset, timeframe = '1m') {
  const key = `${asset}_${timeframe}`;
  if (candleStore[key] && candleStore[key].length >= 3000) return;
  const isForex = isForexPair(asset);
  const coinKey = getCoinBaseSymbol(asset).toUpperCase();
  const basePrice = isForex ? (FOREX_BASE_PRICES[cleanSymbol(asset)] || 1.0) : (
    priceCache[coinKey] || {
      BTC: 64000, ETH: 3400, SOL: 135, BNB: 575, DOGE: 0.125,
      XRP: 0.50, ADA: 0.40, AVAX: 30.0, MATIC: 0.60,
      LINK: 14.0, LTC: 75.0, DOT: 6.0, TRX: 0.11, UNI: 8.0, ATOM: 7.0
    }[coinKey] || 100
  );

  let tfMs = 60000;
  switch (timeframe) {
    case '15m': tfMs = 15 * 60000; break;
    case '30m': tfMs = 30 * 60000; break;
    case '1h': tfMs = 60 * 60000; break;
    case '1d': tfMs = 24 * 60 * 60000; break;
    case '1w': tfMs = 7 * 24 * 60 * 60000; break;
    case '1mo': tfMs = 30 * 24 * 60 * 60000; break;
  }

  const tfScales = {
    '1m': 0.04,
    '15m': 0.08,
    '30m': 0.12,
    '1h': 0.18,
    '1d': 0.28,
    '1w': 0.38,
    '1mo': 0.48
  };
  const scale = tfScales[timeframe] || 0.10;

  const currentPeriod = Math.floor(Date.now() / tfMs) * tfMs;
  const candles = [];
  let currentPrice = basePrice;
  const startOffset = Math.floor(Math.random() * 1000);
  let walk = 0.0;

  // Generate backward from basePrice (live price) to prevent gaps with live ticks
  for (let j = 3000; j >= 1; j--) {
    const idx = startOffset + j;
    const time = currentPeriod - (3001 - j) * tfMs;

    // Multi-frequency waves configured to naturally synthesize realistic broader M and W patterns (mountains)
    const w1 = Math.sin(idx * 0.07) * 0.45;
    const w2 = Math.cos(idx * 0.14 + 0.8) * 0.35;
    const w3 = Math.sin(idx * 0.015) * 0.20;

    const shock = (Math.random() * 2 - 1) * 0.03;
    walk += -0.05 * walk + shock;

    const waveNorm = (w1 + w2 + w3 + walk);
    const targetPrice = basePrice * Math.max(0.2, (1 + scale * waveNorm));

    // Calculate backward step change and add high-frequency candle-level noise
    const trendChange = targetPrice - currentPrice;
    const noise = basePrice * scale * (Math.random() * 2 - 1) * 0.24;

    const close = currentPrice;
    let open = currentPrice + trendChange + noise;
    open = Math.max(basePrice * 0.2, open);

    const body = Math.abs(close - open);
    const minWick = basePrice * scale * 0.02;
    const wickTop = body * (0.12 + Math.random() * 0.30) + minWick * Math.random();
    const wickBot = body * (0.12 + Math.random() * 0.30) + minWick * Math.random();

    const high = Math.max(open, close) + wickTop;
    const low = Math.max(basePrice * 0.1, Math.min(open, close) - wickBot);

    candles.unshift({
      time,
      open: formatPriceNum(open, basePrice),
      high: formatPriceNum(high, basePrice),
      low: formatPriceNum(low, basePrice),
      close: formatPriceNum(close, basePrice)
    });

    currentPrice = open;
  }
  candleStore[key] = candles;
}

function getForexCandles(asset, timeframe = '1m') {
  const key = `${asset}_${timeframe}`;
  
  let tfMs = 60000;
  switch (timeframe) {
    case '15m': tfMs = 15 * 60000; break;
    case '30m': tfMs = 30 * 60000; break;
    case '1h': tfMs = 60 * 60000; break;
    case '1d': tfMs = 24 * 60 * 60000; break;
    case '1w': tfMs = 7 * 24 * 60 * 60000; break;
    case '1mo': tfMs = 30 * 24 * 60 * 60000; break;
  }
  const now = Date.now();
  const currentPeriod = Math.floor(now / tfMs) * tfMs;

  // Clear stale in-memory candles if they haven't been updated for more than 2 periods
  if (candleStore[key] && candleStore[key].length > 0) {
    const last = candleStore[key][candleStore[key].length - 1];
    if (last && last.time < currentPeriod - 2 * tfMs) {
      delete candleStore[key];
    }
  }

  if (!candleStore[key] || candleStore[key].length < 3000) {
    initCandleStore(asset, timeframe);
  }
  
  const candles = candleStore[key];
  const last = candles[candles.length - 1];

  const volatility = isForexPair(asset) ? 0.0003 : 0.001;
  const tick = last.close * (volatility * (Math.random() * 2 - 1));
  const newPrice = Math.max(last.close * 0.5, last.close + tick);

  if (last.time < currentPeriod) {
    candles.push({
      time: currentPeriod,
      open: last.close,
      high: Math.max(last.close, newPrice),
      low: Math.min(last.close, newPrice),
      close: newPrice
    });
    if (candles.length > 3000) candles.shift();
  } else {
    last.high = Math.max(last.high, newPrice);
    last.low = Math.min(last.low, newPrice);
    last.close = newPrice;
  }

  return candles;
}

// Helpers
async function getLivePrice(coin) {
  const coinKey = coin.toUpperCase();
  if (coinKey.includes('OTC')) {
    const otcEngine = require('./services/otcEngine');
    return otcEngine.getPrice(coin) || 100.0;
  }
  const now = Date.now();
  
  // Return cached price if it is fresh (within 400ms) to prevent stale 2-second leap jumps
  if (priceCache[coinKey] && priceCacheTime[coinKey] && (now - priceCacheTime[coinKey] < 400)) {
    return priceCache[coinKey];
  }

  try {
    const symbol = `${coinKey}USDT`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    // Use unrestricted public vision data API first (works on Hostinger/datacenter IPs without blocks), fallback to standard
    let response;
    try {
      response = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`, {
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Vision API error');
    } catch (e) {
      response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, {
        signal: controller.signal
      });
    }
    clearTimeout(timeoutId);
    
    if (!response.ok) throw new Error('Failed to fetch from Binance');
    const data = await response.json();
    const parsedPrice = parseFloat(data.price);
    if (!isNaN(parsedPrice) && parsedPrice > 0) {
      priceCache[coinKey] = parsedPrice;
      priceCacheTime[coinKey] = now;
      return parsedPrice;
    }
    throw new Error('Invalid price data from Binance');
  } catch (error) {
    console.error(`Error fetching price for ${coin}:`, error.message);
    if (priceCache[coinKey]) {
      // Float naturally around the last successfully cached price (within +/- 0.02%)
      const floatVal = priceCache[coinKey] * (Math.random() * 0.0004 - 0.0002);
      const nextPrice = priceCache[coinKey] + floatVal;
      priceCache[coinKey] = nextPrice;
      priceCacheTime[coinKey] = now;
      return nextPrice;
    }
    const fallbacks = {
      BTC: 64000.00 + (Math.random() * 20 - 10),
      ETH: 3400.00 + (Math.random() * 4 - 2),
      SOL: 135.00 + (Math.random() * 0.4 - 0.2),
      BNB: 575.00 + (Math.random() * 1.5 - 0.75),
      DOGE: 0.12500 + (Math.random() * 0.001 - 0.0005)
    };
    const defaultFallback = fallbacks[coinKey] || 100.0;
    priceCache[coinKey] = defaultFallback;
    priceCacheTime[coinKey] = now;
    return defaultFallback;
  }
}

async function getEffectiveTradeControl(db, trade) {
  const combineRow = await db.get("SELECT value FROM settings WHERE key = 'combine_trades_control'");
  const outcomeRow = await db.get("SELECT value FROM settings WHERE key = 'combine_trades_outcome'");
  const combineEnabled = combineRow && combineRow.value === 'true';
  const combineOutcome = outcomeRow ? outcomeRow.value : 'none';
  if (combineEnabled && combineOutcome !== 'none') {
    return combineOutcome;
  }
  return trade.admin_control || 'none';
}

async function getManipulatedPrice(db, userId, asset, realPrice) {
  const cleanAsset = cleanSymbol(asset);
  const baseCoin = getCoinBaseSymbol(asset);
  const now = Date.now();
  const tradeCacheKey = `${userId}_${cleanAsset}`;

  let trade = null;
  let isActive = true;

  const cachedInfo = activeTradeCache[tradeCacheKey];
  if (cachedInfo && (now - activeTradeCacheTime[tradeCacheKey] < 2000)) {
    trade = cachedInfo.trade;
    isActive = cachedInfo.isActive;
  } else {
    // Check for active trade
    const activeTrade = await db.get(`
      SELECT id, coin, direction, amount, open_price, duration, commission_pct, admin_control, created_at, expires_at
      FROM trades
      WHERE user_id = ? AND status = 'active' AND (coin = ? OR coin = ?)
      LIMIT 1
    `, [userId, asset, baseCoin]);

    trade = activeTrade;
    isActive = true;

    if (!trade) {
      // Check for recently resolved trade (within last 40 seconds)
      const cutoff = new Date(now - 40000).toISOString();
      const resolvedTrade = await db.get(`
        SELECT id, coin, direction, amount, open_price, duration, commission_pct, admin_control, created_at, expires_at, resolved_at, close_price
        FROM trades
        WHERE user_id = ? AND status IN ('win', 'lose') AND (coin = ? OR coin = ?) AND (resolved_at >= ? OR expires_at >= ?)
        ORDER BY expires_at DESC
        LIMIT 1
      `, [userId, asset, baseCoin, cutoff, cutoff]);
      
      if (resolvedTrade) {
        trade = resolvedTrade;
        isActive = false;
      }
    }

    activeTradeCache[tradeCacheKey] = { trade, isActive };
    activeTradeCacheTime[tradeCacheKey] = now;
  }

  if (!trade) {
    return realPrice;
  }

  // Get effective control
  const effectiveControl = await getEffectiveTradeControl(db, trade);
  if (effectiveControl === 'none') {
    return realPrice;
  }

  const openPrice = parseFloat(trade.open_price);
  const direction = trade.direction;
  const isWin = effectiveControl === 'win';

  // Calculate offset (e.g. 0.02% of open_price)
  const offset = openPrice * 0.0002;
  
  // Calculate target price preserving natural movement if safe, else clamping to win/loss side
  let targetManipulatedPrice;
  if (direction === 'UP') {
    if (isWin) {
      if (realPrice > openPrice + offset) {
        targetManipulatedPrice = realPrice;
      } else {
        targetManipulatedPrice = Math.max(openPrice + offset, openPrice + offset + (realPrice - openPrice) * 0.05);
      }
    } else {
      if (realPrice < openPrice - offset) {
        targetManipulatedPrice = realPrice;
      } else {
        targetManipulatedPrice = Math.min(openPrice - offset, openPrice - offset + (realPrice - openPrice) * 0.05);
      }
    }
  } else { // DOWN
    if (isWin) {
      if (realPrice < openPrice - offset) {
        targetManipulatedPrice = realPrice;
      } else {
        targetManipulatedPrice = Math.min(openPrice - offset, openPrice - offset + (realPrice - openPrice) * 0.05);
      }
    } else {
      if (realPrice > openPrice + offset) {
        targetManipulatedPrice = realPrice;
      } else {
        targetManipulatedPrice = Math.max(openPrice + offset, openPrice + offset + (realPrice - openPrice) * 0.05);
      }
    }
  }

  const expiresAtMs = new Date(trade.expires_at).getTime();

  if (isActive) {
    const timeLeft = (expiresAtMs - now) / 1000;
    let lastSeconds = 5;
    const duration = parseInt(trade.duration) || 30;
    if (duration >= 60) {
      lastSeconds = 25;
    } else if (duration >= 30) {
      lastSeconds = 15;
    } else if (duration >= 15) {
      lastSeconds = 10;
    } else {
      lastSeconds = 5;
    }

    if (timeLeft <= lastSeconds && timeLeft > 0) {
      const t = (lastSeconds - timeLeft) / lastSeconds;
      const ease = t * t * (3 - 2 * t); // Smoothstep ease-in-out
      return realPrice * (1 - ease) + targetManipulatedPrice * ease;
    } else if (timeLeft <= 0) {
      return targetManipulatedPrice;
    }
    return realPrice;
  } else {
    const timeSinceExpiry = (now - expiresAtMs) / 1000;
    let cooldownSeconds = 5;
    const duration = parseInt(trade.duration) || 30;
    if (duration >= 60) {
      cooldownSeconds = 25;
    } else if (duration >= 30) {
      cooldownSeconds = 15;
    } else if (duration >= 15) {
      cooldownSeconds = 10;
    } else {
      cooldownSeconds = 5;
    }

    if (timeSinceExpiry <= 3) {
      // Stay at the admin call for 3 seconds
      return targetManipulatedPrice;
    } else if (timeSinceExpiry > 3 && timeSinceExpiry <= 3 + cooldownSeconds) {
      // Smoothly return back to the real price in next cooldownSeconds
      const t = (timeSinceExpiry - 3) / cooldownSeconds;
      const ease = t * t * (3 - 2 * t);
      return targetManipulatedPrice * (1 - ease) + realPrice * ease;
    }
    return realPrice;
  }
}

async function applyHistoricalManipulations(db, userId, asset, candles, timeframe = '1m') {
  if (!candles || candles.length === 0) return candles;
  const baseCoin = getCoinBaseSymbol(asset);
  
  // Load user's active trades and trades that closed within the last 15 seconds
  // We only need 15s post-expiry so the manipulation covers the final tick and result toast.
  // After that window the server returns natural candles; the client never re-fetches while
  // the user is on the same asset/timeframe so no visible snap can occur.
  const nowIso = new Date().toISOString();
  const shortCutoff = new Date(Date.now() - 40000).toISOString();
  let userTrades = [];
  try {
    userTrades = await db.all(`
      SELECT id, coin, direction, open_price, duration, admin_control, created_at, expires_at, resolved_at, status, close_price
      FROM trades
      WHERE user_id = ? AND (coin = ? OR coin = ?) AND (status = 'active' OR (status IN ('win', 'lose') AND expires_at >= ?))
    `, [userId, asset, baseCoin, shortCutoff]);
  } catch (e) {
    console.error('Failed to query user trades for candle manipulation:', e);
    return candles;
  }

  if (userTrades.length === 0) return candles;

  // Determine timeframe in milliseconds
  let tfMs = 60000;
  if (timeframe === '15m') tfMs = 900000;
  else if (timeframe === '30m') tfMs = 1800000;
  else if (timeframe === '1h') tfMs = 3600000;
  else if (timeframe === '1d') tfMs = 86400000;
  else if (timeframe === '1w') tfMs = 604800000;
  else if (timeframe === '1mo') tfMs = 2592000000;

  for (const t of userTrades) {
    const effectiveControl = await getEffectiveTradeControl(db, t);
    if (effectiveControl === 'none') continue;

    const openPrice = parseFloat(t.open_price);
    const direction = t.direction;
    const isWin = effectiveControl === 'win';
    const offset = openPrice * 0.0002;
    const expiresAtMs = new Date(t.expires_at).getTime();
    const createdAtMs = new Date(t.created_at).getTime();

    let cooldownSeconds = 5;
    const duration = parseInt(t.duration) || 30;
    if (duration >= 60) {
      cooldownSeconds = 25;
    } else if (duration >= 30) {
      cooldownSeconds = 15;
    } else if (duration >= 15) {
      cooldownSeconds = 10;
    } else {
      cooldownSeconds = 5;
    }

    for (const candle of candles) {
      const candleTime = candle.time;
      const candleTimeMs = typeof candleTime === 'number' ? (candleTime < 10000000000 ? candleTime * 1000 : candleTime) : new Date(candleTime).getTime();
      
      // Check if candle falls within the trade's active and cooldown period
      if (candleTimeMs + tfMs >= createdAtMs && candleTimeMs <= expiresAtMs + 3000 + cooldownSeconds * 1000) {
        const realPrice = candle.close;
        let targetManipPrice;

        if (direction === 'UP') {
          if (isWin) {
            targetManipPrice = Math.max(openPrice + offset, openPrice + offset + (realPrice - openPrice) * 0.05);
          } else {
            targetManipPrice = Math.min(openPrice - offset, openPrice - offset + (realPrice - openPrice) * 0.05);
          }
        } else { // DOWN
          if (isWin) {
            targetManipPrice = Math.min(openPrice - offset, openPrice - offset + (realPrice - openPrice) * 0.05);
          } else {
            targetManipPrice = Math.max(openPrice + offset, openPrice + offset + (realPrice - openPrice) * 0.05);
          }
        }

        let finalPrice = realPrice;
        const now = Date.now();
        const checkTimeMs = Math.min(now, candleTimeMs + tfMs - 1);
        
        if (checkTimeMs >= expiresAtMs) {
          const timeSinceExpiry = (checkTimeMs - expiresAtMs) / 1000;
          if (timeSinceExpiry <= 3) {
            finalPrice = targetManipPrice;
          } else if (timeSinceExpiry > 3 && timeSinceExpiry <= 3 + cooldownSeconds) {
            const factor = (timeSinceExpiry - 3) / cooldownSeconds;
            const ease = factor * factor * (3 - 2 * factor);
            finalPrice = targetManipPrice * (1 - ease) + realPrice * ease;
          }
        } else {
          const timeLeft = (expiresAtMs - checkTimeMs) / 1000;
          let lastSeconds = 5;
          const duration = parseInt(t.duration) || 30;
          if (duration >= 60) {
            lastSeconds = 25;
          } else if (duration >= 30) {
            lastSeconds = 15;
          } else if (duration >= 15) {
            lastSeconds = 10;
          } else {
            lastSeconds = 5;
          }

          if (timeLeft <= lastSeconds && timeLeft > 0) {
            const factor = (lastSeconds - timeLeft) / lastSeconds;
            const ease = factor * factor * (3 - 2 * factor);
            finalPrice = realPrice * (1 - ease) + targetManipPrice * ease;
          } else if (timeLeft <= 0) {
            finalPrice = targetManipPrice;
          }
        }

        // Adjust candle values
        candle.close = finalPrice;
        candle.high = Math.max(candle.high, finalPrice);
        candle.low = Math.min(candle.low, finalPrice);
      }
    }
  }

  return candles;
}

// Initialize and seed global.liveUserActivities on startup with mock page views & finance events
if (!global.liveUserActivities) {
  global.liveUserActivities = [];
  const mockUsers = ['usman', 'atichu', 'anzaltrader', 'demo_user', 'alex_invest', 'shanizafar'];
  const mockPages = [
    { action: 'Viewing Leaderboard', type: 'navigation' },
    { action: 'Checking Profile Badges', type: 'navigation' },
    { action: 'Viewing Profile / Settings', type: 'navigation' },
    { action: 'Checking Dashboard Balance', type: 'navigation' },
    { action: 'Viewing Market Pairs', type: 'navigation' },
    { action: 'Opening Trading Screen', type: 'navigation' },
    { action: 'Checking Active Trades / History', type: 'navigation' }
  ];
  const mockFinances = [
    { action: 'Initiated a Deposit of $250.00', type: 'deposit' },
    { action: 'Requested a Withdrawal of $80.00', type: 'withdrawal' },
    { action: 'Claimed a Badge Bonus', type: 'bonus' },
    { action: 'Claimed Daily Bonus', type: 'bonus' },
    { action: 'Submitted KYC Documents', type: 'kyc' }
  ];
  const mockTrades = [
    { action: 'Placed a $50.00 UP trade on BTC/USDT', type: 'trade' },
    { action: 'Placed a $100.00 DOWN trade on ETH/USDT', type: 'trade' },
    { action: 'Placed a $20.00 UP trade on SOL/USDT', type: 'trade' }
  ];

  const now = Date.now();
  // Generate 80 mock historical activities over the last 4 hours
  for (let i = 80; i > 0; i--) {
    const user = mockUsers[Math.floor(Math.random() * mockUsers.length)];
    const timeOffset = i * 3 * 60 * 1000 + Math.random() * 60000;
    const time = new Date(now - timeOffset).toISOString();
    
    const r = Math.random();
    let item;
    if (r < 0.5) {
      item = mockPages[Math.floor(Math.random() * mockPages.length)];
    } else if (r < 0.75) {
      item = mockTrades[Math.floor(Math.random() * mockTrades.length)];
    } else {
      item = mockFinances[Math.floor(Math.random() * mockFinances.length)];
    }
    
    global.liveUserActivities.push({
      id: (now - timeOffset) + '-' + Math.random().toString(36).substr(2, 4),
      username: user,
      action: item.action,
      type: item.type,
      time
    });
  }
  // Sort descending (newest first) on startup
  global.liveUserActivities.sort((a, b) => new Date(b.time) - new Date(a.time));
}

function isPrivateIp(ip) {
  if (!ip) return true;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' ||
         ip.startsWith('192.168.') || ip.startsWith('10.') || 
         ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
         ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
         ip.startsWith('172.20.') || ip.startsWith('172.21.') ||
         ip.startsWith('172.22.') || ip.startsWith('172.23.') ||
         ip.startsWith('172.24.') || ip.startsWith('172.25.') ||
         ip.startsWith('172.26.') || ip.startsWith('172.27.') ||
         ip.startsWith('172.28.') || ip.startsWith('172.29.') ||
         ip.startsWith('172.30.') || ip.startsWith('172.31.') ||
         ip.startsWith('fe80:');
}

async function lookupIpCountry(ip) {
  if (isPrivateIp(ip)) {
    return 'Local Network';
  }
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.status === 'success' && data.country) {
        return data.country;
      }
    }
  } catch (err) {
    console.error('[IP COUNTRY LOOKUP ERROR]:', err.message);
  }
  return 'Unknown';
}

// Authentication Middleware
async function authenticateToken(req, res, next) {
  const isAdminRoute = req.path && req.path.startsWith('/admin/');
  let token = isAdminRoute ? (req.cookies?.staff_token || req.cookies?.token) : req.cookies?.token;

  if (!token && req.headers['authorization']) {
    const authHeader = req.headers['authorization'];
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  if (!token) return res.status(401).json({ error: 'Access denied. Please log in.' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = await getDB();
    let user;
    try {
      user = await db.get('SELECT id, username, role, status, last_ip, last_country FROM users WHERE id = ?', [decoded.id]);
    } catch (dbErr) {
      user = await db.get('SELECT id, username, role, status FROM users WHERE id = ?', [decoded.id]);
    }

    if (!user) return res.status(401).json({ error: 'User account not found.' });
    if (user.status === 'blocked') return res.status(403).json({ error: 'Your account is blocked.' });

    req.user = user;

    let currentIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '';
    if (currentIp && currentIp.includes(',')) {
      currentIp = currentIp.split(',')[0].trim();
    }
    if (currentIp === '::1' || currentIp === '::ffff:127.0.0.1') {
      currentIp = '127.0.0.1';
    }

    const nowStr = new Date().toISOString();
    if (currentIp && currentIp !== user.last_ip) {
      (async () => {
        try {
          const country = await lookupIpCountry(currentIp);
          const db2 = await getDB();
          await db2.run('UPDATE users SET last_ip = ?, last_country = ?, last_seen_at = ? WHERE id = ?', [currentIp, country, nowStr, user.id]);
        } catch (err) {
          console.error('Failed to update user IP/country:', err.message);
        }
      })();
    } else {
      db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [nowStr, user.id]).catch(e => {
        console.error('Failed to update last_seen_at:', e.message);
      });
    }

    if (user.role === 'user') {
      // Track user transactions / posts in real-time
      const path = req.path;
      const method = req.method;
      let action = '';
      let type = '';

      if (path === '/api/client/trade' && method === 'POST') {
        action = 'Placed a Trade';
        type = 'trade';
      } else if (path === '/api/client/deposit' && method === 'POST') {
        action = 'Initiated a Deposit';
        type = 'deposit';
      } else if (path === '/api/client/withdraw' && method === 'POST') {
        action = 'Requested a Withdrawal';
        type = 'withdrawal';
      } else if (path === '/api/client/badges/claim' && method === 'POST') {
        action = 'Claimed a Badge Bonus';
        type = 'bonus';
      } else if (path === '/api/client/daily-bonus/claim' || (path && path.includes('bonus/claim'))) {
        action = 'Claimed Daily Bonus';
        type = 'bonus';
      } else if (path && path.includes('/kyc') && method === 'POST') {
        action = 'Submitted KYC Documents';
        type = 'kyc';
      } else if (path === '/api/client/visa-card/claim' && method === 'POST') {
        action = 'Claimed a Premium Visa Card';
        type = 'finance';
      } else if (path === '/api/client/visa-card/activate' && method === 'POST') {
        action = 'Activated Premium Visa Card';
        type = 'finance';
      }

      if (action) {
        global.liveUserActivities = global.liveUserActivities || [];
        global.lastUserAction = global.lastUserAction || {};
        const now = Date.now();
        const last = global.lastUserAction[user.username];
        // Deduplicate navigation logs to avoid spam
        const isDuplicate = type === 'navigation' && last && last.action === action && (now - last.time) < 15000;
        
        if (!isDuplicate) {
          global.lastUserAction[user.username] = { action, time: now };
          global.liveUserActivities.unshift({
            id: now + '-' + Math.random().toString(36).substr(2, 4),
            username: user.username,
            action,
            type,
            time: new Date().toISOString()
          });
          if (global.liveUserActivities.length > 1000) {
            global.liveUserActivities.pop();
          }
        }
      }
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

// Role Middlewares
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission denied. Unauthorized access.' });
    }
    next();
  };
}

// Permission Middleware for Admin/Employees
async function checkPermission(req, res, next, permissionName) {
  if (req.user.role === 'admin') return next(); // Admin bypassed

  const db = await getDB();
  const perm = await db.get(
    `SELECT p.* FROM permissions p WHERE p.user_id = ?`,
    [req.user.id]
  );

  if (!perm) return res.status(403).json({ error: 'No permissions configured for employee.' });
  if (perm.full_access === 1 || perm[permissionName] === 1) {
    return next();
  }
  return res.status(403).json({ error: `Permission denied. Requires access: ${permissionName.replace('_', ' ')}` });
}

// --- PUBLIC ROUTES (no auth required) ---

// Public: fetch onboarding slides configured by admin
router.get('/public/onboarding', async (req, res) => {
  try {
    const db = await getDB();
    const row = await db.get("SELECT value FROM settings WHERE key = 'onboarding_slides'");
    let slides = [];
    if (row && row.value) {
      try { slides = JSON.parse(row.value); } catch(e) {}
    }
    // Default slides if none set
    if (!slides.length) {
      slides = [
        { title: 'Welcome to Gain EX 👋', description: 'The best app to invest in various crypto stocks in the world today!', image: '/images/onboarding1.png' },
        { title: 'Get Better Returns 🚀', description: 'Invest in the biggest crypto market & unlock amazing returns of investment.', image: '/images/onboarding2.png' },
        { title: 'Start with Just $1.00 💰', description: "You don't have to buy a whole share, you can buy a fraction.", image: '/images/onboarding3.png' },
        { title: 'Your Safety is First 🛡️', description: 'Your brokerage account is secured with advanced military-grade encryption.', image: '/images/onboarding4.png' },
        { title: 'No Commissions ⚡', description: 'No commissions ever, just trade and maximize your returns.', image: '/images/onboarding5.png' }
      ];
    }
    res.json({ slides });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: fetch document descriptions (Terms, Policy, FAQ, Auth, Risk, AML, Contact)
router.get('/public/documents', async (req, res) => {
  try {
    const db = await getDB();
    const terms = await db.get("SELECT value FROM settings WHERE key = 'terms_description'");
    const policy = await db.get("SELECT value FROM settings WHERE key = 'policy_description'");
    const faq = await db.get("SELECT value FROM settings WHERE key = 'faq_description'");
    const authDesc = await db.get("SELECT value FROM settings WHERE key = 'auth_description'");
    const risk = await db.get("SELECT value FROM settings WHERE key = 'risk_description'");
    const aml = await db.get("SELECT value FROM settings WHERE key = 'aml_description'");
    const contact = await db.get("SELECT value FROM settings WHERE key = 'contact_description'");
    const kyc = await db.get("SELECT value FROM settings WHERE key = 'kyc_description'");
    const refund = await db.get("SELECT value FROM settings WHERE key = 'refund_policy_description'");
    const shipping = await db.get("SELECT value FROM settings WHERE key = 'shipping_policy_description'");
    const officeAddr = await db.get("SELECT value FROM settings WHERE key = 'office_address'");
    const officeNum = await db.get("SELECT value FROM settings WHERE key = 'office_number'");
    res.json({
      terms_description: terms ? terms.value : '',
      policy_description: policy ? policy.value : '',
      faq_description: faq ? faq.value : '',
      auth_description: authDesc ? authDesc.value : '',
      risk_description: risk ? risk.value : '',
      aml_description: aml ? aml.value : '',
      contact_description: contact ? contact.value : '',
      kyc_description: kyc ? kyc.value : '',
      refund_policy_description: refund ? refund.value : '',
      shipping_policy_description: shipping ? shipping.value : '',
      office_address: officeAddr ? officeAddr.value : '',
      office_number: officeNum ? officeNum.value : ''
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function ensureUserInviteCode(db, user) {
  if (!user.invite_code || user.invite_code.trim() === '') {
    let attempts = 0;
    let generatedCode = '';
    while (attempts < 10) {
      generatedCode = 'REF' + Math.random().toString(36).substring(2, 7).toUpperCase();
      const codeExists = await db.get('SELECT id FROM invite_codes WHERE code = ?', [generatedCode]);
      if (!codeExists) break;
      attempts++;
    }
    if (generatedCode) {
      await db.run('UPDATE users SET invite_code = ? WHERE id = ?', [generatedCode, user.id]);
      try {
        await db.run('INSERT INTO invite_codes (code, created_by_id) VALUES (?, ?)', [generatedCode, user.id]);
      } catch (e) {
        console.error('[REFERRAL] Failed to insert invite code into invite_codes table:', e);
      }
      user.invite_code = generatedCode;
    }
  }
}
async function applyReferralCommission(db, referredUserId, depositAmount) {
  try {
    const referredUser = await db.get("SELECT username, invited_by_id FROM users WHERE id = ?", [referredUserId]);
    if (!referredUser || !referredUser.invited_by_id) {
      return; // Not referred by anyone
    }
    const referrerId = referredUser.invited_by_id;

    // Check if the referrer is an employee; employees do not receive deposit commissions
    const referrerCheck = await db.get("SELECT role FROM users WHERE id = ?", [referrerId]);
    if (referrerCheck && referrerCheck.role === 'employee') {
      console.log(`[REFERRAL] Referrer #${referrerId} is an employee. Skipping deposit commission.`);
      return;
    }

    // Count how many deposits the referred user has that are approved
    const approvedCountRow = await db.get(
      "SELECT COUNT(*) as count FROM deposits WHERE user_id = ? AND status = 'approved'",
      [referredUserId]
    );
    const approvedCount = approvedCountRow ? approvedCountRow.count : 0;

    // If it's more than 5, they do not qualify anymore
    if (approvedCount > 5) {
      console.log(`[REFERRAL] Deposit #${approvedCount} for user ${referredUserId} exceeds the first 5 deposits limit. No commission credited.`);
      return;
    }

    // Get commission percentage — check for per-employee override first
    let referralCommissionPct = 5.0;
    // Look up the referrer's invite code row for a custom override
    const refCodeRow = await db.get('SELECT commission_pct FROM invite_codes WHERE created_by_id = ? AND commission_pct IS NOT NULL LIMIT 1', [referrerId]);
    if (refCodeRow && refCodeRow.commission_pct !== null && refCodeRow.commission_pct !== undefined) {
      referralCommissionPct = parseFloat(refCodeRow.commission_pct);
    } else {
      const pctRow = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
      referralCommissionPct = pctRow ? parseFloat(pctRow.value) : 5.0;
    }

    const commissionAmount = depositAmount * (referralCommissionPct / 100.0);
    if (commissionAmount <= 0) return;

    // Get referrer details
    const referrer = await db.get("SELECT balance, currency FROM users WHERE id = ?", [referrerId]);
    if (!referrer) return;

    const rate = await getUserExchangeRate(db, referrerId);
    const commissionInLocal = commissionAmount * rate;
    const newReferrerBalance = (referrer.balance || 0) + commissionInLocal;

    // Credit referrer balance
    await db.run("UPDATE users SET balance = ? WHERE id = ?", [newReferrerBalance, referrerId]);

    // Insert referrer ledger
    const desc = `Referral Commission (${referralCommissionPct}%) for deposit by ${referredUser.username} (Deposit #${approvedCount})`;
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after)
       VALUES (?, 'referral_commission', ?, ?, ?)`,
      [referrerId, commissionInLocal, desc, newReferrerBalance]
    );

    console.log(`[REFERRAL] Credited referrer ${referrerId} with ${commissionAmount} commission (Deposit #${approvedCount} of referred user ${referredUserId})`);
  } catch (err) {
    console.error('[REFERRAL] Error in applyReferralCommission:', err);
  }
}

// --- AUTHENTICATION ROUTES ---

router.post('/auth/signup', async (req, res) => {
  const { username, email, phone_number, password, confirm_password, invite_code, full_name, code } = req.body;

  if (!username || !email || !phone_number || !password || !confirm_password || !full_name) {
    return res.status(400).json({ error: 'All fields (username, email, phone number, password, confirm password, full name) are required.' });
  }

  if (password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const db = await getDB();
  let invited_by_id = null;
  let codeRecord = null;

  if (invite_code && invite_code.trim() !== '') {
    // Validate invite code
    codeRecord = await db.get('SELECT * FROM invite_codes WHERE code = ?', [invite_code.trim().toUpperCase()]);
    if (!codeRecord) {
      return res.status(400).json({ error: 'Invalid invite code.' });
    }
    invited_by_id = codeRecord.created_by_id;
  }

  try {
    // Check username existence
    const usernameExists = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (usernameExists) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    // Check email existence
    const emailExists = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (emailExists) {
      return res.status(400).json({ error: 'Email is already registered.' });
    }

    // Check phone number existence
    const phoneExists = await db.get('SELECT id FROM users WHERE phone_number = ?', [phone_number.trim()]);
    if (phoneExists) {
      return res.status(400).json({ error: 'Phone number is already registered by another account.' });
    }

    // IF verification code is NOT provided: Step 1 (Request code)
    if (!code) {
      const signupCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins expiration

      // Store in signup_verifications table (PostgreSQL and SQLite compatible upsert)
      const upsertSql = db.isPg
        ? `INSERT INTO signup_verifications (email, code, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT (email)
           DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at
           RETURNING email`
        : `INSERT INTO signup_verifications (email, code, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT (email)
           DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at`;

      await db.run(upsertSql, [email.trim().toLowerCase(), signupCode, expiresAt]);

      // Send Verification Email via custom_email template
      const emailSubject = `${signupCode} is your Email Verification Code`;
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Email Verification Code</title>
        </head>
        <body style="margin:0;padding:0;background-color:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
          <table role="presentation" style="width:100%;background-color:#0f172a;padding:40px 20px;">
            <tr>
              <td align="center">
                <table role="presentation" style="width:100%;max-width:580px;background-color:#1e293b;border-radius:16px;border:1px solid rgba(255,255,255,0.05);padding:40px;box-shadow:0 20px 40px rgba(0,0,0,0.3);text-align:left;">
                  <tr>
                    <td style="text-align:center;padding-bottom:30px;">
                      <div style="font-size:24px;font-weight:800;letter-spacing:1px;color:#1ab76d;">GAIN EX <span style="color:#ffffff;font-weight:400;">MARKET</span></div>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <h2 style="margin:0 0 15px 0;font-size:20px;font-weight:700;color:#ffffff;text-align:center;">Verify Your Email Address</h2>
                      <div style="font-size:15px;line-height:1.6;color:#cbd5e1;margin-bottom:20px;text-align:center;">
                        Thank you for choosing Gain EX Market. Please use the verification code below to complete your registration.
                      </div>
                      <div style="text-align:center;padding:20px 0;">
                        <span style="font-size:32px;font-weight:800;letter-spacing:6px;color:#1ab76d;background-color:rgba(26,183,109,0.1);border:1px dashed #1ab76d;padding:10px 25px;border-radius:8px;display:inline-block;">${signupCode}</span>
                      </div>
                      <div style="font-size:13px;color:#94a3b8;text-align:center;margin-top:20px;">
                        This code is valid for 15 minutes. If you did not request this verification code, please ignore this email.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `;

      await sendSystemEmail(email.trim(), 'custom_email', {
        subject: emailSubject,
        html_content: emailHtml
      });

      return res.json({ success: true, code_required: true, message: 'Verification code sent to your email.' });
    }

    // IF verification code IS provided: Step 2 (Verify and register)
    const verification = await db.get(
      `SELECT code, expires_at FROM signup_verifications WHERE email = ?`,
      [email.trim().toLowerCase()]
    );

    if (!verification || verification.code !== code.trim()) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    const now = new Date().toISOString();
    if (verification.expires_at < now) {
      return res.status(400).json({ error: 'Verification code has expired. Please try again.' });
    }

    // Clear verification entry
    await db.run(`DELETE FROM signup_verifications WHERE email = ?`, [email.trim().toLowerCase()]);

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // Generate custom referral code for the new user
    let attempts = 0;
    let refCode = '';
    while (attempts < 10) {
      refCode = 'REF' + Math.random().toString(36).substring(2, 7).toUpperCase();
      const exists = await db.get('SELECT id FROM invite_codes WHERE code = ?', [refCode]);
      if (!exists) break;
      attempts++;
    }

    // Resolve client IP address
    let currentIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '';
    if (currentIp && currentIp.includes(',')) {
      currentIp = currentIp.split(',')[0].trim();
    }
    if (currentIp === '::1' || currentIp === '::ffff:127.0.0.1') {
      currentIp = '127.0.0.1';
    }

    // Check if this IP address exists for any previous account
    let conflictUser = null;
    if (currentIp) {
      conflictUser = await db.get('SELECT username FROM users WHERE last_ip = ? LIMIT 1', [currentIp]);
    }

    if (conflictUser) {
      try {
        await db.run(
          'INSERT INTO ip_alerts (username, ip_address, conflict_username, acknowledged) VALUES (?, ?, ?, 0)',
          [username, currentIp, conflictUser.username]
        );
      } catch (alertErr) {
        console.error('[SIGNUP ALERT ERROR]:', alertErr.message);
      }
    }

    const country = currentIp ? await lookupIpCountry(currentIp).catch(() => 'US') : 'US';

    // Create user with new columns
    const result = await db.run(
      `INSERT INTO users (username, email, phone_number, password_hash, role, balance, status, invited_by_id, full_name, invite_code, last_ip, last_country, kyc_country) 
       VALUES (?, ?, ?, ?, 'user', 0.0, 'active', ?, ?, ?, ?, ?, 'United States')`,
      [username, email, phone_number, password_hash, invited_by_id, full_name, refCode, currentIp || null, country]
    );

    if (result.lastID) {
      try {
        await db.run('INSERT INTO invite_codes (code, created_by_id) VALUES (?, ?)', [refCode, result.lastID]);
      } catch (err) {
        console.error('[REFERRAL] Failed to insert invite code for new user:', err);
      }
    }

    // Update invite code usage
    if (codeRecord) {
      await db.run('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?', [codeRecord.id]);
    }

    if (email) {
      sendSystemEmail(email.trim(), 'signup_success', {
        username: username.trim(),
        full_name: full_name ? full_name.trim() : username.trim()
      }).catch(err => console.error('[EMAIL ERROR] Signup success email:', err.message));
    }

    const signupMsg = 
      `🆕 *New Trader Signup*\n` +
      `👤 *Username*: ${telegramService.escapeMarkdown(username.trim())}\n` +
      `📧 *Email*: ${telegramService.escapeMarkdown(email.trim())}\n` +
      `📞 *Phone*: ${telegramService.escapeMarkdown(phone_number ? phone_number.trim() : 'N/A')}\n` +
      `🏷️ *Full Name*: ${telegramService.escapeMarkdown(full_name ? full_name.trim() : 'N/A')}\n` +
      `🔑 *Ref Used*: ${telegramService.escapeMarkdown(code ? code.trim().toUpperCase() : 'None')}`;

    telegramService.sendNotification(signupMsg);
    whatsappService.sendNotification(signupMsg);

    res.status(201).json({ success: true, message: 'Account registered successfully. You can now log in.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error during signup: ' + err.message });
  }
});

// --- Forgot Password APIs ---
const pendingForgotPasswordChanges = new Map();

router.post('/auth/forgot-password/request', async (req, res) => {
  try {
    const { usernameOrEmail } = req.body;
    if (!usernameOrEmail) {
      return res.status(400).json({ error: 'Username or Email is required.' });
    }
    const db = await getDB();
    const user = await db.get('SELECT id, email, username, full_name FROM users WHERE username = ? OR email = ?', [usernameOrEmail.trim(), usernameOrEmail.trim()]);
    if (!user) {
      return res.json({ success: true, message: 'If the account exists, a code has been sent.' });
    }
    if (!user.email) {
      return res.status(400).json({ error: 'No email address registered for this account.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000;

    pendingForgotPasswordChanges.set(user.id, {
      code,
      expires,
      usernameOrEmail: usernameOrEmail.trim()
    });

    const htmlContent = getPasswordChangeTemplate(code);
    const sent = await sendSystemEmail(user.email, 'custom_email', {
      subject: 'Password Reset Verification — GaineXMarket',
      html_content: htmlContent,
      username: user.username,
      full_name: user.full_name || user.username
    });

    res.json({ success: true, message: 'Verification code sent to your email.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/forgot-password/verify', async (req, res) => {
  try {
    const { usernameOrEmail, code } = req.body;
    if (!usernameOrEmail || !code) {
      return res.status(400).json({ error: 'Username/Email and code are required.' });
    }
    const db = await getDB();
    const user = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', [usernameOrEmail.trim(), usernameOrEmail.trim()]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid username/email or expired code.' });
    }
    const pending = pendingForgotPasswordChanges.get(user.id);
    if (!pending || pending.code !== String(code) || Date.now() > pending.expires) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }
    res.json({ success: true, message: 'Code verified successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/forgot-password/reset', async (req, res) => {
  try {
    const { usernameOrEmail, code, new_password } = req.body;
    if (!usernameOrEmail || !code) {
      return res.status(400).json({ error: 'Username/Email and code are required.' });
    }
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }
    const db = await getDB();
    const user = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', [usernameOrEmail.trim(), usernameOrEmail.trim()]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid user.' });
    }
    const pending = pendingForgotPasswordChanges.get(user.id);
    if (!pending || pending.code !== String(code) || Date.now() > pending.expires) {
      return res.status(400).json({ error: 'Invalid or expired verification session.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(new_password, salt);

    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
    pendingForgotPasswordChanges.delete(user.id);

    res.json({ success: true, message: 'Password reset successful. You can now log in.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body; // username can be username or email
  if (!username || !password) {
    return res.status(400).json({ error: 'Username/Email and password are required.' });
  }

  const db = await getDB();
  try {
    // Check by username OR email
    const user = await db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    if (user.status === 'blocked') {
      return res.status(403).json({ error: 'This account has been blocked by administration.' });
    }

    const validPass = await bcrypt.compare(password, user.password_hash);
    if (!validPass) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    // Sign Token
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    // Fetch permissions
    let permissions = null;
    if (user.role === 'employee') {
      permissions = await db.get('SELECT * FROM permissions WHERE user_id = ?', [user.id]);
    } else if (user.role === 'admin') {
      permissions = { user_management: 1, deposit_approval: 1, withdrawal_approval: 1, trade_monitoring: 1, full_access: 1 };
    }

    // Set staff token cookie if admin or employee
    if (user.role === 'admin' || user.role === 'employee') {
      res.cookie('staff_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });
    }

    // Ensure user has a referral code
    await ensureUserInviteCode(db, user);

    const refPctRow = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
    const referralCommissionPct = refPctRow ? parseFloat(refPctRow.value) : 5.0;

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        balance: user.balance,
        status: user.status,
        kyc_status: user.kyc_status,
        kyc_rejected_reason: user.kyc_rejected_reason,
        demo_balance: user.demo_balance,
        real_account_active: user.real_account_active,
        created_at: user.created_at,
        username_last_changed: user.username_last_changed,
        invite_code: user.invite_code,
        referral_commission_pct: referralCommissionPct
      },
      permissions,
      token
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// GET /auth/google/client-id: Retrieve public Google Client ID for frontend GSI button
router.get('/auth/google/client-id', (req, res) => {
  const client_id = process.env.GOOGLE_CLIENT_ID || '142646243292-5pbg6e9i72t5v2lqef4s7h9q0e8v69v2.apps.googleusercontent.com';
  res.json({ client_id });
});

// Native HTTPS GET helper for Node.js compatibility (verifies Google token info)
const https = require('https');
function verifyGoogleToken(idToken) {
  return new Promise((resolve, reject) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse Google response: ' + e.message));
          }
        } else {
          reject(new Error('Google verification returned status: ' + res.statusCode));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// POST /auth/google: Google Sign-in token verification
router.post('/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Credential token is required.' });
  }

  const db = await getDB();
  try {
    let payload;
    try {
      payload = await verifyGoogleToken(credential);
    } catch (verifyErr) {
      console.error('Google token verification failed:', verifyErr.message);
      return res.status(400).json({ error: 'Invalid Google credential token.' });
    }
    
    if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
      return res.status(400).json({ error: 'Invalid token issuer.' });
    }
    
    if (process.env.GOOGLE_CLIENT_ID && payload.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({ error: 'Invalid token audience (Client ID mismatch).' });
    }

    const googleId = payload.sub;
    const email = payload.email;
    const fullName = payload.name || '';
    const profilePic = payload.picture || '';

    if (!email) {
      return res.status(400).json({ error: 'Email not provided by Google account.' });
    }

    let user = await db.get('SELECT * FROM users WHERE google_id = ?', [googleId]);
    
    if (!user) {
      user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
      if (user) {
        await db.run('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
        user.google_id = googleId;
      }
    }

    // If user exists and has a phone number set, complete the login immediately
    if (user && user.phone_number) {
      if (user.status === 'blocked') {
        return res.status(403).json({ error: 'Your account is blocked.' });
      }

      const tokenPayload = {
        id: user.id,
        username: user.username,
        role: user.role
      };

      const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      const permRow = await db.get('SELECT * FROM permissions WHERE user_id = ?', [user.id]);
      const permissions = permRow || {
        user_management: 0,
        deposit_approval: 0,
        withdrawal_approval: 0,
        trade_monitoring: 0,
        full_access: 0,
        see_all_users: 0
      };

      const settings = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
      const referralCommissionPct = parseFloat(settings ? settings.value : '5.0');

      return res.json({
        success: true,
        is_new_user: false,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phone_number: user.phone_number,
          full_name: user.full_name,
          profile_pic: user.profile_pic,
          credit_score: user.credit_score,
          withdraw_enabled: user.withdraw_enabled,
          withdraw_limit: user.withdraw_limit,
          role: user.role,
          balance: user.balance,
          status: user.status,
          kyc_status: user.kyc_status,
          kyc_rejected_reason: user.kyc_rejected_reason,
          demo_balance: user.demo_balance,
          real_account_active: user.real_account_active,
          created_at: user.created_at,
          username_last_changed: user.username_last_changed,
          invite_code: user.invite_code,
          referral_commission_pct: referralCommissionPct
        },
        permissions,
        token
      });
    }

    // If user does not exist, create a temporary pending user
    if (!user) {
      const emailPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
      const tempUsername = 'temp_g_' + emailPrefix + '_' + Math.random().toString(36).substr(2, 6);
      
      const randomPassword = require('crypto').randomBytes(16).toString('hex');
      const passwordHash = await bcrypt.hash(randomPassword, 10);
      const tempInviteCode = 'GXM_T_' + Math.random().toString(36).substr(2, 6).toUpperCase();

      const userResult = await db.run(
        `INSERT INTO users (username, email, google_id, full_name, profile_pic, password_hash, role, status, invite_code, balance, withdraw_enabled, kyc_country)
         VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', ?, 0.0, 1, 'United States')`,
        [tempUsername, email, googleId, fullName, profilePic, passwordHash, tempInviteCode]
      );
      
      const newUserId = userResult.lastID;
      
      await db.run(
        `INSERT INTO permissions (user_id, user_management, deposit_approval, withdrawal_approval, trade_monitoring, live_support, full_access, see_all_users)
         VALUES (?, 0, 0, 0, 0, 0, 0, 0)`,
        [newUserId]
      );
    }

    // Return that profile completion registration details are required
    const emailPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
    res.json({
      success: true,
      is_new_user: true,
      default_username: emailPrefix,
      email: email
    });

  } catch (err) {
    console.error('Google login backend error:', err);
    res.status(500).json({ error: 'Server error during Google authentication.' });
  }
});

// POST /auth/google/complete: Completing first-time Google sign-up details
router.post('/auth/google/complete', async (req, res) => {
  const { credential, username, phone_number, invite_code } = req.body;
  if (!credential || !username || !phone_number) {
    return res.status(400).json({ error: 'Credential, username, and phone number are required.' });
  }

  const db = await getDB();
  try {
    let payload;
    try {
      payload = await verifyGoogleToken(credential);
    } catch (verifyErr) {
      console.error('Google token verification failed:', verifyErr.message);
      return res.status(400).json({ error: 'Invalid Google credential token.' });
    }

    const googleId = payload.sub;
    const email = payload.email;

    // Check if username is taken by anyone else
    const existingUser = await db.get('SELECT id FROM users WHERE username = ? AND (google_id IS NULL OR google_id != ?)', [username.trim(), googleId]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    const user = await db.get('SELECT * FROM users WHERE google_id = ?', [googleId]);
    if (!user) {
      return res.status(404).json({ error: 'Temporary user not found. Please log in with Google again.' });
    }

    // Check if phone number is taken by anyone else
    const phoneExists = await db.get('SELECT id FROM users WHERE phone_number = ? AND id != ?', [phone_number.trim(), user.id]);
    if (phoneExists) {
      return res.status(400).json({ error: 'Phone number is already registered by another account.' });
    }

    // Process optional invite code
    let invitedById = null;
    let codeRecord = null;
    if (invite_code && invite_code.trim()) {
      codeRecord = await db.get('SELECT * FROM invite_codes WHERE code = ?', [invite_code.trim()]);
      if (codeRecord) {
        invitedById = codeRecord.created_by_id;
      }
    }

    // Generate custom referral code for the user
    let attempts = 0;
    let refCode = '';
    while (attempts < 10) {
      refCode = 'REF' + Math.random().toString(36).substring(2, 7).toUpperCase();
      const exists = await db.get('SELECT id FROM invite_codes WHERE code = ?', [refCode]);
      if (!exists) break;
      attempts++;
    }

    // Resolve client IP address
    let currentIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '';
    if (currentIp && currentIp.includes(',')) {
      currentIp = currentIp.split(',')[0].trim();
    }
    if (currentIp === '::1' || currentIp === '::ffff:127.0.0.1') {
      currentIp = '127.0.0.1';
    }

    // Check if this IP address exists for any previous account (excluding this user)
    let conflictUser = null;
    if (currentIp) {
      conflictUser = await db.get('SELECT username FROM users WHERE last_ip = ? AND id != ? LIMIT 1', [currentIp, user.id]);
    }

    if (conflictUser) {
      try {
        await db.run(
          'INSERT INTO ip_alerts (username, ip_address, conflict_username, acknowledged) VALUES (?, ?, ?, 0)',
          [username.trim(), currentIp, conflictUser.username]
        );
      } catch (alertErr) {
        console.error('[GOOGLE SIGNUP ALERT ERROR]:', alertErr.message);
      }
    }

    const country = currentIp ? await lookupIpCountry(currentIp).catch(() => 'US') : 'US';

    await db.run(
      `UPDATE users 
       SET username = ?, phone_number = ?, invited_by_id = ?, invite_code = ?, last_ip = ?, last_country = ? 
       WHERE id = ?`,
      [username.trim(), phone_number.trim(), invitedById, refCode, currentIp || null, country, user.id]
    );

    try {
      await db.run('INSERT INTO invite_codes (code, created_by_id) VALUES (?, ?)', [refCode, user.id]);
    } catch (err) {
      console.error('[REFERRAL] Failed to insert invite code for Google user:', err);
    }

    if (codeRecord) {
      await db.run('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?', [codeRecord.id]);
    }

    const updatedUser = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);

    // Send signup success email to user
    if (email) {
      sendSystemEmail(email.trim(), 'signup_success', {
        username: updatedUser.username,
        full_name: updatedUser.full_name || updatedUser.username
      }).catch(err => console.error('[EMAIL ERROR] Google signup success email:', err.message));
    }

    const tokenPayload = {
      id: updatedUser.id,
      username: updatedUser.username,
      role: updatedUser.role
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    const permRow = await db.get('SELECT * FROM permissions WHERE user_id = ?', [updatedUser.id]);
    const permissions = permRow || {
      user_management: 0,
      deposit_approval: 0,
      withdrawal_approval: 0,
      trade_monitoring: 0,
      full_access: 0,
      see_all_users: 0
    };

    const settings = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
    const referralCommissionPct = parseFloat(settings ? settings.value : '5.0');

    res.json({
      success: true,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        phone_number: updatedUser.phone_number,
        full_name: updatedUser.full_name,
        profile_pic: updatedUser.profile_pic,
        credit_score: updatedUser.credit_score,
        withdraw_enabled: updatedUser.withdraw_enabled,
        withdraw_limit: updatedUser.withdraw_limit,
        role: updatedUser.role,
        balance: updatedUser.balance,
        status: updatedUser.status,
        kyc_status: updatedUser.kyc_status,
        kyc_rejected_reason: updatedUser.kyc_rejected_reason,
        demo_balance: updatedUser.demo_balance,
        real_account_active: updatedUser.real_account_active,
        created_at: updatedUser.created_at,
        username_last_changed: updatedUser.username_last_changed,
        invite_code: updatedUser.invite_code,
        referral_commission_pct: referralCommissionPct
      },
      permissions,
      token
    });

  } catch (err) {
    console.error('Google completion backend error:', err);
    res.status(500).json({ error: 'Server error during Google signup completion.' });
  }
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.clearCookie('staff_token');
  res.json({ success: true, message: 'Logged out successfully.' });
});

// --- PROFILE STREAK & STATS HELPERS ---
async function calculateStreak(db, userId) {
  const sql = db.isPg
    ? "SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date::text as trade_date FROM trades WHERE user_id = ? AND (is_demo = 0 OR is_demo IS NULL) ORDER BY trade_date DESC"
    : "SELECT DISTINCT date(created_at) as trade_date FROM trades WHERE user_id = ? AND (is_demo = 0 OR is_demo IS NULL) ORDER BY trade_date DESC";
  try {
    const rows = await db.all(sql, [userId]);
    if (rows.length === 0) return 0;

    const now = new Date();
    const formatLocalDate = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const todayStr = formatLocalDate(now);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = formatLocalDate(yesterday);

    const dates = rows.map(r => r.trade_date);
    let currentStreak = 0;
    let lastCheckedDate = null;

    if (dates.includes(todayStr)) {
      lastCheckedDate = now;
      currentStreak = 1;
    } else if (dates.includes(yesterdayStr)) {
      lastCheckedDate = yesterday;
      currentStreak = 1;
    } else {
      return 0;
    }

    let checkDate = new Date(lastCheckedDate);
    while (true) {
      checkDate.setDate(checkDate.getDate() - 1);
      const checkDateStr = formatLocalDate(checkDate);
      if (dates.includes(checkDateStr)) {
        currentStreak++;
      } else {
        break;
      }
    }

    return currentStreak;
  } catch (err) {
    console.error('Streak calculation failed:', err.message);
    return 0;
  }
}

async function getUserProfileDetails(db, userId) {
  const streak = await calculateStreak(db, userId);
  
  const user = await db.get("SELECT currency FROM users WHERE id = ?", [userId]);
  const userCurrency = (user?.currency || 'USD').toUpperCase().trim();
  const DEFAULT_CURRENCY_RATES = {
    USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
    EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
    IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
    THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
    PHP: 58.0, KRW: 1380.0
  };
  let userRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
  if (userCurrency !== 'USD') {
    const rateRow = await db.get("SELECT value FROM settings WHERE key = ?", [`currency_rate_${userCurrency}`]);
    if (rateRow && rateRow.value) {
      const parsedRate = parseFloat(rateRow.value);
      if (!isNaN(parsedRate) && parsedRate > 0) userRate = parsedRate;
    }
  }

  const volumeRow = await db.get(
    "SELECT COALESCE(SUM(CASE WHEN amount_usd IS NOT NULL AND amount_usd > 0 THEN amount_usd ELSE amount / ? END), 0) as total_volume FROM trades WHERE user_id = ?",
    [userRate, userId]
  );
  const totalVolume = Number(volumeRow ? volumeRow.total_volume : 0);

  const friendsRow = await db.get(
    "SELECT COUNT(*) as count FROM friends WHERE (user_id1 = ? OR user_id2 = ?) AND status = 'accepted'",
    [userId, userId]
  );
  const friendsCount = Number(friendsRow ? friendsRow.count : 0);

  return {
    streak,
    total_volume: parseFloat(totalVolume.toFixed(2)),
    friends_count: friendsCount
  };
}

router.get('/auth/me', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const user = await db.get(
      'SELECT id, username, email, phone_number, full_name, profile_pic, role, balance, demo_balance, real_account_active, status, credit_score, withdraw_enabled, withdraw_limit, kyc_status, kyc_country, kyc_rejected_reason, created_at, username_last_changed, currency, invite_code, custom_total_trades, custom_win_rate, custom_net_pnl, demo_custom_total_trades, demo_custom_win_rate, demo_custom_net_pnl FROM users WHERE id = ?',
      [req.user.id]
    );

    if (!user) {
      return res.status(401).json({ error: 'User not found.' });
    }

    // Ensure user has a referral code
    await ensureUserInviteCode(db, user);

    let referralCommissionPct = 5.0;
    if (user.role === 'employee') {
      const employeeId = Number(user.id);
      const refCodeRow = await db.get('SELECT commission_pct FROM invite_codes WHERE created_by_id = ? AND commission_pct IS NOT NULL LIMIT 1', [employeeId]);
      if (refCodeRow && refCodeRow.commission_pct !== null && refCodeRow.commission_pct !== undefined) {
        referralCommissionPct = parseFloat(refCodeRow.commission_pct);
      } else {
        const refPctRow = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
        referralCommissionPct = refPctRow ? parseFloat(refPctRow.value) : 5.0;
      }
    } else {
      const refPctRow = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
      referralCommissionPct = refPctRow ? parseFloat(refPctRow.value) : 5.0;
    }
    user.referral_commission_pct = referralCommissionPct;

    const details = await getUserProfileDetails(db, user.id);
    user.streak = details.streak;
    user.total_volume = details.total_volume;
    user.friends_count = details.friends_count;

    const globalStatusRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_global_status'");
    const globalEnabled = globalStatusRow ? globalStatusRow.value === 'true' : true;

    if (globalEnabled) {
      const activeBotKey = await db.get(
        'SELECT id FROM aibot_keys WHERE used_by_user_id = ? AND is_used = true AND (is_revoked = false OR is_revoked IS NULL) AND (is_enabled = true OR is_enabled IS NULL) LIMIT 1',
        [user.id]
      );
      user.has_active_bot = !!activeBotKey;
    } else {
      user.has_active_bot = false;
    }
    
    let permissions = null;
    if (user.role === 'employee') {
      permissions = await db.get('SELECT * FROM permissions WHERE user_id = ?', [user.id]);
    } else if (user.role === 'admin') {
      permissions = { user_management: 1, deposit_approval: 1, withdrawal_approval: 1, trade_monitoring: 1, full_access: 1 };
    }

    const delayRow = await db.get("SELECT value FROM settings WHERE key = 'page_loader_delay_ms'");
    const pageLoaderDelay = delayRow ? parseInt(delayRow.value) : 400;

    res.json({ user, permissions, page_loader_delay_ms: pageLoaderDelay });
  } catch (err) {
    console.error('Error fetching session user:', err.message);
    res.status(500).json({ error: 'Failed to retrieve session details.' });
  }
});


// --- PROFILE PICTURE UPLOAD ---

const profilePicDir = process.env.VERCEL
  ? '/tmp/uploads/profiles'
  : (fs.existsSync('/data') ? '/data/uploads/profiles' : path.join(__dirname, '..', 'public', 'uploads', 'profiles'));
if (!fs.existsSync(profilePicDir)) {
  fs.mkdirSync(profilePicDir, { recursive: true });
}

const profilePicStorage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, profilePicDir); },
  filename: (req, file, cb) => {
    cb(null, `user_${req.user?.id}_${Date.now()}${path.extname(file.originalname)}`);
  }
});
const uploadProfilePic = multer({
  storage: profilePicStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  }
});

const kycDir = process.env.VERCEL
  ? '/tmp/uploads/kyc'
  : (fs.existsSync('/data') ? '/data/uploads/kyc' : path.join(__dirname, '..', 'public', 'uploads', 'kyc'));
if (!fs.existsSync(kycDir)) {
  fs.mkdirSync(kycDir, { recursive: true });
}

const kycStorage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, kycDir); },
  filename: (req, file, cb) => {
    cb(null, `kyc_${req.user?.id}_${Date.now()}_${file.fieldname}${path.extname(file.originalname)}`);
  }
});
const uploadKyc = multer({
  storage: kycStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  }
});

router.post('/client/profile/upload-pic', authenticateToken, uploadProfilePic.single('profile_pic'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
  const db = await getDB();
  try {
    const filePath = await uploadToSupabase(req.file);
    await db.run('UPDATE users SET profile_pic = ? WHERE id = ?', [filePath, req.user.id]);
    res.json({ success: true, profile_pic: filePath });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save profile picture.' });
  }
});

// POST /api/client/profile/select-avatar - Quick select a pre-defined avatar URL
router.post('/client/profile/select-avatar', authenticateToken, async (req, res) => {
  const { avatar_url } = req.body;
  if (!avatar_url) {
    return res.status(400).json({ error: 'No avatar URL specified.' });
  }
  
  const db = await getDB();
  try {
    await db.run('UPDATE users SET profile_pic = ? WHERE id = ?', [avatar_url, req.user.id]);
    res.json({ success: true, profile_pic: avatar_url });
  } catch (err) {
    console.error('Failed to update avatar:', err.message);
    res.status(500).json({ error: 'Failed to update avatar.' });
  }
});

// POST /api/dev/upload-cropped-avatars - Temporary dev endpoint to save cropped avatars
router.post('/dev/upload-cropped-avatars', async (req, res) => {
  const { filename, image } = req.body;
  if (!filename || !image) {
    return res.status(400).json({ error: 'Filename or image data missing.' });
  }

  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'public', 'images', 'avatars');
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const base64Data = image.replace(/^data:image\/png;base64,/, "");
  try {
    fs.writeFileSync(path.join(dir, filename), base64Data, 'base64');
    res.json({ success: true, path: `/images/avatars/${filename}` });
  } catch (err) {
    console.error('Failed to save cropped avatar:', err.message);
    res.status(500).json({ error: 'Failed to save cropped avatar.' });
  }
});

// --- UPDATE PROFILE DETAILS ---
router.put('/profile/update', authenticateToken, async (req, res) => {
  const { full_name, phone_number, email, username } = req.body;
  const db = await getDB();
  try {
    const user = await db.get(
      'SELECT username, email, phone_number, full_name, created_at, username_last_changed FROM users WHERE id = ?',
      [req.user.id]
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Check if client is trying to change read-only fields
    if (full_name !== undefined && full_name.trim() !== (user.full_name || '').trim()) {
      return res.status(400).json({ error: 'Full name cannot be changed after registration.' });
    }
    if (phone_number !== undefined && phone_number.trim() !== (user.phone_number || '').trim()) {
      return res.status(400).json({ error: 'Phone number cannot be changed after registration.' });
    }
    if (email !== undefined && email.trim().toLowerCase() !== (user.email || '').toLowerCase()) {
      return res.status(400).json({ error: 'Email address cannot be changed after registration.' });
    }

    const updates = [];
    const params = [];

    if (username !== undefined) {
      const usernameTrimmed = username.trim().toLowerCase();
      if (usernameTrimmed && usernameTrimmed !== user.username.toLowerCase()) {
        const createdAt = new Date(user.created_at);
        const now = new Date();
        const lastChanged = user.username_last_changed ? new Date(user.username_last_changed) : null;
        
        // 30 days restriction from account creation
        const daysSinceCreation = (now - createdAt) / (1000 * 60 * 60 * 24);
        if (daysSinceCreation < 30) {
          return res.status(400).json({ error: 'Username can only be changed after 30 days of account creation.' });
        }
        
        // 7 days restriction since last change
        if (lastChanged) {
          const daysSinceLastChange = (now - lastChanged) / (1000 * 60 * 60 * 24);
          if (daysSinceLastChange < 7) {
            return res.status(400).json({ error: 'Username can only be changed once every 7 days.' });
          }
        }
        
        // Check if username already exists for another user
        const existing = await db.get('SELECT id FROM users WHERE username = ? AND id != ?', [usernameTrimmed, req.user.id]);
        if (existing) {
          return res.status(400).json({ error: 'Username is already taken.' });
        }
        
        updates.push('username = ?');
        params.push(usernameTrimmed);
        
        updates.push('username_last_changed = ?');
        params.push(now.toISOString());
      }
    }

    if (updates.length === 0) {
      const updatedUser = await db.get(
        'SELECT id, username, email, phone_number, full_name, profile_pic, role, balance, demo_balance, real_account_active, status, credit_score, withdraw_enabled, withdraw_limit, kyc_status, kyc_rejected_reason, created_at, username_last_changed, currency FROM users WHERE id = ?',
        [req.user.id]
      );
      return res.json({ success: true, message: 'Profile updated successfully.', user: updatedUser });
    }

    params.push(req.user.id);
    await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    // Fetch updated user
    const updatedUser = await db.get(
      'SELECT id, username, email, phone_number, full_name, profile_pic, role, balance, demo_balance, real_account_active, status, credit_score, withdraw_enabled, withdraw_limit, kyc_status, kyc_rejected_reason, created_at, username_last_changed, currency FROM users WHERE id = ?',
      [req.user.id]
    );

    res.json({ success: true, message: 'Profile updated successfully.', user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile: ' + err.message });
  }
});

// --- DELETE OWN ACCOUNT ---
router.post('/profile/delete', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    await db.run('DELETE FROM users WHERE id = ?', [req.user.id]);
    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete account: ' + err.message });
  }
});

// --- IN-MEMORY TEMPORARY STORES FOR OTP VERIFICATIONS ---
function getEmailChangeTemplate(code) {
  const digits = String(code).split('');
  const digitsHtml = `
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse; margin-top: 15px; margin-bottom: 15px;">
      <tr>
        ${digits.map(d => `
          <td style="padding: 0 4px; width: 16.66%;">
            <div class="digit-box" style="height: 72px; background-color: #E8F5EC; border: 1px solid #A8D4B2; border-top: 2.5px solid #1A7A4A; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 30px; font-weight: 900; color: #0C1A0F; text-align: center; line-height: 72px;">${d}</div>
          </td>
        `).join('')}
      </tr>
    </table>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="color-scheme" content="light dark"/>
  <title>Confirm Email Change — GaineXMarket</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background-color: #F0FAF4;
      color: #0C1A0F;
      min-height: 100vh;
      padding: 36px 16px;
      margin: 0;
    }
    .card {
      max-width: 580px;
      margin: 0 auto;
      background-color: #ffffff;
      border: 1px solid #D4EAD9;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.06), 0 12px 40px rgba(0,0,0,0.09);
    }
    .hd {
      background-color: #1A7A4A;
      padding: 22px 32px;
    }
    .logo {
      font-size: 20px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -.3px;
      float: left;
    }
    .logo span {
      color: #7EEDB4;
    }
    .hd-badge {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: .9px;
      text-transform: uppercase;
      color: #7EEDB4;
      background-color: rgba(126,237,180,0.15);
      border: 1px solid rgba(126,237,180,0.35);
      border-radius: 4px;
      padding: 4px 11px;
      float: right;
    }
    .hero {
      background: linear-gradient(170deg,#0F5C35 0%,#1A7A4A 100%);
      padding: 36px 32px 32px;
      text-align: center;
      clear: both;
    }
    .hero-icon {
      width: 60px;
      height: 60px;
      margin: 0 auto 18px;
      background-color: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 14px;
      text-align: center;
      line-height: 58px;
      font-size: 28px;
      color: #ffffff;
    }
    .hero h1 {
      font-size: 22px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -.3px;
      margin-bottom: 8px;
      margin-top: 0;
    }
    .hero p {
      font-size: 13.5px;
      color: rgba(255,255,255,0.68);
      line-height: 1.6;
      margin: 0;
    }
    .hero p strong {
      color: #ffffff;
    }
    .bd {
      padding: 32px 32px 28px;
    }
    .note {
      background-color: #F5FBF7;
      border: 1px solid #C0DEC6;
      border-radius: 8px;
      padding: 14px 18px;
      margin-bottom: 28px;
      font-size: 13px;
      color: #476B52;
      line-height: 1.6;
    }
    .note strong {
      color: #0C1A0F;
    }
    .otp-header {
      margin-bottom: 14px;
      height: 20px;
    }
    .otp-lbl {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 1.1px;
      text-transform: uppercase;
      color: #8AADA0;
      float: left;
      line-height: 20px;
    }
    .otp-exp {
      font-size: 11px;
      font-weight: 600;
      color: #1A7A4A;
      background-color: #F5FBF7;
      border: 1px solid #C0DEC6;
      border-radius: 4px;
      padding: 3px 9px;
      letter-spacing: .2px;
      float: right;
      line-height: 12px;
    }
    .otp-hint {
      font-size: 11.5px;
      color: #8AADA0;
      text-align: center;
      margin-top: 10px;
      margin-bottom: 28px;
    }
    .warn {
      background-color: rgba(239,68,68,0.05);
      border: 1px solid rgba(239,68,68,0.2);
      border-radius: 8px;
      padding: 14px 18px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .warn-i {
      font-size: 16px;
      flex-shrink: 0;
    }
    .warn-t {
      font-size: 12.5px;
      color: #476B52;
      line-height: 1.6;
    }
    .warn-t strong {
      color: #EF4444;
    }
    .warn-t a {
      color: #1A7A4A;
      font-weight: 600;
      text-decoration: none;
    }
    .ft {
      padding: 18px 32px 22px;
      border-top: 1px solid #D4EAD9;
      background-color: #F5FBF7;
      clear: both;
    }
    .ft-t {
      font-size: 12px;
      color: #476B52;
      text-align: center;
      line-height: 1.6;
      margin: 0;
    }
    .ft-t a {
      color: #1A7A4A;
      text-decoration: none;
      font-weight: 600;
    }
    .ft-hr {
      border: none;
      border-top: 1px solid #D4EAD9;
      margin: 10px 0;
    }
    .ft-l {
      font-size: 11px;
      text-align: center;
      color: #8AADA0;
      margin: 0;
    }
    @media(max-width:480px){
      .hd, .hero, .bd, .ft { padding-left: 20px !important; padding-right: 20px !important; }
      .digit-box { height: 60px !important; font-size: 24px !important; line-height: 60px !important; }
    }
    @media(prefers-color-scheme:dark){
      body {
        background-color: #090D0A !important;
        color: #D4EFD9 !important;
      }
      .card {
        background-color: #0D1410 !important;
        border-color: #1A2B1D !important;
        box-shadow: 0 2px 4px rgba(0,0,0,0.4), 0 12px 40px rgba(0,0,0,0.6) !important;
      }
      .digit-box {
        background-color: #0C1F10 !important;
        border-color: #183D20 !important;
        border-top-color: #22C55E !important;
        color: #22C55E !important;
      }
      .note {
        background-color: #111A13 !important;
        border-color: #1F3323 !important;
        color: #5A8A65 !important;
      }
      .note strong {
        color: #D4EFD9 !important;
      }
      .otp-lbl {
        color: #2D4D35 !important;
      }
      .otp-exp {
        background-color: #111A13 !important;
        border-color: #1F3323 !important;
        color: #22C55E !important;
      }
      .otp-hint {
        color: #2D4D35 !important;
      }
      .warn {
        background-color: rgba(239,68,68,0.07) !important;
        border-color: rgba(239,68,68,0.22) !important;
      }
      .warn-t {
        color: #5A8A65 !important;
      }
      .warn-t a {
        color: #22C55E !important;
      }
      .ft {
        background-color: #111A13 !important;
        border-top-color: #1A2B1D !important;
      }
      .ft-t {
        color: #5A8A65 !important;
      }
      .ft-t a {
        color: #22C55E !important;
      }
      .ft-hr {
        border-top-color: #1A2B1D !important;
      }
      .ft-l {
        color: #2D4D35 !important;
      }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="hd">
      <div class="logo">Gaine<span>X</span>Market</div>
      <div class="hd-badge">Email Change</div>
    </div>
    <div class="hero">
      <div class="hero-icon">✉️</div>
      <h1>Confirm Your Email Change</h1>
      <p>We received a request to update the email on your <strong>GaineXMarket</strong> account.<br>Enter the code below to confirm.</p>
    </div>
    <div class="bd">
      <div class="note">
        This code will expire in <strong>5 minutes</strong>. If you did not request an email change, you can safely ignore this message — no changes will be made.
      </div>
      <div class="otp-header">
        <div class="otp-lbl">Your Verification Code</div>
        <div class="otp-exp">⏱ Expires in 5:00</div>
      </div>
      ${digitsHtml}
      <p class="otp-hint">Enter this code in the verification screen inside the app</p>
      <div class="warn">
        <div class="warn-i">🛡️</div>
        <div class="warn-t">
          <strong>Didn't request this?</strong> Contact our support team immediately at
          <a href="mailto:noreply@gainexmarket.com">noreply@gainexmarket.com</a>
          and do not enter this code anywhere.
        </div>
      </div>
    </div>
    <div class="ft">
      <p class="ft-t">Sent by GaineXMarket &nbsp;·&nbsp; <a href="mailto:noreply@gainexmarket.com">noreply@gainexmarket.com</a></p>
      <hr class="ft-hr"/>
      <p class="ft-l">© 2026 GaineXMarket. All rights reserved. This is an automated security email.</p>
    </div>
  </div>
</body>
</html>`;
}

function getPasswordChangeTemplate(code) {
  const digits = String(code).split('');
  const digitsHtml = `
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse; margin-top: 15px; margin-bottom: 15px;">
      <tr>
        ${digits.map(d => `
          <td style="padding: 0 4px; width: 16.66%;">
            <div class="digit-box" style="height: 72px; background-color: #E8F5EC; border: 1px solid #A8D4B2; border-top: 2.5px solid #1A7A4A; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 30px; font-weight: 900; color: #0C1A0F; text-align: center; line-height: 72px;">${d}</div>
          </td>
        `).join('')}
      </tr>
    </table>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="color-scheme" content="light dark"/>
  <title>Password Reset — GaineXMarket</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background-color: #F0FAF4;
      color: #0C1A0F;
      min-height: 100vh;
      padding: 36px 16px;
      margin: 0;
    }
    .card {
      max-width: 580px;
      margin: 0 auto;
      background-color: #ffffff;
      border: 1px solid #D4EAD9;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.06), 0 12px 40px rgba(0,0,0,0.09);
    }
    .hd {
      background-color: #1A7A4A;
      padding: 22px 32px;
    }
    .logo {
      font-size: 20px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -.3px;
      float: left;
    }
    .logo span {
      color: #7EEDB4;
    }
    .hd-badge {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: .9px;
      text-transform: uppercase;
      color: #7EEDB4;
      background-color: rgba(126,237,180,0.15);
      border: 1px solid rgba(126,237,180,0.35);
      border-radius: 4px;
      padding: 4px 11px;
      float: right;
    }
    .hero {
      background: linear-gradient(170deg,#0F5C35 0%,#1A7A4A 100%);
      padding: 36px 32px 32px;
      text-align: center;
      clear: both;
    }
    .hero-icon {
      width: 60px;
      height: 60px;
      margin: 0 auto 18px;
      background-color: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 14px;
      text-align: center;
      line-height: 58px;
      font-size: 26px;
      color: #ffffff;
    }
    .hero h1 {
      font-size: 22px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -.3px;
      margin-bottom: 8px;
      margin-top: 0;
    }
    .hero p {
      font-size: 13.5px;
      color: rgba(255,255,255,0.68);
      line-height: 1.6;
      margin: 0;
    }
    .hero p strong {
      color: #ffffff;
    }
    .bd {
      padding: 32px 32px 28px;
    }
    .note {
      background-color: #F5FBF7;
      border: 1px solid #C0DEC6;
      border-radius: 8px;
      padding: 14px 18px;
      margin-bottom: 28px;
      font-size: 13px;
      color: #476B52;
      line-height: 1.6;
    }
    .note strong {
      color: #0C1A0F;
    }
    .otp-header {
      margin-bottom: 14px;
      height: 20px;
    }
    .otp-lbl {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 1.1px;
      text-transform: uppercase;
      color: #8AADA0;
      float: left;
      line-height: 20px;
    }
    .otp-exp {
      font-size: 11px;
      font-weight: 600;
      color: #1A7A4A;
      background-color: #F5FBF7;
      border: 1px solid #C0DEC6;
      border-radius: 4px;
      padding: 3px 9px;
      letter-spacing: .2px;
      float: right;
      line-height: 12px;
    }
    .otp-hint {
      font-size: 11.5px;
      color: #8AADA0;
      text-align: center;
      margin-top: 10px;
      margin-bottom: 28px;
    }
    .warn {
      background-color: rgba(239,68,68,0.05);
      border: 1px solid rgba(239,68,68,0.2);
      border-radius: 8px;
      padding: 14px 18px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .warn-i {
      font-size: 16px;
      flex-shrink: 0;
    }
    .warn-t {
      font-size: 12.5px;
      color: #476B52;
      line-height: 1.6;
    }
    .warn-t strong {
      color: #EF4444;
    }
    .warn-t a {
      color: #1A7A4A;
      font-weight: 600;
      text-decoration: none;
    }
    .ft {
      padding: 18px 32px 22px;
      border-top: 1px solid #D4EAD9;
      background-color: #F5FBF7;
      clear: both;
    }
    .ft-t {
      font-size: 12px;
      color: #476B52;
      text-align: center;
      line-height: 1.6;
      margin: 0;
    }
    .ft-t a {
      color: #1A7A4A;
      text-decoration: none;
      font-weight: 600;
    }
    .ft-hr {
      border: none;
      border-top: 1px solid #D4EAD9;
      margin: 10px 0;
    }
    .ft-l {
      font-size: 11px;
      text-align: center;
      color: #8AADA0;
      margin: 0;
    }
    @media(max-width:480px){
      .hd, .hero, .bd, .ft { padding-left: 20px !important; padding-right: 20px !important; }
      .digit-box { height: 60px !important; font-size: 24px !important; line-height: 60px !important; }
    }
    @media(prefers-color-scheme:dark){
      body {
        background-color: #090D0A !important;
        color: #D4EFD9 !important;
      }
      .card {
        background-color: #0D1410 !important;
        border-color: #1A2B1D !important;
        box-shadow: 0 2px 4px rgba(0,0,0,0.4), 0 12px 40px rgba(0,0,0,0.6) !important;
      }
      .digit-box {
        background-color: #0C1F10 !important;
        border-color: #183D20 !important;
        border-top-color: #22C55E !important;
        color: #22C55E !important;
      }
      .note {
        background-color: #111A13 !important;
        border-color: #1F3323 !important;
        color: #5A8A65 !important;
      }
      .note strong {
        color: #D4EFD9 !important;
      }
      .otp-lbl {
        color: #2D4D35 !important;
      }
      .otp-exp {
        background-color: #111A13 !important;
        border-color: #1F3323 !important;
        color: #22C55E !important;
      }
      .otp-hint {
        color: #2D4D35 !important;
      }
      .warn {
        background-color: rgba(239,68,68,0.07) !important;
        border-color: rgba(239,68,68,0.22) !important;
      }
      .warn-t {
        color: #5A8A65 !important;
      }
      .warn-t a {
        color: #22C55E !important;
      }
      .ft {
        background-color: #111A13 !important;
        border-top-color: #1A2B1D !important;
      }
      .ft-t {
        color: #5A8A65 !important;
      }
      .ft-t a {
        color: #22C55E !important;
      }
      .ft-hr {
        border-top-color: #1A2B1D !important;
      }
      .ft-l {
        color: #2D4D35 !important;
      }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="hd">
      <div class="logo">Gaine<span>X</span>Market</div>
      <div class="hd-badge">Password Reset</div>
    </div>
    <div class="hero">
      <div class="hero-icon">🔒</div>
      <h1>Password Reset Request</h1>
      <p>We received a request to reset the password on your <strong>GaineXMarket</strong> account.<br>Enter the code below to proceed.</p>
    </div>
    <div class="bd">
      <div class="note">
        This code will expire in <strong>5 minutes</strong>. If you did not request a password reset, you can safely ignore this message — your password will not change.
      </div>
      <div class="otp-header">
        <div class="otp-lbl">Your Reset Code</div>
        <div class="otp-exp">⏱ Expires in 5:00</div>
      </div>
      ${digitsHtml}
      <p class="otp-hint">Enter this code on the password reset screen inside the app</p>
      <div class="warn">
        <div class="warn-i">🛡️</div>
        <div class="warn-t">
          <strong>Suspicious activity?</strong> Contact our support team immediately at
          <a href="mailto:noreply@gainexmarket.com">noreply@gainexmarket.com</a>
          and do not enter this code anywhere.
        </div>
      </div>
    </div>
    <div class="ft">
      <p class="ft-t">Sent by GaineXMarket &nbsp;·&nbsp; <a href="mailto:noreply@gainexmarket.com">noreply@gainexmarket.com</a></p>
      <hr class="ft-hr"/>
      <p class="ft-l">© 2026 GaineXMarket. All rights reserved. This is an automated security email.</p>
    </div>
  </div>
</body>
</html>`;
}

const pendingEmailChanges = new Map();
const pendingPasswordChanges = new Map();

// 1. Request Change Email - Step 1: Send OTP code to current email
router.post('/profile/change-email/request-current', authenticateToken, async (req, res) => {
  try {
    const db = await getDB();
    const user = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!user.email) return res.status(400).json({ error: 'No email address registered.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000;

    pendingEmailChanges.set(req.user.id, {
      currentCode: code,
      currentExpires: expires,
      currentVerified: false,
      newEmail: null,
      newCode: null,
      newExpires: null
    });

    const htmlContent = getEmailChangeTemplate(code);
    const sent = await sendSystemEmail(user.email, 'custom_email', {
      subject: 'Confirm Email Change — GaineXMarket',
      html_content: htmlContent,
      username: user.username,
      full_name: user.full_name || user.username
    });

    if (sent) {
      res.json({ success: true, message: 'Verification code sent to current email.' });
    } else {
      res.status(500).json({ error: 'Failed to send verification email.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Verify Change Email - Step 2: Confirm code sent to current email
router.post('/profile/change-email/verify-current', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    const pending = pendingEmailChanges.get(req.user.id);
    if (!pending || pending.currentCode !== String(code) || Date.now() > pending.currentExpires) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }

    pending.currentVerified = true;
    pendingEmailChanges.set(req.user.id, pending);

    res.json({ success: true, message: 'Current email successfully verified.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Request Change Email - Step 3: Send OTP code to new email address
router.post('/profile/change-email/request-new', authenticateToken, async (req, res) => {
  try {
    const { new_email } = req.body;
    if (!new_email || !new_email.includes('@')) {
      return res.status(400).json({ error: 'Valid new email address is required.' });
    }

    const pending = pendingEmailChanges.get(req.user.id);
    if (!pending || !pending.currentVerified) {
      return res.status(400).json({ error: 'Please verify your current email first.' });
    }

    const db = await getDB();
    const emailExists = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [new_email.trim(), req.user.id]);
    if (emailExists) {
      return res.status(400).json({ error: 'This email is already in use by another account.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000;

    pending.newEmail = new_email.trim();
    pending.newCode = code;
    pending.newExpires = expires;
    pendingEmailChanges.set(req.user.id, pending);

    const user = await db.get('SELECT username, full_name FROM users WHERE id = ?', [req.user.id]);
    const htmlContent = getEmailChangeTemplate(code);
    const sent = await sendSystemEmail(new_email.trim(), 'custom_email', {
      subject: 'Confirm Email Change — GaineXMarket',
      html_content: htmlContent,
      username: user.username,
      full_name: user.full_name || user.username
    });

    if (sent) {
      res.json({ success: true, message: 'Verification code sent to new email.' });
    } else {
      res.status(500).json({ error: 'Failed to send verification email.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Verify Change Email - Step 4: Confirm code sent to new email and update db
router.post('/profile/change-email/verify-new', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    const pending = pendingEmailChanges.get(req.user.id);
    if (!pending || !pending.currentVerified || !pending.newEmail) {
      return res.status(400).json({ error: 'Session mismatch. Please restart email change process.' });
    }

    if (pending.newCode !== String(code) || Date.now() > pending.newExpires) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }

    const db = await getDB();
    await db.run('UPDATE users SET email = ? WHERE id = ?', [pending.newEmail, req.user.id]);

    pendingEmailChanges.delete(req.user.id);

    res.json({ success: true, message: 'Email address updated successfully.', new_email: pending.newEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Request Change Password - Step 1: Send OTP code to current email
router.post('/profile/change-password/request', authenticateToken, async (req, res) => {
  try {
    const db = await getDB();
    const user = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!user.email) return res.status(400).json({ error: 'No email address registered.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000;

    pendingPasswordChanges.set(req.user.id, {
      code: code,
      expires: expires
    });

    const htmlContent = getPasswordChangeTemplate(code);
    const sent = await sendSystemEmail(user.email, 'custom_email', {
      subject: 'Password Reset — GaineXMarket',
      html_content: htmlContent,
      username: user.username,
      full_name: user.full_name || user.username
    });

    if (sent) {
      res.json({ success: true, message: 'Verification code sent to current email.' });
    } else {
      res.status(500).json({ error: 'Failed to send verification email.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Verify and Change Password - Step 2: Confirm code and change password
router.post('/profile/change-password/verify', authenticateToken, async (req, res) => {
  try {
    const { code, new_password } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }

    const pending = pendingPasswordChanges.get(req.user.id);
    if (!pending || pending.code !== String(code) || Date.now() > pending.expires) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }

    const db = await getDB();
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(new_password, salt);

    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user.id]);

    pendingPasswordChanges.delete(req.user.id);

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SUBMIT KYC ---
router.post('/client/kyc/submit', authenticateToken, uploadKyc.fields([
  { name: 'document_front', maxCount: 1 },
  { name: 'document_back', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]), async (req, res) => {
  const { country, address } = req.body;
  if (!country || !address) {
    return res.status(400).json({ error: 'Country and address are required fields.' });
  }

  const db = await getDB();
  const user = await db.get('SELECT kyc_status FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (user.kyc_status === 'verified') {
    return res.status(400).json({ error: 'Your account KYC is already verified.' });
  }
  if (user.kyc_status === 'pending') {
    return res.status(400).json({ error: 'Your KYC verification is already pending review.' });
  }

  // Validate files
  if (!req.files || !req.files.document_front || !req.files.document_front[0]) {
    return res.status(400).json({ error: 'Document Front image is required.' });
  }
  if (!req.files || !req.files.document_back || !req.files.document_back[0]) {
    return res.status(400).json({ error: 'Document Back image is required.' });
  }

  let selfiePath = null;
  if (req.files && req.files.selfie && req.files.selfie[0]) {
    selfiePath = await uploadToSupabase(req.files.selfie[0]);
  } else if (req.body.selfie_base64) {
    try {
      const base64Data = req.body.selfie_base64.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = 'kyc-selfie-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + '.png';
      
      if (supabase) {
        const { data, error } = await supabase.storage
          .from('gainex-uploads')
          .upload(filename, buffer, {
            contentType: 'image/png',
            upsert: true
          });
        if (error) throw error;
        selfiePath = supabase.storage.from('gainex-uploads').getPublicUrl(filename).data.publicUrl;
      } else {
        const savePath = path.join(kycDir, filename);
        fs.writeFileSync(savePath, buffer);
        selfiePath = `/uploads/kyc/${filename}`;
      }
    } catch (err) {
      console.error('Selfie save error:', err);
      return res.status(400).json({ error: 'Invalid selfie base64 image.' });
    }
  }

  const docFront = await uploadToSupabase(req.files.document_front[0]);
  const docBack = await uploadToSupabase(req.files.document_back[0]);
  const submittedAt = new Date().toISOString();

  try {
    await db.run(
      `UPDATE users SET
        kyc_status = 'pending',
        kyc_country = ?,
        kyc_address = ?,
        kyc_document_front = ?,
        kyc_document_back = ?,
        kyc_selfie = ?,
        kyc_submitted_at = ?,
        kyc_rejected_reason = NULL
       WHERE id = ?`,
      [country.trim(), address.trim(), docFront, docBack, selfiePath, submittedAt, req.user.id]
    );

    const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [req.user.id]);
    if (userDetail && userDetail.email) {
      sendSystemEmail(userDetail.email, 'kyc_submitted', {
        username: userDetail.username,
        full_name: userDetail.full_name || userDetail.username
      }).catch(err => console.error('[EMAIL ERROR] KYC submitted email:', err.message));
    }

    if (userDetail) {
      const kycMsg = `📄 *New KYC Document Submitted*\n` +
        `👤 *Username*: ${telegramService.escapeMarkdown(userDetail.username)}\n` +
        `🆔 *User ID*: ${req.user.id}\n` +
        `🌍 *Country*: ${telegramService.escapeMarkdown(country.trim())}\n` +
        `🏠 *Address*: ${telegramService.escapeMarkdown(address.trim())}`;

      const kycPhoto = docFront || selfiePath || docBack;
      if (kycPhoto) {
        telegramService.sendPhoto(kycPhoto, kycMsg).catch(err => console.error('[TELEGRAM ERROR] KYC photo notification:', err.message));
        whatsappService.sendPhoto(kycPhoto, kycMsg).catch(err => console.error('[WHATSAPP ERROR] KYC photo notification:', err.message));
      } else {
        telegramService.sendNotification(kycMsg).catch(err => console.error('[TELEGRAM ERROR] KYC notification:', err.message));
        whatsappService.sendNotification(kycMsg).catch(err => console.error('[WHATSAPP ERROR] KYC notification:', err.message));
      }
    }

    res.json({ success: true, message: 'KYC documents submitted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit KYC documents: ' + err.message });
  }
});

// --- CLIENT WALLET, DEPOSIT, WITHDRAWAL & HISTORY ROUTES ---

router.get('/public/currencies', async (req, res) => {
  const db = await getDB();
  try {
    const rows = await db.all("SELECT key, value FROM settings WHERE key LIKE 'currency_rate_%'");
    const currencies = {};
    rows.forEach(r => {
      const code = r.key.replace('currency_rate_', '').toUpperCase();
      currencies[code] = parseFloat(r.value || 0);
    });
    if (!currencies.USD) {
      currencies.USD = 1.0;
    }
    res.json({ currencies });
  } catch (err) {
    console.error('Error fetching currencies:', err.message);
    res.status(500).json({ error: 'Failed to fetch currencies.' });
  }
});

// Helper to fetch active custom leaderboard entries and shuffle them daily using Pakistan Time (UTC+05:00)

async function getShuffledCustomEntries(db, autoFluctuate, minProfit, maxProfit) {
  const customEntries = await db.all(`
    SELECT c.*, u.profile_pic as reg_pic
    FROM custom_leaderboard c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.is_active = 1
    ORDER BY COALESCE(c.position, 999) ASC, c.net_profit DESC
  `);

  if (customEntries.length === 0) return [];

  // Generate daily seed based on Pakistan Time (UTC+05:00)
  const pkDate = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const daySeed = pkDate.getUTCFullYear() * 10000 + (pkDate.getUTCMonth() + 1) * 100 + pkDate.getUTCDate();

  const seededRandom = (seed) => {
    let s = seed;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  };
  const rand = seededRandom(daySeed);

  // Extract profiles
  const profiles = customEntries.map(c => ({
    username: c.username,
    full_name: c.full_name,
    avatar_url: c.avatar_url,
    reg_pic: c.reg_pic,
    country: c.country
  }));

  // Shuffle profiles using the daily seed
  const shuffledProfiles = [...profiles];
  for (let i = shuffledProfiles.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const temp = shuffledProfiles[i];
    shuffledProfiles[i] = shuffledProfiles[j];
    shuffledProfiles[j] = temp;
  }

  const timeSeed = Math.floor(Date.now() / (10 * 60 * 1000));
  return customEntries.map((c, idx) => {
    const profile = shuffledProfiles[idx % shuffledProfiles.length];
    let profit = parseFloat(c.net_profit || 0);
    if (autoFluctuate) {
      const shift = ((c.id * 19 + timeSeed * 37) % 61) - 30; // fluctuates +/- $30
      profit += shift;
      if (profit < minProfit) profit = minProfit;
      if (profit > maxProfit) profit = maxProfit;
    }
    return {
      id: c.user_id ? Number(c.user_id) : `custom_${c.id}`,
      custom_id: c.id,
      username: profile.username,
      full_name: profile.full_name || profile.username,
      profile_pic: profile.avatar_url || profile.reg_pic || null,
      kyc_country: profile.country || 'US',
      net_profit: profit,
      won_trades: c.won_trades,
      lost_trades: c.lost_trades,
      pinned_position: c.position ? Number(c.position) : null,
      is_custom: true,
      streak: 3 + ((c.id * 7) % 15)
    };
  });
}

function generateRandomDemoSequence(balance) {
  let numTrades = 3;
  if (balance < 50) {
    numTrades = 0;
  } else if (balance >= 50 && balance < 100) {
    numTrades = 3;
  } else if (balance >= 100 && balance < 200) {
    numTrades = 5;
  } else if (balance >= 200 && balance < 400) {
    numTrades = 8;
  } else if (balance >= 400 && balance < 800) {
    numTrades = 10;
  } else if (balance >= 800 && balance < 1600) {
    numTrades = 11;
  } else if (balance >= 1600 && balance < 5000) {
    numTrades = 12;
  } else if (balance >= 5000 && balance < 10000) {
    numTrades = 20 + Math.floor(Math.random() * 6);
  } else {
    numTrades = 25;
  }

  const sequence = [];
  for (let i = 0; i < numTrades; i++) {
    const timer = 10 + Math.floor(Math.random() * 21);
    let pct = 5;
    if (balance >= 50 && balance < 100) {
      const targetAmount = 3 + Math.floor(Math.random() * 3);
      pct = parseFloat(((targetAmount / balance) * 100).toFixed(1));
    } else if (balance >= 100 && balance < 200) {
      pct = 3 + Math.floor(Math.random() * 6);
    } else if (balance >= 200 && balance < 400) {
      pct = 4 + Math.floor(Math.random() * 7);
    } else if (balance >= 400 && balance < 800) {
      pct = 5 + Math.floor(Math.random() * 8);
    } else if (balance >= 800 && balance < 1600) {
      pct = 5 + Math.floor(Math.random() * 9);
    } else if (balance >= 1600 && balance < 5000) {
      pct = 6 + Math.floor(Math.random() * 10);
    } else if (balance >= 5000 && balance < 10000) {
      pct = 8 + Math.floor(Math.random() * 13);
    } else {
      pct = 10 + Math.floor(Math.random() * 11);
    }
    const outcome = 'win';
    sequence.push({ timer, pct, outcome });
  }
  return sequence;
}


// GET: Leaderboard - fetch users sorted by trade earnings with Custom Leaderboard & Hybrid Fluctuation support
router.get('/client/leaderboard', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const testUserFilter = db.isPg ? 'AND (u.is_test = FALSE OR u.is_test IS NULL)' : 'AND (u.is_test = 0 OR u.is_test IS NULL)';
    const offsetMinutes = 300; 

    const pgOffset = '300 minutes';
    const sqliteOffset = '+300 minutes';
    const sqliteNegOffset = '-300 minutes';

    const timeFilter = db.isPg
      ? `t.created_at AT TIME ZONE 'UTC' >= (NOW() AT TIME ZONE 'UTC' + INTERVAL '${pgOffset}')::date::timestamp - INTERVAL '${pgOffset}'
         AND t.created_at AT TIME ZONE 'UTC' < (NOW() AT TIME ZONE 'UTC' + INTERVAL '${pgOffset}')::date::timestamp + INTERVAL '1 day' - INTERVAL '${pgOffset}'`
      : `t.created_at >= datetime('now', '${sqliteOffset}', 'start of day', '${sqliteNegOffset}')
         AND t.created_at < datetime('now', '${sqliteOffset}', 'start of day', '+1 day', '${sqliteNegOffset}')`;

    // Fetch Global Leaderboard Settings
    const minRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_min_profit'");
    const maxRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_max_profit'");
    const autoRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_auto_fluctuate'");
    const minProfit = minRow ? parseFloat(minRow.value) : 100;
    const maxProfit = maxRow ? parseFloat(maxRow.value) : 50000;
    const autoFluctuate = autoRow ? autoRow.value === 'true' : true;

    // 1. Fetch real top traders
    const profitQuery = `
      SELECT
        u.id,
        u.username,
        u.full_name,
        u.profile_pic,
        u.kyc_status,
        u.kyc_country,
        COALESCE(SUM(
          CASE
            WHEN t.status = 'win' THEN (
              CASE 
                WHEN t.amount_usd IS NOT NULL AND t.amount_usd > 0 THEN t.amount_usd 
                ELSE t.amount / (CASE WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PKR' THEN 278.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'INR' THEN 84.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BDT' THEN 117.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NPR' THEN 133.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NRP' THEN 133.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EUR' THEN 0.92 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'GBP' THEN 0.78 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'AED' THEN 3.67 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'SAR' THEN 3.75 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'TRY' THEN 32.5 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NGN' THEN 1500.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'IDR' THEN 16000.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BRL' THEN 5.4 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EGP' THEN 48.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MYR' THEN 4.7 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KZT' THEN 475.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'THB' THEN 36.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'UAH' THEN 41.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'VND' THEN 25400.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MXN' THEN 18.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'JPY' THEN 160.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PHP' THEN 58.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KRW' THEN 1380.0 ELSE 1.0 END)
              END
            ) * t.commission_pct / 100.0
            WHEN t.status = 'lose' THEN -(
              CASE 
                WHEN t.amount_usd IS NOT NULL AND t.amount_usd > 0 THEN t.amount_usd 
                ELSE t.amount / (CASE WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PKR' THEN 278.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'INR' THEN 84.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BDT' THEN 117.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NPR' THEN 133.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NRP' THEN 133.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EUR' THEN 0.92 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'GBP' THEN 0.78 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'AED' THEN 3.67 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'SAR' THEN 3.75 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'TRY' THEN 32.5 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NGN' THEN 1500.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'IDR' THEN 16000.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BRL' THEN 5.4 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EGP' THEN 48.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MYR' THEN 4.7 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KZT' THEN 475.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'THB' THEN 36.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'UAH' THEN 41.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'VND' THEN 25400.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MXN' THEN 18.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'JPY' THEN 160.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PHP' THEN 58.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KRW' THEN 1380.0 ELSE 1.0 END)
              END
            )
            ELSE 0
          END
        ), 0) AS net_profit
      FROM users u
      LEFT JOIN trades t ON u.id = t.user_id
        AND (t.is_demo = 0 OR t.is_demo IS NULL)
        AND t.status IN ('win', 'lose')
        AND ${timeFilter}
      WHERE u.role = 'user' ${testUserFilter}
      GROUP BY u.id, u.username, u.full_name, u.profile_pic, u.kyc_status, u.kyc_country, u.currency
      ORDER BY net_profit DESC
      LIMIT 25
    `;
    const realTraders = await db.all(profitQuery);

    // 2. Fetch active custom leaderboard entries (shuffled daily)
    const processedCustomEntries = await getShuffledCustomEntries(db, autoFluctuate, minProfit, maxProfit);

    // 3. Merge real traders & custom entries
    const combinedList = [];
    const pinnedPositions = {};

    processedCustomEntries.forEach(item => {
      if (item.pinned_position && item.pinned_position > 0 && item.pinned_position <= 20) {
        pinnedPositions[item.pinned_position] = item;
      } else {
        combinedList.push(item);
      }
    });

    realTraders.forEach(rt => {
      // Check if user is already covered by a custom entry
      const existingCustom = processedCustomEntries.find(c => c.id === Number(rt.id));
      if (!existingCustom) {
        combinedList.push({
          id: Number(rt.id),
          username: rt.username,
          full_name: rt.full_name || rt.username,
          profile_pic: rt.profile_pic,
          kyc_country: rt.kyc_country || 'US',
          net_profit: parseFloat(rt.net_profit || 0),
          is_custom: false
        });
      }
    });

    // Sort unpinned traders by net_profit DESC
    combinedList.sort((a, b) => b.net_profit - a.net_profit);

    // Assemble final top 20 list with pinned positions honored
    const leaderboard = [];
    let unpinnedIdx = 0;

    for (let pos = 1; pos <= 20; pos++) {
      if (pinnedPositions[pos]) {
        leaderboard.push(pinnedPositions[pos]);
      } else if (unpinnedIdx < combinedList.length) {
        leaderboard.push(combinedList[unpinnedIdx++]);
      }
    }

    // 4. Calculate logged-in user position & net profit
    const userId = Number(req.user.id);
    const currentUser = await db.get('SELECT username, full_name, profile_pic, kyc_country FROM users WHERE id = ?', [userId]);

    const userProfitQuery = `
      SELECT
        COALESCE(SUM(
          CASE
            WHEN t.status = 'win' THEN (
              CASE 
                WHEN t.amount_usd IS NOT NULL AND t.amount_usd > 0 THEN t.amount_usd 
                ELSE t.amount / (CASE WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PKR' THEN 278.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'INR' THEN 84.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BDT' THEN 117.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NPR' THEN 133.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NRP' THEN 133.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EUR' THEN 0.92 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'GBP' THEN 0.78 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'AED' THEN 3.67 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'SAR' THEN 3.75 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'TRY' THEN 32.5 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NGN' THEN 1500.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'IDR' THEN 16000.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BRL' THEN 5.4 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EGP' THEN 48.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MYR' THEN 4.7 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KZT' THEN 475.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'THB' THEN 36.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'UAH' THEN 41.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'VND' THEN 25400.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MXN' THEN 18.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'JPY' THEN 160.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PHP' THEN 58.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KRW' THEN 1380.0 ELSE 1.0 END)
              END
            ) * t.commission_pct / 100.0
            WHEN t.status = 'lose' THEN -(
              CASE 
                WHEN t.amount_usd IS NOT NULL AND t.amount_usd > 0 THEN t.amount_usd 
                ELSE t.amount / (CASE WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PKR' THEN 278.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'INR' THEN 84.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BDT' THEN 117.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NPR' THEN 133.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NRP' THEN 133.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EUR' THEN 0.92 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'GBP' THEN 0.78 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'AED' THEN 3.67 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'SAR' THEN 3.75 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'TRY' THEN 32.5 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NGN' THEN 1500.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'IDR' THEN 16000.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BRL' THEN 5.4 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EGP' THEN 48.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MYR' THEN 4.7 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KZT' THEN 475.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'THB' THEN 36.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'UAH' THEN 41.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'VND' THEN 25400.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MXN' THEN 18.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'JPY' THEN 160.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PHP' THEN 58.0 WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KRW' THEN 1380.0 ELSE 1.0 END)
              END
            )
            ELSE 0
          END
        ), 0) AS user_profit
      FROM users u
      LEFT JOIN trades t ON u.id = t.user_id
        AND (t.is_demo = 0 OR t.is_demo IS NULL)
        AND t.status IN ('win', 'lose')
        AND ${timeFilter}
      WHERE u.id = ?
    `;
    const profitResult = await db.get(userProfitQuery, [userId]);
    const userProfit = profitResult ? Number(profitResult.user_profit || 0) : 0;

    let userRank = leaderboard.findIndex(u => Number(u.id) === userId) + 1;
    if (userRank === 0 && currentUser) {
      const higherCount = leaderboard.filter(u => parseFloat(u.net_profit || 0) > userProfit).length;
      userRank = higherCount + 1;
    }

    const userPosition = currentUser ? {
      rank: userRank > 20 ? '100+' : userRank,
      profit: userProfit,
      username: currentUser.username,
      full_name: currentUser.full_name || currentUser.username,
      profile_pic: currentUser.profile_pic,
      kyc_country: currentUser.kyc_country
    } : null;

    // Step 5: Compute streaks for real traders in leaderboard
    const realUserIds = leaderboard.filter(u => !u.is_custom).map(u => Number(u.id));
    if (realUserIds.length > 0) {
      const idList = realUserIds.join(',');
      const tradeDatesQuery = db.isPg
        ? `SELECT user_id, ((created_at AT TIME ZONE 'UTC')::date)::text AS trade_date
           FROM trades
           WHERE user_id IN (${idList}) AND (is_demo = 0 OR is_demo IS NULL)
           GROUP BY user_id, ((created_at AT TIME ZONE 'UTC')::date)::text
           ORDER BY user_id, trade_date DESC`
        : `SELECT user_id, date(created_at) AS trade_date
           FROM trades
           WHERE user_id IN (${idList}) AND (is_demo = 0 OR is_demo IS NULL)
           GROUP BY user_id, date(created_at)
           ORDER BY user_id, trade_date DESC`;

      const tradeDateRows = await db.all(tradeDatesQuery);
      const datesByUser = {};
      for (const row of tradeDateRows) {
        const uid = Number(row.user_id);
        if (!datesByUser[uid]) datesByUser[uid] = [];
        datesByUser[uid].push(row.trade_date);
      }

      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const todayStr = fmtDate(now);
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const yesterdayStr = fmtDate(yesterday);

      for (const user of leaderboard) {
        if (user.is_custom) continue;
        const uid = Number(user.id);
        const dates = datesByUser[uid] || [];
        if (dates.length === 0) { user.streak = 0; continue; }

        let lastCheckedDate = null;
        let streak = 0;

        if (dates.includes(todayStr)) {
          lastCheckedDate = new Date(now);
          streak = 1;
        } else if (dates.includes(yesterdayStr)) {
          lastCheckedDate = new Date(yesterday);
          streak = 1;
        } else {
          user.streak = 0;
          continue;
        }

        const checkDate = new Date(lastCheckedDate);
        while (true) {
          checkDate.setDate(checkDate.getDate() - 1);
          if (dates.includes(fmtDate(checkDate))) {
            streak++;
          } else {
            break;
          }
        }
        user.streak = streak;
      }
    }

    return res.json({ leaderboard, userPosition });
  } catch (err) {
    console.error('Error fetching leaderboard:', err.message);
    res.status(500).json({ error: 'Failed to fetch leaderboard details.' });
  }
});

// GET: Public profile details of a user for modal popup (avatar click)
router.get('/client/users/:id/public-profile', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const idParam = String(req.params.id);
    let user;
    let isCustom = false;
    let customEntry = null;

    if (idParam.startsWith('custom_') || isNaN(Number(idParam))) {
      isCustom = true;
      const customDbId = idParam.startsWith('custom_') ? Number(idParam.replace('custom_', '')) : Number(idParam);
      customEntry = await db.get('SELECT * FROM custom_leaderboard WHERE id = ?', [customDbId]);
      if (!customEntry) {
        return res.status(404).json({ error: 'User not found.' });
      }
      // Fetch settings for auto-fluctuation to match leaderboard
      const minRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_min_profit'");
      const maxRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_max_profit'");
      const autoRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_auto_fluctuate'");
      const minProfit = minRow ? parseFloat(minRow.value) : 100;
      const maxProfit = maxRow ? parseFloat(maxRow.value) : 50000;
      const autoFluctuate = autoRow ? autoRow.value === 'true' : true;

      // Extract shuffled custom entries to get matched user details
      const shuffledList = await getShuffledCustomEntries(db, autoFluctuate, minProfit, maxProfit);
      const matchedEntry = shuffledList.find(e => e.custom_id === customDbId);

      user = {
        id: `custom_${customEntry.id}`,
        username: matchedEntry ? matchedEntry.username : customEntry.username,
        full_name: matchedEntry ? matchedEntry.full_name : (customEntry.full_name || customEntry.username),
        profile_pic: matchedEntry ? matchedEntry.profile_pic : (customEntry.avatar_url || null),
        kyc_status: 'verified',
        kyc_country: matchedEntry ? matchedEntry.kyc_country : (customEntry.country || 'US'),
        currency: 'USD'
      };
    } else {
      const targetId = Number(idParam);
      user = await db.get(
        'SELECT id, username, full_name, profile_pic, kyc_status, kyc_country, currency FROM users WHERE id = ?',
        [targetId]
      );
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (isCustom && customEntry) {
      // Fetch settings for auto-fluctuation to match leaderboard
      const minRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_min_profit'");
      const maxRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_max_profit'");
      const autoRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_auto_fluctuate'");
      const minProfit = minRow ? parseFloat(minRow.value) : 100;
      const maxProfit = maxRow ? parseFloat(maxRow.value) : 50000;
      const autoFluctuate = autoRow ? autoRow.value === 'true' : true;

      const timeSeed = Math.floor(Date.now() / (10 * 60 * 1000));
      let profit = parseFloat(customEntry.net_profit || 0);
      if (autoFluctuate) {
        const shift = ((customEntry.id * 19 + timeSeed * 37) % 61) - 30;
        profit += shift;
        if (profit < minProfit) profit = minProfit;
        if (profit > maxProfit) profit = maxProfit;
      }

      const wins = parseInt(customEntry.won_trades || 10);
      const losses = parseInt(customEntry.lost_trades || 2);
      const totalTrades = wins + losses;
      const avgProfit = totalTrades > 0 ? (profit / totalTrades) : 0;
      const minTrade = totalTrades > 0 ? Math.max(10, (profit / totalTrades) * 0.5) : 0;
      const maxTrade = totalTrades > 0 ? (profit / totalTrades) * 1.5 : 0;

      user.stats = {
        trades_count: totalTrades,
        profitable_trades: wins,
        trades_profit: parseFloat(profit.toFixed(2)),
        avg_profit: parseFloat(avgProfit.toFixed(2)),
        min_trade_amount: parseFloat(minTrade.toFixed(2)),
        max_trade_amount: parseFloat(maxTrade.toFixed(2))
      };
      user.streak = 3 + ((customEntry.id * 7) % 15);
      user.badge = null;

      return res.json({ user });
    }

    const DEFAULT_CURRENCY_RATES = {
      USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
      EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
      IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
      THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
      PHP: 58.0, KRW: 1380.0
    };

    const userCurrency = (user.currency || 'USD').toUpperCase().trim();
    let userRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
    if (userCurrency !== 'USD') {
      const rateRow = await db.get("SELECT value FROM settings WHERE key = ?", [`currency_rate_${userCurrency}`]);
      if (rateRow && rateRow.value) {
        const parsedRate = parseFloat(rateRow.value);
        if (!isNaN(parsedRate) && parsedRate > 0) userRate = parsedRate;
      }
    }

    // Fetch user's last claimed badge
    const lastBadge = await db.get(
      "SELECT badge_key, badge_name FROM badge_bonus_claims WHERE user_id = ? AND status != 'rejected' ORDER BY id DESC LIMIT 1",
      [targetId]
    );

    if (lastBadge) {
      const badgeConfig = await getBadgeConfig(db);
      const matched = badgeConfig.find(b => b.key === lastBadge.badge_key);
      user.badge = {
        key: lastBadge.badge_key,
        name: lastBadge.badge_name,
        icon: matched ? matched.icon : '💎'
      };
    } else {
      user.badge = null;
    }

    const streak = await calculateStreak(db, targetId);
    user.streak = streak;

    // Fetch user trading statistics for TODAY only (calculated in Pakistan Time UTC+05:00 to match leaderboard)
    const pgOffset = '300 minutes';
    const sqliteOffset = '+300 minutes';
    const sqliteNegOffset = '-300 minutes';

    const todayFilter = db.isPg
      ? `t.created_at AT TIME ZONE 'UTC' >= (NOW() AT TIME ZONE 'UTC' + INTERVAL '${pgOffset}')::date::timestamp - INTERVAL '${pgOffset}'
         AND t.created_at AT TIME ZONE 'UTC' < (NOW() AT TIME ZONE 'UTC' + INTERVAL '${pgOffset}')::date::timestamp + INTERVAL '1 day' - INTERVAL '${pgOffset}'`
      : `t.created_at >= datetime('now', '${sqliteOffset}', 'start of day', '${sqliteNegOffset}')
         AND t.created_at < datetime('now', '${sqliteOffset}', 'start of day', '+1 day', '${sqliteNegOffset}')`;

    const trades = await db.all(`
      SELECT t.amount, t.amount_usd, t.commission_pct, t.status
      FROM trades t
      WHERE t.user_id = ? AND (t.is_demo = 0 OR t.is_demo IS NULL) AND t.status IN ('win', 'lose')
        AND ${todayFilter}
    `, [targetId]);

    let tradesCount = trades.length;
    let profitableTrades = 0;
    let tradesProfit = 0;
    let minTradeAmount = tradesCount > 0 ? Infinity : 0;
    let maxTradeAmount = 0;

    trades.forEach(t => {
      const stakeUsd = (t.amount_usd !== null && t.amount_usd !== undefined && Number(t.amount_usd) > 0)
        ? Number(t.amount_usd)
        : (Number(t.amount) / userRate);

      if (stakeUsd < minTradeAmount) minTradeAmount = stakeUsd;
      if (stakeUsd > maxTradeAmount) maxTradeAmount = stakeUsd;

      if (t.status === 'win') {
        profitableTrades++;
        const profitUsd = stakeUsd * (Number(t.commission_pct) / 100.0);
        tradesProfit += profitUsd;
      } else if (t.status === 'lose') {
        tradesProfit -= stakeUsd;
      }
    });

    if (minTradeAmount === Infinity) minTradeAmount = 0;
    const avgProfit = tradesCount > 0 ? (tradesProfit / tradesCount) : 0;

    user.stats = {
      trades_count: tradesCount,
      profitable_trades: profitableTrades,
      trades_profit: parseFloat(tradesProfit.toFixed(2)),
      avg_profit: parseFloat(avgProfit.toFixed(2)),
      min_trade_amount: parseFloat(minTradeAmount.toFixed(2)),
      max_trade_amount: parseFloat(maxTradeAmount.toFixed(2))
    };

    res.json({ user });
  } catch (err) {
    console.error('Error fetching public user profile:', err.message);
    res.status(500).json({ error: 'Failed to fetch user details.' });
  }
});

router.post('/client/convert', authenticateToken, async (req, res) => {
  const { targetCurrency } = req.body;
  if (!targetCurrency || typeof targetCurrency !== 'string') {
    return res.status(400).json({ error: 'Target currency is required.' });
  }
  const cleanTarget = targetCurrency.trim().toUpperCase();
  const db = await getDB();
  try {
    const user = await db.get('SELECT balance, demo_balance, currency FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const currentCurrency = (user.currency || 'USD').toUpperCase();
    if (currentCurrency === cleanTarget) {
      return res.status(400).json({ error: 'Already in the target currency.' });
    }

    const isCrypto = (code) => ['BTC', 'ETH', 'BNB', 'SOL', 'USDT', 'USDC'].includes(code.toUpperCase());
    if (isCrypto(currentCurrency) || isCrypto(cleanTarget)) {
      return res.status(400).json({ error: 'Cryptocurrency conversions are not supported.' });
    }

    const targetRateRow = await db.get('SELECT value FROM settings WHERE key = ?', [`currency_rate_${cleanTarget}`]);
    const currentRateRow = await db.get('SELECT value FROM settings WHERE key = ?', [`currency_rate_${currentCurrency}`]);

    if (!targetRateRow) {
      return res.status(400).json({ error: `Currency ${cleanTarget} is not supported.` });
    }
    if (!currentRateRow) {
      return res.status(400).json({ error: `Current currency ${currentCurrency} is missing rate setting.` });
    }

    const targetRate = parseFloat(targetRateRow.value);
    const currentRate = parseFloat(currentRateRow.value);

    if (isNaN(targetRate) || targetRate <= 0 || isNaN(currentRate) || currentRate <= 0) {
      return res.status(400).json({ error: 'Invalid conversion rates configured.' });
    }

    const getRateInUnitsPerUsd = (code, rawRate) => {
      const codeUpper = code.toUpperCase();
      if (codeUpper === 'USD') return 1.0;
      if (['BTC', 'ETH', 'BNB', 'SOL'].includes(codeUpper)) {
        return 1.0 / (rawRate || 1.0);
      }
      return rawRate || 1.0;
    };

    const targetRateInUnits = getRateInUnitsPerUsd(cleanTarget, targetRate);
    const currentRateInUnits = getRateInUnitsPerUsd(currentCurrency, currentRate);

    const multiplier = targetRateInUnits / currentRateInUnits;
    const oldBalance = user.balance || 0;
    const oldDemoBalance = user.demo_balance || 0;

    const newBalance = oldBalance * multiplier;

    await db.run('BEGIN TRANSACTION');
    try {
      await db.run(
        'UPDATE users SET balance = ?, currency = ? WHERE id = ?',
        [newBalance, cleanTarget, req.user.id]
      );

      const desc = `Converted ${oldBalance.toFixed(2)} ${currentCurrency} to ${newBalance.toFixed(2)} ${cleanTarget}`;
      await db.run(
        `INSERT INTO ledger (user_id, type, amount, description, balance_after)
         VALUES (?, 'admin_add', 0, ?, ?)`,
        [req.user.id, desc, newBalance]
      );

      await db.run('COMMIT');

      const updatedUser = await db.get(
        'SELECT id, username, email, phone_number, full_name, profile_pic, role, balance, demo_balance, real_account_active, status, credit_score, withdraw_enabled, withdraw_limit, kyc_status, kyc_rejected_reason, created_at, username_last_changed, currency FROM users WHERE id = ?',
        [req.user.id]
      );

      res.json({ success: true, message: 'Balance converted successfully.', user: updatedUser });
    } catch (txErr) {
      await db.run('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('Error during currency conversion:', err.message);
    res.status(500).json({ error: 'Failed to convert currency: ' + err.message });
  }
});

router.post('/client/activity/log', authenticateToken, async (req, res) => {
  const { action, type } = req.body;
  if (!action || !type) return res.status(400).json({ error: 'Action and type are required.' });

  if (req.user.role === 'user') {
    global.liveUserActivities = global.liveUserActivities || [];
    global.lastUserAction = global.lastUserAction || {};

    const now = Date.now();
    const last = global.lastUserAction[req.user.username];
    // Deduplicate identical navigation logs within 10 seconds to avoid spam
    const isDuplicate = type === 'navigation' && last && last.action === action && (now - last.time) < 10000;

    if (!isDuplicate) {
      global.lastUserAction[req.user.username] = { action, time: now };
      global.liveUserActivities.unshift({
        id: now + '-' + Math.random().toString(36).substr(2, 4),
        username: req.user.username,
        action,
        type,
        time: new Date().toISOString()
      });
      if (global.liveUserActivities.length > 1000) {
        global.liveUserActivities.pop();
      }
    }
  }
  res.json({ success: true });
});

router.get('/client/wallet', authenticateToken, async (req, res) => {
  const db = await getDB();
  const user = await db.get('SELECT balance, demo_balance, status, currency, real_account_active, kyc_country FROM users WHERE id = ?', [req.user.id]);
  
  const userCurrency = (user.currency || 'USD').toUpperCase();
  let rate = 1.0;
  if (userCurrency !== 'USD') {
    const rateRow = await db.get("SELECT value FROM settings WHERE key = ?", [`currency_rate_${userCurrency}`]);
    if (rateRow) {
      const parsedRate = parseFloat(rateRow.value);
      if (!isNaN(parsedRate) && parsedRate > 0) {
        rate = parsedRate;
      }
    }
  }

  // Get wallet details from settings
  const usdt_address = await db.get("SELECT value FROM settings WHERE key = 'usdt_deposit_address'");
  const usdc_address = await db.get("SELECT value FROM settings WHERE key = 'usdc_deposit_address'");
  const bank_details = await db.get("SELECT value FROM settings WHERE key = 'bank_deposit_details'");

  const usdt_trc20 = await db.get("SELECT value FROM settings WHERE key = 'usdt_trc20_deposit_address'");
  const usdt_erc20 = await db.get("SELECT value FROM settings WHERE key = 'usdt_erc20_deposit_address'");
  const usdt_bep20 = await db.get("SELECT value FROM settings WHERE key = 'usdt_bep20_deposit_address'");
  const usdt_ltc = await db.get("SELECT value FROM settings WHERE key = 'usdt_ltc_deposit_address'");
  const usdt_aptos = await db.get("SELECT value FROM settings WHERE key = 'usdt_aptos_deposit_address'");

  const usdt_enabled = await db.get("SELECT value FROM settings WHERE key = 'deposit_usdt_enabled'");
  const usdc_enabled = await db.get("SELECT value FROM settings WHERE key = 'deposit_usdc_enabled'");
  const bank_enabled = await db.get("SELECT value FROM settings WHERE key = 'deposit_bank_enabled'");

  const w_usdt_enabled = await db.get("SELECT value FROM settings WHERE key = 'withdrawal_usdt_enabled'");
  const w_usdc_enabled = await db.get("SELECT value FROM settings WHERE key = 'withdrawal_usdc_enabled'");
  const w_bank_enabled = await db.get("SELECT value FROM settings WHERE key = 'withdrawal_bank_enabled'");

  const balance_card_bg_mobile = await db.get("SELECT value FROM settings WHERE key = 'balance_card_bg_mobile'");
  const balance_card_bg_desktop = await db.get("SELECT value FROM settings WHERE key = 'balance_card_bg_desktop'");
  const binance_auto_enabled = await db.get("SELECT value FROM settings WHERE key = 'binance_auto_enabled'");
  const binance_manual_enabled = await db.get("SELECT value FROM settings WHERE key = 'binance_manual_enabled'");
  const binance_deposit_address = await db.get("SELECT value FROM settings WHERE key = 'binance_deposit_address'");
  const binance_qr_url = await db.get("SELECT value FROM settings WHERE key = 'binance_qr_url'");
  const custom_deposit_methods = await db.get("SELECT value FROM settings WHERE key = 'custom_deposit_methods'");
  const custom_withdrawal_methods = await db.get("SELECT value FROM settings WHERE key = 'custom_withdrawal_methods'");

  res.json({
    balance: user.balance,
    demo_balance: user.demo_balance ?? 10000,
    real_account_active: user.real_account_active,
    status: user.status,
    currency: user.currency || 'USD',
    is_pakistan: (user.currency && user.currency.toUpperCase() === 'PKR') || (user.kyc_country && user.kyc_country.toLowerCase().includes('pakistan')),
    rate: rate,
    deposit: {
      usdt: { address: usdt_address?.value || '', enabled: usdt_enabled?.value === 'true' },
      usdc: { address: usdc_address?.value || '', enabled: usdc_enabled?.value === 'true' },
      bank: { details: bank_details?.value || '', enabled: bank_enabled?.value === 'true' },
      usdt_trc20: { address: usdt_trc20?.value || usdt_address?.value || '' },
      usdt_erc20: { address: usdt_erc20?.value || usdt_address?.value || '' },
      usdt_bep20: { address: usdt_bep20?.value || usdt_address?.value || '' },
      usdt_ltc: { address: usdt_ltc?.value || usdt_address?.value || '' },
      usdt_aptos: { address: usdt_aptos?.value || usdt_address?.value || '' },
      binance_auto: { enabled: binance_auto_enabled?.value === 'true', address: binance_deposit_address?.value || '', qr_url: binance_qr_url?.value || '' },
      binance_manual: { enabled: binance_manual_enabled?.value === 'true', address: binance_deposit_address?.value || '', qr_url: binance_qr_url?.value || '' }
    },
    withdrawal: {
      usdt: { enabled: w_usdt_enabled?.value === 'true' },
      usdc: { enabled: w_usdc_enabled?.value === 'true' },
      bank: { enabled: w_bank_enabled?.value === 'true' }
    },
    balance_card_bg_mobile: balance_card_bg_mobile?.value || '',
    balance_card_bg_desktop: balance_card_bg_desktop?.value || '',
    custom_deposit_methods: custom_deposit_methods?.value || '[]',
    custom_withdrawal_methods: custom_withdrawal_methods?.value || '[]'
  });
});

function verifyBinanceDeposit(apiKey, secretKey, txId, targetAmount) {
  return new Promise((resolve) => {
    if (!apiKey || !secretKey || !txId) {
      return resolve(false);
    }
    try {
      const crypto = require('crypto');
      const https = require('https');

      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = crypto
        .createHmac('sha256', secretKey.trim())
        .update(queryString)
        .digest('hex');

      const path = `/sapi/v1/capital/deposit/hisrec?${queryString}&signature=${signature}`;

      const options = {
        hostname: 'api.binance.com',
        port: 443,
        path: path,
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': apiKey.trim()
        }
      };

      const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          if (response.statusCode === 200) {
            try {
              const list = JSON.parse(data);
              if (Array.isArray(list)) {
                // Find matching record with status = 1 (Success)
                const match = list.find(d => 
                  String(d.txId).toLowerCase().trim() === String(txId).toLowerCase().trim() &&
                  Math.abs(Number(d.amount) - Number(targetAmount)) < 0.01 &&
                  Number(d.status) === 1
                );
                if (match) {
                  return resolve(true);
                }
              }
              resolve(false);
            } catch (e) {
              console.error('[BINANCE AUTO VERIFY ERROR] Parse error:', e.message);
              resolve(false);
            }
          } else {
            console.error('[BINANCE AUTO VERIFY ERROR] HTTP Status:', response.statusCode, data);
            resolve(false);
          }
        });
      });

      request.on('error', (err) => {
        console.error('[BINANCE AUTO VERIFY ERROR] Request failed:', err.message);
        resolve(false);
      });

      request.end();
    } catch (err) {
      console.error('[BINANCE AUTO VERIFY ERROR] Setup error:', err.message);
      resolve(false);
    }
  });
}

router.post('/client/deposit', authenticateToken, upload.single('slip'), async (req, res) => {
  try {
    const db = await getDB();
    const user = await db.get('SELECT status FROM users WHERE id = ?', [req.user.id]);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.status === 'frozen') {
      return res.status(403).json({ error: 'Your account is frozen. Deposits are disabled.' });
    }

    const { method, amount, proof_text } = req.body;
    if (!method || !amount) {
      return res.status(400).json({ error: 'Method and Amount are required.' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid deposit amount.' });
    }

    // Determine base method and get enablement setting
    let checkMethod = String(method || '').toUpperCase();
    let baseMethod = checkMethod;
    if (checkMethod.startsWith('USDT_')) {
      baseMethod = 'USDT';
    } else if (checkMethod.startsWith('USDC_')) {
      baseMethod = 'USDC';
    }

    let details = '';
    const isBinance = (checkMethod === 'BINANCE_AUTO' || checkMethod === 'BINANCE_MANUAL');

    if (isBinance) {
      const enabledKey = checkMethod === 'BINANCE_AUTO' ? 'binance_auto_enabled' : 'binance_manual_enabled';
      const enabledSetting = await db.get("SELECT value FROM settings WHERE key = ?", [enabledKey]);
      if (!enabledSetting || enabledSetting.value !== 'true') {
        return res.status(400).json({ error: 'Selected Binance deposit option is currently disabled.' });
      }
      const addressRow = await db.get("SELECT value FROM settings WHERE key = 'binance_deposit_address'");
      details = `Binance Address/Pay ID: ${addressRow ? addressRow.value : ''}`;
    } else {
      // Check if this is a dynamic e-wallet method
      const eWallet = await db.get('SELECT * FROM e_wallet_methods WHERE UPPER(name) = ?', [checkMethod]);
      if (eWallet) {
        if (Number(eWallet.enabled) !== 1) {
          return res.status(400).json({ error: 'Selected deposit method is currently disabled.' });
        }
        
        const minDep = eWallet.min_deposit !== null && eWallet.min_deposit !== undefined ? parseFloat(eWallet.min_deposit) : 0;
        const maxDep = eWallet.max_deposit !== null && eWallet.max_deposit !== undefined ? parseFloat(eWallet.max_deposit) : 0;

        if (minDep > 0 && parsedAmount < minDep) {
          return res.status(400).json({ error: `Minimum deposit amount for ${eWallet.name} is $${minDep.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.` });
        }
        if (maxDep > 0 && parsedAmount > maxDep) {
          return res.status(400).json({ error: `Maximum deposit amount for ${eWallet.name} is $${maxDep.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.` });
        }
        details = `Wallet: ${eWallet.name}\nHolder: ${eWallet.account_name || ''}\nAccount: ${eWallet.account_number || ''}\nIBAN: ${eWallet.iban || 'N/A'}`;
      } else {
        // Legacy settings check
        const enabledSetting = await db.get(`SELECT value FROM settings WHERE key = ?`, [`deposit_${baseMethod.toLowerCase()}_enabled`]);
        if (!enabledSetting || enabledSetting.value !== 'true') {
          return res.status(400).json({ error: 'Selected deposit method is currently disabled.' });
        }

        const detailsRow = await db.get(`SELECT value FROM settings WHERE key = ?`, [`${checkMethod.toLowerCase()}_deposit_address`]) 
          || await db.get(`SELECT value FROM settings WHERE key = ?`, [`${baseMethod.toLowerCase()}_deposit_address`])
          || await db.get(`SELECT value FROM settings WHERE key = ?`, [`bank_deposit_details`]);
        details = detailsRow ? detailsRow.value : '';
      }
    }

    // Auto-verify Binance deposits if API keys are set and TxID is provided
    let isAutoApproved = false;
    if (checkMethod === 'BINANCE_AUTO' && proof_text) {
      const apiKeyRow = await db.get("SELECT value FROM settings WHERE key = 'binance_api_key'");
      const secretKeyRow = await db.get("SELECT value FROM settings WHERE key = 'binance_secret_key'");
      const apiKey = apiKeyRow ? apiKeyRow.value : '';
      const secretKey = secretKeyRow ? secretKeyRow.value : '';

      if (apiKey && secretKey) {
        const verified = await verifyBinanceDeposit(apiKey, secretKey, proof_text, parsedAmount);
        if (verified) {
          isAutoApproved = true;
        }
      }
    }

    const proof_file = req.file ? await uploadToSupabase(req.file) : null;
    let result;

    if (isAutoApproved) {
      await db.run('BEGIN TRANSACTION');
      result = await db.run(
        `INSERT INTO deposits (user_id, method, amount, details, proof_text, proof_file, status, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)`,
        [req.user.id, checkMethod, parsedAmount, details, proof_text || null, proof_file, new Date().toISOString()]
      );

      const currentUser = await db.get('SELECT balance FROM users WHERE id = ?', [req.user.id]);
      const newBalance = currentUser.balance + parsedAmount;
      await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, req.user.id]);
      await db.run(
        `INSERT INTO ledger (user_id, type, amount, description, balance_after) VALUES (?, 'deposit', ?, ?, ?)`,
        [req.user.id, parsedAmount, `Deposit Approved (${checkMethod})`, newBalance]
      );
      
      await applyReferralCommission(db, req.user.id, parsedAmount);
      await db.run('COMMIT');

      sendPushNotification(req.user.id, 'Deposit Approved', `Your Binance deposit of $${parsedAmount.toFixed(2)} has been automatically credited.`);
    } else {
      result = await db.run(
        `INSERT INTO deposits (user_id, method, amount, details, proof_text, proof_file, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [req.user.id, checkMethod, parsedAmount, details, proof_text || null, proof_file]
      );
    }

    const userDetail = await db.get('SELECT email, username, full_name, balance FROM users WHERE id = ?', [req.user.id]);
    if (userDetail && userDetail.email) {
      if (isAutoApproved) {
        sendSystemEmail(userDetail.email, 'deposit_approved', {
          username: userDetail.username,
          full_name: userDetail.full_name || userDetail.username,
          amount: parsedAmount,
          currency: 'USD',
          transaction_id: result.lastID,
          new_balance: userDetail.balance
        }).catch(err => console.error('[EMAIL ERROR] Binance deposit approved email:', err.message));
      } else {
        sendSystemEmail(userDetail.email, 'deposit_created', {
          username: userDetail.username,
          full_name: userDetail.full_name || userDetail.username,
          amount: parsedAmount,
          currency: 'USD',
          method: checkMethod,
          transaction_id: result.lastID
        }).catch(err => console.error('[EMAIL ERROR] Deposit created email:', err.message));
      }
    }

    if (userDetail) {
      const escUsername = telegramService.escapeMarkdown(userDetail.username);
      const escProofText = telegramService.escapeMarkdown(proof_text);
      const escMethod = telegramService.escapeMarkdown(checkMethod);

      let telegramMsg = `💵 *${isAutoApproved ? 'Binance Auto-Approved Deposit' : 'New Deposit Request'}*\n` +
        `User: ${escUsername} (ID: ${req.user.id})\n` +
        `Amount: $${parsedAmount.toFixed(2)}\n` +
        `Method: ${escMethod}\n` +
        `Status: ${isAutoApproved ? 'Approved (Auto)' : 'Pending'}\n`;
      if (proof_text) {
        telegramMsg += `Details/TxID: ${escProofText}\n`;
      }
      telegramMsg += `Tx ID: ${result.lastID}`;

      if (proof_file) {
        telegramService.sendPhoto(proof_file, telegramMsg).catch(err => {
          console.error('[TELEGRAM ERROR] Photo notification failed, falling back to text:', err.message);
          telegramService.sendNotification(telegramMsg).catch(err2 => console.error('[TELEGRAM ERROR] Text fallback failed:', err2.message));
        });
        whatsappService.sendPhoto(proof_file, telegramMsg).catch(err => {
          console.error('[WHATSAPP ERROR] Photo notification failed, falling back to text:', err.message);
          whatsappService.sendNotification(telegramMsg).catch(err2 => console.error('[WHATSAPP ERROR] Text fallback failed:', err2.message));
        });
      } else {
        telegramService.sendNotification(telegramMsg).catch(err => console.error('[TELEGRAM ERROR] Deposit notification:', err.message));
        whatsappService.sendNotification(telegramMsg).catch(err => console.error('[WHATSAPP ERROR] Deposit notification:', err.message));
      }
    }

    if (isAutoApproved) {
      res.json({ success: true, message: 'Binance payment verified automatically! Your balance has been credited.' });
    } else {
      res.json({ success: true, message: 'Deposit request submitted successfully. Awaiting administration approval.' });
    }
  } catch (err) {
    console.error('[DEPOSIT ERROR]:', err);
    res.status(500).json({ error: 'Failed to record deposit: ' + err.message });
  }
});

// Helper function to recursively sort object keys alphabetically
function sortObject(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObject);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = sortObject(obj[key]);
  }
  return result;
}

// NOWPayments IPN Signature Verification Helper
function verifyNowPaymentsSignature(req, secret) {
  const crypto = require('crypto');
  const signature = req.headers['x-nowpayments-sig'];
  if (!signature) {
    console.error('Signature missing in request headers');
    return false;
  }

  const sortedString = JSON.stringify(sortObject(req.body));
  const hmac = crypto.createHmac('sha512', secret);
  hmac.update(sortedString);
  const calculatedSig = hmac.digest('hex');

  const match = calculatedSig === signature;
  if (!match) {
    console.error('Signature mismatch! Calculated:', calculatedSig, 'Received:', signature);
  }
  return match;
}

// NOWPayments: Create invoice payment
router.post('/client/nowpayments/create', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const user = await db.get('SELECT username, status, currency FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (user.status === 'frozen') {
      return res.status(403).json({ error: 'Your account is frozen. Deposits are disabled.' });
    }

    if (user.currency && user.currency !== 'USD') {
      return res.status(400).json({ error: 'Please change your currency to USD for Deposit and Withdrawal.' });
    }

    const { amount, coin } = req.body;
    if (!amount || !coin) {
      return res.status(400).json({ error: 'Amount and Coin are required.' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 10) {
      return res.status(400).json({ error: 'Minimum deposit amount for Auto Instant is $10.' });
    }

    const apiKey = process.env.NOWPAYMENTS_API_KEY || 'X27F8VT-Q9547FA-P58H7F4-WFVQ84W';

    // Fetch dynamic minimum from NOWPayments
    try {
      const coinLower = coin.toLowerCase();
      const minRes = await fetch(`https://api.nowpayments.io/v1/min-amount?currency_from=usd&currency_to=${coinLower}`, {
        headers: { 'x-api-key': apiKey }
      });
      if (minRes.ok) {
        const minData = await minRes.json();
        const minUsd = parseFloat(minData.min_amount);
        if (!isNaN(minUsd) && parsedAmount < minUsd) {
          const coinNames = {
            btc: 'Bitcoin (BTC)',
            trx: 'Tron (TRX)',
            usdttrc20: 'USDT (TRC20)',
            usdc: 'USDC',
            eth: 'Ethereum (ETH)',
            usdt: 'USDT'
          };
          const displayCoin = coinNames[coinLower] || coin.toUpperCase();
          return res.status(400).json({
            error: `The minimum deposit amount for ${displayCoin} is $${minUsd.toFixed(2)}. Please enter a higher amount.`
          });
        }
      }
    } catch (minErr) {
      console.warn('[NOWPAYMENTS MIN CHECK ERROR] Failed to fetch dynamic limit:', minErr.message);
    }

    const ipnUrl = process.env.NOWPAYMENTS_IPN_URL || `${req.protocol}://${req.get('host')}/api/nowpayments/webhook`;

    const orderId = `NP_${req.user.id}_${Date.now()}`;
    const payload = {
      price_amount: parsedAmount,
      price_currency: 'usd',
      pay_currency: coin.toLowerCase(),
      ipn_callback_url: ipnUrl,
      order_id: orderId,
      order_description: `Gain EX Auto Deposit for ${user.username}`
    };

    console.log('Sending request to NOWPayments:', payload);

    const response = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log('NOWPayments response status:', response.status, 'data:', data);

    if (!response.ok || !data.payment_id) {
      return res.status(response.status || 400).json({
        error: data.message || 'Failed to create payment with NOWPayments.'
      });
    }

    // Insert pending deposit record into DB
    const dbResult = await db.run(
      `INSERT INTO deposits (user_id, method, amount, details, proof_text, proof_file, status)
       VALUES (?, ?, ?, ?, ?, NULL, 'pending')`,
      [
        req.user.id,
        coin.toUpperCase(),
        parsedAmount,
        JSON.stringify({
          payment_id: data.payment_id,
          pay_address: data.pay_address,
          pay_amount: data.pay_amount,
          pay_currency: data.pay_currency,
          order_id: orderId
        }),
        String(data.payment_id)
      ]
    );

    const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [req.user.id]);
    if (userDetail && userDetail.email) {
      sendSystemEmail(userDetail.email, 'deposit_created', {
        username: userDetail.username,
        full_name: userDetail.full_name || userDetail.username,
        amount: parsedAmount,
        currency: 'USD',
        method: coin.toUpperCase(),
        transaction_id: dbResult.lastID
      }).catch(err => console.error('[EMAIL ERROR] NOWPayments deposit created email:', err.message));
    }

    if (userDetail) {
      const nowpMsg = 
        `💵 *New Crypto Deposit Initiated (NOWPayments)*\n` +
        `👤 *Username*: ${telegramService.escapeMarkdown(userDetail.username)}\n` +
        `🆔 *User ID*: ${req.user.id}\n` +
        `💰 *Amount*: $${parsedAmount.toFixed(2)} USD\n` +
        `💳 *Coin*: ${coin.toUpperCase()}\n` +
        `📥 *Pay Address*: \`${data.pay_address}\`\n` +
        `📋 *Transaction ID*: ${dbResult.lastID}`;
      telegramService.sendNotification(nowpMsg);
      whatsappService.sendNotification(nowpMsg);
    }

    res.json({
      success: true,
      payment_id: data.payment_id,
      pay_address: data.pay_address,
      pay_amount: data.pay_amount,
      pay_currency: data.pay_currency
    });
  } catch (err) {
    console.error('NOWPayments create payment error:', err);
    res.status(500).json({ error: 'Failed to initiate auto-deposit: ' + err.message });
  }
});

// NOWPayments: Check deposit payment status from DB
router.get('/client/nowpayments/status/:payment_id', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const paymentId = req.params.payment_id;
    const deposit = await db.get(
      'SELECT status FROM deposits WHERE user_id = ? AND proof_text = ? LIMIT 1',
      [req.user.id, String(paymentId)]
    );

    if (!deposit) {
      return res.status(404).json({ error: 'Deposit record not found.' });
    }

    res.json({ status: deposit.status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve deposit status: ' + err.message });
  }
});

// NOWPayments IPN Webhook (Public)
router.post('/nowpayments/webhook', async (req, res) => {
  const db = await getDB();
  const secret = process.env.NOWPAYMENTS_IPN_SECRET || 'uOtl5EbHHbQL5KZXeAMA0pEcpeUUJmbn';

  console.log('Received NOWPayments IPN Webhook:', JSON.stringify(req.body));

  // Verify signature
  if (!verifyNowPaymentsSignature(req, secret)) {
    return res.status(400).send('Invalid signature');
  }

  const { payment_id, payment_status } = req.body;
  if (!payment_id) {
    return res.status(400).send('Missing payment_id');
  }

  try {
    const deposit = await db.get(
      'SELECT * FROM deposits WHERE proof_text = ? LIMIT 1',
      [String(payment_id)]
    );

    if (!deposit) {
      console.warn(`No deposit found for payment ID: ${payment_id}`);
      return res.status(200).send('Payment ID not tracked');
    }

    if (deposit.status !== 'pending') {
      console.log(`Deposit for payment ID: ${payment_id} is already in status: ${deposit.status}`);
      return res.status(200).send('Already processed');
    }

    if (payment_status === 'finished') {
      console.log(`Approving deposit for payment ID: ${payment_id}`);
      
      await db.run('BEGIN TRANSACTION');
      try {
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [deposit.user_id]);
        if (!user) {
          throw new Error(`User with ID ${deposit.user_id} not found`);
        }

        const newBalance = (user.balance || 0) + deposit.amount;

        await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, deposit.user_id]);

        const resolvedAt = new Date().toISOString();
        await db.run(
          `UPDATE deposits 
           SET status = 'approved', resolved_at = ? 
           WHERE id = ?`,
          [resolvedAt, deposit.id]
        );

        await db.run(
          `INSERT INTO ledger (user_id, type, amount, description, balance_after)
           VALUES (?, 'deposit', ?, ?, ?)`,
          [
            deposit.user_id,
            deposit.amount,
            `Instant Crypto Deposit via NOWPayments (ID: ${payment_id})`,
            newBalance
          ]
        );

        // Apply referral commission for the first 5 deposits
        await applyReferralCommission(db, deposit.user_id, deposit.amount);

        await db.run('COMMIT');
        console.log(`Successfully approved deposit #${deposit.id} and credited user #${deposit.user_id}`);

        const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [deposit.user_id]);
        if (userDetail && userDetail.email) {
          sendSystemEmail(userDetail.email, 'deposit_approved', {
            username: userDetail.username,
            full_name: userDetail.full_name || userDetail.username,
            amount: deposit.amount,
            currency: 'USD',
            transaction_id: deposit.id,
            new_balance: newBalance
          }).catch(err => console.error('[EMAIL ERROR] NOWPayments approved email:', err.message));
        }
      } catch (transErr) {
        await db.run('ROLLBACK');
        console.error('Transaction failed during webhook processing, rolled back:', transErr);
        return res.status(500).send('Internal transaction failure');
      }
    } else if (payment_status === 'failed' || payment_status === 'expired') {
      console.log(`Rejecting deposit for payment ID: ${payment_id} because status is ${payment_status}`);
      const resolvedAt = new Date().toISOString();
      await db.run(
        `UPDATE deposits 
         SET status = 'rejected', resolved_at = ? 
         WHERE id = ?`,
        [resolvedAt, deposit.id]
      );

      const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [deposit.user_id]);
      if (userDetail && userDetail.email) {
        sendSystemEmail(userDetail.email, 'deposit_rejected', {
          username: userDetail.username,
          full_name: userDetail.full_name || userDetail.username,
          amount: deposit.amount,
          currency: 'USD',
          transaction_id: deposit.id,
          reason: `NOWPayments status: ${payment_status}`
        }).catch(err => console.error('[EMAIL ERROR] NOWPayments rejected email:', err.message));
      }
    } else {
      console.log(`Payment ID: ${payment_id} status updated to: ${payment_status} (no action taken yet)`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('NOWPayments webhook error:', err);
    res.status(500).send('Internal Server Error: ' + err.message);
  }
});

const restoreWithdrawalMethod = (w) => {
  if (!w) return w;
  if (w.method === 'BANK' && w.payout_details && w.payout_details.startsWith('[')) {
    const match = w.payout_details.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      w.method = match[1];
      w.payout_details = match[2];
    }
  }
  return w;
};

// --- CLIENT: REQUEST WITHDRAWAL CODE ---
router.post('/client/withdraw/request-code', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const user = await db.get('SELECT email, username, full_name, status, withdraw_enabled, currency FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.status === 'frozen') return res.status(403).json({ error: 'Your account is frozen. Withdrawals are disabled.' });
    if (user.withdraw_enabled === 0) return res.status(403).json({ error: 'Withdrawals are disabled for your account. Please contact support.' });
    if (user.currency && user.currency !== 'USD' && user.currency !== 'PKR') {
      return res.status(400).json({ error: 'Please change your currency to USD or PKR for Deposit and Withdrawal.' });
    }
    if (!user.email) return res.status(400).json({ error: 'Your account does not have an email configured.' });

    // Generate 6 digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes expiration

    await db.run('UPDATE users SET withdrawal_otp = ?, withdrawal_otp_expires_at = ? WHERE id = ?', [code, expiresAt, req.user.id]);

    const sent = await sendSystemEmail(user.email, 'withdrawal_code', {
      username: user.username,
      full_name: user.full_name || user.username,
      code: code
    });

    if (sent) {
      res.json({ success: true, message: 'Verification code sent to your email.' });
    } else {
      res.status(500).json({ error: 'Failed to send verification code email.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/withdraw', authenticateToken, async (req, res) => {
  const db = await getDB();
  const user = await db.get('SELECT status, balance, withdraw_enabled, withdraw_limit, withdrawal_otp, withdrawal_otp_expires_at, email, username, full_name, currency FROM users WHERE id = ?', [req.user.id]);

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (user.status === 'frozen') {
    return res.status(403).json({ error: 'Your account is frozen. Withdrawals are disabled.' });
  }

  if (user.withdraw_enabled === 0) {
    return res.status(403).json({ error: 'Withdrawals are disabled for your account. Please contact support.' });
  }

  if (user.currency && user.currency !== 'USD' && user.currency !== 'PKR') {
    return res.status(400).json({ error: 'Please change your currency to USD or PKR for Deposit and Withdrawal.' });
  }

  const { method, amount, payout_details, code } = req.body;
  if (!method || !amount || !payout_details) {
    return res.status(400).json({ error: 'Method, amount, and withdrawal details are required.' });
  }
  if (!code) {
    return res.status(400).json({ error: 'Verification code is required.' });
  }

  // Check OTP
  if (!user.withdrawal_otp || user.withdrawal_otp !== code.trim()) {
    return res.status(400).json({ error: 'Invalid verification code.' });
  }

  const now = new Date().toISOString();
  if (user.withdrawal_otp_expires_at < now) {
    return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid withdrawal amount.' });
  }

  if (user.withdraw_limit !== null && user.withdraw_limit !== undefined && user.withdraw_limit > 0 && parsedAmount > user.withdraw_limit) {
    return res.status(400).json({ error: `Withdrawal limit exceeded. Your maximum withdraw limit is $${user.withdraw_limit.toFixed(2)}.` });
  }

  // Check if withdrawal method is enabled or has E-Wallet limits
  let isEnabled = true;
  const cleanMethodName = String(method).trim().toLowerCase();

  // Check if this is a dynamic e-wallet method
  const eWallet = await db.get('SELECT * FROM e_wallet_methods WHERE UPPER(name) = ?', [cleanMethodName.toUpperCase()]);
  if (eWallet) {
    if (Number(eWallet.enabled) !== 1) {
      return res.status(400).json({ error: 'Selected withdrawal method is currently disabled.' });
    }
    if (eWallet.min_withdrawal !== null && eWallet.min_withdrawal !== undefined && parsedAmount < eWallet.min_withdrawal) {
      return res.status(400).json({ error: `Minimum withdrawal amount for ${eWallet.name} is $${eWallet.min_withdrawal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.` });
    }
    if (eWallet.max_withdrawal !== null && eWallet.max_withdrawal !== undefined && eWallet.max_withdrawal > 0 && parsedAmount > eWallet.max_withdrawal) {
      return res.status(400).json({ error: `Maximum withdrawal amount for ${eWallet.name} is $${eWallet.max_withdrawal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.` });
    }
  } else {
    const enabledSetting = await db.get(`SELECT value FROM settings WHERE key = ?`, [`withdrawal_${cleanMethodName}_enabled`]);
    if (enabledSetting) {
      isEnabled = enabledSetting.value === 'true';
    } else {
      // Default to enabled for all e-wallets, custom methods, and local payment methods
      isEnabled = true;
    }
    if (!isEnabled) {
      return res.status(400).json({ error: 'Selected withdrawal method is currently disabled.' });
    }
  }

  if (user.balance < parsedAmount) {
    return res.status(400).json({ error: 'Insufficient funds in wallet.' });
  }

  const upperMethod = method.toUpperCase();
  const isDefaultMethod = ['USDT', 'USDC', 'BANK'].includes(upperMethod);
  const mappedMethod = isDefaultMethod ? upperMethod : 'BANK';
  const finalPayoutDetails = isDefaultMethod ? payout_details : `[${upperMethod}] ${payout_details}`;

  let wResult;
  try {
    // 1. Insert withdrawal record first (this is fail-safe; if it fails due to DB validation/constraint, we haven't touched user balance yet)
    wResult = await db.run(
      `INSERT INTO withdrawals (user_id, method, amount, payout_details, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [req.user.id, mappedMethod, parsedAmount, finalPayoutDetails]
    );
  } catch (insertErr) {
    console.error('[WITHDRAW INSERT ERROR]:', insertErr.message);
    return res.status(400).json({ error: 'Failed to create withdrawal request. Please check method and try again.' });
  }

  try {
    // 2. Escrow funds and clear OTP
    await db.run('UPDATE users SET balance = balance - ?, withdrawal_otp = NULL, withdrawal_otp_expires_at = NULL WHERE id = ?', [parsedAmount, req.user.id]);

    // 3. Log to ledger
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after)
       VALUES (?, 'withdrawal', ?, ?, ?)`,
      [req.user.id, -parsedAmount, `Pending withdrawal request #${wResult.lastID} (${upperMethod})`, user.balance - parsedAmount]
    );

    // Trigger withdrawal_submitted email
    if (user.email) {
      sendSystemEmail(user.email, 'withdrawal_submitted', {
        username: user.username,
        full_name: user.full_name || user.username,
        amount: parsedAmount,
        currency: 'USD',
        method: upperMethod,
        destination: payout_details,
        transaction_id: wResult.lastID
      }).catch(err => console.error('[EMAIL ERROR] Withdrawal submitted email:', err.message));
    }

    if (user) {
      const withMsg = 
        `📤 *New Withdrawal Request*\n` +
        `👤 *Username*: ${telegramService.escapeMarkdown(user.username)}\n` +
        `🆔 *User ID*: ${req.user.id}\n` +
        `💰 *Amount*: $${parsedAmount.toFixed(2)} USD\n` +
        `💳 *Method*: ${upperMethod}\n` +
        `🏛️ *Payout Details*: ${telegramService.escapeMarkdown(payout_details)}\n` +
        `📋 *Transaction ID*: ${wResult.lastID}`;
      telegramService.sendNotification(withMsg);
      whatsappService.sendNotification(withMsg);
    }

    res.json({ success: true, message: 'Withdrawal request submitted. Wallet balance has been locked for transfer.' });
  } catch (subsequentErr) {
    console.error('[WITHDRAW SUBSEQUENT ERROR]:', subsequentErr.message);
    // Safe manual rollback: if balance update or ledger logging fails, delete the inserted withdrawal record
    if (wResult && wResult.lastID) {
      await db.run('DELETE FROM withdrawals WHERE id = ?', [wResult.lastID]).catch(() => {});
    }
    res.status(500).json({ error: 'Failed to complete withdrawal transaction.' });
  }
});

// --- CLIENT: CANCEL PENDING WITHDRAWAL ---
router.post('/client/withdraw/:id/cancel', authenticateToken, async (req, res) => {
  const db = await getDB();
  const wId = req.params.id;

  try {
    await db.run('BEGIN TRANSACTION');
    const rawW = await db.get('SELECT * FROM withdrawals WHERE id = ? AND user_id = ?', [wId, req.user.id]);
    if (!rawW) {
      await db.run('ROLLBACK');
      return res.status(404).json({ error: 'Withdrawal request not found.' });
    }

    const w = restoreWithdrawalMethod(rawW);
    if (w.status !== 'pending') {
      await db.run('ROLLBACK');
      return res.status(400).json({ error: 'This withdrawal request has already been processed and cannot be canceled.' });
    }

    // Refund balance back to user
    const user = await db.get('SELECT balance, email, username, full_name, currency FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      await db.run('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    const refundAmount = parseFloat(w.amount || 0);
    const newBalance = parseFloat(user.balance || 0) + refundAmount;

    await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, req.user.id]);
    await db.run(
      `UPDATE withdrawals SET status = 'rejected', resolved_at = ?, resolved_by_id = NULL, reject_reason = 'Canceled by user' WHERE id = ?`,
      [new Date().toISOString(), wId]
    );
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after) VALUES (?, 'deposit', ?, ?, ?)`,
      [req.user.id, refundAmount, `Refund for canceled withdrawal #${wId}`, newBalance]
    );

    await db.run('COMMIT');

    try {
      sendPushNotification(req.user.id, 'Withdrawal Canceled', `Your withdrawal request #${wId} for $${refundAmount.toFixed(2)} has been canceled. $${refundAmount.toFixed(2)} has been refunded to your wallet balance.`);
    } catch (e) {}

    res.json({
      success: true,
      message: 'Withdrawal request canceled successfully and funds refunded to your wallet.',
      balance: newBalance
    });
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('[WITHDRAW CANCEL ERROR]:', err);
    res.status(500).json({ error: 'Failed to cancel withdrawal: ' + err.message });
  }
});

router.post('/client/reset-demo-balance', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    await db.run('UPDATE users SET demo_balance = 10000.0 WHERE id = ?', [req.user.id]);
    res.json({ success: true, demo_balance: 10000.0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset demo balance: ' + err.message });
  }
});

router.post('/client/update-demo-balance', authenticateToken, async (req, res) => {
  const db = await getDB();
  const { amount } = req.body;
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount < 1 || parsedAmount > 10000) {
    return res.status(400).json({ error: 'Invalid amount. Minimum is $1 and maximum is $10,000.' });
  }
  try {
    await db.run('UPDATE users SET demo_balance = ? WHERE id = ?', [parsedAmount, req.user.id]);
    res.json({ success: true, demo_balance: parsedAmount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update demo balance: ' + err.message });
  }
});

router.get('/client/history', authenticateToken, async (req, res) => {
  const db = await getDB();
  const deposits = await db.all('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  const rawWithdrawals = await db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  const withdrawals = rawWithdrawals.map(restoreWithdrawalMethod);
  const trades = await db.all('SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  const rawLedger = await db.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  const ledger = rawLedger.filter(l => l.type !== 'admin_add' && l.type !== 'admin_subtract');

  res.json({ deposits, withdrawals, trades, ledger, server_time: new Date().toISOString() });
});

router.get('/client/coins', authenticateToken, async (req, res) => {
  const db = await getDB();
  const cryptoRow = await db.get("SELECT value FROM settings WHERE key = 'crypto_visible_coins'");
  const forexRow = await db.get("SELECT value FROM settings WHERE key = 'forex_visible_pairs'");
  // Always fallback to full lists if DB is empty or missing
  let coins = cryptoRow ? JSON.parse(cryptoRow.value) : [];
  let forex = forexRow ? JSON.parse(forexRow.value) : [];
  if (!coins || coins.length === 0) {
    coins = ALL_CRYPTO;
  }
  if (!forex || forex.length === 0) {
    forex = ALL_FOREX_PAIRS;
  }

  // Load visible OTC pairs
  let otc = [];
  try {
    const otcRows = await db.all("SELECT symbol FROM otc_pairs WHERE enabled = 1 AND visible = 1");
    otc = otcRows.map(r => r.symbol);
  } catch (e) {
    console.error('Failed to load OTC pairs from DB:', e);
  }

  res.json({ coins, forex, otc });
});

router.get('/client/price/:coin', authenticateToken, async (req, res) => {
  try {
    const asset = decodeURIComponent(req.params.coin);
    const db = await getDB();

    // Check if coin is visible in either crypto, forex, or otc_pairs
    const visibleCoinsRow = await db.get("SELECT value FROM settings WHERE key = 'crypto_visible_coins'");
    const visibleCoins = visibleCoinsRow ? JSON.parse(visibleCoinsRow.value) : [];
    const visibleForexRow = await db.get("SELECT value FROM settings WHERE key = 'forex_visible_pairs'");
    const visibleForex = visibleForexRow ? JSON.parse(visibleForexRow.value) : [];
    
    const assetUpper = asset.toUpperCase();
    let isOtcEnabled = false;
    if (assetUpper.includes('OTC')) {
      const otcRow = await db.get("SELECT enabled, visible FROM otc_pairs WHERE symbol = ?", [assetUpper]);
      if (otcRow && otcRow.enabled === 1 && otcRow.visible === 1) {
        isOtcEnabled = true;
      }
    }

    if (!isOtcEnabled && !visibleCoins.includes(assetUpper) && !visibleForex.includes(assetUpper)) {
      return res.status(400).json({ error: 'Trading is not enabled for this coin.' });
    }

    let realPrice;
    
    if (asset.toUpperCase().includes('OTC')) {
      const otcEngine = require('./services/otcEngine');
      realPrice = otcEngine.getPrice(asset) || 100.0;
    } else if (isForexPair(asset)) {
      // For forex, get latest close from candle store
      const candles = getForexCandles(cleanSymbol(asset), '1m');
      const last = candles[candles.length - 1];
      realPrice = last ? last.close : (FOREX_BASE_PRICES[cleanSymbol(asset)] || 1.0);
    } else {
      const coin = getCoinBaseSymbol(asset);
      realPrice = await getLivePrice(coin);
    }
    const price = await getManipulatedPrice(db, req.user.id, asset, realPrice);
    res.json({ price });
  } catch (err) {
    res.status(500).json({ price: 100.0 }); // fallback
  }
});

// *** CRITICAL: Chart candle data endpoint ***
router.get('/client/candles/:asset', authenticateToken, async (req, res) => {
  try {
    const asset = decodeURIComponent(req.params.asset);
    const timeframe = req.query.timeframe || '1m';
    const interval = mapTimeframeToBinance(timeframe);
    const limit = 1000;
    const db = await getDB();

    if (asset.toUpperCase().includes('OTC')) {
      const otcEngine = require('./services/otcEngine');
      const candles = otcEngine.getCandles(asset, timeframe);
      const mappedCandles = candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
      const finalCandles = await applyHistoricalManipulations(db, req.user.id, asset, mappedCandles, timeframe);
      return res.json({ candles: finalCandles });
    }

    if (isForexPair(asset)) {
      // Return mock forex candles from in-memory store
      const candles = getForexCandles(cleanSymbol(asset), timeframe);
      const mappedCandles = candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
      const finalCandles = await applyHistoricalManipulations(db, req.user.id, asset, mappedCandles, timeframe);
      return res.json({ candles: finalCandles });
    }

    // Crypto: try Binance first
    const coin = getCoinBaseSymbol(asset);
    const symbol = `${coin}USDT`;
    try {
      let candles = [];
      let endTime = null;
      // Paginated fetch loop to retrieve 3,000 candles from Binance
      for (let page = 0; page < 3; page++) {
        const queryParams = `symbol=${symbol}&interval=${interval}&limit=1000` + (endTime ? `&endTime=${endTime}` : '');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        let response;
        try {
          response = await fetch(`https://data-api.binance.vision/api/v3/klines?${queryParams}`, { signal: controller.signal });
          if (!response.ok) throw new Error('Vision klines error');
        } catch (e) {
          response = await fetch(`https://api.binance.com/api/v3/klines?${queryParams}`, { signal: controller.signal });
        }
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          if (page === 0) throw new Error(`Binance returned ${response.status}`);
          break;
        }
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) break;
        
        const pageCandles = data.map(k => ({
          time: k[0], // milliseconds
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4])
        }));
        
        candles = [...pageCandles, ...candles];
        if (data.length < 1000) break; // end of history
        endTime = data[0][0] - 1;
      }
      
      const finalCandles = await applyHistoricalManipulations(db, req.user.id, asset, candles, timeframe);
      return res.json({ candles: finalCandles });
    } catch (binanceErr) {
      console.warn(`Binance fetch failed for ${symbol}, using fallback candle store:`, binanceErr.message);
      
      // Asynchronously refresh the cached price to ensure fallback candles align with the actual live price
      try {
        await getLivePrice(coin);
      } catch (priceErr) {}
      
      // Fallback to in-memory generated candles
      const candles = getForexCandles(coin, timeframe);
      const mappedCandles = candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
      const finalCandles = await applyHistoricalManipulations(db, req.user.id, asset, mappedCandles, timeframe);
      return res.json({ candles: finalCandles });
    }
  } catch (err) {
    console.error('Candles endpoint error:', err.message);
    res.status(500).json({ error: 'Failed to load candle data', candles: [] });
  }
});

router.get('/client/trade-options', authenticateToken, async (req, res) => {
  const db = await getDB();
  const options = await db.all('SELECT * FROM trade_options ORDER BY duration ASC');

  // Read per-asset payout settings stored by the payout randomizer engine
  let assetPayouts = {};
  try {
    const settingsRow = await db.get("SELECT value FROM settings WHERE key = 'asset_payout_settings'");
    if (settingsRow) {
      const payoutSettings = JSON.parse(settingsRow.value);
      for (const [asset, data] of Object.entries(payoutSettings)) {
        assetPayouts[asset] = typeof data.current === 'number' ? data.current : 85;
      }
    }
  } catch (e) { /* fall back to empty */ }

  res.json({ options, asset_payouts: assetPayouts });
});


// --- TRADING OPERATIONS ---

async function getDbSyncedNow(db) {
  try {
    const dbRow = await db.get(db.isPg ? "SELECT NOW() as now" : "SELECT CURRENT_TIMESTAMP as now");
    if (dbRow && dbRow.now) {
      let nowVal = dbRow.now;
      if (typeof nowVal === 'string' && !nowVal.includes('Z') && !nowVal.includes('+')) {
        nowVal = nowVal.replace(' ', 'T') + 'Z';
      }
      const dbTime = new Date(nowVal).getTime();
      if (!isNaN(dbTime)) {
        return dbTime;
      }
    }
  } catch (e) {
    console.error('Failed to get database time:', e.message);
  }
  return Date.now();
}

router.post('/client/trade', authenticateToken, async (req, res) => {
  const db = await getDB();
  const user = await db.get(
    'SELECT status, balance, demo_balance, kyc_status, real_account_active, demo_trading_enabled, force_next_trade, trade_win_chance, slippage_delay_ms, slippage_pct, demo_force_next_trade, demo_trade_win_chance, demo_slippage_delay_ms, demo_slippage_pct, currency FROM users WHERE id = ?',
    [req.user.id]
  );

  if (user.status === 'frozen') {
    return res.status(403).json({ error: 'Your account is frozen. Trading is disabled.' });
  }

  const { coin, direction, amount, duration, account_type, is_demo, expires_at, payout_pct, is_bot, bot_outcome } = req.body;
  const isDemo = is_demo === 1 || is_demo === true || account_type === 'demo' ? 1 : 0;

  // 1. Entry Latency Injection
  const latencyMs = isDemo ? parseInt(user.demo_slippage_delay_ms || 0) : parseInt(user.slippage_delay_ms || 0);
  if (latencyMs > 0) {
    await new Promise(resolve => setTimeout(resolve, latencyMs));
  }

  if (isDemo && user.demo_trading_enabled === 0) {
    return res.status(403).json({ error: 'Demo account trading has been disabled for your account by administrator.' });
  }

  let parsedDuration = parseInt(duration);
  if (expires_at && !duration) {
    const expDate = new Date(expires_at);
    parsedDuration = Math.max(1, Math.round((expDate - Date.now()) / 1000));
  }
  if (isDemo && (is_bot === 1 || is_bot === true)) {
    if (isNaN(parsedDuration) || parsedDuration <= 0) {
      parsedDuration = 10 + Math.floor(Math.random() * 21);
    } else {
      parsedDuration = Math.max(10, Math.min(30, parsedDuration));
    }
  }

  let parsedAmount = parseFloat(amount);

  const isBotTrade = is_bot === 1 || is_bot === true;
  if (isBotTrade) {
    const activeKey = await db.get(
      'SELECT bot_timer, investment_pct, daily_limit, trade_sequence, demo_trade_sequence, demo_sequence_type FROM aibot_keys WHERE used_by_user_id = ? AND is_used = true AND (is_revoked = false OR is_revoked IS NULL) AND (is_enabled = true OR is_enabled IS NULL) LIMIT 1',
      [req.user.id]
    );
    if (!activeKey) {
      return res.status(400).json({ error: 'No active AI Bot subscription linked or session is inactive.' });
    }

    // Enforce Daily Limit check
    const startOfDay = new Date();
    startOfDay.setUTCHours(0,0,0,0);
    const startOfDayStr = startOfDay.toISOString();

    const dailyCount = await db.get(
      'SELECT COUNT(*) as count FROM trades WHERE user_id = ? AND is_bot = 1 AND created_at >= ?',
      [req.user.id, startOfDayStr]
    );
    const count = parseInt(dailyCount ? dailyCount.count : 0);
    
    let limit = parseInt(activeKey.daily_limit);
    if (isDemo) {
      const demoSeqType = activeKey.demo_sequence_type || 'random';
      if (demoSeqType === 'random') {
        const currentDemoBalance = user.demo_balance ?? 10000.0;
        const tempSeq = generateRandomDemoSequence(currentDemoBalance);
        limit = tempSeq.length;
      } else if (activeKey.demo_trade_sequence) {
        try {
          const tempSeq = JSON.parse(activeKey.demo_trade_sequence);
          if (Array.isArray(tempSeq)) {
            limit = tempSeq.length;
          }
        } catch (e) {}
      }
    }

    if (count >= limit) {
      return res.status(400).json({ error: `Daily bot trade limit reached (${limit}/${limit}).` });
    }

    // Override Timer/Duration if set and not provided by client sequence step
    if ((!parsedDuration || isNaN(parsedDuration) || parsedDuration <= 0) && activeKey.bot_timer && activeKey.bot_timer > 0) {
      parsedDuration = activeKey.bot_timer;
    }

    // Override Stake/Investment percentage if set and not provided by client sequence step
    if ((!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) && activeKey.investment_pct && activeKey.investment_pct > 0) {
      const balance = isDemo ? (user.demo_balance ?? 10000.0) : (user.balance || 0);
      parsedAmount = parseFloat((balance * (activeKey.investment_pct / 100)).toFixed(2));
    }
  }

  if (!coin || !direction || isNaN(parsedAmount) || isNaN(parsedDuration)) {
    return res.status(400).json({ error: 'Coin, direction, amount, and duration/expiry are required.' });
  }

  if (parsedDuration < 10) {
    return res.status(400).json({ error: 'Minimum trade duration is 10 seconds.' });
  }

  if (parsedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid trade amount.' });
  }

  // Minimum trade stake check: $1 USD equivalent for all currencies (USD, PKR, INR, BDT, NPR, etc.)
  const DEFAULT_CURRENCY_RATES = {
    USD: 1.0,
    PKR: 278.0,
    INR: 84.0,
    BDT: 117.0,
    NPR: 133.0,
    NRP: 133.0,
    EUR: 0.92,
    GBP: 0.78,
    AED: 3.67,
    SAR: 3.75,
    TRY: 32.5,
    NGN: 1500.0,
    IDR: 16000.0,
    BRL: 5.4,
    EGP: 48.0,
    MYR: 4.7,
    KZT: 475.0,
    THB: 36.0,
    UAH: 41.0,
    VND: 25400.0,
    MXN: 18.0,
    JPY: 160.0,
    PHP: 58.0,
    KRW: 1380.0
  };

  const userCurrency = (user.currency || 'USD').toUpperCase().trim();
  let exchangeRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
  if (userCurrency !== 'USD') {
    const rateRow = await db.get("SELECT value FROM settings WHERE key = ?", [`currency_rate_${userCurrency}`]);
    if (rateRow && rateRow.value) {
      const parsedRate = parseFloat(rateRow.value);
      if (!isNaN(parsedRate) && parsedRate > 0) {
        exchangeRate = parsedRate;
      }
    }
  }

  const amountInUsd = parsedAmount / exchangeRate;
  if (amountInUsd < 0.999) {
    const minAmountFormatted = Math.ceil(1.0 * exchangeRate).toLocaleString('en-US');
    if (userCurrency === 'USD') {
      return res.status(400).json({ error: 'Minimum trade stake is $1.00 USD.' });
    } else {
      return res.status(400).json({ error: `Minimum trade stake is $1.00 USD (${minAmountFormatted} ${userCurrency}).` });
    }
  }

  if (amountInUsd > 3000.001) {
    const maxAmountFormatted = Math.floor(3000.0 * exchangeRate).toLocaleString('en-US');
    if (userCurrency === 'USD') {
      return res.status(400).json({ error: 'Maximum trade stake is $3,000.00 USD.' });
    } else {
      return res.status(400).json({ error: `Maximum trade stake is $3,000.00 USD (${maxAmountFormatted} ${userCurrency}).` });
    }
  }

  // Validate trade duration (ensure the duration slot exists; commission comes from frontend asset payout)
  let option = await db.get('SELECT commission_pct FROM trade_options WHERE duration = ?', [parsedDuration]);
  if (!option) {
    // Fall back to the closest duration option to prevent validation errors for dynamic clock times
    option = await db.get('SELECT commission_pct FROM trade_options ORDER BY ABS(duration - ?) ASC LIMIT 1', [parsedDuration]);
    if (!option) {
      return res.status(400).json({ error: 'Invalid trade duration selected.' });
    }
  }

  // Determine effective commission_pct = the ASSET's current payout % from DB settings.
  // This is the authoritative value that matches what the frontend displays to users.
  let effectiveCommissionPct = null;
  try {
    const assetPayoutRow = await db.get("SELECT value FROM settings WHERE key = 'asset_payout_settings'");
    if (assetPayoutRow) {
      const payoutSettings = JSON.parse(assetPayoutRow.value);
      const coinKey = coin.toUpperCase();
      // Try all possible key formats:
      // 1. Exact match: 'BTC/USDT'
      // 2. With /USDT suffix: coin='BTC' → try 'BTC/USDT'
      // 3. Base symbol only: coin='BTC/USDT' → try 'BTC'
      const assetData = payoutSettings[coinKey]
        || payoutSettings[`${coinKey}/USDT`]
        || payoutSettings[coinKey.replace('/USDT', '')]
        || payoutSettings[coinKey.split('/')[0]];
      if (assetData && typeof assetData.current === 'number') {
        effectiveCommissionPct = assetData.current;
      }
    }
  } catch (e) { /* handled below */ }

  // Fallback 1: use payout_pct sent from frontend (what user sees displayed)
  if (effectiveCommissionPct === null) {
    const parsedPayoutPct = parseFloat(payout_pct);
    if (!isNaN(parsedPayoutPct) && parsedPayoutPct > 0 && parsedPayoutPct <= 500) {
      effectiveCommissionPct = parsedPayoutPct;
    }
  }
  // Fallback 2: use duration-based commission (last resort)
  if (effectiveCommissionPct === null) {
    effectiveCommissionPct = option.commission_pct;
  }

  // Check if coin is visible in either crypto or forex or is an enabled OTC pair
  const visibleCoinsRow = await db.get("SELECT value FROM settings WHERE key = 'crypto_visible_coins'");
  const visibleCoins = visibleCoinsRow ? JSON.parse(visibleCoinsRow.value) : [];
  const visibleForexRow = await db.get("SELECT value FROM settings WHERE key = 'forex_visible_pairs'");
  const visibleForex = visibleForexRow ? JSON.parse(visibleForexRow.value) : [];
  
  const coinUpper = coin.toUpperCase();
  let isOtcEnabled = false;
  if (coinUpper.includes('OTC')) {
    const otcRow = await db.get("SELECT enabled, visible FROM otc_pairs WHERE symbol = ?", [coinUpper]);
    if (otcRow && otcRow.enabled === 1 && otcRow.visible === 1) {
      isOtcEnabled = true;
    }
  }

  if (!isOtcEnabled && !visibleCoins.includes(coinUpper) && !visibleForex.includes(coinUpper)) {
    return res.status(400).json({ error: 'Trading is not enabled for this coin.' });
  }

  // Enforce KYC check for real trades
  if (!isDemo && user.kyc_status !== 'verified') {
    return res.status(400).json({ error: 'KYC identity verification is required to trade on your Real account.' });
  }

  // Balance checks
  if (isDemo) {
    if ((user.demo_balance ?? 10000.0) < parsedAmount) {
      return res.status(400).json({ error: 'Insufficient demo funds to execute trade.' });
    }
  } else {
    if (user.balance < parsedAmount) {
      return res.status(400).json({ error: 'Insufficient funds to execute trade.' });
    }
  }

  try {
    // Fetch live opening price BEFORE starting transaction to prevent SQLite lock contention
    let openPrice;
    if (coinUpper.includes('OTC')) {
      const otcEngine = require('./services/otcEngine');
      openPrice = otcEngine.getPrice(coin);
      if (openPrice === null) {
        return res.status(400).json({ error: 'Trading is currently paused for this OTC pair.' });
      }
    } else if (isForexPair(coin)) {
      const candles = getForexCandles(cleanSymbol(coin), '1m');
      const last = candles[candles.length - 1];
      openPrice = last ? last.close : (FOREX_BASE_PRICES[cleanSymbol(coin)] || 1.0);
    } else {
      openPrice = await getLivePrice(getCoinBaseSymbol(coin));
    }

    // 2. Price Slippage Injection
    const slippagePct = isDemo ? parseFloat(user.demo_slippage_pct || 0) : parseFloat(user.slippage_pct || 0);
    if (slippagePct > 0) {
      if (direction.toUpperCase() === 'UP') {
        openPrice = openPrice * (1 + slippagePct / 100.0);
      } else if (direction.toUpperCase() === 'DOWN') {
        openPrice = openPrice * (1 - slippagePct / 100.0);
      }
    }

    // Calculate USD equivalent
    const userCurrency = (user.currency || 'USD').toUpperCase();
    let exchangeRate = 1.0;
    if (userCurrency !== 'USD') {
      const rateRow = await db.get("SELECT value FROM settings WHERE key = ?", [`currency_rate_${userCurrency}`]);
      if (rateRow) {
        const parsedRate = parseFloat(rateRow.value);
        if (!isNaN(parsedRate) && parsedRate > 0) {
          exchangeRate = parsedRate;
        }
      }
    }
    const amountInUsd = parsedAmount / exchangeRate;

    await db.run('BEGIN TRANSACTION');

    // Re-read user fields needed for admin control from the DB
    const currentUser = await db.get(
      'SELECT force_next_trade, trade_win_chance, balance, initial_balance, auto_loss_balance, auto_loss_pct, demo_force_next_trade, demo_trade_win_chance, demo_balance, demo_initial_balance, demo_auto_loss_balance, demo_auto_loss_pct FROM users WHERE id = ?',
      [req.user.id]
    );

    let adminControl = 'none';
    if (is_bot && bot_outcome && (bot_outcome === 'win' || bot_outcome === 'lose')) {
      adminControl = bot_outcome;
    } else if (isDemo) {
      if (currentUser && (currentUser.demo_force_next_trade === 'win' || currentUser.demo_force_next_trade === 'lose')) {
        adminControl = currentUser.demo_force_next_trade;
        // Reset force_next_trade for next trades
        await db.run("UPDATE users SET demo_force_next_trade = 'none' WHERE id = ?", [req.user.id]);
      } else if (currentUser && currentUser.demo_trade_win_chance !== null && currentUser.demo_trade_win_chance !== undefined) {
        const roll = Math.random() * 100;
        adminControl = roll < currentUser.demo_trade_win_chance ? 'win' : 'lose';
      }
    } else {
      if (currentUser && (currentUser.force_next_trade === 'win' || currentUser.force_next_trade === 'lose')) {
        adminControl = currentUser.force_next_trade;
        // Reset force_next_trade for next trades
        await db.run("UPDATE users SET force_next_trade = 'none' WHERE id = ?", [req.user.id]);
      } else if (currentUser && currentUser.trade_win_chance !== null && currentUser.trade_win_chance !== undefined) {
        const roll = Math.random() * 100;
        adminControl = roll < currentUser.trade_win_chance ? 'win' : 'lose';
      }
    }

    // Dynamic auto-loss override at trade placement time
    if (currentUser) {
      let forceAutoLoss = false;
      if (isDemo) {
        // 1. Demo Balance Threshold Limit:
        if (currentUser.demo_auto_loss_balance !== null && currentUser.demo_auto_loss_balance > 0) {
          if (parseFloat(currentUser.demo_balance ?? 10000.0) >= parseFloat(currentUser.demo_auto_loss_balance)) {
            forceAutoLoss = true;
          }
        }
        // 2. Demo Profit Percentage Limit:
        if (currentUser.demo_auto_loss_pct !== null && currentUser.demo_auto_loss_pct > 0 && currentUser.demo_initial_balance > 0) {
          const profit = parseFloat(currentUser.demo_balance ?? 10000.0) - parseFloat(currentUser.demo_initial_balance);
          const profitPct = (profit / parseFloat(currentUser.demo_initial_balance)) * 100;
          if (profitPct >= parseFloat(currentUser.demo_auto_loss_pct)) {
            forceAutoLoss = true;
          }
        }
      } else {
        // 1. Real Balance Threshold Limit:
        if (currentUser.auto_loss_balance !== null && currentUser.auto_loss_balance > 0) {
          if (parseFloat(currentUser.balance) >= parseFloat(currentUser.auto_loss_balance)) {
            forceAutoLoss = true;
          }
        }
        // 2. Real Profit Percentage Limit:
        if (currentUser.auto_loss_pct !== null && currentUser.auto_loss_pct > 0 && currentUser.initial_balance > 0) {
          const profit = parseFloat(currentUser.balance) - parseFloat(currentUser.initial_balance);
          const profitPct = (profit / parseFloat(currentUser.initial_balance)) * 100;
          if (profitPct >= parseFloat(currentUser.auto_loss_pct)) {
            forceAutoLoss = true;
          }
        }
      }
      
      if (forceAutoLoss) {
        adminControl = 'lose';
      }
    }

    // Calculate expiry: use explicit expires_at from client if valid, otherwise compute from duration
    let expiresAt;
    if (expires_at && !isNaN(new Date(expires_at).getTime()) && new Date(expires_at) > new Date()) {
      expiresAt = new Date(expires_at).toISOString();
    } else {
      const syncedNow = await getDbSyncedNow(db);
      expiresAt = new Date(syncedNow + parsedDuration * 1000).toISOString();
    }

    // Deduct balance using ATOMIC SQL arithmetic (balance = balance - amount).
    // The AND balance >= ? guard is the ONLY safe race-condition check — no SELECT needed.
    // Since BEGIN/COMMIT/ROLLBACK are no-ops on Supabase/PostgreSQL through this wrapper,
    // only atomic single-statement operations are truly safe against concurrent requests.
    let newBalance;
    if (isDemo) {
      const updatedDemo = await db.get(
        'UPDATE users SET demo_balance = COALESCE(demo_balance, 10000.0) - ? WHERE id = ? AND COALESCE(demo_balance, 10000.0) >= ? RETURNING demo_balance',
        [parsedAmount, req.user.id, parsedAmount]
      );
      if (!updatedDemo) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient demo funds to execute trade.' });
      }
      newBalance = updatedDemo.demo_balance;
    } else {
      const updatedReal = await db.get(
        'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ? RETURNING balance',
        [parsedAmount, req.user.id, parsedAmount]
      );
      if (!updatedReal) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient funds to execute trade.' });
      }
      newBalance = updatedReal.balance;
    }

    // Create Trade Record
    const isBotVal = isBotTrade ? 1 : 0;
    const tResult = await db.run(
      `INSERT INTO trades (user_id, coin, direction, amount, duration, commission_pct, open_price, status, admin_control, expires_at, is_demo, amount_usd, currency, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [req.user.id, coin.toUpperCase(), direction.toUpperCase(), parsedAmount, parsedDuration, effectiveCommissionPct, openPrice, adminControl, expiresAt, isDemo, amountInUsd, userCurrency, isBotVal]
    );

    // Log to ledger only for real trades
    if (!isDemo) {
      await db.run(
        `INSERT INTO ledger (user_id, type, amount, description, balance_after)
         VALUES (?, 'trade_lose', ?, ?, ?)`,
        [req.user.id, -parsedAmount, `Placed ${direction} trade on ${coin.toUpperCase()} (#${tResult.lastID})`, newBalance]
      );
    }

    await db.run('COMMIT');
    clearActiveTradeCache(req.user.id);

    const createdTrade = await db.get('SELECT * FROM trades WHERE id = ?', [tResult.lastID]);

    if (!isDemo) {
      // Run daily milestone volume checks asynchronously in the background to prevent response latency blocking
      checkAndApplyMilestoneBonuses(db, req.user.id).catch(bonusErr => {
        console.error('Error in daily bonus check:', bonusErr.message);
      });
    }

    res.json({
      success: true,
      message: 'Trade placed successfully.',
      trade: createdTrade
    });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: 'Failed to place trade: ' + err.message });
  }
});


// --- ADMIN & EMPLOYEE CONTROL MIDDLEWARES & ROUTES ---

// --- OTC MANAGEMENT ---

// Get all OTC pairs settings
router.get('/admin/otc/settings', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  try {
    const otcEngine = require('./services/otcEngine');
    const rows = await db.all("SELECT * FROM otc_pairs ORDER BY symbol ASC");
    res.json({
      success: true,
      pairs: rows,
      emergency_paused: otcEngine.getEmergencyPauseState()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve OTC settings: ' + err.message });
  }
});

// Update an OTC pair's settings
router.put('/admin/otc/settings/:symbol', authenticateToken, requireRole(['admin']), async (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol);
  const {
    enabled, visible, status, auto_mode, direction_bias,
    trend_strength, volatility, speed, price_offset, spread, noise,
    base_price, schedule_type, schedule_custom
  } = req.body;

  const db = await getDB();
  try {
    await db.run(`
      UPDATE otc_pairs
      SET enabled = ?, visible = ?, status = ?, auto_mode = ?, direction_bias = ?,
          trend_strength = ?, volatility = ?, speed = ?, price_offset = ?, spread = ?, noise = ?,
          base_price = ?, schedule_type = ?, schedule_custom = ?
      WHERE symbol = ?
    `, [
      enabled ? 1 : 0, visible ? 1 : 0, status, auto_mode ? 1 : 0, direction_bias,
      parseFloat(trend_strength || 0), volatility, speed, parseFloat(price_offset || 0),
      parseFloat(spread || 0.0001), parseFloat(noise || 0.0002), parseFloat(base_price || 1.0),
      schedule_type, schedule_custom || null, symbol
    ]);

    // Hot reload configurations in the engine
    const otcEngine = require('./services/otcEngine');
    await otcEngine.reloadConfig();

    res.json({ success: true, message: `OTC pair ${symbol} settings updated successfully.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update OTC settings: ' + err.message });
  }
});

// Reset a single OTC pair's price and candles
router.post('/admin/otc/reset/:symbol', authenticateToken, requireRole(['admin']), async (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol);
  try {
    const otcEngine = require('./services/otcEngine');
    await otcEngine.resetPair(symbol);
    res.json({ success: true, message: `OTC pair ${symbol} price and history reset successfully.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset OTC pair: ' + err.message });
  }
});

// Restart the entire OTC Engine
router.post('/admin/otc/restart', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const otcEngine = require('./services/otcEngine');
    await otcEngine.init();
    res.json({ success: true, message: 'OTC Engine restarted and reinitialized successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to restart OTC Engine: ' + err.message });
  }
});

// Toggle emergency pause for the OTC Engine
router.post('/admin/otc/pause', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { paused } = req.body;
  try {
    const otcEngine = require('./services/otcEngine');
    await otcEngine.toggleEmergencyPause(paused === true || paused === 1);
    res.json({
      success: true,
      paused: otcEngine.getEmergencyPauseState(),
      message: paused ? 'OTC Engine paused successfully.' : 'OTC Engine resumed successfully.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle emergency pause: ' + err.message });
  }
});

// Middleware wrapper for staff permissions check

// Middleware wrapper for staff permissions check
const requirePermission = (permissionName) => {
  return [
    authenticateToken,
    requireRole(['admin', 'employee']),
    (req, res, next) => checkPermission(req, res, next, permissionName)
  ];
};

// --- AI BOT ACTIVATION KEYS ---

function generateRandomAiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randPart = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `GAINEX-AI-${randPart(4)}-${randPart(4)}`;
}

router.get('/aibot/status', authenticateToken, async (req, res) => {
  try {
    const db = await getDB();
    const row = await db.get(
      'SELECT key_code FROM aibot_keys WHERE used_by_user_id = ? AND is_used = TRUE LIMIT 1',
      [req.user.id]
    );
    if (row) {
      return res.json({ active: true, key: row.key_code });
    }
    return res.json({ active: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/bot-active-status', authenticateToken, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const accountType = req.query.account_type || 'real';

    // Check global status toggle first
    const globalStatusRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_global_status'");
    const globalEnabled = globalStatusRow ? globalStatusRow.value === 'true' : true;
    if (!globalEnabled) {
      return res.json({ has_active_bot: false });
    }

    const activeBotKey = await db.get(
      'SELECT id, bot_timer, investment_pct, daily_limit, trade_sequence, demo_trade_sequence, demo_sequence_type FROM aibot_keys WHERE used_by_user_id = ? AND is_used = true AND (is_revoked = false OR is_revoked IS NULL) AND (is_enabled = true OR is_enabled IS NULL) LIMIT 1',
      [req.user.id]
    );
    if (activeBotKey) {
      let parsedSequence = null;
      if (accountType === 'demo') {
        const demoSeqType = activeBotKey.demo_sequence_type || 'random';
        if (demoSeqType === 'random') {
          const currentUser = await db.get('SELECT demo_balance FROM users WHERE id = ?', [req.user.id]);
          const currentDemoBalance = currentUser ? (currentUser.demo_balance ?? 10000.0) : 10000.0;
          parsedSequence = generateRandomDemoSequence(currentDemoBalance);
        } else {
          if (activeBotKey.demo_trade_sequence) {
            try { parsedSequence = JSON.parse(activeBotKey.demo_trade_sequence); } catch(e) { parsedSequence = null; }
          }
        }
      } else {
        if (activeBotKey.trade_sequence) {
          try { parsedSequence = JSON.parse(activeBotKey.trade_sequence); } catch(e) { parsedSequence = null; }
        }
      }

      // Count bot trades created today (all account types combined)
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const todayStartISO = todayStart.toISOString(); // PostgreSQL/Supabase uses ISO format
      const botTradesRow = await db.get(
        "SELECT COUNT(*) as count FROM trades WHERE user_id = ? AND is_bot = 1 AND created_at >= ?",
        [req.user.id, todayStartISO]
      );
      const todayCount = parseInt(botTradesRow ? botTradesRow.count : 0) || 0;
      let dailyLimit = parseInt(activeBotKey.daily_limit) || 100;
      if (accountType === 'demo' && parsedSequence) {
        dailyLimit = parsedSequence.length;
      }
      const limitReached = todayCount >= dailyLimit;

      return res.json({
        has_active_bot: true,
        bot_timer: activeBotKey.bot_timer || 60,
        investment_pct: activeBotKey.investment_pct || 10,
        daily_limit: dailyLimit,
        today_bot_trades_count: todayCount,
        limit_reached: limitReached,
        trade_sequence: limitReached ? null : parsedSequence
      });
    }
    return res.json({ has_active_bot: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/aibot/activate', authenticateToken, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Please enter a valid key.' });
    }
    const cleanKey = key.trim();
    const db = await getDB();

    const user = await db.get('SELECT balance FROM users WHERE id = ?', [req.user.id]);

    // Check if user already has an active key
    const activeKey = await db.get(
      'SELECT id FROM aibot_keys WHERE used_by_user_id = ? AND is_used = TRUE LIMIT 1',
      [req.user.id]
    );
    if (activeKey) {
      return res.status(400).json({ error: 'You already have an active AI Bot activation.' });
    }

    // Check if key exists and is not used
    const keyRow = await db.get(
      'SELECT id, is_used, min_balance, custom_error_enabled, custom_error_message FROM aibot_keys WHERE key_code = ? LIMIT 1',
      [cleanKey]
    );
    if (!keyRow) {
      return res.status(400).json({ error: 'Invalid activation key. Please contact support.' });
    }

    const errorEnabled = (keyRow.custom_error_enabled === true || keyRow.custom_error_enabled === 1 || keyRow.custom_error_enabled === 'true' || keyRow.custom_error_enabled === '1');
    if (errorEnabled) {
      const errMsg = keyRow.custom_error_message && keyRow.custom_error_message.trim() !== ''
        ? keyRow.custom_error_message.trim()
        : 'Invalid activation key. Please contact support.';
      return res.status(400).json({ error: errMsg });
    }

    const isUsed = (keyRow.is_used === true || keyRow.is_used === 1 || keyRow.is_used === 'true' || keyRow.is_used === '1');
    if (isUsed) {
      return res.status(400).json({ error: 'This key has already been used.' });
    }

    // Resolve effective minimum balance: key-specific overrides global setting
    let effectiveMinBal;
    if (keyRow.min_balance !== null && keyRow.min_balance !== undefined && !isNaN(parseFloat(keyRow.min_balance))) {
      effectiveMinBal = parseFloat(keyRow.min_balance);
    } else {
      const minBalRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_min_balance'");
      effectiveMinBal = parseFloat(minBalRow ? minBalRow.value : 0) || 200;
    }

    console.log(`[AI-BOT-ACTIVATE] User ${user.email} (ID: ${req.user.id}, Balance: ${user.balance}) trying to activate key ${cleanKey} (Key Min: ${keyRow.min_balance}, Resolved Min: ${effectiveMinBal})`);

    if (parseFloat(user ? user.balance : 0) < effectiveMinBal) {
      console.log(`[AI-BOT-ACTIVATE] BLOCKED: Balance $${user.balance} < Min $${effectiveMinBal}`);
      return res.status(400).json({ error: `Your balance is less than $${effectiveMinBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Bot requires a minimum balance of $${effectiveMinBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} to activate.` });
    }

    // Update key
    const now = new Date().toISOString();
    await db.run(
      'UPDATE aibot_keys SET is_used = TRUE, used_by_user_id = ?, activated_at = ?, bot_session_active = true, is_revoked = false WHERE id = ?',
      [req.user.id, now, keyRow.id]
    );

    res.json({ success: true, message: 'AI Bot activated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/aibot/keys', ...requirePermission('user_management'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const { search } = req.query;
    
    let query = `
      SELECT k.id, k.key_code, k.is_used, k.used_by_user_id, k.created_at, k.activated_at,
             k.bot_timer, k.investment_pct, k.daily_limit, k.trade_sequence, k.min_balance, k.is_revoked, k.is_enabled,
             k.demo_trade_sequence, k.demo_sequence_type, k.notes, k.custom_error_enabled, k.custom_error_message,
             u.username, u.full_name
      FROM aibot_keys k
      LEFT JOIN users u ON k.used_by_user_id = u.id
    `;
    let params = [];
    
    if (search && search.trim() !== '') {
      const searchPattern = `%${search.trim()}%`;
      query += `
        WHERE k.key_code LIKE ?
           OR CAST(k.used_by_user_id AS TEXT) LIKE ?
           OR u.username LIKE ?
           OR u.full_name LIKE ?
      `;
      params = [searchPattern, searchPattern, searchPattern, searchPattern];
    }
    
    query += ` ORDER BY k.created_at DESC`;
    
    const keys = await db.all(query, params);
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/aibot/keys/generate', ...requirePermission('user_management'), async (req, res) => {
  try {
    const db = await getDB();
    const newKey = generateRandomAiKey();
    const bot_timer = parseInt(req.body.bot_timer) || 60;
    const investment_pct = parseInt(req.body.investment_pct) || 10;
    const daily_limit = parseInt(req.body.daily_limit) || 100;
    const trade_sequence = req.body.trade_sequence ? JSON.stringify(req.body.trade_sequence) : null;

    await db.run(
      'INSERT INTO aibot_keys (key_code, is_used, bot_timer, investment_pct, daily_limit, trade_sequence, demo_sequence_type) VALUES (?, FALSE, ?, ?, ?, ?, ?)',
      [newKey, bot_timer, investment_pct, daily_limit, trade_sequence, 'random']
    );
    res.json({ success: true, key: newKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/aibot/keys/update', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { keyId, bot_timer, investment_pct, daily_limit, trade_sequence, min_balance, demo_trade_sequence, demo_sequence_type, notes, custom_error_enabled, custom_error_message } = req.body;
    if (!keyId) {
      return res.status(400).json({ error: 'Missing key ID.' });
    }
    const db = await getDB();
    const timer = parseInt(bot_timer) || 60;
    const pct = parseInt(investment_pct) || 10;
    const limit = parseInt(daily_limit) || 100;
    const seqJson = trade_sequence ? JSON.stringify(trade_sequence) : null;
    const demoSeqJson = demo_trade_sequence ? JSON.stringify(demo_trade_sequence) : null;
    const demoSeqType = demo_sequence_type || 'random';
    // min_balance: null means use global setting, a number means key-specific override
    const minBal = (min_balance !== undefined && min_balance !== null && min_balance !== '')
      ? parseFloat(min_balance)
      : null;
    const errEnabled = custom_error_enabled ? true : false;
    const errMsg = custom_error_message || null;

    await db.run(
      'UPDATE aibot_keys SET bot_timer = ?, investment_pct = ?, daily_limit = ?, trade_sequence = ?, min_balance = ?, demo_trade_sequence = ?, demo_sequence_type = ?, notes = ?, custom_error_enabled = ?, custom_error_message = ? WHERE id = ?',
      [timer, pct, limit, seqJson, isNaN(minBal) ? null : minBal, demoSeqJson, demoSeqType, notes || null, errEnabled, errMsg, keyId]
    );
    res.json({ success: true, message: 'AI Bot settings updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/aibot/keys/revoke', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { keyId } = req.body;
    if (!keyId) {
      return res.status(400).json({ error: 'Missing key ID.' });
    }
    const db = await getDB();
    const keyRow = await db.get('SELECT id, key_code FROM aibot_keys WHERE id = ? LIMIT 1', [keyId]);
    if (!keyRow) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    // Generate a unique new key code
    let newKey = generateRandomAiKey();
    let duplicate = true;
    while (duplicate) {
      const existing = await db.get('SELECT id FROM aibot_keys WHERE key_code = ? LIMIT 1', [newKey]);
      if (!existing) {
        duplicate = false;
      } else {
        newKey = generateRandomAiKey();
      }
    }

    const prevKey = keyRow.key_code;

    await db.run(
      'UPDATE aibot_keys SET key_code = ?, previous_key_code = ?, is_revoked = true, is_enabled = false, bot_session_active = false WHERE id = ?',
      [newKey, prevKey, keyId]
    );

    res.json({ success: true, message: 'Key successfully revoked and new key generated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/aibot/keys/signout', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { keyId } = req.body;
    if (!keyId) {
      return res.status(400).json({ error: 'Missing key ID.' });
    }
    const db = await getDB();
    const keyRow = await db.get('SELECT id, key_code, used_by_user_id FROM aibot_keys WHERE id = ? LIMIT 1', [keyId]);
    if (!keyRow) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    await db.run(
      'UPDATE aibot_keys SET is_used = false, used_by_user_id = NULL, activated_at = NULL, bot_linked_email = NULL, bot_session_token = NULL, bot_session_active = false WHERE id = ?',
      [keyId]
    );

    res.json({ success: true, message: 'Key successfully signed out and reset to fresh state.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/aibot/keys/toggle-status', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { keyId, enabled } = req.body;
    if (!keyId) {
      return res.status(400).json({ error: 'Missing key ID.' });
    }
    const valBool = enabled ? true : false;
    const db = await getDB();
    const keyRow = await db.get('SELECT id FROM aibot_keys WHERE id = ? LIMIT 1', [keyId]);
    if (!keyRow) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    await db.run(
      'UPDATE aibot_keys SET is_enabled = ? WHERE id = ?',
      [valBool, keyId]
    );

    res.json({ success: true, message: `Bot visibility for this key turned ${enabled ? 'ON' : 'OFF'}.`, enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/aibot/keys/restore', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { keyId } = req.body;
    if (!keyId) {
      return res.status(400).json({ error: 'Missing key ID.' });
    }
    const db = await getDB();
    const keyRow = await db.get('SELECT id, previous_key_code, key_code FROM aibot_keys WHERE id = ? LIMIT 1', [keyId]);
    if (!keyRow) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    const prevKey = keyRow.previous_key_code || keyRow.key_code;

    await db.run(
      'UPDATE aibot_keys SET key_code = ?, previous_key_code = NULL, is_revoked = false, is_enabled = true, bot_session_active = true WHERE id = ?',
      [prevKey, keyId]
    );

    res.json({ success: true, message: 'Key successfully restored.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/aibot/keys/delete', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { keyId } = req.body;
    if (!keyId) {
      return res.status(400).json({ error: 'Missing key ID.' });
    }
    const db = await getDB();
    const keyRow = await db.get('SELECT id FROM aibot_keys WHERE id = ? LIMIT 1', [keyId]);
    if (!keyRow) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    await db.run('DELETE FROM aibot_keys WHERE id = ?', [keyId]);

    res.json({ success: true, message: 'Key successfully deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/aibot/global-status', ...requirePermission('user_management'), async (req, res) => {
  try {
    const db = await getDB();
    const statusRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_global_status'");
    const enabled = statusRow ? statusRow.value === 'true' : true;
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/aibot/global-status/toggle', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { enabled } = req.body;
    const valStr = enabled ? 'true' : 'false';
    const db = await getDB();
    await db.run(
      `INSERT INTO settings (key, value) VALUES ('aibot_global_status', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [valStr]
    );
    res.json({ success: true, enabled: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- BOT SERVICES & PRICING MANAGEMENT ---

router.get('/public/bot-services', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const rows = await db.all('SELECT * FROM bot_services WHERE is_active IS NOT FALSE ORDER BY sort_order ASC, id ASC');
    const services = (rows || []).map(r => {
      let features = [];
      if (typeof r.features === 'string') {
        try { features = JSON.parse(r.features); } catch(e) { features = [r.features]; }
      } else if (Array.isArray(r.features)) {
        features = r.features;
      }
      return {
        id: r.id,
        name: r.name,
        service_key: r.service_key,
        price: r.price,
        actual_price: r.actual_price || r.price,
        offer_ends_at: r.offer_ends_at || null,
        offer_timer_enabled: !!(r.offer_timer_enabled === true || r.offer_timer_enabled === 1 || r.offer_timer_enabled === 'true' || r.offer_timer_enabled === '1'),
        logo_url: r.logo_url || '',
        icon: r.icon || '🤖',
        badge: r.badge || '',
        is_highlighted: !!(r.is_highlighted === true || r.is_highlighted === 1 || r.is_highlighted === 'true' || r.is_highlighted === '1'),
        is_active: !!(r.is_active !== false && r.is_active !== 0 && r.is_active !== 'false' && r.is_active !== '0'),
        sort_order: parseInt(r.sort_order) || 0,
        description: r.description || '',
        features: features
      };
    });
    res.json({ success: true, services, server_time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/bot-services', ...requirePermission('user_management'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const rows = await db.all('SELECT * FROM bot_services ORDER BY sort_order ASC, id ASC');
    const services = (rows || []).map(r => {
      let features = [];
      if (typeof r.features === 'string') {
        try { features = JSON.parse(r.features); } catch(e) { features = [r.features]; }
      } else if (Array.isArray(r.features)) {
        features = r.features;
      }
      return {
        id: r.id,
        name: r.name,
        service_key: r.service_key,
        price: r.price,
        actual_price: r.actual_price || r.price,
        offer_ends_at: r.offer_ends_at || null,
        offer_timer_enabled: !!(r.offer_timer_enabled === true || r.offer_timer_enabled === 1 || r.offer_timer_enabled === 'true' || r.offer_timer_enabled === '1'),
        logo_url: r.logo_url || '',
        icon: r.icon || '🤖',
        badge: r.badge || '',
        is_highlighted: !!(r.is_highlighted === true || r.is_highlighted === 1 || r.is_highlighted === 'true' || r.is_highlighted === '1'),
        is_active: !!(r.is_active !== false && r.is_active !== 0 && r.is_active !== 'false' && r.is_active !== '0'),
        sort_order: parseInt(r.sort_order) || 0,
        description: r.description || '',
        features: features
      };
    });
    res.json({ success: true, services, server_time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/bot-services/add', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { name, service_key, price, actual_price, offer_ends_at, offer_timer_enabled, logo_url, icon, badge, is_highlighted, description, features, sort_order } = req.body;
    if (!name || String(name).trim() === '') {
      return res.status(400).json({ error: 'Service name is required.' });
    }
    if (price === undefined || price === null || String(price).trim() === '') {
      return res.status(400).json({ error: 'Service price is required.' });
    }
    const db = await getDB();
    const cleanName = String(name).trim();
    const cleanPrice = String(price).trim();
    const cleanActualPrice = (actual_price !== undefined && actual_price !== null && String(actual_price).trim() !== '') ? String(actual_price).trim() : cleanPrice;
    const cleanOfferEnds = (offer_ends_at && String(offer_ends_at).trim()) ? String(offer_ends_at).trim() : null;
    const timerEnabled = !!(offer_timer_enabled === true || offer_timer_enabled === 'true' || offer_timer_enabled === 1 || offer_timer_enabled === '1');
    const cleanLogo = logo_url ? String(logo_url).trim() : '';
    const cleanIcon = (icon && String(icon).trim()) ? String(icon).trim() : '🤖';
    const cleanBadge = (badge && String(badge).trim()) ? String(badge).trim() : '';
    const isHighlighted = !!is_highlighted;
    const cleanDesc = description ? String(description).trim() : '';
    const cleanFeatures = Array.isArray(features) ? JSON.stringify(features) : (typeof features === 'string' ? JSON.stringify(features.split('\n').map(f => f.trim()).filter(Boolean)) : JSON.stringify([]));
    const sortOrd = parseInt(sort_order) || 0;
    const keySlug = (service_key && String(service_key).trim()) ? String(service_key).trim() : cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '_');

    await db.run(
      'INSERT INTO bot_services (name, service_key, price, actual_price, offer_ends_at, offer_timer_enabled, logo_url, icon, badge, is_highlighted, is_active, sort_order, description, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [cleanName, keySlug, cleanPrice, cleanActualPrice, cleanOfferEnds, timerEnabled, cleanLogo, cleanIcon, cleanBadge, isHighlighted, true, sortOrd, cleanDesc, cleanFeatures]
    );

    res.json({ success: true, message: 'Bot service added successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/bot-services/update', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { id, name, service_key, price, actual_price, offer_ends_at, offer_timer_enabled, logo_url, icon, badge, is_highlighted, is_active, description, features, sort_order } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing service ID.' });
    }
    const db = await getDB();
    const existing = await db.get('SELECT id FROM bot_services WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Service not found.' });
    }

    const cleanName = name ? String(name).trim() : 'Bot Service';
    const cleanPrice = (price !== undefined && price !== null) ? String(price).trim() : '$99';
    const cleanActualPrice = (actual_price !== undefined && actual_price !== null && String(actual_price).trim() !== '') ? String(actual_price).trim() : cleanPrice;
    const cleanOfferEnds = (offer_ends_at && String(offer_ends_at).trim()) ? String(offer_ends_at).trim() : null;
    const timerEnabled = !!(offer_timer_enabled === true || offer_timer_enabled === 'true' || offer_timer_enabled === 1 || offer_timer_enabled === '1');
    const cleanKey = service_key ? String(service_key).trim() : null;
    const cleanLogo = (logo_url !== undefined && logo_url !== null) ? String(logo_url).trim() : '';
    const cleanIcon = (icon && String(icon).trim()) ? String(icon).trim() : '🤖';
    const cleanBadge = (badge && String(badge).trim()) ? String(badge).trim() : '';
    const isHighlighted = (is_highlighted !== undefined) ? !!is_highlighted : false;
    const isActive = is_active !== false && is_active !== 'false' && is_active !== 0 && is_active !== '0';
    const cleanDesc = description ? String(description).trim() : '';
    const cleanFeatures = Array.isArray(features) ? JSON.stringify(features) : (typeof features === 'string' ? JSON.stringify(features.split('\n').map(f => f.trim()).filter(Boolean)) : JSON.stringify([]));
    const sortOrd = parseInt(sort_order) || 0;

    if (cleanKey) {
      await db.run(
        'UPDATE bot_services SET name = ?, service_key = ?, price = ?, actual_price = ?, offer_ends_at = ?, offer_timer_enabled = ?, logo_url = ?, icon = ?, badge = ?, is_highlighted = ?, is_active = ?, sort_order = ?, description = ?, features = ? WHERE id = ?',
        [cleanName, cleanKey, cleanPrice, cleanActualPrice, cleanOfferEnds, timerEnabled, cleanLogo, cleanIcon, cleanBadge, isHighlighted, isActive, sortOrd, cleanDesc, cleanFeatures, id]
      );
    } else {
      await db.run(
        'UPDATE bot_services SET name = ?, price = ?, actual_price = ?, offer_ends_at = ?, offer_timer_enabled = ?, logo_url = ?, icon = ?, badge = ?, is_highlighted = ?, is_active = ?, sort_order = ?, description = ?, features = ? WHERE id = ?',
        [cleanName, cleanPrice, cleanActualPrice, cleanOfferEnds, timerEnabled, cleanLogo, cleanIcon, cleanBadge, isHighlighted, isActive, sortOrd, cleanDesc, cleanFeatures, id]
      );
    }

    res.json({ success: true, message: 'Bot service updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/bot-services/delete', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing service ID.' });
    }
    const db = await getDB();
    await db.run('DELETE FROM bot_services WHERE id = ?', [id]);
    res.json({ success: true, message: 'Bot service deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- BOT PAYMENT METHODS & CHECKOUT ORDERS ---

// Public endpoint to get active payment methods for checkout
router.get('/public/bot-payment-methods', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const rows = await db.all('SELECT * FROM bot_payment_methods WHERE is_active IS NOT FALSE ORDER BY sort_order ASC, id ASC');
    const methods = (rows || []).map(r => ({
      id: r.id,
      name: r.name,
      type: r.type || 'crypto',
      address_or_number: r.address_or_number,
      account_holder: r.account_holder || '',
      network_or_bank: r.network_or_bank || '',
      instructions: r.instructions || '',
      qr_code_url: r.qr_code_url || '',
      is_active: r.is_active !== false,
      sort_order: parseInt(r.sort_order) || 0
    }));
    res.json({ success: true, methods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint to submit bot checkout order
router.post('/public/bot-checkout/submit', async (req, res) => {
  try {
    const {
      service_key,
      service_name,
      amount,
      currency,
      user_email,
      user_phone,
      payment_method_id,
      payment_method_name,
      txid,
      proof_url
    } = req.body;

    if (!user_email || !String(user_email).trim()) {
      return res.status(400).json({ error: 'Activation Email is required.' });
    }
    if (!user_phone || !String(user_phone).trim()) {
      return res.status(400).json({ error: 'Contact / WhatsApp Phone Number is required.' });
    }
    if (!txid || !String(txid).trim()) {
      return res.status(400).json({ error: 'Transaction ID / Reference Number is required.' });
    }

    const cleanEmail = String(user_email).trim().toLowerCase();
    const cleanPhone = String(user_phone).trim();
    const cleanTxid = String(txid).trim();
    const cleanServiceKey = service_key ? String(service_key).trim() : 'gxm_bot';
    const cleanServiceName = service_name ? String(service_name).trim() : 'GXM Bot';
    const cleanAmount = parseFloat(amount) || 0;
    const cleanCurrency = currency ? String(currency).trim() : 'USD';
    const cleanMethodId = parseInt(payment_method_id) || null;
    const cleanMethodName = payment_method_name ? String(payment_method_name).trim() : 'Manual';
    const cleanProof = proof_url ? String(proof_url).trim() : '';

    const db = await getDB();
    const result = await db.run(
      `INSERT INTO bot_orders (service_key, service_name, amount, currency, user_email, user_phone, payment_method_id, payment_method_name, txid, proof_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id`,
      [cleanServiceKey, cleanServiceName, cleanAmount, cleanCurrency, cleanEmail, cleanPhone, cleanMethodId, cleanMethodName, cleanTxid, cleanProof]
    );

    const orderId = result?.lastID || result?.rows?.[0]?.id || Date.now();
    res.json({
      success: true,
      message: 'Your Bot order and proof have been submitted successfully! Staff will verify and activate your key.',
      order_id: orderId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get all bot payment methods
router.get('/admin/bot-payment-methods', ...requirePermission('user_management'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const rows = await db.all('SELECT * FROM bot_payment_methods ORDER BY sort_order ASC, id ASC');
    res.json({ success: true, methods: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Add bot payment method
router.post('/admin/bot-payment-methods/add', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { name, type, address_or_number, account_holder, network_or_bank, instructions, qr_code_url, is_active, sort_order } = req.body;
    if (!name || String(name).trim() === '') {
      return res.status(400).json({ error: 'Method name is required.' });
    }
    if (!address_or_number || String(address_or_number).trim() === '') {
      return res.status(400).json({ error: 'Wallet address or account number is required.' });
    }

    const cleanName = String(name).trim();
    const cleanType = type ? String(type).trim() : 'crypto';
    const cleanAddr = String(address_or_number).trim();
    const cleanHolder = account_holder ? String(account_holder).trim() : '';
    const cleanNet = network_or_bank ? String(network_or_bank).trim() : '';
    const cleanInst = instructions ? String(instructions).trim() : '';
    const cleanQr = qr_code_url ? String(qr_code_url).trim() : '';
    const isActive = is_active !== false && is_active !== 'false' && is_active !== 0 && is_active !== '0';
    const sortOrd = parseInt(sort_order) || 0;

    const db = await getDB();
    await db.run(
      `INSERT INTO bot_payment_methods (name, type, address_or_number, account_holder, network_or_bank, instructions, qr_code_url, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanName, cleanType, cleanAddr, cleanHolder, cleanNet, cleanInst, cleanQr, isActive, sortOrd]
    );

    res.json({ success: true, message: 'Payment method created successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update bot payment method
router.post('/admin/bot-payment-methods/update', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { id, name, type, address_or_number, account_holder, network_or_bank, instructions, qr_code_url, is_active, sort_order } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing payment method ID.' });
    }
    const db = await getDB();
    const existing = await db.get('SELECT id FROM bot_payment_methods WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Payment method not found.' });
    }

    const cleanName = name ? String(name).trim() : 'Payment Method';
    const cleanType = type ? String(type).trim() : 'crypto';
    const cleanAddr = address_or_number ? String(address_or_number).trim() : '';
    const cleanHolder = account_holder ? String(account_holder).trim() : '';
    const cleanNet = network_or_bank ? String(network_or_bank).trim() : '';
    const cleanInst = instructions ? String(instructions).trim() : '';
    const cleanQr = qr_code_url !== undefined ? String(qr_code_url).trim() : '';
    const isActive = (is_active !== undefined) ? (is_active !== false && is_active !== 'false' && is_active !== 0 && is_active !== '0') : true;
    const sortOrd = parseInt(sort_order) || 0;

    await db.run(
      `UPDATE bot_payment_methods SET name = ?, type = ?, address_or_number = ?, account_holder = ?, network_or_bank = ?, instructions = ?, qr_code_url = ?, is_active = ?, sort_order = ? WHERE id = ?`,
      [cleanName, cleanType, cleanAddr, cleanHolder, cleanNet, cleanInst, cleanQr, isActive, sortOrd, id]
    );

    res.json({ success: true, message: 'Payment method updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Delete bot payment method
router.post('/admin/bot-payment-methods/delete', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing payment method ID.' });
    }
    const db = await getDB();
    await db.run('DELETE FROM bot_payment_methods WHERE id = ?', [id]);
    res.json({ success: true, message: 'Payment method deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get all bot purchase orders
router.get('/admin/bot-orders', ...requirePermission('user_management'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const rows = await db.all('SELECT * FROM bot_orders ORDER BY created_at DESC');
    res.json({ success: true, orders: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Review bot order (Approve & Generate Key / Reject)
router.post('/admin/bot-orders/review', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { order_id, action, admin_notes, key_code } = req.body;
    if (!order_id) {
      return res.status(400).json({ error: 'Missing order ID.' });
    }
    const db = await getDB();
    const order = await db.get('SELECT * FROM bot_orders WHERE id = ? LIMIT 1', [order_id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const now = new Date().toISOString();
    const notes = admin_notes ? String(admin_notes).trim() : '';

    if (action === 'approve') {
      let finalKey = key_code ? String(key_code).trim() : generateRandomAiKey();
      
      // Ensure key uniqueness in aibot_keys
      let duplicate = true;
      while (duplicate) {
        const existingKey = await db.get('SELECT id FROM aibot_keys WHERE key_code = ? LIMIT 1', [finalKey]);
        if (!existingKey) {
          duplicate = false;
        } else {
          finalKey = generateRandomAiKey();
        }
      }

      // Create activation key in aibot_keys
      await db.run(
        'INSERT INTO aibot_keys (key_code, is_used, bot_timer, investment_pct, daily_limit, trade_sequence, demo_sequence_type, notes) VALUES (?, FALSE, 60, 10, 100, NULL, ?, ?)',
        [finalKey, 'random', `Auto-generated for Order #${order.id} (${order.user_email})`]
      );

      // Update bot order status
      await db.run(
        'UPDATE bot_orders SET status = ?, assigned_key = ?, admin_notes = ?, reviewed_at = ? WHERE id = ?',
        ['approved', finalKey, notes, now, order_id]
      );

      res.json({ success: true, message: `Order approved! Key ${finalKey} generated and assigned.`, key: finalKey });
    } else {
      // Reject order
      await db.run(
        'UPDATE bot_orders SET status = ?, admin_notes = ?, reviewed_at = ? WHERE id = ?',
        ['rejected', notes, now, order_id]
      );

      res.json({ success: true, message: 'Order marked as rejected.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- BOT SUPPORT TICKETS MANAGEMENT ---

router.post('/public/bot-contact/submit', async (req, res) => {
  try {
    const { name, email, category, phone, subject, message } = req.body;
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'Name, email, subject, and message are required.' });
    }
    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanCategory = category ? String(category).trim() : 'general';
    const cleanPhone = phone ? String(phone).trim() : '';
    const cleanSubject = String(subject).trim();
    const cleanMessage = String(message).trim();

    const db = await getDB();
    await db.run(
      'INSERT INTO bot_support_tickets (name, email, category, phone, subject, message, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [cleanName, cleanEmail, cleanCategory, cleanPhone, cleanSubject, cleanMessage, 'pending']
    );

    res.json({ success: true, message: 'Support ticket submitted successfully. Our quant team will respond shortly.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/bot-tickets', ...requirePermission('user_management'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const tickets = await db.all('SELECT * FROM bot_support_tickets ORDER BY id DESC');
    res.json({ success: true, tickets: tickets || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/bot-tickets/status', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { id, status, admin_notes } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing ticket ID.' });
    }
    const db = await getDB();
    const existing = await db.get('SELECT id FROM bot_support_tickets WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    const cleanStatus = status ? String(status).trim().toLowerCase() : 'pending';
    const cleanNotes = admin_notes !== undefined ? String(admin_notes).trim() : null;

    if (cleanNotes !== null) {
      await db.run(
        'UPDATE bot_support_tickets SET status = ?, admin_notes = ? WHERE id = ?',
        [cleanStatus, cleanNotes, id]
      );
    } else {
      await db.run(
        'UPDATE bot_support_tickets SET status = ? WHERE id = ?',
        [cleanStatus, id]
      );
    }

    res.json({ success: true, message: `Ticket status updated to ${cleanStatus}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/bot-tickets/delete', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing ticket ID.' });
    }
    const db = await getDB();
    await db.run('DELETE FROM bot_support_tickets WHERE id = ?', [id]);
    res.json({ success: true, message: 'Ticket deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUBLIC BOT API (Trading Boy Bot — no JWT auth required) ---

// Verify Gain EX account email exists — Step 1 of Trading Boy Bot login
router.post('/public/bot/verify-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const cleanEmail = email.trim();
    const db = await getDB();

    const user = await db.get(
      'SELECT id, username, email, status, balance FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1',
      [cleanEmail]
    );

    if (!user) {
      return res.status(400).json({ error: 'No account found with that email.' });
    }

    if (user.status === 'frozen' || user.status === 'blocked') {
      return res.status(400).json({ error: 'Your account status is inactive. Please contact support.' });
    }

    return res.json({ success: true, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Link account and activate key — Step 2 of Trading Boy Bot login
router.post('/public/bot/link-account', async (req, res) => {
  try {
    const { email, key } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email address is required.' });
    }
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Please enter your activation key.' });
    }

    const cleanEmail = email.trim();
    const cleanKey = key.trim();
    const db = await getDB();

    // 1. Check key details & custom error first
    const cleanKeyRaw = cleanKey.replace(/-/g, '').toUpperCase();
    const keyRow = await db.get(
      `SELECT id, key_code, is_used, used_by_user_id, min_balance, is_revoked, is_enabled, custom_error_enabled, custom_error_message 
       FROM aibot_keys 
       WHERE UPPER(TRIM(key_code)) = UPPER(TRIM(?)) OR UPPER(REPLACE(key_code, '-', '')) = ? 
       LIMIT 1`,
      [cleanKey, cleanKeyRaw]
    );

    if (!keyRow) {
      return res.status(400).json({ error: 'Invalid activation key. Please contact support.' });
    }

    const errorEnabled = (keyRow.custom_error_enabled === true || keyRow.custom_error_enabled === 1 || keyRow.custom_error_enabled === 'true' || keyRow.custom_error_enabled === '1');
    if (errorEnabled) {
      const errMsg = keyRow.custom_error_message && keyRow.custom_error_message.trim() !== ''
        ? keyRow.custom_error_message.trim()
        : 'Invalid activation key. Please contact support.';
      return res.status(400).json({ error: errMsg });
    }

    if (keyRow.is_revoked === true || keyRow.is_revoked === 1 || keyRow.is_revoked === 'true' || keyRow.is_revoked === '1' || keyRow.is_enabled === false || keyRow.is_enabled === 0 || keyRow.is_enabled === 'false' || keyRow.is_enabled === '0') {
      return res.status(400).json({ error: 'This activation key is blocked or revoked. Please contact support.' });
    }

    // 2. Check user exists
    const user = await db.get(
      'SELECT id, username, email, status, balance, currency FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1',
      [cleanEmail]
    );

    if (!user) {
      return res.status(400).json({ error: 'No account found with that email.' });
    }

    if (user.status === 'frozen' || user.status === 'blocked') {
      return res.status(400).json({ error: 'Your account status is inactive. Please contact support.' });
    }

    // Resolve effective minimum balance (runs for ALL link attempts — new and re-link)
    // Key-specific min_balance overrides the global setting; null = use global
    let effectiveMinBal;
    if (keyRow.min_balance !== null && keyRow.min_balance !== undefined && !isNaN(parseFloat(keyRow.min_balance))) {
      effectiveMinBal = parseFloat(keyRow.min_balance);
    } else {
      const minBalRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_min_balance'");
      effectiveMinBal = parseFloat(minBalRow ? minBalRow.value : 0) || 200;
    }
    console.log(`[BOT-LINK-ACCOUNT] User ${user.email} (ID: ${user.id}, Balance: ${user.balance}) trying to link key ${cleanKey} (Key Min: ${keyRow.min_balance}, Resolved Min: ${effectiveMinBal})`);

    if (parseFloat(user.balance || 0) < effectiveMinBal) {
      console.log(`[BOT-LINK-ACCOUNT] BLOCKED: Balance $${user.balance} < Min $${effectiveMinBal}`);
      return res.status(400).json({ error: `Your balance is less than $${effectiveMinBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Bot requires a minimum balance of $${effectiveMinBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} to activate.` });
    }

    const isUsed = (keyRow.is_used === true || keyRow.is_used === 1 || keyRow.is_used === 'true' || keyRow.is_used === '1');

    if (isUsed) {
      // If already used, verify ownership
      if (Number(keyRow.used_by_user_id) !== Number(user.id)) {
        return res.status(400).json({ error: 'This activation key has already been used by another account.' });
      }
    } else {
      // If unused, check if user already has an active key on their account
      const activeKey = await db.get(
        'SELECT id, key_code FROM aibot_keys WHERE used_by_user_id = ? AND is_used = true LIMIT 1',
        [user.id]
      );
      if (activeKey) {
        return res.status(400).json({ error: `You already have an active key on your account: ${activeKey.key_code}. Please log in with that key.` });
      }

      // Activate the unused key for this user
      const now = new Date().toISOString();
      await db.run(
        'UPDATE aibot_keys SET is_used = true, used_by_user_id = ?, activated_at = ? WHERE id = ?',
        [user.id, now, keyRow.id]
      );
      console.log(`Activated unused key ${cleanKey} directly via Trading Boy Bot for user: ${user.email}`);
    }

    // 3. Check duplicate active bot session
    const activeSession = await db.get(
      'SELECT id, key_code FROM aibot_keys WHERE bot_linked_email = ? AND bot_session_active = true LIMIT 1',
      [user.email]
    );

    if (activeSession && activeSession.id !== keyRow.id) {
      return res.status(400).json({ error: 'This email user account is already in use by another active bot session.' });
    }

    // 4. Generate unique session token
    const crypto = require('crypto');
    const sessionToken = 'TBB-SES-' + crypto.randomBytes(8).toString('hex').toUpperCase();

    // Link the session
    await db.run(
      'UPDATE aibot_keys SET bot_linked_email = ?, bot_session_token = ?, bot_session_active = true WHERE id = ?',
      [user.email, sessionToken, keyRow.id]
    );

    const stats = await db.get(
      `SELECT 
         COUNT(*) as total,
         SUM(CASE WHEN status = 'win' THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN status = 'loss' OR status = 'lose' THEN 1 ELSE 0 END) as losses,
         SUM(CASE 
           WHEN status = 'win' THEN COALESCE(amount_usd, amount, 0) * (COALESCE(commission_pct, 0) / 100.0)
           WHEN status = 'lose' OR status = 'loss' THEN -COALESCE(amount_usd, amount, 0)
           ELSE 0
         END) as profit
       FROM trades 
       WHERE user_id = ? AND is_bot = 1`,
      [user.id]
    );

    return res.json({
      success: true,
      session_token: sessionToken,
      username: user.username,
      balance: user.balance,
      currency: user.currency,
      wins: parseInt(stats ? stats.wins : 0) || 0,
      losses: parseInt(stats ? stats.losses : 0) || 0,
      tradesCount: parseInt(stats ? stats.total : 0) || 0,
      profit: parseFloat(stats ? stats.profit : 0) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unlink a bot session
router.post('/public/bot/unlink-account', async (req, res) => {
  try {
    const { session_token } = req.body;
    if (!session_token || typeof session_token !== 'string') {
      return res.status(400).json({ error: 'Missing session token.' });
    }
    const db = await getDB();
    
    await db.run(
      'UPDATE aibot_keys SET bot_session_active = false, bot_session_token = NULL, bot_linked_email = NULL WHERE bot_session_token = ?',
      [session_token]
    );

    return res.json({ success: true, message: 'Successfully logged out and unlinked.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch current balance for a bot session
router.get('/public/bot/balance', async (req, res) => {
  try {
    const sessionToken = req.query.session_token;
    if (!sessionToken) {
      return res.status(400).json({ error: 'Missing session token.' });
    }
    const db = await getDB();

    const session = await db.get(
      'SELECT k.used_by_user_id, k.min_balance FROM aibot_keys k WHERE k.bot_session_token = ? AND k.bot_session_active = true LIMIT 1',
      [sessionToken]
    );

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired bot session.' });
    }

    const user = await db.get('SELECT id, username, email, balance, currency FROM users WHERE id = ? LIMIT 1', [session.used_by_user_id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Enforce minimum balance on every balance poll — covers localStorage-restored sessions
    let effectiveMinBal;
    if (session.min_balance !== null && session.min_balance !== undefined && !isNaN(parseFloat(session.min_balance))) {
      effectiveMinBal = parseFloat(session.min_balance);
    } else {
      const minBalRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_min_balance'");
      effectiveMinBal = parseFloat(minBalRow ? minBalRow.value : 0) || 200;
    }

    if (parseFloat(user.balance || 0) < effectiveMinBal) {
      // Return 401 but DO NOT terminate the bot session in DB (keep strong connection alive)
      return res.status(401).json({
        error: `Your balance ($${parseFloat(user.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) is below the required minimum of $${effectiveMinBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} to use the AI Trading Bot.`,
        insufficient_balance: true
      });
    }

    const stats = await db.get(
      `SELECT 
         COUNT(*) as total,
         SUM(CASE WHEN status = 'win' THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN status = 'loss' OR status = 'lose' THEN 1 ELSE 0 END) as losses,
         SUM(CASE 
           WHEN status = 'win' THEN COALESCE(amount_usd, amount, 0) * (COALESCE(commission_pct, 0) / 100.0)
           WHEN status = 'lose' OR status = 'loss' THEN -COALESCE(amount_usd, amount, 0)
           ELSE 0
         END) as profit
       FROM trades 
       WHERE user_id = ? AND is_bot = 1`,
      [session.used_by_user_id]
    );

    return res.json({
      success: true,
      username: user.username,
      email: user.email,
      balance: user.balance,
      currency: user.currency,
      wins: parseInt(stats ? stats.wins : 0) || 0,
      losses: parseInt(stats ? stats.losses : 0) || 0,
      tradesCount: parseInt(stats ? stats.total : 0) || 0,
      profit: parseFloat(stats ? stats.profit : 0) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Place a trade via the bot session (real trading ONLY)
router.post('/public/bot/place-trade', async (req, res) => {
  try {
    const { session_token, coin, direction, amount, duration, payout_pct, bot_outcome } = req.body;
    if (!session_token) {
      return res.status(400).json({ error: 'Missing session token.' });
    }
    const db = await getDB();

    // Validate bot session
    const session = await db.get(
      `SELECT k.used_by_user_id, k.bot_linked_email, k.bot_timer, k.investment_pct, k.daily_limit,
              u.status, u.balance, u.demo_balance, u.kyc_status, u.currency, u.slippage_delay_ms, u.slippage_pct, u.trade_win_chance, u.force_next_trade, u.initial_balance, u.auto_loss_balance, u.auto_loss_pct
       FROM aibot_keys k 
       JOIN users u ON k.used_by_user_id = u.id 
       WHERE k.bot_session_token = ? AND k.bot_session_active = true 
       LIMIT 1`,
      [session_token]
    );

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired bot session.' });
    }

    if (session.status === 'frozen') {
      return res.status(403).json({ error: 'Your account is frozen. Trading is disabled.' });
    }

    const isDemo = req.body.account_type === 'demo' || req.body.is_demo === 1 || req.body.is_demo === true ? 1 : 0;

    const startOfDay = new Date();
    startOfDay.setUTCHours(0,0,0,0);
    const startOfDayStr = startOfDay.toISOString();

    const dailyCount = await db.get(
      'SELECT COUNT(*) as count FROM trades WHERE user_id = ? AND is_bot = 1 AND created_at >= ?',
      [session.used_by_user_id, startOfDayStr]
    );
    const count = parseInt(dailyCount ? dailyCount.count : 0);
    
    let limit = parseInt(session.daily_limit || 100);
    if (isDemo) {
      const demoSeqType = session.demo_sequence_type || 'random';
      if (demoSeqType === 'random') {
        const currentDemoBalance = session.demo_balance ?? 10000.0;
        const tempSeq = generateRandomDemoSequence(currentDemoBalance);
        limit = tempSeq.length;
      } else if (session.demo_trade_sequence) {
        try {
          const tempSeq = JSON.parse(session.demo_trade_sequence);
          if (Array.isArray(tempSeq)) {
            limit = tempSeq.length;
          }
        } catch (e) {}
      }
    }

    if (count >= limit) {
      return res.status(400).json({ error: `Daily bot trade limit reached (${limit}/${limit}).` });
    }

    let parsedDuration = parseInt(duration);
    if ((!parsedDuration || isNaN(parsedDuration) || parsedDuration <= 0) && session.bot_timer && session.bot_timer > 0) {
      parsedDuration = session.bot_timer;
    }
    if (isDemo) {
      if (isNaN(parsedDuration) || parsedDuration <= 0) {
        parsedDuration = 10 + Math.floor(Math.random() * 21);
      } else {
        parsedDuration = Math.max(10, Math.min(30, parsedDuration));
      }
    }

    let parsedAmount = parseFloat(amount);
    if ((!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) && session.investment_pct && session.investment_pct > 0) {
      const bal = isDemo ? (session.demo_balance ?? 10000.0) : session.balance;
      parsedAmount = parseFloat((bal * (session.investment_pct / 100)).toFixed(2));
    }

    // Enforce KYC check for real trades
    if (!isDemo && session.kyc_status !== 'verified') {
      return res.status(400).json({ error: 'KYC identity verification is required to trade on your Real account.' });
    }

    // 1. Entry Latency Injection
    const latencyMs = parseInt(session.slippage_delay_ms || 0);
    if (latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, latencyMs));
    }

    if (!coin || !direction || isNaN(parsedAmount) || isNaN(parsedDuration)) {
      return res.status(400).json({ error: 'Coin, direction, amount, and duration/expiry are required.' });
    }

    if (parsedDuration < 10) {
      return res.status(400).json({ error: 'Minimum trade duration is 10 seconds.' });
    }

    if (parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid trade amount.' });
    }

    // Minimum trade stake check: $1 USD equivalent
    const DEFAULT_CURRENCY_RATES = {
      USD: 1.0,
      PKR: 278.0,
      INR: 84.0,
      BDT: 117.0,
      NPR: 133.0,
      NRP: 133.0,
      EUR: 0.92,
      GBP: 0.78,
      AED: 3.67,
      SAR: 3.75,
      TRY: 32.5,
      NGN: 1500.0,
      IDR: 16000.0,
      BRL: 5.4,
      EGP: 48.0,
      MYR: 4.7,
      KZT: 475.0,
      THB: 36.0,
      UAH: 41.0,
      VND: 25400.0,
      MXN: 18.0,
      JPY: 160.0,
      PHP: 58.0,
      KRW: 1380.0
    };

    const userCurrency = (session.currency || 'USD').toUpperCase().trim();
    let exchangeRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
    if (userCurrency !== 'USD') {
      const rateRow = await db.get("SELECT value FROM settings WHERE key = ?", [`currency_rate_${userCurrency}`]);
      if (rateRow && rateRow.value) {
        const parsedRate = parseFloat(rateRow.value);
        if (!isNaN(parsedRate) && parsedRate > 0) {
          exchangeRate = parsedRate;
        }
      }
    }

    const amountInUsd = parsedAmount / exchangeRate;
    if (amountInUsd < 0.999) {
      const minAmountFormatted = Math.ceil(1.0 * exchangeRate).toLocaleString('en-US');
      if (userCurrency === 'USD') {
        return res.status(400).json({ error: 'Minimum trade stake is $1.00 USD.' });
      } else {
        return res.status(400).json({ error: `Minimum trade stake is $1.00 USD (${minAmountFormatted} ${userCurrency}).` });
      }
    }

    if (amountInUsd > 3000.001) {
      const maxAmountFormatted = Math.floor(3000.0 * exchangeRate).toLocaleString('en-US');
      if (userCurrency === 'USD') {
        return res.status(400).json({ error: 'Maximum trade stake is $3,000.00 USD.' });
      } else {
        return res.status(400).json({ error: `Maximum trade stake is $3,000.00 USD (${maxAmountFormatted} ${userCurrency}).` });
      }
    }

    // Determine effective commission_pct = the ASSET's current payout % from DB settings.
    let effectiveCommissionPct = null;
    const coinUpper = coin.toUpperCase();
    try {
      const assetPayoutRow = await db.get("SELECT value FROM settings WHERE key = 'asset_payout_settings'");
      if (assetPayoutRow) {
        const payoutSettings = JSON.parse(assetPayoutRow.value);
        const coinKey = coinUpper;
        const assetData = payoutSettings[coinKey]
          || payoutSettings[`${coinKey}/USDT`]
          || payoutSettings[coinKey.replace('/USDT', '')]
          || payoutSettings[coinKey.split('/')[0]];
        if (assetData && typeof assetData.current === 'number') {
          effectiveCommissionPct = assetData.current;
        }
      }
    } catch (e) { }

    if (effectiveCommissionPct === null) {
      const parsedPayoutPct = parseFloat(payout_pct);
      if (!isNaN(parsedPayoutPct) && parsedPayoutPct > 0 && parsedPayoutPct <= 500) {
        effectiveCommissionPct = parsedPayoutPct;
      }
    }

    if (effectiveCommissionPct === null) {
      let option = await db.get('SELECT commission_pct FROM trade_options WHERE duration = ?', [parsedDuration]);
      if (!option) {
        option = await db.get('SELECT commission_pct FROM trade_options ORDER BY ABS(duration - ?) ASC LIMIT 1', [parsedDuration]);
      }
      effectiveCommissionPct = option ? option.commission_pct : 80.0;
    }

    // Check if coin is visible in either crypto or forex or is an enabled OTC pair
    const visibleCoinsRow = await db.get("SELECT value FROM settings WHERE key = 'crypto_visible_coins'");
    const visibleCoins = visibleCoinsRow ? JSON.parse(visibleCoinsRow.value) : [];
    const visibleForexRow = await db.get("SELECT value FROM settings WHERE key = 'forex_visible_pairs'");
    const visibleForex = visibleForexRow ? JSON.parse(visibleForexRow.value) : [];
    
    let isOtcEnabled = false;
    if (coinUpper.includes('OTC')) {
      const otcRow = await db.get("SELECT enabled, visible FROM otc_pairs WHERE symbol = ?", [coinUpper]);
      if (otcRow && otcRow.enabled === 1 && otcRow.visible === 1) {
        isOtcEnabled = true;
      }
    }

    if (!isOtcEnabled && !visibleCoins.includes(coinUpper) && !visibleForex.includes(coinUpper)) {
      return res.status(400).json({ error: 'Trading is not enabled for this coin.' });
    }

    // Balance checks
    const currentBal = isDemo ? (session.demo_balance ?? 10000.0) : session.balance;
    if (currentBal < parsedAmount) {
      return res.status(400).json({ error: 'Insufficient funds to execute trade.' });
    }

    // Fetch live opening price BEFORE starting transaction to prevent SQLite lock contention
    let openPrice;
    if (coinUpper.includes('OTC')) {
      const otcEngine = require('./services/otcEngine');
      openPrice = otcEngine.getPrice(coin);
      if (openPrice === null) {
        return res.status(400).json({ error: 'Trading is currently paused for this OTC pair.' });
      }
    } else if (isForexPair(coin)) {
      const candles = getForexCandles(cleanSymbol(coin), '1m');
      const last = candles[candles.length - 1];
      openPrice = last ? last.close : (FOREX_BASE_PRICES[cleanSymbol(coin)] || 1.0);
    } else {
      openPrice = await getLivePrice(getCoinBaseSymbol(coin));
    }

    // Slippage Injection
    const slippagePct = parseFloat(session.slippage_pct || 0);
    if (slippagePct > 0) {
      if (direction.toUpperCase() === 'UP') {
        openPrice = openPrice * (1 + slippagePct / 100.0);
      } else if (direction.toUpperCase() === 'DOWN') {
        openPrice = openPrice * (1 - slippagePct / 100.0);
      }
    }

    await db.run('BEGIN TRANSACTION');

    // Re-read user fields needed for admin control from the DB
    const currentUser = await db.get(
      'SELECT force_next_trade, trade_win_chance, balance, initial_balance, auto_loss_balance, auto_loss_pct, demo_force_next_trade, demo_trade_win_chance, demo_balance, demo_initial_balance, demo_auto_loss_balance, demo_auto_loss_pct FROM users WHERE id = ?',
      [session.used_by_user_id]
    );

    let adminControl = 'none';
    if (bot_outcome && (bot_outcome === 'win' || bot_outcome === 'lose')) {
      adminControl = bot_outcome;
    } else if (isDemo) {
      if (currentUser && (currentUser.demo_force_next_trade === 'win' || currentUser.demo_force_next_trade === 'lose')) {
        adminControl = currentUser.demo_force_next_trade;
        // Reset force_next_trade for next trades
        await db.run("UPDATE users SET demo_force_next_trade = 'none' WHERE id = ?", [session.used_by_user_id]);
      } else if (currentUser && currentUser.demo_trade_win_chance !== null && currentUser.demo_trade_win_chance !== undefined) {
        const roll = Math.random() * 100;
        adminControl = roll < currentUser.demo_trade_win_chance ? 'win' : 'lose';
      }
    } else {
      if (currentUser && (currentUser.force_next_trade === 'win' || currentUser.force_next_trade === 'lose')) {
        adminControl = currentUser.force_next_trade;
        // Reset force_next_trade for next trades
        await db.run("UPDATE users SET force_next_trade = 'none' WHERE id = ?", [session.used_by_user_id]);
      } else if (currentUser && currentUser.trade_win_chance !== null && currentUser.trade_win_chance !== undefined) {
        const roll = Math.random() * 100;
        adminControl = roll < currentUser.trade_win_chance ? 'win' : 'lose';
      }
    }

    // Dynamic auto-loss override
    if (currentUser) {
      let forceAutoLoss = false;
      if (isDemo) {
        if (currentUser.demo_auto_loss_balance !== null && currentUser.demo_auto_loss_balance > 0) {
          if (parseFloat(currentUser.demo_balance ?? 10000.0) >= parseFloat(currentUser.demo_auto_loss_balance)) {
            forceAutoLoss = true;
          }
        }
        if (currentUser.demo_auto_loss_pct !== null && currentUser.demo_auto_loss_pct > 0 && currentUser.demo_initial_balance > 0) {
          const profit = parseFloat(currentUser.demo_balance ?? 10000.0) - parseFloat(currentUser.demo_initial_balance);
          const profitPct = (profit / parseFloat(currentUser.demo_initial_balance)) * 100;
          if (profitPct >= parseFloat(currentUser.demo_auto_loss_pct)) {
            forceAutoLoss = true;
          }
        }
      } else {
        if (currentUser.auto_loss_balance !== null && currentUser.auto_loss_balance > 0) {
          if (parseFloat(currentUser.balance) >= parseFloat(currentUser.auto_loss_balance)) {
            forceAutoLoss = true;
          }
        }
        if (currentUser.auto_loss_pct !== null && currentUser.auto_loss_pct > 0 && currentUser.initial_balance > 0) {
          const profit = parseFloat(currentUser.balance) - parseFloat(currentUser.initial_balance);
          const profitPct = (profit / parseFloat(currentUser.initial_balance)) * 100;
          if (profitPct >= parseFloat(currentUser.auto_loss_pct)) {
            forceAutoLoss = true;
          }
        }
      }
      if (forceAutoLoss) {
        adminControl = 'lose';
      }
    }

    const syncedNow = await getDbSyncedNow(db);
    const expiresAt = new Date(syncedNow + parsedDuration * 1000).toISOString();

    // Deduct balance atomically
    let newBalance;
    if (isDemo) {
      const updatedDemo = await db.get(
        'UPDATE users SET demo_balance = COALESCE(demo_balance, 10000.0) - ? WHERE id = ? AND COALESCE(demo_balance, 10000.0) >= ? RETURNING demo_balance',
        [parsedAmount, session.used_by_user_id, parsedAmount]
      );
      if (!updatedDemo) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient demo funds to execute trade.' });
      }
      newBalance = updatedDemo.demo_balance;
    } else {
      const updatedReal = await db.get(
        'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ? RETURNING balance',
        [parsedAmount, session.used_by_user_id, parsedAmount]
      );
      if (!updatedReal) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient funds to execute trade.' });
      }
      newBalance = updatedReal.balance;
    }

    // Create Trade Record
    const tResult = await db.run(
      `INSERT INTO trades (user_id, coin, direction, amount, duration, commission_pct, open_price, status, admin_control, expires_at, is_demo, amount_usd, currency, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1)`,
      [session.used_by_user_id, coin.toUpperCase(), direction.toUpperCase(), parsedAmount, parsedDuration, effectiveCommissionPct, openPrice, adminControl, expiresAt, isDemo, amountInUsd, userCurrency]
    );

    // Log to ledger only for real trades
    if (!isDemo) {
      await db.run(
        `INSERT INTO ledger (user_id, type, amount, description, balance_after)
         VALUES (?, 'trade_lose', ?, ?, ?)`,
        [session.used_by_user_id, -parsedAmount, `Placed ${direction} trade on ${coin.toUpperCase()} (#${tResult.lastID}) via Bot`, newBalance]
      );
    }

    await db.run('COMMIT');
    clearActiveTradeCache(session.used_by_user_id);

    if (!isDemo) {
      // Run Daily milestones
      checkAndApplyMilestoneBonuses(db, session.used_by_user_id).catch(err => {
        console.error('Error in daily milestone check via Bot:', err.message);
      });
    }

    return res.json({
      success: true,
      message: 'Trade placed successfully.',
      trade_id: tResult.lastID,
      open_price: openPrice,
      expires_at: expiresAt,
      payout_pct: effectiveCommissionPct,
      balance: newBalance
    });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: 'Failed to place trade: ' + err.message });
  }
});

// Fetch outcome of a specific trade
router.get('/public/bot/trade-result/:trade_id', async (req, res) => {
  try {
    const tradeId = req.params.trade_id;
    const sessionToken = req.query.session_token;
    if (!sessionToken) {
      return res.status(400).json({ error: 'Missing session token.' });
    }
    const db = await getDB();

    // Verify session
    const session = await db.get(
      'SELECT used_by_user_id FROM aibot_keys WHERE bot_session_token = ? AND bot_session_active = true LIMIT 1',
      [sessionToken]
    );
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired bot session.' });
    }

    const trade = await db.get(
      'SELECT id, user_id, status, coin, direction, amount, open_price, close_price, commission_pct FROM trades WHERE id = ? AND user_id = ? LIMIT 1',
      [tradeId, session.used_by_user_id]
    );

    if (!trade) {
      return res.status(404).json({ error: 'Trade not found.' });
    }

    // Get current balance
    const user = await db.get('SELECT balance FROM users WHERE id = ? LIMIT 1', [session.used_by_user_id]);

    let profit = 0;
    if (trade.status === 'win') {
      profit = trade.amount * (trade.commission_pct / 100.0);
    } else if (trade.status === 'lose') {
      profit = -trade.amount;
    }

    return res.json({
      success: true,
      status: trade.status,
      coin: trade.coin,
      direction: trade.direction,
      amount: trade.amount,
      open_price: trade.open_price,
      close_price: trade.close_price,
      profit: profit,
      balance: user ? user.balance : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public live price for an asset (real price, no per-user manipulation)
router.get('/public/bot/price/:asset', async (req, res) => {
  try {
    const asset = decodeURIComponent(req.params.asset);
    let price;
    if (isForexPair(asset)) {
      const candles = getForexCandles(cleanSymbol(asset), '1m');
      const last = candles[candles.length - 1];
      price = last ? last.close : (FOREX_BASE_PRICES[cleanSymbol(asset)] || 1.0);
    } else {
      const coin = getCoinBaseSymbol(asset);
      price = await getLivePrice(coin);
    }
    return res.json({ asset, price: Number(price) || 0 });
  } catch (err) {
    res.status(500).json({ asset: req.params.asset, price: 0 });
  }
});

// Public candles for an asset (real candles, no per-user manipulation)
router.get('/public/bot/candles/:asset', async (req, res) => {
  try {
    const asset = decodeURIComponent(req.params.asset);
    const timeframe = req.query.timeframe || '1m';
    const interval = mapTimeframeToBinance(timeframe);

    if (isForexPair(asset)) {
      const candles = getForexCandles(cleanSymbol(asset), timeframe);
      return res.json({ candles: candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })) });
    }

    const coin = getCoinBaseSymbol(asset);
    const symbol = `${coin}USDT`;
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      if (!resp.ok) throw new Error(`Binance ${resp.status}`);
      const data = await resp.json();
      const candles = data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
      return res.json({ candles });
    } catch {
      const candles = getForexCandles(coin, timeframe);
      return res.json({ candles: candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })) });
    }
  } catch (err) {
    res.status(500).json({ candles: [] });
  }
});

// --- LEADERBOARD CUSTOMIZATION ENDPOINTS (ADMIN TOOLS) ---

const handleGetLeaderboardCustomization = async (req, res) => {
  const db = await getDB();
  try {
    const modeRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_custom_mode'");
    const minRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_min_profit'");
    const maxRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_max_profit'");
    const autoRow = await db.get("SELECT value FROM settings WHERE key = 'leaderboard_auto_fluctuate'");

    const settings = {
      mode: modeRow ? modeRow.value : 'hybrid',
      min_profit: minRow ? parseFloat(minRow.value) : 500,
      max_profit: maxRow ? parseFloat(maxRow.value) : 25000,
      auto_fluctuate: autoRow ? autoRow.value === 'true' : true
    };

    const entries = await db.all(`
      SELECT c.*, u.username as registered_username
      FROM custom_leaderboard c
      LEFT JOIN users u ON c.user_id = u.id
      ORDER BY COALESCE(c.position, 999) ASC, c.net_profit DESC
    `);

    const registeredUsers = await db.all("SELECT id, username, full_name, kyc_country FROM users WHERE role = 'user' ORDER BY username ASC");

    res.json({ success: true, settings, entries, registeredUsers });
  } catch (err) {
    console.error('Error fetching staff leaderboard customization:', err.message);
    res.status(500).json({ error: err.message });
  }
};

const handleSaveLeaderboardSettings = async (req, res) => {
  const db = await getDB();
  const { mode, min_profit, max_profit, auto_fluctuate } = req.body;
  try {
    await db.run("INSERT INTO settings (key, value) VALUES ('leaderboard_custom_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(mode || 'hybrid')]);
    await db.run("INSERT INTO settings (key, value) VALUES ('leaderboard_min_profit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(min_profit || 500)]);
    await db.run("INSERT INTO settings (key, value) VALUES ('leaderboard_max_profit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(max_profit || 25000)]);
    await db.run("INSERT INTO settings (key, value) VALUES ('leaderboard_auto_fluctuate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(auto_fluctuate ? 'true' : 'false')]);

    res.json({ success: true, message: 'Leaderboard settings updated successfully.' });
  } catch (err) {
    console.error('Error saving leaderboard settings:', err.message);
    res.status(500).json({ error: err.message });
  }
};

const handleSaveLeaderboardEntry = async (req, res) => {
  const db = await getDB();
  const { id, user_id, username, full_name, country, net_profit, won_trades, lost_trades, position, is_active, avatar_url } = req.body;

  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Username is required for leaderboard entry.' });
  }

  try {
    const parsedUserId = user_id ? Number(user_id) : null;
    const parsedProfit = parseFloat(net_profit) || 0;
    const parsedWins = parseInt(won_trades) || 0;
    const parsedLosses = parseInt(lost_trades) || 0;
    const parsedPos = position ? parseInt(position) : null;
    const activeVal = is_active !== false && is_active !== 0 && is_active !== '0' ? 1 : 0;

    if (id) {
      await db.run(`
        UPDATE custom_leaderboard SET
          user_id = ?, username = ?, full_name = ?, country = ?, net_profit = ?,
          won_trades = ?, lost_trades = ?, position = ?, is_active = ?, avatar_url = ?
        WHERE id = ?
      `, [parsedUserId, username.trim(), full_name ? full_name.trim() : null, (country || 'US').trim().toUpperCase(), parsedProfit, parsedWins, parsedLosses, parsedPos, activeVal, avatar_url || null, id]);
    } else {
      await db.run(`
        INSERT INTO custom_leaderboard (user_id, username, full_name, country, net_profit, won_trades, lost_trades, position, is_active, avatar_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [parsedUserId, username.trim(), full_name ? full_name.trim() : null, (country || 'US').trim().toUpperCase(), parsedProfit, parsedWins, parsedLosses, parsedPos, activeVal, avatar_url || null]);
    }

    res.json({ success: true, message: id ? 'Leaderboard entry updated.' : 'Leaderboard entry added.' });
  } catch (err) {
    console.error('Error saving leaderboard entry:', err.message);
    res.status(500).json({ error: err.message });
  }
};

const handleDeleteLeaderboardEntry = async (req, res) => {
  const db = await getDB();
  const { id } = req.params;
  try {
    await db.run('DELETE FROM custom_leaderboard WHERE id = ?', [id]);
    res.json({ success: true, message: 'Leaderboard entry deleted.' });
  } catch (err) {
    console.error('Error deleting leaderboard entry:', err.message);
    res.status(500).json({ error: err.message });
  }
};

router.get('/admin/leaderboard-customization', ...requirePermission('full_access'), handleGetLeaderboardCustomization);
router.post('/admin/leaderboard-customization/settings', ...requirePermission('full_access'), handleSaveLeaderboardSettings);
router.post('/admin/leaderboard-customization/entry', ...requirePermission('full_access'), handleSaveLeaderboardEntry);
router.delete('/admin/leaderboard-customization/entry/:id', ...requirePermission('full_access'), handleDeleteLeaderboardEntry);

// --- USER MANAGEMENT ---


router.get('/admin/users', ...requirePermission('user_management'), async (req, res) => {
  const { search } = req.query;
  const db = await getDB();

  const isEmployee = req.user.role === 'employee';
  let employeeCommPct = 5.0;
  if (isEmployee) {
    const employeeId = Number(req.user.id);
    const inviteRow = await db.get('SELECT commission_pct FROM invite_codes WHERE created_by_id = ? AND commission_pct IS NOT NULL LIMIT 1', [employeeId]);
    if (inviteRow) {
      employeeCommPct = parseFloat(inviteRow.commission_pct);
    } else {
      const pctRow = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
      employeeCommPct = pctRow ? parseFloat(pctRow.value) : 5.0;
    }
  }

  let query = `
    SELECT u.id, u.username, u.email, u.phone_number, u.role, u.balance, u.demo_balance, u.status, u.kyc_status, u.real_account_active,
           u.slippage_delay_ms, u.slippage_pct, u.invite_code, u.invited_by_id, u.created_at, u.last_seen_at, u.currency,
           u.auto_loss_balance, u.auto_loss_pct, u.initial_balance, u.is_test, u.last_ip, u.last_country,
           ${isEmployee ? `
           (
             SELECT COALESCE(SUM(COALESCE(t.referrer_commission, 0.0)), 0.0)
             FROM trades t
             WHERE t.user_id = u.id
           ) as net_broker_revenue,
           ` : `
           (
             SELECT COALESCE(SUM(
               CASE 
                 WHEN t.status = 'lose' THEN COALESCE(t.amount_usd, t.amount)
                 WHEN t.status = 'win' THEN -COALESCE(t.amount_usd, t.amount) * t.commission_pct / 100.0 
                 ELSE 0 
               END
             ), 0)
             FROM trades t
             WHERE t.user_id = u.id AND (t.is_demo = 0 OR t.is_demo IS NULL)
           ) as net_broker_revenue,
           `}
           (
             SELECT COUNT(*)
             FROM trades t
             WHERE t.user_id = u.id
           ) as total_trades,
           (
             SELECT COUNT(*)
             FROM trades t
             WHERE t.user_id = u.id AND t.status = 'win'
           ) as won_trades,
           (
             SELECT COALESCE(SUM(d.amount), 0)
             FROM deposits d
             WHERE d.user_id = u.id AND d.status = 'approved'
           ) as total_deposits,
           (
             SELECT key_code
             FROM aibot_keys
             WHERE used_by_user_id = u.id AND is_used = TRUE
             LIMIT 1
           ) as aibot_key
    FROM users u
    WHERE u.role = 'user'
  `;
  let params = [];

  // Employees without see_all_users can only see users they invited
  if (req.user.role === 'employee') {
    const perm = await db.get('SELECT see_all_users, full_access FROM permissions WHERE user_id = ?', [req.user.id]);
    if (!perm || (!perm.see_all_users && !perm.full_access)) {
      query += ' AND u.invited_by_id = ?';
      params.push(req.user.id);
    }
  }

  if (search) {
    query += ' AND (u.username LIKE ? OR u.email LIKE ? OR u.phone_number LIKE ? OR CAST(u.id AS TEXT) LIKE ? OR u.invite_code LIKE ? OR u.last_ip LIKE ?)';
    const val = `%${search}%`;
    params.push(val, val, val, val, val, val);
  }
  query += ' ORDER BY u.created_at DESC';

  const list = await db.all(query, params);
  if (isEmployee) {
    list.forEach(user => {
      delete user.slippage_delay_ms;
      delete user.slippage_pct;
      delete user.auto_loss_balance;
      delete user.auto_loss_pct;
      delete user.initial_balance;
      delete user.demo_force_next_trade;
      delete user.demo_trade_win_chance;
      delete user.demo_slippage_delay_ms;
      delete user.demo_slippage_pct;
      delete user.demo_auto_loss_balance;
      delete user.demo_auto_loss_pct;
      delete user.demo_initial_balance;
    });
  }
  res.json({ users: list });
});

router.get('/admin/users/:id/details', ...requirePermission('user_management'), async (req, res) => {
  const db = await getDB();
  const userId = req.params.id;

  const user = await db.get(
    `SELECT u.id, u.username, u.email, u.phone_number, u.full_name, u.role, u.balance, u.demo_balance, u.currency, u.status, u.credit_score, u.withdraw_enabled, u.withdraw_limit, u.created_at, u.kyc_status, u.kyc_country, u.kyc_address, u.kyc_document_front, u.kyc_document_back, u.kyc_selfie, u.kyc_submitted_at, u.kyc_rejected_reason, u.real_account_active, u.trading_enabled, u.force_next_trade, u.trade_win_chance, u.slippage_delay_ms, u.slippage_pct, u.withdraw_error_message, u.auto_loss_balance, u.auto_loss_pct, u.initial_balance, u.demo_force_next_trade, u.demo_trade_win_chance, u.demo_slippage_delay_ms, u.demo_slippage_pct, u.demo_auto_loss_balance, u.demo_auto_loss_pct, u.demo_initial_balance, u.demo_trading_enabled, u.last_seen_at, u.is_test, u.last_ip, u.last_country, u.custom_total_trades, u.custom_win_rate, u.custom_net_pnl, u.demo_custom_total_trades, u.demo_custom_win_rate, u.demo_custom_net_pnl,
            (
              SELECT COALESCE(SUM(
                CASE 
                  WHEN t.status = 'lose' THEN COALESCE(t.amount_usd, t.amount)
                  WHEN t.status = 'win' THEN -COALESCE(t.amount_usd, t.amount) * t.commission_pct / 100.0 
                  ELSE 0 
                END
              ), 0)
              FROM trades t
              WHERE t.user_id = u.id AND (t.is_demo = 0 OR t.is_demo IS NULL)
            ) as net_broker_revenue
     FROM users u
     WHERE u.id = ? AND u.role = 'user'`,
    [userId]
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (req.user.role === 'employee') {
    delete user.kyc_country;
    delete user.kyc_address;
    delete user.kyc_document_front;
    delete user.kyc_document_back;
    delete user.kyc_selfie;
    delete user.kyc_submitted_at;
    delete user.kyc_rejected_reason;
    delete user.force_next_trade;
    delete user.trade_win_chance;
    delete user.slippage_delay_ms;
    delete user.slippage_pct;
    delete user.auto_loss_balance;
    delete user.auto_loss_pct;
    delete user.initial_balance;
    delete user.demo_force_next_trade;
    delete user.demo_trade_win_chance;
    delete user.demo_slippage_delay_ms;
    delete user.demo_slippage_pct;
    delete user.demo_auto_loss_balance;
    delete user.demo_auto_loss_pct;
    delete user.demo_initial_balance;
    delete user.withdraw_error_message;
  }

  const deposits = await db.all('SELECT * FROM deposits WHERE user_id = ? AND (hidden_staff = 0 OR hidden_staff IS NULL) ORDER BY created_at DESC', [userId]);
  const rawWithdrawals = await db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  const withdrawals = rawWithdrawals.map(restoreWithdrawalMethod);
  const trades = await db.all('SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  const ledger = await db.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC', [userId]);

  res.json({ user, deposits, withdrawals, trades, ledger });
});

// --- ADMIN MANAGE USER (credit score, withdrawal, password reset) ---

router.put('/admin/users/:id/manage', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { 
    credit_score, 
    withdraw_enabled, 
    withdraw_limit, 
    new_password,
    real_account_active,
    trading_enabled,
    kyc_status,
    kyc_rejected_reason,
    force_next_trade,
    trade_win_chance,
    slippage_delay_ms,
    slippage_pct,
    withdraw_error_message,
    auto_loss_balance,
    auto_loss_pct,
    username,
    full_name,
    email,
    phone_number,
    demo_force_next_trade,
    demo_trade_win_chance,
    demo_slippage_delay_ms,
    demo_slippage_pct,
    demo_auto_loss_balance,
    demo_auto_loss_pct,
    demo_trading_enabled,
    custom_total_trades,
    custom_win_rate,
    custom_net_pnl,
    demo_custom_total_trades,
    demo_custom_win_rate,
    demo_custom_net_pnl
  } = req.body;
  const db = await getDB();
  const userId = req.params.id;

  try {
    const user = await db.get('SELECT id, role, status FROM users WHERE id = ?', [userId]);
    if (!user || user.role !== 'user') {
      return res.status(404).json({ error: 'Client user not found.' });
    }

    const updates = [];
    const params = [];

    if (username !== undefined) {
      const uName = String(username).trim();
      if (!uName) {
        return res.status(400).json({ error: 'Username cannot be empty.' });
      }
      const existing = await db.get('SELECT id FROM users WHERE username = ? AND id != ?', [uName, userId]);
      if (existing) {
        return res.status(400).json({ error: 'Username is already taken.' });
      }
      updates.push('username = ?');
      params.push(uName);
    }

    if (full_name !== undefined) {
      updates.push('full_name = ?');
      params.push(String(full_name).trim() || null);
    }

    if (email !== undefined) {
      const uEmail = String(email).trim();
      if (uEmail !== '') {
        const existing = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [uEmail, userId]);
        if (existing) {
          return res.status(400).json({ error: 'Email is already taken.' });
        }
      }
      updates.push('email = ?');
      params.push(uEmail || null);
    }

    if (phone_number !== undefined) {
      const uPhone = String(phone_number).trim();
      if (uPhone !== '') {
        const existing = await db.get('SELECT id FROM users WHERE phone_number = ? AND id != ?', [uPhone, userId]);
        if (existing) {
          return res.status(400).json({ error: 'Phone number is already registered by another account.' });
        }
      }
      updates.push('phone_number = ?');
      params.push(uPhone || null);
    }

    if (req.body.kyc_country !== undefined) {
      updates.push('kyc_country = ?');
      params.push(String(req.body.kyc_country).trim() || null);
    }

    if (credit_score !== undefined) {
      const cs = parseInt(credit_score);
      if (isNaN(cs) || cs < 0 || cs > 1000) {
        return res.status(400).json({ error: 'Credit score must be 0–1000.' });
      }
      updates.push('credit_score = ?');
      params.push(cs);
    }

    if (withdraw_enabled !== undefined) {
      updates.push('withdraw_enabled = ?');
      params.push(withdraw_enabled ? 1 : 0);
    }

    if (withdraw_limit !== undefined) {
      const wl = parseFloat(withdraw_limit);
      if (isNaN(wl) || wl < 0) {
        return res.status(400).json({ error: 'Withdraw limit must be a non-negative number.' });
      }
      updates.push('withdraw_limit = ?');
      params.push(wl);
    }

    if (new_password) {
      if (new_password.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }
      const salt = await bcrypt.genSalt(10);
      const password_hash = await bcrypt.hash(new_password, salt);
      updates.push('password_hash = ?');
      params.push(password_hash);
    }

    if (real_account_active !== undefined) {
      updates.push('real_account_active = ?');
      params.push((real_account_active === true || real_account_active === 1 || real_account_active === '1') ? 1 : 0);
    }

    if (req.body.is_test !== undefined) {
      const isTestVal = (req.body.is_test === true || req.body.is_test === 1 || req.body.is_test === '1' || req.body.is_test === 'true');
      updates.push('is_test = ?');
      params.push(db.isPg ? (isTestVal ? true : false) : (isTestVal ? 1 : 0));
    }

    if (trading_enabled !== undefined) {
      const isTradingEnabled = (trading_enabled === true || trading_enabled === 1 || trading_enabled === '1');
      updates.push('trading_enabled = ?');
      params.push(isTradingEnabled ? 1 : 0);

      if (!isTradingEnabled) {
        updates.push('status = ?');
        params.push('frozen');
      } else if (user.status === 'frozen') {
        updates.push('status = ?');
        params.push('active');
      }
    }

    if (req.body.demo_trading_enabled !== undefined) {
      const isDemoTradingEnabled = (req.body.demo_trading_enabled === true || req.body.demo_trading_enabled === 1 || req.body.demo_trading_enabled === '1');
      updates.push('demo_trading_enabled = ?');
      params.push(isDemoTradingEnabled ? 1 : 0);
    }

    if (kyc_status !== undefined) {
      const validKycStatuses = ['unverified', 'pending', 'verified', 'rejected'];
      if (validKycStatuses.includes(kyc_status)) {
        updates.push('kyc_status = ?');
        params.push(kyc_status);
        if (kyc_status === 'verified') {
          if (real_account_active === undefined) {
            updates.push('real_account_active = ?');
            params.push(1);
          }
          if (trading_enabled === undefined) {
            updates.push('trading_enabled = ?');
            params.push(1);
          }
        }
      }
    }

    if (kyc_rejected_reason !== undefined) {
      updates.push('kyc_rejected_reason = ?');
      params.push(kyc_rejected_reason || null);
    }

    if (force_next_trade !== undefined) {
      const validForces = ['win', 'lose', 'none'];
      if (validForces.includes(force_next_trade)) {
        updates.push('force_next_trade = ?');
        params.push(force_next_trade);
      }
    }

    if (trade_win_chance !== undefined) {
      const twc = trade_win_chance !== null ? parseInt(trade_win_chance) : null;
      if (twc !== null && (isNaN(twc) || twc < 0 || twc > 100)) {
        return res.status(400).json({ error: 'Trade win chance override must be 0–100% or natural (disabled).' });
      }
      updates.push('trade_win_chance = ?');
      params.push(twc);
    }

    if (slippage_delay_ms !== undefined) {
      const delay = parseInt(slippage_delay_ms);
      if (isNaN(delay) || delay < 0) {
        return res.status(400).json({ error: 'Entry latency must be a non-negative integer.' });
      }
      updates.push('slippage_delay_ms = ?');
      params.push(delay);
    }

    if (slippage_pct !== undefined) {
      const slip = parseFloat(slippage_pct);
      if (isNaN(slip) || slip < 0 || slip > 100) {
        return res.status(400).json({ error: 'Execution slippage must be a non-negative percentage (0-100).' });
      }
      updates.push('slippage_pct = ?');
      params.push(slip);
    }

    if (withdraw_error_message !== undefined) {
      updates.push('withdraw_error_message = ?');
      params.push(withdraw_error_message || null);
    }

    if (auto_loss_balance !== undefined) {
      const alb = auto_loss_balance !== null ? parseFloat(auto_loss_balance) : null;
      if (alb !== null && (isNaN(alb) || alb < 0)) {
        return res.status(400).json({ error: 'Auto-loss balance must be a non-negative number or disabled.' });
      }
      updates.push('auto_loss_balance = ?');
      params.push(alb);
    }

    if (auto_loss_pct !== undefined) {
      const alp = auto_loss_pct !== null ? parseFloat(auto_loss_pct) : null;
      if (alp !== null && (isNaN(alp) || alp < 0)) {
        return res.status(400).json({ error: 'Auto-loss percentage must be a non-negative number or disabled.' });
      }
      updates.push('auto_loss_pct = ?');
      params.push(alp);

      if (alp !== null) {
        const userRow = await db.get('SELECT balance, initial_balance FROM users WHERE id = ?', [userId]);
        if (userRow && (!userRow.initial_balance || parseFloat(userRow.initial_balance) <= 0)) {
          const initBal = parseFloat(userRow.balance) || 100.0;
          await db.run('UPDATE users SET initial_balance = ? WHERE id = ?', [initBal, userId]);
        }
      }
    }

    if (demo_force_next_trade !== undefined) {
      const validForces = ['win', 'lose', 'none'];
      if (validForces.includes(demo_force_next_trade)) {
        updates.push('demo_force_next_trade = ?');
        params.push(demo_force_next_trade);
      }
    }

    if (demo_trade_win_chance !== undefined) {
      const dtwc = demo_trade_win_chance !== null ? parseInt(demo_trade_win_chance) : null;
      if (dtwc !== null && (isNaN(dtwc) || dtwc < 0 || dtwc > 100)) {
        return res.status(400).json({ error: 'Demo win chance override must be 0–100% or natural (disabled).' });
      }
      updates.push('demo_trade_win_chance = ?');
      params.push(dtwc);
    }

    if (demo_slippage_delay_ms !== undefined) {
      const delay = parseInt(demo_slippage_delay_ms);
      if (isNaN(delay) || delay < 0) {
        return res.status(400).json({ error: 'Demo entry latency must be a non-negative integer.' });
      }
      updates.push('demo_slippage_delay_ms = ?');
      params.push(delay);
    }

    if (demo_slippage_pct !== undefined) {
      const slip = parseFloat(demo_slippage_pct);
      if (isNaN(slip) || slip < 0 || slip > 100) {
        return res.status(400).json({ error: 'Demo execution slippage must be a non-negative percentage (0-100).' });
      }
      updates.push('demo_slippage_pct = ?');
      params.push(slip);
    }

    if (demo_auto_loss_balance !== undefined) {
      const dalb = demo_auto_loss_balance !== null ? parseFloat(demo_auto_loss_balance) : null;
      if (dalb !== null && (isNaN(dalb) || dalb < 0)) {
        return res.status(400).json({ error: 'Demo auto-loss balance must be a non-negative number or disabled.' });
      }
      updates.push('demo_auto_loss_balance = ?');
      params.push(dalb);
    }

    if (demo_auto_loss_pct !== undefined) {
      const dalp = demo_auto_loss_pct !== null ? parseFloat(demo_auto_loss_pct) : null;
      if (dalp !== null && (isNaN(dalp) || dalp < 0)) {
        return res.status(400).json({ error: 'Demo auto-loss percentage must be a non-negative number or disabled.' });
      }
      updates.push('demo_auto_loss_pct = ?');
      params.push(dalp);

      if (dalp !== null) {
        const userRow = await db.get('SELECT demo_balance, demo_initial_balance FROM users WHERE id = ?', [userId]);
        if (userRow && (!userRow.demo_initial_balance || parseFloat(userRow.demo_initial_balance) <= 0)) {
          const initBal = parseFloat(userRow.demo_balance) || 10000.0;
          await db.run('UPDATE users SET demo_initial_balance = ? WHERE id = ?', [initBal, userId]);
        }
      }
    }

    if (custom_total_trades !== undefined) {
      const ctt = (custom_total_trades !== null && custom_total_trades !== '') ? parseInt(custom_total_trades) : null;
      if (ctt !== null && (isNaN(ctt) || ctt < 0)) {
        return res.status(400).json({ error: 'Custom total trades must be a non-negative integer or empty.' });
      }
      updates.push('custom_total_trades = ?');
      params.push(ctt);
    }

    if (custom_win_rate !== undefined) {
      const cwr = (custom_win_rate !== null && custom_win_rate !== '') ? parseFloat(custom_win_rate) : null;
      if (cwr !== null && (isNaN(cwr) || cwr < 0 || cwr > 100)) {
        return res.status(400).json({ error: 'Custom win rate must be between 0 and 100% or empty.' });
      }
      updates.push('custom_win_rate = ?');
      params.push(cwr);
    }

    if (custom_net_pnl !== undefined) {
      const cnp = (custom_net_pnl !== null && custom_net_pnl !== '') ? parseFloat(custom_net_pnl) : null;
      if (cnp !== null && isNaN(cnp)) {
        return res.status(400).json({ error: 'Custom net P&L must be a valid number or empty.' });
      }
      updates.push('custom_net_pnl = ?');
      params.push(cnp);
    }

    if (demo_custom_total_trades !== undefined) {
      const dctt = (demo_custom_total_trades !== null && demo_custom_total_trades !== '') ? parseInt(demo_custom_total_trades) : null;
      if (dctt !== null && (isNaN(dctt) || dctt < 0)) {
        return res.status(400).json({ error: 'Demo custom total trades must be a non-negative integer or empty.' });
      }
      updates.push('demo_custom_total_trades = ?');
      params.push(dctt);
    }

    if (demo_custom_win_rate !== undefined) {
      const dcwr = (demo_custom_win_rate !== null && demo_custom_win_rate !== '') ? parseFloat(demo_custom_win_rate) : null;
      if (dcwr !== null && (isNaN(dcwr) || dcwr < 0 || dcwr > 100)) {
        return res.status(400).json({ error: 'Demo custom win rate must be between 0 and 100% or empty.' });
      }
      updates.push('demo_custom_win_rate = ?');
      params.push(dcwr);
    }

    if (demo_custom_net_pnl !== undefined) {
      const dcnp = (demo_custom_net_pnl !== null && demo_custom_net_pnl !== '') ? parseFloat(demo_custom_net_pnl) : null;
      if (dcnp !== null && isNaN(dcnp)) {
        return res.status(400).json({ error: 'Demo custom net P&L must be a valid number or empty.' });
      }
      updates.push('demo_custom_net_pnl = ?');
      params.push(dcnp);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No changes provided.' });
    }

    params.push(userId);
    await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    const updatedUser = await db.get(
      'SELECT id, username, email, phone_number, full_name, role, balance, status, credit_score, withdraw_enabled, withdraw_limit, real_account_active, trading_enabled, force_next_trade, trade_win_chance, slippage_delay_ms, slippage_pct, withdraw_error_message, auto_loss_balance, auto_loss_pct, initial_balance, demo_force_next_trade, demo_trade_win_chance, demo_slippage_delay_ms, demo_slippage_pct, demo_auto_loss_balance, demo_auto_loss_pct, demo_initial_balance, demo_trading_enabled, kyc_status, kyc_rejected_reason, is_test, custom_total_trades, custom_win_rate, custom_net_pnl, demo_custom_total_trades, demo_custom_win_rate, demo_custom_net_pnl FROM users WHERE id = ?',
      [userId]
    );

    if (new_password && updatedUser && updatedUser.email) {
      const html = `
        <p>Hello ${updatedUser.full_name || updatedUser.username || 'Trader'},</p>
        <p>Your account password has been reset by the administrator.</p>
        <p>Your new password is: <strong>${new_password}</strong></p>
        <p>Please log in and update your password immediately to secure your account.</p>
      `;
      sendSystemEmail(updatedUser.email, 'custom_email', {
        subject: 'Account Password Reset - Gain EX Market',
        html_content: html,
        username: updatedUser.username,
        full_name: updatedUser.full_name
      }).catch(err => console.error('[EMAIL ERROR] Admin password reset email:', err.message));
    }

    res.json({ success: true, message: 'User settings updated successfully.', user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user settings: ' + err.message });
  }
});

// --- ADMIN DELETE DEPOSIT/WITHDRAWAL HISTORY ---
router.delete('/admin/history/:type/:id', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { type, id } = req.params;
  if (type !== 'deposit' && type !== 'withdrawal') {
    return res.status(400).json({ error: 'Invalid history type.' });
  }
  const db = await getDB();
  try {
    if (type === 'deposit') {
      await db.run('DELETE FROM deposits WHERE id = ?', [id]);
    } else {
      await db.run('DELETE FROM withdrawals WHERE id = ?', [id]);
    }
    res.json({ success: true, message: 'Transaction history item deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete transaction: ' + err.message });
  }
});

// --- ADMIN BULK DELETE USERS ---
router.post('/admin/users/bulk-delete', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'No user IDs provided.' });
  }

  const db = await getDB();
  try {
    const placeholders = userIds.map(() => '?').join(',');
    await db.run(
      `DELETE FROM users WHERE id IN (${placeholders}) AND role = 'user'`,
      userIds
    );
    res.json({ success: true, message: `Successfully deleted ${userIds.length} users.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to perform bulk delete: ' + err.message });
  }
});

// --- ADMIN BULK MANAGE USERS ---
router.post('/admin/users/bulk-manage', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { userIds, force_next_trade, trade_win_chance, trading_enabled, withdraw_enabled } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'No user IDs provided.' });
  }

  const db = await getDB();
  try {
    const updates = [];
    const params = [];

    if (force_next_trade !== undefined) {
      updates.push('force_next_trade = ?');
      params.push(force_next_trade);
    }

    if (trade_win_chance !== undefined) {
      updates.push('trade_win_chance = ?');
      params.push(trade_win_chance);
    }

    if (trading_enabled !== undefined) {
      const isTradingEnabled = trading_enabled === true || trading_enabled === 1;
      updates.push('trading_enabled = ?');
      params.push(isTradingEnabled ? 1 : 0);

      if (!isTradingEnabled) {
        updates.push('status = ?');
        params.push('frozen');
      } else {
        updates.push("status = CASE WHEN status = 'frozen' THEN 'active' ELSE status END");
      }
    }

    if (withdraw_enabled !== undefined) {
      updates.push('withdraw_enabled = ?');
      params.push(withdraw_enabled ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No settings to change.' });
    }

    const placeholders = userIds.map(() => '?').join(',');
    const queryParams = [...params, ...userIds];

    await db.run(
      `UPDATE users SET ${updates.join(', ')} WHERE id IN (${placeholders}) AND role = 'user'`,
      queryParams
    );

    res.json({ success: true, message: `Successfully updated settings for ${userIds.length} users.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to perform bulk updates: ' + err.message });
  }
});

// --- ADMIN KYC LIST ---
router.get('/admin/kyc/list', ...requirePermission('user_management'), async (req, res) => {
  const db = await getDB();
  const { kyc_status } = req.query;
  try {
    let query = `SELECT id, username, email, kyc_status, kyc_country, kyc_address,
                        kyc_document_front, kyc_document_back, kyc_selfie,
                        kyc_submitted_at, kyc_rejected_reason
                 FROM users WHERE role = 'user'`;
    const params = [];
    if (kyc_status) {
      query += ' AND kyc_status = ?';
      params.push(kyc_status);
    } else {
      query += ` AND kyc_status IN ('pending','verified','rejected')`;
    }
    query += ' ORDER BY kyc_submitted_at DESC';
    const users = await db.all(query, params);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC list: ' + err.message });
  }
});

router.post('/admin/users/:id/kyc/approve', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const db = await getDB();
  const userId = req.params.id;

  try {
    const user = await db.get("SELECT email, username, full_name FROM users WHERE id = ? AND role = 'user'", [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await db.run(
      `UPDATE users SET 
        kyc_status = 'verified', 
        kyc_rejected_reason = NULL,
        real_account_active = 1,
        trading_enabled = 1
       WHERE id = ?`,
      [userId]
    );

    if (user.email) {
      sendSystemEmail(user.email, 'kyc_verified', {
        username: user.username,
        full_name: user.full_name || user.username
      }).catch(err => console.error('[EMAIL ERROR] KYC verified email:', err.message));
    }

    sendPushNotification(userId, 'KYC Verification Approved', 'Congratulations! Your identity verification has been approved successfully.');

    res.json({ success: true, message: 'KYC verified successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve KYC: ' + err.message });
  }
});

router.post('/admin/users/:id/kyc/reject', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'Rejection reason is required.' });
  }

  const db = await getDB();
  const userId = req.params.id;

  try {
    const user = await db.get("SELECT email, username, full_name FROM users WHERE id = ? AND role = 'user'", [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await db.run(
      `UPDATE users SET 
        kyc_status = 'rejected', 
        kyc_rejected_reason = ? 
       WHERE id = ?`,
      [reason.trim(), userId]
    );

    if (user.email) {
      sendSystemEmail(user.email, 'kyc_rejected', {
        username: user.username,
        full_name: user.full_name || user.username,
        reason: reason.trim()
      }).catch(err => console.error('[EMAIL ERROR] KYC rejected email:', err.message));
    }

    sendPushNotification(userId, 'KYC Verification Rejected', `Your identity verification was rejected. Reason: ${reason.trim()}`);

    res.json({ success: true, message: 'KYC rejected successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject KYC: ' + err.message });
  }
});

router.post('/admin/users/:id/kyc/under-review', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const db = await getDB();
  const userId = req.params.id;
  try {
    const user = await db.get("SELECT email, username, full_name, kyc_status FROM users WHERE id = ?", [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.kyc_status === 'pending') {
      if (user.email) {
        sendSystemEmail(user.email, 'kyc_under_review', {
          username: user.username,
          full_name: user.full_name || user.username
        }).catch(err => console.error('[EMAIL ERROR] KYC under-review email:', err.message));
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to put KYC under review: ' + err.message });
  }
});

router.post('/admin/users/:id/status', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { status } = req.body;
  if (!['active', 'frozen', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  const db = await getDB();
  try {
    const user = await db.get('SELECT role FROM users WHERE id = ?', [req.params.id]);
    if (!user || user.role !== 'user') {
      return res.status(400).json({ error: 'Cannot modify non-client or non-existent account.' });
    }

    await db.run('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: `Account successfully marked as: ${status}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});

router.post('/admin/users/:id/balance', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { action, amount, description } = req.body;
  if (!['add', 'subtract'].includes(action) || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Valid action (add/subtract) and positive amount required.' });
  }

  const parsedAmount = parseFloat(amount);
  const db = await getDB();

  try {
    await db.run('BEGIN TRANSACTION');

    const user = await db.get('SELECT balance, role, currency FROM users WHERE id = ?', [req.params.id]);
    if (!user || user.role !== 'user') {
      await db.run('ROLLBACK');
      return res.status(404).json({ error: 'Client user not found.' });
    }

    const rate = await getUserExchangeRate(db, req.params.id);
    const adjustedAmount = parsedAmount * rate;

    let newBalance = user.balance;
    let ledgerType = '';
    let ledgerAmt = 0;

    if (action === 'add') {
      newBalance += adjustedAmount;
      ledgerType = 'admin_add';
      ledgerAmt = adjustedAmount;
    } else {
      if (user.balance < adjustedAmount) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'User does not have enough balance to subtract.' });
      }
      newBalance -= adjustedAmount;
      ledgerType = 'admin_subtract';
      ledgerAmt = -adjustedAmount;
    }

    await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, req.params.id]);
    
    // Log to ledger
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, ledgerType, ledgerAmt, description || `Admin adjustment: ${action} $${parsedAmount} USD (converted to ${adjustedAmount.toFixed(2)} ${user.currency || 'USD'})`, newBalance]
    );

    await db.run('COMMIT');
    res.json({ success: true, message: `User balance adjusted to ${newBalance.toFixed(2)} ${user.currency || 'USD'}` });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: 'Failed to adjust balance: ' + err.message });
  }
});




// --- ADMIN CREATE USER ---

router.post('/admin/users/create', ...requirePermission('user_management'), async (req, res) => {
  const { username, full_name, email, phone_number, password, balance, demo_balance } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const db = await getDB();
  try {
    const isEmployee = req.user.role === 'employee';

    // Check for duplicate username
    const existingUsername = await db.get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existingUsername) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    // Check for duplicate email (only if provided)
    if (email && email.trim() !== '') {
      const existingEmail = await db.get('SELECT id FROM users WHERE email = ?', [email.trim()]);
      if (existingEmail) {
        return res.status(400).json({ error: 'Email is already registered.' });
      }
    }

    // Check for duplicate phone_number (only if provided)
    if (phone_number && phone_number.trim() !== '') {
      const existingPhone = await db.get('SELECT id FROM users WHERE phone_number = ?', [phone_number.trim()]);
      if (existingPhone) {
        return res.status(400).json({ error: 'Phone number is already registered by another account.' });
      }
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    let parsedBalance = parseFloat(balance) || 0.0;
    let parsedDemoBalance = parseFloat(demo_balance) || 10000.0;
    let invited_by_id = null;

    if (isEmployee) {
      // Force initial balances to default
      parsedBalance = 0.0;
      parsedDemoBalance = 10000.0;
      invited_by_id = req.user.id;
    }

    // Generate a unique referral/invite code for the newly created user
    let userInviteCode = '';
    let attempts = 0;
    while (attempts < 10) {
      userInviteCode = 'REF' + Math.random().toString(36).substring(2, 7).toUpperCase();
      const exists = await db.get('SELECT id FROM invite_codes WHERE code = ?', [userInviteCode]);
      if (!exists) break;
      attempts++;
    }

    const result = await db.run(
      `INSERT INTO users (username, full_name, email, phone_number, password_hash, role, balance, demo_balance, status, invited_by_id, invite_code, kyc_country)
       VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 'active', ?, ?, 'United States')`,
      [
        username.trim(),
        full_name ? full_name.trim() : null,
        email ? email.trim() : null,
        phone_number ? phone_number.trim() : null,
        password_hash,
        parsedBalance,
        parsedDemoBalance,
        invited_by_id,
        userInviteCode
      ]
    );

    if (result.lastID) {
      try {
        await db.run('INSERT INTO invite_codes (code, created_by_id) VALUES (?, ?)', [userInviteCode, result.lastID]);
      } catch (err) {
        console.error('[CREATE USER] Failed to insert invite code:', err.message);
      }
    }

    res.status(201).json({ success: true, message: `User "${username}" created successfully.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user: ' + err.message });
  }
});





// --- ADMIN TRADE OPTIONS CRUD ---

// Create a trade option
router.post('/admin/trade-options', ...requirePermission('trade_monitoring'), async (req, res) => {
  const { duration, commission_pct } = req.body;
  const parsedDur = parseInt(duration);
  const parsedComm = parseFloat(commission_pct);

  if (isNaN(parsedDur) || parsedDur <= 0 || isNaN(parsedComm) || parsedComm < 0 || parsedComm > 100) {
    return res.status(400).json({ error: 'Valid duration (seconds > 0) and commission percentage (0-100) required.' });
  }

  const db = await getDB();
  try {
    const result = await db.run(
      `INSERT INTO trade_options (duration, commission_pct) VALUES (?, ?)`,
      [parsedDur, parsedComm]
    );
    res.status(201).json({ success: true, message: 'Trade option added successfully.', id: result.lastID });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'A trade option with this duration already exists.' });
    }
    res.status(500).json({ error: 'Failed to create trade option: ' + err.message });
  }
});

// Update a trade option
router.put('/admin/trade-options/:id', ...requirePermission('trade_monitoring'), async (req, res) => {
  const { duration, commission_pct } = req.body;
  const parsedDur = parseInt(duration);
  const parsedComm = parseFloat(commission_pct);

  if (isNaN(parsedDur) || parsedDur <= 0 || isNaN(parsedComm) || parsedComm < 0 || parsedComm > 100) {
    return res.status(400).json({ error: 'Valid duration and commission percentage required.' });
  }

  const db = await getDB();
  try {
    const result = await db.run(
      `UPDATE trade_options SET duration = ?, commission_pct = ? WHERE id = ?`,
      [parsedDur, parsedComm, req.params.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Trade option not found.' });
    }

    res.json({ success: true, message: 'Trade option updated successfully.' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'A trade option with this duration already exists.' });
    }
    res.status(500).json({ error: 'Failed to update trade option.' });
  }
});

// Delete a trade option
router.delete('/admin/trade-options/:id', ...requirePermission('trade_monitoring'), async (req, res) => {
  const db = await getDB();
  try {
    const result = await db.run(`DELETE FROM trade_options WHERE id = ?`, [req.params.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Trade option not found.' });
    }
    res.json({ success: true, message: 'Trade option deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete trade option.' });
  }
});

// --- STATS DASHBOARD ---

// --- STATS DASHBOARD ---

router.get('/admin/stats', authenticateToken, requireRole(['admin', 'employee']), async (req, res) => {
  const db = await getDB();
  try {
    const isAdmin = req.user.role === 'admin';
    const userId = req.user.id;

    let seeAll = true;
    let hasLiveActivity = true;
    let hasGlobalSettings = true;
    let hasLiveTrades = true;
    let hasKycList = true;

    if (!isAdmin) {
      const perm = await db.get('SELECT see_all_users, full_access, dash_live_activity, dash_global_settings, dash_live_trades, dash_kyc_list FROM permissions WHERE user_id = ?', [userId]);
      seeAll = perm ? !!(perm.see_all_users || perm.full_access) : false;
      hasLiveActivity = perm ? !!(perm.dash_live_activity || perm.full_access) : false;
      hasGlobalSettings = perm ? !!(perm.dash_global_settings || perm.full_access) : false;
      hasLiveTrades = perm ? !!(perm.dash_live_trades || perm.full_access) : false;
      hasKycList = perm ? !!(perm.dash_kyc_list || perm.full_access) : false;
    }

    const testUserFilter = db.isPg ? 'AND (is_test = FALSE OR is_test IS NULL)' : 'AND (is_test = 0 OR is_test IS NULL)';
    const testUserJoinFilter = db.isPg ? 'AND (u.is_test = FALSE OR u.is_test IS NULL)' : 'AND (u.is_test = 0 OR u.is_test IS NULL)';

    const usdConversionSql = `
      (
        CASE WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PKR' THEN 278.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'INR' THEN 84.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BDT' THEN 117.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NPR' THEN 133.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NRP' THEN 133.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EUR' THEN 0.92 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'GBP' THEN 0.78 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'AED' THEN 3.67 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'SAR' THEN 3.75 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'TRY' THEN 32.5 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'NGN' THEN 1500.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'IDR' THEN 16000.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'BRL' THEN 5.4 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'EGP' THEN 48.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MYR' THEN 4.7 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KZT' THEN 475.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'THB' THEN 36.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'UAH' THEN 41.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'VND' THEN 25400.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'MXN' THEN 18.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'JPY' THEN 160.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'PHP' THEN 58.0 
             WHEN UPPER(COALESCE(u.currency, 'USD')) = 'KRW' THEN 1380.0 
             ELSE 1.0 
        END
      )
    `;

    // 1. Core counters
    const total_users = seeAll 
      ? (await db.get(`SELECT COUNT(*) as c FROM users WHERE role='user' ${testUserFilter}`))?.c || 0
      : (await db.get(`SELECT COUNT(*) as c FROM users WHERE role='user' AND invited_by_id = ? ${testUserFilter}`, [userId]))?.c || 0;
    
    const twoMinutesAgo = new Date(Date.now() - 120000).toISOString();
    const active_users = seeAll
      ? (await db.get(`SELECT COUNT(*) as c FROM users WHERE role='user' AND last_seen_at >= ? ${testUserFilter}`, [twoMinutesAgo]))?.c || 0
      : (await db.get(`SELECT COUNT(*) as c FROM users WHERE role='user' AND invited_by_id = ? AND last_seen_at >= ? ${testUserFilter}`, [userId, twoMinutesAgo]))?.c || 0;
    
    const pending_deposits = seeAll
      ? (await db.get(`SELECT COUNT(*) as c FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status='pending' AND (d.hidden_staff = 0 OR d.hidden_staff IS NULL)`))?.c || 0
      : (await db.get(`SELECT COUNT(*) as c FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status='pending' AND u.invited_by_id = ? AND (d.hidden_staff = 0 OR d.hidden_staff IS NULL)`, [userId]))?.c || 0;
      
    const pending_withdrawals = seeAll
      ? (await db.get(`SELECT COUNT(*) as c FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status='pending'`))?.c || 0
      : (await db.get(`SELECT COUNT(*) as c FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status='pending' AND u.invited_by_id = ?`, [userId]))?.c || 0;
    
    const total_volume = seeAll
      ? (await db.get(`SELECT COALESCE(SUM(COALESCE(t.amount_usd, t.amount)), 0) as s FROM trades t JOIN users u ON t.user_id = u.id WHERE (t.is_demo = 0 OR t.is_demo IS NULL) ${testUserJoinFilter}`))?.s || 0
      : (await db.get(`SELECT COALESCE(SUM(COALESCE(t.amount_usd, t.amount)), 0) as s FROM trades t JOIN users u ON t.user_id = u.id WHERE (t.is_demo = 0 OR t.is_demo IS NULL) AND u.invited_by_id = ? ${testUserJoinFilter}`, [userId]))?.s || 0;
    
    let net_broker_revenue = 0;
    if (req.user.role === 'employee') {
      const employeeId = Number(userId);
      const totalCommissionRow = await db.get(`
        SELECT COALESCE(SUM(COALESCE(t.referrer_commission, 0.0)), 0.0) as s
        FROM trades t
        JOIN users u ON t.user_id = u.id
        WHERE u.invited_by_id = ? ${testUserJoinFilter}
      `, [employeeId]);
      net_broker_revenue = totalCommissionRow ? parseFloat(totalCommissionRow.s) : 0;
    } else {
      net_broker_revenue = seeAll
        ? (await db.get(`
            SELECT COALESCE(SUM(
              CASE 
                WHEN t.status = 'lose' THEN COALESCE(t.amount_usd, t.amount)
                WHEN t.status = 'win' THEN -COALESCE(t.amount_usd, t.amount) * t.commission_pct / 100.0 
                ELSE 0 
              END
            ), 0) as s 
            FROM trades t 
            JOIN users u ON t.user_id = u.id
            WHERE (t.is_demo = 0 OR t.is_demo IS NULL) ${testUserJoinFilter}
          `))?.s || 0
        : (await db.get(`
            SELECT COALESCE(SUM(
              CASE 
                WHEN t.status = 'lose' THEN COALESCE(t.amount_usd, t.amount)
                WHEN t.status = 'win' THEN -COALESCE(t.amount_usd, t.amount) * t.commission_pct / 100.0 
                ELSE 0 
              END
            ), 0) as s 
            FROM trades t 
            JOIN users u ON t.user_id = u.id
            WHERE (t.is_demo = 0 OR t.is_demo IS NULL) AND u.invited_by_id = ? ${testUserJoinFilter}
          `, [userId]))?.s || 0;
    }

    const total_deposits = seeAll
      ? (await db.get(`SELECT COALESCE(SUM(d.amount / ${usdConversionSql}), 0) as s FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'approved' ${testUserJoinFilter}`))?.s || 0
      : (await db.get(`SELECT COALESCE(SUM(d.amount / ${usdConversionSql}), 0) as s FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'approved' AND u.invited_by_id = ? ${testUserJoinFilter}`, [userId]))?.s || 0;
      
    const total_withdrawals = seeAll
      ? (await db.get(`SELECT COALESCE(SUM(w.amount / ${usdConversionSql}), 0) as s FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = 'approved' ${testUserJoinFilter}`))?.s || 0
      : (await db.get(`SELECT COALESCE(SUM(w.amount / ${usdConversionSql}), 0) as s FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = 'approved' AND u.invited_by_id = ? ${testUserJoinFilter}`, [userId]))?.s || 0;

    // 2. Telemetry
    const startDb = Date.now();
    await db.get('SELECT 1');
    const dbLatency = Date.now() - startDb;
    
    const telemetry = {
      uptime_seconds: process.uptime(),
      db_latency_ms: dbLatency,
      memory_heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    };

    // 3. Active trades list
    let active_trades_list = [];
    if (hasLiveTrades) {
      active_trades_list = await db.all(`
        SELECT t.id, u.username, t.coin, t.direction, t.amount, t.open_price, t.expires_at, t.admin_control, COALESCE(t.currency, u.currency) AS currency 
        FROM trades t 
        JOIN users u ON t.user_id = u.id 
        WHERE t.status = 'active' ${seeAll ? '' : 'AND u.invited_by_id = ?'}
        ORDER BY t.created_at DESC
      `, seeAll ? [] : [userId]);
    }
    const active_trades = active_trades_list.length;

    // 4. Pending KYC list
    let pending_kyc_list = [];
    if (hasKycList) {
      pending_kyc_list = await db.all(`
        SELECT id, username, email, kyc_country, kyc_submitted_at 
        FROM users 
        WHERE role = 'user' AND kyc_status = 'pending' ${seeAll ? '' : 'AND invited_by_id = ?'}
        ORDER BY kyc_submitted_at DESC
      `, seeAll ? [] : [userId]);
    }

    // 5. Volume stats (Daily history for chart) - past 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
    const volume_stats = seeAll
      ? await db.all(`
          SELECT SUBSTR(CAST(t.created_at AS TEXT), 1, 10) as date,
                 COALESCE(SUM(COALESCE(t.amount_usd, t.amount)), 0) as volume,
                 COALESCE(SUM(
                   CASE 
                     WHEN t.status = 'lose' THEN COALESCE(t.amount_usd, t.amount)
                     WHEN t.status = 'win' THEN -COALESCE(t.amount_usd, t.amount) * t.commission_pct / 100.0 
                     ELSE 0 
                   END
                 ), 0) as revenue
          FROM trades t
          JOIN users u ON t.user_id = u.id
          WHERE (t.is_demo = 0 OR t.is_demo IS NULL) ${testUserJoinFilter} AND SUBSTR(CAST(t.created_at AS TEXT), 1, 10) >= ?
          GROUP BY 1
          ORDER BY 1 ASC
        `, [sevenDaysAgo])
      : await db.all(`
          SELECT SUBSTR(CAST(t.created_at AS TEXT), 1, 10) as date,
                 COALESCE(SUM(COALESCE(t.amount_usd, t.amount)), 0) as volume,
                 COALESCE(SUM(
                   CASE 
                     WHEN t.status = 'lose' THEN COALESCE(t.amount_usd, t.amount)
                     WHEN t.status = 'win' THEN -COALESCE(t.amount_usd, t.amount) * t.commission_pct / 100.0 
                     ELSE 0 
                   END
                 ), 0) as revenue
          FROM trades t
          JOIN users u ON t.user_id = u.id
          WHERE (t.is_demo = 0 OR t.is_demo IS NULL) AND u.invited_by_id = ? ${testUserJoinFilter} AND SUBSTR(CAST(t.created_at AS TEXT), 1, 10) >= ?
          GROUP BY 1
          ORDER BY 1 ASC
        `, [userId, sevenDaysAgo]);

    // Helper function to format DB dates as strict UTC ISO strings
    const formatDbTime = (dbTime) => {
      if (!dbTime) return new Date().toISOString();
      if (typeof dbTime === 'string') {
        if (!dbTime.includes('T') && !dbTime.includes('Z')) {
          let normalized = dbTime.replace(' ', 'T');
          if (!normalized.endsWith('Z')) {
            normalized += 'Z';
          }
          return normalized;
        }
        return dbTime;
      }
      return new Date(dbTime).toISOString();
    };

    // 6. Recent activities (top 500 merged from signups, deposits, withdrawals, trades)
    let recent_activity = [];
    let live_activities = [];

    if (hasLiveActivity) {
      const signups = seeAll 
        ? await db.all("SELECT username, created_at FROM users WHERE role = 'user' ORDER BY created_at DESC LIMIT 500")
        : await db.all("SELECT username, created_at FROM users WHERE role = 'user' AND invited_by_id = ? ORDER BY created_at DESC LIMIT 500", [userId]);
      
      const deposits = seeAll
        ? await db.all("SELECT d.amount, d.status, d.created_at, u.username FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.hidden_staff = 0 OR d.hidden_staff IS NULL ORDER BY d.created_at DESC LIMIT 500")
        : await db.all("SELECT d.amount, d.status, d.created_at, u.username FROM deposits d JOIN users u ON d.user_id = u.id WHERE u.invited_by_id = ? AND (d.hidden_staff = 0 OR d.hidden_staff IS NULL) ORDER BY d.created_at DESC LIMIT 500", [userId]);

      const withdrawals = seeAll
        ? await db.all("SELECT w.amount, w.status, w.created_at, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 500")
        : await db.all("SELECT w.amount, w.status, w.created_at, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE u.invited_by_id = ? ORDER BY w.created_at DESC LIMIT 500", [userId]);

      const trades = seeAll
        ? await db.all("SELECT t.amount, t.coin, t.direction, t.status, t.created_at, u.username, COALESCE(t.currency, u.currency) AS currency FROM trades t JOIN users u ON t.user_id = u.id WHERE t.is_demo = 0 OR t.is_demo IS NULL ORDER BY t.created_at DESC LIMIT 500")
        : await db.all("SELECT t.amount, t.coin, t.direction, t.status, t.created_at, u.username, COALESCE(t.currency, u.currency) AS currency FROM trades t JOIN users u ON t.user_id = u.id WHERE (t.is_demo = 0 OR t.is_demo IS NULL) AND u.invited_by_id = ? ORDER BY t.created_at DESC LIMIT 500", [userId]);

      const activities = [];
      signups.forEach(s => {
        activities.push({ type: 'signup', desc: `New user signup: ${s.username}`, time: formatDbTime(s.created_at) });
      });
      deposits.forEach(d => {
        activities.push({ type: 'deposit', desc: `Deposit of $${d.amount.toFixed(2)} (${d.status}) by ${d.username}`, time: formatDbTime(d.created_at) });
      });
      withdrawals.forEach(w => {
        activities.push({ type: 'withdrawal', desc: `Withdrawal of $${w.amount.toFixed(2)} (${w.status}) by ${w.username}`, time: formatDbTime(w.created_at) });
      });
      trades.forEach(t => {
        const cur = (t.currency || 'USD').toUpperCase();
        activities.push({ type: 'trade', desc: `Placed ${t.amount.toFixed(2)} ${cur} trade on ${t.coin} (${t.status}) by ${t.username}`, time: formatDbTime(t.created_at) });
      });

      // Sort by time descending and take top 500
      activities.sort((a, b) => new Date(b.time) - new Date(a.time));
      recent_activity = activities.slice(0, 500);

      const rawLive = global.liveUserActivities || [];
      if (seeAll) {
        live_activities = rawLive.slice().sort((a, b) => new Date(b.time) - new Date(a.time));
      } else {
        const referredUsers = await db.all("SELECT username FROM users WHERE invited_by_id = ?", [userId]);
        const refUsernames = new Set(referredUsers.map(ru => ru.username));
        live_activities = rawLive
          .filter(la => refUsernames.has(la.username))
          .sort((a, b) => new Date(b.time) - new Date(a.time));
      }
    }

    let ip_alerts = [];
    if (seeAll) {
      ip_alerts = await db.all('SELECT * FROM ip_alerts WHERE acknowledged = 0 ORDER BY id DESC');
    } else {
      // Employees can only see alerts related to users they invited
      const referredUsers = await db.all("SELECT username FROM users WHERE invited_by_id = ?", [userId]);
      const refUsernames = referredUsers.map(ru => ru.username);
      if (refUsernames.length > 0) {
        const placeholders = refUsernames.map(() => '?').join(',');
        ip_alerts = await db.all(`SELECT * FROM ip_alerts WHERE acknowledged = 0 AND username IN (${placeholders}) ORDER BY id DESC`, refUsernames);
      }
    }

    res.json({
      total_users,
      active_users,
      total_volume,
      net_broker_revenue,
      pending_deposits,
      pending_withdrawals,
      active_trades,
      telemetry,
      active_trades_list,
      pending_kyc_list,
      volume_stats,
      recent_activity,
      total_deposits,
      total_withdrawals,
      live_activities,
      ip_alerts
    });
  } catch (err) {
    console.error('Stats endpoint error:', err.message);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// POST /api/admin/ip-alerts/:id/dismiss - Dismiss (acknowledge) an IP alert
router.post('/admin/ip-alerts/:id/dismiss', authenticateToken, requireRole(['admin', 'employee']), async (req, res) => {
  const db = await getDB();
  const { id } = req.params;
  try {
    await db.run('UPDATE ip_alerts SET acknowledged = 1 WHERE id = ?', [Number(id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error dismissing IP alert:', err.message);
    res.status(500).json({ error: 'Failed to dismiss IP alert.' });
  }
});


// --- USER DETAILS (single user with ledger) ---

router.get('/admin/users/:id', ...requirePermission('user_management'), async (req, res) => {
  const db = await getDB();
  const userId = req.params.id;
  const user = await db.get(
    'SELECT id, username, role, balance, status, invite_code, created_at FROM users WHERE id = ?',
    [userId]
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const ledger = await db.all(
    'SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
    [userId]
  );
  res.json({ user, ledger });
});


// --- USER STATUS (PUT version for staff panel) ---

router.put('/admin/users/:id/status', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { status } = req.body;
  if (!['active', 'frozen', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }
  const db = await getDB();
  try {
    await db.run('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: `Account set to: ${status}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});


// --- USER BALANCE ADJUST (PUT version for staff panel) ---

router.put('/admin/users/:id/balance', ...requirePermission('user_management'), async (req, res) => {
  if (req.user.role === 'employee') {
    return res.status(403).json({ error: 'Forbidden: Employees cannot adjust or manage users.' });
  }
  const { action, amount, note } = req.body;
  if (!['add', 'subtract'].includes(action) || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Valid action and positive amount required.' });
  }
  const parsedAmount = parseFloat(amount);
  const db = await getDB();
  try {
    await db.run('BEGIN TRANSACTION');
    const user = await db.get('SELECT balance, currency FROM users WHERE id = ?', [req.params.id]);
    if (!user) { await db.run('ROLLBACK'); return res.status(404).json({ error: 'User not found.' }); }

    const rate = await getUserExchangeRate(db, req.params.id);
    const adjustedAmount = parsedAmount * rate;

    let newBalance = user.balance;
    let ledgerType = '';
    let ledgerAmt = 0;
    if (action === 'add') {
      newBalance += adjustedAmount;
      ledgerType = 'admin_add';
      ledgerAmt = adjustedAmount;
    } else {
      if (user.balance < adjustedAmount) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'User does not have enough balance.' });
      }
      newBalance -= adjustedAmount;
      ledgerType = 'admin_subtract';
      ledgerAmt = -adjustedAmount;
    }

    await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, req.params.id]);
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after) VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, ledgerType, ledgerAmt, note || `Admin ${action} $${parsedAmount} USD (converted to ${adjustedAmount.toFixed(2)} ${user.currency || 'USD'})`, newBalance]
    );
    await db.run('COMMIT');
    res.json({ success: true, new_balance: newBalance });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: 'Failed: ' + err.message });
  }
});


// --- EMPLOYEES (with invite_code and users_invited count) ---

router.get('/admin/employees', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const emps = await db.all(`
    SELECT u.id, u.username, u.status, u.invite_code, u.created_at,
           p.user_management, p.deposit_approval, p.withdrawal_approval, p.trade_monitoring, p.full_access, p.see_all_users, p.live_support,
           p.dash_live_activity, p.dash_global_settings, p.dash_live_trades, p.dash_kyc_list, p.earnings_history, p.withdrawal_limit,
           ic.commission_pct,
           (SELECT COUNT(*) FROM users WHERE invited_by_id = u.id) as users_invited
    FROM users u
    LEFT JOIN permissions p ON u.id = p.user_id
    LEFT JOIN invite_codes ic ON ic.created_by_id = u.id
    WHERE u.role = 'employee'
    ORDER BY u.created_at DESC
  `);

  const result = emps.map(e => ({
    id: e.id,
    username: e.username,
    status: e.status,
    invite_code: e.invite_code,
    created_at: e.created_at,
    users_invited: e.users_invited || 0,
    commission_pct: e.commission_pct,
    permissions: {
      full_access: e.full_access,
      user_management: e.user_management,
      deposit_approval: e.deposit_approval,
      withdrawal_approval: e.withdrawal_approval,
      trade_monitoring: e.trade_monitoring,
      live_support: e.live_support,
      see_all_users: e.see_all_users,
      dash_live_activity: e.dash_live_activity,
      dash_global_settings: e.dash_global_settings,
      dash_live_trades: e.dash_live_trades,
      dash_kyc_list: e.dash_kyc_list,
      earnings_history: e.earnings_history !== undefined && e.earnings_history !== null ? e.earnings_history : 1,
      withdrawal_limit: e.withdrawal_limit !== undefined && e.withdrawal_limit !== null ? parseFloat(e.withdrawal_limit) : 1000.00
    }
  }));

  res.json({ employees: result });
});


// --- CREATE EMPLOYEE (with invite code + custom commission support) ---

router.post('/admin/employees', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const { username, password, invite_code, commission_pct, permissions } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const exists = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (exists) return res.status(400).json({ error: 'Username already exists.' });

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // Generate invite code for this employee
    const empInviteCode = invite_code
      ? invite_code.trim().toUpperCase()
      : 'EMP' + Math.random().toString(36).substring(2, 8).toUpperCase();

    // Check if invite code already taken
    const codeExists = await db.get('SELECT id FROM invite_codes WHERE code = ?', [empInviteCode]);
    if (codeExists) return res.status(400).json({ error: 'Invite code already exists. Choose a different one.' });

    const commissionVal = (commission_pct !== undefined && commission_pct !== null && commission_pct !== '')
      ? parseFloat(commission_pct) : null;

    await db.run('BEGIN TRANSACTION');

    const result = await db.run(
      `INSERT INTO users (username, password_hash, role, status, invite_code) VALUES (?, ?, 'employee', 'active', ?)`,
      [username, password_hash, empInviteCode]
    );
    const empId = result.lastID;

    const p = permissions || {};
    await db.run(
      `INSERT INTO permissions (user_id, user_management, deposit_approval, withdrawal_approval, trade_monitoring, live_support, full_access, see_all_users,
                               dash_live_activity, dash_global_settings, dash_live_trades, dash_kyc_list)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        empId,
        p.user_management ? 1 : 0,
        p.deposit_approval ? 1 : 0,
        p.withdrawal_approval ? 1 : 0,
        p.trade_monitoring ? 1 : 0,
        p.live_support ? 1 : 0,
        p.full_access ? 1 : 0,
        p.see_all_users ? 1 : 0,
        p.dash_live_activity ? 1 : 0,
        p.dash_global_settings ? 1 : 0,
        p.dash_live_trades ? 1 : 0,
        p.dash_kyc_list ? 1 : 0
      ]
    );

    await db.run(
      'INSERT INTO invite_codes (code, created_by_id, commission_pct) VALUES (?, ?, ?)',
      [empInviteCode, empId, commissionVal]
    );

    await db.run('COMMIT');
    res.status(201).json({ success: true, message: 'Employee created.', invite_code: empInviteCode });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: 'Failed to create employee: ' + err.message });
  }
});


// --- EMPLOYEE PERMISSIONS (PUT version) — also updates commission_pct and invite code ---

router.put('/admin/employees/:id/permissions', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const p = req.body;
  const empId = req.params.id;
  try {
    const emp = await db.get('SELECT role, invite_code FROM users WHERE id = ?', [empId]);
    if (!emp || emp.role !== 'employee') return res.status(400).json({ error: 'Invalid employee.' });

    // Upsert permissions
    await db.run(
      `INSERT INTO permissions (user_id, user_management, deposit_approval, withdrawal_approval, trade_monitoring, live_support, full_access, see_all_users,
                               dash_live_activity, dash_global_settings, dash_live_trades, dash_kyc_list)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         user_management = excluded.user_management,
         deposit_approval = excluded.deposit_approval,
         withdrawal_approval = excluded.withdrawal_approval,
         trade_monitoring = excluded.trade_monitoring,
         live_support = excluded.live_support,
         full_access = excluded.full_access,
         see_all_users = excluded.see_all_users,
         dash_live_activity = excluded.dash_live_activity,
         dash_global_settings = excluded.dash_global_settings,
         dash_live_trades = excluded.dash_live_trades,
         dash_kyc_list = excluded.dash_kyc_list`,
      [
        empId,
        p.user_management ? 1 : 0,
        p.deposit_approval ? 1 : 0,
        p.withdrawal_approval ? 1 : 0,
        p.trade_monitoring ? 1 : 0,
        p.live_support ? 1 : 0,
        p.full_access ? 1 : 0,
        p.see_all_users ? 1 : 0,
        p.dash_live_activity ? 1 : 0,
        p.dash_global_settings ? 1 : 0,
        p.dash_live_trades ? 1 : 0,
        p.dash_kyc_list ? 1 : 0
      ]
    );

    // Update commission_pct on the employee's invite code row
    const commissionVal = (p.commission_pct !== undefined && p.commission_pct !== null && p.commission_pct !== '')
      ? parseFloat(p.commission_pct) : null;
    await db.run(
      'UPDATE invite_codes SET commission_pct = ? WHERE created_by_id = ?',
      [commissionVal, empId]
    );

    // Optionally rename the invite code
    if (p.new_invite_code) {
      const newCode = p.new_invite_code.trim().toUpperCase();
      if (newCode && newCode !== emp.invite_code) {
        const codeConflict = await db.get('SELECT id FROM invite_codes WHERE code = ? AND created_by_id != ?', [newCode, empId]);
        if (codeConflict) return res.status(400).json({ error: 'Invite code already in use by someone else.' });
        await db.run('UPDATE users SET invite_code = ? WHERE id = ?', [newCode, empId]);
        await db.run('UPDATE invite_codes SET code = ? WHERE created_by_id = ?', [newCode, empId]);
      }
    }

    res.json({ success: true, message: 'Permissions updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed: ' + err.message });
  }
});


// --- DELETE EMPLOYEE (blocks account) ---

router.delete('/admin/employees/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  try {
    const emp = await db.get('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
    if (!emp || emp.role !== 'employee') return res.status(400).json({ error: 'Invalid employee.' });
    await db.run("UPDATE users SET status = 'blocked' WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: 'Employee blocked.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to block employee: ' + err.message });
  }
});


// --- RESET EMPLOYEE PASSWORD ---

router.put('/admin/employees/:id/reset-password', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    const emp = await db.get('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
    if (!emp || emp.role !== 'employee') return res.status(400).json({ error: 'Invalid employee.' });
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, req.params.id]);
    res.json({ success: true, message: 'Password reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password: ' + err.message });
  }
});


// --- EMPLOYEE STATS ---

router.get('/admin/employees/:id/stats', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  try {
    const emp = await db.get('SELECT id, username, role FROM users WHERE id = ?', [req.params.id]);
    if (!emp || emp.role !== 'employee') return res.status(400).json({ error: 'Invalid employee.' });

    const usersInvited = await db.all(
      'SELECT id, username, status, created_at FROM users WHERE invited_by_id = ? ORDER BY created_at DESC',
      [emp.id]
    );
    const usersIds = usersInvited.map(u => u.id);

    let totalDeposits = 0;
    let totalCommissions = 0;
    let depositRows = [];

    if (usersIds.length > 0) {
      const placeholders = usersIds.map(() => '?').join(',');
      const depResult = await db.get(
        `SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE user_id IN (${placeholders}) AND status = 'approved'`,
        usersIds
      );
      totalDeposits = depResult ? parseFloat(depResult.total) : 0;

      const commResult = await db.get(
        `SELECT COALESCE(SUM(amount), 0) as total FROM ledger WHERE user_id = ? AND type = 'referral_commission'`,
        [emp.id]
      );
      totalCommissions = commResult ? parseFloat(commResult.total) : 0;
    }

    res.json({
      employee: { id: emp.id, username: emp.username },
      users_invited: usersInvited,
      total_deposits: totalDeposits,
      total_commissions: totalCommissions
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats: ' + err.message });
  }
});


// --- EMPLOYEE WITHDRAWAL API ROUTES ---

// GET /api/staff/my-withdrawals/summary — get employee commission & withdrawal balance summary
router.get('/staff/my-withdrawals/summary', authenticateToken, async (req, res) => {
  const db = await getDB();
  const userId = req.user.id;
  try {
    const empId = Number(userId);
    
    // 1. Total referral commission earned from invited users
    const earnedRow = await db.get(`
      SELECT COALESCE(SUM(COALESCE(t.referrer_commission, 0.0)), 0.0) as s
      FROM trades t
      JOIN users u ON t.user_id = u.id
      WHERE u.invited_by_id = ?
    `, [empId]);
    const total_commission_earned = earnedRow ? parseFloat(earnedRow.s || 0) : 0;

    // 2. Approved withdrawals
    const approvedRow = await db.get(`
      SELECT COALESCE(SUM(amount), 0.0) as s
      FROM employee_withdrawals
      WHERE employee_id = ? AND status = 'approved'
    `, [empId]);
    const approved_withdrawn = approvedRow ? parseFloat(approvedRow.s || 0) : 0;

    // 3. Pending withdrawals
    const pendingRow = await db.get(`
      SELECT COALESCE(SUM(amount), 0.0) as s
      FROM employee_withdrawals
      WHERE employee_id = ? AND status = 'pending'
    `, [empId]);
    const pending_withdrawn = pendingRow ? parseFloat(pendingRow.s || 0) : 0;

    const available_balance = Math.max(0, parseFloat((total_commission_earned - (approved_withdrawn + pending_withdrawn)).toFixed(2)));

    // 4. Permissions & withdrawal limit
    let permissions = await db.get('SELECT earnings_history, withdrawal_limit FROM permissions WHERE user_id = ?', [empId]);
    if (!permissions && req.user.role === 'admin') {
      permissions = { earnings_history: 1, withdrawal_limit: 100000.00 };
    }
    const earnings_history = permissions ? (permissions.earnings_history !== 0 ? 1 : 0) : 1;
    const withdrawal_limit = permissions && permissions.withdrawal_limit !== null && permissions.withdrawal_limit !== undefined
      ? parseFloat(permissions.withdrawal_limit) : 1000.00;

    res.json({
      success: true,
      total_commission_earned: parseFloat(total_commission_earned.toFixed(2)),
      approved_withdrawn: parseFloat(approved_withdrawn.toFixed(2)),
      pending_withdrawn: parseFloat(pending_withdrawn.toFixed(2)),
      available_balance,
      withdrawal_limit,
      earnings_history
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/my-withdrawals/history — get commission log & withdrawal history
router.get('/staff/my-withdrawals/history', authenticateToken, async (req, res) => {
  const db = await getDB();
  const userId = req.user.id;
  try {
    const empId = Number(userId);
    
    // Check permission
    if (req.user.role === 'employee') {
      const perm = await db.get('SELECT earnings_history FROM permissions WHERE user_id = ?', [empId]);
      if (perm && perm.earnings_history === 0) {
        return res.status(403).json({ error: 'Earnings and withdrawal history disabled by administrator.' });
      }
    }

    // 1. Commission log (trades from invited users where referrer_commission > 0)
    const commissionLog = await db.all(`
      SELECT t.id, t.amount, t.amount_usd, t.currency, t.referrer_commission, t.created_at, t.resolved_at,
             u.username as user_name, u.id as user_id
      FROM trades t
      JOIN users u ON t.user_id = u.id
      WHERE u.invited_by_id = ? AND t.referrer_commission > 0
      ORDER BY t.resolved_at DESC LIMIT 100
    `, [empId]);

    // 2. Withdrawal history
    const withdrawals = await db.all(`
      SELECT * FROM employee_withdrawals
      WHERE employee_id = ?
      ORDER BY created_at DESC LIMIT 100
    `, [empId]);

    res.json({
      success: true,
      commission_log: commissionLog,
      withdrawals
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/my-withdrawals/request — submit employee withdrawal request
router.post('/staff/my-withdrawals/request', authenticateToken, async (req, res) => {
  const db = await getDB();
  const userId = req.user.id;
  const { amount, method, accountDetails } = req.body;

  try {
    const empId = Number(userId);
    
    // Check permission
    let perm = await db.get('SELECT earnings_history, withdrawal_limit FROM permissions WHERE user_id = ?', [empId]);
    if (req.user.role === 'employee' && perm && perm.earnings_history === 0) {
      return res.status(403).json({ error: 'Withdrawals are currently disabled for your account by administrator.' });
    }

    const reqAmount = parseFloat(amount);
    if (isNaN(reqAmount) || reqAmount <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal amount.' });
    }

    if (!method || !accountDetails || !accountDetails.trim()) {
      return res.status(400).json({ error: 'Withdrawal method and account details are required.' });
    }

    // 1. Check custom per-withdrawal limit
    const limitVal = perm && perm.withdrawal_limit !== null && perm.withdrawal_limit !== undefined
      ? parseFloat(perm.withdrawal_limit) : 1000.00;
    if (limitVal > 0 && reqAmount > limitVal) {
      return res.status(400).json({ error: `Withdrawal amount ($${reqAmount.toFixed(2)}) exceeds your custom limit ($${limitVal.toFixed(2)}).` });
    }

    // 2. Check available commission balance
    const earnedRow = await db.get(`
      SELECT COALESCE(SUM(COALESCE(t.referrer_commission, 0.0)), 0.0) as s
      FROM trades t
      JOIN users u ON t.user_id = u.id
      WHERE u.invited_by_id = ?
    `, [empId]);
    const totalEarned = earnedRow ? parseFloat(earnedRow.s || 0) : 0;

    const withdrawnRow = await db.get(`
      SELECT COALESCE(SUM(amount), 0.0) as s
      FROM employee_withdrawals
      WHERE employee_id = ? AND status IN ('approved', 'pending')
    `, [empId]);
    const totalWithdrawn = withdrawnRow ? parseFloat(withdrawnRow.s || 0) : 0;

    const availableBalance = Math.max(0, parseFloat((totalEarned - totalWithdrawn).toFixed(2)));

    if (reqAmount > availableBalance) {
      return res.status(400).json({ error: `Insufficient available earnings. Available balance is $${availableBalance.toFixed(2)}.` });
    }

    // 3. Create withdrawal request
    await db.run(
      `INSERT INTO employee_withdrawals (employee_id, amount, method, account_details, status) VALUES (?, ?, ?, ?, 'pending')`,
      [empId, reqAmount, method.trim(), accountDetails.trim()]
    );

    res.json({ success: true, message: 'Withdrawal request submitted successfully. Waiting for admin approval.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/employee-withdrawals — admin view of all employee withdrawals
router.get('/admin/employee-withdrawals', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  try {
    const rows = await db.all(`
      SELECT ew.*, u.username as employee_name, u.email as employee_email
      FROM employee_withdrawals ew
      JOIN users u ON ew.employee_id = u.id
      ORDER BY ew.created_at DESC
    `);
    res.json({ success: true, withdrawals: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/employee-withdrawals/:id/approve — admin approve employee withdrawal
router.post('/admin/employee-withdrawals/:id/approve', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const { id } = req.params;
  const { adminNotes } = req.body || {};
  try {
    const item = await db.get('SELECT * FROM employee_withdrawals WHERE id = ?', [id]);
    if (!item) return res.status(404).json({ error: 'Withdrawal request not found.' });
    if (item.status !== 'pending') return res.status(400).json({ error: `Request is already ${item.status}.` });

    await db.run(
      `UPDATE employee_withdrawals SET status = 'approved', admin_notes = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by_id = ? WHERE id = ?`,
      [adminNotes || 'Approved by Admin', req.user.id, id]
    );

    res.json({ success: true, message: 'Employee withdrawal request approved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/employee-withdrawals/:id/reject — admin reject employee withdrawal
router.post('/admin/employee-withdrawals/:id/reject', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const { id } = req.params;
  const { adminNotes } = req.body || {};
  try {
    const item = await db.get('SELECT * FROM employee_withdrawals WHERE id = ?', [id]);
    if (!item) return res.status(404).json({ error: 'Withdrawal request not found.' });
    if (item.status !== 'pending') return res.status(400).json({ error: `Request is already ${item.status}.` });

    await db.run(
      `UPDATE employee_withdrawals SET status = 'rejected', admin_notes = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by_id = ? WHERE id = ?`,
      [adminNotes || 'Rejected by Admin', req.user.id, id]
    );

    res.json({ success: true, message: 'Employee withdrawal request rejected.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- INVITE CODES (DELETE) ---

router.delete('/admin/invite-codes/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  try {
    const result = await db.run('DELETE FROM invite_codes WHERE id = ?', [req.params.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Invite code not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete invite code.' });
  }
});

router.get('/admin/invite-codes', authenticateToken, requireRole(['admin', 'employee']), async (req, res) => {
  const db = await getDB();
  const perm = await db.get('SELECT see_all_users, full_access FROM permissions WHERE user_id = ?', [req.user.id]);
  const seeAll = req.user.role === 'admin' || (perm && (perm.see_all_users || perm.full_access));

  let codes;
  if (seeAll) {
    codes = await db.all(`
      SELECT c.id, c.code, c.used_count, c.created_at, u.username as creator_username
      FROM invite_codes c
      JOIN users u ON c.created_by_id = u.id
      ORDER BY c.created_at DESC
    `);
  } else {
    codes = await db.all(`
      SELECT c.id, c.code, c.used_count, c.created_at, u.username as creator_username
      FROM invite_codes c
      JOIN users u ON c.created_by_id = u.id
      WHERE c.created_by_id = ?
      ORDER BY c.created_at DESC
    `, [req.user.id]);
  }
  res.json({ codes });
});


// --- DEPOSITS (with status filter & limit support, and approve/reject via PUT) ---

router.get('/admin/deposits', ...requirePermission('deposit_approval'), async (req, res) => {
  const { status, limit } = req.query;
  const db = await getDB();
  const perm = await db.get('SELECT see_all_users, full_access FROM permissions WHERE user_id = ?', [req.user.id]);
  const seeAll = req.user.role === 'admin' || (perm && (perm.see_all_users || perm.full_access));

  let query = `SELECT d.*, u.username FROM deposits d JOIN users u ON d.user_id = u.id WHERE (d.hidden_staff = 0 OR d.hidden_staff IS NULL)`;
  const params = [];

  if (!seeAll) {
    query += ' AND u.invited_by_id = ?';
    params.push(req.user.id);
  }
  
  if (status && status !== 'all') {
    query += ' AND d.status = ?';
    params.push(status);
  }

  query += ' ORDER BY d.created_at DESC';
  if (limit) {
    query += ' LIMIT ?';
    params.push(parseInt(limit));
  }
  const deposits = await db.all(query, params);
  res.json({ deposits });
});

// POST /api/admin/deposits/delete - Bulk Soft Delete Deposits
router.post('/admin/deposits/delete', ...requirePermission('deposit_approval'), async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No deposit IDs specified for deletion.' });
  }

  const db = await getDB();
  try {
    const placeholders = ids.map(() => '?').join(',');
    await db.run(
      `UPDATE deposits SET hidden_staff = 1 WHERE id IN (${placeholders})`,
      ids
    );
    res.json({ success: true, message: `Successfully deleted ${ids.length} deposit(s) from staff panel.` });
  } catch (err) {
    console.error('Error soft-deleting deposits:', err.message);
    res.status(500).json({ error: 'Failed to delete deposits.' });
  }
});

router.put('/admin/deposits/:id/approve', ...requirePermission('deposit_approval'), async (req, res) => {
  const db = await getDB();
  const depositId = req.params.id;
  try {
    await db.run('BEGIN TRANSACTION');
    const deposit = await db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    if (!deposit) { await db.run('ROLLBACK'); return res.status(404).json({ error: 'Not found.' }); }
    if (deposit.status !== 'pending') { await db.run('ROLLBACK'); return res.status(400).json({ error: 'Already resolved.' }); }

    const user = await db.get('SELECT balance FROM users WHERE id = ?', [deposit.user_id]);
    const newBalance = user.balance + deposit.amount;
    await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, deposit.user_id]);
    await db.run(
      `UPDATE deposits SET status='approved', resolved_at=?, resolved_by_id=? WHERE id=?`,
      [new Date().toISOString(), req.user.id, depositId]
    );
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after) VALUES (?, 'deposit', ?, ?, ?)`,
      [deposit.user_id, deposit.amount, `Deposit Approved (${deposit.method})`, newBalance]
    );

    // Apply referral commission for the first 5 deposits
    await applyReferralCommission(db, deposit.user_id, deposit.amount);

    await db.run('COMMIT');

    const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [deposit.user_id]);
    if (userDetail && userDetail.email) {
      sendSystemEmail(userDetail.email, 'deposit_approved', {
        username: userDetail.username,
        full_name: userDetail.full_name || userDetail.username,
        amount: deposit.amount,
        currency: 'USD',
        transaction_id: deposit.id,
        new_balance: newBalance
      }).catch(err => console.error('[EMAIL ERROR] Admin deposit approved email:', err.message));
    }

    sendPushNotification(deposit.user_id, 'Deposit Approved', `Your deposit of $${deposit.amount.toFixed(2)} has been successfully credited.`);

    res.json({ success: true, message: 'Deposit approved.' });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/deposits/:id/reject', ...requirePermission('deposit_approval'), async (req, res) => {
  const db = await getDB();
  const depositId = req.params.id;
  try {
    const deposit = await db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    if (!deposit) return res.status(404).json({ error: 'Not found.' });
    if (deposit.status !== 'pending') return res.status(400).json({ error: 'Already resolved.' });
    const { reason } = req.body;
    await db.run(
      `UPDATE deposits SET status='rejected', resolved_at=?, resolved_by_id=?, reject_reason=? WHERE id=?`,
      [new Date().toISOString(), req.user.id, reason || null, depositId]
    );
    const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [deposit.user_id]);
    if (userDetail && userDetail.email) {
      sendSystemEmail(userDetail.email, 'deposit_rejected', {
        username: userDetail.username,
        full_name: userDetail.full_name || userDetail.username,
        amount: deposit.amount,
        currency: 'USD',
        transaction_id: deposit.id,
        reason: reason || 'Deposit verification proof was missing or incorrect.'
      }).catch(err => console.error('[EMAIL ERROR] Admin deposit rejected email:', err.message));
    }

    sendPushNotification(deposit.user_id, 'Deposit Rejected', `Your deposit request for $${deposit.amount.toFixed(2)} has been rejected.`);

    res.json({ success: true, message: 'Deposit rejected.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- WITHDRAWALS (with status filter & approve/reject via PUT) ---

router.get('/admin/withdrawals', ...requirePermission('withdrawal_approval'), async (req, res) => {
  const { status, limit } = req.query;
  const db = await getDB();
  const perm = await db.get('SELECT see_all_users, full_access FROM permissions WHERE user_id = ?', [req.user.id]);
  const seeAll = req.user.role === 'admin' || (perm && (perm.see_all_users || perm.full_access));

  let query = `SELECT w.*, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id`;
  const params = [];

  if (!seeAll) {
    query += ' WHERE u.invited_by_id = ?';
    params.push(req.user.id);
    if (status && status !== 'all') {
      query += ' AND w.status = ?';
      params.push(status);
    }
  } else {
    if (status && status !== 'all') {
      query += ' WHERE w.status = ?';
      params.push(status);
    }
  }

  query += ' ORDER BY w.created_at DESC';
  if (limit) {
    query += ' LIMIT ?';
    params.push(parseInt(limit));
  }
  const rawWithdrawals = await db.all(query, params);
  const withdrawals = rawWithdrawals.map(restoreWithdrawalMethod);
  res.json({ withdrawals });
});

router.put('/admin/withdrawals/:id/approve', ...requirePermission('withdrawal_approval'), async (req, res) => {
  const { amount } = req.body;
  const db = await getDB();
  const wId = req.params.id;
  try {
    await db.run('BEGIN TRANSACTION');
    const rawW = await db.get('SELECT * FROM withdrawals WHERE id = ?', [wId]);
    const w = restoreWithdrawalMethod(rawW);
    if (!w) { await db.run('ROLLBACK'); return res.status(404).json({ error: 'Not found.' }); }
    if (w.status !== 'pending') { await db.run('ROLLBACK'); return res.status(400).json({ error: 'Already resolved.' }); }

    let finalAmount = w.amount;
    if (amount !== undefined) {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > w.amount) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'Invalid adjusted amount.' });
      }
      finalAmount = parsedAmount;
    }

    // If finalAmount is less than w.amount, refund the difference to the user
    if (finalAmount < w.amount) {
      const diff = w.amount - finalAmount;
      const user = await db.get('SELECT balance FROM users WHERE id = ?', [w.user_id]);
      const newBalance = user.balance + diff;
      await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, w.user_id]);
      await db.run(
        `INSERT INTO ledger (user_id, type, amount, description, balance_after) VALUES (?, 'deposit', ?, ?, ?)`,
        [w.user_id, diff, `Refund for withdrawal amount adjustment (payout: $${finalAmount.toFixed(2)} / requested: $${w.amount.toFixed(2)})`, newBalance]
      );
    }

    await db.run(
      `UPDATE withdrawals SET status='approved', amount=?, resolved_at=?, resolved_by_id=? WHERE id=?`,
      [finalAmount, new Date().toISOString(), req.user.id, wId]
    );

    await db.run('COMMIT');

    const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [w.user_id]);
    if (userDetail && userDetail.email) {
      sendSystemEmail(userDetail.email, 'withdrawal_approved', {
        username: userDetail.username,
        full_name: userDetail.full_name || userDetail.username,
        amount: finalAmount,
        currency: 'USD',
        method: w.method,
        destination: w.payout_details,
        transaction_id: w.id
      }).catch(err => console.error('[EMAIL ERROR] Withdrawal approved email:', err.message));
    }

    sendPushNotification(w.user_id, 'Withdrawal Approved', `Your withdrawal of $${finalAmount.toFixed(2)} via ${w.method} has been approved.`);

    res.json({ success: true, message: 'Withdrawal approved.', final_amount: finalAmount });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/withdrawals/:id/reject', ...requirePermission('withdrawal_approval'), async (req, res) => {
  const db = await getDB();
  const wId = req.params.id;
  const { reason } = req.body;
  try {
    await db.run('BEGIN TRANSACTION');
    const rawW = await db.get('SELECT * FROM withdrawals WHERE id = ?', [wId]);
    const w = restoreWithdrawalMethod(rawW);
    if (!w) { await db.run('ROLLBACK'); return res.status(404).json({ error: 'Not found.' }); }
    if (w.status !== 'pending') { await db.run('ROLLBACK'); return res.status(400).json({ error: 'Already resolved.' }); }

    // Refund balance
    const user = await db.get('SELECT balance FROM users WHERE id = ?', [w.user_id]);
    const newBalance = user.balance + w.amount;
    await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, w.user_id]);
    await db.run(
      `UPDATE withdrawals SET status='rejected', resolved_at=?, resolved_by_id=?, reject_reason=? WHERE id=?`,
      [new Date().toISOString(), req.user.id, reason || null, wId]
    );
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after) VALUES (?, 'deposit', ?, ?, ?)`,
      [w.user_id, w.amount, `Refund for rejected withdrawal #${wId}`, newBalance]
    );
    await db.run('COMMIT');
    const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [w.user_id]);
    if (userDetail && userDetail.email) {
      sendSystemEmail(userDetail.email, 'withdrawal_rejected', {
        username: userDetail.username,
        full_name: userDetail.full_name || userDetail.username,
        amount: w.amount,
        currency: 'USD',
        transaction_id: w.id,
        reason: reason || 'Incorrect payout details or compliance check failure.'
      }).catch(err => console.error('[EMAIL ERROR] Withdrawal rejected email:', err.message));
    }

    sendPushNotification(w.user_id, 'Withdrawal Rejected', `Your withdrawal request for $${w.amount.toFixed(2)} has been rejected. Reason: ${reason || 'Incorrect details.'}`);

    res.json({ success: true, message: 'Withdrawal rejected and balance refunded.' });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});


// --- TRADES (with optional status filter, PUT control) ---

router.get('/admin/trades', ...requirePermission('trade_monitoring'), async (req, res) => {
  const { status, search } = req.query;
  const db = await getDB();
  const perm = await db.get('SELECT see_all_users, full_access FROM permissions WHERE user_id = ?', [req.user.id]);
  const seeAll = req.user.role === 'admin' || (perm && (perm.see_all_users || perm.full_access));

  let query = `SELECT t.*, u.username, u.email, u.phone_number FROM trades t JOIN users u ON t.user_id = u.id`;
  const params = [];
  const conditions = [];

  if (!seeAll) {
    conditions.push('u.invited_by_id = ?');
    params.push(req.user.id);
  }

  if (status && status !== 'all') {
    conditions.push('t.status = ?');
    params.push(status);
  }

  if (search) {
    const searchPattern = `%${search}%`;
    conditions.push(`(
      t.coin LIKE ? OR 
      t.direction LIKE ? OR
      CAST(t.amount AS TEXT) LIKE ? OR 
      u.username LIKE ? OR 
      u.email LIKE ? OR 
      u.phone_number LIKE ? OR
      CAST(t.id AS TEXT) = ?
    )`);
    params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, search.trim());
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY t.created_at DESC LIMIT 5000';
  const trades = await db.all(query, params);
  res.json({ trades });
});

router.put('/admin/trades/:id/control', ...requirePermission('trade_monitoring'), async (req, res) => {
  const { admin_control } = req.body;
  if (!['win', 'lose', 'none'].includes(admin_control)) {
    return res.status(400).json({ error: 'Invalid control value (win/lose/none).' });
  }
  const db = await getDB();
  try {
    const trade = await db.get('SELECT status FROM trades WHERE id = ?', [req.params.id]);
    if (!trade) return res.status(404).json({ error: 'Trade not found.' });
    if (trade.status !== 'active') return res.status(400).json({ error: 'Can only control active trades.' });
    await db.run('UPDATE trades SET admin_control = ? WHERE id = ?', [admin_control, req.params.id]);
    res.json({ success: true, message: `Trade control set to: ${admin_control}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// --- COMBINE TRADES CONTROL ---

router.put('/admin/trades/combine-control', ...requirePermission('trade_monitoring'), async (req, res) => {
  const { combine_trades_control, combine_trades_outcome } = req.body;
  const db = await getDB();
  try {
    await db.run('BEGIN TRANSACTION');
    if (combine_trades_control !== undefined) {
      await db.run(
        `INSERT INTO settings (key, value) VALUES ('combine_trades_control', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [combine_trades_control ? 'true' : 'false']
      );
    }
    if (combine_trades_outcome !== undefined) {
      if (!['win', 'lose', 'none'].includes(combine_trades_outcome)) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'Invalid outcome. Must be win, lose, or none.' });
      }
      await db.run(
        `INSERT INTO settings (key, value) VALUES ('combine_trades_outcome', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [combine_trades_outcome]
      );

      // If setting an outcome with combine ON, apply admin_control to ALL active trades
      const combineRow = await db.get(`SELECT value FROM settings WHERE key = 'combine_trades_control'`);
      const combineEnabled = combineRow && combineRow.value === 'true';
      if (combineEnabled && combine_trades_outcome !== 'none') {
        await db.run(`UPDATE trades SET admin_control = ? WHERE status = 'active'`, [combine_trades_outcome]);
      } else if (combine_trades_outcome === 'none') {
        await db.run(`UPDATE trades SET admin_control = 'none' WHERE status = 'active'`);
      }
    }
    await db.run('COMMIT');
    res.json({ success: true, message: 'Combine trades settings updated.' });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});


// --- ONBOARDING IMAGE UPLOAD ---

// Setup file upload directory for onboarding images
const onboardingUploadDir = process.env.VERCEL
  ? '/tmp/uploads/onboarding'
  : (fs.existsSync('/data') ? '/data/uploads/onboarding' : path.join(__dirname, '..', 'public', 'uploads', 'onboarding'));
if (!fs.existsSync(onboardingUploadDir)) {
  fs.mkdirSync(onboardingUploadDir, { recursive: true });
}

const onboardingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, onboardingUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `onboarding_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const uploadOnboarding = multer({
  storage: onboardingStorage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

router.post('/admin/upload-onboarding-image', authenticateToken, requireRole(['admin']), uploadOnboarding.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
  try {
    const filePath = await uploadToSupabase(req.file);
    res.json({ success: true, filePath });
  } catch (err) {
    res.status(500).json({ error: 'Image upload failed.' });
  }
});


// --- SETTINGS (PUT version for staff panel) ---

router.put('/admin/settings', authenticateToken, requireRole(['admin']), async (req, res) => {
  const settingsObj = req.body;
  const db = await getDB();
  try {
    await db.run('BEGIN TRANSACTION');
    for (const [key, value] of Object.entries(settingsObj)) {
      await db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, String(value)]
      );
    }
    await db.run('COMMIT');
    res.json({ success: true, message: 'Settings updated.' });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/settings/:key', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  try {
    await db.run('DELETE FROM settings WHERE key = ?', [req.params.key]);
    res.json({ success: true, message: `Setting ${req.params.key} deleted.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET settings as a flat object (not array)
router.get('/admin/settings', authenticateToken, requireRole(['admin', 'employee']), async (req, res) => {
  const db = await getDB();
  const rows = await db.all('SELECT * FROM settings');
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ settings });
});


// --- TRADE OPTIONS GET ---

router.get('/admin/trade-options', authenticateToken, requireRole(['admin', 'employee']), async (req, res) => {
  const db = await getDB();
  const opts = await db.all('SELECT * FROM trade_options ORDER BY duration ASC');
  res.json({ trade_options: opts });
});

// --- DYNAMIC PROFILE DETAILS ENDPOINT ---
router.get('/profile/details/:userId', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const userId = Number(req.params.userId);
    const targetUser = await db.get(
      'SELECT id, username, full_name, profile_pic, kyc_status FROM users WHERE id = ?',
      [userId]
    );
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const details = await getUserProfileDetails(db, userId);
    targetUser.streak = details.streak;
    targetUser.total_volume = details.total_volume;
    targetUser.friends_count = details.friends_count;

    // Check friendship status with current logged-in user
    const uid = req.user.id;
    const user_id1 = Math.min(uid, userId);
    const user_id2 = Math.max(uid, userId);
    const friendship = await db.get(
      'SELECT id as friendship_id, status, sender_id FROM friends WHERE user_id1 = ? AND user_id2 = ?',
      [user_id1, user_id2]
    );

    let friendStatus = 'none'; // 'none', 'accepted', 'pending_incoming', 'pending_outgoing'
    let friendshipId = null;
    if (friendship) {
      friendshipId = friendship.friendship_id;
      if (friendship.status === 'accepted') {
        friendStatus = 'accepted';
      } else {
        friendStatus = friendship.sender_id === uid ? 'pending_outgoing' : 'pending_incoming';
      }
    }

    res.json({ user: targetUser, friendStatus, friendshipId });
  } catch (err) {
    console.error('Error fetching user profile details:', err.message);
    res.status(500).json({ error: 'Failed to retrieve profile details.' });
  }
});

// --- FEED POSTS SYSTEM ---

const feedUploadDir = process.env.VERCEL
  ? '/tmp/uploads/feeds'
  : (fs.existsSync('/data') ? '/data/uploads/feeds' : path.join(__dirname, '..', 'public', 'uploads', 'feeds'));
if (!fs.existsSync(feedUploadDir)) {
  fs.mkdirSync(feedUploadDir, { recursive: true });
}

const feedStorage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, feedUploadDir); },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'feed-' + uniqueSuffix + ext);
  }
});

const uploadFeedMedia = multer({
  storage: feedStorage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

// GET: Fetch feed posts for a user
router.get('/profile/posts', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    let targetUserId = req.user.id;
    if (req.query.userId && req.query.userId !== 'undefined' && req.query.userId !== 'null') {
      const qUser = String(req.query.userId);
      if (qUser.startsWith('custom_') || isNaN(Number(qUser))) {
        return res.json({ posts: [] });
      }
      targetUserId = Number(req.query.userId);
    }
    
    const posts = await db.all(
      `SELECT p.*, u.username, u.full_name, u.profile_pic, u.kyc_status,
              EXISTS (SELECT 1 FROM profile_post_likes l WHERE l.post_id = p.id AND l.user_id = ?) as has_liked
       FROM profile_posts p 
       JOIN users u ON p.user_id = u.id 
       WHERE p.user_id = ? 
       ORDER BY p.created_at DESC`,
      [req.user.id, targetUserId]
    );

    res.json({ posts });
  } catch (err) {
    console.error('Error fetching profile posts:', err.message);
    res.status(500).json({ error: 'Failed to fetch feed posts.' });
  }
});

// POST: Upload a new post (max 5 posts per user)
router.post('/profile/posts', authenticateToken, uploadFeedMedia.single('media'), async (req, res) => {
  const db = await getDB();
  try {
    const countRow = await db.get('SELECT COUNT(*) as count FROM profile_posts WHERE user_id = ?', [req.user.id]);
    const postCount = countRow ? countRow.count : 0;
    if (postCount >= 5) {
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch (fErr) {}
      }
      return res.status(400).json({ error: 'Maximum limit of 5 feed posts reached. Delete a post to upload a new one.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Media file (image, gif, or video) is required.' });
    }

    const { description } = req.body;
    const mediaUrl = '/uploads/feeds/' + req.file.filename;

    // Detect media type
    let mediaType = 'image';
    const mime = req.file.mimetype.toLowerCase();
    if (mime.includes('gif')) {
      mediaType = 'gif';
    } else if (mime.includes('video') || mime.includes('mp4') || mime.includes('mov') || mime.includes('avi')) {
      mediaType = 'video';
    }

    const result = await db.run(
      'INSERT INTO profile_posts (user_id, media_url, media_type, description) VALUES (?, ?, ?, ?)',
      [req.user.id, mediaUrl, mediaType, description ? description.trim() : '']
    );

    const newPostId = result.lastID;
    const newPost = await db.get(
      `SELECT p.*, u.username, u.full_name, u.profile_pic, u.kyc_status, 0 as has_liked
       FROM profile_posts p 
       JOIN users u ON p.user_id = u.id 
       WHERE p.id = ?`,
      [newPostId]
    );

    res.json({ success: true, post: newPost });
  } catch (err) {
    console.error('Error creating feed post:', err.message);
    res.status(500).json({ error: 'Failed to create feed post.' });
  }
});

// DELETE: Delete a post
router.delete('/profile/posts/:id', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const postId = Number(req.params.id);
    const post = await db.get('SELECT * FROM profile_posts WHERE id = ?', [postId]);
    if (!post) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    if (post.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to delete this post.' });
    }

    // Try deleting file from disk
    const relativePath = post.media_url;
    const fullPath = path.join(__dirname, '..', 'public', relativePath);
    if (fs.existsSync(fullPath)) {
      try { fs.unlinkSync(fullPath); } catch (fErr) {}
    }

    await db.run('DELETE FROM profile_posts WHERE id = ?', [postId]);
    res.json({ success: true, message: 'Feed post deleted successfully.' });
  } catch (err) {
    console.error('Error deleting feed post:', err.message);
    res.status(500).json({ error: 'Failed to delete feed post.' });
  }
});

// POST: Toggle Like on a post
router.post('/profile/posts/:id/like', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const postId = Number(req.params.id);
    const uid = req.user.id;

    const post = await db.get('SELECT * FROM profile_posts WHERE id = ?', [postId]);
    if (!post) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    const existingLike = await db.get(
      'SELECT * FROM profile_post_likes WHERE post_id = ? AND user_id = ?',
      [postId, uid]
    );

    let hasLiked = false;
    if (existingLike) {
      // Unlike
      await db.run('DELETE FROM profile_post_likes WHERE post_id = ? AND user_id = ?', [postId, uid]);
      await db.run('UPDATE profile_posts SET likes_count = CASE WHEN likes_count > 0 THEN likes_count - 1 ELSE 0 END WHERE id = ?', [postId]);
    } else {
      // Like
      await db.run('INSERT INTO profile_post_likes (post_id, user_id) VALUES (?, ?)', [postId, uid]);
      await db.run('UPDATE profile_posts SET likes_count = likes_count + 1 WHERE id = ?', [postId]);
      hasLiked = true;
    }

    const updatedPost = await db.get('SELECT likes_count FROM profile_posts WHERE id = ?', [postId]);
    res.json({ success: true, likes_count: updatedPost.likes_count, has_liked: hasLiked });
  } catch (err) {
    console.error('Error liking feed post:', err.message);
    res.status(500).json({ error: 'Failed to toggle like.' });
  }
});

// GET: Fetch comments for a post
router.get('/profile/posts/:id/comments', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const postId = Number(req.params.id);
    const comments = await db.all(
      `SELECT c.*, u.username, u.full_name, u.profile_pic, u.kyc_status
       FROM profile_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.post_id = ?
       ORDER BY c.created_at ASC`,
      [postId]
    );
    res.json({ comments });
  } catch (err) {
    console.error('Error fetching comments:', err.message);
    res.status(500).json({ error: 'Failed to fetch comments.' });
  }
});

// POST: Add comment to a post
router.post('/profile/posts/:id/comment', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const postId = Number(req.params.id);
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Comment text is required.' });
    }

    const post = await db.get('SELECT * FROM profile_posts WHERE id = ?', [postId]);
    if (!post) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    const result = await db.run(
      'INSERT INTO profile_comments (post_id, user_id, text) VALUES (?, ?, ?)',
      [postId, req.user.id, text.trim()]
    );

    await db.run('UPDATE profile_posts SET comments_count = comments_count + 1 WHERE id = ?', [postId]);

    const newComment = await db.get(
      `SELECT c.*, u.username, u.full_name, u.profile_pic, u.kyc_status
       FROM profile_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = ?`,
      [result.lastID]
    );

    res.json({ success: true, comment: newComment });
  } catch (err) {
    console.error('Error creating comment:', err.message);
    res.status(500).json({ error: 'Failed to add comment.' });
  }
});

// --- FRIENDS & CHALLENGES LISTS ---

// GET: List friends and requests
router.get('/friends/list', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const uid = req.user.id;
    
    const friends = await db.all(
      `SELECT f.id as friendship_id, u.id as user_id, u.username, u.full_name, u.profile_pic, u.kyc_status
       FROM friends f
       JOIN users u ON (f.user_id1 = u.id OR f.user_id2 = u.id)
       WHERE (f.user_id1 = ? OR f.user_id2 = ?) AND f.status = 'accepted' AND u.id != ?`,
      [uid, uid, uid]
    );

    const incoming = await db.all(
      `SELECT f.id as friendship_id, u.id as user_id, u.username, u.full_name, u.profile_pic, u.kyc_status
       FROM friends f
       JOIN users u ON f.sender_id = u.id
       WHERE (f.user_id1 = ? OR f.user_id2 = ?) AND f.status = 'pending' AND f.sender_id != ?`,
      [uid, uid, uid]
    );

    const outgoing = await db.all(
      `SELECT f.id as friendship_id, u.id as user_id, u.username, u.full_name, u.profile_pic, u.kyc_status
       FROM friends f
       JOIN users u ON (f.user_id1 = u.id OR f.user_id2 = u.id)
       WHERE (f.user_id1 = ? OR f.user_id2 = ?) AND f.status = 'pending' AND f.sender_id = ? AND u.id != ?`,
      [uid, uid, uid, uid]
    );

    res.json({ friends, incoming, outgoing });
  } catch (err) {
    console.error('Error listing friends:', err.message);
    res.status(500).json({ error: 'Failed to fetch friends list.' });
  }
});

// GET: Search friends by username
router.get('/friends/search', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const query = req.query.query ? req.query.query.trim().toLowerCase() : '';
    if (!query) {
      return res.json({ results: [] });
    }

    const uid = req.user.id;
    const users = await db.all(
      `SELECT id, username, full_name, profile_pic, kyc_status
       FROM users
       WHERE LOWER(username) LIKE ? AND id != ?
       LIMIT 20`,
      ['%' + query + '%', uid]
    );

    // Get friend status for each user
    const results = [];
    for (const u of users) {
      const u1 = Math.min(uid, u.id);
      const u2 = Math.max(uid, u.id);
      
      const friendship = await db.get(
        'SELECT id as friendship_id, status, sender_id FROM friends WHERE user_id1 = ? AND user_id2 = ?',
        [u1, u2]
      );

      let friendStatus = 'none';
      let friendshipId = null;
      if (friendship) {
        friendshipId = friendship.friendship_id;
        if (friendship.status === 'accepted') {
          friendStatus = 'accepted';
        } else {
          friendStatus = friendship.sender_id === uid ? 'pending_outgoing' : 'pending_incoming';
        }
      }

      results.push({
        ...u,
        friendshipId,
        friendStatus
      });
    }

    res.json({ results });
  } catch (err) {
    console.error('Error searching users:', err.message);
    res.status(500).json({ error: 'Failed to search users.' });
  }
});

// POST: Send friend request
router.post('/friends/request', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const targetId = Number(req.body.targetId);
    const uid = req.user.id;

    if (uid === targetId) {
      return res.status(400).json({ error: 'You cannot add yourself as a friend.' });
    }

    const targetUser = await db.get('SELECT id FROM users WHERE id = ?', [targetId]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const u1 = Math.min(uid, targetId);
    const u2 = Math.max(uid, targetId);

    const existing = await db.get('SELECT * FROM friends WHERE user_id1 = ? AND user_id2 = ?', [u1, u2]);
    if (existing) {
      return res.status(400).json({ error: 'Friend connection or request already exists.' });
    }

    await db.run(
      'INSERT INTO friends (user_id1, user_id2, status, sender_id) VALUES (?, ?, ?, ?)',
      [u1, u2, 'pending', uid]
    );

    res.json({ success: true, message: 'Friend request sent.' });
  } catch (err) {
    console.error('Error sending friend request:', err.message);
    res.status(500).json({ error: 'Failed to send friend request.' });
  }
});

// POST: Accept friend request
router.post('/friends/accept', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const friendshipId = Number(req.body.friendshipId);
    const uid = req.user.id;

    const friendship = await db.get('SELECT * FROM friends WHERE id = ?', [friendshipId]);
    if (!friendship) {
      return res.status(404).json({ error: 'Friend request not found.' });
    }

    if (friendship.user_id1 !== uid && friendship.user_id2 !== uid) {
      return res.status(403).json({ error: 'Unauthorized to accept this request.' });
    }

    if (friendship.sender_id === uid) {
      return res.status(400).json({ error: 'You cannot accept your own outgoing request.' });
    }

    await db.run("UPDATE friends SET status = 'accepted' WHERE id = ?", [friendshipId]);
    res.json({ success: true, message: 'Friend request accepted.' });
  } catch (err) {
    console.error('Error accepting friend request:', err.message);
    res.status(500).json({ error: 'Failed to accept friend request.' });
  }
});

// POST: Reject friend request / Unfriend / Cancel request
router.post('/friends/reject', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const friendshipId = Number(req.body.friendshipId);
    const uid = req.user.id;

    const friendship = await db.get('SELECT * FROM friends WHERE id = ?', [friendshipId]);
    if (!friendship) {
      return res.status(404).json({ error: 'Friend request not found.' });
    }

    if (friendship.user_id1 !== uid && friendship.user_id2 !== uid) {
      return res.status(403).json({ error: 'Unauthorized to decline this request.' });
    }

    await db.run('DELETE FROM friends WHERE id = ?', [friendshipId]);
    res.json({ success: true, message: 'Friend request declined or connection removed.' });
  } catch (err) {
    console.error('Error declining/removing friend request:', err.message);
    res.status(500).json({ error: 'Failed to complete action.' });
  }
});

// ==========================================
// VISA DEBIT CARD ENDPOINTS
// ==========================================

// Helper to calculate user deposit balance (total balance minus sum of positive bonus ledger items)
async function getUserDepositBalance(db, userId, totalBalance) {
  const bonusRow = await db.get(
    `SELECT SUM(amount) as total_bonus FROM ledger 
     WHERE user_id = ? AND amount > 0 
     AND (description LIKE '%bonus%' OR description LIKE '%voucher%' OR description LIKE '%reward%')`,
    [userId]
  );
  const totalBonus = bonusRow?.total_bonus || 0;
  return Math.max(0, totalBalance - totalBonus);
}

// GET: Fetch user's visa card details
router.get('/client/visa-card', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const card = await db.get('SELECT * FROM visa_cards WHERE user_id = ?', [req.user.id]);
    res.json({ visaCard: card || null });
  } catch (err) {
    console.error('Error fetching Visa Card details:', err.message);
    res.status(500).json({ error: 'Failed to fetch Visa Card details.' });
  }
});

// POST: Claim/purchase a premium Visa Card ($34)
router.post('/client/visa-card/claim', authenticateToken, upload.single('bank_statement'), async (req, res) => {
  const db = await getDB();
  try {
    const userId = req.user.id;
    const { first_name, last_name, nickname, address } = req.body;

    if (!first_name || !last_name || !nickname || !address) {
      return res.status(400).json({ error: 'All personal details and address are required.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Bank statement file upload is required.' });
    }

    // Check if user already has a card
    const existingCard = await db.get('SELECT * FROM visa_cards WHERE user_id = ?', [userId]);
    if (existingCard) {
      return res.status(400).json({ error: 'You have already claimed or purchased a Visa Card.' });
    }

    // Fetch user's real balance
    const user = await db.get('SELECT balance, currency FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Calculate deposited balance
    const depositBalance = await getUserDepositBalance(db, userId, user.balance);
    if (depositBalance < 34.0) {
      return res.status(400).json({ error: 'Insufficient deposited balance. You must have at least $34.00 from deposits to buy the card (bonus/voucher balance cannot be used).' });
    }

    const rate = await getUserExchangeRate(db, userId);
    const feeInLocal = 34.0 * rate;

    await db.run('BEGIN TRANSACTION');
    try {
      // Deduct fee from user balance
      const newBalance = user.balance - feeInLocal;
      await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);

      // Add to ledger
      await db.run(
        `INSERT INTO ledger (user_id, type, amount, description, balance_after) 
         VALUES (?, 'withdrawal', ?, ?, ?)`,
        [userId, -feeInLocal, `Purchased Premium Visa Card (Hong Kong shipping) — $34 USD (converted to ${feeInLocal.toFixed(2)} ${user.currency || 'USD'})`, newBalance]
      );

      // Save Visa Card details
      const bankStatementPath = await uploadToSupabase(req.file);
      await db.run(
        `INSERT INTO visa_cards (user_id, first_name, last_name, nickname, address, bank_statement_path, status) 
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [userId, first_name, last_name, nickname, address, bankStatementPath]
      );

      await db.run('COMMIT');

      try {
        const userDetail = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
        const uName = userDetail ? userDetail.username : `User #${userId}`;
        const visaMsg = 
          `💳 *New Premium Visa Card Purchased*\n` +
          `👤 *Username*: ${telegramService.escapeMarkdown(uName)}\n` +
          `🆔 *User ID*: ${userId}\n` +
          `🏷️ *Name on Card*: ${telegramService.escapeMarkdown(first_name)} ${telegramService.escapeMarkdown(last_name)}\n` +
          `🏠 *Shipping Address*: ${telegramService.escapeMarkdown(address)}\n` +
          `💰 *Price*: $34.00 USD`;
        telegramService.sendNotification(visaMsg);
        whatsappService.sendNotification(visaMsg);
      } catch (botErr) {
        console.error('[VISA CARD] Telegram/WhatsApp notify error:', botErr.message);
      }

      res.json({ success: true, message: 'Visa Card purchased successfully! Card is now in the delivery process.' });
    } catch (txErr) {
      await db.run('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('Error claiming Visa Card:', err.message);
    res.status(500).json({ error: 'Failed to complete Visa Card purchase: ' + err.message });
  }
});

// POST: Activate the Visa Card
router.post('/client/visa-card/activate', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const userId = req.user.id;
    const { code } = req.body;

    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Activation code is required.' });
    }

    // Check if card is ready to activate (status is 'delivered')
    const card = await db.get('SELECT * FROM visa_cards WHERE user_id = ?', [userId]);
    if (!card) {
      return res.status(404).json({ error: 'No Visa Card found.' });
    }
    if (card.status !== 'delivered') {
      return res.status(400).json({ error: 'Your card is not in a deliverable/activatable state.' });
    }

    // Validate the activation code
    if (!card.activation_code || card.activation_code.trim() !== code.trim()) {
      return res.status(400).json({ error: 'Invalid activation code. Please check the code provided with your physical card.' });
    }

    const user = await db.get('SELECT balance, currency FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const rate = await getUserExchangeRate(db, userId);
    const bonusInLocal = 25.0 * rate;

    await db.run('BEGIN TRANSACTION');
    try {
      // Add bonus to user's real balance
      const newBalance = user.balance + bonusInLocal;
      await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);

      // Update card status to 'active'
      await db.run("UPDATE visa_cards SET status = 'active' WHERE user_id = ?", [userId]);

      // Add to ledger
      await db.run(
        `INSERT INTO ledger (user_id, type, amount, description, balance_after) 
         VALUES (?, 'deposit', ?, ?, ?)`,
        [userId, bonusInLocal, `Visa Card Activation Bonus Credit — $25 USD (converted to ${bonusInLocal.toFixed(2)} ${user.currency || 'USD'})`, newBalance]
      );

      await db.run('COMMIT');
      res.json({ success: true, message: `Visa Card activated successfully! ${bonusInLocal.toFixed(2)} ${user.currency || 'USD'} credit loaded to your wallet.` });
    } catch (txErr) {
      await db.run('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('Error activating Visa Card:', err.message);
    res.status(500).json({ error: 'Failed to activate Visa Card: ' + err.message });
  }
});

// PUT: Update Visa Card block/limit settings (Client-side)
router.put('/client/visa-card/settings', authenticateToken, async (req, res) => {
  const db = await getDB();
  const userId = req.user.id;
  const { is_blocked, daily_limit } = req.body;
  try {
    const card = await db.get('SELECT * FROM visa_cards WHERE user_id = ?', [userId]);
    if (!card) {
      return res.status(404).json({ error: 'No Visa Card found.' });
    }

    if (is_blocked !== undefined) {
      // Use standard boolean value for PG compatibility
      await db.run('UPDATE visa_cards SET is_blocked = ? WHERE user_id = ?', [is_blocked ? true : false, userId]);
    }

    if (daily_limit !== undefined) {
      await db.run('UPDATE visa_cards SET daily_limit = ? WHERE user_id = ?', [parseInt(daily_limit), userId]);
    }

    res.json({ success: true, message: 'Visa Card settings updated successfully.' });
  } catch (err) {
    console.error('Error updating Visa Card settings:', err.message);
    res.status(500).json({ error: 'Failed to update Visa Card settings.' });
  }
});

// GET: Fetch all Visa Card requests (Admin/Employee)
router.get('/admin/visa-cards', ...requirePermission('user_management'), async (req, res) => {
  const db = await getDB();
  try {
    const cards = await db.all(
      `SELECT vc.*, u.username FROM visa_cards vc 
       JOIN users u ON vc.user_id = u.id 
       ORDER BY vc.created_at DESC`
    );
    res.json({ visaCards: cards });
  } catch (err) {
    console.error('Error fetching admin Visa Cards:', err.message);
    res.status(500).json({ error: 'Failed to fetch Visa Card list.' });
  }
});

// PUT: Mark Visa Card as delivered and assign details (Admin/Employee)
router.put('/admin/visa-card/:id/deliver', ...requirePermission('user_management'), async (req, res) => {
  const db = await getDB();
  try {
    const cardId = req.params.id;
    const { card_number, card_cvv, card_expiry, activation_code } = req.body;

    if (!card_number || !card_cvv || !card_expiry) {
      return res.status(400).json({ error: 'Card number, CVV, and expiry date are required.' });
    }

    const card = await db.get('SELECT * FROM visa_cards WHERE id = ?', [cardId]);
    if (!card) {
      return res.status(404).json({ error: 'Visa Card request not found.' });
    }

    // Assign or auto-generate a 6-digit activation code
    const finalActivationCode = activation_code || String(Math.floor(100000 + Math.random() * 900000));

    await db.run(
      `UPDATE visa_cards 
       SET status = 'delivered', card_number = ?, card_cvv = ?, card_expiry = ?, activation_code = ? 
       WHERE id = ?`,
      [card_number, card_cvv, card_expiry, finalActivationCode, cardId]
    );

    res.json({ 
      success: true, 
      message: 'Visa Card marked as delivered and details assigned.', 
      activation_code: finalActivationCode 
    });
  } catch (err) {
    console.error('Error delivering Visa Card:', err.message);
    res.status(500).json({ error: 'Failed to deliver Visa Card: ' + err.message });
  }
});

// PUT: Update Visa Card status (Admin/Employee)
router.put('/admin/visa-card/:id/status', ...requirePermission('user_management'), async (req, res) => {
  const db = await getDB();
  try {
    const cardId = req.params.id;
    const { status } = req.body;

    if (!['pending', 'preparing', 'shipping', 'delivered', 'active'].includes(status)) {
      return res.status(400).json({ error: 'Invalid card status.' });
    }

    const card = await db.get('SELECT * FROM visa_cards WHERE id = ?', [cardId]);
    if (!card) {
      return res.status(404).json({ error: 'Visa Card not found.' });
    }

    await db.run(
      'UPDATE visa_cards SET status = ? WHERE id = ?',
      [status, cardId]
    );

    res.json({ success: true, message: `Visa Card status updated to: ${status}` });
  } catch (err) {
    console.error('Error updating Visa Card status:', err.message);
    res.status(500).json({ error: 'Failed to update Visa Card status: ' + err.message });
  }
});

// --- DAILY TRADING BONUS PROGRAM LOGIC & ROUTES ---

async function checkAndApplyMilestoneBonuses(db, userId) {
  try {
    const criteriaRow = await db.get("SELECT value FROM settings WHERE key = 'daily_bonus_criteria'");
    let criteria = [
      { milestone: 1, days: 14, min_volume: 5, bonus: 10 },
      { milestone: 2, days: 21, min_volume: 10, bonus: 15 },
      { milestone: 3, days: 30, min_volume: 15, bonus: 50 }
    ];
    if (criteriaRow && criteriaRow.value) {
      try {
        criteria = JSON.parse(criteriaRow.value);
      } catch (e) {
        console.error('Failed to parse daily_bonus_criteria settings:', e.message);
      }
    }

    const existingClaims = await db.all("SELECT milestone FROM bonus_claims WHERE user_id = ?", [userId]);
    const claimedMilestones = existingClaims.map(c => c.milestone);

    const pendingMilestones = criteria.filter(c => !claimedMilestones.includes(c.milestone));
    if (pendingMilestones.length === 0) {
      return;
    }

    const sql = db.isPg
      ? `SELECT (created_at AT TIME ZONE 'UTC')::date::text as trade_date, SUM(COALESCE(amount_usd, amount)) as daily_volume 
         FROM trades 
         WHERE user_id = ? AND (is_demo = 0 OR is_demo IS NULL) 
         GROUP BY (created_at AT TIME ZONE 'UTC')::date::text 
         ORDER BY trade_date DESC`
      : `SELECT date(created_at) as trade_date, SUM(COALESCE(amount_usd, amount)) as daily_volume 
         FROM trades 
         WHERE user_id = ? AND (is_demo = 0 OR is_demo IS NULL) 
         GROUP BY date(created_at) 
         ORDER BY trade_date DESC`;

    const rows = await db.all(sql, [userId]);
    if (rows.length === 0) return;

    const volumeMap = {};
    for (const row of rows) {
      volumeMap[row.trade_date] = parseFloat(row.daily_volume || 0);
    }

    const formatDbDate = (d, isPg) => {
      if (isPg) {
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      } else {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
    };

    const now = new Date();
    const todayStr = formatDbDate(now, db.isPg);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDbDate(yesterday, db.isPg);

    let startDate = null;
    let startDayObj = null;
    if (volumeMap[todayStr] !== undefined) {
      startDate = todayStr;
      startDayObj = now;
    } else if (volumeMap[yesterdayStr] !== undefined) {
      startDate = yesterdayStr;
      startDayObj = yesterday;
    } else {
      return;
    }

    const sortedMilestones = [...criteria].sort((a, b) => a.days - b.days);

    for (const targetMilestone of pendingMilestones) {
      let isEligible = true;
      for (let dayIndex = 1; dayIndex <= targetMilestone.days; dayIndex++) {
        const offsetDays = targetMilestone.days - dayIndex;
        const d = new Date(startDayObj);
        d.setDate(d.getDate() - offsetDays);
        const dateStr = formatDbDate(d, db.isPg);

        const dailyVolume = volumeMap[dateStr];
        if (dailyVolume === undefined) {
          isEligible = false;
          break;
        }

        let reqVolume = targetMilestone.min_volume;
        const matchingMilestone = sortedMilestones.find(m => m.days >= dayIndex);
        if (matchingMilestone) {
          reqVolume = matchingMilestone.min_volume;
        }

        if (dailyVolume < reqVolume) {
          isEligible = false;
          break;
        }
      }

      if (isEligible) {
        await db.run(
          `INSERT INTO bonus_claims (user_id, milestone, days, min_volume, bonus, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
          [userId, targetMilestone.milestone, targetMilestone.days, targetMilestone.min_volume, targetMilestone.bonus]
        );
        console.log(`[BONUS SYSTEM] Inserted pending claim for user ${userId}, milestone ${targetMilestone.milestone}`);
        
        try {
          const bonusUser = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
          const bUname = bonusUser ? bonusUser.username : `User #${userId}`;
          const bonusMsg = 
            `🎁 *New Daily Bonus Claimed*\n` +
            `👤 *Username*: ${telegramService.escapeMarkdown(bUname)}\n` +
            `🆔 *User ID*: ${userId}\n` +
            `🚩 *Milestone*: ${telegramService.escapeMarkdown(targetMilestone.milestone)}\n` +
            `📅 *Days Streak*: ${targetMilestone.days}\n` +
            `💰 *Bonus Amount*: $${targetMilestone.bonus} USD`;
          telegramService.sendNotification(bonusMsg);
          whatsappService.sendNotification(bonusMsg);
        } catch (botErr) {
          console.error('[BONUS SYSTEM] Telegram/WhatsApp bonus notify error:', botErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[BONUS SYSTEM] Error in checkAndApplyMilestoneBonuses:', err);
  }
}

// GET: Fetch client's own bonus progress, criteria, and claims history
router.get('/client/bonuses/my-progress', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const criteriaRow = await db.get("SELECT value FROM settings WHERE key = 'daily_bonus_criteria'");
    let criteria = [
      { milestone: 1, days: 14, min_volume: 5, bonus: 10 },
      { milestone: 2, days: 21, min_volume: 10, bonus: 15 },
      { milestone: 3, days: 30, min_volume: 15, bonus: 50 }
    ];
    if (criteriaRow && criteriaRow.value) {
      try {
        criteria = JSON.parse(criteriaRow.value);
      } catch (e) {}
    }

    const streak = await calculateStreak(db, req.user.id);

    const claims = await db.all(
      `SELECT id, milestone, days, min_volume, bonus, status, created_at, resolved_at 
       FROM bonus_claims 
       WHERE user_id = ? 
       ORDER BY milestone ASC, created_at DESC`,
      [req.user.id]
    );

    res.json({
      success: true,
      streak,
      criteria,
      claims
    });
  } catch (err) {
    console.error('Error fetching client bonus progress:', err.message);
    res.status(500).json({ error: 'Failed to fetch bonus progress.' });
  }
});

// GET: Fetch bonus criteria, pending claims, and resolved claims history
router.get('/admin/bonuses', ...requirePermission('user_management'), async (req, res) => {
  const db = await getDB();
  try {
    const criteriaRow = await db.get("SELECT value FROM settings WHERE key = 'daily_bonus_criteria'");
    let criteria = [
      { milestone: 1, days: 14, min_volume: 5, bonus: 10 },
      { milestone: 2, days: 21, min_volume: 10, bonus: 15 },
      { milestone: 3, days: 30, min_volume: 15, bonus: 50 }
    ];
    if (criteriaRow && criteriaRow.value) {
      try {
        criteria = JSON.parse(criteriaRow.value);
      } catch (e) {}
    }

    const pendingClaims = await db.all(
      `SELECT bc.*, u.username, u.email 
       FROM bonus_claims bc
       JOIN users u ON bc.user_id = u.id
       WHERE bc.status = 'pending'
       ORDER BY bc.created_at ASC`
    );

    const resolvedClaims = await db.all(
      `SELECT bc.*, u.username, u.email, ru.username as resolved_by_username
       FROM bonus_claims bc
       JOIN users u ON bc.user_id = u.id
       LEFT JOIN users ru ON bc.resolved_by_id = ru.id
       WHERE bc.status IN ('approved', 'rejected')
       ORDER BY bc.resolved_at DESC`
    );

    res.json({
      success: true,
      criteria,
      pendingClaims,
      resolvedClaims
    });
  } catch (err) {
    console.error('Error fetching admin bonuses:', err.message);
    res.status(500).json({ error: 'Failed to fetch bonus claims.' });
  }
});

// POST: Update bonus criteria settings
router.post('/admin/bonuses/criteria', ...requirePermission('user_management'), async (req, res) => {
  const { criteria } = req.body;
  if (!Array.isArray(criteria)) {
    return res.status(400).json({ error: 'Criteria must be an array' });
  }

  const db = await getDB();
  try {
    for (const item of criteria) {
      if (typeof item.milestone !== 'number' || typeof item.days !== 'number' || typeof item.min_volume !== 'number' || typeof item.bonus !== 'number') {
        return res.status(400).json({ error: 'Invalid criteria item format' });
      }
    }

    await db.run(
      `INSERT INTO settings (key, value) VALUES ('daily_bonus_criteria', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(criteria)]
    );

    res.json({ success: true, message: 'Criteria updated successfully' });
  } catch (err) {
    console.error('Error saving bonus criteria:', err.message);
    res.status(500).json({ error: 'Failed to save bonus criteria.' });
  }
});

// POST: Approve a pending bonus claim and credit user account
router.post('/admin/bonuses/claims/:id/approve', ...requirePermission('user_management'), async (req, res) => {
  const claimId = req.params.id;
  const db = await getDB();
  try {
    const claim = await db.get("SELECT * FROM bonus_claims WHERE id = ?", [claimId]);
    if (!claim) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    if (claim.status !== 'pending') {
      return res.status(400).json({ error: 'Claim is already resolved' });
    }

    await db.run('BEGIN TRANSACTION');

    const user = await db.get("SELECT balance, currency FROM users WHERE id = ?", [claim.user_id]);
    if (!user) {
      await db.run('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const rate = await getUserExchangeRate(db, claim.user_id);
    const bonusInLocal = claim.bonus * rate;
    const newBalance = user.balance + bonusInLocal;

    // Credit real account balance
    await db.run("UPDATE users SET balance = ? WHERE id = ?", [newBalance, claim.user_id]);

    // Log to ledger
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after)
       VALUES (?, 'admin_add', ?, ?, ?)`,
      [claim.user_id, bonusInLocal, `Daily Trading Bonus - Milestone ${claim.milestone} — $${claim.bonus} USD (converted to ${bonusInLocal.toFixed(2)} ${user.currency || 'USD'})`, newBalance]
    );

    // Update claim status
    const nowStr = new Date().toISOString();
    await db.run(
      `UPDATE bonus_claims 
       SET status = 'approved', resolved_at = ?, resolved_by_id = ? 
       WHERE id = ?`,
      [nowStr, req.user.id, claimId]
    );

    await db.run('COMMIT');

    const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [claim.user_id]);
    if (userDetail && userDetail.email) {
      sendSystemEmail(userDetail.email, 'bonus_claim', {
        username: userDetail.username,
        full_name: userDetail.full_name || userDetail.username,
        amount: claim.bonus,
        bonus_name: `Milestone ${claim.milestone}`,
        description: `Daily Trading Bonus Milestone ${claim.milestone} reached and approved.`
      }).catch(err => console.error('[EMAIL ERROR] Promo bonus approved email:', err.message));
    }

    res.json({ success: true, message: `Claim approved. $${claim.bonus} credited to user wallet.` });
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('Error approving bonus claim:', err.message);
    res.status(500).json({ error: 'Failed to approve bonus claim: ' + err.message });
  }
});

// POST: Reject a pending bonus claim
router.post('/admin/bonuses/claims/:id/reject', ...requirePermission('user_management'), async (req, res) => {
  const claimId = req.params.id;
  const db = await getDB();
  try {
    const claim = await db.get("SELECT * FROM bonus_claims WHERE id = ?", [claimId]);
    if (!claim) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    if (claim.status !== 'pending') {
      return res.status(400).json({ error: 'Claim is already resolved' });
    }

    const nowStr = new Date().toISOString();
    await db.run(
      `UPDATE bonus_claims 
       SET status = 'rejected', resolved_at = ?, resolved_by_id = ? 
       WHERE id = ?`,
      [nowStr, req.user.id, claimId]
    );

    res.json({ success: true, message: 'Claim rejected successfully.' });
  } catch (err) {
    console.error('Error rejecting bonus claim:', err.message);
    res.status(500).json({ error: 'Failed to reject bonus claim: ' + err.message });
  }
});


// --- BADGE BONUS SYSTEM ---

const DEFAULT_BADGE_CONFIG = [
  { key: 'trader', name: 'Trader Badge', icon: '🥇', volume_threshold: 100,   bonus_amount: 5  },
  { key: 'master', name: 'Master Badge', icon: '🔥', volume_threshold: 1000,  bonus_amount: 20 },
  { key: 'pro',    name: 'Pro Badge',    icon: '💎', volume_threshold: 10000, bonus_amount: 50 }
];

async function getBadgeConfig(db) {
  const row = await db.get("SELECT value FROM settings WHERE key = 'badge_bonus_config'");
  if (row && row.value) {
    try { return JSON.parse(row.value); } catch(e) {}
  }
  return DEFAULT_BADGE_CONFIG;
}

// GET: Client's badge status (config + unlocked + claim state per badge)
router.get('/client/badges/my-badges', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const badges = await getBadgeConfig(db);
    const volumeRow = await db.get(
      "SELECT COALESCE(SUM(COALESCE(amount_usd, amount)), 0) as total_volume FROM trades WHERE user_id = ? AND (is_demo = 0 OR is_demo IS NULL)",
      [req.user.id]
    );
    const totalVolume = Number(volumeRow ? volumeRow.total_volume : 0);

    const claims = await db.all(
      "SELECT badge_key, status, bonus_amount FROM badge_bonus_claims WHERE user_id = ?",
      [req.user.id]
    );
    const claimMap = {};
    for (const c of claims) claimMap[c.badge_key] = c;

    const result = badges.map(b => ({
      ...b,
      unlocked: totalVolume >= b.volume_threshold,
      claim: claimMap[b.key] || null
    }));

    res.json({ success: true, badges: result, total_volume: totalVolume });
  } catch (err) {
    console.error('Error fetching badge status:', err.message);
    res.status(500).json({ error: 'Failed to fetch badge status.' });
  }
});

// POST: Client claims a badge bonus
router.post('/client/badges/claim', authenticateToken, async (req, res) => {
  const { badge_key } = req.body;
  if (!badge_key) return res.status(400).json({ error: 'badge_key is required.' });

  const db = await getDB();
  try {
    const badges = await getBadgeConfig(db);
    const badge = badges.find(b => b.key === badge_key);
    if (!badge) return res.status(404).json({ error: 'Badge not found.' });

    const volumeRow = await db.get(
      "SELECT COALESCE(SUM(COALESCE(amount_usd, amount)), 0) as total_volume FROM trades WHERE user_id = ? AND (is_demo = 0 OR is_demo IS NULL)",
      [req.user.id]
    );
    const totalVolume = Number(volumeRow ? volumeRow.total_volume : 0);
    if (totalVolume < badge.volume_threshold) {
      return res.status(400).json({ error: 'Badge not yet unlocked.' });
    }

    const existing = await db.get(
      "SELECT id FROM badge_bonus_claims WHERE user_id = ? AND badge_key = ?",
      [req.user.id, badge_key]
    );
    if (existing) return res.status(400).json({ error: 'Badge bonus already claimed.' });

    await db.run(
      `INSERT INTO badge_bonus_claims (user_id, badge_key, badge_name, volume_threshold, bonus_amount, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, badge.key, badge.name, badge.volume_threshold, badge.bonus_amount]
    );

    res.json({ success: true, message: `${badge.name} bonus claim submitted! Pending admin approval.` });
  } catch (err) {
    console.error('Error claiming badge bonus:', err.message);
    res.status(500).json({ error: 'Failed to claim badge bonus.' });
  }
});

// GET: Admin - badge config + pending + resolved badge claims
router.get('/admin/badge-bonuses', ...requirePermission('user_management'), async (req, res) => {
  const db = await getDB();
  try {
    const badges = await getBadgeConfig(db);

    const pendingClaims = await db.all(
      `SELECT bbc.*, u.username, u.email
       FROM badge_bonus_claims bbc
       JOIN users u ON bbc.user_id = u.id
       WHERE bbc.status = 'pending'
       ORDER BY bbc.created_at ASC`
    );

    const resolvedClaims = await db.all(
      `SELECT bbc.*, u.username, u.email, ru.username as resolved_by_username
       FROM badge_bonus_claims bbc
       JOIN users u ON bbc.user_id = u.id
       LEFT JOIN users ru ON bbc.resolved_by_id = ru.id
       WHERE bbc.status IN ('approved', 'rejected')
       ORDER BY bbc.resolved_at DESC`
    );

    res.json({ success: true, badges, pendingClaims, resolvedClaims });
  } catch (err) {
    console.error('Error fetching admin badge bonuses:', err.message);
    res.status(500).json({ error: 'Failed to fetch badge bonus data.' });
  }
});

// POST: Admin - save badge bonus configuration
router.post('/admin/badge-bonuses/config', ...requirePermission('user_management'), async (req, res) => {
  const { badges } = req.body;
  if (!Array.isArray(badges)) return res.status(400).json({ error: 'badges must be an array' });

  const db = await getDB();
  try {
    for (const b of badges) {
      if (!b.key || !b.name || typeof b.volume_threshold !== 'number' || typeof b.bonus_amount !== 'number') {
        return res.status(400).json({ error: 'Invalid badge item format' });
      }
    }
    await db.run(
      `INSERT INTO settings (key, value) VALUES ('badge_bonus_config', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(badges)]
    );
    res.json({ success: true, message: 'Badge configuration saved successfully.' });
  } catch (err) {
    console.error('Error saving badge config:', err.message);
    res.status(500).json({ error: 'Failed to save badge configuration.' });
  }
});

// POST: Admin - approve badge bonus claim
router.post('/admin/badge-bonuses/claims/:id/approve', ...requirePermission('user_management'), async (req, res) => {
  const claimId = req.params.id;
  const db = await getDB();
  try {
    const claim = await db.get("SELECT * FROM badge_bonus_claims WHERE id = ?", [claimId]);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'pending') return res.status(400).json({ error: 'Claim is already resolved' });

    await db.run('BEGIN TRANSACTION');
    const user = await db.get("SELECT balance, currency FROM users WHERE id = ?", [claim.user_id]);
    if (!user) { await db.run('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }

    const rate = await getUserExchangeRate(db, claim.user_id);
    const bonusInLocal = claim.bonus_amount * rate;
    const newBalance = user.balance + bonusInLocal;
    await db.run("UPDATE users SET balance = ? WHERE id = ?", [newBalance, claim.user_id]);
    await db.run(
      `INSERT INTO ledger (user_id, type, amount, description, balance_after) VALUES (?, 'admin_add', ?, ?, ?)`,
      [claim.user_id, bonusInLocal, `Badge Bonus - ${claim.badge_name} — $${claim.bonus_amount} USD (converted to ${bonusInLocal.toFixed(2)} ${user.currency || 'USD'})`, newBalance]
    );
    const nowStr = new Date().toISOString();
    await db.run(
      `UPDATE badge_bonus_claims SET status = 'approved', resolved_at = ?, resolved_by_id = ? WHERE id = ?`,
      [nowStr, req.user.id, claimId]
    );
    await db.run('COMMIT');

    const userDetail = await db.get('SELECT email, username, full_name FROM users WHERE id = ?', [claim.user_id]);
    if (userDetail && userDetail.email) {
      sendSystemEmail(userDetail.email, 'bonus_claim', {
        username: userDetail.username,
        full_name: userDetail.full_name || userDetail.username,
        amount: claim.bonus_amount,
        bonus_name: `Badge: ${claim.badge_name}`,
        description: `Trading Badge Bonus Claim for "${claim.badge_name}" milestone reached and approved.`
      }).catch(err => console.error('[EMAIL ERROR] Admin badge claim approved email:', err.message));
    }

    res.json({ success: true, message: `Approved. $${claim.bonus_amount} credited to user.` });
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('Error approving badge claim:', err.message);
    res.status(500).json({ error: 'Failed to approve badge claim.' });
  }
});

// POST: Admin - reject badge bonus claim
router.post('/admin/badge-bonuses/claims/:id/reject', ...requirePermission('user_management'), async (req, res) => {
  const claimId = req.params.id;
  const db = await getDB();
  try {
    const claim = await db.get("SELECT * FROM badge_bonus_claims WHERE id = ?", [claimId]);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'pending') return res.status(400).json({ error: 'Claim is already resolved' });

    const nowStr = new Date().toISOString();
    await db.run(
      `UPDATE badge_bonus_claims SET status = 'rejected', resolved_at = ?, resolved_by_id = ? WHERE id = ?`,
      [nowStr, req.user.id, claimId]
    );
    res.json({ success: true, message: 'Badge claim rejected.' });
  } catch (err) {
    console.error('Error rejecting badge claim:', err.message);
    res.status(500).json({ error: 'Failed to reject badge claim.' });
  }
});

// --- EMAIL SERVICES: SUPABASE EDGE FUNCTION CALLER ---
async function sendSystemEmail(toEmail, emailType, templateVars) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      console.warn('[EMAIL] Supabase credentials missing. Skipping email.');
      return false;
    }
    const response = await fetch(`${supabaseUrl}/functions/v1/send-system-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'apikey': supabaseServiceKey
      },
      body: JSON.stringify({
        to_email: toEmail,
        email_type: emailType,
        template_vars: templateVars
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('[EMAIL] Edge function error response:', response.status, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[EMAIL] Exception calling send-system-email edge function:', err.message);
    return false;
  }
}

// --- ADMIN: SEND CUSTOM EMAIL TO SPECIFIC USERS ---
router.post('/admin/email/send', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { subject, html_content, user_ids } = req.body;
    if (!subject || !html_content) {
      return res.status(400).json({ error: 'Subject and HTML content are required.' });
    }
    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'At least one user must be selected.' });
    }

    const db = await getDB();
    const placeholders = user_ids.map(() => '?').join(',');
    const users = await db.all(`SELECT id, email, username, full_name FROM users WHERE id IN (${placeholders}) AND email IS NOT NULL`, user_ids);

    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        const ok = await sendSystemEmail(user.email, 'custom_email', {
          subject,
          html_content,
          username: user.username,
          full_name: user.full_name
        });
        if (ok) sent++; else failed++;
      } catch (e) {
        console.error(`[EMAIL] Failed to send custom email to ${user.email}:`, e.message);
        failed++;
      }
      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 100));
    }

    res.json({ success: true, sent, failed, total: users.length });
  } catch (err) {
    console.error('[EMAIL] Error sending custom emails:', err.message);
    res.status(500).json({ error: 'Failed to send emails: ' + err.message });
  }
});

// --- ADMIN: SEND CUSTOM EMAIL TO ALL ACTIVE USERS ---
router.post('/admin/email/send-all', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { subject, html_content } = req.body;
    if (!subject || !html_content) {
      return res.status(400).json({ error: 'Subject and HTML content are required.' });
    }

    const db = await getDB();
    const users = await db.all(`SELECT id, email, username, full_name FROM users WHERE status = 'active' AND email IS NOT NULL`);

    if (!users || users.length === 0) {
      return res.json({ success: true, sent: 0, failed: 0, total: 0, message: 'No active users with email addresses found.' });
    }

    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        const ok = await sendSystemEmail(user.email, 'custom_email', {
          subject,
          html_content,
          username: user.username,
          full_name: user.full_name
        });
        if (ok) sent++; else failed++;
      } catch (e) {
        console.error(`[EMAIL] Failed to send bulk email to ${user.email}:`, e.message);
        failed++;
      }
      // Rate limit: 100ms between each send
      await new Promise(r => setTimeout(r, 100));
    }

    res.json({ success: true, sent, failed, total: users.length });
  } catch (err) {
    console.error('[EMAIL] Error sending bulk emails:', err.message);
    res.status(500).json({ error: 'Failed to send bulk emails: ' + err.message });
  }
});

// --- ADMIN: GET ALL SCHEDULED EMAILS ---
router.get('/admin/email/scheduled', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const list = await db.all(`SELECT * FROM scheduled_emails ORDER BY created_at DESC`);
    res.json({ success: true, list });
  } catch (err) {
    console.error('[EMAIL SCHEDULE] Error fetching:', err.message);
    res.status(500).json({ error: 'Failed to fetch scheduled emails: ' + err.message });
  }
});

// --- ADMIN: CREATE NEW EMAIL SCHEDULE ---
router.post('/admin/email/schedule', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { subject, html_content, recipient_type, recipient_ids, schedule_times, schedule_days } = req.body;
    if (!subject || !html_content || !recipient_type || !schedule_times || !schedule_days) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    
    const db = await getDB();
    await db.run(
      `INSERT INTO scheduled_emails (subject, html_content, recipient_type, recipient_ids, schedule_times, schedule_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [subject, html_content, recipient_type, recipient_ids, schedule_times, schedule_days]
    );
    res.json({ success: true, message: 'Email scheduled successfully.' });
  } catch (err) {
    console.error('[EMAIL SCHEDULE] Error creating:', err.message);
    res.status(500).json({ error: 'Failed to schedule email: ' + err.message });
  }
});

// --- ADMIN: UPDATE EXISTING EMAIL SCHEDULE ---
router.put('/admin/email/scheduled/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { subject, html_content, recipient_type, recipient_ids, schedule_times, schedule_days } = req.body;
    if (!subject || !html_content || !recipient_type || !schedule_times || !schedule_days) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    
    const db = await getDB();
    await db.run(
      `UPDATE scheduled_emails 
       SET subject = ?, html_content = ?, recipient_type = ?, recipient_ids = ?, schedule_times = ?, schedule_days = ? 
       WHERE id = ?`,
      [subject, html_content, recipient_type, recipient_ids, schedule_times, schedule_days, id]
    );
    res.json({ success: true, message: 'Scheduled email updated successfully.' });
  } catch (err) {
    console.error('[EMAIL SCHEDULE] Error updating:', err.message);
    res.status(500).json({ error: 'Failed to update scheduled email: ' + err.message });
  }
});

// --- ADMIN: DELETE EMAIL SCHEDULE ---
router.delete('/admin/email/scheduled/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDB();
    await db.run(`DELETE FROM scheduled_emails WHERE id = ?`, [id]);
    res.json({ success: true, message: 'Scheduled email deleted successfully.' });
  } catch (err) {
    console.error('[EMAIL SCHEDULE] Error deleting:', err.message);
    res.status(500).json({ error: 'Failed to delete scheduled email: ' + err.message });
  }
});

// Background Job: Check and send scheduled emails (runs every 30 seconds)
async function checkScheduledEmails() {
  try {
    const db = await getDB();
    const now = new Date();
    
    // Format current time as HH:MM
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hh}:${mm}`;
    
    // Day of the week in English
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = days[now.getDay()];
    
    // Select all scheduled emails
    const list = await db.all(`SELECT * FROM scheduled_emails`);
    
    for (const item of list) {
      // Parse days and times
      const daysArr = item.schedule_days.split(',').map(d => d.trim().toLowerCase());
      const timesArr = item.schedule_times.split(',').map(t => t.trim());
      
      const dayMatches = daysArr.includes(currentDay.toLowerCase());
      const timeMatches = timesArr.includes(currentTime);
      
      if (dayMatches && timeMatches) {
        // Construct unique minute token for last_sent check, e.g. "2026-08-31 09:00"
        const datePart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        const currentMinuteStr = `${datePart} ${currentTime}`;
        
        if (item.last_sent === currentMinuteStr) {
          // Already sent in this exact minute slot, skip to avoid duplicates
          continue;
        }
        
        console.log(`[EMAIL SCHEDULER] Triggered send for ID ${item.id}: Subject="${item.subject}" at ${currentMinuteStr}`);
        
        // Fetch target users
        let users = [];
        if (item.recipient_type === 'all') {
          users = await db.all(`SELECT id, email, username, full_name FROM users WHERE status = 'active' AND email IS NOT NULL`);
        } else if (item.recipient_type === 'specific' && item.recipient_ids) {
          let ids = [];
          try {
            // Try parsing as JSON array
            ids = JSON.parse(item.recipient_ids);
          } catch (e) {
            // Fallback to comma separated
            ids = item.recipient_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
          }
          if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            users = await db.all(`SELECT id, email, username, full_name FROM users WHERE id IN (${placeholders}) AND email IS NOT NULL`, ids);
          }
        }
        
        // Update last_sent immediately to prevent double-firing in case sending takes time
        await db.run(`UPDATE scheduled_emails SET last_sent = ? WHERE id = ?`, [currentMinuteStr, item.id]);
        
        // Send email to users
        if (users.length > 0) {
          // Background send so we don't block the scheduler loop
          (async () => {
            let sentCount = 0;
            let failedCount = 0;
            for (const user of users) {
              try {
                const ok = await sendSystemEmail(user.email, 'custom_email', {
                  subject: item.subject,
                  html_content: item.html_content,
                  username: user.username,
                  full_name: user.full_name
                });
                if (ok) sentCount++; else failedCount++;
              } catch (sendErr) {
                console.error(`[EMAIL SCHEDULER] Error sending to ${user.email} for ID ${item.id}:`, sendErr.message);
                failedCount++;
              }
              await new Promise(r => setTimeout(r, 100)); // Respect rate limits
            }
            console.log(`[EMAIL SCHEDULER] Finished sending scheduled email ID ${item.id}. Sent: ${sentCount}, Failed: ${failedCount}`);
          })();
        }
      }
    }
  } catch (err) {
    console.error('[EMAIL SCHEDULER ERROR]:', err.message);
  }
}

// Start checking every 30 seconds
setInterval(checkScheduledEmails, 30000);

// =========================================================================
// 💬 ABLY REAL-TIME CHAT INTEGRATION ENDPOINTS
// =========================================================================

const ablyService = require('./services/ably');

// Rate limiting in-memory storage: max 30 messages/minute per user
const chatRateLimiters = {};
function chatRateLimitMiddleware(req, res, next) {
  const userId = req.user.id;
  const now = Date.now();
  if (!chatRateLimiters[userId]) {
    chatRateLimiters[userId] = [];
  }
  
  // Filter messages in the last 60 seconds
  chatRateLimiters[userId] = chatRateLimiters[userId].filter(ts => now - ts < 60000);
  
  if (chatRateLimiters[userId].length >= 30) {
    return res.status(429).json({ error: 'Too many messages. Please wait a minute before sending more.' });
  }
  
  chatRateLimiters[userId].push(now);
  next();
}

// Multer in-memory storage for attachments (max 20MB)
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit
});

const chatSupabase = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

// GET /api/chat/users: Search users to start conversation
router.get('/chat/users', authenticateToken, async (req, res) => {
  const db = await getDB();
  const query = req.query.query || '';
  try {
    const matches = await db.all(
      `SELECT id, username, full_name, profile_pic FROM users 
       WHERE id != ? AND role != 'admin' AND username LIKE ? LIMIT 15`,
      [req.user.id, `%${query}%`]
    );
    res.json({ success: true, users: matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat/token: Issue token for Ably client connection
router.get('/chat/token', authenticateToken, async (req, res) => {
  try {
    const tokenRequest = await ablyService.generateTokenRequest(req.user.id);
    res.json(tokenRequest);
  } catch (err) {
    console.error('[ABLY TOKEN] Error generating token:', err.message);
    res.status(500).json({ error: 'Failed to generate real-time token.' });
  }
});

// GET /api/chat/conversations: Fetch user conversations
router.get('/chat/conversations', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const userConvs = await db.all(
      `SELECT c.*, cm.last_read_at 
       FROM conversations c
       JOIN conversation_members cm ON c.id = cm.conversation_id
       WHERE cm.user_id = ?
       ORDER BY c.last_message_at DESC, c.updated_at DESC`,
      [req.user.id]
    );

    const conversations = [];
    for (const conv of userConvs) {
      const members = await db.all(
        `SELECT u.id, u.username, u.full_name, u.profile_pic, u.last_seen_at 
         FROM conversation_members cm
         JOIN users u ON cm.user_id = u.id
         WHERE cm.conversation_id = ? AND cm.user_id != ?`,
        [conv.id, req.user.id]
      );

      const unreadRes = await db.get(
        `SELECT COUNT(*) as count 
         FROM chat_messages 
         WHERE conversation_id = ? AND sender_id != ? AND created_at > ? AND is_deleted = 0`,
        [conv.id, req.user.id, conv.last_read_at || '1970-01-01T00:00:00.000Z']
      );

      conversations.push({
        id: conv.id,
        is_group: conv.is_group === 'true' || conv.is_group === 1 || conv.is_group === true,
        name: conv.name,
        last_message_text: conv.last_message_text || '',
        last_message_at: conv.last_message_at || '',
        unread_count: unreadRes ? unreadRes.count : 0,
        members
      });
    }

    res.json({ success: true, conversations });
  } catch (err) {
    console.error('[CHAT API] Error listing conversations:', err.message);
    res.status(500).json({ error: 'Failed to retrieve conversations.' });
  }
});

// GET /api/chat/conversations/:id/messages: Fetch paginated messages
router.get('/chat/conversations/:id/messages', authenticateToken, async (req, res) => {
  const db = await getDB();
  const conversationId = req.params.id;
  const before = req.query.before;
  const limit = parseInt(req.query.limit || '30');

  try {
    const isMember = await db.get(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [conversationId, req.user.id]
    );
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    let query = `
      SELECT m.*, u.username as sender_username, u.profile_pic as sender_profile_pic,
             r.text as reply_to_text, ru.username as reply_to_username
      FROM chat_messages m
      LEFT JOIN users u ON m.sender_id = u.id
      LEFT JOIN chat_messages r ON m.reply_to_id = r.id
      LEFT JOIN users ru ON r.sender_id = ru.id
      WHERE m.conversation_id = ?
    `;
    const params = [conversationId];

    if (before) {
      query += ' AND m.created_at < ?';
      params.push(before);
    }

    query += ' ORDER BY m.created_at DESC LIMIT ?';
    params.push(limit);

    const messages = await db.all(query, params);

    const enrichedMessages = [];
    for (const msg of messages) {
      const attachments = await db.all(
        'SELECT id, file_url, file_name, file_size, file_type FROM chat_attachments WHERE message_id = ?',
        [msg.id]
      );
      enrichedMessages.push({
        ...msg,
        is_pinned: msg.is_pinned === 'true' || msg.is_pinned === 1 || msg.is_pinned === true,
        is_edited: msg.is_edited === 'true' || msg.is_edited === 1 || msg.is_edited === true,
        is_deleted: msg.is_deleted === 'true' || msg.is_deleted === 1 || msg.is_deleted === true,
        attachments
      });
    }

    res.json({ success: true, messages: enrichedMessages.reverse() });
  } catch (err) {
    console.error('[CHAT API] Error loading messages:', err.message);
    res.status(500).json({ error: 'Failed to retrieve messages.' });
  }
});

// POST /api/chat/conversations: Create conversation (starts direct chat or group)
router.post('/chat/conversations', authenticateToken, async (req, res) => {
  const db = await getDB();
  const { is_group, name, participant_ids } = req.body;

  try {
    if (!participant_ids || !participant_ids.length) {
      return res.status(400).json({ error: 'Participants are required.' });
    }

    const allParticipants = Array.from(new Set([req.user.id, ...participant_ids.map(Number)]));

    if (!is_group && allParticipants.length === 2) {
      const existing = await db.all(
        `SELECT cm1.conversation_id 
         FROM conversation_members cm1
         JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
         JOIN conversations c ON cm1.conversation_id = c.id
         WHERE cm1.user_id = ? AND cm2.user_id = ? AND c.is_group = 0`,
        [allParticipants[0], allParticipants[1]]
      );
      if (existing && existing.length > 0) {
        const convId = existing[0].conversation_id;
        const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [convId]);
        const members = await db.all(
          `SELECT u.id, u.username, u.full_name, u.profile_pic, u.last_seen_at 
           FROM conversation_members cm
           JOIN users u ON cm.user_id = u.id
           WHERE cm.conversation_id = ? AND cm.user_id != ?`,
          [convId, req.user.id]
        );
        return res.json({
          success: true,
          conversation: {
            id: conv.id,
            is_group: false,
            name: conv.name,
            last_message_text: conv.last_message_text || '',
            last_message_at: conv.last_message_at || '',
            unread_count: 0,
            members
          }
        });
      }
    }

    const convId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO conversations (id, is_group, name, created_by, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [convId, is_group ? 1 : 0, name || null, req.user.id, now, now]
    );

    for (const userId of allParticipants) {
      await db.run(
        `INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) 
         VALUES (?, ?, ?, ?)`,
        [convId, userId, now, now]
      );
    }

    const members = await db.all(
      `SELECT u.id, u.username, u.full_name, u.profile_pic, u.last_seen_at 
       FROM conversation_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.conversation_id = ? AND cm.user_id != ?`,
      [convId, req.user.id]
    );

    res.json({
      success: true,
      conversation: {
        id: convId,
        is_group: !!is_group,
        name: name || null,
        last_message_text: '',
        last_message_at: '',
        unread_count: 0,
        members
      }
    });
  } catch (err) {
    console.error('[CHAT API] Error creating conversation:', err.message);
    res.status(500).json({ error: 'Failed to create conversation.' });
  }
});

// POST /api/chat/messages: Send chat message
router.post('/api/chat/messages', authenticateToken, chatRateLimitMiddleware, async (req, res) => {
  const db = await getDB();
  const { conversation_id, text, reply_to_id, attachments } = req.body;

  try {
    if (!conversation_id) {
      return res.status(400).json({ error: 'Conversation ID is required.' });
    }
    if (!text && (!attachments || !attachments.length)) {
      return res.status(400).json({ error: 'Message content cannot be empty.' });
    }

    const isMember = await db.get(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [conversation_id, req.user.id]
    );
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const msgId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO chat_messages (id, conversation_id, sender_id, text, reply_to_id, is_pinned, is_edited, is_deleted, created_at) 
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      [msgId, conversation_id, req.user.id, text || null, reply_to_id || null, now]
    );

    const savedAttachments = [];
    if (attachments && attachments.length) {
      for (const att of attachments) {
        const attId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
        await db.run(
          `INSERT INTO chat_attachments (id, message_id, file_url, file_name, file_size, file_type, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [attId, msgId, att.url, att.name, att.size, att.type, now]
        );
        savedAttachments.push({ id: attId, file_url: att.url, file_name: att.name, file_size: att.size, file_type: att.type });
      }
    }

    const lastText = text || (attachments && attachments.length ? `[Attachment: ${attachments[0].name}]` : 'New message');
    await db.run(
      `UPDATE conversations 
       SET last_message_text = ?, last_message_at = ?, updated_at = ? 
       WHERE id = ?`,
      [lastText, now, now, conversation_id]
    );

    await db.run(
      `UPDATE conversation_members 
       SET last_read_at = ? 
       WHERE conversation_id = ? AND user_id = ?`,
      [now, conversation_id, req.user.id]
    );

    const sender = await db.get('SELECT username, profile_pic FROM users WHERE id = ?', [req.user.id]);

    let replyText = null;
    let replyUsername = null;
    if (reply_to_id) {
      const replyMsg = await db.get(
        `SELECT m.text, u.username 
         FROM chat_messages m
         LEFT JOIN users u ON m.sender_id = u.id
         WHERE m.id = ?`,
        [reply_to_id]
      );
      if (replyMsg) {
        replyText = replyMsg.text;
        replyUsername = replyMsg.username;
      }
    }

    const responsePayload = {
      id: msgId,
      conversation_id,
      sender_id: req.user.id,
      sender_username: sender ? sender.username : '',
      sender_profile_pic: sender ? sender.profile_pic : '',
      text,
      reply_to_id: reply_to_id || null,
      reply_to_text: replyText,
      reply_to_username: replyUsername,
      is_pinned: false,
      is_edited: false,
      is_deleted: false,
      created_at: now,
      attachments: savedAttachments
    };

    const ably = require('ably');
    if (process.env.ABLY_API_KEY) {
      const client = new ably.Rest({ key: process.env.ABLY_API_KEY });
      client.channels.get(`chat:conversation:${conversation_id}`).publish('message_new', responsePayload, (err) => {
        if (err) console.error('[ABLY BROADCAST ERROR] Failed:', err);
      });
    }

    res.json({ success: true, message: responsePayload });
  } catch (err) {
    console.error('[CHAT API] Error sending message:', err.message);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// POST /api/chat/attachments: Upload file to storage (images, documents, voice, video)
router.post('/api/chat/attachments', authenticateToken, chatUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    const file = req.file;
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/mp3',
      'video/mp4', 'video/webm', 'video/ogg'
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Unsupported file type.' });
    }

    let uploaded;
    if (chatSupabase) {
      const fileExt = file.originalname.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}.${fileExt}`;
      const filePath = `chat-attachments/${fileName}`;

      const { data, error } = await chatSupabase.storage
        .from('chat-attachments')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '3600',
          upsert: false
        });

      if (error) throw error;

      const { data: urlData } = chatSupabase.storage
        .from('chat-attachments')
        .getPublicUrl(filePath);

      uploaded = {
        url: urlData.publicUrl,
        name: file.originalname,
        size: file.size,
        type: file.mimetype
      };
    } else {
      const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      const fileExt = file.originalname.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}.${fileExt}`;
      const filePath = path.join(uploadDir, fileName);
      fs.writeFileSync(filePath, file.buffer);
      
      uploaded = {
        url: `/uploads/${fileName}`,
        name: file.originalname,
        size: file.size,
        type: file.mimetype
      };
    }

    res.json({ success: true, attachment: uploaded });
  } catch (err) {
    console.error('[CHAT ATTACHMENT UPLOAD ERROR]:', err.message);
    res.status(500).json({ error: 'Failed to upload attachment.' });
  }
});

// POST /api/chat/messages/:id/pin: Pin message
router.post('/api/chat/messages/:id/pin', authenticateToken, async (req, res) => {
  const db = await getDB();
  const msgId = req.params.id;
  const { pin } = req.body;

  try {
    const msg = await db.get('SELECT * FROM chat_messages WHERE id = ?', [msgId]);
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    const isMember = await db.get(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [msg.conversation_id, req.user.id]
    );
    if (!isMember) return res.status(403).json({ error: 'Access denied.' });

    await db.run('UPDATE chat_messages SET is_pinned = ? WHERE id = ?', [!!pin, msgId]);

    const ably = require('ably');
    if (process.env.ABLY_API_KEY) {
      const client = new ably.Rest({ key: process.env.ABLY_API_KEY });
      client.channels.get(`chat:conversation:${msg.conversation_id}`).publish('message_pin', { id: msgId, is_pinned: !!pin });
    }

    res.json({ success: true, is_pinned: !!pin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/chat/messages/:id: Edit message
router.put('/api/chat/messages/:id', authenticateToken, async (req, res) => {
  const db = await getDB();
  const msgId = req.params.id;
  const { text } = req.body;

  try {
    const msg = await db.get('SELECT * FROM chat_messages WHERE id = ?', [msgId]);
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    if (msg.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Cannot edit someone else\'s message.' });
    }

    const now = new Date().toISOString();
    await db.run(
      'UPDATE chat_messages SET text = ?, is_edited = 1, edited_at = ? WHERE id = ?',
      [text, now, msgId]
    );

    const ably = require('ably');
    if (process.env.ABLY_API_KEY) {
      const client = new ably.Rest({ key: process.env.ABLY_API_KEY });
      client.channels.get(`chat:conversation:${msg.conversation_id}`).publish('message_edit', { id: msgId, text, edited_at: now });
    }

    res.json({ success: true, id: msgId, text, edited_at: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/chat/messages/:id: Soft delete message
router.delete('/api/chat/messages/:id', authenticateToken, async (req, res) => {
  const db = await getDB();
  const msgId = req.params.id;

  try {
    const msg = await db.get('SELECT * FROM chat_messages WHERE id = ?', [msgId]);
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    if (msg.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Cannot delete someone else\'s message.' });
    }

    const now = new Date().toISOString();
    await db.run(
      'UPDATE chat_messages SET is_deleted = 1, text = ?, deleted_at = ? WHERE id = ?',
      ['This message was deleted.', now, msgId]
    );
    await db.run('DELETE FROM chat_attachments WHERE message_id = ?', [msgId]);

    const ably = require('ably');
    if (process.env.ABLY_API_KEY) {
      const client = new ably.Rest({ key: process.env.ABLY_API_KEY });
      client.channels.get(`chat:conversation:${msg.conversation_id}`).publish('message_delete', { id: msgId, deleted_at: now });
    }

    res.json({ success: true, id: msgId, deleted_at: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/conversations/:id/read: Read messages
router.post('/api/chat/conversations/:id/read', authenticateToken, async (req, res) => {
  const db = await getDB();
  const conversationId = req.params.id;
  const now = new Date().toISOString();

  try {
    await db.run(
      `UPDATE conversation_members 
       SET last_read_at = ? 
       WHERE conversation_id = ? AND user_id = ?`,
      [now, conversationId, req.user.id]
    );

    await db.run(
      `UPDATE chat_messages 
       SET seen_at = ? 
       WHERE conversation_id = ? AND sender_id != ? AND seen_at IS NULL`,
      [now, conversationId, req.user.id]
    );

    const ably = require('ably');
    if (process.env.ABLY_API_KEY) {
      const client = new ably.Rest({ key: process.env.ABLY_API_KEY });
      client.channels.get(`chat:conversation:${conversationId}`).publish('receipt_seen', { reader_id: req.user.id, seen_at: now });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// 🎧 LIVE SUPPORT CHAT — User-Side Endpoints
// =============================================================================

const requireAuth = authenticateToken;
const supportRouter = require('express').Router();

function getPriorityForCategory(category) {
  const c = (category || '').toLowerCase();
  if (['vip', 'deposit', 'withdrawal', 'security', 'account locked', 'account_locked'].includes(c)) return 'high';
  if (['kyc', 'verification', 'account issues', 'account_issues'].includes(c)) return 'medium';
  return 'low';
}

// GET /api/support/conversation — get user's active support conversation (or null)
supportRouter.get('/conversation', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.query(
      `SELECT c.*, cm.last_read_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.seen_at IS NULL AND m.is_deleted = false) as unread_count
       FROM conversations c
       JOIN conversation_members cm ON c.id = cm.conversation_id
       WHERE cm.user_id = $1 AND c.type = 'support' AND c.status != 'closed'
       ORDER BY c.updated_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json({ conversation: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/support/conversations — get all user's support conversations
supportRouter.get('/conversations', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.query(
      `SELECT c.*, cm.last_read_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.seen_at IS NULL AND m.is_deleted = false) as unread_count
       FROM conversations c
       JOIN conversation_members cm ON c.id = cm.conversation_id
       WHERE cm.user_id = $1 AND c.type = 'support'
       ORDER BY c.updated_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/conversations — create new support conversation (up to 3 active per user)
supportRouter.post('/conversations', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    // Enforce max 3 active conversations per user
    const existing = await db.query(
      `SELECT id FROM conversations c
       JOIN conversation_members cm ON c.id = cm.conversation_id
       WHERE cm.user_id = $1 AND c.type = 'support' AND c.status NOT IN ('closed', 'resolved')`,
      [req.user.id]
    );
    if (existing.length >= 3) {
      return res.status(400).json({ error: 'Maximum of 3 active chats allowed. Please close an ongoing chat first.' });
    }

    let botId = null;
    try {
      const botRow = await db.query("SELECT id FROM users WHERE username = 'GainEX AI Bot' LIMIT 1");
      if (botRow && botRow.length > 0) {
        botId = botRow[0].id;
      }
    } catch (e) {
      console.error('Error fetching bot ID during conversation create:', e.message);
    }

    const initialStatus = botId ? 'assigned' : 'waiting';
    const initialAssignedTo = botId ? botId : null;

    const convId = await db.query(
      `INSERT INTO conversations (type, status, created_by, updated_at, priority, category, assigned_to) VALUES ('support',$1,$2,NOW(),'low','General',$3) RETURNING id`,
      [initialStatus, req.user.id, initialAssignedTo]
    );
    const id = convId[0].id;

    // Add user as member
    await db.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)`,
      [id, req.user.id]
    );

    // If bot is active, send welcome message immediately
    if (botId) {
      const welcomeText = "Hello! I am the GainEX AI Support Assistant. How can I help you today?";
      const msgResult = await db.query(
        `INSERT INTO chat_messages (conversation_id, sender_id, text, delivered_at) VALUES ($1,$2,$3,NOW()) RETURNING id, created_at`,
        [id, botId, welcomeText]
      );
      
      const messageId = msgResult[0].id;
      const msgCreatedAt = msgResult[0].created_at;

      // Broadcast welcome message via Ably
      if (process.env.ABLY_API_KEY) {
        const Ably = require('ably');
        const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
        ablyRest.channels.get(`support:conversation:${id}`).publish('message', {
          id: messageId,
          conversation_id: id,
          sender_id: botId,
          text: welcomeText,
          created_at: msgCreatedAt,
          sender_name: 'GainEX AI Bot',
          is_staff: true
        });
      }
    }

    // Notify staff via Ably queue
    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get('support:queue').publish('new_conversation', {
        conversationId: id,
        userId: req.user.id,
        createdAt: new Date().toISOString()
      });
      if (botId) {
        ablyRest.channels.get('support:queue').publish('message_update', {
          conversationId: id,
          lastMessage: "Hello! I am the GainEX AI Support Assistant. How can I help you today?",
          updatedAt: new Date().toISOString(),
          status: 'assigned'
        });
      }
    }

    try {
      const suppMsg = 
        `💬 *New Support Conversation Started*\n` +
        `👤 *Username*: ${telegramService.escapeMarkdown(req.user.username || 'User')}\n` +
        `🆔 *User ID*: ${req.user.id}\n` +
        `🎫 *Conversation ID*: #${id}`;
      telegramService.sendNotification(suppMsg);
      whatsappService.sendNotification(suppMsg);
    } catch (botErr) {
      console.error('[SUPPORT] Telegram/WhatsApp notify error:', botErr.message);
    }

    res.json({ success: true, conversationId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/conversations/:id/close — close conversation by customer
supportRouter.post('/conversations/:id/close', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    
    // Verify user is member
    const member = await db.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`,
      [id, req.user.id]
    );
    if (!member[0]) return res.status(403).json({ error: 'Not authorized' });

    // Update status to closed
    await db.query(
      `UPDATE conversations SET status='closed', updated_at=NOW() WHERE id=$1`,
      [id]
    );

    // Audit log
    await db.query(
      `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,'closed','Closed by customer')`,
      [id, req.user.id]
    );

    // Publish status updates via Ably
    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${id}`).publish('status_update', { status: 'closed' });
      ablyRest.channels.get('support:queue').publish('conversation_updated', { conversationId: id, status: 'closed' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/conversations/:id/rate — rate conversation by customer
supportRouter.post('/conversations/:id/rate', requireAuth, async (req, res) => {
  try {
    const db = await getDB();
    const { id } = req.params;
    const { rating } = req.body;

    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Invalid rating value' });
    }

    // Verify user is member
    const member = await db.all(
      `SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`,
      [id, req.user.id]
    );
    if (!member[0]) return res.status(403).json({ error: 'Not authorized' });

    // Update rating
    await db.run(
      `UPDATE conversations SET rating=$1 WHERE id=$2`,
      [rating, id]
    );

    // Audit log
    await db.run(
      `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,'rated',$3)`,
      [id, req.user.id, `Rated: ${rating}`]
    );

    // Publish status updates via Ably
    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${id}`).publish('status_update', { status: 'rated', rating });
      ablyRest.channels.get('support:queue').publish('conversation_updated', { conversationId: id, rating });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/support/conversations/:id/messages — paginated messages
supportRouter.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const { before } = req.query;
    const limit = 40;

    // Verify user is member
    const member = await db.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`,
      [id, req.user.id]
    );
    if (!member[0]) return res.status(403).json({ error: 'Not a member' });

    let params = [id, limit];
    let whereClause = before ? `AND m.created_at < $3` : '';
    if (before) params.push(before);

    const messages = await db.query(
      `SELECT m.*, u.username as sender_name, (u.role IN ('admin','employee')) as is_staff,
        (u.username = 'GainEX AI Bot') as is_bot,
        (SELECT json_agg(json_build_object('id',a.id,'file_url',a.file_url,'file_name',a.file_name,'file_size',a.file_size,'file_type',a.file_type))
         FROM chat_attachments a WHERE a.message_id = m.id) as attachments
       FROM chat_messages m
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id=$1 AND m.is_deleted=false ${whereClause}
       ORDER BY m.created_at DESC LIMIT $2`,
      params
    );
    res.json({ messages: messages.reverse(), hasMore: messages.length === limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/messages — send a message
const supportRateMap = {};
supportRouter.post('/messages', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    const uid = req.user.id;
    if (!supportRateMap[uid]) supportRateMap[uid] = [];
    supportRateMap[uid] = supportRateMap[uid].filter(t => now - t < 60000);
    if (supportRateMap[uid].length >= 30) return res.status(429).json({ error: 'Too many messages. Please wait.' });
    supportRateMap[uid].push(now);

    const { conversationId, text, replyToId } = req.body;
    const db = getDB();

    // Verify user is member
    const conv = await db.query(
      `SELECT c.status, c.assigned_to FROM conversations c JOIN conversation_members cm ON c.id=cm.conversation_id WHERE c.id=$1 AND cm.user_id=$2 AND c.type='support'`,
      [conversationId, req.user.id]
    );
    if (!conv[0]) return res.status(403).json({ error: 'Not authorized' });
    if (conv[0].status === 'closed' || conv[0].status === 'resolved') return res.status(403).json({ error: 'Conversation is closed' });

    const result = await db.query(
      `INSERT INTO chat_messages (conversation_id, sender_id, text, reply_to_id, delivered_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
      [conversationId, req.user.id, text || '', replyToId || null]
    );
    const message = result[0];

    // Automate category & priority classification on customer first message
    const msgCount = await db.query(`SELECT COUNT(*) as count FROM chat_messages WHERE conversation_id=$1`, [conversationId]);
    let cat = 'General';
    let prio = 'low';
    if (msgCount[0] && parseInt(msgCount[0].count) <= 1) {
      const msgText = (text || '').toLowerCase();
      if (msgText.includes('vip')) { cat = 'VIP'; prio = 'high'; }
      else if (msgText.includes('deposit') || msgText.includes('depo') || msgText.includes('add money') || msgText.includes('payment')) { cat = 'Deposit'; prio = 'high'; }
      else if (msgText.includes('withdraw') || msgText.includes('payout') || msgText.includes('cash out')) { cat = 'Withdrawal'; prio = 'high'; }
      else if (msgText.includes('kyc') || msgText.includes('passport') || msgText.includes('id card') || msgText.includes('document')) { cat = 'KYC'; prio = 'medium'; }
      else if (msgText.includes('verify') || msgText.includes('verification')) { cat = 'Verification'; prio = 'medium'; }
      else if (msgText.includes('2fa') || msgText.includes('security') || msgText.includes('hack') || msgText.includes('password reset') || msgText.includes('compromise')) { cat = 'Security'; prio = 'high'; }
      else if (msgText.includes('lock') || msgText.includes('locked') || msgText.includes('frozen') || msgText.includes('block')) { cat = 'Account Locked'; prio = 'high'; }
      else if (msgText.includes('trade') || msgText.includes('trading') || msgText.includes('asset') || msgText.includes('option')) { cat = 'Trading'; prio = 'low'; }
      else if (msgText.includes('technical') || msgText.includes('error') || msgText.includes('bug') || msgText.includes('fail')) { cat = 'Technical'; prio = 'low'; }
      else if (msgText.includes('promo') || msgText.includes('bonus') || msgText.includes('code')) { cat = 'Promotions'; prio = 'low'; }

      await db.query(`UPDATE conversations SET category=$1, priority=$2 WHERE id=$3`, [cat, prio, conversationId]);
      await db.query(
        `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,'created',$3)`,
        [conversationId, req.user.id, `Ticket classified as Category: ${cat}, Priority: ${prio}`]
      );
    }

    // Automate customer reply status transition back to assigned/waiting
    const newStatus = conv[0] && conv[0].assigned_to ? 'assigned' : 'waiting';

    // Update conversation last_message
    await db.query(
      `UPDATE conversations SET last_message_text=$1, last_message_at=NOW(), updated_at=NOW(), status=$2 WHERE id=$3`,
      [text ? text.substring(0, 100) : '📎 Attachment', newStatus, conversationId]
    );

    const category = cat;
    // Publish via Ably
    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${conversationId}`).publish('message', { ...message, sender_name: req.user.username });
      ablyRest.channels.get('support:queue').publish('message_update', { conversationId, lastMessage: text, updatedAt: new Date().toISOString(), status: newStatus, category, priority: prio });
    }

    // Trigger AI Support Bot reply check in background
    let botId = null;
    try {
      const botRow = await db.query("SELECT id FROM users WHERE username = 'GainEX AI Bot' LIMIT 1");
      if (botRow && botRow.length > 0) {
        botId = botRow[0].id;
      }
    } catch (e) {}

    if (!conv[0].assigned_to || (botId && Number(conv[0].assigned_to) === Number(botId))) {
      aiSupportService.handleUserMessage(conversationId, message, req.user);
    }

    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/attachments — upload file
const supportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
supportRouter.post('/attachments', requireAuth, supportUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const allowedTypes = ['image/jpeg','image/png','image/gif','image/webp','application/pdf','audio/webm','audio/ogg','audio/wav','audio/mpeg','video/mp4','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowedTypes.includes(req.file.mimetype)) return res.status(400).json({ error: 'File type not allowed' });

    const { messageId } = req.body;
    let fileUrl = '';

    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
      const { createClient } = require('@supabase/supabase-js');
      const sup = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      const fileName = `support/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await sup.storage.from('chat-attachments').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      const { data } = sup.storage.from('chat-attachments').getPublicUrl(fileName);
      fileUrl = data.publicUrl;
    } else {
      const path = require('path');
      const fsp = require('fs').promises;
      const uploadDir = path.join(__dirname, '..', 'public', 'uploads', 'support');
      await fsp.mkdir(uploadDir, { recursive: true });
      const fileName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await fsp.writeFile(path.join(uploadDir, fileName), req.file.buffer);
      fileUrl = `/uploads/support/${fileName}`;
    }

    const db = getDB();
    const att = await db.query(
      `INSERT INTO chat_attachments (message_id, file_url, file_name, file_size, file_type) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [messageId, fileUrl, req.file.originalname, req.file.size, req.file.mimetype]
    );
    res.json({ success: true, attachment: att[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/conversations/:id/read — mark as read
supportRouter.post('/conversations/:id/read', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const now = new Date().toISOString();
    await db.query(`UPDATE chat_messages SET seen_at=$1 WHERE conversation_id=$2 AND sender_id!=$3 AND seen_at IS NULL`, [now, id, req.user.id]);
    await db.query(`UPDATE conversation_members SET last_read_at=$1 WHERE conversation_id=$2 AND user_id=$3`, [now, id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// 🛡️ LIVE SUPPORT CHAT — Staff-Side Endpoints
// =============================================================================

const staffSupportRouter = require('express').Router();

// Middleware: must be logged-in staff with live_support permission or admin
async function requireSupportAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role === 'admin') return next();
  if (req.user.role === 'employee') {
    try {
      const db = getDB();
      const rows = await db.query('SELECT live_support, full_access FROM permissions WHERE user_id = $1', [req.user.id]);
      const p = rows[0] || {};
      if (p.full_access || p.live_support || p.full_access == 1 || p.live_support == 1 || String(p.full_access) === 'true' || String(p.live_support) === 'true') {
        req.user.permissions = p;
        return next();
      }
    } catch (e) {
      console.error('requireSupportAccess database error:', e.message);
    }
  }
  return res.status(403).json({ error: 'Live Support permission required' });
}

// GET /api/staff/support/stats — get support overview statistics
staffSupportRouter.get('/stats', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const waiting = await db.query(`SELECT COUNT(*) as c FROM conversations WHERE status='waiting' AND type='support'`);
    const active = await db.query(`SELECT COUNT(*) as c FROM conversations WHERE status IN ('assigned', 'waiting_customer') AND type='support' AND assigned_to = $1`, [req.user.id]);
    
    const today = new Date();
    today.setHours(0,0,0,0);
    const resolved = await db.query(`SELECT COUNT(*) as c FROM conversations WHERE status IN ('resolved', 'closed') AND type='support' AND updated_at>=$1`, [today.toISOString()]);
    
    const twoMinutesAgo = new Date(Date.now() - 120000).toISOString();
    const onlineAgents = await db.query(`SELECT COUNT(*) as c FROM users WHERE role IN ('admin', 'employee') AND last_seen_at>=$1`, [twoMinutesAgo]);

    res.json({
      waiting_chats: parseInt(waiting[0]?.c || 0),
      active_chats: parseInt(active[0]?.c || 0),
      resolved_today: parseInt(resolved[0]?.c || 0),
      online_agents: parseInt(onlineAgents[0]?.c || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/support/agents — get support agent list with chat counts
staffSupportRouter.get('/agents', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const twoMinutesAgo = new Date(Date.now() - 120000).toISOString();
    const agents = await db.query(
      `SELECT u.id, u.username, u.role, u.last_seen_at,
         (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to = u.id AND c.status IN ('assigned', 'waiting_customer') AND c.type = 'support') as active_chats_count,
         (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to = u.id AND c.status = 'resolved' AND c.type = 'support') as resolved_chats_count
       FROM users u
       WHERE u.role IN ('admin', 'employee')
       ORDER BY u.username ASC`
    );
    const mapped = agents.map(a => ({
      id: a.id,
      username: a.username,
      role: a.role,
      is_online: new Date(a.last_seen_at) >= new Date(twoMinutesAgo),
      active_chats_count: parseInt(a.active_chats_count || 0),
      resolved_chats_count: parseInt(a.resolved_chats_count || 0)
    }));
    res.json({ agents: mapped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/support/conversations — get support conversation queue
staffSupportRouter.get('/conversations', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const { queue, search, page = 1, category, priority } = req.query;
    const limit = 30;
    const offset = (page - 1) * limit;
    const staffId = req.user.id;

    let whereClause = `c.type = 'support'`;
    const params = [];

    if (queue === 'unassigned') {
      whereClause += ` AND c.status = 'waiting' AND (c.assigned_to IS NULL OR c.assigned_to = $${params.length + 1})`;
      params.push(staffId);
    } else if (queue === 'mine') {
      whereClause += ` AND c.assigned_to = $${params.length + 1} AND c.status != 'closed' AND c.status != 'waiting'`;
      params.push(staffId);
    } else if (queue === 'bot') {
      whereClause += ` AND c.assigned_to = (SELECT id FROM users WHERE username = 'GainEX AI Bot' LIMIT 1) AND c.status != 'closed' AND c.status != 'resolved'`;
    } else if (queue === 'resolved') {
      whereClause += ` AND c.status IN ('resolved','closed')`;
    }

    if (category) {
      whereClause += ` AND c.category = $${params.length + 1}`;
      params.push(category);
    }

    if (priority) {
      whereClause += ` AND c.priority = $${params.length + 1}`;
      params.push(priority);
    }

    if (search) {
      // Allow searching username, guest category name, user_id, conversation_id, or message content
      whereClause += ` AND (u.username ILIKE $${params.length + 1} 
        OR c.category ILIKE $${params.length + 1}
        OR CAST(c.id AS TEXT) ILIKE $${params.length + 1}
        OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id=c.id AND m.text ILIKE $${params.length + 1}))`;
      params.push(`%${search}%`);
    }

    params.push(limit, offset);
    const rows = await db.query(
      `SELECT c.*, u.username as user_name, u.id as user_id, u.created_at as user_created_at,
        a.username as assigned_agent_name,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id=c.id AND (c.created_by IS NULL OR m.sender_id!=c.created_by) AND m.seen_at IS NULL AND m.is_deleted=false) as unread_count
       FROM conversations c
       LEFT JOIN conversation_members cm ON c.id=cm.conversation_id AND cm.user_id=c.created_by
       LEFT JOIN users u ON u.id=c.created_by
       LEFT JOIN users a ON a.id=c.assigned_to
       WHERE ${whereClause}
       ORDER BY 
         CASE c.priority
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END ASC,
         c.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Map rows to process guest names/emails stored in category field
    const processedRows = rows.map(row => {
      if (row.created_by === null && row.category) {
        const match = row.category.match(/^Guest:\s*(.*?)\s*<([^>]+)>/i);
        if (match) {
          row.user_name = match[1] + ' (Guest)';
          row.email = match[2];
        } else {
          row.user_name = row.category;
        }
      }
      return row;
    });

    res.json({ conversations: processedRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/support/conversations/:id — get single conversation details
staffSupportRouter.get('/conversations/:id', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const rows = await db.query(
      `SELECT c.*, u.username as user_name, u.id as user_id, u.email, u.created_at as user_created_at, u.last_seen_at, u.status as user_account_status,
        a.username as assigned_agent_name,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) as total_messages
       FROM conversations c
       LEFT JOIN conversation_members cm ON c.id=cm.conversation_id AND cm.user_id=c.created_by
       LEFT JOIN users u ON u.id=c.created_by
       LEFT JOIN users a ON a.id=c.assigned_to
       WHERE c.id=$1 AND c.type='support'`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    // Process guest info if guest chat
    if (rows[0].created_by === null && rows[0].category) {
      const match = rows[0].category.match(/^Guest:\s*(.*?)\s*<([^>]+)>/i);
      if (match) {
        rows[0].user_name = match[1] + ' (Guest)';
        rows[0].email = match[2];
      } else {
        rows[0].user_name = rows[0].category;
      }
    }

    res.json({ conversation: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/support/conversations/:id/messages — load messages and receipts
staffSupportRouter.get('/conversations/:id/messages', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const { before } = req.query;
    const limit = 40;
    let params = [id, limit];
    let whereClause = before ? `AND m.created_at < $3` : '';
    if (before) params.push(before);

    const messages = await db.query(
      `SELECT m.*, u.username as sender_name, (u.role IN ('admin','employee')) as is_staff,
        (SELECT json_agg(json_build_object('id',a.id,'file_url',a.file_url,'file_name',a.file_name,'file_size',a.file_size,'file_type',a.file_type))
         FROM chat_attachments a WHERE a.message_id=m.id) as attachments
       FROM chat_messages m
       LEFT JOIN users u ON m.sender_id=u.id
       WHERE m.conversation_id=$1 AND m.is_deleted=false ${whereClause}
       ORDER BY m.created_at DESC LIMIT $2`,
      params
    );

    // Mark messages as read/seen by staff member
    await db.query(`UPDATE chat_messages SET seen_at=NOW() WHERE conversation_id=$1 AND sender_id!=$2 AND seen_at IS NULL`, [id, req.user.id]);
    res.json({ messages: messages.reverse(), hasMore: messages.length === limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/support/conversations/:id/accept — accept support chat
staffSupportRouter.post('/conversations/:id/accept', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const conv = await db.query(`SELECT status, assigned_to FROM conversations WHERE id=$1 AND type='support'`, [id]);
    if (!conv[0]) return res.status(404).json({ error: 'Not found' });
    if (conv[0].assigned_to && conv[0].assigned_to !== req.user.id) return res.status(409).json({ error: 'Already assigned to another agent' });

    await db.query(`UPDATE conversations SET status='assigned', assigned_to=$1, updated_at=NOW() WHERE id=$2`, [req.user.id, id]);
    await db.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, req.user.id]);

    // Create Audit Log
    await db.query(
      `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,'accepted',$3)`,
      [id, req.user.id, `Ticket accepted by agent ${req.user.username}`]
    );

    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${id}`).publish('status_update', { status: 'assigned', assignedTo: req.user.username });
      ablyRest.channels.get('support:queue').publish('conversation_updated', { conversationId: id, status: 'assigned', assignedTo: req.user.username });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

staffSupportRouter.post('/conversations/:id/handover-to-bot', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const conv = await db.query(`SELECT status, assigned_to FROM conversations WHERE id=$1 AND type='support'`, [id]);
    if (!conv[0]) return res.status(404).json({ error: 'Conversation not found' });

    // Reset assigned_to to null, status to waiting
    await db.query(`UPDATE conversations SET status='waiting', assigned_to=NULL, updated_at=NOW() WHERE id=$1`, [id]);

    // Create Audit Log
    await db.query(
      `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,'handover',$3)`,
      [id, req.user.id, `Ticket handed over back to AI Support Bot by ${req.user.username}`]
    );

    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${id}`).publish('status_update', { status: 'waiting', assignedTo: null });
      ablyRest.channels.get('support:queue').publish('conversation_updated', { conversationId: id, status: 'waiting', assignedTo: null });
    }

    // Trigger AI support bot immediately so it replies to the latest customer messages if any
    const dbResolved = await db;
    const lastMsg = await dbResolved.get("SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", [id]);
    const chattingUser = await dbResolved.get(
      "SELECT u.* FROM conversation_members cm JOIN users u ON cm.user_id = u.id WHERE cm.conversation_id = ? AND u.role = 'user' LIMIT 1",
      [id]
    );
    if (chattingUser && lastMsg) {
      aiSupportService.handleUserMessage(id, lastMsg, chattingUser);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/support/aibot-settings', ...requirePermission('user_management'), async (req, res) => {
  try {
    const db = await getDB();
    const enabledRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_support_enabled'");
    const instrRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_support_instructions'");
    const keyRow = await db.get("SELECT value FROM settings WHERE key = 'gemini_api_key'");
    
    res.json({
      enabled: enabledRow ? enabledRow.value === 'true' : true,
      instructions: instrRow ? instrRow.value : '',
      gemini_key: keyRow ? keyRow.value : ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/support/aibot-settings', ...requirePermission('user_management'), async (req, res) => {
  try {
    const { enabled, gemini_key, instructions } = req.body;
    const db = await getDB();
    
    await db.run(
      `INSERT INTO settings (key, value) VALUES ('aibot_support_enabled', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [enabled ? 'true' : 'false']
    );
    
    await db.run(
      `INSERT INTO settings (key, value) VALUES ('aibot_support_instructions', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [instructions || '']
    );
    
    if (gemini_key !== undefined) {
      await db.run(
        `INSERT INTO settings (key, value) VALUES ('gemini_api_key', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [gemini_key]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/support/conversations/:id/reassign — reassign ticket to another agent
staffSupportRouter.post('/conversations/:id/reassign', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const { agentId } = req.body;
    
    // Authorization: Must be admin to reassign/transfer
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only administrators can reassign conversations' });
    }

    const agentUser = await db.query(`SELECT username FROM users WHERE id=$1 AND role IN ('admin', 'employee')`, [agentId]);
    if (!agentUser[0]) return res.status(404).json({ error: 'Agent not found' });

    await db.query(`UPDATE conversations SET assigned_to=$1, status='waiting', updated_at=NOW() WHERE id=$2`, [agentId, id]);
    await db.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, agentId]);

    // Create Audit Log
    await db.query(
      `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,'reassigned',$3)`,
      [id, req.user.id, `Ticket transferred to agent ${agentUser[0].username}`]
    );

    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${id}`).publish('status_update', { status: 'waiting', assignedTo: agentUser[0].username, assignedToId: agentId });
      ablyRest.channels.get('support:queue').publish('conversation_updated', { conversationId: id, status: 'waiting', assignedTo: agentUser[0].username, assignedToId: agentId });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/staff/support/conversations/:id/status — change conversation status
staffSupportRouter.put('/conversations/:id/status', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['waiting', 'assigned', 'waiting_customer', 'resolved', 'closed'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const db = getDB();
    const oldConv = await db.query(`SELECT status FROM conversations WHERE id=$1`, [req.params.id]);
    const oldStatus = oldConv[0] ? oldConv[0].status : '';
    
    const extra = status === 'closed' ? ', closed_at=NOW()' : '';
    await db.query(`UPDATE conversations SET status=$1, updated_at=NOW()${extra} WHERE id=$2 AND type='support'`, [status, req.params.id]);

    // Create Audit Log
    let eventType = 'status_changed';
    let details = `Status changed from ${oldStatus} to ${status}`;
    if (status === 'closed') {
      eventType = 'closed';
      details = `Ticket closed by ${req.user.username}`;
    } else if (oldStatus === 'closed') {
      eventType = 'reopened';
      details = `Ticket reopened by ${req.user.username}`;
    }
    await db.query(
      `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,$3,$4)`,
      [req.params.id, req.user.id, eventType, details]
    );

    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${req.params.id}`).publish('status_update', { status });
      ablyRest.channels.get('support:queue').publish('conversation_updated', { conversationId: req.params.id, status });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/staff/support/conversations/:id/priority — change priority manually
staffSupportRouter.put('/conversations/:id/priority', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const { priority } = req.body;
    const allowed = ['high', 'medium', 'low'];
    if (!allowed.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });

    const db = getDB();
    const oldConv = await db.query(`SELECT priority FROM conversations WHERE id=$1`, [req.params.id]);
    await db.query(`UPDATE conversations SET priority=$1, updated_at=NOW() WHERE id=$2 AND type='support'`, [priority, req.params.id]);

    // Audit Log
    await db.query(
      `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,'priority_changed',$3)`,
      [req.params.id, req.user.id, `Priority changed from ${oldConv[0]?.priority || 'low'} to ${priority}`]
    );

    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${req.params.id}`).publish('priority_update', { priority });
      ablyRest.channels.get('support:queue').publish('conversation_updated', { conversationId: req.params.id, priority });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/staff/support/conversations/:id/category — change category and set priority default
staffSupportRouter.put('/conversations/:id/category', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const { category } = req.body;
    const db = getDB();
    const oldConv = await db.query(`SELECT category, priority FROM conversations WHERE id=$1`, [req.params.id]);
    const defaultPriority = getPriorityForCategory(category);
    
    await db.query(`UPDATE conversations SET category=$1, priority=$2, updated_at=NOW() WHERE id=$3 AND type='support'`, [category, defaultPriority, req.params.id]);

    // Audit Log
    await db.query(
      `INSERT INTO support_audit_logs (conversation_id, actor_id, event_type, details) VALUES ($1,$2,'category_changed',$3)`,
      [req.params.id, req.user.id, `Category changed from ${oldConv[0]?.category || 'General'} to ${category} (Priority reset to default: ${defaultPriority})`]
    );

    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${req.params.id}`).publish('category_update', { category, priority: defaultPriority });
      ablyRest.channels.get('support:queue').publish('conversation_updated', { conversationId: req.params.id, category, priority: defaultPriority });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/support/conversations/:id/notes — get private staff notes
staffSupportRouter.get('/conversations/:id/notes', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const notes = await db.query(
      `SELECT n.*, u.username as author_name FROM support_notes n
       LEFT JOIN users u ON n.author_id=u.id
       WHERE n.conversation_id=$1 ORDER BY n.created_at DESC`,
      [req.params.id]
    );
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/support/conversations/:id/notes — add a private staff note
staffSupportRouter.post('/conversations/:id/notes', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });
    const db = getDB();
    await db.query(
      `INSERT INTO support_notes (conversation_id, author_id, text) VALUES ($1,$2,$3)`,
      [req.params.id, req.user.id, text]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/support/conversations/:id/audit — get internal audit logs
staffSupportRouter.get('/conversations/:id/audit', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const logs = await db.query(
      `SELECT a.*, u.username as actor_name FROM support_audit_logs a
       LEFT JOIN users u ON a.actor_id=u.id
       WHERE a.conversation_id=$1 ORDER BY a.created_at DESC`,
      [req.params.id]
    );
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/support/messages — staff replies to customer (with ownership protection)
staffSupportRouter.post('/messages', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const { conversationId, text, replyToId } = req.body;
    const db = getDB();

    const conv = await db.query(`SELECT status, assigned_to FROM conversations WHERE id=$1 AND type='support'`, [conversationId]);
    if (!conv[0]) return res.status(404).json({ error: 'Conversation not found' });
    if (conv[0].status === 'closed') return res.status(403).json({ error: 'Conversation is closed' });

    // Ownership Protection Gate: Only the assigned agent or an admin can reply
    if (conv[0].assigned_to && conv[0].assigned_to !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'This conversation is assigned to another agent.' });
    }

    const result = await db.query(
      `INSERT INTO chat_messages (conversation_id, sender_id, text, reply_to_id, delivered_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
      [conversationId, req.user.id, text || '', replyToId || null]
    );
    const message = result[0];

    // Automate status update to waiting_customer on staff reply
    await db.query(
      `UPDATE conversations SET last_message_text=$1, last_message_at=NOW(), updated_at=NOW(), status='waiting_customer' WHERE id=$2`,
      [text ? text.substring(0, 100) : '📎 Attachment', conversationId]
    );

    if (process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${conversationId}`).publish('message', { ...message, sender_name: req.user.username, is_staff: true });
      ablyRest.channels.get('support:queue').publish('message_update', { conversationId, lastMessage: text, updatedAt: new Date().toISOString(), status: 'waiting_customer' });
    }

    res.json({ success: true, message: { ...message, sender_name: req.user.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/support/messages/:id/pin — pin message
staffSupportRouter.post('/messages/:id/pin', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const msgId = req.params.id;
    await db.query(`UPDATE chat_messages SET is_pinned=true WHERE id=$1`, [msgId]);
    
    const msg = await db.query(`SELECT conversation_id FROM chat_messages WHERE id=$1`, [msgId]);
    if (msg[0] && process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${msg[0].conversation_id}`).publish('message_pin', { id: msgId, is_pinned: true });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/support/messages/:id/unpin — unpin message
staffSupportRouter.post('/messages/:id/unpin', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const msgId = req.params.id;
    await db.query(`UPDATE chat_messages SET is_pinned=false WHERE id=$1`, [msgId]);
    
    const msg = await db.query(`SELECT conversation_id FROM chat_messages WHERE id=$1`, [msgId]);
    if (msg[0] && process.env.ABLY_API_KEY) {
      const Ably = require('ably');
      const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
      ablyRest.channels.get(`support:conversation:${msg[0].conversation_id}`).publish('message_pin', { id: msgId, is_pinned: false });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// ⚡ QUICK CHATS — shared canned responses for live support agents
// =============================================================================

// GET /api/staff/support/quick-chats — list all saved quick chats (shared library)
staffSupportRouter.get('/quick-chats', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.query(
      `SELECT q.*, u.username as author_name FROM quick_chats q LEFT JOIN users u ON u.id = q.agent_id ORDER BY q.updated_at DESC`
    );
    res.json({ quickChats: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/support/quick-chats — create a quick chat
staffSupportRouter.post('/quick-chats', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !title.trim() || !content || !content.trim()) {
      return res.status(400).json({ error: 'Title and message are both required.' });
    }
    const db = getDB();
    const row = await db.query(
      `INSERT INTO quick_chats (agent_id, title, content) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.id, title.trim().substring(0, 120), content.trim().substring(0, 2000)]
    );
    res.json({ success: true, quickChat: row[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/staff/support/quick-chats/:id — update an existing quick chat in place
staffSupportRouter.put('/quick-chats/:id', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !title.trim() || !content || !content.trim()) {
      return res.status(400).json({ error: 'Title and message are both required.' });
    }
    const db = getDB();
    const row = await db.query(
      `UPDATE quick_chats SET title=$1, content=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [title.trim().substring(0, 120), content.trim().substring(0, 2000), req.params.id]
    );
    if (!row[0]) return res.status(404).json({ error: 'Quick chat not found.' });
    res.json({ success: true, quickChat: row[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/staff/support/quick-chats/:id — delete a quick chat
staffSupportRouter.delete('/quick-chats/:id', requireAuth, requireSupportAccess, async (req, res) => {
  try {
    const db = getDB();
    await db.query(`DELETE FROM quick_chats WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// 🌐 GUEST LIVE SUPPORT — Unauthenticated Landing Page Chat
// =============================================================================
const guestSupportRouter = require('express').Router();

// Rate-limit store for guest chat (in-memory, per IP)
const guestRateLimitMap = {};

function guestRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!guestRateLimitMap[ip]) guestRateLimitMap[ip] = [];
  guestRateLimitMap[ip] = guestRateLimitMap[ip].filter(t => now - t < 60000);
  if (guestRateLimitMap[ip].length >= 20) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  guestRateLimitMap[ip].push(now);
  next();
}

// POST /api/guest-support/start — start a new guest conversation
guestSupportRouter.post('/start', guestRateLimit, async (req, res) => {
  try {
    const db = await getDB();
    const { guest_name, guest_email, message } = req.body;
    if (!guest_name || !guest_name.trim()) return res.status(400).json({ error: 'Name is required.' });
    if (!guest_email || !guest_email.trim()) return res.status(400).json({ error: 'Email is required.' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required.' });

    const name = guest_name.trim().substring(0, 80);
    const email = guest_email.trim().toLowerCase().substring(0, 120);
    const text = message.trim().substring(0, 2000);

    // Encode guest info into the category field — safe, always works
    const guestCategory = `Guest: ${name} <${email}>`;

    // Create the support conversation (no created_by — use NULL, supported by schema)
    const convRow = await db.get(
      `INSERT INTO conversations (type, status, updated_at, priority, category)
       VALUES ('support','waiting',NOW(),'low',$1) RETURNING id`,
      [guestCategory]
    );
    if (!convRow || !convRow.id) {
      return res.status(500).json({ error: 'Failed to create conversation.' });
    }
    const convId = convRow.id;

    // Find a staff/admin user to use as placeholder sender for the guest message
    // (sender_id is NOT NULL in chat_messages — we embed guest info in message text)
    // We mark guest messages with a [GUEST] prefix so staff panel can recognise them.
    // Staff replies (sender_id IS NOT NULL, non-guest) are what the poll endpoint returns.
    // We still need a sender_id. Use the conversation id as a sentinel value
    // by storing guest name+email in the text body with a clear prefix.
    // The safest approach: find the first admin user id to use as placeholder.
    let guestSenderId = null;
    try {
      const adminRow = await db.get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
      if (adminRow) guestSenderId = adminRow.id;
    } catch (e) {}

    if (guestSenderId) {
      await db.run(
        `INSERT INTO chat_messages (conversation_id, sender_id, text, delivered_at)
         VALUES ($1, $2, $3, NOW())`,
        [convId, guestSenderId, `[GUEST: ${name} | ${email}] ${text}`]
      );
    }

    // Notify staff via Ably
    if (process.env.ABLY_API_KEY) {
      try {
        const Ably = require('ably');
        const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
        ablyRest.channels.get('support:queue').publish('new_conversation', {
          conversationId: convId,
          guestName: name,
          guestEmail: email,
          createdAt: new Date().toISOString()
        });
      } catch (e) {}
    }

    // Telegram & WhatsApp notification
    try {
      const guestMsg = 
        `💬 *New Guest Support Chat*\n` +
        `👤 *Name*: ${telegramService.escapeMarkdown(name)}\n` +
        `📧 *Email*: ${telegramService.escapeMarkdown(email)}\n` +
        `🎫 *Conversation ID*: #${convId}\n` +
        `💬 *Message*: ${telegramService.escapeMarkdown(text.substring(0, 200))}`;
      telegramService.sendNotification(guestMsg);
      whatsappService.sendNotification(guestMsg);
    } catch (e) {}

    // Generate a simple session token for this guest
    const token = Buffer.from(`${convId}:${process.env.JWT_SECRET || 'gxm-guest'}:${Date.now()}`).toString('base64');

    res.json({ success: true, conversationId: convId, guestToken: token, guestName: name, guestSenderId });
  } catch (err) {
    console.error('[GUEST SUPPORT] start error:', err.message);
    res.status(500).json({ error: 'Failed to start conversation.' });
  }
});

// POST /api/guest-support/message — guest sends a follow-up message
guestSupportRouter.post('/message', guestRateLimit, async (req, res) => {
  try {
    const db = await getDB();
    const { conversationId, guestToken, message, guestName, guestEmail, guestSenderId } = req.body;
    if (!conversationId || !guestToken || !message) return res.status(400).json({ error: 'Missing fields.' });

    const text = message.trim().substring(0, 2000);
    const name = (guestName || 'Guest').trim().substring(0, 80);
    const email = (guestEmail || '').trim().toLowerCase().substring(0, 120);

    // Verify conversation exists and is not closed
    const conv = await db.get(
      `SELECT id, status FROM conversations WHERE id = $1 AND type = 'support'`,
      [conversationId]
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
    if (conv.status === 'closed') return res.status(400).json({ error: 'This conversation has been closed.' });

    // Use stored guestSenderId or look up admin again
    let senderId = guestSenderId || null;
    if (!senderId) {
      try {
        const adminRow = await db.get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
        if (adminRow) senderId = adminRow.id;
      } catch (e) {}
    }

    if (senderId) {
      await db.run(
        `INSERT INTO chat_messages (conversation_id, sender_id, text, delivered_at)
         VALUES ($1, $2, $3, NOW())`,
        [conversationId, senderId, `[GUEST: ${name} | ${email}] ${text}`]
      );
    }

    await db.run(
      `UPDATE conversations SET last_message_text=$1, last_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [text.substring(0, 100), conversationId]
    );

    // Ably publish to staff panel
    if (process.env.ABLY_API_KEY) {
      try {
        const Ably = require('ably');
        const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
        ablyRest.channels.get(`support:conversation:${conversationId}`).publish('message', {
          conversation_id: conversationId,
          sender_id: senderId,
          sender_name: `${name} (Guest)`,
          text: `[GUEST: ${name} | ${email}] ${text}`,
          delivered_at: new Date().toISOString()
        });
        ablyRest.channels.get('support:queue').publish('message_update', {
          conversationId,
          lastMessage: text,
          updatedAt: new Date().toISOString()
        });
      } catch (e) {}
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[GUEST SUPPORT] message error:', err.message);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// GET /api/guest-support/poll — guest polls for new staff replies
guestSupportRouter.get('/poll', guestRateLimit, async (req, res) => {
  try {
    const db = await getDB();
    const { conversationId, guestToken, since, guestSenderId } = req.query;
    if (!conversationId || !guestToken) return res.status(400).json({ error: 'Missing fields.' });

    // Verify conversation exists
    const conv = await db.get(
      `SELECT id, status FROM conversations WHERE id = $1 AND type = 'support'`,
      [conversationId]
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

    // Fetch staff replies — exclude messages sent by guestSenderId (those are guest messages)
    // Staff replies are any messages from users that are NOT the admin placeholder
    const gSid = guestSenderId ? Number(guestSenderId) : null;
    let messages;
    if (since) {
      messages = await db.all(
        `SELECT id, sender_id, text, delivered_at FROM chat_messages
         WHERE conversation_id=$1 AND is_deleted=false AND delivered_at > $2
           AND ($3::bigint IS NULL OR sender_id != $3::bigint)
           AND text NOT LIKE '[GUEST:%'
         ORDER BY delivered_at ASC LIMIT 20`,
        [conversationId, since, gSid]
      );
    } else {
      messages = await db.all(
        `SELECT id, sender_id, text, delivered_at FROM chat_messages
         WHERE conversation_id=$1 AND is_deleted=false
           AND ($2::bigint IS NULL OR sender_id != $2::bigint)
           AND text NOT LIKE '[GUEST:%'
         ORDER BY delivered_at ASC LIMIT 20`,
        [conversationId, gSid]
      );
    }

    res.json({ messages: messages || [], status: conv.status });
  } catch (err) {
    console.error('[GUEST SUPPORT] poll error:', err.message);
    res.status(500).json({ error: 'Failed to poll messages.' });
  }
});

// --- BANK & E-WALLET METHODS MANAGEMENT (MULTI-COUNTRY) ---

// GET /api/admin/e-wallets - List all e-wallet methods
router.get('/admin/e-wallets', authenticateToken, requireRole(['admin', 'employee']), async (req, res) => {
  const db = await getDB();
  try {
    const rows = await db.all('SELECT * FROM e_wallet_methods ORDER BY id DESC');
    res.json({ methods: rows });
  } catch (err) {
    console.error('Error fetching e-wallet methods:', err.message);
    res.status(500).json({ error: 'Failed to fetch e-wallet methods.' });
  }
});

// POST /api/admin/e-wallets - Create a new e-wallet method
router.post('/admin/e-wallets', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const { name, account_name, account_number, iban, logo_url, country, pkr_rate, min_deposit, max_deposit, min_withdrawal, max_withdrawal } = req.body;
  if (!name || !account_name || !account_number) {
    return res.status(400).json({ error: 'Name, Account Name, and Account Number are required.' });
  }
  const countryVal = (country && String(country).trim()) || 'Pakistan';
  const rateVal = pkr_rate !== undefined && pkr_rate !== null ? parseInt(pkr_rate) : 283;
  const minDep = min_deposit !== undefined && min_deposit !== null ? parseFloat(min_deposit) : 10;
  const maxDep = max_deposit !== undefined && max_deposit !== null ? parseFloat(max_deposit) : 10000;
  const minWd = min_withdrawal !== undefined && min_withdrawal !== null ? parseFloat(min_withdrawal) : 10;
  const maxWd = max_withdrawal !== undefined && max_withdrawal !== null ? parseFloat(max_withdrawal) : 10000;
  try {
    await db.run(
      `INSERT INTO e_wallet_methods (name, account_name, account_number, iban, logo_url, country, enabled, pkr_rate, min_deposit, max_deposit, min_withdrawal, max_withdrawal)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [name, account_name, account_number, iban || null, logo_url || null, countryVal, rateVal, minDep, maxDep, minWd, maxWd]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error creating e-wallet method:', err.message);
    res.status(500).json({ error: 'Failed to create e-wallet method.' });
  }
});

// PUT /api/admin/e-wallets/:id - Update an existing e-wallet method
router.put('/admin/e-wallets/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const { name, account_name, account_number, iban, logo_url, country, enabled, pkr_rate, min_deposit, max_deposit, min_withdrawal, max_withdrawal } = req.body;
  const { id } = req.params;
  if (!name || !account_name || !account_number) {
    return res.status(400).json({ error: 'Name, Account Name, and Account Number are required.' });
  }
  const countryVal = (country && String(country).trim()) || 'Pakistan';
  const rateVal = pkr_rate !== undefined && pkr_rate !== null ? parseInt(pkr_rate) : 283;
  const minDep = min_deposit !== undefined && min_deposit !== null ? parseFloat(min_deposit) : 10;
  const maxDep = max_deposit !== undefined && max_deposit !== null ? parseFloat(max_deposit) : 10000;
  const minWd = min_withdrawal !== undefined && min_withdrawal !== null ? parseFloat(min_withdrawal) : 10;
  const maxWd = max_withdrawal !== undefined && max_withdrawal !== null ? parseFloat(max_withdrawal) : 10000;
  try {
    await db.run(
      `UPDATE e_wallet_methods
       SET name = ?, account_name = ?, account_number = ?, iban = ?, logo_url = ?, country = ?, enabled = ?, pkr_rate = ?, min_deposit = ?, max_deposit = ?, min_withdrawal = ?, max_withdrawal = ?
       WHERE id = ?`,
      [name, account_name, account_number, iban || null, logo_url || null, countryVal, enabled !== undefined ? enabled : 1, rateVal, minDep, maxDep, minWd, maxWd, Number(id)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating e-wallet method:', err.message);
    res.status(500).json({ error: 'Failed to update e-wallet method.' });
  }
});

// DELETE /api/admin/e-wallets/:id - Delete an e-wallet method
router.delete('/admin/e-wallets/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const db = await getDB();
  const { id } = req.params;
  try {
    await db.run('DELETE FROM e_wallet_methods WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting e-wallet method:', err.message);
    res.status(500).json({ error: 'Failed to delete e-wallet method.' });
  }
});

// GET /api/client/e-wallets - Fetch active e-wallet methods for users filtered by KYC Country
router.get('/client/e-wallets', authenticateToken, async (req, res) => {
  const db = await getDB();
  try {
    const user = await db.get('SELECT kyc_country, last_country, currency FROM users WHERE id = ?', [req.user.id]);
    const userCountryRaw = (user?.kyc_country || user?.last_country || '').trim();
    const userCountryNorm = userCountryRaw.toLowerCase();

    const rows = await db.all('SELECT * FROM e_wallet_methods WHERE enabled = 1 ORDER BY id DESC');
    
    let matchedMethods = [];
    if (userCountryNorm) {
      matchedMethods = rows.filter(m => {
        const methodCountryRaw = (m.country || 'Pakistan').trim();
        const methodCountryNorm = methodCountryRaw.toLowerCase();
        return methodCountryNorm === userCountryNorm ||
               userCountryNorm.includes(methodCountryNorm) ||
               methodCountryNorm.includes(userCountryNorm);
      });
    }

    res.json({ 
      methods: matchedMethods,
      user_country: userCountryRaw,
      has_methods: matchedMethods.length > 0
    });
  } catch (err) {
    console.error('Error fetching client e-wallets:', err.message);
    res.status(500).json({ error: 'Failed to load payment methods.' });
  }
});

// POST /api/admin/upload - Generic Admin File Upload
router.post('/admin/upload', authenticateToken, requireRole(['admin', 'employee']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const filePath = await uploadToSupabase(req.file);
    res.json({ filePath });
  } catch (err) {
    res.status(500).json({ error: 'File upload failed.' });
  }
});

// Mount support routers
router.use('/support', supportRouter);
router.use('/staff/support', staffSupportRouter);
router.use('/guest-support', guestSupportRouter);

module.exports = { router, getLivePrice, getManipulatedPrice, getEffectiveTradeControl, clearActiveTradeCache };
