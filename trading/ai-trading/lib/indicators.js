import { RSI, MACD, SMA, EMA, BollingerBands } from 'technicalindicators';
import logger from './logger.js';

/**
 * Calculate RSI (14 period) from close prices.
 * @param {number[]} closes
 * @returns {{ value: number, signal: string } | null}
 */
export function calcRSI(closes) {
  try {
    const values = RSI.calculate({ values: closes, period: 14 });
    if (values.length === 0) return null;
    const value = Math.round(values[values.length - 1] * 100) / 100;
    let signal = 'NEUTRAL';
    if (value < 30) signal = 'OVERSOLD';
    else if (value < 40) signal = 'APPROACHING_OVERSOLD';
    else if (value > 70) signal = 'OVERBOUGHT';
    else if (value > 60) signal = 'APPROACHING_OVERBOUGHT';
    return { value, signal };
  } catch (err) {
    logger.warn(`RSI calc failed: ${err.message}`);
    return null;
  }
}

/**
 * Calculate MACD (12, 26, 9) from close prices.
 * @param {number[]} closes
 * @returns {{ macd: number, signal: number, histogram: number, crossover: string } | null}
 */
export function calcMACD(closes) {
  try {
    const values = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    if (values.length < 2) return null;
    const current = values[values.length - 1];
    const prev = values[values.length - 2];
    if (current.MACD == null || current.signal == null) return null;

    const macd = Math.round(current.MACD * 1000) / 1000;
    const signal = Math.round(current.signal * 1000) / 1000;
    const histogram = Math.round(current.histogram * 1000) / 1000;

    let crossover = 'NEUTRAL';
    if (prev.MACD <= prev.signal && current.MACD > current.signal) crossover = 'BULLISH';
    else if (prev.MACD >= prev.signal && current.MACD < current.signal) crossover = 'BEARISH';
    else if (current.MACD > current.signal) crossover = 'BULLISH_TREND';
    else if (current.MACD < current.signal) crossover = 'BEARISH_TREND';

    return { macd, signal, histogram, crossover };
  } catch (err) {
    logger.warn(`MACD calc failed: ${err.message}`);
    return null;
  }
}

/**
 * Calculate SMAs at given periods.
 * @param {number[]} closes
 * @param {number[]} periods
 * @returns {Object} e.g. { sma10: 70100, sma30: 69800 }
 */
export function calcSMAs(closes, periods) {
  const result = {};
  for (const period of periods) {
    try {
      if (closes.length < period) {
        result[`sma${period}`] = null;
        continue;
      }
      const values = SMA.calculate({ values: closes, period });
      result[`sma${period}`] = values.length > 0
        ? Math.round(values[values.length - 1] * 100) / 100
        : null;
    } catch {
      result[`sma${period}`] = null;
    }
  }
  return result;
}

/**
 * Calculate EMAs at given periods.
 * @param {number[]} closes
 * @param {number[]} periods
 * @returns {{ ema9: number, ema21: number, signal: string } | null}
 */
export function calcEMAs(closes, periods) {
  const result = {};
  for (const period of periods) {
    try {
      const values = EMA.calculate({ values: closes, period });
      result[`ema${period}`] = values.length > 0
        ? Math.round(values[values.length - 1] * 100) / 100
        : null;
    } catch {
      result[`ema${period}`] = null;
    }
  }
  // Determine signal from EMA9 vs EMA21
  let signal = 'NEUTRAL';
  if (result.ema9 != null && result.ema21 != null) {
    if (result.ema9 > result.ema21) signal = 'BULLISH';
    else if (result.ema9 < result.ema21) signal = 'BEARISH';
  }
  return { ...result, signal };
}

/**
 * Calculate Bollinger Bands (20, 2).
 * @param {number[]} closes
 * @param {number} currentPrice
 * @returns {{ upper, middle, lower, width, position } | null}
 */
export function calcBollingerBands(closes, currentPrice) {
  try {
    const values = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    if (values.length === 0) return null;
    const bb = values[values.length - 1];
    const upper = Math.round(bb.upper * 100) / 100;
    const middle = Math.round(bb.middle * 100) / 100;
    const lower = Math.round(bb.lower * 100) / 100;

    const bandWidth = upper - lower;
    const avgWidth = middle * 0.04; // ~4% is "normal" width
    let width = 'NORMAL';
    if (bandWidth < avgWidth * 0.5) width = 'NARROW';
    else if (bandWidth > avgWidth * 1.5) width = 'WIDE';

    let position = 'MIDDLE';
    const range = upper - lower;
    if (range > 0) {
      const pctInBand = (currentPrice - lower) / range;
      if (pctInBand < 0.2) position = 'LOWER';
      else if (pctInBand > 0.8) position = 'UPPER';
    }

    return { upper, middle, lower, width, position };
  } catch (err) {
    logger.warn(`Bollinger calc failed: ${err.message}`);
    return null;
  }
}

/**
 * Analyze volume from candle data.
 * @param {{ volume: number }[]} candles - 1h candles
 * @returns {{ current, avg24h, ratio, trend } | null}
 */
export function calcVolume(candles) {
  try {
    if (candles.length < 25) return null;
    const recent = candles.slice(-1)[0].volume;
    const last24 = candles.slice(-24);
    const avg24h = last24.reduce((s, c) => s + c.volume, 0) / last24.length;
    const ratio = avg24h > 0 ? Math.round((recent / avg24h) * 100) / 100 : 0;

    // Volume trend: compare last 6h average to prior 6h average
    const last6 = candles.slice(-6);
    const prior6 = candles.slice(-12, -6);
    const avg6 = last6.reduce((s, c) => s + c.volume, 0) / last6.length;
    const avgPrior6 = prior6.reduce((s, c) => s + c.volume, 0) / Math.max(prior6.length, 1);
    let trend = 'STABLE';
    if (avgPrior6 > 0) {
      const change = (avg6 - avgPrior6) / avgPrior6;
      if (change > 0.2) trend = 'INCREASING';
      else if (change < -0.2) trend = 'DECREASING';
    }

    return {
      current: Math.round(recent),
      avg24h: Math.round(avg24h),
      ratio,
      trend,
      spike: ratio > 2.0,
    };
  } catch (err) {
    logger.warn(`Volume calc failed: ${err.message}`);
    return null;
  }
}

/**
 * Find support and resistance levels from swing highs/lows.
 * @param {{ high: number, low: number, close: number }[]} candles - 1h candles
 * @param {number} currentPrice
 * @returns {{ support: number[], resistance: number[] }}
 */
export function calcSupportResistance(candles, currentPrice) {
  try {
    if (candles.length < 10) return { support: [], resistance: [] };

    const swingHighs = [];
    const swingLows = [];
    const lookback = 5;

    for (let i = lookback; i < candles.length - lookback; i++) {
      let isHigh = true;
      let isLow = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].high >= candles[i].high) isHigh = false;
        if (candles[j].low <= candles[i].low) isLow = false;
      }
      if (isHigh) swingHighs.push(candles[i].high);
      if (isLow) swingLows.push(candles[i].low);
    }

    // Cluster nearby levels (within 0.5%)
    const cluster = (levels) => {
      if (levels.length === 0) return [];
      levels.sort((a, b) => a - b);
      const clusters = [[levels[0]]];
      for (let i = 1; i < levels.length; i++) {
        const last = clusters[clusters.length - 1];
        const avg = last.reduce((s, v) => s + v, 0) / last.length;
        if (Math.abs(levels[i] - avg) / avg < 0.005) {
          last.push(levels[i]);
        } else {
          clusters.push([levels[i]]);
        }
      }
      return clusters.map(c => {
        const avg = c.reduce((s, v) => s + v, 0) / c.length;
        return Math.round(avg * 100) / 100;
      });
    };

    const supports = cluster(swingLows).filter(l => l < currentPrice);
    const resistances = cluster(swingHighs).filter(l => l > currentPrice);

    return {
      support: supports.slice(-2).reverse(),
      resistance: resistances.slice(0, 2),
    };
  } catch (err) {
    logger.warn(`S/R calc failed: ${err.message}`);
    return { support: [], resistance: [] };
  }
}

/**
 * Determine overall trend from multiple indicators.
 * @param {object} params - { rsi, macd, ema, sma, price }
 * @returns {{ direction: string, strength: string }}
 */
export function calcTrend({ rsi, macd, ema, sma, price }) {
  let bullish = 0;
  let bearish = 0;
  const total = 5;

  // SMA200 trend
  if (sma?.sma200 != null) {
    if (price > sma.sma200) bullish++;
    else bearish++;
  }

  // SMA50 vs SMA200 (golden/death cross)
  if (sma?.sma50 != null && sma?.sma200 != null) {
    if (sma.sma50 > sma.sma200) bullish++;
    else bearish++;
  }

  // MACD direction
  if (macd) {
    if (macd.crossover === 'BULLISH' || macd.crossover === 'BULLISH_TREND') bullish++;
    else if (macd.crossover === 'BEARISH' || macd.crossover === 'BEARISH_TREND') bearish++;
  }

  // RSI range
  if (rsi) {
    if (rsi.value > 50) bullish++;
    else bearish++;
  }

  // EMA trend
  if (ema) {
    if (ema.signal === 'BULLISH') bullish++;
    else if (ema.signal === 'BEARISH') bearish++;
  }

  let direction = 'SIDEWAYS';
  if (bullish >= 4) direction = 'BULLISH';
  else if (bearish >= 4) direction = 'BEARISH';
  else if (bullish >= 3) direction = 'BULLISH';
  else if (bearish >= 3) direction = 'BEARISH';

  let strength = 'WEAK';
  const dominant = Math.max(bullish, bearish);
  if (dominant >= 5) strength = 'STRONG';
  else if (dominant >= 4) strength = 'MODERATE';

  return { direction, strength };
}
