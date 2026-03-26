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
export function computeExitUrgency(position, analysis, currentPrice, currentTime = null, exitOverrides = null) {
  let score = 0;
  const factors = [];

  const avgEntry = parseFloat(position.avg_entry_price);
  if (!(avgEntry > 0)) {
    logger.warn(`[ExitScanner] ${position.symbol} #${position.id}: corrupt avg_entry_price (${position.avg_entry_price}) — assigning high urgency`);
    return { score: 80, factors: ['corrupt avg_entry_price — manual review needed'], pnl_percent: 0, hold_hours: 0, drawdown_from_peak: 0, max_gain: 0 };
  }
  const direction = position.direction || 'LONG';
  // Direction-aware P&L: LONG profits when price rises, SHORT profits when price falls
  const pnlPercent = direction === 'SHORT'
    ? ((avgEntry - currentPrice) / avgEntry) * 100
    : ((currentPrice - avgEntry) / avgEntry) * 100;
  const holdMs = (currentTime || Date.now()) - new Date(position.entry_time).getTime();
  const holdHours = holdMs / (1000 * 60 * 60);

  // Predictive position hold time override — return 0 urgency if below minimum hold
  if (exitOverrides?.minHoldHours && holdHours < exitOverrides.minHoldHours) {
    return {
      score: 0,
      factors: [`Predictive hold: ${holdHours.toFixed(1)}h < ${exitOverrides.minHoldHours}h minimum — suppressed`],
      pnl_percent: pnlPercent,
      hold_hours: holdHours,
      drawdown_from_peak: 0,
      max_gain: parseFloat(position.max_unrealized_gain_percent || 0),
    };
  }
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
  // For SHORT positions, invert RSI logic: oversold = target reached (exit), overbought = trend continuing (hold)
  if (analysis.rsi) {
    const rsi = analysis.rsi.value;
    const atrPct = analysis.atr?.percent || 3;
    const atrScale = atrPct > 5 ? 0.6 : atrPct < 2 ? 1.2 : 1.0;
    if (direction === 'SHORT') {
      // SHORT: low RSI = price dropped = profitable, consider covering
      if (rsi < 15) {
        score += Math.round(30 * atrScale);
        factors.push(`RSI ${rsi.toFixed(1)} (extreme oversold — SHORT target zone${atrScale !== 1 ? `, ATR ${atrPct.toFixed(1)}%` : ''})`);
      } else if (rsi < 25) {
        score += Math.round(15 * atrScale);
        factors.push(`RSI ${rsi.toFixed(1)} (oversold — SHORT profit zone${atrScale !== 1 ? `, ATR ${atrPct.toFixed(1)}%` : ''})`);
      } else if (rsi < 30) {
        score += Math.round(5 * atrScale);
        factors.push(`RSI ${rsi.toFixed(1)} (approaching oversold — SHORT nearing target)`);
      }
    } else {
      // LONG: high RSI = overbought, consider selling
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
  }

  // StochRSI — for shorts, oversold/bullish signals trigger exit (price dropped, cover)
  if (direction === 'SHORT') {
    if (analysis.stochRsi?.signal === 'OVERSOLD') {
      score += 10;
      factors.push(`StochRSI oversold K:${analysis.stochRsi.k} — SHORT cover zone`);
    } else if (analysis.stochRsi?.signal === 'BULLISH_CROSS') {
      score += 15;
      factors.push(`StochRSI bullish cross K:${analysis.stochRsi.k} — SHORT reversal risk`);
    }
  } else {
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

  // ── Auto-partial-exit: protect profits proactively ──
  // Partial exits have 100% WR historically — trigger earlier for profit protection
  const partialExits = parseInt(position.partial_exits) || 0;
  if (partialExits === 0 && pnlPercent >= 5 && score >= 20 && score < 40) {
    score = Math.max(score, 35);
    factors.push(`Auto-partial trigger: +${pnlPercent.toFixed(1)}% profit with moderate urgency — lock partial gains`);
  } else if (!isT1 && partialExits === 0 && pnlPercent >= 3 && score >= 15) {
    // T2: more aggressive partial threshold (T2 reversals are sharper)
    // Only fires if generic auto-partial didn't already trigger
    score = Math.max(score, 35);
    factors.push(`T2 auto-partial: +${pnlPercent.toFixed(1)}% profit — T2 needs faster profit locking`);
  }

  // Hold time — tier-adjusted (predictive overrides use longer stagnation thresholds)
  const effectiveHoldThreshold = exitOverrides?.stagnationStartHours || holdTimeThreshold;
  const effectiveHoldMedium = exitOverrides?.stagnationStartHours
    ? Math.round(exitOverrides.stagnationStartHours * 0.5)
    : holdTimeMedium;
  if (holdHours > effectiveHoldThreshold) {
    score += 15;
    factors.push(`Held ${holdHours.toFixed(0)}h (>${effectiveHoldThreshold}h${exitOverrides ? ' predictive' : ` T${tier}`})`);
  } else if (holdHours > effectiveHoldMedium) {
    score += 10;
    factors.push(`Held ${holdHours.toFixed(0)}h (>${effectiveHoldMedium}h)`);
  } else if (holdHours > 12) {
    score += 5;
    factors.push(`Held ${holdHours.toFixed(0)}h (>12h)`);
  }

  // Bollinger Bands — direction-aware
  if (direction === 'SHORT') {
    if (analysis.bollingerBands?.position === 'LOWER') {
      score += 10;
      factors.push('Price at BB lower band — SHORT target zone');
    }
  } else {
    if (analysis.bollingerBands?.position === 'UPPER') {
      score += 10;
      factors.push('Price at BB upper band');
    }
  }

  // MACD — for shorts, bullish MACD signals trigger exit (reversal against short)
  if (analysis.macd) {
    if (direction === 'SHORT') {
      if (analysis.macd.crossover === 'BULLISH') {
        score += 15;
        factors.push('MACD bullish crossover — SHORT reversal risk');
      } else if (analysis.macd.crossover === 'BULLISH_TREND') {
        score += 5;
        factors.push('MACD bullish trend — SHORT pressure easing');
      }
    } else {
      if (analysis.macd.crossover === 'BEARISH') {
        score += 15;
        factors.push('MACD bearish crossover');
      } else if (analysis.macd.crossover === 'BEARISH_TREND') {
        score += 5;
        factors.push('MACD bearish trend');
      }
    }
  }

  // Trend — for shorts, bullish trend is adverse
  if (direction === 'SHORT') {
    if (analysis.trend?.direction === 'BULLISH') {
      score += 10;
      factors.push('Trend: BULLISH — adverse for SHORT');
    }
  } else {
    if (analysis.trend?.direction === 'BEARISH') {
      score += 10;
      factors.push('Trend: BEARISH');
    }
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

  // ── Cut losers faster: loss + hold time + adverse MACD ──
  const adverseMacd = direction === 'SHORT'
    ? analysis.macd?.crossover === 'BULLISH'
    : analysis.macd?.crossover === 'BEARISH';
  if (pnlPercent < -5 && holdHours > 12 && adverseMacd) {
    score += 15;
    factors.push(`Loser held ${holdHours.toFixed(0)}h with MACD ${direction === 'SHORT' ? 'bullish' : 'bearish'} — cut loss`);
  }

  // ── Declining volume with profit — fading buying interest ──
  if (analysis.volume?.trend === 'DECREASING' && pnlPercent > 3) {
    score += 10;
    factors.push(`Volume declining with +${pnlPercent.toFixed(1)}% profit — fading interest`);
  }

  // ── OBV divergence: profitable but volume flow adverse ──
  const adverseObvTrend = direction === 'SHORT' ? 'RISING' : 'FALLING';
  if (analysis.obv && pnlPercent > 3 && analysis.obv.trend === adverseObvTrend) {
    score += 15;
    factors.push(`OBV divergence: ${direction} +${pnlPercent.toFixed(1)}% but OBV ${analysis.obv.trend.toLowerCase()} — ${direction === 'SHORT' ? 'buyers returning' : 'smart money exiting'}`);
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
  if (maxGain > 5 && pnlPercent < -2) {
    const floor = Math.min(80, 50 + Math.round(maxGain * 2));
    if (score < floor) {
      score = floor;
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
  const urgencyThreshold = exitConfig.urgency_threshold ?? 30;
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
      const cooldownKey = `${position.symbol}:${position.direction || 'LONG'}`;
      const inCooldown = isInExitCooldown(cooldownKey, cooldownMinutes);

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
        const direction = position.direction || 'LONG';
        const currentPnlPct = direction === 'SHORT'
          ? ((avgEntry - currentPrice) / avgEntry) * 100
          : ((currentPrice - avgEntry) / avgEntry) * 100;
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

      // Predictive positions get different exit thresholds (longer hold, higher urgency threshold)
      let exitOverrides = null;
      const entryMode = position.entry_mode || 'REACTIVE';
      if (entryMode === 'PREDICTIVE' || entryMode === 'PREDICTIVE_BTC_LED') {
        exitOverrides = {
          minHoldHours: 6,
          stagnationStartHours: 12,
        };
      }

      const urgency = computeExitUrgency(posForUrgency, analysis, currentPrice, null, exitOverrides);

      logger.info(`[ExitScanner] ${position.symbol}${entryMode !== 'REACTIVE' ? ` [${entryMode}]` : ''}: urgency ${urgency.score} | P&L ${urgency.pnl_percent.toFixed(1)}% | held ${urgency.hold_hours.toFixed(0)}h`);

      // Predictive positions use higher urgency threshold (50 vs 30)
      const effectiveThreshold = (entryMode === 'PREDICTIVE' || entryMode === 'PREDICTIVE_BTC_LED')
        ? 50
        : urgencyThreshold;
      if (urgency.score < effectiveThreshold) continue;

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
