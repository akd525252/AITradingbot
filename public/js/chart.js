function normalizeTime(ts) {
  if (!ts) return Date.now();
  return ts < 1e12 ? ts * 1000 : ts;
}

function getCoinBaseSymbol(coin) {
  if (!coin) return '';
  return coin.split('/')[0].split('-')[0].trim().toUpperCase();
}

const chart = {
  activeAsset: 'BTC',
  activeTimeframe: '1m',
  chartStyle: 'candles', // 'candles' | 'area' | 'bars' | 'heikin'
  candles: [],
  activeTrades: [],
  tvChart: null,
  candlestickSeries: null,
  areaSeries: null,
  barSeries: null,
  priceLines: [],
  tickInterval: null,
  fetchInterval: null,
  _sentimentTarget: 50,
  sentimentVal: 50,

  // ── Indicator Engine ─────────────────────────────────────────────────────────
  _activeIndicators: {},   // { id: { series: [...], paneId: null } }
  _indicatorConfig: {
    ma:       { label: 'Moving Average (MA)',         color: '#f59e0b', period: 14 },
    ema:      { label: 'Exp. Moving Avg (EMA)',       color: '#06b6d4', period: 14 },
    bb:       { label: 'Bollinger Bands',             color: '#8b5cf6', period: 20 },
    wma:      { label: 'Weighted MA (WMA)',           color: '#ec4899', period: 14 },
    vwap:     { label: 'VWAP',                        color: '#1ab76d', period: 0  },
    rsi:      { label: 'RSI (14)',                    color: '#f97316', period: 14 },
    macd:     { label: 'MACD (12,26,9)',              color: '#38bdf8', period: 26 },
    stoch:    { label: 'Stochastic (14,3)',           color: '#a78bfa', period: 14 },
    atr:      { label: 'ATR (14)',                    color: '#fb7185', period: 14 },
    ichimoku: { label: 'Ichimoku Cloud',              color: '#34d399', period: 0  },
  },

  // ── Indicator Math Helpers ───────────────────────────────────────────────────
  _calcSMA(closes, period) {
    const result = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      let sum = 0; for (let j = 0; j < period; j++) sum += closes[i - j];
      result.push(sum / period);
    }
    return result;
  },
  _calcEMA(closes, period) {
    const result = []; const k = 2 / (period + 1); let prev = null;
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      if (prev === null) {
        let s = 0; for (let j = 0; j < period; j++) s += closes[i - j];
        prev = s / period; result.push(prev); continue;
      }
      prev = closes[i] * k + prev * (1 - k); result.push(prev);
    }
    return result;
  },
  _calcWMA(closes, period) {
    const result = [];
    const denom = period * (period + 1) / 2;
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      let s = 0; for (let j = 0; j < period; j++) s += closes[i - j] * (period - j);
      result.push(s / denom);
    }
    return result;
  },
  _calcBB(closes, period) {
    const mid = this._calcSMA(closes, period);
    const upper = [], lower = [];
    for (let i = 0; i < closes.length; i++) {
      if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
      let sq = 0; for (let j = 0; j < period; j++) sq += (closes[i - j] - mid[i]) ** 2;
      const sd = Math.sqrt(sq / period);
      upper.push(mid[i] + 2 * sd); lower.push(mid[i] - 2 * sd);
    }
    return { mid, upper, lower };
  },
  _calcVWAP(candles) {
    const result = []; let cumTP = 0, cumVol = 0;
    for (const c of candles) {
      const tp = (c.high + c.low + c.close) / 3;
      const vol = c.volume || 1;
      cumTP += tp * vol; cumVol += vol;
      result.push(cumVol > 0 ? cumTP / cumVol : null);
    }
    return result;
  },
  _calcRSI(closes, period) {
    const result = [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = 0; i < closes.length; i++) {
      if (i < period) { result.push(null); continue; }
      if (i === period) { result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)); continue; }
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
      result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return result;
  },
  _calcMACD(closes) {
    const ema12 = this._calcEMA(closes, 12);
    const ema26 = this._calcEMA(closes, 26);
    const macdLine = ema12.map((v, i) => (v !== null && ema26[i] !== null) ? v - ema26[i] : null);
    const valid = macdLine.filter(v => v !== null);
    const signal = [], histogram = [];
    let sigPrev = null; const k = 2 / 10;
    for (let i = 0, vi = 0; i < macdLine.length; i++) {
      if (macdLine[i] === null) { signal.push(null); histogram.push(null); continue; }
      if (vi < 8) { vi++; signal.push(null); histogram.push(null); continue; }
      if (sigPrev === null) sigPrev = valid.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
      sigPrev = macdLine[i] * k + sigPrev * (1 - k);
      signal.push(sigPrev); histogram.push(macdLine[i] - sigPrev); vi++;
    }
    return { macdLine, signal, histogram };
  },
  _calcStoch(candles, kPeriod = 14, dPeriod = 3) {
    const kLine = [], dLine = [];
    for (let i = 0; i < candles.length; i++) {
      if (i < kPeriod - 1) { kLine.push(null); continue; }
      const slice = candles.slice(i - kPeriod + 1, i + 1);
      const lo = Math.min(...slice.map(c => c.low));
      const hi = Math.max(...slice.map(c => c.high));
      kLine.push(hi === lo ? 50 : (candles[i].close - lo) / (hi - lo) * 100);
    }
    for (let i = 0; i < kLine.length; i++) {
      if (i < kPeriod - 1 + dPeriod - 1) { dLine.push(null); continue; }
      const slice = kLine.slice(i - dPeriod + 1, i + 1).filter(v => v !== null);
      dLine.push(slice.length === dPeriod ? slice.reduce((a, b) => a + b, 0) / dPeriod : null);
    }
    return { kLine, dLine };
  },
  _calcATR(candles, period = 14) {
    const result = [];
    for (let i = 0; i < candles.length; i++) {
      if (i === 0) { result.push(null); continue; }
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low  - candles[i - 1].close)
      );
      if (i < period) { result.push(null); continue; }
      if (i === period) {
        const avg = candles.slice(1, period + 1).reduce((s, c, j) => {
          const t = Math.max(c.high - c.low, Math.abs(c.high - candles[j].close), Math.abs(c.low - candles[j].close));
          return s + t;
        }, 0) / period;
        result.push(avg); continue;
      }
      result.push((result[i - 1] * (period - 1) + tr) / period);
    }
    return result;
  },
  _calcIchimoku(candles) {
    const high = candles.map(c => c.high), low = candles.map(c => c.low);
    const midVal = (arr, i, p) => {
      const sl = arr.slice(Math.max(0, i - p + 1), i + 1);
      return (Math.max(...sl) + Math.min(...sl)) / 2;
    };
    const tenkan = candles.map((_, i) => i >= 8  ? midVal(high, i, 9)  + midVal(low, i, 9)  : null).map((v, i) => v !== null ? (midVal(high, i, 9) + midVal(low, i, 9)) / 2 : null);
    const kijun  = candles.map((_, i) => i >= 25 ? (midVal(high, i, 26) + midVal(low, i, 26)) / 2 : null);
    const senkouA = tenkan.map((t, i) => (t !== null && kijun[i] !== null) ? (t + kijun[i]) / 2 : null);
    const senkouB = candles.map((_, i) => i >= 51 ? (midVal(high, i, 52) + midVal(low, i, 52)) / 2 : null);
    return { tenkan, kijun, senkouA, senkouB };
  },

  // ── Toggle an Indicator ──────────────────────────────────────────────────────
  toggleIndicator(id) {
    if (this._activeIndicators[id]) {
      this._removeIndicator(id);
    } else {
      this._addIndicator(id);
    }
    // Save active set to localStorage
    try { localStorage.setItem('gxm_indicators', JSON.stringify(Object.keys(this._activeIndicators))); } catch(e) {}
    // Update panel UI
    if (window.IndicatorPanel) window.IndicatorPanel.syncUI();
  },

  _removeIndicator(id) {
    const entry = this._activeIndicators[id];
    if (!entry) return;
    for (const s of entry.series) {
      try { if (this.tvChart) this.tvChart.removeSeries(s); } catch(e) {}
    }
    delete this._activeIndicators[id];
  },

  _addIndicator(id) {
    if (!this.tvChart || !this.candles || this.candles.length < 2) return;
    const cfg = this._indicatorConfig[id];
    if (!cfg) return;
    const closes   = this.candles.map(c => c.close);
    const times    = this.candles.map(c => Math.floor((c.time < 1e12 ? c.time * 1000 : c.time) / 1000));
    const pairData = (vals) => vals.map((v, i) => v !== null ? { time: times[i], value: v } : null).filter(Boolean);

    const seriesList = [];

    switch (id) {
      case 'ma': {
        const vals = this._calcSMA(closes, cfg.period);
        const s = this.tvChart.addLineSeries({ color: cfg.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(pairData(vals)); seriesList.push(s); break;
      }
      case 'ema': {
        const vals = this._calcEMA(closes, cfg.period);
        const s = this.tvChart.addLineSeries({ color: cfg.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(pairData(vals)); seriesList.push(s); break;
      }
      case 'wma': {
        const vals = this._calcWMA(closes, cfg.period);
        const s = this.tvChart.addLineSeries({ color: cfg.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(pairData(vals)); seriesList.push(s); break;
      }
      case 'bb': {
        const { mid, upper, lower } = this._calcBB(closes, cfg.period);
        const opts = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        const sM = this.tvChart.addLineSeries({ ...opts, color: cfg.color });
        const sU = this.tvChart.addLineSeries({ ...opts, color: cfg.color });
        const sL = this.tvChart.addLineSeries({ ...opts, color: cfg.color });
        sM.setData(pairData(mid)); sU.setData(pairData(upper)); sL.setData(pairData(lower));
        seriesList.push(sM, sU, sL); break;
      }
      case 'vwap': {
        const vals = this._calcVWAP(this.candles);
        const s = this.tvChart.addLineSeries({ color: cfg.color, lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(pairData(vals)); seriesList.push(s); break;
      }
      case 'rsi': {
        const vals = this._calcRSI(closes, cfg.period);
        const s = this.tvChart.addLineSeries({ color: cfg.color, lineWidth: 2, priceScaleId: 'rsi', priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
        s.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });
        s.setData(pairData(vals)); seriesList.push(s); break;
      }
      case 'macd': {
        const { macdLine, signal } = this._calcMACD(closes);
        const opts = { lineWidth: 1, priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        const sM = this.tvChart.addLineSeries({ ...opts, color: '#38bdf8' });
        const sS = this.tvChart.addLineSeries({ ...opts, color: '#f97316' });
        sM.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, borderVisible: false });
        sM.setData(pairData(macdLine)); sS.setData(pairData(signal));
        seriesList.push(sM, sS); break;
      }
      case 'stoch': {
        const { kLine, dLine } = this._calcStoch(this.candles, 14, 3);
        const opts = { lineWidth: 1, priceScaleId: 'stoch', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        const sK = this.tvChart.addLineSeries({ ...opts, color: '#a78bfa' });
        const sD = this.tvChart.addLineSeries({ ...opts, color: '#fb7185' });
        sK.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, borderVisible: false });
        sK.setData(pairData(kLine)); sD.setData(pairData(dLine));
        seriesList.push(sK, sD); break;
      }
      case 'atr': {
        const vals = this._calcATR(this.candles, cfg.period);
        const s = this.tvChart.addLineSeries({ color: cfg.color, lineWidth: 1, priceScaleId: 'atr', priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
        s.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, borderVisible: false });
        s.setData(pairData(vals)); seriesList.push(s); break;
      }
      case 'ichimoku': {
        const { tenkan, kijun, senkouA, senkouB } = this._calcIchimoku(this.candles);
        const opts = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        const sT = this.tvChart.addLineSeries({ ...opts, color: '#ef4444' });
        const sK = this.tvChart.addLineSeries({ ...opts, color: '#3b82f6' });
        const sA = this.tvChart.addLineSeries({ ...opts, color: '#34d399' });
        const sB = this.tvChart.addLineSeries({ ...opts, color: '#f87171' });
        sT.setData(pairData(tenkan)); sK.setData(pairData(kijun));
        sA.setData(pairData(senkouA)); sB.setData(pairData(senkouB));
        seriesList.push(sT, sK, sA, sB); break;
      }
    }
    if (seriesList.length) this._activeIndicators[id] = { series: seriesList };
  },

  _cleanupIndicators() {
    for (const id of Object.keys(this._activeIndicators)) {
      const entry = this._activeIndicators[id];
      for (const s of entry.series) { try { if (this.tvChart) this.tvChart.removeSeries(s); } catch(e) {} }
    }
    this._activeIndicators = {};
  },

  // ── Live-tick indicator update (called every tick from micro-ticker) ──────
  _updateIndicatorTick() {
    if (!this.candles || this.candles.length < 2) return;
    if (!Object.keys(this._activeIndicators).length) return;

    const candles = this.candles;
    const count = candles.length;
    const lastTime = Math.floor((candles[count - 1].time < 1e12 ? candles[count - 1].time * 1000 : candles[count - 1].time) / 1000);

    for (const [id, entry] of Object.entries(this._activeIndicators)) {
      const cfg = this._indicatorConfig[id];
      if (!cfg || !entry.series.length) continue;
      try {
        switch (id) {
          case 'ma': {
            const p = cfg.period || 14;
            const sub = candles.slice(-p).map(c => c.close);
            if (sub.length >= p) {
              const sum = sub.reduce((a, b) => a + b, 0);
              entry.series[0].update({ time: lastTime, value: sum / p });
            }
            break;
          }
          case 'ema': {
            const p = cfg.period || 14;
            const sub = candles.slice(-Math.min(count, p * 3)).map(c => c.close);
            const vals = this._calcEMA(sub, p);
            const v = vals[vals.length - 1];
            if (v !== null && v !== undefined) entry.series[0].update({ time: lastTime, value: v });
            break;
          }
          case 'wma': {
            const p = cfg.period || 14;
            const sub = candles.slice(-p).map(c => c.close);
            if (sub.length >= p) {
              let sum = 0, denom = (p * (p + 1)) / 2;
              for (let i = 0; i < p; i++) sum += sub[i] * (i + 1);
              entry.series[0].update({ time: lastTime, value: sum / denom });
            }
            break;
          }
          case 'bb': {
            const p = cfg.period || 20;
            const sub = candles.slice(-p).map(c => c.close);
            if (sub.length >= p) {
              const mean = sub.reduce((a, b) => a + b, 0) / p;
              const variance = sub.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / p;
              const dev = Math.sqrt(variance) * 2;
              entry.series[0].update({ time: lastTime, value: mean });
              entry.series[1].update({ time: lastTime, value: mean + dev });
              entry.series[2].update({ time: lastTime, value: mean - dev });
            }
            break;
          }
          case 'vwap': {
            const sub = candles.slice(-Math.min(count, 100));
            const vals = this._calcVWAP(sub);
            const v = vals[vals.length - 1];
            if (v !== null && v !== undefined) entry.series[0].update({ time: lastTime, value: v });
            break;
          }
          case 'rsi': {
            const p = cfg.period || 14;
            const sub = candles.slice(-Math.min(count, p * 3)).map(c => c.close);
            const vals = this._calcRSI(sub, p);
            const v = vals[vals.length - 1];
            if (v !== null && v !== undefined) entry.series[0].update({ time: lastTime, value: v });
            break;
          }
          case 'macd': {
            const sub = candles.slice(-Math.min(count, 60)).map(c => c.close);
            const { macdLine, signal } = this._calcMACD(sub);
            const mLast = macdLine[macdLine.length - 1];
            const sLast = signal[signal.length - 1];
            if (mLast !== null && mLast !== undefined) entry.series[0].update({ time: lastTime, value: mLast });
            if (sLast !== null && sLast !== undefined) entry.series[1].update({ time: lastTime, value: sLast });
            break;
          }
          case 'stoch': {
            const sub = candles.slice(-Math.min(count, 30));
            const { kLine, dLine } = this._calcStoch(sub, 14, 3);
            const kLast = kLine[kLine.length - 1];
            const dLast = dLine[dLine.length - 1];
            if (kLast !== null && kLast !== undefined) entry.series[0].update({ time: lastTime, value: kLast });
            if (dLast !== null && dLast !== undefined) entry.series[1].update({ time: lastTime, value: dLast });
            break;
          }
          case 'atr': {
            const p = cfg.period || 14;
            const sub = candles.slice(-Math.min(count, p * 3));
            const vals = this._calcATR(sub, p);
            const v = vals[vals.length - 1];
            if (v !== null && v !== undefined) entry.series[0].update({ time: lastTime, value: v });
            break;
          }
          case 'ichimoku': {
            const sub = candles.slice(-Math.min(count, 80));
            const { tenkan, kijun, senkouA, senkouB } = this._calcIchimoku(sub);
            const tLast = tenkan[tenkan.length - 1];
            const kLast = kijun[kijun.length - 1];
            const aLast = senkouA[senkouA.length - 1];
            const bLast = senkouB[senkouB.length - 1];
            if (tLast !== null && tLast !== undefined) entry.series[0].update({ time: lastTime, value: tLast });
            if (kLast !== null && kLast !== undefined) entry.series[1].update({ time: lastTime, value: kLast });
            if (aLast !== null && aLast !== undefined) entry.series[2].update({ time: lastTime, value: aLast });
            if (bLast !== null && bLast !== undefined) entry.series[3].update({ time: lastTime, value: bLast });
            break;
          }
        }
      } catch(e) { /* ignore series update errors during transitions */ }
    }
  },

  _reloadSavedIndicators() {
    try {
      const saved = JSON.parse(localStorage.getItem('gxm_indicators') || '[]');
      for (const id of saved) this._addIndicator(id);
    } catch(e) {}
    if (window.IndicatorPanel) window.IndicatorPanel.syncUI();
  },

  init(asset) {
    if (asset) this.activeAsset = asset;
    
    // Clear intervals and V-SYNC animations
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.fetchInterval) clearInterval(this.fetchInterval);
    if (this.priceFetchInterval) clearInterval(this.priceFetchInterval);
    if (this.microTickInterval) clearInterval(this.microTickInterval);
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    
    // Clean up previous resize observer and drag event listeners
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (e) {}
      this._resizeObserver = null;
    }
    if (this._dragStartHandler && this._chartContainerRef) {
      try {
        this._chartContainerRef.removeEventListener('mousedown', this._dragStartHandler);
        this._chartContainerRef.removeEventListener('touchstart', this._dragStartHandler);
        this._chartContainerRef.removeEventListener('pointerdown', this._dragStartHandler);
      } catch (e) {}
    }
    if (this._dragEndHandler) {
      try {
        window.removeEventListener('mouseup', this._dragEndHandler);
        window.removeEventListener('touchend', this._dragEndHandler);
        window.removeEventListener('touchcancel', this._dragEndHandler);
        window.removeEventListener('pointerup', this._dragEndHandler);
        window.removeEventListener('pointercancel', this._dragEndHandler);
        window.removeEventListener('blur', this._dragEndHandler);
      } catch (e) {}
    }

    this.currentPrice = 0;
    this.targetPrice = 0;
    
    if (this._clampTimeout) {
      clearTimeout(this._clampTimeout);
      this._clampTimeout = null;
    }
    
    // Clean up indicator series before destroying chart
    this._cleanupIndicators();

    // Destroy previous chart if it exists to release resources
    if (this.tvChart) {
      try {
        this.tvChart.remove();
      } catch (e) {
        console.warn('Failed to remove chart:', e);
      }
      this.tvChart = null;
    }
    
    // Clear series references
    this.candlestickSeries = null;
    this.areaSeries = null;
    this.barSeries = null;
    this.priceLines = [];
    this._lastTradeKeys = '';

    // Clear cached DOM elements & rects to allow clean garbage collection and re-init
    this._priceEl = null;
    this._chartOverlaysEl = null;
    this._gainexChartEl = null;
    this._pBarGreen = null;
    this._pBarRed = null;
    this._pLabelGreen = null;
    this._pLabelRed = null;
    this._greenEl = null;
    this._redEl = null;
    this._greenPctEl = null;
    this._redPctEl = null;
    this._cachedCanvasRect = null;
    this._cachedContainerRect = null;
    this._lastRectUpdate = 0;
    this._lastDisplayGreen = null;
    this._lastFormattedPrice = null;
    this._mainCanvasEl = null;
    this._scrollRafPending = false;
    this._lastDrawingRedrawMs = 0;
    this._lastHeikinUpdateMs = 0;
    this._timerEl = null;
    this._verticalLineEl = null;
    this._cachedLastCandleX = undefined;
    this._cachedLastCandleXTime = null;
    this._lastLastCandleXUpdate = 0;
    this._lastPeriodicTickMs = 0;
    this._lastDynamicRenderMs = 0;
    this._timestampToCandleTimeCache = {};

    const container = document.getElementById('gainex-chart');
    if (!container) {
      console.warn('Chart container not found');
      return;
    }
    this._chartContainerRef = container;
    
    // Initialize TV Lightweight Chart
    const w = container.clientWidth || container.offsetWidth || 600;
    const h = container.clientHeight || container.offsetHeight || 400;
    
    const isLightTheme = document.body.classList.contains('light-theme');
    const chartBgColor = isLightTheme ? '#ffffff' : '#0d1221';
    const chartTextColor = isLightTheme ? '#0f172a' : '#8a99ad';
    const chartGridColor = isLightTheme ? 'rgba(0, 0, 0, 0.06)' : 'rgba(37, 54, 92, 0.65)';
    const chartBorderColor = isLightTheme ? 'rgba(0, 0, 0, 0.08)' : 'rgba(37, 54, 92, 0.5)';

    // Clear existing TV chart markup and show a clean premium loading spinner
    container.innerHTML = `
      <div id="chart-loading-indicator" style="
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: ${chartBgColor};
        z-index: 100;
        font-family: 'Outfit', sans-serif;
        color: ${chartTextColor};
        gap: 12px;
        transition: opacity 0.25s ease;
      ">
        <div class="chart-spinner" style="
          width: 32px;
          height: 32px;
          border: 3px solid rgba(26, 183, 109, 0.15);
          border-radius: 50%;
          border-top-color: #1ab76d;
          animation: chartSpin 0.8s linear infinite;
        "></div>
        <span style="font-size: 13px; font-weight: 500; letter-spacing: 0.5px; opacity: 0.85;">Loading Chart...</span>
      </div>
      <style>
        @keyframes chartSpin {
          to { transform: rotate(360deg); }
        }
      </style>
    `;

    const isMobileView = w < 768 || window.innerWidth < 768;
    const defaultBarSpacing = isMobileView ? 18 : 28;

    this.tvChart = LightweightCharts.createChart(container, {
      width: w,
      height: h,
      layout: {
        background: { type: LightweightCharts.ColorType.Solid, color: chartBgColor },
        textColor: chartTextColor,
        fontFamily: 'Outfit, sans-serif',
      },
      grid: {
        vertLines: { color: chartGridColor },
        horzLines: { color: chartGridColor },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: chartBorderColor,
        visible: true,
        autoScale: true,
        mode: LightweightCharts.PriceScaleMode.Normal,
        alignLabels: true,
        scaleMargins: {
          top: 0.2,
          bottom: 0.2,
        },
      },
      leftPriceScale: {
        visible: false,
        borderVisible: false,
      },
      timeScale: {
        borderColor: chartBorderColor,
        timeVisible: true,
        secondsVisible: false,
        barSpacing: defaultBarSpacing,
        rightOffset: (window.innerWidth < 768 ? 12 : 8),
        shiftVisibleRangeOnNewBar: true,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        mouseWheel: true,
        pinch: true,
      },
      kineticScroll: {
        touch: true,
        mouse: true,
      },
      autoSize: true,
    });

    try {
      this.tvChart.priceScale('left').applyOptions({
        visible: false,
        borderVisible: false,
      });
    } catch (e) {
      console.warn('Failed to apply left scale options:', e);
    }

    // 1. Smooth Scrolling & Drag-Clamping Logic to prevent lag and glitching
    this._isUserDragging = false;
    let isUpdatingRange = false;

    // Helper function to clamp the visible range back to the maximum allowed right position
    this._clampVisibleRange = () => {
      if (isUpdatingRange || !this.tvChart || !this.candles || !this.candles.length) return;
      const range = this.tvChart.timeScale().getVisibleLogicalRange();
      if (!range) return;
      const total = this.candles.length;
      const span = range.to - range.from;
      const maxFrom = Math.max(0, total - Math.floor(span * 0.5));
      if (range.from > maxFrom) {
        isUpdatingRange = true;
        this.tvChart.timeScale().setVisibleLogicalRange({
          from: maxFrom,
          to: maxFrom + span
        });
        isUpdatingRange = false;
      }
    };

    // Event listeners to detect user dragging (to avoid fighting the user and causing lag)
    const startDrag = () => {
      this._isUserDragging = true;
    };
    const endDrag = () => {
      if (this._isUserDragging) {
        this._isUserDragging = false;
        if (this._clampTimeout) {
          clearTimeout(this._clampTimeout);
          this._clampTimeout = null;
        }
        this._clampVisibleRange();
      }
    };

    container.addEventListener('mousedown', startDrag);
    container.addEventListener('touchstart', startDrag, { passive: true });
    container.addEventListener('pointerdown', startDrag, { passive: true });
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('touchend', endDrag);
    window.addEventListener('touchcancel', endDrag);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);

    // Keep references to clean up later
    this._dragStartHandler = startDrag;
    this._dragEndHandler = endDrag;

    // Time scale change listener - throttled overlay sync on scroll/pan
    this.tvChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!this._scrollRafPending) {
        this._scrollRafPending = true;
        requestAnimationFrame(() => {
          this._scrollRafPending = false;
          this.renderOverlays();
        });
      }
    });

    // Create series based on chartStyle
    this._createSeries();

    // Resize handling using ResizeObserver (guarantees chart always fits container perfectly)
    this._resizeHandler = () => {
      if (this.tvChart && container) {
        const rw = container.clientWidth || container.offsetWidth || 600;
        const rh = container.clientHeight || container.offsetHeight || 400;
        if (rw > 0 && rh > 0) {
          this.tvChart.resize(rw, rh);
          // Recalculate and update position of HTML overlays (pills, lines) immediately
          this.renderOverlays();
          // Resize drawing engine canvas to match new chart dimensions
          if (window.DrawingEngine) window.DrawingEngine.resize();
        }
      }
    };

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        this._resizeHandler();
      });
      this._resizeObserver.observe(container);
    }
    window.removeEventListener('resize', this._resizeHandler);
    window.addEventListener('resize', this._resizeHandler);

    // Initial fetch and start ticking
    this.fetchCandles().then(() => {
      this._startLiveTick();
      this.drawActiveTrades();
      this._reloadSavedIndicators();
    });

    // NOTE: No periodic candle re-fetch here by design.
    // The priceFetchInterval (live tick) updates the current candle in memory every second.
    // Historical candles are only re-fetched when the user switches asset or timeframe,
    // which calls init() or fetchCandles() directly.
    // This ensures manipulated candles never snap back to their real shape while the user watches.

    // Create and append overlays container at the end of init to guarantee it's on top of TV Chart canvas
    const overlaysContainer = document.createElement('div');
    overlaysContainer.id = 'chart-overlays';
    overlaysContainer.style.pointerEvents = 'none';
    container.style.position = 'relative';
    container.appendChild(overlaysContainer);
  },
  
  _createSeries() {
    if (!this.tvChart) return;
    
    // Clean up existing series
    if (this.candlestickSeries) { this.tvChart.removeSeries(this.candlestickSeries); this.candlestickSeries = null; }
    if (this.areaSeries) { this.tvChart.removeSeries(this.areaSeries); this.areaSeries = null; }
    if (this.barSeries) { this.tvChart.removeSeries(this.barSeries); this.barSeries = null; }

    const isUpColor = '#089981'; // Premium TradingView green
    const isDownColor = '#f23645'; // Premium TradingView red

    if (this.chartStyle === 'candles' || this.chartStyle === 'heikin') {
      this.candlestickSeries = this.tvChart.addCandlestickSeries({
        upColor: isUpColor,
        downColor: isDownColor,
        borderVisible: false,
        wickUpColor: isUpColor,
        wickDownColor: isDownColor,
      });
    } else if (this.chartStyle === 'area') {
      this.areaSeries = this.tvChart.addAreaSeries({
        topColor: 'rgba(8, 153, 129, 0.25)', // Matching premium green
        bottomColor: 'rgba(8, 153, 129, 0.0)',
        lineColor: isUpColor,
        lineWidth: 2,
      });
    } else if (this.chartStyle === 'bars') {
      this.barSeries = this.tvChart.addBarSeries({
        upColor: isUpColor,
        downColor: isDownColor,
      });
    }
  },

  setChartStyle(style) {
    if (['candles', 'area', 'bars', 'heikin'].includes(style)) {
      this.chartStyle = style;
      this._createSeries();
      this._updateSeriesData();
      this.drawActiveTrades();
    }
  },

  applyTheme(theme) {
    if (!this.tvChart) return;
    const isLightTheme = theme === 'light';
    const chartBgColor = isLightTheme ? '#ffffff' : '#0d1221';
    const chartTextColor = isLightTheme ? '#0f172a' : '#8a99ad';
    const chartGridColor = isLightTheme ? 'rgba(0, 0, 0, 0.06)' : 'rgba(37, 54, 92, 0.65)';
    const chartBorderColor = isLightTheme ? 'rgba(0, 0, 0, 0.08)' : 'rgba(37, 54, 92, 0.5)';

    this.tvChart.applyOptions({
      layout: {
        background: { type: LightweightCharts.ColorType.Solid, color: chartBgColor },
        textColor: chartTextColor,
      },
      grid: {
        vertLines: { color: chartGridColor },
        horzLines: { color: chartGridColor },
      },
      rightPriceScale: {
        borderColor: chartBorderColor,
      },
      timeScale: {
        borderColor: chartBorderColor,
      },
    });
  },

  _updateSeriesData() {
    if (!this.candles.length) return;
    
    const formattedData = this.candles.map(c => {
      c._timeSec = c._timeSec || Math.floor(normalizeTime(c.time) / 1000);
      return {
        time: c._timeSec,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      };
    });

    // Ensure strictly increasing timestamps (TradingView Lightweight charts throws error on duplicates)
    const uniqueData = [];
    const seen = new Set();
    for (const d of formattedData) {
      if (!seen.has(d.time)) {
        seen.add(d.time);
        uniqueData.push(d);
      }
    }

    // Sanitizer removed to allow pristine rendering of candles.



    if (this.chartStyle === 'heikin') {
      const haData = [];
      for (let i = 0; i < uniqueData.length; i++) {
        const c = uniqueData[i];
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        const haOpen = i === 0 ? (c.open + c.close) / 2 : (haData[i - 1].open + haData[i - 1].close) / 2;
        const haHigh = Math.max(c.high, haOpen, haClose);
        const haLow = Math.min(c.low, haOpen, haClose);
        haData.push({ time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose });
      }
      if (this.candlestickSeries) this.candlestickSeries.setData(haData);
    } else if (this.chartStyle === 'candles' && this.candlestickSeries) {
      this.candlestickSeries.setData(uniqueData);
    } else if (this.chartStyle === 'area' && this.areaSeries) {
      this.areaSeries.setData(uniqueData.map(d => ({ time: d.time, value: d.close })));
    } else if (this.chartStyle === 'bars' && this.barSeries) {
      this.barSeries.setData(uniqueData);
    }

    // Hide the loading indicator
    const loader = document.getElementById('chart-loading-indicator');
    if (loader) {
      loader.style.opacity = '0';
      setTimeout(() => {
        if (loader && loader.parentNode) {
          loader.parentNode.removeChild(loader);
        }
      }, 250);
    }
  },
  
  async fetchCandles() {
    const cacheKey = `candles_cache_${this.activeAsset}_${this.activeTimeframe}`;
    let hasLoadedFromCache = false;

    // 1. Try loading from cache first for instant layout presentation
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.candles = parsed;
          const last = this.candles[this.candles.length - 1];
          this.liveTickPrice = last.close;
          this.currentPrice = last.close;
          this.targetPrice = last.close;
          
          this._updatePriceDisplay(last.close);
          this._updateSeriesData();
          if (this.tvChart) {
            try {
              const isMob = window.innerWidth < 768;
              this.tvChart.priceScale('right').applyOptions({ autoScale: true });
              this.tvChart.timeScale().applyOptions({
                barSpacing: isMob ? 18 : 28,
                rightOffset: 0
              });
              this.tvChart.timeScale().scrollToRealTime();
            } catch (err) {}
          }
          hasLoadedFromCache = true;
        }
      }
    } catch (e) {
      console.warn('Failed to load candles from cache:', e);
    }

    // 2. Perform background fetch for fresh data
    try {
      const res = await fetch(`/api/client/candles/${encodeURIComponent(this.activeAsset)}?timeframe=${this.activeTimeframe}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.candles && data.candles.length > 0) {
        this.candles = data.candles;
        const last = this.candles[this.candles.length - 1];
        this.liveTickPrice = last.close;
        this.currentPrice = last.close;
        this.targetPrice = last.close;
        
        // Save fresh data to local cache
        try {
          localStorage.setItem(cacheKey, JSON.stringify(data.candles));
        } catch (cacheErr) {
          // If storage quota exceeded, clear old caches to make room
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key && key.startsWith('candles_cache_')) {
                localStorage.removeItem(key);
              }
            }
            localStorage.setItem(cacheKey, JSON.stringify(data.candles));
          } catch (e) {}
        }

        this._updatePriceDisplay(last.close);
        this._timestampToCandleTimeCache = {}; // Clear coordinates cache
        this._updateSeriesData();
        
        if (this.tvChart) {
          try {
            const isMob = window.innerWidth < 768;
            this.tvChart.priceScale('right').applyOptions({ autoScale: true });
            this.tvChart.timeScale().applyOptions({
              barSpacing: isMob ? 18 : 28,
              rightOffset: 0
            });
            this.tvChart.timeScale().scrollToRealTime();
          } catch (err) {}
        }
      }
    } catch (e) {
      console.warn('Chart fetch failed:', e.message);
    }
  },

  changeTimeframe(tf) {
    this.activeTimeframe = tf;
    this.fetchCandles();
  },

  handleAssetChange(asset) {
    if (!asset) return;
    this.activeAsset = asset;
    this.candles = [];
    if (window.app && window.app.selectedCoin !== undefined) window.app.selectedCoin = asset;
    this.init(asset);
  },

  setActiveTrades(trades) {
    this.activeTrades = trades || [];
    this._lastTradeKeys = ''; // Force overlay pills re-render
    this.drawActiveTrades();
  },

  drawActiveTrades() {
    // Remove old lines first
    this.priceLines.forEach(line => {
      const activeSeries = this.candlestickSeries || this.areaSeries || this.barSeries;
      if (activeSeries) activeSeries.removePriceLine(line);
    });
    this.priceLines = [];

    const activeSeries = this.candlestickSeries || this.areaSeries || this.barSeries;
    if (!activeSeries) return;

    this.activeTrades.forEach(t => {
      // Ensure the trade is for the currently selected coin
      if (t.coin !== this.activeAsset && t.coin !== getCoinBaseSymbol(this.activeAsset)) return;

      const color = t.direction === 'UP' ? 'rgba(8, 153, 129, 0.75)' : 'rgba(242, 54, 69, 0.75)';
      const line = activeSeries.createPriceLine({
        price: parseFloat(t.open_price),
        color: color,
        lineWidth: 1.5,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: false,
        title: '',
      });
      this.priceLines.push(line);
    });

    this.renderOverlays();
  },

  recentClosedTrades: [],
  _lastTradeKeys: '',

  setRecentClosedTrades(trades) {
    this.recentClosedTrades = trades || [];
    this._lastTradeKeys = ''; // Force overlay pills re-render
    this.renderOverlays();
  },

  getCoordinateForTime(timestamp) {
    if (!this.tvChart || !this.candles || this.candles.length === 0) return null;
    const timeSec = typeof timestamp === 'number' ? timestamp : Math.floor(new Date(timestamp).getTime() / 1000);
    
    if (!this._timestampToCandleTimeCache) {
      this._timestampToCandleTimeCache = {};
    }

    let bestCandleTimeSec = this._timestampToCandleTimeCache[timeSec];

    if (bestCandleTimeSec === undefined) {
      // Fast binary search algorithm (O(log N)) over chronologically sorted candles
      let low = 0;
      let high = this.candles.length - 1;
      let minDiff = Infinity;

      while (low <= high) {
        const mid = (low + high) >> 1;
        const candle = this.candles[mid];
        const cTimeSec = candle._timeSec || (candle._timeSec = Math.floor(normalizeTime(candle.time) / 1000));
        const diff = Math.abs(cTimeSec - timeSec);

        if (diff < minDiff) {
          minDiff = diff;
          bestCandleTimeSec = cTimeSec;
        }

        if (cTimeSec < timeSec) {
          low = mid + 1;
        } else if (cTimeSec > timeSec) {
          high = mid - 1;
        } else {
          break; // Exact match
        }
      }
      this._timestampToCandleTimeCache[timeSec] = bestCandleTimeSec;
    }

    if (bestCandleTimeSec !== null) {
      return this.tvChart.timeScale().timeToCoordinate(bestCandleTimeSec);
    }
    return null;
  },

  renderOverlays() {
    if (!this._chartOverlaysEl) this._chartOverlaysEl = document.getElementById('chart-overlays');
    const container = this._chartOverlaysEl;
    if (!container || !this.tvChart) return;

    const activeSeries = this.candlestickSeries || this.areaSeries || this.barSeries;
    if (!activeSeries) return;

    if (!this._gainexChartEl) this._gainexChartEl = document.getElementById('gainex-chart');
    const chartContainer = this._gainexChartEl;
    let width = this._cachedWidth || 600;
    let height = this._cachedHeight || 400;

    if (chartContainer) {
      const mainCanvas = chartContainer.querySelector('canvas');
      if (mainCanvas) {
        const now = Date.now();
        // Throttle getBoundingClientRect calls to at most once per 1000ms
        if (!this._cachedCanvasRect || !this._lastRectUpdate || now - this._lastRectUpdate > 1000) {
          const canvasRect = mainCanvas.getBoundingClientRect();
          const containerRect = chartContainer.getBoundingClientRect();
          this._cachedCanvasRect = canvasRect;
          this._cachedContainerRect = containerRect;
          this._lastRectUpdate = now;
          this._cachedWidth = canvasRect.width;
          this._cachedHeight = canvasRect.height;

          container.style.position = 'absolute';
          container.style.left = `${canvasRect.left - containerRect.left}px`;
          container.style.top = `${canvasRect.top - containerRect.top}px`;
          container.style.width = `${canvasRect.width}px`;
          container.style.height = `${canvasRect.height}px`;
        }

        width = this._cachedWidth;
        height = this._cachedHeight;
      }
    }

    // Check if any active trade pill elements are missing from the DOM container
    let missingPills = false;
    for (const t of this.activeTrades) {
      if ((t.coin === this.activeAsset || t.coin === getCoinBaseSymbol(this.activeAsset)) && !document.getElementById(`pill-${t.id}`)) {
        missingPills = true;
        break;
      }
    }
    if (missingPills) {
      this._lastTradeKeys = '';
    }

    // Generate a unique key for the current trades state
    const currentKey = this.activeTrades.map(t => `${t.id}_${t.open_price}`).join(',') + '|' + 
                       this.recentClosedTrades.map(t => `${t.id}_${t.status}`).join(',');

    // Re-create the DOM elements only if the active/closed trades list has changed
    if (this._lastTradeKeys !== currentKey) {
      this._lastTradeKeys = currentKey;
      
      // Clean up previous trade pills, preserving the candle timer and vertical line
      const childrenToRemove = Array.from(container.children).filter(child => 
        child.id !== 'candle-timer-overlay' && child.id !== 'candle-vertical-line'
      );
      childrenToRemove.forEach(child => container.removeChild(child));

      // Create Active Trades Elements
      this.activeTrades.forEach(t => {
        if (t.coin !== this.activeAsset && t.coin !== getCoinBaseSymbol(this.activeAsset)) return;

        const isUp = t.direction === 'UP';

        // Connector line
        const connector = document.createElement('div');
        connector.className = `trade-connector-line ${isUp ? 'up' : 'down'}`;
        connector.id = `connector-${t.id}`;
        connector.style.display = 'none';
        container.appendChild(connector);

        // Dots container
        const dots = document.createElement('div');
        dots.className = 'trade-entry-dots';
        dots.id = `dots-${t.id}`;
        dots.style.display = 'none';

        const dot1 = document.createElement('div');
        dot1.className = 'trade-entry-dot';
        const dot2 = document.createElement('div');
        dot2.className = 'trade-entry-dot';
        dots.appendChild(dot1);
        dots.appendChild(dot2);
        container.appendChild(dots);

        // Pill container
        const pill = document.createElement('div');
        pill.className = `active-trade-pill ${isUp ? 'up' : 'down'}`;
        pill.id = `pill-${t.id}`;
        pill.style.display = 'none';
        container.appendChild(pill);
      });

      // Create Closed Trades Elements
      this.recentClosedTrades.forEach(t => {
        if (t.coin !== this.activeAsset && t.coin !== getCoinBaseSymbol(this.activeAsset)) return;

        const isWin = t.status === 'win';
        const currencyCode = (typeof app !== 'undefined' && app.user) ? app.user.currency : 'USD';
        const stakeVal = (typeof app !== 'undefined' && app.getTradeDisplayAmount) ? app.getTradeDisplayAmount(t, currencyCode) : t.amount;
        const profit = stakeVal * (t.commission_pct / 100.0);
        const displayVal = isWin 
          ? `+${typeof app !== 'undefined' ? app.formatCurrency(profit, currencyCode) : '$' + profit.toFixed(2)}` 
          : (typeof app !== 'undefined' ? app.formatCurrency(0, currencyCode) : '$0.00');

        const resPill = document.createElement('div');
        resPill.className = `closed-trade-result-pill ${isWin ? 'win' : 'lose'}`;
        resPill.id = `closed-pill-${t.id}`;
        resPill.style.display = 'none';
        
        const arrowIcon = t.direction === 'UP' ? '▲' : '▼';
        resPill.innerHTML = `
          <span class="result-title">RESULT (P/L)</span>
          <span class="result-val">${arrowIcon} ${displayVal}</span>
        `;

        // Close button '✕'
        const closeBtn = document.createElement('span');
        closeBtn.className = 'result-close';
        closeBtn.innerHTML = '✕';
        closeBtn.onclick = (e) => {
          e.stopPropagation();
          if (window.closeChartResultPill) {
            window.closeChartResultPill(t.id);
          }
        };
        resPill.appendChild(closeBtn);
        container.appendChild(resPill);
      });
    }

    // Now, update positions and content of all elements
    // 1. Update Active Trades
    this.activeTrades.forEach(t => {
      if (t.coin !== this.activeAsset && t.coin !== getCoinBaseSymbol(this.activeAsset)) return;

      const y = activeSeries.priceToCoordinate(parseFloat(t.open_price));
      if (!t._parsedCreatedAt) {
        t._parsedCreatedAt = Math.floor(new Date(t.created_at).getTime() / 1000);
      }
      const entryX = this.getCoordinateForTime(t._parsedCreatedAt);

      // Update dots
      const dotsEl = document.getElementById(`dots-${t.id}`);
      if (dotsEl) {
        if (y !== null && entryX !== null && y >= 0 && y <= height && entryX >= 0 && entryX <= width) {
          dotsEl.style.left = `${entryX}px`;
          dotsEl.style.top = `${y}px`;
          dotsEl.style.display = 'flex';
        } else {
          dotsEl.style.display = 'none';
        }
      }

      // Update connector & pill
      const connectorEl = document.getElementById(`connector-${t.id}`);
      const pillEl = document.getElementById(`pill-${t.id}`);
      if (pillEl) {
        if (y !== null && entryX !== null && y >= 0 && y <= height) {
          let pillX = entryX - 55;
          if (pillX < 40) {
            pillX = 40;
          }

          const expiryTime = new Date(t.expires_at).getTime();
          const adjustedNow = Date.now() - ((typeof app !== 'undefined' && app.clientServerTimeOffset !== undefined) ? app.clientServerTimeOffset : 0);
          const timeLeftSec = Math.ceil((expiryTime - adjustedNow) / 1000);
          let timerStr = '00:00';
          if (timeLeftSec > 0) {
            const m = Math.floor(timeLeftSec / 60).toString().padStart(2, '0');
            const s = (timeLeftSec % 60).toString().padStart(2, '0');
            timerStr = `${m}:${s}`;
          } else {
            timerStr = 'Settling...';
          }

          pillEl.style.left = `${pillX}px`;
          pillEl.style.top = `${y}px`;
          pillEl.style.display = 'flex';

          const arrowIcon = t.direction === 'UP' ? '▲' : '▼';
          const currencyCode = (typeof app !== 'undefined' && app.user) ? app.user.currency : 'USD';
          const formattedAmount = (typeof app !== 'undefined' && app.formatTradeAmount)
            ? app.formatTradeAmount(t, currencyCode)
            : `$${t.amount}`;

          const contentKey = `${arrowIcon}_${formattedAmount}_${timerStr}`;
          if (pillEl._contentKey !== contentKey) {
            pillEl._contentKey = contentKey;
            pillEl.innerHTML = `<span class="arrow-circle">${arrowIcon}</span> <span>${formattedAmount}</span> <span style="opacity: 0.8; font-size: 10px; margin-left: 4px;">${timerStr}</span>`;
          }

          if (connectorEl) {
            connectorEl.style.left = `${pillX}px`;
            connectorEl.style.width = `${entryX - pillX}px`;
            connectorEl.style.top = `${y}px`;
            connectorEl.style.display = 'block';
          }
        } else {
          pillEl.style.display = 'none';
          if (connectorEl) connectorEl.style.display = 'none';
        }
      }
    });

    // 2. Update Closed Trades
    this.recentClosedTrades.forEach(t => {
      if (t.coin !== this.activeAsset && t.coin !== getCoinBaseSymbol(this.activeAsset)) return;

      const y = activeSeries.priceToCoordinate(parseFloat(t.open_price));
      if (!t._parsedCreatedAt) {
        t._parsedCreatedAt = Math.floor(new Date(t.created_at).getTime() / 1000);
      }
      const entryX = this.getCoordinateForTime(t._parsedCreatedAt);

      const closedPillEl = document.getElementById(`closed-pill-${t.id}`);
      if (closedPillEl) {
        if (y !== null && entryX !== null && y >= 0 && y <= height && entryX >= 0 && entryX <= width) {
          let closedX = entryX - 60;
          if (closedX < 50) {
            closedX = 50;
          }
          closedPillEl.style.left = `${closedX}px`;
          closedPillEl.style.top = `${y}px`;
          closedPillEl.style.display = 'flex';
        } else {
          closedPillEl.style.display = 'none';
        }
      }
    });

    // Trigger fast dynamic overlays sync
    this.renderDynamicOverlays();

    // Notify drawing engine to redraw in sync with chart viewport changes (throttled to 100ms)
    if (window.DrawingEngine) {
      const _now = Date.now();
      if (!this._lastDrawingRedrawMs || _now - this._lastDrawingRedrawMs >= 100) {
        this._lastDrawingRedrawMs = _now;
        window.DrawingEngine.redraw();
      }
    }
  },

  renderDynamicOverlays() {
    if (!this._chartOverlaysEl) this._chartOverlaysEl = document.getElementById('chart-overlays');
    const container = this._chartOverlaysEl;
    if (!container || !this.tvChart) return;

    const activeSeries = this.candlestickSeries || this.areaSeries || this.barSeries;
    if (!activeSeries) return;

    if (!this._gainexChartEl) this._gainexChartEl = document.getElementById('gainex-chart');
    const chartContainer = this._gainexChartEl;
    if (!chartContainer) return;

    if (!this._mainCanvasEl || !this._mainCanvasEl.isConnected) {
      this._mainCanvasEl = chartContainer.querySelector('canvas');
    }
    const mainCanvas = this._mainCanvasEl;
    if (!mainCanvas) return;

    const now = Date.now();
    // Cache/throttle rect dimensions
    if (!this._cachedCanvasRect || !this._lastRectUpdate || now - this._lastRectUpdate > 1000) {
      const canvasRect = mainCanvas.getBoundingClientRect();
      const containerRect = chartContainer.getBoundingClientRect();
      this._cachedCanvasRect = canvasRect;
      this._cachedContainerRect = containerRect;
      this._lastRectUpdate = now;
      this._cachedWidth = canvasRect.width;
      this._cachedHeight = canvasRect.height;

      container.style.position = 'absolute';
      container.style.left = `${canvasRect.left - containerRect.left}px`;
      container.style.top = `${canvasRect.top - containerRect.top}px`;
      container.style.width = `${canvasRect.width}px`;
      container.style.height = `${canvasRect.height}px`;
    }

    const width = this._cachedWidth;
    const height = this._cachedHeight;

    if (!this._timerEl || !this._timerEl.isConnected) {
      this._timerEl = document.getElementById('candle-timer-overlay');
    }
    let timerEl = this._timerEl;

    if (!this._verticalLineEl || !this._verticalLineEl.isConnected) {
      this._verticalLineEl = document.getElementById('candle-vertical-line');
    }
    let verticalLineEl = this._verticalLineEl;

    if (!timerEl) {
      timerEl = document.createElement('div');
      timerEl.id = 'candle-timer-overlay';
      timerEl.style.cssText = `
        position: absolute;
        z-index: 45;
        background: rgba(20, 26, 40, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 4px;
        padding: 2px 7px;
        color: #ffffff;
        font-family: 'Outfit', -apple-system, BlinkMacSystemFont, monospace;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.2;
        letter-spacing: 0.5px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
        pointer-events: none;
        transform: translateY(-50%);
        display: none;
        white-space: nowrap;
      `;
      container.appendChild(timerEl);
      this._timerEl = timerEl;
    }

    if (!verticalLineEl) {
      verticalLineEl = document.createElement('div');
      verticalLineEl.id = 'candle-vertical-line';
      verticalLineEl.style.cssText = `
        position: absolute;
        z-index: 40;
        width: 1px;
        border-left: 1px dashed rgba(255, 255, 255, 0.25);
        pointer-events: none;
        display: none;
      `;
      container.appendChild(verticalLineEl);
      this._verticalLineEl = verticalLineEl;
    }

    if (this.candles && this.candles.length > 0) {
      const last = this.candles[this.candles.length - 1];
      const y = activeSeries.priceToCoordinate(this.liveTickPrice || this.currentPrice || last.close);
      if (!last._timeSec) {
        last._timeSec = Math.floor(normalizeTime(last.time) / 1000);
      }
      // Get candle X coordinate smoothly on every tick (binary search is eliminated via O(1) cache above, so this is cheap and lag-free)
      const candleX = this.tvChart.timeScale().timeToCoordinate(last._timeSec);

      if (y !== null && candleX !== null && y >= 0 && y <= height && candleX >= 0 && candleX <= width) {
        let tfMs = 60000; // default 1m
        switch (this.activeTimeframe) {
          case '5s': tfMs = 5000; break;
          case '10s': tfMs = 10000; break;
          case '15s': tfMs = 15000; break;
          case '30s': tfMs = 30000; break;
          case '1m': tfMs = 60000; break;
          case '5m': tfMs = 300000; break;
          case '15m': tfMs = 900000; break;
          case '30m': tfMs = 1800000; break;
          case '1h': tfMs = 3600000; break;
          case '1d': tfMs = 86400000; break;
          case '1w': tfMs = 604800000; break;
          case '1mo': tfMs = 2592000000; break;
        }

        const currentPeriodStart = Math.floor(now / tfMs) * tfMs;
        const currentPeriodEnd = currentPeriodStart + tfMs;
        const remainingMs = Math.max(0, currentPeriodEnd - now);
        const remainingSec = Math.floor(remainingMs / 1000);

        let timerStr = '00:00';
        if (remainingSec >= 3600) {
          const h = Math.floor(remainingSec / 3600).toString().padStart(2, '0');
          const m = Math.floor((remainingSec % 3600) / 60).toString().padStart(2, '0');
          const s = (remainingSec % 60).toString().padStart(2, '0');
          timerStr = `${h}:${m}:${s}`;
        } else {
          const m = Math.floor(remainingSec / 60).toString().padStart(2, '0');
          const s = (remainingSec % 60).toString().padStart(2, '0');
          timerStr = `${m}:${s}`;
        }

        if (timerEl._lastTimerStr !== timerStr) {
          timerEl._lastTimerStr = timerStr;
          timerEl.textContent = timerStr;
        }
        timerEl.style.top = `${y}px`;
        const timerLeft = Math.min(width - 60, Math.max(10, candleX + 16));
        timerEl.style.left = `${timerLeft}px`;
        timerEl.style.display = 'block';

        verticalLineEl.style.left = `${candleX}px`;
        verticalLineEl.style.top = '0px';
        verticalLineEl.style.height = `${height}px`;
        verticalLineEl.style.display = 'block';
      } else {
        timerEl.style.display = 'none';
        verticalLineEl.style.display = 'none';
      }
    } else {
      if (timerEl) timerEl.style.display = 'none';
      if (verticalLineEl) verticalLineEl.style.display = 'none';
    }
  },

  _startLiveTick() {
    // Clear existing live ticks and animation frames
    if (this.priceFetchInterval) clearInterval(this.priceFetchInterval);
    if (this.microTickInterval) clearInterval(this.microTickInterval);
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);

    // Initial price state from the last candle
    if (this.candles.length > 0) {
      const last = this.candles[this.candles.length - 1];
      this.currentPrice = last.close;
      this.targetPrice = last.close;
      this.liveTickPrice = last.close;
    }

    // 1. Fetch real price quote from API every 1000ms with in-flight lock
    this._isFetchingPrice = false;
    this.priceFetchInterval = setInterval(async () => {
      if (!this.candles.length || this._isFetchingPrice) return;
      this._isFetchingPrice = true;
      const last = this.candles[this.candles.length - 1];
      try {
        const res = await fetch(`/api/client/price/${encodeURIComponent(this.activeAsset)}`);
        if (!res.ok) {
          try {
            const data = await res.json();
            if (data.error === 'Trading is not enabled for this coin.') {
              if (window.app) window.app.handleAssetDisabled(this.activeAsset);
            }
          } catch(err){}
          throw new Error('API fetch error');
        }
        const data = await res.json();
        if (typeof data.price === 'number' && data.price > 0) {
          const refPrice = this.currentPrice || last.close;
          // Reject prices that deviate more than 20% from current in one tick (likely API glitch/spike)
          const deviation = refPrice ? Math.abs(data.price - refPrice) / refPrice : 0;
          if (deviation <= 0.20) {
            this.targetPrice = data.price;
          }
        }
      } catch (e) {
        // Fallback target random walk only if API fails completely
        const isForex = this.activeAsset.includes('/') || this.activeAsset.toUpperCase().includes('OTC');
        const vol = isForex ? 0.00008 : 0.00025;
        const tick = (this.targetPrice || last.close) * vol * (Math.random() * 2 - 1);
        this.targetPrice = Math.max((this.targetPrice || last.close) * 0.5, (this.targetPrice || last.close) + tick);
      } finally {
        this._isFetchingPrice = false;
      }
    }, 1000);

    // 2. Realistic 60FPS / 120FPS V-SYNC Linear Interpolation (LERP) easing towards real market quotes
    const animate = () => {
      try {
        if (this.tvChart && this.candles && this.candles.length) {
          const last = this.candles[this.candles.length - 1];
          if (last) {
            if (this.currentPrice === undefined || isNaN(this.currentPrice)) this.currentPrice = last.close;
            if (this.targetPrice === undefined || isNaN(this.targetPrice)) this.targetPrice = last.close;

            // Natural market easing towards the active price quote
            this.currentPrice += (this.targetPrice - this.currentPrice) * 0.08;
            this._applyRenderTick(this.currentPrice);
          }
        }
      } catch (err) {
        // Guard against temporary series transition exceptions to keep loop alive
      } finally {
        this.animationFrameId = requestAnimationFrame(animate);
      }
    };

    this.animationFrameId = requestAnimationFrame(animate);
  },

  _applyRenderTick(price) {
    if (!this.tvChart || !this.candles || !this.candles.length) return;
    const last = this.candles[this.candles.length - 1];
    if (!last) return;

    this.liveTickPrice = price;
    const now = Date.now();

    let tfMs = 60000;
    switch (this.activeTimeframe) {
      case '5s': tfMs = 5000; break;
      case '10s': tfMs = 10000; break;
      case '15s': tfMs = 15000; break;
      case '30s': tfMs = 30000; break;
      case '1m': tfMs = 60000; break;
      case '5m': tfMs = 300000; break;
      case '15m': tfMs = 900000; break;
      case '30m': tfMs = 1800000; break;
      case '1h': tfMs = 3600000; break;
      case '1d': tfMs = 86400000; break;
      case '1w': tfMs = 604800000; break;
      case '1mo': tfMs = 2592000000; break;
    }
    const currentPeriod = Math.floor(now / tfMs) * tfMs;
    const lastCandleTimeSec = Math.floor(normalizeTime(last.time) / 1000);
    const currentPeriodSec = Math.floor(currentPeriod / 1000);

    let updatedCandle;
    if (lastCandleTimeSec < currentPeriodSec) {
      // Create new candle at timeframe boundary
      const newCandle = {
        time: currentPeriod,
        open: last.close,
        high: price,
        low: price,
        close: price
      };
      this.candles.push(newCandle);
      if (this.candles.length > 3000) this.candles.shift();
      updatedCandle = newCandle;
    } else {
      last.high = Math.max(last.high, price);
      last.low  = Math.min(last.low,  price);
      last.close = price;
      updatedCandle = last;
    }

    // Notify parent app of live price tick for pending trade quote matching
    if (window.app && typeof window.app.checkPendingTradesTrigger === 'function') {
      window.app.checkPendingTradesTrigger('quote', price);
    }

    // Update series data with latest tick
    const activeSeries = this.candlestickSeries || this.areaSeries || this.barSeries;
    if (activeSeries) {
      if (this.chartStyle === 'heikin') {
        const _hn = Date.now();
        if (!this._lastHeikinUpdateMs || _hn - this._lastHeikinUpdateMs >= 500) {
          this._lastHeikinUpdateMs = _hn;
          this._updateSeriesData();
        }
      } else {
        if (this.chartStyle === 'area') {
          activeSeries.update({
            time: Math.floor(normalizeTime(updatedCandle.time) / 1000),
            value: updatedCandle.close
          });
        } else {
          activeSeries.update({
            time: Math.floor(normalizeTime(updatedCandle.time) / 1000),
            open: updatedCandle.open,
            high: updatedCandle.high,
            low: updatedCandle.low,
            close: updatedCandle.close
          });
        }
      }
    }

    this._updatePriceDisplay(price);
    
    // Render dynamic timer/line overlays and indicator ticks
    this.renderDynamicOverlays();
    this._updateIndicatorTick();

    // Throttle trade pill overlay scan to max 10Hz (once per 100ms)
    if (!this._lastOverlaySyncMs || now - this._lastOverlaySyncMs >= 100) {
      this._lastOverlaySyncMs = now;
      this.renderOverlays();
    }

    // Update real-time sentiment pressure smoothly
    if (last.high > last.low) {
      const ratio = (price - last.low) / (last.high - last.low);
      const targetGreen = Math.round(15 + ratio * 70); // clamp between 15% and 85%
      
      if (this.currentSentiment === undefined) this.currentSentiment = 50;
      this.currentSentiment += (targetGreen - this.currentSentiment) * 0.15; // smooth transition
      
      const displayGreen = Math.round(this.currentSentiment);
      const displayRed = 100 - displayGreen;

      if (this._lastDisplayGreen !== displayGreen) {
        this._lastDisplayGreen = displayGreen;

        // Cache elements on first fetch
        if (!this._pBarGreen) this._pBarGreen = document.getElementById('pressure-bar-green');
        if (!this._pBarRed) this._pBarRed = document.getElementById('pressure-bar-red');
        if (!this._pLabelGreen) this._pLabelGreen = document.getElementById('pressure-label-green');
        if (!this._pLabelRed) this._pLabelRed = document.getElementById('pressure-label-red');
        
        if (this._pBarGreen && this._pBarRed) {
          this._pBarGreen.style.height = `${displayGreen}%`;
          this._pBarRed.style.height = `${displayRed}%`;
        }
        if (this._pLabelGreen) this._pLabelGreen.textContent = `${displayGreen}%`;
        if (this._pLabelRed) this._pLabelRed.textContent = `${displayRed}%`;

        // Update original horizontal sentiment bar elements
        if (!this._greenEl) this._greenEl = document.getElementById('sentiment-bar-green');
        if (!this._redEl) this._redEl = document.getElementById('sentiment-bar-red');
        if (!this._greenPctEl) this._greenPctEl = document.getElementById('sentiment-green-pct');
        if (!this._redPctEl) this._redPctEl = document.getElementById('sentiment-red-pct');
        
        if (this._greenEl && this._redEl) {
          this._greenEl.style.height = `${displayGreen}%`;
          this._redEl.style.height = `${displayRed}%`;
        }
        if (this._greenPctEl) this._greenPctEl.textContent = `${displayGreen}%`;
        if (this._redPctEl) this._redPctEl.textContent = `${displayRed}%`;
      }
    }
  },

  updateChartWithNewPrice(price) {
    if (typeof price === 'number' && price > 0) {
      this.targetPrice = price;
      if (!this.currentPrice) this.currentPrice = price;
    }
  },

  _updatePriceDisplay(price) {
    const now = Date.now();
    // Throttle DOM text updates to 15Hz (once per 66ms) to prevent iOS WebKit layout thrashing
    if (this._lastPriceDisplayUpdateMs && now - this._lastPriceDisplayUpdateMs < 66) {
      return;
    }
    this._lastPriceDisplayUpdateMs = now;

    if (!this._priceEl) {
      this._priceEl = document.getElementById('trade-live-price');
    }
    if (!this._priceEl) return;

    const isForex = this.activeAsset.includes('/') || this.activeAsset.toUpperCase().includes('OTC');
    const decimals = isForex ? 5 : (price > 100 ? 2 : 4);
    
    // Fast en-US locale equivalent formatting (much faster than price.toLocaleString)
    const fixed = price.toFixed(decimals);
    let formatted;
    if (price < 1000) {
      formatted = fixed;
    } else {
      const parts = fixed.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      formatted = parts.join('.');
    }

    if (this._lastFormattedPrice !== formatted) {
      this._lastFormattedPrice = formatted;
      this._priceEl.textContent = formatted;
    }
  },

  // ─── Zoom Controls ───────────────────────────────────────────────────────────
  // Uses the Lightweight Charts timeScale().scrollToPosition() API to zoom in/out
  // by adjusting the visible bar count (barSpacing).

  zoomIn() {
    if (!this.tvChart) return;
    const ts = this.tvChart.timeScale();
    const options = ts.options();
    const current = options.barSpacing || 6;
    // Increase spacing by 25%, capped at 50px per candle
    const next = Math.min(50, current * 1.25);
    ts.applyOptions({ barSpacing: next });
  },

  zoomOut() {
    if (!this.tvChart) return;
    const ts = this.tvChart.timeScale();
    const options = ts.options();
    const current = options.barSpacing || 6;
    // Decrease spacing by 20%, minimum 2px per candle
    const next = Math.max(2, current / 1.25);
    ts.applyOptions({ barSpacing: next });
  }
};

window.chart = chart;
