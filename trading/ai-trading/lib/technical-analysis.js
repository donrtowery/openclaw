import { readFileSync } from 'fs';
import { getCandles } from './binance.js';
import {
  calcRSI, calcMACD, calcSMAs, calcEMAs,
  calcBollingerBands, calcVolume, calcSupportResistance, calcTrend,
  calcATR, calcStochasticRSI, calcADX, calcOBV,
  calcVWAP, calcIchimoku, calcFibonacci,
} from './indicators.js';
import logger from './logger.js';

const tradingConfig = JSON.parse(readFileSync('config/trading.json', 'utf8'));

// ── Candle cache (5-minute TTL) ─────────────────────────────

const candleCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500; // Prevent unbounded growth

function cacheKey(symbol, interval) {
  return `${symbol}:${interval}`;
}

async function getCachedCandles(symbol, interval, limit) {
  const key = cacheKey(symbol, interval);
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Evict stale entries when cache grows too large
  if (candleCache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of candleCache) {
      if (now - v.timestamp > CACHE_TTL) candleCache.delete(k);
    }
    // If still too large after evicting stale, remove oldest entries
    if (candleCache.size >= MAX_CACHE_ENTRIES) {
      const entries = [...candleCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, Math.floor(MAX_CACHE_ENTRIES / 4));
      for (const [k] of toRemove) candleCache.delete(k);
    }
  }

  const data = await getCandles(symbol, interval, limit);
  candleCache.set(key, { data, timestamp: Date.now() });
  return data;
}

// ── Rate-limited parallel execution ─────────────────────────

async function runWithConcurrency(tasks, maxConcurrent = 3) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then(
      result => { executing.delete(p); return result; },
      error => { executing.delete(p); throw error; }
    );
    executing.add(p);
    results.push(p);

    if (executing.size >= maxConcurrent) {
      await Promise.race(executing).catch(() => {});
    }
  }

  return Promise.allSettled(results);
}

// ── Single symbol analysis ──────────────────────────────────

/**
 * Run full technical analysis for one symbol.
 * @param {string} symbol
 * @returns {Promise<object>} Analysis object
 */
export async function analyzeSymbol(symbol, options = {}) {
  let candles1h, candles5m, candles4h, price;

  try {
    [candles1h, candles5m, candles4h] = await Promise.all([
      getCachedCandles(symbol, '1h', 200),
      getCachedCandles(symbol, '5m', 200),
      getCachedCandles(symbol, '4h', 100),
    ]);
  } catch (err) {
    logger.warn(`Failed to fetch candles for ${symbol}: ${err.message}`);
    return { symbol, error: err.message, timestamp: new Date().toISOString() };
  }

  if (!candles1h.length || !candles5m.length) {
    return { symbol, error: 'No candle data', timestamp: new Date().toISOString() };
  }

  price = candles5m[candles5m.length - 1].close;
  const closes1h = candles1h.map(c => c.close);
  const closes5m = candles5m.map(c => c.close);

  const rsi = calcRSI(closes1h);
  const macd = calcMACD(closes1h);
  const smaShort = calcSMAs(closes5m, [10, 30]);
  const smaLong = calcSMAs(closes1h, [50, 200]);
  const sma = { ...smaShort, ...smaLong };
  const ema = calcEMAs(closes1h, [9, 21]);
  const bollingerBands = calcBollingerBands(closes1h, price);
  const volume = calcVolume(candles1h, tradingConfig);
  const { support, resistance } = calcSupportResistance(candles1h, price);
  const trend = calcTrend({ rsi, macd, ema, sma, price });
  const atr = calcATR(candles1h);
  const stochRsi = calcStochasticRSI(closes1h);
  const adx = calcADX(candles1h);
  const obv = calcOBV(candles1h);
  const vwap = calcVWAP(candles1h, price);
  const ichimoku = calcIchimoku(candles1h, price);
  const fibonacci = calcFibonacci(candles1h, price);

  // 4h timeframe trend for macro context
  const closes4h = candles4h.map(c => c.close);
  const trend4h = closes4h.length >= 50 ? calcTrend({
    rsi: calcRSI(closes4h),
    macd: calcMACD(closes4h),
    ema: calcEMAs(closes4h, [9, 21]),
    sma: calcSMAs(closes4h, [50]),
    price,
  }) : null;

  const result = {
    symbol,
    price: price >= 1 ? Math.round(price * 100) / 100 : parseFloat(price.toPrecision(6)),
    rsi,
    macd,
    sma,
    ema,
    bollingerBands,
    volume,
    support,
    resistance,
    trend,
    atr,
    stochRsi,
    adx,
    obv,
    vwap,
    ichimoku,
    fibonacci,
    trend4h,
    timestamp: new Date().toISOString(),
  };

  // Optionally include raw candles for predictive analysis (reuses cache — no extra API calls)
  if (options.includeCandles) {
    result._candles1h = candles1h;
  }

  return result;
}

// ── Multi-symbol analysis ───────────────────────────────────

/**
 * Analyze multiple symbols with rate limiting (max 3 concurrent).
 * @param {string[]} symbols
 * @returns {Promise<object[]>}
 */
export async function analyzeAll(symbols) {
  const tasks = symbols.map(symbol => () => analyzeSymbol(symbol));
  const settled = await runWithConcurrency(tasks, 3);

  return settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    logger.warn(`Analysis failed for ${symbols[i]}: ${result.reason?.message}`);
    return { symbol: symbols[i], error: result.reason?.message, timestamp: new Date().toISOString() };
  });
}

// ── Claude prompt formatters ────────────────────────────────

/**
 * Format a single symbol's analysis for Claude prompt.
 * @param {object} a - Analysis object from analyzeSymbol
 * @returns {string}
 */
export function formatForClaude(a) {
  if (a.error) return `${a.symbol} — TA unavailable: ${a.error}`;

  const lines = [];

  // Line 1: Symbol, price, trend
  const dir = a.trend?.direction || '?';
  const str = a.trend?.strength || '?';
  lines.push(`${a.symbol} ($${a.price.toLocaleString('en-US')}) — ${dir} ${str}`);

  // Line 2: Indicators
  const parts = [];
  if (a.rsi) parts.push(`RSI:${a.rsi.value}(${a.rsi.signal.toLowerCase()})`);
  if (a.macd) parts.push(`MACD:${a.macd.crossover.toLowerCase()}`);
  if (a.volume) parts.push(`Vol:${a.volume.ratio}x(${a.volume.trend.toLowerCase()})`);
  lines.push(parts.join(' | '));

  // Line 3: MAs and BB
  const maParts = [];
  if (a.sma?.sma200 != null) {
    maParts.push(`price${a.price > a.sma.sma200 ? '>' : '<'}SMA200(1h)`);
  }
  if (a.sma?.sma50 != null && a.sma?.sma200 != null) {
    maParts.push(a.sma.sma50 > a.sma.sma200 ? 'golden-cross' : 'death-cross');
  }
  if (a.ema) maParts.push(`EMA:${a.ema.signal.toLowerCase()}`);
  if (a.bollingerBands) maParts.push(`BB:${a.bollingerBands.position.toLowerCase()}(${a.bollingerBands.width.toLowerCase()})`);
  if (a.adx) maParts.push(`ADX:${a.adx.value}(${a.adx.signal.toLowerCase()})`);
  lines.push(maParts.join(' | '));

  // Line 3b: Momentum (StochRSI, ATR)
  const momentumParts = [];
  if (a.stochRsi) momentumParts.push(`StochRSI:K${a.stochRsi.k}/D${a.stochRsi.d}(${a.stochRsi.signal.toLowerCase()})`);
  if (a.atr) momentumParts.push(`ATR:${a.atr.percent}%`);
  if (a.obv) momentumParts.push(`OBV:${a.obv.trend.toLowerCase()}`);
  if (momentumParts.length) lines.push(momentumParts.join(' | '));

  // Line 3c: Advanced indicators (VWAP, Ichimoku, Fibonacci)
  const advParts = [];
  if (a.vwap) advParts.push(`VWAP:$${a.vwap.value >= 1 ? a.vwap.value.toFixed(2) : a.vwap.value.toPrecision(6)}(${a.vwap.signal.toLowerCase()})`);
  if (a.ichimoku) advParts.push(`Ichimoku:${a.ichimoku.signal.toLowerCase()}`);
  if (a.fibonacci?.nearest_support) advParts.push(`Fib-S:${a.fibonacci.nearest_support.level}($${a.fibonacci.nearest_support.price.toFixed(2)})`);
  if (a.fibonacci?.nearest_resistance) advParts.push(`Fib-R:${a.fibonacci.nearest_resistance.level}($${a.fibonacci.nearest_resistance.price.toFixed(2)})`);
  if (advParts.length) lines.push(advParts.join(' | '));

  // Line 3d: 4h timeframe context
  if (a.trend4h) {
    lines.push(`4h: ${a.trend4h.direction} ${a.trend4h.strength}`);
  }

  // Line 4: S/R
  const srParts = [];
  if (a.support?.length) srParts.push(`S:$${a.support.map(s => s.toLocaleString('en-US')).join('/$')}`);
  if (a.resistance?.length) srParts.push(`R:$${a.resistance.map(r => r.toLocaleString('en-US')).join('/$')}`);
  if (srParts.length) lines.push(srParts.join(' | '));

  return lines.join('\n');
}

/**
 * Format all analyses into a single block for Claude prompt.
 * @param {object[]} analyses
 * @returns {string}
 */
export function formatAllForClaude(analyses) {
  return analyses.map(a => formatForClaude(a)).join('\n\n');
}
