const { getDB } = require('../db');

// In-memory store for active OTC simulation states
const otcPairsState = {};
let tickInterval = null;
let isEmergencyPaused = false;

// Timeframe MS mapping
const TIMEFRAME_MS = {
  '1m': 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1mo': 30 * 24 * 60 * 60 * 1000
};

// Volatility map (returns price change standard deviation ratio per second)
const VOLATILITY_FACTORS = {
  very_low: 0.00005,
  low: 0.0001,
  medium: 0.0002,
  high: 0.0004,
  very_high: 0.0008
};

// Speed interval factor mapping
const SPEED_FACTORS = {
  slow: 0.5,
  normal: 1.0,
  fast: 2.0
};

/**
 * Initialize the OTC Engine, load pairs from DB, pre-generate history, and start simulation loop
 */
async function init() {
  console.log('[OTC ENGINE] Initializing...');
  try {
    const db = await getDB();
    
    // Fetch global emergency pause state if stored in settings
    const pauseSetting = await db.get("SELECT value FROM settings WHERE key = 'otc_emergency_paused'");
    isEmergencyPaused = pauseSetting ? pauseSetting.value === 'true' : false;

    await loadPairsFromDB(db);
    
    // Start tick timer loop
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      if (!isEmergencyPaused) {
        tickSimulation();
      }
    }, 1000);

    console.log('[OTC ENGINE] Started successfully.');
  } catch (err) {
    console.error('[OTC ENGINE] Initialization failed:', err);
  }
}

/**
 * Loads OTC pairs configuration from the database and initializes their states
 */
async function loadPairsFromDB(db) {
  const rows = await db.all("SELECT * FROM otc_pairs");
  const now = Date.now();

  for (const row of rows) {
    const symbol = row.symbol;
    const isNew = !otcPairsState[symbol];

    // Preserve existing price if reloading config
    const prevPrice = !isNew ? otcPairsState[symbol].currentPrice : parseFloat(row.base_price || 1.0);

    otcPairsState[symbol] = {
      symbol: symbol,
      enabled: row.enabled !== 0,
      visible: row.visible !== 0,
      status: row.status || 'healthy',
      auto_mode: row.auto_mode !== 0,
      direction_bias: row.direction_bias || 'neutral',
      trend_strength: parseFloat(row.trend_strength ?? 0.05),
      volatility: row.volatility || 'medium',
      speed: row.speed || 'normal',
      price_offset: parseFloat(row.price_offset || 0),
      spread: parseFloat(row.spread || 0.0001),
      noise: parseFloat(row.noise || 0.0002),
      base_price: parseFloat(row.base_price || 1.0),
      schedule_type: row.schedule_type || 'always',
      schedule_custom: row.schedule_custom,
      
      // Dynamic Simulation parameters
      currentPrice: prevPrice,
      trendAngle: 0.0,
      momentum: 0.0,
      marketPhase: 'consolidating',
      phaseTicksRemaining: 0,
      supportPrice: prevPrice * 0.995,
      resistancePrice: prevPrice * 1.005,
      
      // Timeframe candle arrays
      candles: !isNew ? otcPairsState[symbol].candles : {}
    };

    // Pre-populate candle history if this is a newly loaded pair
    if (isNew) {
      pregenerateCandleHistory(otcPairsState[symbol]);
    }
  }
}

function formatPriceNum(val, basePrice) {
  if (basePrice < 1) return Number(val.toFixed(6));
  if (basePrice < 10) return Number(val.toFixed(4));
  return Number(val.toFixed(2));
}

/**
 * Pre-generates historical candlestick data for an OTC pair across all timeframes.
 */
function pregenerateCandleHistory(state) {
  const basePrice = state.base_price;
  const now = Date.now();
  state.candles = {};

  const tfScales = {
    '1m': 0.04,
    '15m': 0.08,
    '30m': 0.12,
    '1h': 0.18,
    '1d': 0.28,
    '1w': 0.38,
    '1mo': 0.48
  };

  for (const [tf, tfMs] of Object.entries(TIMEFRAME_MS)) {
    const candles = [];
    const currentPeriod = Math.floor(now / tfMs) * tfMs;
    const scale = tfScales[tf] || 0.10;

    let prevPrice = basePrice;
    const startOffset = Math.floor(Math.random() * 1000);
    let walk = 0.0;

    for (let j = 1; j <= 3000; j++) {
      const idx = startOffset + j;
      const time = currentPeriod - (3001 - j) * tfMs;

      // Multi-frequency waves configured to naturally synthesize realistic broader M and W patterns (mountains)
      const w1 = Math.sin(idx * 0.07) * 0.45;
      const w2 = Math.cos(idx * 0.14 + 0.8) * 0.35;
      const w3 = Math.sin(idx * 0.015) * 0.20;

      // Mean-reverting noise walk (Ornstein-Uhlenbeck)
      const shock = (Math.random() * 2 - 1) * 0.03;
      walk += -0.05 * walk + shock;

      let bias = 0.0;
      if (state.direction_bias === 'bullish') bias = 0.15;
      if (state.direction_bias === 'bearish') bias = -0.15;

      // Smooth wave price
      const waveNorm = (w1 + w2 + w3 + walk + bias);
      const targetPrice = basePrice * Math.max(0.2, (1 + scale * waveNorm));

      // Calculate step change from wave and add high-frequency candle-level noise
      const trendChange = targetPrice - prevPrice;
      const noise = basePrice * scale * (Math.random() * 2 - 1) * 0.24;
      
      const open = prevPrice;
      let close = prevPrice + trendChange + noise;
      close = Math.max(basePrice * 0.2, close);
      
      const body = Math.abs(close - open);
      const minWick = basePrice * scale * 0.02;
      const wickTop = body * (0.12 + Math.random() * 0.30) + minWick * Math.random();
      const wickBot = body * (0.12 + Math.random() * 0.30) + minWick * Math.random();

      const high = Math.max(open, close) + wickTop;
      const low = Math.max(basePrice * 0.1, Math.min(open, close) - wickBot);

      candles.push({
        time,
        open: formatPriceNum(open, basePrice),
        high: formatPriceNum(high, basePrice),
        low: formatPriceNum(low, basePrice),
        close: formatPriceNum(close, basePrice)
      });

      prevPrice = close;
    }
    state.candles[tf] = candles;
  }
}

/**
 * Checks if the OTC pair is active based on its market hours schedule configuration
 */
function isPairActiveInSchedule(state) {
  if (state.schedule_type === 'always') return true;

  const date = new Date();
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday

  if (state.schedule_type === 'weekends') {
    return (day === 0 || day === 6);
  }

  if (state.schedule_type === 'custom') {
    try {
      if (!state.schedule_custom) return true;
      const sched = JSON.parse(state.schedule_custom);
      // Expected: { days: [0, 6], startHour: 0, endHour: 24 }
      if (Array.isArray(sched.days) && !sched.days.includes(day)) return false;
      const hour = date.getHours();
      if (typeof sched.startHour === 'number' && hour < sched.startHour) return false;
      if (typeof sched.endHour === 'number' && hour >= sched.endHour) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  return true;
}

/**
 * Runs the simulation step once per second to calculate prices and compile candles
 */
function tickSimulation() {
  const now = Date.now();

  for (const [symbol, state] of Object.entries(otcPairsState)) {
    if (!state.enabled || !isPairActiveInSchedule(state)) {
      continue;
    }

    const baseVolatility = VOLATILITY_FACTORS[state.volatility] || 0.0002;
    state.tickCount = (state.tickCount || 0) + 1;
    const idx = state.tickCount;

    // Smooth live wave configured to naturally synthesize realistic broader M and W patterns (mountains)
    const w1 = Math.sin(idx * 0.0012) * 0.45;
    const w2 = Math.cos(idx * 0.0024 + 0.8) * 0.35;
    const w3 = Math.sin(idx * 0.00025) * 0.20;

    state.walkAccumulator = state.walkAccumulator || 0.0;
    const shock = (Math.random() * 2 - 1) * 0.005;
    state.walkAccumulator += -0.02 * state.walkAccumulator + shock;

    let bias = 0.0;
    if (state.direction_bias === 'bullish') bias = 0.15;
    if (state.direction_bias === 'bearish') bias = -0.15;

    const waveNorm = (w1 + w2 + w3 + state.walkAccumulator + bias);
    const targetPrice = state.base_price * Math.max(0.2, (1 + baseVolatility * 15.0 * waveNorm));

    if (!state.currentPrice || state.currentPrice === state.base_price) {
      state.currentPrice = targetPrice;
    } else {
      // Smooth live wave LERP + high-frequency tick noise to mix red and green ticks
      const trendChange = targetPrice - state.currentPrice;
      const noise = state.base_price * baseVolatility * (Math.random() * 2 - 1) * 6.0;
      state.currentPrice += trendChange * 0.12 + noise;
      state.currentPrice = Math.max(state.base_price * 0.2, state.currentPrice);
    }

    updateTimeframeCandles(state, now);
  }
}

/**
 * Updates OHLC candlestick data series for all active timeframes using the new price tick
 */
function updateTimeframeCandles(state, now) {
  const currentPrice = state.currentPrice + state.price_offset;

  for (const [tf, tfMs] of Object.entries(TIMEFRAME_MS)) {
    const candles = state.candles[tf];
    if (!candles || candles.length === 0) continue;

    const currentPeriod = Math.floor(now / tfMs) * tfMs;
    const last = candles[candles.length - 1];

    if (last.time < currentPeriod) {
      // Start a new candle
      candles.push({
        time: currentPeriod,
        open: last.close,
        high: Math.max(last.close, currentPrice),
        low: Math.min(last.close, currentPrice),
        close: currentPrice
      });
      // Cap at 3000 candles in memory
      if (candles.length > 3000) candles.shift();
    } else {
      // Update existing candle
      last.close = currentPrice;
      last.high = Math.max(last.high, currentPrice);
      last.low = Math.min(last.low, currentPrice);
    }
  }
}

/**
 * Retrieve the current mid-market price for an OTC pair
 */
function getPrice(symbol) {
  const cleaned = symbol.replace(/\s*\(OTC\)/gi, '').trim().toUpperCase() + ' (OTC)';
  const state = otcPairsState[cleaned];
  if (state) {
    return state.currentPrice + state.price_offset;
  }
  return null;
}

/**
 * Retrieve the array of candles for an OTC pair and timeframe
 */
function getCandles(symbol, timeframe = '1m') {
  const cleaned = symbol.replace(/\s*\(OTC\)/gi, '').trim().toUpperCase() + ' (OTC)';
  const state = otcPairsState[cleaned];
  if (state && state.candles[timeframe]) {
    return state.candles[timeframe];
  }
  return [];
}

/**
 * Forces a reload of pair configurations from the database
 */
async function reloadConfig() {
  try {
    const db = await getDB();
    await loadPairsFromDB(db);
    console.log('[OTC ENGINE] Reloaded pair configurations successfully.');
  } catch (err) {
    console.error('[OTC ENGINE] Failed to reload configuration:', err);
  }
}

/**
 * Resets a single OTC pair's price and regenerates its history
 */
async function resetPair(symbol) {
  const cleaned = symbol.replace(/\s*\(OTC\)/gi, '').trim().toUpperCase() + ' (OTC)';
  const state = otcPairsState[cleaned];
  if (state) {
    state.currentPrice = state.base_price;
    state.trendAngle = 0.0;
    state.momentum = 0.0;
    state.walkAccumulator = 0.0;
    state.tickCount = 0;
    state.marketPhase = 'consolidating';
    state.phaseTicksRemaining = 0;
    state.supportPrice = state.base_price * 0.995;
    state.resistancePrice = state.base_price * 1.005;
    pregenerateCandleHistory(state);
    console.log(`[OTC ENGINE] Reset pair ${cleaned} successfully.`);
  }
}

/**
 * Triggers a global emergency pause / resume for all OTC price movements
 */
async function toggleEmergencyPause(paused) {
  isEmergencyPaused = paused;
  const db = await getDB();
  await db.run(
    "INSERT INTO settings (key, value) VALUES ('otc_emergency_paused', ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
    [paused ? 'true' : 'false']
  );
  console.log(`[OTC ENGINE] Emergency pause set to: ${paused}`);
}

module.exports = {
  init,
  getPrice,
  getCandles,
  reloadConfig,
  resetPair,
  toggleEmergencyPause,
  getEmergencyPauseState: () => isEmergencyPaused,
  getPairsState: () => otcPairsState
};
