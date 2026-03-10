import { RSI, MACD, SMA, EMA, BollingerBands, ATR, ADX, StochasticRSI } from 'technicalindicators';
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
    const value = values[values.length - 1];
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

    const macd = current.MACD;
    const signal = current.signal;
    const histogram = current.histogram;

    let crossover = 'NEUTRAL';
    if (prev.MACD != null && prev.signal != null) {
      if (prev.MACD <= prev.signal && current.MACD > current.signal) crossover = 'BULLISH';
      else if (prev.MACD >= prev.signal && current.MACD < current.signal) crossover = 'BEARISH';
      else if (current.MACD > current.signal) crossover = 'BULLISH_TREND';
      else if (current.MACD < current.signal) crossover = 'BEARISH_TREND';
    } else {
      // Previous values unavailable — detect trend only, not crossover
      if (current.MACD > current.signal) crossover = 'BULLISH_TREND';
      else if (current.MACD < current.signal) crossover = 'BEARISH_TREND';
    }

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
        ? values[values.length - 1]
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
        ? values[values.length - 1]
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
    const upper = bb.upper;
    const middle = bb.middle;
    const lower = bb.lower;

    const bandWidth = upper - lower;
    const avgWidth = middle * 0.04; // ~4% is "normal" width
    let width = 'NORMAL';
    if (bandWidth < avgWidth * 0.5) width = 'NARROW';
    else if (bandWidth > avgWidth * 1.5) width = 'WIDE';

    let position = 'MIDDLE';
    const range = upper - lower;
    if (!range || range <= 0 || !isFinite(range)) {
      position = 'MIDDLE';
    } else {
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
export function calcVolume(candles, config) {
  try {
    if (candles.length < 25) return null;
    // Use second-to-last candle — last candle is still forming and has incomplete volume
    const recent = candles.length >= 2 ? candles.slice(-2)[0].volume : candles.slice(-1)[0].volume;
    // Exclude last candle AND the "current" candle from avg to avoid self-inclusion bias
    const last24 = candles.slice(-26, -2);
    const avg24h = last24.reduce((s, c) => s + c.volume, 0) / last24.length;
    const ratio = avg24h > 0 ? Math.round((recent / avg24h) * 100) / 100 : 0;

    // Volume trend: compare last 6 complete candles to prior 6 (exclude last incomplete)
    const last6 = candles.slice(-7, -1);
    const prior6 = candles.slice(-13, -7);
    const avg6 = last6.reduce((s, c) => s + c.volume, 0) / last6.length;
    const avgPrior6 = prior6.reduce((s, c) => s + c.volume, 0) / Math.max(prior6.length, 1);
    let trend = 'STABLE';
    if (avgPrior6 > 0) {
      const change = (avg6 - avgPrior6) / avgPrior6;
      const trendThreshold = config?.volume_trend_threshold || 0.2;
      if (change > trendThreshold) trend = 'INCREASING';
      else if (change < -trendThreshold) trend = 'DECREASING';
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

/**
 * Calculate ATR (Average True Range, 14 period) for volatility measurement.
 * @param {{ high: number, low: number, close: number }[]} candles
 * @returns {{ value: number, percent: number } | null}
 */
export function calcATR(candles) {
  try {
    if (candles.length < 15) return null;
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const values = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    if (values.length === 0) return null;
    const value = values[values.length - 1];
    const currentPrice = closes[closes.length - 1];
    const percent = currentPrice > 0 ? Math.round((value / currentPrice) * 10000) / 100 : 0;
    return { value, percent };
  } catch (err) {
    logger.warn(`ATR calc failed: ${err.message}`);
    return null;
  }
}

/**
 * Calculate Stochastic RSI (14, 14, 3, 3) for momentum confirmation.
 * @param {number[]} closes
 * @returns {{ k: number, d: number, signal: string } | null}
 */
export function calcStochasticRSI(closes) {
  try {
    if (closes.length < 30) return null;
    const values = StochasticRSI.calculate({
      values: closes,
      rsiPeriod: 14,
      stochasticPeriod: 14,
      kPeriod: 3,
      dPeriod: 3,
    });
    if (values.length === 0) return null;
    const current = values[values.length - 1];
    const k = current.k;
    const d = current.d;
    let signal = 'NEUTRAL';
    if (k < 20 && d < 20) signal = 'OVERSOLD';
    else if (k > 80 && d > 80) signal = 'OVERBOUGHT';
    else if (k > d && k < 30) signal = 'BULLISH_CROSS';
    else if (k < d && k > 70) signal = 'BEARISH_CROSS';
    else if (k > 70) signal = 'APPROACHING_OVERBOUGHT';
    else if (k < 30) signal = 'APPROACHING_OVERSOLD';
    return { k, d, signal };
  } catch (err) {
    logger.warn(`StochRSI calc failed: ${err.message}`);
    return null;
  }
}

/**
 * Calculate ADX (Average Directional Index, 14 period) for trend strength.
 * @param {{ high: number, low: number, close: number }[]} candles
 * @returns {{ value: number, pdi: number, mdi: number, signal: string } | null}
 */
/**
 * Calculate On-Balance Volume (OBV) from candle data.
 * OBV adds volume on up-closes and subtracts on down-closes.
 * @param {{ close: number, volume: number }[]} candles
 * @returns {{ value: number, trend: string } | null}
 */
export function calcOBV(candles) {
  try {
    if (candles.length < 20) return null;
    let obv = 0;
    const obvValues = [0];
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].close > candles[i - 1].close) {
        obv += candles[i].volume;
      } else if (candles[i].close < candles[i - 1].close) {
        obv -= candles[i].volume;
      }
      obvValues.push(obv);
    }
    const current = obvValues[obvValues.length - 1];
    // OBV trend: compare recent 10-period SMA vs prior 10-period SMA
    const recent10 = obvValues.slice(-10);
    const prior10 = obvValues.slice(-20, -10);
    const avgRecent = recent10.reduce((s, v) => s + v, 0) / recent10.length;
    const avgPrior = prior10.length > 0 ? prior10.reduce((s, v) => s + v, 0) / prior10.length : avgRecent;
    let trend = 'FLAT';
    if (avgRecent > avgPrior * 1.05) trend = 'RISING';
    else if (avgRecent < avgPrior * 0.95) trend = 'FALLING';
    return { value: Math.round(current), trend };
  } catch (err) {
    logger.warn(`OBV calc failed: ${err.message}`);
    return null;
  }
}

export function calcADX(candles) {
  try {
    if (candles.length < 28) return null;
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const values = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    if (values.length === 0) return null;
    const current = values[values.length - 1];
    const value = current.adx;
    const pdi = current.pdi;
    const mdi = current.mdi;
    let signal = 'WEAK_TREND';
    if (value >= 25) {
      signal = pdi > mdi ? 'STRONG_BULLISH' : 'STRONG_BEARISH';
    } else if (value >= 20) {
      signal = 'MODERATE_TREND';
    }
    return { value, pdi, mdi, signal };
  } catch (err) {
    logger.warn(`ADX calc failed: ${err.message}`);
    return null;
  }
}
