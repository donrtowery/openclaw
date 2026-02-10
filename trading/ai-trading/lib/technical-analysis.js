import { getCandles } from './binance.js';
import {
  calcRSI, calcMACD, calcSMAs, calcEMAs,
  calcBollingerBands, calcVolume, calcSupportResistance, calcTrend,
} from './indicators.js';
import logger from './logger.js';

// ── Candle cache (5-minute TTL) ─────────────────────────────

const candleCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheKey(symbol, interval) {
  return `${symbol}:${interval}`;
}

async function getCachedCandles(symbol, interval, limit) {
  const key = cacheKey(symbol, interval);
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
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
    const p = task().then(result => {
      executing.delete(p);
      return result;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= maxConcurrent) {
      await Promise.race(executing);
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
export async function analyzeSymbol(symbol) {
  let candles1h, candles5m, price;

  try {
    [candles1h, candles5m] = await Promise.all([
      getCachedCandles(symbol, '1h', 200),
      getCachedCandles(symbol, '5m', 200),
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
  const volume = calcVolume(candles1h);
  const { support, resistance } = calcSupportResistance(candles1h, price);
  const trend = calcTrend({ rsi, macd, ema, sma, price });

  return {
    symbol,
    price: Math.round(price * 100) / 100,
    rsi,
    macd,
    sma,
    ema,
    bollingerBands,
    volume,
    support,
    resistance,
    trend,
    timestamp: new Date().toISOString(),
  };
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
  lines.push(`${a.symbol} ($${a.price.toLocaleString()}) — ${dir} ${str}`);

  // Line 2: Indicators
  const parts = [];
  if (a.rsi) parts.push(`RSI:${a.rsi.value}(${a.rsi.signal.toLowerCase()})`);
  if (a.macd) parts.push(`MACD:${a.macd.crossover.toLowerCase()}`);
  if (a.volume) parts.push(`Vol:${a.volume.ratio}x(${a.volume.trend.toLowerCase()})`);
  lines.push(parts.join(' | '));

  // Line 3: MAs and BB
  const maParts = [];
  if (a.sma?.sma200 != null) {
    maParts.push(`price${a.price > a.sma.sma200 ? '>' : '<'}SMA200`);
  }
  if (a.sma?.sma50 != null && a.sma?.sma200 != null) {
    maParts.push(a.sma.sma50 > a.sma.sma200 ? 'golden-cross' : 'death-cross');
  }
  if (a.ema) maParts.push(`EMA:${a.ema.signal.toLowerCase()}`);
  if (a.bollingerBands) maParts.push(`BB:${a.bollingerBands.position.toLowerCase()}(${a.bollingerBands.width.toLowerCase()})`);
  lines.push(maParts.join(' | '));

  // Line 4: S/R
  const srParts = [];
  if (a.support?.length) srParts.push(`S:$${a.support.map(s => s.toLocaleString()).join('/$')}`);
  if (a.resistance?.length) srParts.push(`R:$${a.resistance.map(r => r.toLocaleString()).join('/$')}`);
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
