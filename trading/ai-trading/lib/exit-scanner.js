import { analyzeSymbol } from './technical-analysis.js';
import { getOpenPositions } from './position-manager.js';
import logger from './logger.js';

// Separate cooldown map from entry scanner — keyed by symbol
const exitCooldowns = new Map();

/**
 * Compute exit urgency score for an open position based on current state.
 * Pure function — no I/O, no side effects.
 *
 * Returns: { score, factors, pnl_percent, hold_hours, drawdown_from_peak, max_gain }
 */
export function computeExitUrgency(position, analysis, currentPrice) {
  let score = 0;
  const factors = [];

  const avgEntry = parseFloat(position.avg_entry_price);
  const pnlPercent = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry) * 100 : 0;
  const holdMs = Date.now() - new Date(position.entry_time).getTime();
  const holdHours = holdMs / (1000 * 60 * 60);
  const maxGain = parseFloat(position.max_unrealized_gain_percent || 0);
  const drawdownFromPeak = maxGain - pnlPercent;

  // RSI (current state, not crossing)
  if (analysis.rsi) {
    const rsi = analysis.rsi.value;
    if (rsi > 85) {
      score += 30;
      factors.push(`RSI ${rsi.toFixed(1)} (extreme overbought)`);
    } else if (rsi > 75) {
      score += 15;
      factors.push(`RSI ${rsi.toFixed(1)} (overbought)`);
    } else if (rsi > 70) {
      score += 5;
      factors.push(`RSI ${rsi.toFixed(1)} (approaching overbought)`);
    }
  }

  // Unrealized profit
  if (pnlPercent > 20) {
    score += 25;
    factors.push(`P&L +${pnlPercent.toFixed(1)}% (large unrealized gain)`);
  } else if (pnlPercent > 10) {
    score += 15;
    factors.push(`P&L +${pnlPercent.toFixed(1)}%`);
  } else if (pnlPercent > 5) {
    score += 10;
    factors.push(`P&L +${pnlPercent.toFixed(1)}%`);
  }

  // Drawdown from peak (giving back gains)
  if (maxGain > 3) {
    if (drawdownFromPeak > 10) {
      score += 30;
      factors.push(`Drawdown ${drawdownFromPeak.toFixed(1)}% from peak +${maxGain.toFixed(1)}%`);
    } else if (drawdownFromPeak > 5) {
      score += 20;
      factors.push(`Drawdown ${drawdownFromPeak.toFixed(1)}% from peak +${maxGain.toFixed(1)}%`);
    } else if (drawdownFromPeak > 3) {
      score += 10;
      factors.push(`Drawdown ${drawdownFromPeak.toFixed(1)}% from peak +${maxGain.toFixed(1)}%`);
    }
  }

  // Hold time
  if (holdHours > 48) {
    score += 15;
    factors.push(`Held ${holdHours.toFixed(0)}h (>48h)`);
  } else if (holdHours > 24) {
    score += 10;
    factors.push(`Held ${holdHours.toFixed(0)}h (>24h)`);
  } else if (holdHours > 12) {
    score += 5;
    factors.push(`Held ${holdHours.toFixed(0)}h (>12h)`);
  }

  // Bollinger Bands upper touch
  if (analysis.bollingerBands?.position === 'UPPER') {
    score += 10;
    factors.push('Price at BB upper band');
  }

  // MACD weakness
  if (analysis.macd) {
    if (analysis.macd.crossover === 'BEARISH') {
      score += 15;
      factors.push('MACD bearish crossover');
    } else if (analysis.macd.crossover === 'BEARISH_TREND') {
      score += 5;
      factors.push('MACD bearish trend');
    }
  }

  // Trend
  if (analysis.trend?.direction === 'BEARISH') {
    score += 10;
    factors.push('Trend: BEARISH');
  }

  // Deep loss
  if (pnlPercent < -10) {
    score += 20;
    factors.push(`P&L ${pnlPercent.toFixed(1)}% (deep loss)`);
  } else if (pnlPercent < -5) {
    score += 10;
    factors.push(`P&L ${pnlPercent.toFixed(1)}% (moderate loss)`);
  }

  return {
    score,
    factors,
    pnl_percent: pnlPercent,
    hold_hours: holdHours,
    drawdown_from_peak: drawdownFromPeak,
    max_gain: maxGain,
  };
}

/**
 * Check if a symbol is in exit evaluation cooldown.
 */
export function isInExitCooldown(symbol, cooldownMinutes) {
  const lastFired = exitCooldowns.get(symbol);
  if (!lastFired) return false;
  return (Date.now() - lastFired) < cooldownMinutes * 60 * 1000;
}

/**
 * Record exit evaluation cooldown for a symbol.
 */
export function recordExitCooldown(symbol) {
  exitCooldowns.set(symbol, Date.now());
}

/**
 * Run exit scan: evaluate all open positions and return candidates for Sonnet.
 *
 * Returns: { positions_checked, candidates: [{ position, analysis, urgency, currentPrice }], duration_ms }
 */
export async function runExitScan(config) {
  const startTime = Date.now();
  const exitConfig = config.exit_scanner || {};
  const urgencyThreshold = exitConfig.urgency_threshold || 40;
  const criticalThreshold = exitConfig.critical_threshold || 70;
  const cooldownMinutes = exitConfig.cooldown_minutes || 30;

  const openPositions = await getOpenPositions();
  if (openPositions.length === 0) {
    return { positions_checked: 0, candidates: [], duration_ms: Date.now() - startTime };
  }

  const candidates = [];

  for (const position of openPositions) {
    try {
      const inCooldown = isInExitCooldown(position.symbol, cooldownMinutes);

      const analysis = await analyzeSymbol(position.symbol);
      if (analysis.error) {
        logger.warn(`[ExitScanner] ${position.symbol}: analysis failed — ${analysis.error}`);
        continue;
      }

      const currentPrice = analysis.price;
      const urgency = computeExitUrgency(position, analysis, currentPrice);

      logger.info(`[ExitScanner] ${position.symbol}: urgency ${urgency.score} | P&L ${urgency.pnl_percent.toFixed(1)}% | held ${urgency.hold_hours.toFixed(0)}h`);

      if (urgency.score < urgencyThreshold) continue;

      // Cooldown check — critical urgency bypasses
      if (inCooldown && urgency.score < criticalThreshold) {
        logger.info(`[ExitScanner] ${position.symbol}: in cooldown, urgency ${urgency.score} < critical ${criticalThreshold}`);
        continue;
      }

      if (inCooldown && urgency.score >= criticalThreshold) {
        logger.warn(`[ExitScanner] ${position.symbol}: CRITICAL urgency ${urgency.score} — bypassing cooldown`);
      }

      candidates.push({ position, analysis, urgency, currentPrice });
    } catch (error) {
      logger.error(`[ExitScanner] Error evaluating ${position.symbol}: ${error.message}`);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`[ExitScanner] Checked ${openPositions.length} positions in ${duration}ms — ${candidates.length} candidate(s) for Sonnet`);

  return { positions_checked: openPositions.length, candidates, duration_ms: duration };
}
