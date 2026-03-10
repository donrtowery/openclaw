import { analyzeSymbol } from './technical-analysis.js';
import { getOpenPositions } from './position-manager.js';
import { query } from '../db/connection.js';
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
  if (!(avgEntry > 0)) {
    logger.warn(`[ExitScanner] ${position.symbol} #${position.id}: corrupt avg_entry_price (${position.avg_entry_price}) — assigning high urgency`);
    return { score: 80, factors: ['corrupt avg_entry_price — manual review needed'], pnl_percent: 0, hold_hours: 0, drawdown_from_peak: 0, max_gain: 0 };
  }
  const pnlPercent = ((currentPrice - avgEntry) / avgEntry) * 100;
  const holdMs = Date.now() - new Date(position.entry_time).getTime();
  const holdHours = holdMs / (1000 * 60 * 60);
  const maxGain = parseFloat(position.max_unrealized_gain_percent || 0);
  const drawdownFromPeak = maxGain - pnlPercent;
  const tier = position.tier || 2;
  const dcaCount = parseInt(position.dca_count) || 0;

  // ── Tier-based thresholds ──
  const isT1 = tier === 1;
  const deepLossThreshold = isT1 ? -15 : -10;
  const moderateLossThreshold = isT1 ? -8 : -5;
  const holdTimeThreshold = isT1 ? 72 : 48;
  const holdTimeMedium = isT1 ? 36 : 24;

  // RSI (current state, not crossing) — ATR-scaled: high volatility coins get more RSI headroom
  if (analysis.rsi) {
    const rsi = analysis.rsi.value;
    const atrPct = analysis.atr?.percent || 3;
    // High ATR (>5%) reduces RSI urgency by ~40%, low ATR (<2%) increases by ~20%
    const atrScale = atrPct > 5 ? 0.6 : atrPct < 2 ? 1.2 : 1.0;
    if (rsi > 85) {
      score += Math.round(30 * atrScale);
      factors.push(`RSI ${rsi.toFixed(1)} (extreme overbought${atrScale !== 1 ? `, ATR ${atrPct.toFixed(1)}%` : ''})`);
    } else if (rsi > 75) {
      score += Math.round(15 * atrScale);
      factors.push(`RSI ${rsi.toFixed(1)} (overbought${atrScale !== 1 ? `, ATR ${atrPct.toFixed(1)}%` : ''})`);
    } else if (rsi > 70) {
      score += Math.round(5 * atrScale);
      factors.push(`RSI ${rsi.toFixed(1)} (approaching overbought)`);
    }
  }

  // StochRSI overbought confirmation
  if (analysis.stochRsi?.signal === 'OVERBOUGHT') {
    score += 10;
    factors.push(`StochRSI overbought K:${analysis.stochRsi.k}`);
  } else if (analysis.stochRsi?.signal === 'BEARISH_CROSS') {
    score += 15;
    factors.push(`StochRSI bearish cross K:${analysis.stochRsi.k}`);
  } else if (analysis.stochRsi?.signal === 'APPROACHING_OVERBOUGHT') {
    score += 5;
    factors.push(`StochRSI approaching overbought K:${analysis.stochRsi.k}`);
  }

  // ADX: weak trend + loss = exit faster (choppy market, not trending)
  if (analysis.adx && analysis.adx.value < 20 && pnlPercent < -3) {
    score += 15;
    factors.push(`ADX ${analysis.adx.value} (weak trend) + loss — choppy market`);
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

  // Drawdown from peak (giving back gains) — tier-adjusted
  if (maxGain > 3) {
    const severeDrawdown = isT1 ? 12 : 10;
    const moderateDrawdown = isT1 ? 7 : 5;
    if (drawdownFromPeak > severeDrawdown) {
      score += 30;
      factors.push(`Drawdown ${drawdownFromPeak.toFixed(1)}% from peak +${maxGain.toFixed(1)}%`);
    } else if (drawdownFromPeak > moderateDrawdown) {
      score += 20;
      factors.push(`Drawdown ${drawdownFromPeak.toFixed(1)}% from peak +${maxGain.toFixed(1)}%`);
    } else if (drawdownFromPeak > 3) {
      score += 10;
      factors.push(`Drawdown ${drawdownFromPeak.toFixed(1)}% from peak +${maxGain.toFixed(1)}%`);
    }
  }

  // ATR-based trailing stop for winners
  if (analysis.atr && maxGain > 5 && pnlPercent > 0) {
    const atrTrailPct = analysis.atr.percent * 2.5; // 2.5x ATR trailing stop
    if (drawdownFromPeak > atrTrailPct) {
      score += 25;
      factors.push(`ATR trail triggered: drawdown ${drawdownFromPeak.toFixed(1)}% > ${atrTrailPct.toFixed(1)}% (2.5x ATR)`);
    }
  }

  // Hold time — tier-adjusted
  if (holdHours > holdTimeThreshold) {
    score += 15;
    factors.push(`Held ${holdHours.toFixed(0)}h (>${holdTimeThreshold}h T${tier})`);
  } else if (holdHours > holdTimeMedium) {
    score += 10;
    factors.push(`Held ${holdHours.toFixed(0)}h (>${holdTimeMedium}h)`);
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

  // Deep loss — tier-adjusted
  if (pnlPercent < deepLossThreshold) {
    score += 20;
    factors.push(`P&L ${pnlPercent.toFixed(1)}% (deep loss, T${tier} threshold ${deepLossThreshold}%)`);
  } else if (pnlPercent < moderateLossThreshold) {
    score += 10;
    factors.push(`P&L ${pnlPercent.toFixed(1)}% (moderate loss)`);
  }

  // ── Time-accelerated urgency for losses ──
  if (pnlPercent < -3 && holdHours > 24) {
    score += 15;
    factors.push(`Loss ${pnlPercent.toFixed(1)}% held >24h — accelerated exit pressure`);
  }

  // ── Cut losers faster: loss + hold time + bearish signals ──
  if (pnlPercent < -5 && holdHours > 12 && analysis.macd?.crossover === 'BEARISH') {
    score += 15;
    factors.push(`Loser held ${holdHours.toFixed(0)}h with MACD bearish — cut loss`);
  }

  // ── Declining volume with profit — fading buying interest ──
  if (analysis.volume?.trend === 'DECREASING' && pnlPercent > 3) {
    score += 10;
    factors.push(`Volume declining with +${pnlPercent.toFixed(1)}% profit — fading interest`);
  }

  // ── Low volume on losing position — no recovery interest ──
  if (analysis.volume && pnlPercent < -5 && analysis.volume.ratio < 0.8) {
    score += 15;
    factors.push(`Low volume ${analysis.volume.ratio.toFixed(1)}x + ${pnlPercent.toFixed(1)}% loss — no recovery interest`);
  }

  // ── DCA'd positions losing — tighter exit (but not premature) ──
  if (dcaCount >= 2 && pnlPercent < -8) {
    score += 20;
    factors.push(`${dcaCount} DCAs + ${pnlPercent.toFixed(1)}% loss — thesis failing`);
  } else if (dcaCount >= 1 && pnlPercent < -10) {
    score += 15;
    factors.push(`DCA'd position at ${pnlPercent.toFixed(1)}% — consider exit`);
  }

  // ── Peak giveback fast-exit: was winning, now losing — thesis failed ──
  if (maxGain > 5 && pnlPercent < 0) {
    if (score < 80) {
      score = 80;
    }
    factors.push(`Peak giveback: was +${maxGain.toFixed(1)}% now ${pnlPercent.toFixed(1)}% — thesis failed`);
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

  // Prune expired exit cooldowns
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const now = Date.now();
  for (const [sym, ts] of exitCooldowns) {
    if (now - ts > cooldownMs * 2) exitCooldowns.delete(sym);
  }

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

      // Update peak gain before urgency calc to avoid stale data
      // Use a shallow copy so we don't mutate the DB row object
      let posForUrgency = position;
      const avgEntry = parseFloat(position.avg_entry_price);
      if (avgEntry > 0) {
        const currentPnlPct = ((currentPrice - avgEntry) / avgEntry) * 100;
        const storedPeak = parseFloat(position.max_unrealized_gain_percent || 0);
        if (currentPnlPct > storedPeak) {
          posForUrgency = { ...position, max_unrealized_gain_percent: currentPnlPct };
          try {
            await query('UPDATE positions SET max_unrealized_gain_percent = $1, updated_at = NOW() WHERE id = $2', [currentPnlPct, position.id]);
          } catch (err) {
            logger.warn(`[ExitScanner] Failed to update peak gain for ${position.symbol}: ${err.message}`);
          }
        }
      }

      const urgency = computeExitUrgency(posForUrgency, analysis, currentPrice);

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

      candidates.push({ position: posForUrgency, analysis, urgency, currentPrice });
    } catch (error) {
      logger.error(`[ExitScanner] Error evaluating ${position.symbol}: ${error.message}`);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`[ExitScanner] Checked ${openPositions.length} positions in ${duration}ms — ${candidates.length} candidate(s) for Sonnet`);

  return { positions_checked: openPositions.length, candidates, duration_ms: duration };
}
