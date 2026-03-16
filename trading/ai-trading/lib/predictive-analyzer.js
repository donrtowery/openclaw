/**
 * Predictive Analyzer — Pure math, no AI calls.
 *
 * Detects leading indicator divergences (OBV vs price, MACD histogram acceleration)
 * and computes BTC correlation/beta for altcoin entries.
 */

import { query } from '../db/connection.js';
import logger from './logger.js';

// ── OBV Divergence Detection ────────────────────────────────

/**
 * Detect OBV trend vs price trend mismatch over a sliding window.
 * Uses linear regression slopes on OBV and close prices.
 *
 * @param {object[]} candles1h - Array of 1h candles with { close, volume }
 * @param {object} opts - { minCandles: 12, persistenceHours: 3 }
 * @returns {{ detected: boolean, type: string|null, persistence_hours: number, strength: number }}
 */
export function computeOBVDivergence(candles1h, opts = {}) {
  const minCandles = opts.minCandles || 12;
  const persistenceHours = opts.persistenceHours || 3;

  if (!candles1h || candles1h.length < minCandles + 5) {
    return { detected: false, type: null, persistence_hours: 0, strength: 0 };
  }

  // Use the most recent `minCandles` to 20 candles as the divergence window
  const windowSize = Math.min(20, Math.max(minCandles, candles1h.length));
  const window = candles1h.slice(-windowSize);

  // Compute cumulative OBV for the window
  const obvValues = [];
  let obv = 0;
  for (let i = 0; i < window.length; i++) {
    if (i > 0) {
      if (window[i].close > window[i - 1].close) {
        obv += window[i].volume;
      } else if (window[i].close < window[i - 1].close) {
        obv -= window[i].volume;
      }
    }
    obvValues.push(obv);
  }

  const closes = window.map(c => c.close);

  // Linear regression slopes
  const priceSlope = linearRegressionSlope(closes);
  const obvSlope = linearRegressionSlope(obvValues);

  // Normalize slopes to detect direction
  const priceTrend = priceSlope > 0 ? 'UP' : 'DOWN';
  const obvTrend = obvSlope > 0 ? 'UP' : 'DOWN';

  // Divergence = OBV and price moving in opposite directions
  if (priceTrend === obvTrend) {
    return { detected: false, type: null, persistence_hours: 0, strength: 0 };
  }

  // Calculate strength as R² of the OBV regression (how consistent the divergence is)
  const obvR2 = rSquared(obvValues);
  const priceR2 = rSquared(closes);
  const strength = Math.min(1, (obvR2 + priceR2) / 2);

  // Minimum slope magnitude check — avoid noise
  const priceRange = Math.max(...closes) - Math.min(...closes);
  const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
  const priceSlopePct = Math.abs(priceSlope * closes.length / avgPrice) * 100;
  if (priceSlopePct < 0.5) {
    // Price barely moved — not a meaningful divergence
    return { detected: false, type: null, persistence_hours: 0, strength: 0 };
  }

  // Check persistence: how many of the last N candles maintain the divergence
  let persistentCandles = 0;
  for (let i = window.length - 1; i >= Math.max(0, window.length - persistenceHours); i--) {
    const localPriceDir = i > 0 ? (window[i].close > window[i - 1].close ? 'UP' : 'DOWN') : priceTrend;
    const localObvDir = i > 0 ? (obvValues[i] > obvValues[i - 1] ? 'UP' : 'DOWN') : obvTrend;
    if (localPriceDir !== localObvDir) persistentCandles++;
  }

  // BULLISH divergence: price falling but OBV rising (accumulation)
  // BEARISH divergence: price rising but OBV falling (distribution)
  const type = priceTrend === 'DOWN' && obvTrend === 'UP' ? 'BULLISH' : 'BEARISH';

  return {
    detected: true,
    type,
    persistence_hours: persistentCandles,
    strength: parseFloat(strength.toFixed(3)),
  };
}

// ── MACD Histogram Acceleration ─────────────────────────────

/**
 * Compute rate of change of MACD histogram over recent bars.
 * Acceleration = histogram expanding in one direction consistently.
 *
 * @param {object[]} candles1h - Array of 1h candles with { close }
 * @param {object} opts - { bars: 5 }
 * @returns {{ detected: boolean, direction: string|null, acceleration_rate: number, bars_accelerating: number }}
 */
export function computeMACDAcceleration(candles1h, opts = {}) {
  const bars = opts.bars || 5;

  if (!candles1h || candles1h.length < 30) {
    return { detected: false, direction: null, acceleration_rate: 0, bars_accelerating: 0 };
  }

  const closes = candles1h.map(c => c.close);

  // Compute MACD histogram (12, 26, 9)
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  if (ema12.length < bars + 2 || ema26.length < bars + 2) {
    return { detected: false, direction: null, acceleration_rate: 0, bars_accelerating: 0 };
  }

  // Align EMA arrays (ema26 is shorter)
  const offset = ema12.length - ema26.length;
  const macdLine = [];
  for (let i = 0; i < ema26.length; i++) {
    macdLine.push(ema12[i + offset] - ema26[i]);
  }

  const signalLine = computeEMA(macdLine, 9);
  const signalOffset = macdLine.length - signalLine.length;
  const histogram = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + signalOffset] - signalLine[i]);
  }

  if (histogram.length < bars + 1) {
    return { detected: false, direction: null, acceleration_rate: 0, bars_accelerating: 0 };
  }

  // Check last `bars` histogram deltas for consistent acceleration
  const recentHist = histogram.slice(-bars - 1);
  let barsAccelerating = 0;
  let direction = null;

  for (let i = 1; i < recentHist.length; i++) {
    const delta = recentHist[i] - recentHist[i - 1];
    if (delta > 0) {
      if (direction === null) direction = 'BULLISH';
      if (direction === 'BULLISH') barsAccelerating++;
      else break;
    } else if (delta < 0) {
      if (direction === null) direction = 'BEARISH';
      if (direction === 'BEARISH') barsAccelerating++;
      else break;
    }
  }

  // Need at least 3 bars of consistent acceleration
  if (barsAccelerating < 3) {
    return { detected: false, direction: null, acceleration_rate: 0, bars_accelerating: 0 };
  }

  // Acceleration rate = average histogram delta over the accelerating period
  const accelDeltas = [];
  for (let i = recentHist.length - barsAccelerating; i < recentHist.length; i++) {
    accelDeltas.push(Math.abs(recentHist[i] - recentHist[i - 1]));
  }
  const accelerationRate = accelDeltas.reduce((a, b) => a + b, 0) / accelDeltas.length;

  // Normalize by price to make cross-symbol comparable
  const avgPrice = closes.slice(-bars).reduce((a, b) => a + b, 0) / bars;
  const normalizedRate = (accelerationRate / avgPrice) * 10000; // basis points

  return {
    detected: true,
    direction,
    acceleration_rate: parseFloat(normalizedRate.toFixed(4)),
    bars_accelerating: barsAccelerating,
  };
}

// ── BTC Correlation / Beta ──────────────────────────────────

/**
 * Compute Pearson correlation and beta between BTC and an altcoin
 * using 1h log-returns over a specified window.
 *
 * @param {object[]} btcCandles - BTC 1h candles with { close }
 * @param {object[]} altCandles - Altcoin 1h candles with { close }
 * @returns {{ pearson_r: number, beta: number, r_squared: number, candle_count: number }}
 */
export function computeBTCCorrelation(btcCandles, altCandles) {
  if (!btcCandles || !altCandles || btcCandles.length < 10 || altCandles.length < 10) {
    return { pearson_r: 0, beta: 0, r_squared: 0, candle_count: 0 };
  }

  // Align by using the minimum length
  const len = Math.min(btcCandles.length, altCandles.length);
  const btc = btcCandles.slice(-len);
  const alt = altCandles.slice(-len);

  // Compute log-returns
  const btcReturns = [];
  const altReturns = [];
  for (let i = 1; i < len; i++) {
    if (btc[i - 1].close > 0 && alt[i - 1].close > 0) {
      btcReturns.push(Math.log(btc[i].close / btc[i - 1].close));
      altReturns.push(Math.log(alt[i].close / alt[i - 1].close));
    }
  }

  if (btcReturns.length < 8) {
    return { pearson_r: 0, beta: 0, r_squared: 0, candle_count: btcReturns.length };
  }

  // Pearson correlation
  const n = btcReturns.length;
  const meanBtc = btcReturns.reduce((a, b) => a + b, 0) / n;
  const meanAlt = altReturns.reduce((a, b) => a + b, 0) / n;

  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = btcReturns[i] - meanBtc;
    const dy = altReturns[i] - meanAlt;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denominator = Math.sqrt(sumX2 * sumY2);
  const pearson_r = denominator > 0 ? sumXY / denominator : 0;

  // Beta = covariance(alt, btc) / variance(btc)
  const beta = sumX2 > 0 ? sumXY / sumX2 : 0;

  // R-squared
  const r_squared = pearson_r * pearson_r;

  return {
    pearson_r: parseFloat(pearson_r.toFixed(4)),
    beta: parseFloat(beta.toFixed(3)),
    r_squared: parseFloat(r_squared.toFixed(4)),
    candle_count: n,
  };
}

// ── Leading Signal Orchestrator ─────────────────────────────

/**
 * Run both divergence checks on a symbol and return combined signal.
 *
 * @param {string} symbol
 * @param {object} analysis - From analyzeSymbol()
 * @param {object[]} candles1h - Raw 1h candles
 * @param {object} config - predictive config section
 * @returns {object|null} Combined divergence signal or null if nothing detected
 */
export function detectLeadingSignals(symbol, analysis, candles1h, config = {}) {
  const leadingConfig = config.leading_indicators || {};
  const obvMinCandles = leadingConfig.obv_divergence_min_candles || 12;
  const obvPersistence = leadingConfig.obv_divergence_persistence_hours || 3;
  const macdBars = leadingConfig.macd_acceleration_bars || 5;

  const obvResult = computeOBVDivergence(candles1h, {
    minCandles: obvMinCandles,
    persistenceHours: obvPersistence,
  });

  const macdResult = computeMACDAcceleration(candles1h, { bars: macdBars });

  // Filter out weak OBV divergences below minimum strength threshold
  const obvMinStrength = leadingConfig.obv_min_strength || 0.50;
  const hasObv = obvResult.detected && obvResult.strength >= obvMinStrength;
  const hasMacd = macdResult.detected;

  if (!hasObv && !hasMacd) return null;

  // Determine combined direction
  let direction = null;
  let divergenceType = null;

  if (hasObv && hasMacd) {
    // Both detected — check alignment
    if (obvResult.type === macdResult.direction) {
      direction = obvResult.type; // BULLISH or BEARISH
      divergenceType = 'COMBINED';
    } else {
      // Conflicting signals — use the stronger one
      if (obvResult.strength > 0.5) {
        direction = obvResult.type;
        divergenceType = 'OBV_DIVERGENCE';
      } else if (macdResult.bars_accelerating >= 4) {
        direction = macdResult.direction;
        divergenceType = 'MACD_ACCELERATION';
      } else {
        return null; // Conflicting and neither is strong enough
      }
    }
  } else if (hasObv) {
    direction = obvResult.type;
    divergenceType = 'OBV_DIVERGENCE';
  } else {
    direction = macdResult.direction;
    divergenceType = 'MACD_ACCELERATION';
  }

  // Calculate combined strength
  const obvStrength = hasObv ? obvResult.strength : 0;
  const macdStrength = hasMacd ? Math.min(1, macdResult.bars_accelerating / 5) : 0;
  const combinedStrength = divergenceType === 'COMBINED'
    ? Math.min(1, (obvStrength + macdStrength) / 1.5)
    : Math.max(obvStrength, macdStrength);

  return {
    symbol,
    direction, // BULLISH or BEARISH
    divergence_type: divergenceType,
    combined_strength: parseFloat(combinedStrength.toFixed(3)),
    obv: hasObv ? obvResult : null,
    macd: hasMacd ? macdResult : null,
    price: analysis.price,
    atr_percent: analysis.atr?.percent || 0,
    volume_ratio: analysis.volume?.ratio || 1,
  };
}

// ── BTC-Led Candidate Ranking ───────────────────────────────

/**
 * Query latest BTC correlations where beta > threshold and R² > minimum.
 * R² filter ensures high-beta readings are statistically meaningful, not noise.
 *
 * @param {number} betaThreshold - Minimum beta to qualify (default 1.5)
 * @param {number} minRSquared - Minimum R² to qualify (default 0.30)
 * @returns {Promise<object[]>} Sorted by beta desc
 */
export async function getHighBetaAltcoins(betaThreshold = 1.5, minRSquared = 0.30) {
  const result = await query(`
    SELECT DISTINCT ON (symbol) symbol, pearson_r, beta, r_squared, candle_count, created_at
    FROM btc_correlations
    WHERE beta > $1 AND r_squared > $2
    ORDER BY symbol, created_at DESC
  `, [betaThreshold, minRSquared]);

  return result.rows.sort((a, b) => parseFloat(b.beta) - parseFloat(a.beta));
}

/**
 * Rank high-beta altcoins by profit potential for BTC-led entries.
 *
 * profit_score = beta * atr_percent * volume_ratio_weight
 *
 * @param {object[]} correlations - From getHighBetaAltcoins
 * @param {Map<string, object>} analysesMap - symbol -> analysis from analyzeSymbol
 * @param {number} maxCandidates - Max candidates to return
 * @returns {object[]} Ranked candidates
 */
export function rankBTCLedCandidates(correlations, analysesMap, maxCandidates = 3) {
  const candidates = [];

  for (const corr of correlations) {
    const symbol = corr.symbol;
    if (symbol === 'BTCUSDT') continue; // Exclude BTC itself

    const analysis = analysesMap.get(symbol);
    if (!analysis || analysis.error) continue;

    const beta = parseFloat(corr.beta);
    const atrPercent = analysis.atr?.percent || 0;
    const volumeRatio = analysis.volume?.ratio || 1;

    // Volume weight: higher current volume vs average = more conviction
    const volumeWeight = Math.min(2, Math.max(0.5, volumeRatio));

    const profitScore = beta * atrPercent * volumeWeight;

    candidates.push({
      symbol,
      beta,
      pearson_r: parseFloat(corr.pearson_r),
      r_squared: parseFloat(corr.r_squared || 0),
      atr_percent: atrPercent,
      volume_ratio: volumeRatio,
      profit_score: parseFloat(profitScore.toFixed(4)),
      analysis,
    });
  }

  // Sort by profit_score descending, return top N
  return candidates
    .sort((a, b) => b.profit_score - a.profit_score)
    .slice(0, maxCandidates);
}

// ── Utility Functions ───────────────────────────────────────

/**
 * Simple linear regression slope.
 * @param {number[]} values
 * @returns {number} slope
 */
function linearRegressionSlope(values) {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  return denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
}

/**
 * R-squared of a linear regression on the values.
 * @param {number[]} values
 * @returns {number} R² [0, 1]
 */
function rSquared(values) {
  const n = values.length;
  if (n < 3) return 0;

  const slope = linearRegressionSlope(values);
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  const intercept = meanY - slope * (n - 1) / 2;

  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }

  return ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
}

/**
 * Compute EMA for an array of values.
 * @param {number[]} values
 * @param {number} period
 * @returns {number[]}
 */
function computeEMA(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  const ema = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];

  for (let i = period; i < values.length; i++) {
    ema.push(values[i] * k + ema[ema.length - 1] * (1 - k));
  }

  return ema;
}
