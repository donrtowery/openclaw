import { query } from '../db/connection.js';
import { analyzeSymbol, analyzeAll } from './technical-analysis.js';
import logger from './logger.js';

// Track previous indicator values to detect threshold CROSSINGS (not states)
const previousIndicators = new Map();

// Signal cooldown: prevent re-triggering same signal type for same symbol
// Map<"SYMBOL:SIGNAL_TYPE", timestamp>
const signalCooldowns = new Map();

// First cycle after startup is calibration — populate previousIndicators without firing signals
let isCalibrationCycle = true;

// Cached symbol list (refreshed hourly, not every cycle)
let cachedSymbols = null;
let symbolsCacheTime = 0;
const SYMBOLS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Load active symbols from database (cached for 1 hour)
 */
export async function initScanner() {
  const now = Date.now();
  if (cachedSymbols && (now - symbolsCacheTime) < SYMBOLS_CACHE_TTL) {
    return cachedSymbols;
  }

  const result = await query('SELECT * FROM symbols WHERE is_active = true ORDER BY tier, symbol');
  cachedSymbols = result.rows;
  symbolsCacheTime = now;
  logger.info(`[Scanner] Loaded ${cachedSymbols.length} active symbols`);
  return cachedSymbols;
}

/**
 * Check if a signal is in cooldown for a symbol
 */
function isInCooldown(symbol, signalType, cooldownMinutes) {
  const key = `${symbol}:${signalType}`;
  const lastFired = signalCooldowns.get(key);
  if (!lastFired) return false;
  return (Date.now() - lastFired) < cooldownMinutes * 60 * 1000;
}

/**
 * Record that a signal fired (starts cooldown)
 */
function recordCooldown(symbol, signalType) {
  signalCooldowns.set(`${symbol}:${signalType}`, Date.now());
}

/**
 * Detect threshold CROSSINGS (transitions) between current and previous snapshots.
 * These are ALERTS to Haiku — not trading triggers.
 *
 * Key distinction: a "crossing" means the state CHANGED, not that it IS in a state.
 * RSI dropping from 35 to 28 = crossing into oversold (alert).
 * RSI staying at 28 next cycle = still oversold (no alert).
 */
function detectThresholdCrossings(symbol, current, previous, thresholds) {
  const crossed = [];

  if (!previous || previous.error || current.error) {
    return crossed;
  }

  // --- RSI crossings ---
  if (previous.rsi && current.rsi) {
    if (previous.rsi.value >= thresholds.rsi_oversold && current.rsi.value < thresholds.rsi_oversold) {
      crossed.push('RSI_OVERSOLD');
    }
    if (previous.rsi.value <= thresholds.rsi_overbought && current.rsi.value > thresholds.rsi_overbought) {
      crossed.push('RSI_OVERBOUGHT');
    }
  }

  // --- MACD crossovers ---
  if (previous.macd && current.macd) {
    if (current.macd.crossover === 'BULLISH' && previous.macd.crossover !== 'BULLISH') {
      crossed.push('MACD_BULLISH_CROSSOVER');
    }
    if (current.macd.crossover === 'BEARISH' && previous.macd.crossover !== 'BEARISH') {
      crossed.push('MACD_BEARISH_CROSSOVER');
    }
  }

  // --- EMA crossovers ---
  if (previous.ema && current.ema) {
    if (previous.ema.signal !== 'BULLISH' && current.ema.signal === 'BULLISH') {
      crossed.push('EMA_BULLISH_CROSSOVER');
    }
    if (previous.ema.signal !== 'BEARISH' && current.ema.signal === 'BEARISH') {
      crossed.push('EMA_BEARISH_CROSSOVER');
    }
  }

  // --- Volume spike: TRANSITION from normal to spike (not persistent state) ---
  if (previous.volume && current.volume) {
    const wasSpike = previous.volume.ratio >= thresholds.volume_spike_ratio;
    const isSpike = current.volume.ratio >= thresholds.volume_spike_ratio;
    if (!wasSpike && isSpike) {
      crossed.push('VOLUME_SPIKE');
    }
  }

  // --- Bollinger Band: TRANSITIONS only ---
  if (thresholds.bb_squeeze && previous.bollingerBands && current.bollingerBands) {
    // Squeeze: bands transitioned from normal/wide TO narrow
    if (previous.bollingerBands.width !== 'NARROW' && current.bollingerBands.width === 'NARROW') {
      crossed.push('BB_SQUEEZE');
    }
    // Lower touch: price moved INTO lower zone
    if (previous.bollingerBands.position !== 'LOWER' && current.bollingerBands.position === 'LOWER') {
      crossed.push('BB_LOWER_TOUCH');
    }
    // Upper touch: price moved INTO upper zone
    if (previous.bollingerBands.position !== 'UPPER' && current.bollingerBands.position === 'UPPER') {
      crossed.push('BB_UPPER_TOUCH');
    }
  }

  // --- Trend change ---
  if (previous.trend && current.trend) {
    if (previous.trend.direction !== 'BULLISH' && current.trend.direction === 'BULLISH') {
      crossed.push('TREND_TURNED_BULLISH');
    }
    if (previous.trend.direction !== 'BEARISH' && current.trend.direction === 'BEARISH') {
      crossed.push('TREND_TURNED_BEARISH');
    }
  }

  return crossed;
}

/**
 * Run one complete scan cycle across all active symbols.
 * Uses analyzeAll() for parallel execution (3 concurrent).
 * Returns triggered signals for Haiku to evaluate.
 */
export async function runScanCycle(config) {
  const startTime = Date.now();
  const symbols = await initScanner();
  const triggeredSignals = [];
  const allSnapshots = [];
  const thresholds = config.scanner.thresholds;
  const cooldownMinutes = config.scanner.signal_cooldown_minutes || 60;

  logger.info(`[Scanner] Starting scan of ${symbols.length} symbols...`);

  // Parallel analysis using proven v1 concurrency limiter (max 3)
  const symbolNames = symbols.map(s => s.symbol);
  const analyses = await analyzeAll(symbolNames);

  // Build a lookup for tier info
  const symbolMap = new Map(symbols.map(s => [s.symbol, s]));

  for (const analysis of analyses) {
    try {
      if (analysis.error) {
        logger.warn(`[Scanner] ${analysis.symbol}: ${analysis.error}`);
        continue;
      }

      const symbolRow = symbolMap.get(analysis.symbol);
      if (!symbolRow) continue;

      allSnapshots.push(analysis);

      // Store current as previous for next cycle
      const previous = previousIndicators.get(analysis.symbol);
      previousIndicators.set(analysis.symbol, analysis);

      // On calibration cycle, only populate previousIndicators — don't detect crossings
      if (isCalibrationCycle) continue;

      // Detect threshold crossings against previous values
      let crossed = detectThresholdCrossings(analysis.symbol, analysis, previous, thresholds);

      // Filter out signals that are in cooldown
      if (crossed.length > 0) {
        crossed = crossed.filter(sig => {
          if (isInCooldown(analysis.symbol, sig, cooldownMinutes)) {
            return false; // Still in cooldown, skip
          }
          recordCooldown(analysis.symbol, sig);
          return true;
        });
      }

      if (crossed.length > 0) {
        logger.info(`[Scanner] ${analysis.symbol} triggered: ${crossed.join(', ')}`);

        // Check for existing open position
        const posResult = await query(
          'SELECT * FROM positions WHERE symbol = $1 AND status = $2',
          [analysis.symbol, 'OPEN']
        );
        const hasPosition = posResult.rows.length > 0;
        const position = hasPosition ? posResult.rows[0] : null;

        triggeredSignals.push({
          symbol: analysis.symbol,
          tier: symbolRow.tier,
          price: analysis.price,
          analysis,
          thresholds_crossed: crossed,
          has_position: hasPosition,
          position,
        });
      }
    } catch (error) {
      logger.error(`[Scanner] Error processing ${analysis.symbol}: ${error.message}`);
    }
  }

  // End calibration mode after first cycle
  if (isCalibrationCycle) {
    isCalibrationCycle = false;
    const duration = Date.now() - startTime;
    logger.info(`[Scanner] Calibration cycle complete: ${symbols.length} symbols baselined in ${duration}ms`);
    return {
      symbols_scanned: symbols.length,
      triggered: [],
      snapshots: allSnapshots,
      duration_ms: duration,
    };
  }

  // Batch-save all indicator snapshots in one INSERT
  if (allSnapshots.length > 0) {
    try {
      await saveIndicatorSnapshots(allSnapshots);
    } catch (error) {
      logger.error(`[Scanner] Failed to save indicator snapshots: ${error.message}`);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`[Scanner] Complete: ${symbols.length} symbols in ${duration}ms, ${triggeredSignals.length} triggered`);

  return {
    symbols_scanned: symbols.length,
    triggered: triggeredSignals,
    snapshots: allSnapshots,
    duration_ms: duration,
  };
}

/**
 * Batch-save indicator snapshots to database for backtesting and learning.
 * Single multi-row INSERT instead of N individual INSERTs.
 */
async function saveIndicatorSnapshots(analyses) {
  if (analyses.length === 0) return;

  const COLS = 20;
  const values = [];
  const placeholders = [];

  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    const offset = i * COLS;
    placeholders.push(`(${Array.from({ length: COLS }, (_, j) => `$${offset + j + 1}`).join(',')})`);
    values.push(
      a.symbol,
      a.price,
      a.rsi?.value ?? null,
      a.macd?.macd ?? null,
      a.macd?.signal ?? null,
      a.macd?.histogram ?? null,
      a.sma?.sma10 ?? null,
      a.sma?.sma30 ?? null,
      a.sma?.sma50 ?? null,
      a.sma?.sma200 ?? null,
      a.ema?.ema9 ?? null,
      a.ema?.ema21 ?? null,
      a.bollingerBands?.upper ?? null,
      a.bollingerBands?.middle ?? null,
      a.bollingerBands?.lower ?? null,
      a.volume?.current ?? null,
      a.volume?.ratio ?? null,
      a.support?.[0] ?? null,
      a.resistance?.[0] ?? null,
      a.trend?.direction ?? null,
    );
  }

  await query(`
    INSERT INTO indicator_snapshots (
      symbol, price, rsi, macd, macd_signal, macd_histogram,
      sma10, sma30, sma50, sma200, ema9, ema21,
      bb_upper, bb_middle, bb_lower, volume_24h, volume_ratio,
      support_nearest, resistance_nearest, trend
    ) VALUES ${placeholders.join(',')}
  `, values);
}
