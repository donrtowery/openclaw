import { query } from '../db/connection.js';
import { createRequire } from 'module';
import logger from './logger.js';

const require = createRequire(import.meta.url);
const tiersConfig = require('../config/tiers.json');
const tradingConfig = require('../config/trading.json');

/**
 * Look up which tier a symbol belongs to.
 * @param {string} symbol
 * @returns {{ tier: number, name: string, config: object } | null}
 */
export function getTierForSymbol(symbol) {
  for (const [tierNum, tierData] of Object.entries(tiersConfig.tiers)) {
    if (tierData.symbols.includes(symbol)) {
      return {
        tier: parseInt(tierNum),
        name: tierData.name,
        config: tierData,
      };
    }
  }
  return null;
}

/**
 * Calculate stop loss price based on tier.
 * Stop is always calculated from the ORIGINAL entry price.
 * @param {string} symbol
 * @param {number} entryPrice - Original entry price (not DCA average)
 * @returns {number} Stop loss price
 */
export function calculateStopLoss(symbol, entryPrice) {
  const tierInfo = getTierForSymbol(symbol);
  if (!tierInfo) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }
  const stopPercent = tierInfo.config.stopLossPercent;
  return entryPrice * (1 - stopPercent / 100);
}

/**
 * Calculate DCA trigger price for a given level.
 * @param {string} symbol
 * @param {number} entryPrice - Original entry price
 * @param {number} dcaLevel - 1 or 2
 * @returns {number | null} DCA trigger price, or null if not available for this tier
 */
export function calculateDCAPrice(symbol, entryPrice, dcaLevel) {
  const tierInfo = getTierForSymbol(symbol);
  if (!tierInfo) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }

  const dcaKey = `dca${dcaLevel}`;
  const dcaConfig = tierInfo.config[dcaKey];

  if (!dcaConfig || dcaLevel > tierInfo.config.dcaLevels) {
    return null;
  }

  return entryPrice * (1 - dcaConfig.triggerPercent / 100);
}

/**
 * Calculate all three take profit price levels.
 * @param {number} entryPrice - Average entry price (recalculated after DCAs)
 * @returns {{ tp1: number, tp2: number, tp3: number }}
 */
export function calculateTakeProfits(entryPrice) {
  const tp = tiersConfig.takeProfit;
  return {
    tp1: entryPrice * (1 + tp.tp1.percent / 100),
    tp2: entryPrice * (1 + tp.tp2.percent / 100),
    tp3: entryPrice * (1 + tp.tp3.percent / 100),
  };
}

/**
 * Check if current price has hit a DCA level that hasn't been used yet.
 * @param {object} position - Position row from DB
 * @param {number} currentPrice
 * @returns {{ shouldDCA: boolean, level: number, amount: number } | null}
 */
export function shouldDCA(position, currentPrice) {
  const tierInfo = getTierForSymbol(position.symbol);
  if (!tierInfo) return null;

  const maxDCA = tierInfo.config.dcaLevels;

  // Check DCA1
  if (position.dca_level < 1 && maxDCA >= 1) {
    const dca1Trigger = calculateDCAPrice(position.symbol, parseFloat(position.entry_price), 1);
    if (dca1Trigger && currentPrice <= dca1Trigger) {
      return { shouldDCA: true, level: 1, amount: tierInfo.config.dca1.amount };
    }
  }

  // Check DCA2
  if (position.dca_level < 2 && maxDCA >= 2) {
    const dca2Trigger = calculateDCAPrice(position.symbol, parseFloat(position.entry_price), 2);
    if (dca2Trigger && currentPrice <= dca2Trigger) {
      return { shouldDCA: true, level: 2, amount: tierInfo.config.dca2.amount };
    }
  }

  return null;
}

/**
 * Check if current price has hit the stop loss.
 * Stop loss is based on the ORIGINAL entry price, not DCA average.
 * @param {object} position - Position row from DB
 * @param {number} currentPrice
 * @returns {boolean}
 */
export function shouldStopLoss(position, currentPrice) {
  return currentPrice <= parseFloat(position.stop_loss_price);
}

/**
 * Check which take profit levels have been hit.
 * @param {object} position - Position row from DB
 * @param {number} currentPrice
 * @returns {{ level: string, price: number } | null} First unhit TP level that's been reached
 */
export function shouldTakeProfit(position, currentPrice) {
  if (!position.tp1_hit && currentPrice >= parseFloat(position.tp1_price)) {
    return { level: 'TP1', price: parseFloat(position.tp1_price) };
  }
  if (!position.tp2_hit && currentPrice >= parseFloat(position.tp2_price)) {
    return { level: 'TP2', price: parseFloat(position.tp2_price) };
  }
  if (!position.tp3_hit && currentPrice >= parseFloat(position.tp3_price)) {
    return { level: 'TP3', price: parseFloat(position.tp3_price) };
  }
  return null;
}

/**
 * Check whether trading is currently paused by the circuit breaker.
 * @returns {Promise<{ isPaused: boolean, consecutiveLosses: number, resumeAt: Date | null }>}
 */
export async function checkCircuitBreaker() {
  const result = await query('SELECT * FROM circuit_breaker WHERE id = 1');
  const row = result.rows[0];

  // If paused, check if cooldown has elapsed
  if (row.is_paused && row.resume_at) {
    const now = new Date();
    if (now >= new Date(row.resume_at)) {
      // Cooldown elapsed — auto-resume
      await query(
        `UPDATE circuit_breaker
         SET is_paused = false, paused_at = NULL, resume_at = NULL, last_updated = NOW()
         WHERE id = 1`
      );
      return { isPaused: false, consecutiveLosses: row.consecutive_losses, resumeAt: null };
    }
  }

  return {
    isPaused: row.is_paused,
    consecutiveLosses: row.consecutive_losses,
    resumeAt: row.resume_at,
  };
}

/**
 * Record a loss. Increments consecutive losses and pauses if threshold reached.
 * @returns {Promise<{ consecutiveLosses: number, isPaused: boolean }>}
 */
export async function recordLoss() {
  const result = await query(
    `UPDATE circuit_breaker
     SET consecutive_losses = consecutive_losses + 1, last_updated = NOW()
     WHERE id = 1
     RETURNING consecutive_losses`
  );

  const losses = result.rows[0].consecutive_losses;
  const maxLosses = tradingConfig.circuitBreaker.maxConsecutiveLosses;

  if (losses >= maxLosses) {
    const pauseHours = tradingConfig.circuitBreaker.pauseDurationHours;
    const resumeAt = new Date(Date.now() + pauseHours * 60 * 60 * 1000);

    await query(
      `UPDATE circuit_breaker
       SET is_paused = true, paused_at = NOW(), resume_at = $1, last_updated = NOW()
       WHERE id = 1`,
      [resumeAt]
    );

    return { consecutiveLosses: losses, isPaused: true };
  }

  return { consecutiveLosses: losses, isPaused: false };
}

/**
 * Record a win. Resets consecutive losses to 0.
 */
export async function recordWin() {
  await query(
    `UPDATE circuit_breaker
     SET consecutive_losses = 0, last_updated = NOW()
     WHERE id = 1`
  );
}

/**
 * Check whether we can open a new position (< max concurrent).
 * @returns {Promise<{ canOpen: boolean, openCount: number, maxPositions: number }>}
 */
export async function canOpenPosition() {
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM positions WHERE status = 'OPEN'`
  );
  const openCount = result.rows[0].count;
  const maxPositions = tradingConfig.maxConcurrentPositions;

  return {
    canOpen: openCount < maxPositions,
    openCount,
    maxPositions,
  };
}
