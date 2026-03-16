/**
 * Prediction Manager — CRUD operations, position sizing, and scoring for predictions.
 */

import { readFileSync } from 'fs';
import { query } from '../db/connection.js';
import logger from './logger.js';

const _tradingConfig = (() => { try { return JSON.parse(readFileSync('config/trading.json', 'utf8')); } catch { return {}; } })();

// ── Create Prediction ───────────────────────────────────────

/**
 * Insert a new prediction into the database.
 *
 * @param {object} params
 * @returns {Promise<number>} prediction ID
 */
export async function createPrediction({
  symbol, tier, direction, confidence, timeframe_hours,
  invalidation_criteria, divergence_type, divergence_details,
  reasoning, signal_id = null,
}) {
  const result = await query(`
    INSERT INTO predictions (
      symbol, tier, direction, confidence, timeframe_hours,
      invalidation_criteria, divergence_type, divergence_details,
      reasoning, signal_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `, [
    symbol, tier, direction, confidence, timeframe_hours,
    invalidation_criteria, divergence_type,
    divergence_details ? JSON.stringify(divergence_details) : null,
    reasoning, signal_id,
  ]);

  const id = result.rows[0].id;
  logger.info(`[Prediction] Created #${id}: ${symbol} ${direction} conf:${confidence} timeframe:${timeframe_hours}h type:${divergence_type}`);
  return id;
}

// ── Query Predictions ───────────────────────────────────────

/**
 * Get all PENDING predictions (not yet resolved).
 * @returns {Promise<object[]>}
 */
export async function getPendingPredictions() {
  const result = await query(
    "SELECT * FROM predictions WHERE outcome = 'PENDING' ORDER BY created_at DESC"
  );
  return result.rows;
}

/**
 * Check if a PENDING prediction already exists for a symbol + direction + divergence type
 * within the given dedup window. Prevents duplicate predictions every cycle.
 *
 * @param {string} symbol
 * @param {string} direction - UP or DOWN
 * @param {string} divergenceType - OBV_DIVERGENCE, MACD_ACCELERATION, COMBINED
 * @param {number} windowHours - Lookback window (default: timeframe of the prediction, typically 12)
 * @returns {Promise<boolean>} true if a matching pending prediction exists
 */
export async function hasPendingPrediction(symbol, direction, divergenceType, windowHours = 12) {
  const result = await query(`
    SELECT id FROM predictions
    WHERE symbol = $1 AND direction = $2 AND divergence_type = $3
      AND outcome = 'PENDING'
      AND created_at > NOW() - make_interval(hours => $4)
    LIMIT 1
  `, [symbol, direction, divergenceType, windowHours]);
  return result.rows.length > 0;
}

/**
 * Get open positions with PREDICTIVE or PREDICTIVE_BTC_LED entry mode.
 * @returns {Promise<object[]>}
 */
export async function getOpenPredictivePositions() {
  const result = await query(
    "SELECT * FROM positions WHERE status = 'OPEN' AND entry_mode IN ('PREDICTIVE', 'PREDICTIVE_BTC_LED') ORDER BY entry_time DESC"
  );
  return result.rows;
}

/**
 * Check if we can open a new predictive position.
 * @param {object} config - predictive config section
 * @returns {Promise<boolean>}
 */
export async function canOpenPredictivePosition(config = {}) {
  const maxPredictive = config.max_concurrent_predictive_positions || 3;
  const openPredictive = await getOpenPredictivePositions();
  return openPredictive.length < maxPredictive;
}

// ── Position Sizing ─────────────────────────────────────────

/**
 * Calculate position size for a predictive trade.
 *
 * Formula: tierBase * baseMultiplier * (confidence / confidenceDenominator)
 * Capped at tier max and available capital.
 *
 * @param {number} tier - 1 or 2
 * @param {number} confidence - 0.0-1.0
 * @param {object} tradingConfig - Full trading config
 * @returns {number} Position size in USD
 */
export function calcPredictivePositionSize(tier, confidence, tradingConfig) {
  const predictiveConfig = tradingConfig.predictive || {};
  const sizingConfig = predictiveConfig.position_sizing || {};
  const baseMultiplier = sizingConfig.base_multiplier || 0.60;
  const confDenom = sizingConfig.confidence_denominator || 0.80;

  const tierKey = `tier_${tier}`;
  const tierConfig = tradingConfig.position_sizing?.[tierKey];
  const tierBase = tierConfig?.base_position_usd || (tier === 1 ? 800 : 600);
  const tierMax = tierConfig?.max_position_usd || (tier === 1 ? 2400 : 1800);

  const rawSize = tierBase * baseMultiplier * (confidence / confDenom);
  return Math.min(Math.round(rawSize), tierMax);
}

// ── Link Prediction to Position ─────────────────────────────

/**
 * Link a prediction to an opened position.
 * @param {number} predictionId
 * @param {number} positionId
 */
export async function linkPredictionToPosition(predictionId, positionId) {
  await query(
    'UPDATE predictions SET position_id = $1 WHERE id = $2',
    [positionId, predictionId]
  );
}

// ── Prediction Scoring ──────────────────────────────────────

/**
 * Evaluate all PENDING predictions past their timeframe.
 * Scores: CORRECT (>=3% in direction), PARTIALLY_CORRECT (1-3%),
 * WRONG (>=2% against), INVALIDATED (criteria met), EXPIRED (no sig move).
 *
 * @returns {Promise<{ evaluated: number, correct: number, wrong: number }>}
 */
export async function evaluatePredictions() {
  const pending = await query(`
    SELECT p.*
    FROM predictions p
    WHERE p.outcome = 'PENDING'
      AND p.created_at + make_interval(hours => p.timeframe_hours) < NOW()
    ORDER BY p.created_at ASC
  `);

  let evaluated = 0, correct = 0, wrong = 0;

  for (const pred of pending.rows) {
    try {
      // Get price at prediction time and current/final price
      const priceAtCreation = await getPriceAtTime(pred.symbol, pred.created_at);
      const priceAtEnd = await getPriceAtTime(pred.symbol, new Date(
        new Date(pred.created_at).getTime() + pred.timeframe_hours * 3600000
      ));

      if (!priceAtCreation || !priceAtEnd) {
        // Can't evaluate — mark expired
        await markPredictionOutcome(pred.id, 'EXPIRED', null);
        evaluated++;
        continue;
      }

      const movePercent = ((priceAtEnd - priceAtCreation) / priceAtCreation) * 100;
      const directedMove = pred.direction === 'UP' ? movePercent : -movePercent;

      let outcome;
      if (directedMove >= 3) {
        outcome = 'CORRECT';
        correct++;
      } else if (directedMove >= 1) {
        outcome = 'PARTIALLY_CORRECT';
        correct++; // Counts as a hit for accuracy
      } else if (directedMove <= -2) {
        outcome = 'WRONG';
        wrong++;
      } else {
        outcome = 'EXPIRED';
      }

      await markPredictionOutcome(pred.id, outcome, movePercent);
      evaluated++;

      logger.info(`[Prediction] Scored #${pred.id} ${pred.symbol} ${pred.direction}: ${outcome} (${movePercent > 0 ? '+' : ''}${movePercent.toFixed(2)}%)`);
    } catch (err) {
      logger.error(`[Prediction] Error scoring #${pred.id}: ${err.message}`);
    }
  }

  if (evaluated > 0) {
    logger.info(`[Prediction] Evaluated ${evaluated} predictions: ${correct} correct, ${wrong} wrong`);
  }

  return { evaluated, correct, wrong };
}

/**
 * Get the rolling 14-day accuracy for a symbol.
 * Used for auto-calibration (raise threshold if accuracy < 40%).
 *
 * @param {string} symbol
 * @returns {Promise<number|null>} Accuracy percentage or null if insufficient data
 */
export async function getSymbolPredictionAccuracy(symbol) {
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE outcome NOT IN ('PENDING')) as scored,
      COUNT(*) FILTER (WHERE outcome IN ('CORRECT', 'PARTIALLY_CORRECT')) as hits
    FROM predictions
    WHERE symbol = $1 AND created_at > NOW() - INTERVAL '14 days'
  `, [symbol]);

  const row = result.rows[0];
  const scored = parseInt(row.scored) || 0;
  if (scored < 3) return null; // Insufficient data

  const hits = parseInt(row.hits) || 0;
  return (hits / scored) * 100;
}

// ── Internal Helpers ────────────────────────────────────────

async function getPriceAtTime(symbol, targetTime) {
  // Use indicator_snapshots to find closest price
  const result = await query(`
    SELECT price FROM indicator_snapshots
    WHERE symbol = $1 AND created_at <= $2
    ORDER BY created_at DESC LIMIT 1
  `, [symbol, targetTime]);

  if (result.rows.length > 0) return parseFloat(result.rows[0].price);

  // Fallback: check slightly after
  const fallback = await query(`
    SELECT price FROM indicator_snapshots
    WHERE symbol = $1 AND created_at >= $2
    ORDER BY created_at ASC LIMIT 1
  `, [symbol, targetTime]);

  return fallback.rows.length > 0 ? parseFloat(fallback.rows[0].price) : null;
}

async function markPredictionOutcome(predictionId, outcome, actualMovePercent) {
  await query(`
    UPDATE predictions
    SET outcome = $1, actual_move_percent = $2, outcome_evaluated_at = NOW()
    WHERE id = $3
  `, [outcome, actualMovePercent, predictionId]);
}
