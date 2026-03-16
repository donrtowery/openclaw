import dotenv from 'dotenv';
dotenv.config();

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { query, getClient, testConnection } from '../db/connection.js';
import { queueEvent } from '../lib/events.js';
import logger from '../lib/logger.js';
import Anthropic from '@anthropic-ai/sdk';
import { extractJSON } from '../lib/claude.js';
import { evaluatePredictions } from '../lib/prediction-manager.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
});
const OPUS_MODEL = process.env.OPUS_MODEL || 'claude-opus-4-20250514';
const SONNET_MODEL = process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250929';

const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));
const SNAPSHOT_RETENTION_DAYS = config.learning?.snapshot_retention_days || 30;
const MISSED_OPP_THRESHOLD = config.learning?.missed_opportunity_threshold_pct || 3.0;
const SUSTAINED_CANDLES = config.learning?.sustained_candles_required || 6;
const ESC_CONV_TARGET_MIN = config.learning?.escalation_conversion_target_min || 15;
const ESC_CONV_TARGET_MAX = config.learning?.escalation_conversion_target_max || 30;
const PASS_EVAL_WINDOW_HOURS = Math.max(1, parseInt(config.learning?.pass_evaluation_window_hours) || 48);
// Safety assertion: PASS_EVAL_WINDOW_HOURS is interpolated into SQL make_interval() calls.
// It MUST be a safe integer. This assertion prevents injection if the parseInt guard above
// is ever removed or the config source changes.
if (!Number.isInteger(PASS_EVAL_WINDOW_HOURS) || PASS_EVAL_WINDOW_HOURS < 1 || PASS_EVAL_WINDOW_HOURS > 168) {
  throw new Error(`PASS_EVAL_WINDOW_HOURS must be an integer 1-168, got: ${PASS_EVAL_WINDOW_HOURS}`);
}
const DEFENSIVE_WIN_RATE_THRESHOLD = config.learning?.defensive_mode_win_rate_threshold || 50;
const DEFENSIVE_MAX_ESC_TARGET = config.learning?.defensive_mode_max_escalation_target || 15;
const DEFENSIVE_MIN_ESCALATE_RATIO = config.learning?.defensive_mode_min_escalate_ratio || 0.2;

// Changelog config
const CHANGELOG_ENABLED = config.learning?.changelog?.enabled !== false;
const CHANGELOG_OSCILLATION_WINDOW_DAYS = config.learning?.changelog?.oscillation_window_days || 14;
const CHANGELOG_OSCILLATION_THRESHOLD = config.learning?.changelog?.oscillation_threshold || 3;
const CHANGELOG_CONTEXT_WINDOW_DAYS = config.learning?.changelog?.context_window_days || 30;
const CHANGELOG_MAX_CONTEXT_ENTRIES = config.learning?.changelog?.max_context_entries || 50;
const CHANGELOG_RETENTION_DAYS = config.learning?.changelog?.retention_days || 90;

async function run() {
  logger.info('[Learning] === Nightly Learning Job Started ===');

  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('[Learning] Database connection failed');
    process.exit(1);
  }

  // ── Step 1: Evaluate outcomes first (so stats reflect latest data) ──

  await updateOutcomes();

  // ── Step 1b: Evaluate prediction outcomes ─────────────────
  try {
    const predResults = await evaluatePredictions();
    if (predResults.evaluated > 0) {
      logger.info(`[Learning] Prediction scoring: ${predResults.evaluated} evaluated (${predResults.correct} correct, ${predResults.wrong} wrong)`);
    }
  } catch (err) {
    logger.error(`[Learning] Prediction scoring error: ${err.message}`);
  }

  // ── Step 1c: Fetch prediction accuracy for Opus context ───
  let predictionAccuracyStats = [];
  try {
    const accResult = await query('SELECT * FROM prediction_accuracy ORDER BY total DESC LIMIT 20');
    predictionAccuracyStats = accResult.rows;
  } catch (err) {
    logger.warn(`[Learning] Prediction accuracy query failed: ${err.message}`);
  }

  // ── Step 2: Calculate statistics ──────────────────────────

  const stats = await calculateStats();

  // ── Novelty check: skip prompt updates if no new closed trades since last run ──
  const MIN_NEW_TRADES = config.learning?.min_new_trades_for_update || 2;
  const lastHistoryResult = await query(
    'SELECT created_at FROM learning_history ORDER BY created_at DESC LIMIT 1'
  );
  const lastLearningRunTime = lastHistoryResult.rows[0]?.created_at || null;
  let newTradesSinceLastRun = stats.total_trades; // default: all trades count if no prior run
  if (lastLearningRunTime) {
    const newTradesResult = await query(
      "SELECT COUNT(*) as cnt FROM positions WHERE status = 'CLOSED' AND exit_time > $1",
      [lastLearningRunTime]
    );
    newTradesSinceLastRun = parseInt(newTradesResult.rows[0]?.cnt) || 0;
  }
  const skipPromptUpdates = newTradesSinceLastRun < MIN_NEW_TRADES && lastLearningRunTime !== null;
  if (skipPromptUpdates) {
    logger.info(`[Learning] Novelty check: only ${newTradesSinceLastRun} new trade(s) since last run (need ${MIN_NEW_TRADES}). Skipping prompt/rule updates to prevent churn.`);
  }

  logger.info(`[Learning] Stats: ${stats.total_trades} trades, ${stats.win_rate.toFixed(1)}% win rate, $${stats.total_pnl.toFixed(2)} total P&L, Sharpe: ${stats.sharpe_ratio.toFixed(2)}, max streak: ${stats.max_consecutive_losses}`);
  logger.info(`[Learning] Missed BUY opportunities: ${stats.missed_opportunities.length} non-escalated, ${stats.missed_pass_decisions.length} Sonnet PASS`);
  logger.info(`[Learning] Missed SELL opportunities: ${stats.missed_sell_opportunities.length} non-escalated, ${stats.missed_sell_pass_decisions.length} Sonnet PASS`);

  const totalEscalated = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.total_escalated), 0);
  const totalTraded = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.led_to_trade), 0);
  const totalPassed = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.passed), 0);
  const escConvRate = totalEscalated > 0 ? (totalTraded / totalEscalated * 100).toFixed(1) : '0.0';
  logger.info(`[Learning] Escalation accuracy: ${totalEscalated} escalated → ${totalTraded} traded (${escConvRate}%), ${totalPassed} PASSed`);
  logger.info(`[Learning] PASS outcomes: ${parseInt(stats.pass_outcome_summary.correct_pass) || 0} CORRECT_PASS, ${parseInt(stats.pass_outcome_summary.missed_opportunity) || 0} MISSED_OPPORTUNITY`);
  logger.info(`[Learning] PASS patterns (Sonnet rejects, min 10 samples): ${stats.pass_patterns.length} | Missed escalation patterns: ${stats.missed_escalation_patterns.length}`);
  if (stats.pass_reasoning_themes.length > 0) {
    const themes = stats.pass_reasoning_themes.map(t => `${t.rejection_theme}(${t.cnt})`).join(', ');
    logger.info(`[Learning] PASS rejection themes: ${themes}`);
  }

  // ── Defensive Mode Detection ──
  const defensiveMode = stats.win_rate < DEFENSIVE_WIN_RATE_THRESHOLD && stats.total_pnl < 0 && stats.total_trades >= 5;
  if (defensiveMode) {
    logger.warn(`[Learning] *** DEFENSIVE MODE ACTIVE *** Win rate ${stats.win_rate.toFixed(1)}% < ${DEFENSIVE_WIN_RATE_THRESHOLD}%, P&L $${stats.total_pnl.toFixed(2)} < 0, ${stats.total_trades} trades >= 5`);
  }

  // Fetch last 5 learning history rows for trajectory analysis
  const trajectoryResult = await query(`
    SELECT created_at, total_trades, win_rate, total_pnl, sonnet_analysis
    FROM learning_history
    ORDER BY created_at DESC LIMIT 5
  `);
  const trajectoryRows = trajectoryResult.rows;
  if (trajectoryRows.length > 0) {
    for (const row of trajectoryRows) {
      try {
        const prev = JSON.parse(row.sonnet_analysis);
        const prevRuleCount = (toArray(prev.haiku_rules).length + toArray(prev.haiku_escalation_calibration).length);
        logger.info(`[Learning] History ${new Date(row.created_at).toISOString().split('T')[0]}: ${row.total_trades} trades, ${parseFloat(row.win_rate).toFixed(1)}% WR, $${parseFloat(row.total_pnl).toFixed(2)} P&L, ${prevRuleCount} rules`);
      } catch { /* ignore parse errors from old format */ }
    }
    logger.info(`[Learning] Current escalation conversion: ${escConvRate}%`);
  }

  // ── Step 3: Call Opus for analysis (ONE call) ─────────────

  const analysis = await callOpusForAnalysis(stats, defensiveMode, trajectoryRows, predictionAccuracyStats);

  // ── Step 3b: Validate Opus's generated rules ──────────────
  // Run validation BEFORE injecting corrective rules so the contradiction
  // detector doesn't strip system-generated calibration rules.

  validateAnalysis(analysis, defensiveMode);

  // ── Step 3c: Enforce escalation conversion rate bounds ────
  // These corrective rules are injected AFTER validation so they are
  // never removed by the contradiction detector.

  const currentEscRate = parseFloat(escConvRate);
  if (defensiveMode) {
    // Check for defensive mode stagnation — if barely any new trades since oldest session, relax
    // Uses actual trade count between history entries to avoid 30-day rolling window shrinkage
    let defensiveStagnant = false;
    let tradesSinceOldest = -1;
    if (trajectoryRows.length >= 2) {
      const oldestSessionTime = trajectoryRows[trajectoryRows.length - 1]?.created_at;
      if (oldestSessionTime) {
        try {
          const tradesSinceResult = await query(
            "SELECT COUNT(*) as cnt FROM positions WHERE status = 'CLOSED' AND exit_time > $1",
            [oldestSessionTime]
          );
          tradesSinceOldest = parseInt(tradesSinceResult.rows[0]?.cnt) || 0;
          const stagnationThreshold = trajectoryRows.length; // 1 trade per session minimum
          if (tradesSinceOldest <= stagnationThreshold) {
            defensiveStagnant = true;
          }
        } catch (err) {
          logger.warn(`[Learning] Stagnation check query failed: ${err.message}`);
        }
      }
    }

    let corrective;
    if (defensiveStagnant) {
      // Stagnant defensive mode — relax to allow T1 MODERATE signals to break the deadlock
      logger.warn(`[Learning] DEFENSIVE MODE STAGNANT: Only ${tradesSinceOldest} new trades across ${trajectoryRows.length} sessions. Relaxing to cautious mode.`);
      const stagnationSessions = config.escalation?.stagnation_sessions_to_override || 3;
      const stagnationFloor = config.escalation?.stagnation_confidence_floor || 0.50;
      if (trajectoryRows.length >= stagnationSessions && tradesSinceOldest === 0) {
        // Full stagnation override — trading has completely stopped
        logger.warn(`[Learning] STAGNATION OVERRIDE: Zero trades across ${trajectoryRows.length} sessions (>= ${stagnationSessions}). Aggressively relaxing filters.`);
        corrective = `START: STAGNATION OVERRIDE — zero trades for ${trajectoryRows.length} sessions. RESUME TRADING with relaxed filters. Allow T1 signals with confidence >=${stagnationFloor} and 1+ confirmation. Allow T2 STRONG signals with confidence >=0.60 and 2+ confirmations. Volume >2x is sufficient for T1. SELL signals always escalated. This override expires when at least 3 new trades complete.`;
      } else {
        corrective = `STOP: CAUTIOUS MODE (relaxed from defensive) — win rate ${stats.win_rate.toFixed(1)}%, P&L $${stats.total_pnl.toFixed(2)}. Allow T1 MODERATE signals with confidence >=0.55 and 1+ confirmations. Allow T2 STRONG signals with confidence >=0.65. SELL signals are EXEMPT — always escalate SELL/exit signals.`;
      }
    } else {
      // Standard defensive mode
      logger.warn(`[Learning] DEFENSIVE MODE: Prepending capital preservation STOP rule (overrides escalation conversion logic)`);
      corrective = `STOP: DEFENSIVE MODE — win rate ${stats.win_rate.toFixed(1)}%, P&L $${stats.total_pnl.toFixed(2)}. Capital preservation is priority #1. Only escalate HIGH-confidence BUY signals with 3+ strong confirmations. Reject all MODERATE and WEAK BUY signals. SELL signals are EXEMPT — always escalate SELL/exit signals regardless of defensive mode.`;
    }
    analysis.haiku_rules = [corrective, ...toArray(analysis.haiku_rules)];
  } else if (totalEscalated >= 20) { // Only enforce with sufficient data
    if (currentEscRate > ESC_CONV_TARGET_MAX) {
      logger.warn(`[Learning] Escalation conversion rate ${escConvRate}% exceeds target max ${ESC_CONV_TARGET_MAX}% — prepending corrective STOP rule`);
      const corrective = `STOP: Escalation conversion at ${escConvRate}% (target ${ESC_CONV_TARGET_MIN}-${ESC_CONV_TARGET_MAX}%). Be MORE selective — only escalate STRONG signals with 3+ confirmations.`;
      analysis.haiku_rules = [corrective, ...toArray(analysis.haiku_rules)];
    } else if (currentEscRate < ESC_CONV_TARGET_MIN) {
      logger.warn(`[Learning] Escalation conversion rate ${escConvRate}% below target min ${ESC_CONV_TARGET_MIN}% — prepending corrective START rule`);
      const corrective = `START: Escalation conversion at ${escConvRate}% (target ${ESC_CONV_TARGET_MIN}-${ESC_CONV_TARGET_MAX}%). Be LESS selective — escalate MODERATE signals with 2+ confirmations.`;
      analysis.haiku_rules = [corrective, ...toArray(analysis.haiku_rules)];
    }
  }

  // ── Step 4: Update prompt files ───────────────────────────

  let promptsUpdated = false;
  if (analysis._parseFailure) {
    logger.warn(`[Learning] Skipping prompt/rule updates — Opus parse failure this cycle`);
  } else if (skipPromptUpdates) {
    logger.info(`[Learning] Skipping prompt/rule updates — insufficient new trade data`);
  } else {
    await updatePromptFiles(stats, analysis, defensiveMode);
    await saveLearningRules(analysis, stats);
    promptsUpdated = true;
  }

  // ── Step 5: Save history (always, even on parse failure for diagnostics) ──

  await saveLearningHistory(stats, analysis, promptsUpdated);

  // ── Step 6: Cleanup ───────────────────────────────────────

  await cleanup();

  // ── Step 7: Log results ───────────────────────────────────

  await queueEvent('SYSTEM', null, {
    type: 'NIGHTLY_LEARNING',
    trades_analyzed: stats.total_trades,
    win_rate: stats.win_rate,
    profit_factor: stats.profit_factor,
    rules_generated: (analysis.haiku_rules?.length || 0) + (analysis.sonnet_rules?.length || 0) + (analysis.haiku_escalation_calibration?.length || 0),
    few_shots_generated: (analysis.haiku_few_shots?.length || 0) + (analysis.sonnet_few_shots?.length || 0),
    escalation_total: totalEscalated,
    escalation_traded: totalTraded,
    escalation_passed: totalPassed,
    escalation_conversion_rate: parseFloat(escConvRate),
    pass_correct: parseInt(stats.pass_outcome_summary.correct_pass) || 0,
    pass_missed_opportunity: parseInt(stats.pass_outcome_summary.missed_opportunity) || 0,
    pass_patterns_count: stats.pass_patterns.length,
    missed_escalation_patterns_count: stats.missed_escalation_patterns.length,
  });

  logger.info('[Learning] === Nightly Learning Complete ===');
  process.exit(0);
}

// ── Statistics Calculator ───────────────────────────────────

async function calculateStats() {
  // Overall trade stats
  const overallResult = await query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as wins,
      COUNT(CASE WHEN realized_pnl < 0 THEN 1 END) as losses,
      COUNT(CASE WHEN realized_pnl = 0 THEN 1 END) as breakeven,
      COALESCE(SUM(realized_pnl), 0) as total_pnl,
      COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl END), 0) as total_wins_pnl,
      COALESCE(ABS(SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl END)), 0) as total_losses_pnl,
      COALESCE(AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END), 0) as avg_win,
      COALESCE(AVG(CASE WHEN realized_pnl < 0 THEN realized_pnl END), 0) as avg_loss,
      COALESCE(MAX(realized_pnl), 0) as best_trade,
      COALESCE(MIN(realized_pnl), 0) as worst_trade,
      COALESCE(AVG(CASE WHEN realized_pnl > 0 THEN hold_hours END), 0) as avg_hold_winners,
      COALESCE(AVG(CASE WHEN realized_pnl < 0 THEN hold_hours END), 0) as avg_hold_losers
    FROM positions WHERE status = 'CLOSED' AND exit_time > NOW() - INTERVAL '30 days'
  `);
  const o = overallResult.rows[0];
  const total = parseInt(o.total) || 0;
  const wins = parseInt(o.wins) || 0;
  const totalWinsPnl = parseFloat(o.total_wins_pnl) || 0;
  const totalLossesPnl = parseFloat(o.total_losses_pnl) || 0;

  // P&L by tier
  const tierResult = await query(`
    SELECT tier,
      COUNT(*) as total,
      COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as wins,
      COALESCE(SUM(realized_pnl), 0) as pnl
    FROM positions WHERE status = 'CLOSED' AND exit_time > NOW() - INTERVAL '30 days'
    GROUP BY tier ORDER BY tier
  `);

  // DCA effectiveness
  const dcaResult = await query(`
    SELECT
      CASE WHEN COALESCE(p.dca_count, 0) > 0 THEN 'with_dca' ELSE 'no_dca' END as dca_type,
      COUNT(*) as total,
      COUNT(CASE WHEN p.realized_pnl > 0 THEN 1 END) as wins,
      COALESCE(AVG(p.realized_pnl_percent), 0) as avg_pnl_pct
    FROM positions p WHERE p.status = 'CLOSED' AND p.exit_time > NOW() - INTERVAL '30 days'
    GROUP BY dca_type
  `);

  // Win rate by Haiku strength (signals → decisions → positions)
  const strengthResult = await query(`
    SELECT s.strength,
      COUNT(*) as total,
      COUNT(CASE WHEN p.realized_pnl > 0 THEN 1 END) as wins,
      COALESCE(AVG(p.realized_pnl_percent), 0) as avg_pnl_pct
    FROM signals s
    JOIN decisions d ON d.signal_id = s.id
    JOIN positions p ON p.open_decision_id = d.id AND p.status = 'CLOSED' AND p.exit_time > NOW() - INTERVAL '30 days'
    GROUP BY s.strength
  `);

  // Win rate by confidence range
  const confResult = await query(`
    SELECT
      CASE
        WHEN d.confidence < 0.70 THEN 'low (<0.70)'
        WHEN d.confidence < 0.80 THEN 'medium (0.70-0.80)'
        ELSE 'high (>0.80)'
      END as conf_range,
      COUNT(*) as total,
      COUNT(CASE WHEN p.realized_pnl > 0 THEN 1 END) as wins,
      COALESCE(AVG(p.realized_pnl_percent), 0) as avg_pnl_pct
    FROM decisions d
    JOIN positions p ON p.open_decision_id = d.id AND p.status = 'CLOSED' AND p.exit_time > NOW() - INTERVAL '30 days'
    GROUP BY conf_range
  `);

  // Best/worst indicator combos (top 5 each)
  const patternResult = await query(`
    SELECT s.triggered_by, s.trend,
      COUNT(*) as total,
      COUNT(CASE WHEN p.realized_pnl > 0 THEN 1 END) as wins,
      COALESCE(AVG(p.realized_pnl_percent), 0) as avg_pnl_pct
    FROM signals s
    JOIN decisions d ON d.signal_id = s.id
    JOIN positions p ON p.open_decision_id = d.id AND p.status = 'CLOSED' AND p.exit_time > NOW() - INTERVAL '30 days'
    GROUP BY s.triggered_by, s.trend
    HAVING COUNT(*) >= 2
    ORDER BY avg_pnl_pct DESC
  `);

  // Losing trade patterns — what setups consistently lose money
  const losingPatternResult = await query(`
    SELECT s.triggered_by, s.trend, s.strength,
      COUNT(*) as total,
      COUNT(CASE WHEN p.realized_pnl < 0 THEN 1 END) as losses,
      AVG(CASE WHEN p.realized_pnl < 0 THEN p.realized_pnl END) as avg_loss_usd,
      AVG(CASE WHEN p.realized_pnl < 0 THEN p.realized_pnl_percent END) as avg_loss_pct
    FROM signals s
    JOIN decisions d ON d.signal_id = s.id
    JOIN positions p ON p.open_decision_id = d.id AND p.status = 'CLOSED' AND p.exit_time > NOW() - INTERVAL '30 days'
    WHERE p.realized_pnl < 0
    GROUP BY s.triggered_by, s.trend, s.strength
    HAVING COUNT(*) >= 2
    ORDER BY avg_loss_usd ASC
    LIMIT 10
  `);

  // Exit timing analysis — categorize exits for exit-eval learning
  // Filter out corrupt data: only include trades with |pnl_pct| < 50%
  // LEAST/GREATEST in the AVG is a secondary safety net (caps to -100..+100)
  const exitTimingResult = await query(`
    SELECT
      CASE
        WHEN realized_pnl > 0 AND realized_pnl_percent >= max_unrealized_gain_percent * 0.7 THEN 'good_exit'
        WHEN realized_pnl > 0 AND realized_pnl_percent < max_unrealized_gain_percent * 0.5 THEN 'late_exit_winner'
        WHEN realized_pnl < 0 AND max_unrealized_gain_percent > 3 THEN 'winner_turned_loser'
        WHEN realized_pnl < 0 THEN 'slow_loss_cut'
        ELSE 'other'
      END as exit_category,
      COUNT(*) as cnt,
      AVG(LEAST(GREATEST(realized_pnl_percent, -100), 100)) as avg_pnl_pct,
      AVG(LEAST(max_unrealized_gain_percent, 100)) as avg_max_gain_pct,
      AVG(hold_hours) as avg_hold_hours
    FROM positions
    WHERE status = 'CLOSED' AND exit_time > NOW() - INTERVAL '30 days'
      AND ABS(realized_pnl_percent) < 50
    GROUP BY exit_category
  `);

  // Missed opportunities: signals not escalated where price moved favorably within eval window
  // Uses indicator_snapshots for actual price data. Requires price didn't dip >3% in first
  // 4 hours (consistent with outcome updater) to avoid showing "opportunities" that would
  // have been stopped out by intermediate drawdowns.
  const missedResult = await query(`
    SELECT s.symbol, s.signal_type, s.strength, s.confidence,
      s.price as signal_price, s.created_at,
      sub.max_price_24h,
      CASE WHEN s.price > 0
        THEN ((sub.max_price_24h - s.price) / s.price * 100)
        ELSE 0
      END as potential_gain_pct
    FROM signals s
    LEFT JOIN LATERAL (
      SELECT MAX(i.price) as max_price_24h
      FROM indicator_snapshots i
      WHERE i.symbol = s.symbol
        AND i.created_at > s.created_at
        AND i.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
    ) sub ON true
    WHERE s.escalated = false AND s.signal_type = 'BUY'
      AND s.created_at > NOW() - INTERVAL '30 days'
      AND s.created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      AND sub.max_price_24h IS NOT NULL
      AND COALESCE((SELECT MIN(i2.price) FROM indicator_snapshots i2
           WHERE i2.symbol = s.symbol
             AND i2.created_at > s.created_at
             AND i2.created_at < s.created_at + INTERVAL '4 hours'
          ), s.price) >= s.price * 0.97
    ORDER BY potential_gain_pct DESC
    LIMIT 20
  `);

  // Missed SELL opportunities: SELL signals not escalated where price dropped within eval window
  const missedSellResult = await query(`
    SELECT s.symbol, s.signal_type, s.strength, s.confidence,
      s.price as signal_price, s.created_at,
      sub.min_price_24h,
      CASE WHEN s.price > 0
        THEN ((s.price - sub.min_price_24h) / s.price * 100)
        ELSE 0
      END as potential_drop_pct
    FROM signals s
    LEFT JOIN LATERAL (
      SELECT MIN(i.price) as min_price_24h
      FROM indicator_snapshots i
      WHERE i.symbol = s.symbol
        AND i.created_at > s.created_at
        AND i.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
    ) sub ON true
    WHERE s.escalated = false AND s.signal_type = 'SELL'
      AND s.created_at > NOW() - INTERVAL '30 days'
      AND s.created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      AND sub.min_price_24h IS NOT NULL
      -- Exclude cases where price rallied >3% above signal price in first 4h before dropping
      AND COALESCE((SELECT MAX(i2.price) FROM indicator_snapshots i2
           WHERE i2.symbol = s.symbol
             AND i2.created_at > s.created_at
             AND i2.created_at < s.created_at + INTERVAL '4 hours'
          ), s.price) <= s.price * 1.03
    ORDER BY potential_drop_pct DESC
    LIMIT 20
  `);

  // Missed PASS decisions: Sonnet passed on BUY signals where price rose within eval window
  const missedPassResult = await query(`
    SELECT d.symbol, d.confidence as sonnet_conf, d.reasoning,
      s.strength as haiku_strength, s.confidence as haiku_conf,
      s.price as signal_price, s.created_at,
      sub.max_price_24h,
      CASE WHEN s.price > 0
        THEN ((sub.max_price_24h - s.price) / s.price * 100)
        ELSE 0
      END as potential_gain_pct
    FROM decisions d
    JOIN signals s ON d.signal_id = s.id
    LEFT JOIN LATERAL (
      SELECT MAX(i.price) as max_price_24h
      FROM indicator_snapshots i
      WHERE i.symbol = s.symbol
        AND i.created_at > s.created_at
        AND i.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
    ) sub ON true
    WHERE d.action = 'PASS' AND s.signal_type = 'BUY'
      AND d.created_at > NOW() - INTERVAL '30 days'
      AND d.created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      AND sub.max_price_24h IS NOT NULL
      AND s.price > 0
      AND ((sub.max_price_24h - s.price) / s.price * 100) > $1
    ORDER BY potential_gain_pct DESC
    LIMIT 20
  `, [MISSED_OPP_THRESHOLD]);

  // Missed SELL PASS decisions: Sonnet passed on SELL signals where price dropped within eval window
  const missedSellPassResult = await query(`
    SELECT d.symbol, d.confidence as sonnet_conf, d.reasoning,
      s.strength as haiku_strength, s.confidence as haiku_conf,
      s.price as signal_price, s.created_at,
      sub.min_price_24h,
      CASE WHEN s.price > 0
        THEN ((s.price - sub.min_price_24h) / s.price * 100)
        ELSE 0
      END as potential_drop_pct
    FROM decisions d
    JOIN signals s ON d.signal_id = s.id
    LEFT JOIN LATERAL (
      SELECT MIN(i.price) as min_price_24h
      FROM indicator_snapshots i
      WHERE i.symbol = s.symbol
        AND i.created_at > s.created_at
        AND i.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
    ) sub ON true
    WHERE d.action = 'PASS' AND s.signal_type = 'SELL'
      AND d.created_at > NOW() - INTERVAL '30 days'
      AND d.created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      AND sub.min_price_24h IS NOT NULL
      AND s.price > 0
      AND ((s.price - sub.min_price_24h) / s.price * 100) > $1
      -- Exclude cases where price rallied >3% in first 4h before dropping (matches missedSellResult filter)
      AND COALESCE((SELECT MAX(i2.price) FROM indicator_snapshots i2
           WHERE i2.symbol = s.symbol
             AND i2.created_at > s.created_at
             AND i2.created_at < s.created_at + INTERVAL '4 hours'
          ), s.price) <= s.price * 1.03
    ORDER BY potential_drop_pct DESC
    LIMIT 20
  `, [MISSED_OPP_THRESHOLD]);

  // Escalation accuracy by strength — how many Haiku escalations led to trades vs PASS
  const escalationAccuracyResult = await query(`
    SELECT s.strength,
      COUNT(*) as total_escalated,
      COUNT(CASE WHEN d.action != 'PASS' THEN 1 END) as led_to_trade,
      COUNT(CASE WHEN d.action = 'PASS' THEN 1 END) as passed
    FROM signals s
    JOIN decisions d ON d.signal_id = s.id
    WHERE s.escalated = true
      AND s.created_at > NOW() - INTERVAL '30 days'
    GROUP BY s.strength
    ORDER BY s.strength
  `);

  // PASS patterns — only flag patterns where PASSes were CONFIRMED correct (price didn't move)
  // This prevents self-reinforcing rejection loops where Sonnet passes → nightly says "stop" → Sonnet passes more
  const passPatternResult = await query(`
    SELECT s.triggered_by, s.trend, s.strength,
      COUNT(*) as total,
      COUNT(CASE WHEN d.outcome = 'CORRECT_PASS' THEN 1 END) as correct_pass_count,
      ROUND(COUNT(CASE WHEN d.outcome = 'CORRECT_PASS' THEN 1 END)::numeric / NULLIF(COUNT(CASE WHEN d.outcome IN ('CORRECT_PASS', 'MISSED_OPPORTUNITY') THEN 1 END), 0) * 100, 1) as correct_pass_rate
    FROM signals s
    JOIN decisions d ON d.signal_id = s.id
    WHERE s.escalated = true
      AND s.created_at > NOW() - INTERVAL '30 days'
      AND d.outcome IN ('CORRECT_PASS', 'MISSED_OPPORTUNITY')
    GROUP BY s.triggered_by, s.trend, s.strength
    HAVING COUNT(CASE WHEN d.outcome IN ('CORRECT_PASS', 'MISSED_OPPORTUNITY') THEN 1 END) >= 10
      AND (COUNT(CASE WHEN d.outcome = 'CORRECT_PASS' THEN 1 END)::numeric / NULLIF(COUNT(CASE WHEN d.outcome IN ('CORRECT_PASS', 'MISSED_OPPORTUNITY') THEN 1 END), 0) * 100) >= 70
    ORDER BY correct_pass_rate DESC
  `);

  // Missed escalation patterns — combos Haiku didn't escalate that turned out to be MISSED_OPPORTUNITY
  const missedEscalationResult = await query(`
    SELECT s.triggered_by, s.trend, s.strength,
      COUNT(*) as total,
      COALESCE(AVG(s.outcome_pnl), 0) as avg_gain_pct
    FROM signals s
    WHERE s.escalated = false
      AND s.outcome = 'MISSED_OPPORTUNITY'
      AND s.created_at > NOW() - INTERVAL '30 days'
    GROUP BY s.triggered_by, s.trend, s.strength
    HAVING COUNT(*) >= 2
    ORDER BY avg_gain_pct DESC
  `);

  // PASS reasoning themes — aggregate why Sonnet rejects signals
  const passReasoningResult = await query(`
    SELECT
      CASE
        WHEN reasoning ILIKE '%volume%' THEN 'Insufficient volume'
        WHEN reasoning ILIKE '%resistance%' THEN 'Near resistance'
        WHEN reasoning ILIKE '%downtrend%' OR reasoning ILIKE '%bearish%' OR reasoning ILIKE '%below SMA200%' THEN 'Bearish trend'
        WHEN reasoning ILIKE '%confirmation%' THEN 'Lacks confirmation'
        WHEN reasoning ILIKE '%overbought%' THEN 'Overbought conditions'
        WHEN reasoning ILIKE '%oversold%' AND reasoning ILIKE '%knife%' THEN 'Falling knife'
        WHEN reasoning ILIKE '%noise%' OR reasoning ILIKE '%single%' THEN 'Signal noise'
        WHEN reasoning ILIKE '%parse error%' THEN 'Parse error'
        ELSE 'Other'
      END as rejection_theme,
      COUNT(*) as cnt
    FROM decisions
    WHERE action = 'PASS'
      AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY rejection_theme
    ORDER BY cnt DESC
  `);

  // Sharpe ratio — risk-adjusted returns
  const sharpeResult = await query(`
    SELECT realized_pnl_percent FROM positions
    WHERE status = 'CLOSED' AND exit_time > NOW() - INTERVAL '30 days'
    ORDER BY exit_time
  `);
  let sharpeRatio = 0;
  const pnlReturns = sharpeResult.rows.map(r => parseFloat(r.realized_pnl_percent) || 0);
  if (pnlReturns.length >= 3) {
    const avgReturn = pnlReturns.reduce((s, r) => s + r, 0) / pnlReturns.length;
    const variance = pnlReturns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (pnlReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    sharpeRatio = stdDev > 0 ? Math.round((avgReturn / stdDev) * 100) / 100 : 0;
  }

  // Win rate by signal combo — which triggered_by combinations actually work
  const signalComboResult = await query(`
    SELECT array_to_string(s.triggered_by, '+') as signal_combo, s.strength,
      COUNT(*) as total,
      COUNT(CASE WHEN p.realized_pnl > 0 THEN 1 END) as wins,
      COALESCE(AVG(p.realized_pnl_percent), 0) as avg_pnl_pct,
      COALESCE(SUM(p.realized_pnl), 0) as total_pnl
    FROM signals s
    JOIN decisions d ON d.signal_id = s.id
    JOIN positions p ON p.open_decision_id = d.id AND p.status = 'CLOSED' AND p.exit_time > NOW() - INTERVAL '30 days'
    GROUP BY signal_combo, s.strength
    ORDER BY total DESC
  `);

  // Max consecutive losses (for streak tracking)
  const streakResult = await query(`
    SELECT realized_pnl FROM positions
    WHERE status = 'CLOSED' AND exit_time > NOW() - INTERVAL '30 days'
    ORDER BY exit_time
  `);
  let maxConsecLosses = 0;
  let currentStreak = 0;
  for (const row of streakResult.rows) {
    if (parseFloat(row.realized_pnl) < 0) {
      currentStreak++;
      maxConsecLosses = Math.max(maxConsecLosses, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  // PASS outcome summary — headline count of CORRECT_PASS vs MISSED_OPPORTUNITY
  const passOutcomeSummaryResult = await query(`
    SELECT
      COUNT(CASE WHEN outcome = 'CORRECT_PASS' THEN 1 END) as correct_pass,
      COUNT(CASE WHEN outcome = 'MISSED_OPPORTUNITY' THEN 1 END) as missed_opportunity
    FROM decisions
    WHERE action = 'PASS'
      AND created_at > NOW() - INTERVAL '30 days'
      AND outcome IN ('CORRECT_PASS', 'MISSED_OPPORTUNITY')
  `);

  return {
    total_trades: total,
    wins,
    losses: parseInt(o.losses) || 0,
    win_rate: total > 0 ? (wins / total * 100) : 0,
    total_pnl: parseFloat(o.total_pnl) || 0,
    profit_factor: totalLossesPnl > 0 ? totalWinsPnl / totalLossesPnl : totalWinsPnl > 0 ? 999 : 0,
    avg_win: parseFloat(o.avg_win) || 0,
    avg_loss: parseFloat(o.avg_loss) || 0,
    best_trade: parseFloat(o.best_trade) || 0,
    worst_trade: parseFloat(o.worst_trade) || 0,
    avg_hold_winners: parseFloat(o.avg_hold_winners) || 0,
    avg_hold_losers: parseFloat(o.avg_hold_losers) || 0,
    tier_stats: tierResult.rows,
    dca_stats: dcaResult.rows,
    strength_stats: strengthResult.rows,
    confidence_stats: confResult.rows,
    pattern_stats: patternResult.rows,
    missed_opportunities: missedResult.rows,
    missed_pass_decisions: missedPassResult.rows,
    missed_sell_opportunities: missedSellResult.rows,
    missed_sell_pass_decisions: missedSellPassResult.rows,
    escalation_accuracy: escalationAccuracyResult.rows,
    pass_patterns: passPatternResult.rows,
    missed_escalation_patterns: missedEscalationResult.rows,
    pass_outcome_summary: passOutcomeSummaryResult.rows[0] || { correct_pass: 0, missed_opportunity: 0 },
    pass_reasoning_themes: passReasoningResult.rows,
    losing_patterns: losingPatternResult.rows,
    exit_timing: exitTimingResult.rows,
    sharpe_ratio: sharpeRatio,
    signal_combo_stats: signalComboResult.rows,
    max_consecutive_losses: maxConsecLosses,
  };
}

// ── Opus Analysis Call ──────────────────────────────────────

async function callOpusForAnalysis(stats, defensiveMode = false, trajectoryRows = [], predictionAccuracyStats = []) {
  const hasTrades = stats.total_trades > 0;

  // Adapt prompt framing based on what data exists
  let prompt = `═══ TRADING PHILOSOPHY — READ BEFORE ANALYZING ═══\n\n`;
  prompt += `This is a conservative, utility-focused crypto trading bot. Follow these principles:\n\n`;
  prompt += `1. QUALITY OVER QUANTITY: We would rather miss 10 mediocre trades than take 1 bad one. A 60% win rate with fewer trades beats a 45% win rate with many trades.\n`;
  prompt += `2. T1 AND T2 ONLY: We only trade Tier 1 (blue chip infrastructure: BTC, ETH, SOL, etc.) and Tier 2 (established utility coins). No speculative or meme coins. Do not generate rules referencing T3 or speculative assets.\n`;
  prompt += `3. LOSING TRADES MATTER AS MUCH AS MISSED OPPORTUNITIES: Every "START escalating" rule must be balanced by awareness of what similar setups have lost. Do not create one-sided pressure to trade more.\n`;
  prompt += `4. MULTI-INDICATOR CONFIRMATION REQUIRED: Single-indicator signals are noise in crypto. Require 2-3 aligned indicators before escalating or approving.\n`;
  prompt += `5. PATIENCE PAYS: Hold winners, cut losers early. If losers are held longer than winners, that is the #1 problem to fix.\n`;
  prompt += `6. ESCALATION IS EXPENSIVE: Every escalation costs a Sonnet API call. Target ${ESC_CONV_TARGET_MIN}-${ESC_CONV_TARGET_MAX}% conversion rate. Over-escalation wastes money and creates noise.\n\n`;

  if (hasTrades) {
    prompt += `Analyze this trading performance data and generate updated rules and examples.\n\n`;
    prompt += `PERFORMANCE (${stats.total_trades} trades):\n`;
    prompt += `Win rate: ${stats.win_rate.toFixed(1)}% (${stats.wins}W/${stats.losses}L)\n`;
    prompt += `P&L: $${stats.total_pnl.toFixed(2)} | Avg win: +$${stats.avg_win.toFixed(2)} | Avg loss: $${stats.avg_loss.toFixed(2)}\n`;
    prompt += `Profit factor: ${stats.profit_factor >= 999 ? '∞' : stats.profit_factor.toFixed(2)} | Sharpe ratio: ${stats.sharpe_ratio.toFixed(2)}\n`;
    prompt += `Hold time: Winners ${stats.avg_hold_winners.toFixed(1)}h, Losers ${stats.avg_hold_losers.toFixed(1)}h | Max consec losses: ${stats.max_consecutive_losses}\n`;
    prompt += `Best: +$${stats.best_trade.toFixed(2)} | Worst: $${stats.worst_trade.toFixed(2)}\n\n`;

    // Performance trajectory from recent learning history
    if (trajectoryRows.length > 0) {
      prompt += `PERFORMANCE TRAJECTORY (last ${trajectoryRows.length} nightly runs, newest first):\n`;
      for (const row of trajectoryRows) {
        const date = new Date(row.created_at).toISOString().split('T')[0];
        prompt += `${date}: ${row.total_trades} trades, ${parseFloat(row.win_rate).toFixed(1)}% WR, $${parseFloat(row.total_pnl).toFixed(2)} P&L\n`;
      }

      // Compute trajectory direction
      if (trajectoryRows.length >= 2) {
        const newest = trajectoryRows[0];
        const oldest = trajectoryRows[trajectoryRows.length - 1];
        const wrDelta = parseFloat(newest.win_rate) - parseFloat(oldest.win_rate);
        const pnlDelta = parseFloat(newest.total_pnl) - parseFloat(oldest.total_pnl);
        let direction;
        if (wrDelta < -10 || pnlDelta < -100) {
          direction = 'DECLINING';
        } else if (wrDelta > 10 || pnlDelta > 100) {
          direction = 'IMPROVING';
        } else {
          direction = 'STABLE';
        }
        prompt += `Direction: ${direction} (WR ${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}%, P&L ${pnlDelta >= 0 ? '+' : ''}$${pnlDelta.toFixed(2)} over ${trajectoryRows.length} runs)\n`;

        if (direction === 'DECLINING') {
          prompt += `\n*** PERFORMANCE IS DECLINING — PRIORITIZE CAPITAL PRESERVATION ***\n`;
          prompt += `- Generate MORE STOP/REJECT/REDUCE rules than START/ESCALATE rules\n`;
          prompt += `- Focus on what is LOSING money, not what was missed\n`;
          prompt += `- Tighten entry criteria — require stronger confirmations\n`;
          prompt += `- Do NOT increase aggressiveness when the bot is losing\n\n`;
        }
      }

      if (defensiveMode) {
        prompt += `\n╔══════════════════════════════════════════════════╗\n`;
        prompt += `║  *** DEFENSIVE MODE ACTIVE ***                   ║\n`;
        prompt += `║  Win rate: ${stats.win_rate.toFixed(1)}% | P&L: $${stats.total_pnl.toFixed(2).padEnd(10)}        ║\n`;
        prompt += `║  Capital preservation is the #1 priority.        ║\n`;
        prompt += `║                                                  ║\n`;
        prompt += `║  MANDATORY CONSTRAINTS:                          ║\n`;
        prompt += `║  - At least 60% of rules must be STOP/REJECT     ║\n`;
        prompt += `║  - NO new START/ESCALATE rules for patterns      ║\n`;
        prompt += `║    that have lost money in the last 30 days      ║\n`;
        prompt += `║  - Max escalation target: ${DEFENSIVE_MAX_ESC_TARGET}%                  ║\n`;
        prompt += `║  - Every START rule must cite specific evidence   ║\n`;
        prompt += `║    of profitability (>70% WR, positive P&L)      ║\n`;
        prompt += `╚══════════════════════════════════════════════════╝\n\n`;
      }

      prompt += '\n';
    }

  } else {
    prompt += `This is a new trading bot with no closed trades yet. Analyze the signal data below — especially missed opportunities — to generate initial rules and calibrate aggressiveness.\n\n`;
  }

  if (stats.tier_stats.length > 0) {
    prompt += `BY TIER:\n`;
    for (const t of stats.tier_stats) {
      const wr = parseInt(t.total) > 0 ? (parseInt(t.wins) / parseInt(t.total) * 100).toFixed(0) : 0;
      prompt += `T${t.tier}: ${t.total} trades, ${wr}% WR, $${parseFloat(t.pnl).toFixed(2)}\n`;
    }
    prompt += '\n';
  }

  if (stats.strength_stats.length > 0) {
    prompt += `BY HAIKU STRENGTH:\n`;
    for (const s of stats.strength_stats) {
      const wr = parseInt(s.total) > 0 ? (parseInt(s.wins) / parseInt(s.total) * 100).toFixed(0) : 0;
      prompt += `${s.strength}: ${s.total} trades, ${wr}% WR, avg ${parseFloat(s.avg_pnl_pct).toFixed(1)}%\n`;
    }
    prompt += '\n';
  }

  if (stats.signal_combo_stats.length > 0) {
    prompt += `WIN RATE BY SIGNAL COMBO:\n`;
    for (const s of stats.signal_combo_stats) {
      const wr = parseInt(s.total) > 0 ? (parseInt(s.wins) / parseInt(s.total) * 100).toFixed(0) : 0;
      prompt += `${s.signal_combo} ${s.strength}: ${s.total} trades, ${wr}% WR, avg ${parseFloat(s.avg_pnl_pct).toFixed(1)}%, total $${parseFloat(s.total_pnl).toFixed(2)}\n`;
    }
    prompt += '\n';
  }

  if (stats.confidence_stats.length > 0) {
    prompt += `BY CONFIDENCE:\n`;
    for (const c of stats.confidence_stats) {
      const wr = parseInt(c.total) > 0 ? (parseInt(c.wins) / parseInt(c.total) * 100).toFixed(0) : 0;
      prompt += `${c.conf_range}: ${c.total} trades, ${wr}% WR, avg ${parseFloat(c.avg_pnl_pct).toFixed(1)}%\n`;
    }
    prompt += '\n';
  }

  if (stats.pattern_stats.length > 0) {
    prompt += `INDICATOR PATTERNS:\n`;
    for (const p of stats.pattern_stats) {
      const wr = parseInt(p.total) > 0 ? (parseInt(p.wins) / parseInt(p.total) * 100).toFixed(0) : 0;
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      prompt += `${triggers} (${p.trend}): ${p.total} trades, ${wr}% WR, avg ${parseFloat(p.avg_pnl_pct).toFixed(1)}%\n`;
    }
    prompt += '\n';
  }

  if (stats.dca_stats.length > 0) {
    prompt += `DCA EFFECTIVENESS:\n`;
    for (const d of stats.dca_stats) {
      const wr = parseInt(d.total) > 0 ? (parseInt(d.wins) / parseInt(d.total) * 100).toFixed(0) : 0;
      prompt += `${d.dca_type}: ${d.total} trades, ${wr}% WR, avg ${parseFloat(d.avg_pnl_pct).toFixed(1)}%\n`;
    }
    prompt += '\n';
  }

  // Losing trade patterns — counterbalance to missed opportunities
  if (stats.losing_patterns.length > 0) {
    prompt += `LOSING TRADE PATTERNS (these setups consistently lost money — treat with EQUAL weight to missed opportunities):\n`;
    for (const p of stats.losing_patterns) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      prompt += `${triggers} (${p.trend}) ${p.strength}: ${p.total} trades, ${p.losses} losses, avg loss $${parseFloat(p.avg_loss_usd).toFixed(2)} (${parseFloat(p.avg_loss_pct).toFixed(1)}%)\n`;
    }
    prompt += '\n';
  }

  // Exit timing data
  if (stats.exit_timing.length > 0) {
    prompt += `EXIT TIMING ANALYSIS:\n`;
    for (const e of stats.exit_timing) {
      prompt += `${e.exit_category}: ${e.cnt} trades, avg P&L ${parseFloat(e.avg_pnl_pct).toFixed(1)}%, avg max gain ${parseFloat(e.avg_max_gain_pct || 0).toFixed(1)}%, avg hold ${parseFloat(e.avg_hold_hours).toFixed(1)}h\n`;
    }
    prompt += '\n';
  }

  // Current rules
  const rulesResult = await query('SELECT rule_text, win_rate, sample_size FROM learning_rules WHERE is_active = true');
  if (rulesResult.rows.length > 0) {
    prompt += `CURRENT RULES:\n`;
    for (const r of rulesResult.rows) {
      prompt += `- ${r.rule_text}`;
      if (r.win_rate) prompt += ` (${r.win_rate}% WR, ${r.sample_size} trades)`;
      prompt += '\n';
    }
    prompt += '\n';
  }

  // Changelog context — prevents oscillation and gives Opus historical awareness
  const changelogContext = await fetchChangelogContext();
  if (changelogContext) {
    prompt += `═══ RULE CHANGE HISTORY — READ BEFORE GENERATING NEW RULES ═══\n\n`;

    if (changelogContext.oscillating.length > 0) {
      prompt += `*** OSCILLATING RULES (BLOCKED — do NOT re-add these) ***\n`;
      prompt += `These rules have been added and removed ${CHANGELOG_OSCILLATION_THRESHOLD}+ times in ${CHANGELOG_OSCILLATION_WINDOW_DAYS} days. They are automatically blocked. Do NOT generate rules with the same intent.\n`;
      for (const osc of changelogContext.oscillating) {
        const types = osc.change_types.slice(0, 4).join('→');
        prompt += `- [${osc.rule_type}] "${osc.rule_text}" (${osc.change_count} changes: ${types})\n`;
        if (osc.reasons[0]) prompt += `  Last reason: ${osc.reasons[0]}\n`;
      }
      prompt += '\n';
    }

    if (changelogContext.deactivations.length > 0) {
      prompt += `RECENTLY REMOVED RULES (last ${CHANGELOG_CONTEXT_WINDOW_DAYS} days) — learn from these:\n`;
      for (const d of changelogContext.deactivations) {
        const date = new Date(d.created_at).toISOString().split('T')[0];
        prompt += `- [${date}] [${d.rule_type}] REMOVED: "${d.rule_text.substring(0, 100)}"\n`;
        prompt += `  Reason: ${d.reason}\n`;
      }
      prompt += '\n';
    }

    if (changelogContext.recent.length > 0) {
      prompt += `RECENT RULE CHANGES (${changelogContext.recent.length} changes in last ${CHANGELOG_CONTEXT_WINDOW_DAYS} days):\n`;
      for (const c of changelogContext.recent.slice(0, 20)) {
        const date = new Date(c.created_at).toISOString().split('T')[0];
        prompt += `- [${date}] ${c.change_type} [${c.rule_type}]: "${c.rule_text.substring(0, 80)}"\n`;
      }
      prompt += '\n';
    }

    prompt += `INSTRUCTIONS: Do NOT re-create rules that were recently deactivated unless you have NEW evidence (new trades, changed win rates) that justifies them. Reference specific data points when re-proposing any previously-removed rule.\n\n`;
  }

  // Missed opportunities — consolidated into one section with type markers
  // Cap displayed gains at 20% to avoid unrealistic peak-price inflation (S5/S8)
  const MISSED_OPP_DISPLAY_CAP = 20;
  const capGain = (pct) => Math.min(parseFloat(pct), MISSED_OPP_DISPLAY_CAP).toFixed(1);
  const allMissed = [];
  const missedNonEscalated = stats.missed_opportunities.filter(m => parseFloat(m.potential_gain_pct) > MISSED_OPP_THRESHOLD);
  for (const m of missedNonEscalated.slice(0, 5)) {
    allMissed.push(`[NOT_ESC] ${m.symbol} ${m.strength} conf:${m.confidence} +${capGain(m.potential_gain_pct)}%`);
  }
  for (const m of stats.missed_pass_decisions.slice(0, 5)) {
    allMissed.push(`[SONNET_PASS] ${m.symbol} Haiku:${m.haiku_strength} conf:${m.haiku_conf} +${capGain(m.potential_gain_pct)}%`);
  }
  const missedSellNonEscalated = stats.missed_sell_opportunities.filter(m => parseFloat(m.potential_drop_pct) > MISSED_OPP_THRESHOLD);
  for (const m of missedSellNonEscalated.slice(0, 3)) {
    allMissed.push(`[SELL_NOT_ESC] ${m.symbol} ${m.strength} -${capGain(m.potential_drop_pct)}%`);
  }
  for (const m of stats.missed_sell_pass_decisions.slice(0, 3)) {
    allMissed.push(`[SELL_PASS] ${m.symbol} Haiku:${m.haiku_strength} -${capGain(m.potential_drop_pct)}%`);
  }
  if (allMissed.length > 0) {
    prompt += `MISSED OPPORTUNITIES (price moved >${MISSED_OPP_THRESHOLD}% within ${PASS_EVAL_WINDOW_HOURS}h):\n`;
    for (const line of allMissed) {
      prompt += `${line}\n`;
    }
    prompt += '\n';
  }

  // ── BILATERAL ACCURACY FRAMING ──
  // Show Sonnet's own accuracy prominently so the model sees both sides
  const correctPass = parseInt(stats.pass_outcome_summary.correct_pass) || 0;
  const missedOpp = parseInt(stats.pass_outcome_summary.missed_opportunity) || 0;
  const totalPassDecisions = correctPass + missedOpp;
  const sonnetPassAccuracy = totalPassDecisions > 0 ? (correctPass / totalPassDecisions * 100).toFixed(1) : 'N/A';

  prompt += `═══ BILATERAL ACCURACY — BOTH MODELS CAN BE WRONG ═══\n\n`;

  prompt += `SONNET'S OWN ACCURACY:\n`;
  prompt += `- Of ${totalPassDecisions} evaluated PASS decisions: ${correctPass} CORRECT_PASS, ${missedOpp} MISSED_OPPORTUNITY\n`;
  prompt += `- Sonnet PASS accuracy: ${sonnetPassAccuracy}%\n`;
  prompt += `- MISSED_OPPORTUNITY means SONNET was wrong to pass, NOT that Haiku was wrong to escalate\n\n`;

  // Prediction accuracy (predictive analysis system)
  if (predictionAccuracyStats.length > 0) {
    prompt += `PREDICTION ACCURACY (leading indicator divergences):\n`;
    for (const row of predictionAccuracyStats) {
      prompt += `${row.symbol} ${row.divergence_type}: ${row.total} predictions, ${row.hits} hits (${row.accuracy_pct || 0}% accuracy), avg correct move: ${parseFloat(row.avg_correct_move || 0).toFixed(2)}%\n`;
    }
    prompt += `\nUse this data to assess whether the predictive system is working for specific symbols/divergence types. If accuracy is consistently below 40% for a symbol, the system will auto-raise the confidence threshold.\n\n`;
  }

  // Haiku escalation accuracy
  if (stats.escalation_accuracy.length > 0) {
    const totalEsc = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.total_escalated), 0);
    const totalTraded = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.led_to_trade), 0);
    const totalPassed = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.passed), 0);
    prompt += `HAIKU ESCALATION ACCURACY (${totalEsc} escalated → ${totalTraded} traded, ${totalPassed} PASSed):\n`;
    for (const r of stats.escalation_accuracy) {
      const convRate = parseInt(r.total_escalated) > 0 ? (parseInt(r.led_to_trade) / parseInt(r.total_escalated) * 100).toFixed(0) : 0;
      prompt += `${r.strength}: ${r.total_escalated} escalated, ${convRate}% converted to trade, ${r.passed} PASSed\n`;
    }
    prompt += '\n';
  }

  // Flag inverted strength conversion if present
  const strongData = stats.escalation_accuracy.find(r => r.strength === 'STRONG');
  const moderateData = stats.escalation_accuracy.find(r => r.strength === 'MODERATE');
  if (strongData && moderateData) {
    const strongConv = parseInt(strongData.total_escalated) > 0 ? parseInt(strongData.led_to_trade) / parseInt(strongData.total_escalated) * 100 : 0;
    const modConv = parseInt(moderateData.total_escalated) > 0 ? parseInt(moderateData.led_to_trade) / parseInt(moderateData.total_escalated) * 100 : 0;
    if (strongConv < modConv) {
      prompt += `\n*** STRENGTH INVERSION DETECTED ***\n`;
      prompt += `STRONG signals convert at ${strongConv.toFixed(0)}% but MODERATE converts at ${modConv.toFixed(0)}%.\n`;
      prompt += `This means STRONG is MISCALIBRATED — too many weak signals labeled STRONG.\n`;
      prompt += `PRIORITY: Tighten STRONG criteria in haiku_rules. Require 4+ aligned indicators for STRONG (not 3+).\n`;
      prompt += `STRONG should mean: high volume (>3x) + RSI confirmation + MACD alignment + trend support + ADX >25.\n\n`;
    }
  }

  prompt += `HOW TO INTERPRET:\n`;
  prompt += `- Haiku over-escalates → Sonnet correctly passes → reduce Haiku escalation for that pattern\n`;
  prompt += `- Haiku escalates → Sonnet wrongly passes (MISSED_OPPORTUNITY) → Sonnet was wrong, NOT Haiku\n`;
  prompt += `- Haiku doesn't escalate → price moves favorably → Haiku was too conservative\n`;
  prompt += `- A healthy system has ${ESC_CONV_TARGET_MIN}-${ESC_CONV_TARGET_MAX}% escalation conversion rate. 100% conversion = too conservative.\n\n`;

  // Patterns Sonnet consistently passes on
  if (stats.pass_patterns.length > 0) {
    prompt += `PATTERNS SONNET CONSISTENTLY PASSES (>=70% PASS rate, min 10 samples):\n`;
    for (const p of stats.pass_patterns) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      prompt += `${triggers} (${p.trend}) ${p.strength}: ${p.total} escalated, ${p.correct_pass_rate}% PASSed\n`;
    }
    prompt += '\n';
  }

  // Sonnet's MISSED_OPPORTUNITY decisions — framed as SONNET ERRORS
  if (stats.missed_pass_decisions.length > 0) {
    prompt += `SONNET BUY ERRORS (wrong to pass — price rose >${MISSED_OPP_THRESHOLD}% sustained):\n`;
    for (const m of stats.missed_pass_decisions.slice(0, 5)) {
      prompt += `${m.symbol} Haiku:${m.haiku_strength} conf:${m.haiku_conf} → passed → +${Math.min(parseFloat(m.potential_gain_pct), 20).toFixed(1)}% | ${(m.reasoning || '').substring(0, 60)}\n`;
    }
    prompt += '\n';
  }

  // Sonnet's MISSED SELL decisions
  if (stats.missed_sell_pass_decisions.length > 0) {
    prompt += `SONNET SELL ERRORS (wrong to pass — price dropped >${MISSED_OPP_THRESHOLD}% sustained):\n`;
    for (const m of stats.missed_sell_pass_decisions.slice(0, 5)) {
      prompt += `${m.symbol} Haiku:${m.haiku_strength} conf:${m.haiku_conf} → passed → -${Math.min(parseFloat(m.potential_drop_pct), 20).toFixed(1)}% | ${(m.reasoning || '').substring(0, 60)}\n`;
    }
    prompt += '\n';
  }

  // Patterns Haiku missed
  if (stats.missed_escalation_patterns.length > 0) {
    prompt += `PATTERNS HAIKU MISSED (not escalated but moved favorably):\n`;
    for (const p of stats.missed_escalation_patterns) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      prompt += `${triggers} (${p.trend}) ${p.strength}: ${p.total} missed, avg +${parseFloat(p.avg_gain_pct).toFixed(1)}% gain — Haiku should START escalating this\n`;
    }
    prompt += '\n';
  }

  // Sonnet PASS reasoning themes
  if (stats.pass_reasoning_themes.length > 0) {
    prompt += `SONNET PASS REASONING THEMES (why Sonnet rejects signals):\n`;
    const totalThemeCnt = stats.pass_reasoning_themes.reduce((sum, t) => sum + parseInt(t.cnt), 0);
    for (const t of stats.pass_reasoning_themes) {
      const pct = totalThemeCnt > 0 ? (parseInt(t.cnt) / totalThemeCnt * 100).toFixed(0) : 0;
      prompt += `${t.rejection_theme}: ${t.cnt} times (${pct}%)\n`;
    }
    // Warn when "Insufficient volume" dominates PASS reasons
    const volumeTheme = stats.pass_reasoning_themes.find(t =>
      t.rejection_theme && t.rejection_theme.toLowerCase().includes('volume')
    );
    if (volumeTheme && totalThemeCnt > 0) {
      const volumePct = parseInt(volumeTheme.cnt) / totalThemeCnt * 100;
      if (volumePct > 50) {
        prompt += `\n*** WARNING: "${volumeTheme.rejection_theme}" accounts for ${volumePct.toFixed(0)}% of all PASS rejections. ***\n`;
        prompt += `Sonnet is likely over-filtering on volume. Haiku already applies a 2x volume floor.\n`;
        prompt += `Generate a sonnet_rule to STOP citing insufficient volume when volume >2.5x AND 2+ confirmations present.\n\n`;
      }
    }
    prompt += '\n';
  }

  prompt += `Generate JSON with: haiku_rules (string array — what to escalate/skip), sonnet_rules (string array — what to prioritize), exit_rules (string array — exit timing rules for the exit evaluator), haiku_few_shots (array of {description, input, output, outcome}), sonnet_few_shots (array of {description, signal, decision, outcome}), haiku_escalation_calibration (string array of pattern-level rules like "STOP escalating X" / "START escalating Y"), rule_changes (what changed and why). All rules must be plain strings, not objects.\n\n`;

  // ── RULE QUALITY SPEC ──
  // These constraints prevent common failure modes in rule generation.
  prompt += `═══ RULE QUALITY REQUIREMENTS — EVERY RULE MUST FOLLOW THESE ═══\n\n`;

  prompt += `VALID RULE VERBS:\n`;
  prompt += `- haiku_rules: ESCALATE, REJECT, REDUCE, START, STOP (these are the ONLY valid prefixes)\n`;
  prompt += `- sonnet_rules: APPROVE, REJECT, START, STOP (these are the ONLY valid prefixes)\n`;
  prompt += `- exit_rules: EXIT, HOLD, PARTIAL_EXIT, TRAIL (these are the ONLY valid prefixes)\n`;
  prompt += `- NEVER use: MONITOR, PRIORITIZE, CONSIDER, NOTE, CRITICAL, SKIP, or narrative commentary as a rule\n`;
  prompt += `- Every rule must be an actionable instruction the AI can follow when evaluating a single signal/position\n\n`;

  prompt += `AVAILABLE DATA PER MODEL (rules MUST only reference data the model can see):\n`;
  prompt += `- Haiku receives a 5-line compact format per signal:\n`;
  prompt += `  Line 1: symbol, price, trend direction + strength\n`;
  prompt += `  Line 2: RSI value + signal, MACD crossover, volume ratio + trend\n`;
  prompt += `  Line 3: price vs SMA200, golden-cross/death-cross, EMA signal, BB position + width, ADX value + signal\n`;
  prompt += `  Line 3b: StochRSI K/D + signal, ATR percent\n`;
  prompt += `  Line 3c: OBV (On-Balance Volume): trend direction (RISING/FALLING/FLAT) — confirms whether volume flow supports price direction\n`;
  prompt += `  Line 4: nearest support levels, nearest resistance levels\n`;
  prompt += `  Plus: tier, thresholds crossed, and existing position (entry price, P&L%, hold time, size)\n`;
  prompt += `- Haiku does NOT have: candlestick patterns (engulfing/hammer/doji), multi-timeframe data (4h/1d), candle counts, historical price changes (e.g. "up 8% in 4h"), divergence detection, consolidation duration, or higher-lows analysis\n`;
  prompt += `- Sonnet receives: Haiku's assessment + same technical data + news context + portfolio state\n`;
  prompt += `- Exit evaluator receives: position details + current technicals + urgency score\n`;
  prompt += `- NEVER generate a haiku_rule referencing data Haiku cannot see. Instead, use the indicators Haiku HAS: RSI value, MACD direction, volume ratio, EMA/SMA signals, BB position, support/resistance levels, trend direction, tier, confidence\n\n`;

  prompt += `STATISTICAL SIGNIFICANCE:\n`;
  prompt += `- With <10 trades, rules should be TENTATIVE — prefix with "TENTATIVE:" and keep thresholds moderate\n`;
  prompt += `- With <5 trades, do NOT generate aggressive REJECT or hard-stop rules — the data is noise, not signal\n`;
  prompt += `- Never treat a 0% or 100% WR from <5 trades as meaningful — it WILL regress to the mean\n`;
  prompt += `- Weight rules by sample size: a pattern with 20 trades at 65% WR is far more reliable than 2 trades at 0% WR\n\n`;

  prompt += `VOLUME THRESHOLD AWARENESS:\n`;
  prompt += `- Haiku already filters signals before they reach Sonnet. Do NOT stack volume thresholds across layers.\n`;
  prompt += `- Haiku volume floor: 2x. If haiku_rules require >3x, sonnet_rules should NOT add another >4x filter on top.\n`;
  prompt += `- Reasonable volume thresholds: 2-3x for standard signals, 4-5x for high-conviction, 6x+ only for breakout plays.\n`;
  prompt += `- If "Insufficient volume" is the dominant PASS theme, thresholds may already be too high — consider lowering, not raising.\n\n`;

  prompt += `EXIT RULE CONSTRAINTS:\n`;
  prompt += `- The exit evaluator's base prompt says "no rigid stop losses — exit when thesis changes, not on arbitrary percentages"\n`;
  prompt += `- T1 blue chips can tolerate 15-20% drawdowns if thesis intact. T2 tolerates 10-15%.\n`;
  prompt += `- Do NOT generate hard percentage stops that contradict this (e.g., "exit at -3% no exceptions" is invalid)\n`;
  prompt += `- Trailing stops must be wide enough for crypto volatility: minimum 3% for T2, 5% for T1\n`;
  prompt += `- Time-based stops should be >8h minimum — crypto trends need time to develop\n\n`;

  prompt += `RULE DISTINCTNESS:\n`;
  prompt += `- Each rule must cover a DIFFERENT scenario. Do not generate 3 variations of "golden cross + volume + MACD"\n`;
  prompt += `- If two rules would fire on the same signal, merge them into one\n`;
  prompt += `- Balance the ruleset: mix of entry patterns, rejection filters, and edge cases\n\n`;

  prompt += `CONTRADICTION AVOIDANCE:\n`;
  prompt += `- REJECT/STOP rules MUST target a specific signal pattern (e.g., "REJECT VOLUME_SPIKE STRONG with RSI >70 — 3/3 losses")\n`;
  prompt += `- NEVER generate generic theme-level rejections (e.g., "REJECT signals with insufficient volume", "REDUCE signals citing volume")\n`;
  prompt += `- Generic rejections contradict specific ESCALATE rules and are automatically removed by the validator\n`;
  prompt += `- Each REJECT rule must cite: the specific pattern, sample count, and loss rate from the data above\n`;
  prompt += `- If you want to restrict a broad category, use multiple specific rules instead of one blanket rule\n`;
  prompt += `- When a pattern is mostly unprofitable but has a profitable sub-pattern (e.g., VOLUME_SPIKE STRONG is 3/3 losers overall but T1+RSI40-52+vol>5x is 63% WR), use ONE consolidated rule with the exception built in, not separate REJECT + START rules\n\n`;

  if (defensiveMode) {
    prompt += `CONSTRAINTS: Max 15 haiku_rules (combined). >=60% MUST be STOP/REJECT/REDUCE (DEFENSIVE MODE). STOP/REJECT rules MUST target BUY/DCA patterns only — NEVER generate STOP/REJECT rules for SELL signals (SELL is always exempt). Max escalation target: ${DEFENSIVE_MAX_ESC_TARGET}%. No STOP rules with <5 samples. LOSING TRADE PATTERNS are the #1 priority — generate REJECT/REDUCE rules for every losing pattern. START rules allowed ONLY for patterns with >70% WR and positive P&L. Include SELL-side ESCALATE rules. No duplicate rules.\n\n`;
    prompt += `Focus on: CAPITAL PRESERVATION. What is losing money? What patterns should be stopped? Which losing trades should never have been taken? Only promote patterns with strong evidence of profitability (>70% WR, positive P&L, 5+ samples). Do NOT generate rules to trade more.`;
  } else {
    prompt += `CONSTRAINTS: Max 15 haiku_rules (combined). >=40% must be ESCALATE/START. Target ${ESC_CONV_TARGET_MIN}-${ESC_CONV_TARGET_MAX}% escalation conversion. No STOP rules with <5 samples. MISSED_OPPORTUNITY = Sonnet error, not Haiku. No blanket rejections — only STOP patterns with confirmed CORRECT_PASS (price didn't move). Include SELL-side rules. No duplicate rules. LOSING TRADE PATTERNS must generate REJECT/REDUCE rules — do not only focus on missed opportunities.\n\n`;

    if (hasTrades) {
      prompt += `Focus on: >70% WR patterns (promote), <40% WR patterns (warn), missed opportunities (both non-escalated and Sonnet PASS), optimal hold times, DCA effectiveness.`;
    } else {
      prompt += `Focus on: missed opportunities (what should have been escalated or bought), signal quality (which triggers produce real moves), and calibrating Haiku escalation thresholds and Sonnet confidence. The bot may be too conservative — analyze whether passes were justified.`;
    }
  }

  const LEARNING_TIMEOUT_MS = 300000; // 5 min timeout for Opus learning analysis
  const MAX_RETRIES = 2;

  try {
    let message;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        let timer;
        const cleanup = () => clearTimeout(timer);
        message = await Promise.race([
          anthropic.messages.create({
            model: OPUS_MODEL,
            max_tokens: 8192,
            system: [{ type: 'text', text: 'You are a conservative trading performance analyst for a utility-focused crypto bot. Quality over quantity — never bias toward more trading. Losing trades matter as much as missed opportunities. Respond with valid JSON only. Be concise — short rule strings, no lengthy explanations.', cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: prompt }],
          }).then(r => { cleanup(); return r; }, err => { cleanup(); throw err; }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Opus learning timed out after ${LEARNING_TIMEOUT_MS}ms`)), LEARNING_TIMEOUT_MS); }),
        ]);
        break; // Success
      } catch (retryErr) {
        const isRetryable = retryErr.message?.includes('timed out') || retryErr.status === 429 || (retryErr.status >= 500 && retryErr.status < 600);
        if (!isRetryable || attempt === MAX_RETRIES) throw retryErr;
        const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        logger.warn(`[Learning] Opus attempt ${attempt} failed (${retryErr.message}), retrying in ${(delay/1000).toFixed(1)}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    const text = message.content?.[0]?.text;
    if (!text) {
      logger.error('[Learning] Empty Opus response for analysis');
      return { _parseFailure: true, haiku_rules: [], sonnet_rules: [], haiku_escalation_calibration: [], exit_rules: [] };
    }
    logger.info(`[Learning] Opus analysis: ${message.usage.input_tokens}in/${message.usage.output_tokens}out tokens, stop_reason: ${message.stop_reason}`);

    if (message.stop_reason === 'max_tokens') {
      logger.error(`[Learning] Opus response truncated at max_tokens (${message.usage.output_tokens} tokens) — rules were LOST. Retrying with doubled max_tokens...`);

      // Retry once with doubled max_tokens
      try {
        let retryTimer;
        const retryCleanup = () => clearTimeout(retryTimer);
        const retryMessage = await Promise.race([
          anthropic.messages.create({
            model: OPUS_MODEL,
            max_tokens: 16384,
            system: [{ type: 'text', text: 'You are a conservative trading performance analyst for a utility-focused crypto bot. Quality over quantity — never bias toward more trading. Losing trades matter as much as missed opportunities. Respond with valid JSON only. Be concise — short rule strings, no lengthy explanations.', cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: prompt }],
          }).then(r => { retryCleanup(); return r; }, err => { retryCleanup(); throw err; }),
          new Promise((_, reject) => { retryTimer = setTimeout(() => reject(new Error('Opus retry timed out')), LEARNING_TIMEOUT_MS); }),
        ]);
        logger.info(`[Learning] Opus retry: ${retryMessage.usage.input_tokens}in/${retryMessage.usage.output_tokens}out tokens, stop_reason: ${retryMessage.stop_reason}`);
        if (retryMessage.stop_reason === 'end_turn' && retryMessage.content?.[0]?.text) {
          message = retryMessage; // Use the successful retry
        } else {
          logger.error(`[Learning] Opus retry still truncated (stop_reason: ${retryMessage.stop_reason}) — giving up`);
          return {
            haiku_rules: [],
            sonnet_rules: [],
            haiku_escalation_calibration: [],
            exit_rules: [],
            haiku_few_shots: [],
            sonnet_few_shots: [],
            rule_changes: 'Truncated at max_tokens even after retry — no changes this cycle',
            _parseFailure: true,
          };
        }
      } catch (retryErr) {
        logger.error(`[Learning] Opus retry failed: ${retryErr.message} — skipping parse`);
        return {
          haiku_rules: [],
          sonnet_rules: [],
          haiku_escalation_calibration: [],
          exit_rules: [],
          haiku_few_shots: [],
          sonnet_few_shots: [],
          rule_changes: 'Truncated at max_tokens, retry failed — no changes this cycle',
          _parseFailure: true,
        };
      }
    }

    let parsed;
    try {
      parsed = extractJSON(text);
    } catch (parseError) {
      logger.error(`[Learning] Failed to parse Opus response: ${parseError.message}`);
      logger.warn(`[Learning] Returning empty analysis — prompts will not be updated this cycle`);
      return {
        haiku_rules: [],
        sonnet_rules: [],
        haiku_escalation_calibration: [],
        exit_rules: [],
        haiku_few_shots: [],
        sonnet_few_shots: [],
        rule_changes: 'Parse failure — no changes this cycle',
        _parseFailure: true,
      };
    }
    return parsed;
  } catch (error) {
    logger.error(`[Learning] Opus call failed: ${error.message}`);
    throw error;
  }
}

// ── Rule Validator ──────────────────────────────────────────

function validateAnalysis(analysis, defensiveMode = false) {
  const issues = [];

  // ── Defensive mode pre-filter: remove APPROVE/START/ESCALATE rules before contradiction detection ──
  if (defensiveMode) {
    const preFilterSonnet = (rules) => {
      const arr = toArray(rules);
      const beforeCount = arr.length;
      const filtered = arr.filter(r => {
        const text = (typeof r === 'string' ? r : '').toUpperCase();
        return !(text.startsWith('APPROVE') || text.startsWith('START') || text.startsWith('ESCALATE'));
      });
      const removed = beforeCount - filtered.length;
      if (removed > 0) {
        logger.info(`[Learning] Defensive mode: pre-filtered ${removed} APPROVE/START rules (expected behavior)`);
      }
      return filtered;
    };
    analysis.sonnet_rules = preFilterSonnet(analysis.sonnet_rules);
  }

  // ── Filter non-actionable rules ──
  // Rules must start with a valid verb. Anything else is commentary, not a rule.
  const VALID_HAIKU_VERBS = /^(ESCALATE|REJECT|REDUCE|START|STOP|TENTATIVE)/i;
  const VALID_SONNET_VERBS = /^(APPROVE|REJECT|START|STOP|TENTATIVE)/i;
  const VALID_EXIT_VERBS = /^(EXIT|HOLD|PARTIAL_EXIT|TRAIL|TENTATIVE)/i;

  const filterInvalidVerbs = (rules, validPattern, label) => {
    return rules.filter(r => {
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      if (!validPattern.test(text.trim())) {
        issues.push(`Removed non-actionable ${label} rule (invalid verb): "${text.substring(0, 60)}"`);
        return false;
      }
      return true;
    });
  };

  analysis.haiku_rules = filterInvalidVerbs(toArray(analysis.haiku_rules), VALID_HAIKU_VERBS, 'haiku');
  analysis.haiku_escalation_calibration = filterInvalidVerbs(toArray(analysis.haiku_escalation_calibration), VALID_HAIKU_VERBS, 'haiku_calibration');
  analysis.sonnet_rules = filterInvalidVerbs(toArray(analysis.sonnet_rules), VALID_SONNET_VERBS, 'sonnet');
  analysis.exit_rules = filterInvalidVerbs(toArray(analysis.exit_rules || []), VALID_EXIT_VERBS, 'exit');

  // ── Enforce volume threshold ceiling from config ──
  const volumeCeiling = config.escalation?.volume_threshold_ceiling || 5.0;
  const enforceVolumeCeiling = (rules, label) => {
    return rules.map(r => {
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      // Cap ALL volume thresholds like ">6x", ">7x", "volume >8x" etc.
      const capped = text.replace(/volume\s*[>≥]\s*(\d+(?:\.\d+)?)\s*x/gi, (match, threshold) => {
        if (parseFloat(threshold) > volumeCeiling) {
          issues.push(`Capped ${label} volume threshold from ${threshold}x to ${volumeCeiling}x (ceiling)`);
          return match.replace(threshold, String(volumeCeiling));
        }
        return match;
      });
      return capped !== text ? capped : r;
    });
  };
  analysis.haiku_rules = enforceVolumeCeiling(toArray(analysis.haiku_rules), 'haiku');
  analysis.haiku_escalation_calibration = enforceVolumeCeiling(toArray(analysis.haiku_escalation_calibration), 'haiku_calibration');
  analysis.sonnet_rules = enforceVolumeCeiling(toArray(analysis.sonnet_rules), 'sonnet');

  // ── Convert blanket DCA rejection rules to conditional (S10) ──
  // Blanket "REJECT DCA" conflicts with Sonnet's conditional DCA rule. Convert to conditional.
  const convertBlanketDca = (rules) => {
    return rules.map(r => {
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      // Match blanket DCA rejections that don't already have T1/conditional language
      if (/^REJECT\b.*\bDCA\b/i.test(text) && !/\bT1\b/i.test(text) && !/\bunless\b/i.test(text)) {
        const replacement = text.replace(/^REJECT\b/i, 'REJECT') + ' unless T1 AND price >5% below entry — escalate only the best DCA candidates for Sonnet';
        issues.push(`Converted blanket DCA rejection to conditional: "${text.substring(0, 50)}" → added T1 exception`);
        return replacement;
      }
      return r;
    });
  };
  analysis.haiku_rules = convertBlanketDca(toArray(analysis.haiku_rules));
  analysis.haiku_escalation_calibration = convertBlanketDca(toArray(analysis.haiku_escalation_calibration));

  // Remove STOP rules that reference <5 samples
  const filterLowSampleRules = (rules) => {
    return rules.filter(r => {
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      const upper = text.toUpperCase();
      if (!upper.startsWith('STOP') && !upper.startsWith('SKIP') && !upper.startsWith('REJECT')) return true;
      // Try to extract sample count from rule text
      const sampleMatch = text.match(/(\d+)\s*(trade|sample|evaluated|case)/i) || text.match(/(\d+)\/\d+\s*(trade|DCA|signal)/i);
      if (sampleMatch && parseInt(sampleMatch[1]) < 5) {
        issues.push(`Removed low-sample STOP rule: "${text.substring(0, 60)}..." (${sampleMatch[1]} samples)`);
        return false;
      }
      return true;
    });
  };

  analysis.haiku_rules = filterLowSampleRules(toArray(analysis.haiku_rules));
  analysis.haiku_escalation_calibration = filterLowSampleRules(toArray(analysis.haiku_escalation_calibration));
  analysis.sonnet_rules = filterLowSampleRules(toArray(analysis.sonnet_rules));
  analysis.exit_rules = filterLowSampleRules(toArray(analysis.exit_rules || []));

  // Check ESCALATE/START ratio — threshold depends on defensive mode
  // Compute allHaikuRules AFTER all mutations (filterInvalidVerbs, enforceVolumeCeiling, convertBlanketDca, filterLowSampleRules)
  const allHaikuRules = [...toArray(analysis.haiku_rules), ...toArray(analysis.haiku_escalation_calibration)];
  const minEscalateRatio = defensiveMode ? DEFENSIVE_MIN_ESCALATE_RATIO : 0.4;
  if (allHaikuRules.length > 0) {
    const escalateCount = allHaikuRules.filter(r => {
      const text = (typeof r === 'string' ? r : JSON.stringify(r)).toUpperCase();
      return text.startsWith('ESCALATE') || text.startsWith('START') || text.includes('START ESCALATING');
    }).length;
    const escalateRatio = escalateCount / allHaikuRules.length;
    if (escalateRatio < minEscalateRatio) {
      issues.push(`Only ${(escalateRatio * 100).toFixed(0)}% of haiku rules are ESCALATE/START (need >=${(minEscalateRatio * 100).toFixed(0)}%).${defensiveMode ? ' (Defensive mode — lower threshold OK)' : ' Adding balance.'}`);
      // Don't remove rules, just log the imbalance — the escalation guardrail handles correction
    }
    if (defensiveMode && escalateRatio > 0.4) {
      issues.push(`WARNING: Defensive mode active but ${(escalateRatio * 100).toFixed(0)}% of rules are ESCALATE/START (>40%) — too aggressive for a losing streak. Consider reducing START rules.`);
    }
  }

  // Detect contradictory rule pairs
  const allRulesFlat = [
    ...toArray(analysis.haiku_rules).map(r => ({ source: 'haiku_rules', text: typeof r === 'string' ? r : JSON.stringify(r), original: r })),
    ...toArray(analysis.sonnet_rules).map(r => ({ source: 'sonnet_rules', text: typeof r === 'string' ? r : JSON.stringify(r), original: r })),
    ...toArray(analysis.haiku_escalation_calibration).map(r => ({ source: 'haiku_escalation_calibration', text: typeof r === 'string' ? r : JSON.stringify(r), original: r })),
  ];

  // Find APPROVE + REDUCE/REJECT pairs for same pattern
  const approveRules = allRulesFlat.filter(r => /^(APPROVE|ESCALATE|START)/i.test(r.text));
  const rejectRules = allRulesFlat.filter(r => /^(REJECT|REDUCE|STOP|SKIP)/i.test(r.text));

  // Specific indicator keywords that suggest two rules target the same pattern.
  // Generic strength terms (STRONG/MODERATE/WEAK) are excluded — they appear in
  // nearly every rule and don't indicate a true contradiction.
  const SPECIFIC_KEYWORDS = /\b(T[12]|RSI|MACD|BB|VOLUME|EMA|SMA200|GOLDEN.CROSS|DEATH.CROSS|SUPPORT|RESISTANCE|ADX|STOCHRSI|ATR)\b/gi;

  for (const approve of approveRules) {
    for (const reject of rejectRules) {
      // Extract only specific indicator keywords (not generic strength terms)
      const approveKeywords = [...new Set((approve.text.toUpperCase().match(SPECIFIC_KEYWORDS) || []).map(k => k.replace(/[.-]/g, '_')))];
      const rejectKeywords = [...new Set((reject.text.toUpperCase().match(SPECIFIC_KEYWORDS) || []).map(k => k.replace(/[.-]/g, '_')))];

      if (approveKeywords.length >= 2 && rejectKeywords.length >= 2) {
        const overlap = approveKeywords.filter(k => rejectKeywords.includes(k));
        // Require 4+ specific indicator overlaps AND matching tier/strength for a true contradiction.
        // Without tier/strength matching, rules targeting different contexts are falsely flagged.
        const approveUpper = approve.text.toUpperCase();
        const rejectUpper = reject.text.toUpperCase();
        const sameTier = (approveUpper.includes('T1') && rejectUpper.includes('T1')) ||
                         (approveUpper.includes('T2') && rejectUpper.includes('T2')) ||
                         (!approveUpper.match(/\bT[12]\b/) && !rejectUpper.match(/\bT[12]\b/));
        const sameStrength = ['STRONG', 'MODERATE', 'WEAK'].some(s =>
          approveUpper.includes(s) && rejectUpper.includes(s));
        if (overlap.length >= 4 && sameTier && sameStrength) {
          if (defensiveMode) {
            // Defensive mode: preserve REJECT, remove APPROVE — bias toward capital preservation
            issues.push(`Contradictory rules detected (DEFENSIVE): "${approve.text.substring(0, 50)}" vs "${reject.text.substring(0, 50)}" — removing APPROVE rule`);
            analysis[approve.source] = toArray(analysis[approve.source]).filter(r => r !== approve.original);
          } else {
            // Normal mode: remove REJECT (bias toward trading given the original problem was over-rejection)
            issues.push(`Contradictory rules detected: "${approve.text.substring(0, 50)}" vs "${reject.text.substring(0, 50)}" — removing REJECT rule`);
            analysis[reject.source] = toArray(analysis[reject.source]).filter(r => r !== reject.original);
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    logger.warn(`[Learning] Rule validation issues (${issues.length}):`);
    for (const issue of issues) {
      logger.warn(`[Learning]   - ${issue}`);
    }
  } else {
    logger.info('[Learning] Rule validation passed — no issues');
  }
}

// ── Prompt File Updater ─────────────────────────────────────

async function updatePromptFiles(stats, analysis, defensiveMode = false) {
  const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local TZ (EST)

  // Shared performance header
  let perfHeader = `\n## LEARNING DATA\n`;
  perfHeader += `(Updated: ${date} | ${stats.total_trades} trades | ${stats.win_rate.toFixed(1)}% win rate)\n\n`;
  perfHeader += `PERFORMANCE:\n`;
  perfHeader += `- ${stats.win_rate.toFixed(1)}% WR (${stats.wins}W/${stats.losses}L) | PF: ${stats.profit_factor >= 999 ? '∞' : stats.profit_factor.toFixed(2)}\n`;
  perfHeader += `- Avg win: +$${stats.avg_win.toFixed(2)} | Avg loss: $${stats.avg_loss.toFixed(2)}\n`;
  perfHeader += `- Hold: Winners ${stats.avg_hold_winners.toFixed(1)}h, Losers ${stats.avg_hold_losers.toFixed(1)}h\n`;

  // Best tier
  if (stats.tier_stats.length > 0) {
    const best = stats.tier_stats.reduce((a, b) => {
      const aWr = parseInt(a.total) > 0 ? parseInt(a.wins) / parseInt(a.total) : 0;
      const bWr = parseInt(b.total) > 0 ? parseInt(b.wins) / parseInt(b.total) : 0;
      return aWr >= bWr ? a : b;
    });
    const bestWr = parseInt(best.total) > 0 ? (parseInt(best.wins) / parseInt(best.total) * 100).toFixed(0) : 0;
    perfHeader += `- Best tier: T${best.tier} (${bestWr}% WR)\n`;
  }
  perfHeader += '\n';

  // ── Haiku-specific section ──
  let haikuSection = perfHeader;

  // Escalation accuracy
  if (stats.escalation_accuracy.length > 0) {
    const totalEsc = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.total_escalated), 0);
    const totalTraded = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.led_to_trade), 0);
    const totalPassed = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.passed), 0);
    haikuSection += `YOUR ESCALATION ACCURACY:\n`;
    haikuSection += `- Total: ${totalEsc} escalated → ${totalTraded} traded, ${totalPassed} PASSed by Sonnet\n`;
    for (const r of stats.escalation_accuracy) {
      const convRate = parseInt(r.total_escalated) > 0 ? (parseInt(r.led_to_trade) / parseInt(r.total_escalated) * 100).toFixed(0) : 0;
      haikuSection += `- ${r.strength}: ${r.total_escalated} escalated, ${convRate}% converted\n`;
    }
    haikuSection += `Note: Conversion rate reflects Sonnet's filtering, not your accuracy. Low STRONG conversion means Sonnet applies additional filters. High WEAK conversion is survivorship bias (small sample of exceptional signals).\n`;
    haikuSection += '\n';
  }

  // PASS outcome summary
  const correctPass = parseInt(stats.pass_outcome_summary.correct_pass) || 0;
  const missedOpp = parseInt(stats.pass_outcome_summary.missed_opportunity) || 0;
  if (correctPass > 0 || missedOpp > 0) {
    haikuSection += `SONNET PASS OUTCOMES:\n`;
    haikuSection += `- CORRECT_PASS: ${correctPass} (Sonnet was right to pass)\n`;
    haikuSection += `- MISSED_OPPORTUNITY: ${missedOpp} (price moved favorably after pass)\n\n`;
  }

  // STOP escalating patterns — only based on confirmed correct passes, not raw PASS rate
  if (stats.pass_patterns.length > 0) {
    haikuSection += `STOP ESCALATING (confirmed unprofitable — price didn't move after >70% of these):\n`;
    for (const p of stats.pass_patterns.slice(0, 5)) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      haikuSection += `- ${triggers} (${p.trend}) ${p.strength}: ${p.correct_pass_rate}% confirmed unprofitable (${p.total} evaluated)\n`;
    }
    haikuSection += '\n';
  }

  // START escalating patterns — exclude patterns that also appear in BAD TRADE PATTERNS
  // Suppress during defensive mode to avoid contradicting STOP/REJECT rules
  if (stats.missed_escalation_patterns.length > 0 && !defensiveMode) {
    const badPatternKeys = new Set(
      stats.losing_patterns.map(p => {
        const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
        return `${triggers}|${p.strength}`;
      })
    );
    const filteredMissed = stats.missed_escalation_patterns.filter(p => {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      return !badPatternKeys.has(`${triggers}|${p.strength}`);
    });
    if (filteredMissed.length > 0) {
      haikuSection += `START ESCALATING (you filtered these out but price moved favorably):\n`;
      for (const p of filteredMissed.slice(0, 5)) {
        const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
        haikuSection += `- ${triggers} (${p.trend}) ${p.strength}: ${p.total} missed, avg +${Math.min(parseFloat(p.avg_gain_pct), 20).toFixed(1)}% gain\n`;
      }
      haikuSection += '\n';
    }
  }

  // SONNET WAS WRONG section — show MISSED_OPPORTUNITY PASS decisions
  // Suppress during defensive mode to avoid contradicting STOP/REJECT rules
  if (stats.missed_pass_decisions.length > 0 && !defensiveMode) {
    haikuSection += `SONNET WAS WRONG (these PASSed signals SHOULD have been escalated — Sonnet erred, not you):\n`;
    for (const m of stats.missed_pass_decisions.slice(0, 5)) {
      haikuSection += `- ${m.symbol} ${m.haiku_strength} conf:${m.haiku_conf} → Sonnet passed → price rose +${Math.min(parseFloat(m.potential_gain_pct), 20).toFixed(1)}%`;
      if (m.reasoning) haikuSection += ` | Sonnet's reason: ${m.reasoning.substring(0, 80)}`;
      haikuSection += '\n';
    }
    haikuSection += `Keep escalating signals like these — Sonnet needs to see them.\n\n`;
  }

  // Missed SELL signals — Sonnet passed on these (Haiku correctly escalated them)
  if (stats.missed_sell_pass_decisions.length > 0) {
    haikuSection += `SONNET MISSED THESE SELL SIGNALS (you correctly escalated, but Sonnet chose PASS and price dropped):\n`;
    for (const m of stats.missed_sell_pass_decisions.slice(0, 5)) {
      haikuSection += `- ${m.symbol} ${m.haiku_strength} conf:${m.haiku_conf} → Sonnet passed → price dropped -${Math.min(parseFloat(m.potential_drop_pct), 20).toFixed(1)}%`;
      if (m.reasoning) haikuSection += ` | Sonnet's reason: ${m.reasoning.substring(0, 80)}`;
      haikuSection += '\n';
    }
    haikuSection += `Keep escalating SELL signals like these — Sonnet needs to see them.\n\n`;
  } else if (stats.missed_sell_opportunities.length > 0) {
    const missedSellFiltered = stats.missed_sell_opportunities.filter(m => parseFloat(m.potential_drop_pct) > MISSED_OPP_THRESHOLD);
    if (missedSellFiltered.length > 0) {
      haikuSection += `MISSED SELL SIGNALS (you didn't escalate these SELL signals but price dropped):\n`;
      for (const m of missedSellFiltered.slice(0, 5)) {
        haikuSection += `- ${m.symbol} ${m.strength} conf:${m.confidence} @ $${parseFloat(m.signal_price).toFixed(4)} → min $${parseFloat(m.min_price_24h).toFixed(4)} (-${Math.min(parseFloat(m.potential_drop_pct), 20).toFixed(1)}%)\n`;
      }
      haikuSection += `Start escalating SELL signals like these — missed sells mean unrealized losses.\n\n`;
    }
  }

  // BAD TRADE PATTERNS — counterbalance to escalation pressure
  if (stats.losing_patterns.length > 0) {
    const badTradeSection = `BAD TRADE PATTERNS (these setups consistently lost money — DO NOT escalate/approve):\n`;
    haikuSection += badTradeSection;
    for (const p of stats.losing_patterns.slice(0, 5)) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      haikuSection += `- ${triggers} (${p.trend}) ${p.strength}: ${p.losses}/${p.total} lost, avg $${parseFloat(p.avg_loss_usd).toFixed(2)}\n`;
    }
    haikuSection += '\n';
  }

  // Haiku rules: combine haiku_rules + haiku_escalation_calibration, cap at 15
  const haikuRules = deduplicateRules([
    ...toArray(analysis.haiku_rules),
    ...toArray(analysis.haiku_escalation_calibration),
  ]).slice(0, 15);
  const sonnetRules = toArray(analysis.sonnet_rules);

  // ── Sonnet section with losing trade patterns ──
  let sonnetSection = perfHeader;
  if (stats.losing_patterns.length > 0) {
    // Build exception lookup from winning signal combos (for cross-referencing)
    const winningSubPatterns = new Map();
    if (stats.signal_combo_stats) {
      for (const s of stats.signal_combo_stats) {
        const wr = parseInt(s.total) > 0 ? parseInt(s.wins) / parseInt(s.total) * 100 : 0;
        if (wr >= 55 && parseInt(s.total) >= 2) {
          winningSubPatterns.set(s.signal_combo, { wr: wr.toFixed(0), total: s.total });
        }
      }
    }

    sonnetSection += `BAD TRADE PATTERNS (these setups consistently lost money — REJECT or REDUCE):\n`;
    for (const p of stats.losing_patterns.slice(0, 5)) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      let line = `- ${triggers} (${p.trend}) ${p.strength}: ${p.losses}/${p.total} lost, avg $${parseFloat(p.avg_loss_usd).toFixed(2)}`;
      // Check for winning sub-pattern exception (matches haiku prompt format)
      const matchingWin = winningSubPatterns.get(triggers);
      if (matchingWin) {
        line += ` (EXCEPTION: sub-pattern wins ${matchingWin.wr}% on ${matchingWin.total} trades — approve if RSI <55 and volume >3x)`;
      }
      sonnetSection += line + '\n';
    }
    sonnetSection += '\n';
  }

  // Write Haiku prompt
  updatePromptFile('prompts/haiku-scanner.md', haikuSection, haikuRules, analysis.haiku_few_shots || []);

  // Write Sonnet prompt
  updatePromptFile('prompts/sonnet-decision.md', sonnetSection, sonnetRules, analysis.sonnet_few_shots || []);

  // ── Exit-eval prompt update ──
  let exitSection = `\n## LEARNING DATA\n`;
  exitSection += `(Updated: ${date} | ${stats.total_trades} trades | ${stats.win_rate.toFixed(1)}% win rate)\n\n`;

  // Exit timing analysis
  if (stats.exit_timing.length > 0) {
    exitSection += `EXIT TIMING ANALYSIS:\n`;
    for (const e of stats.exit_timing) {
      exitSection += `- ${e.exit_category}: ${e.cnt} trades, avg P&L ${parseFloat(e.avg_pnl_pct).toFixed(1)}%, avg max gain ${parseFloat(e.avg_max_gain_pct || 0).toFixed(1)}%, avg hold ${parseFloat(e.avg_hold_hours).toFixed(1)}h\n`;
    }
    exitSection += '\n';
  }

  // Hold time comparison
  if (stats.avg_hold_winners > 0 || stats.avg_hold_losers > 0) {
    exitSection += `HOLD TIME COMPARISON:\n`;
    exitSection += `- Winners: ${stats.avg_hold_winners.toFixed(1)}h avg hold\n`;
    exitSection += `- Losers: ${stats.avg_hold_losers.toFixed(1)}h avg hold\n`;
    if (stats.avg_hold_winners > 0 && stats.avg_hold_losers > stats.avg_hold_winners * 1.3 && stats.avg_hold_losers > 0) {
      exitSection += `- WARNING: Losers held ${((stats.avg_hold_losers / stats.avg_hold_winners - 1) * 100).toFixed(0)}% longer than winners — cut losses faster\n`;
    }
    exitSection += '\n';
  }

  // BAD TRADE PATTERNS — losers to avoid
  if (stats.losing_patterns.length > 0) {
    exitSection += `BAD TRADE PATTERNS (these setups consistently lost money — exit faster if held):\n`;
    for (const p of stats.losing_patterns.slice(0, 5)) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      exitSection += `- ${triggers} (${p.trend}) ${p.strength}: ${p.losses}/${p.total} lost, avg $${parseFloat(p.avg_loss_usd).toFixed(2)}\n`;
    }
    exitSection += '\n';
  }

  // Exit rules from Sonnet analysis
  const exitRules = toArray(analysis.exit_rules);
  if (exitRules.length > 0) {
    exitSection += `EXIT RULES FROM EXPERIENCE:\n`;
    for (let i = 0; i < exitRules.length; i++) {
      exitSection += `${i + 1}. ${flattenRule(exitRules[i])}\n`;
    }
    exitSection += '\n';
  }

  // Update exit-eval prompt file
  let exitContent = readFileSync('prompts/sonnet-exit-eval.md', 'utf8');
  const exitMarker = '## LEARNING DATA';
  const exitMarkerIndex = exitContent.indexOf(exitMarker);
  if (exitMarkerIndex !== -1) {
    exitContent = exitContent.substring(0, exitMarkerIndex).trimEnd();
  }
  writeFileSync('prompts/sonnet-exit-eval.md.tmp', exitContent + '\n\n' + exitSection.trim() + '\n');
  renameSync('prompts/sonnet-exit-eval.md.tmp', 'prompts/sonnet-exit-eval.md');

  logger.info('[Learning] Prompt files updated (haiku, sonnet, exit-eval)');
}

function flattenRule(rule) {
  if (typeof rule === 'string') return rule;
  // Convert structured rule objects to readable plain text
  if (rule.action && rule.pattern) {
    let text = `${rule.action}: ${rule.pattern}`;
    if (rule.reason) text += ` — ${rule.reason}`;
    return text;
  }
  return JSON.stringify(rule);
}

function deduplicateRules(rules) {
  const flattened = rules.map(flattenRule);
  const seen = [];
  const result = [];
  for (let i = 0; i < flattened.length; i++) {
    const normalized = flattened[i].toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    // Check for near-duplicates: if >60% of words overlap with an existing rule, skip
    const words = new Set(normalized.split(' ').filter(w => w.length > 1));
    let isDuplicate = false;
    for (const existing of seen) {
      const existingWords = new Set(existing.split(' ').filter(w => w.length > 1));
      const intersection = [...words].filter(w => existingWords.has(w));
      // Jaccard-style: overlap relative to the candidate rule's word count
      const overlap = words.size > 0
        ? intersection.length / words.size
        : 0;
      if (overlap > 0.6) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      seen.push(normalized);
      result.push(rules[i]);
    }
  }
  return result;
}

function updatePromptFile(path, learningSection, rules, fewShots) {
  let content = readFileSync(path, 'utf8');

  // Extract existing learning section for diff logging
  const marker = '## LEARNING DATA';
  const markerIndex = content.indexOf(marker);
  const oldSection = markerIndex !== -1 ? content.substring(markerIndex) : '';

  if (markerIndex !== -1) {
    content = content.substring(0, markerIndex).trimEnd();
  }

  // Build new section
  let section = '\n\n' + learningSection;

  // Enforce max 15 rules as safety net
  const cappedRules = rules.slice(0, 15);
  if (cappedRules.length > 0) {
    section += `RULES FROM EXPERIENCE:\n`;
    for (let i = 0; i < cappedRules.length; i++) {
      // Fix stale mode references: rule #1 (master mode rule) already sets
      // the current mode policy, so remove mode qualifiers from other rules
      // that were generated under a previous mode (e.g., "during DEFENSIVE MODE").
      let ruleText = flattenRule(cappedRules[i]);
      // Strip stale mode qualifiers — rule #1 (master mode rule) already declares current mode
      ruleText = ruleText.replace(/\s*(?:during|in|under)\s+(?:DEFENSIVE|CAUTIOUS|STAGNATION(?:\s+OVERRIDE)?)\s+MODE/gi, '');
      ruleText = ruleText.replace(/\s*\((?:DEFENSIVE|CAUTIOUS)\s+MODE(?:\s+active)?\)/gi, '');
      section += `${i + 1}. ${ruleText}\n`;
    }
    section += '\n';
  }

  if (fewShots.length > 0) {
    section += `EXAMPLES FROM ACTUAL TRADES:\n`;
    for (const fs of fewShots.slice(0, 3)) { // Max 3 to save tokens
      section += `- ${fs.description}: ${fs.outcome}\n`;
    }
    section += '\n';
  }

  // Log meaningful changes between old and new learning sections
  const newSection = section.trim();
  if (oldSection && newSection !== oldSection.trim()) {
    const oldRuleCount = (oldSection.match(/^\d+\./gm) || []).length;
    const newRuleCount = cappedRules.length;
    const oldStopCount = (oldSection.match(/STOP/g) || []).length;
    const newStopCount = (newSection.match(/STOP/g) || []).length;
    const oldStartCount = (oldSection.match(/START/g) || []).length;
    const newStartCount = (newSection.match(/START/g) || []).length;
    logger.info(`[Learning] ${path} diff: rules ${oldRuleCount}→${newRuleCount}, STOP refs ${oldStopCount}→${newStopCount}, START refs ${oldStartCount}→${newStartCount}`);
  }

  writeFileSync(path + '.tmp', content + section);
  renameSync(path + '.tmp', path);
}

// ── Outcome Updater ─────────────────────────────────────────

async function updateOutcomes() {
  // Break into smaller transactions to avoid lock contention with live trading engine.
  // Each logical group runs in its own transaction.

  // ── Group 1: Trade outcome updates (signals + decisions for closed positions) ──
  const client1 = await getClient();
  try {
  await client1.query('BEGIN');

  // Update signals that led to winning trades
  await client1.query(`
    UPDATE signals SET outcome = 'WIN', outcome_pnl = p.realized_pnl
    FROM decisions d
    JOIN positions p ON p.open_decision_id = d.id
    WHERE signals.id = d.signal_id
    AND p.status = 'CLOSED' AND p.realized_pnl > 0
    AND signals.outcome = 'PENDING'
  `);

  // Update signals that led to losing trades
  await client1.query(`
    UPDATE signals SET outcome = 'LOSS', outcome_pnl = p.realized_pnl
    FROM decisions d
    JOIN positions p ON p.open_decision_id = d.id
    WHERE signals.id = d.signal_id
    AND p.status = 'CLOSED' AND p.realized_pnl < 0
    AND signals.outcome = 'PENDING'
  `);

  // Update decisions that led to wins/losses
  await client1.query(`
    UPDATE decisions SET outcome = 'WIN', outcome_pnl = p.realized_pnl
    FROM positions p
    WHERE p.open_decision_id = decisions.id
    AND p.status = 'CLOSED' AND p.realized_pnl > 0
    AND decisions.outcome = 'PENDING'
  `);

  await client1.query(`
    UPDATE decisions SET outcome = 'LOSS', outcome_pnl = p.realized_pnl
    FROM positions p
    WHERE p.open_decision_id = decisions.id
    AND p.status = 'CLOSED' AND p.realized_pnl < 0
    AND decisions.outcome = 'PENDING'
  `);

  // Update signals for breakeven trades
  await client1.query(`
    UPDATE signals SET outcome = 'NEUTRAL', outcome_pnl = 0
    FROM decisions d
    JOIN positions p ON p.open_decision_id = d.id
    WHERE signals.id = d.signal_id
    AND p.status = 'CLOSED' AND p.realized_pnl = 0
    AND signals.outcome = 'PENDING'
  `);

  // Update decisions for breakeven trades
  await client1.query(`
    UPDATE decisions SET outcome = 'NEUTRAL', outcome_pnl = 0
    FROM positions p
    WHERE p.open_decision_id = decisions.id
    AND p.status = 'CLOSED' AND p.realized_pnl = 0
    AND decisions.outcome = 'PENDING'
  `);

  await client1.query('COMMIT');
  } catch (error) {
    await client1.query('ROLLBACK').catch(() => {});
    logger.error(`[Learning] Trade outcome update failed: ${error.message}`);
    throw error;
  } finally {
    client1.release();
  }

  // ── Group 2: PASS decision evaluations ──
  const client = await getClient();
  try {
  await client.query('BEGIN');

  // PASS decisions older than configured window: evaluate against actual price movement
  // BUY signals where price rose >threshold% sustained for N candles → MISSED_OPPORTUNITY
  const missedBuys = await client.query(`
    UPDATE decisions d SET
      outcome = 'MISSED_OPPORTUNITY',
      outcome_pnl = sub.gain_pct
    FROM (
      SELECT d2.id as decision_id,
        ((MAX(i.price) - s.price) / s.price * 100) as gain_pct
      FROM decisions d2
      JOIN signals s ON d2.signal_id = s.id
      LEFT JOIN indicator_snapshots i ON i.symbol = s.symbol
        AND i.created_at > s.created_at
        AND i.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      WHERE d2.action = 'PASS' AND d2.outcome = 'PENDING'
        AND s.signal_type = 'BUY'
        AND d2.created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      GROUP BY d2.id, s.price, s.symbol, s.created_at
      HAVING s.price > 0 AND ((MAX(i.price) - s.price) / s.price * 100) > $1
        AND (SELECT COUNT(*) FROM indicator_snapshots i2
             WHERE i2.symbol = s.symbol
               AND i2.created_at > s.created_at
               AND i2.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
               AND ((i2.price - s.price) / s.price * 100) > $1
            ) >= $2
        -- Only count as missed if price didn't dip >3% first (would have been stopped out)
        AND COALESCE((SELECT MIN(i3.price) FROM indicator_snapshots i3
             WHERE i3.symbol = s.symbol
               AND i3.created_at > s.created_at
               AND i3.created_at < s.created_at + INTERVAL '4 hours'
            ), s.price) >= s.price * 0.97
    ) sub
    WHERE d.id = sub.decision_id
  `, [MISSED_OPP_THRESHOLD, SUSTAINED_CANDLES]);
  if (missedBuys.rowCount > 0) {
    logger.info(`[Learning] Marked ${missedBuys.rowCount} BUY PASS decisions as MISSED_OPPORTUNITY`);
  }

  // SELL signals where price dropped >threshold% sustained for N candles → MISSED_OPPORTUNITY
  const missedSells = await client.query(`
    UPDATE decisions d SET
      outcome = 'MISSED_OPPORTUNITY',
      outcome_pnl = sub.drop_pct
    FROM (
      SELECT d2.id as decision_id,
        ((s.price - MIN(i.price)) / s.price * 100) as drop_pct
      FROM decisions d2
      JOIN signals s ON d2.signal_id = s.id
      LEFT JOIN indicator_snapshots i ON i.symbol = s.symbol
        AND i.created_at > s.created_at
        AND i.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      WHERE d2.action = 'PASS' AND d2.outcome = 'PENDING'
        AND s.signal_type = 'SELL'
        AND d2.created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      Group BY d2.id, s.price, s.symbol, s.created_at
      HAVING s.price > 0 AND ((s.price - MIN(i.price)) / s.price * 100) > $1
        AND (SELECT COUNT(*) FROM indicator_snapshots i2
             WHERE i2.symbol = s.symbol
               AND i2.created_at > s.created_at
               AND i2.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
               AND ((s.price - i2.price) / s.price * 100) > $1
            ) >= $2
        -- Only count as missed if price didn't rally >3% first (would have caused adverse entry)
        AND COALESCE((SELECT MAX(i3.price) FROM indicator_snapshots i3
             WHERE i3.symbol = s.symbol
               AND i3.created_at > s.created_at
               AND i3.created_at < s.created_at + INTERVAL '4 hours'
            ), s.price) <= s.price * 1.03
    ) sub
    WHERE d.id = sub.decision_id
  `, [MISSED_OPP_THRESHOLD, SUSTAINED_CANDLES]);
  if (missedSells.rowCount > 0) {
    logger.info(`[Learning] Marked ${missedSells.rowCount} SELL PASS decisions as MISSED_OPPORTUNITY`);
  }

  // Remaining PASS decisions older than evaluation window: mark as CORRECT_PASS
  // Only mark if indicator_snapshots data exists for the symbol — no data = inconclusive
  await client.query(`
    UPDATE decisions SET outcome = 'CORRECT_PASS'
    WHERE action = 'PASS' AND outcome = 'PENDING'
    AND created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
    AND signal_id IN (
      SELECT s.id FROM signals s
      WHERE EXISTS (
        SELECT 1 FROM indicator_snapshots i
        WHERE i.symbol = s.symbol
        AND i.created_at > s.created_at
        AND i.created_at < s.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      )
    )
  `);

  // PASS decisions with no indicator data: leave as PENDING (will be retried or age out)
  // This prevents falsely reinforcing rejection patterns when we have no evidence

  await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`[Learning] PASS evaluation failed: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }

  // ── Group 3: Non-escalated signal evaluations ──
  const client3 = await getClient();
  try {
  await client3.query('BEGIN');

  // Also tag non-escalated BUY signals that moved >threshold% sustained as MISSED_OPPORTUNITY
  const missedBuySignals = await client3.query(`
    UPDATE signals s SET
      outcome = 'MISSED_OPPORTUNITY',
      outcome_pnl = sub.gain_pct
    FROM (
      Select s2.id as signal_id,
        ((MAX(i.price) - s2.price) / s2.price * 100) as gain_pct
      FROM signals s2
      LEFT JOIN indicator_snapshots i ON i.symbol = s2.symbol
        AND i.created_at > s2.created_at
        AND i.created_at < s2.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      WHERE s2.escalated = false AND s2.signal_type = 'BUY'
        AND s2.outcome = 'PENDING'
        AND s2.created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      GROUP BY s2.id, s2.price, s2.symbol, s2.created_at
      HAVING s2.price > 0 AND ((MAX(i.price) - s2.price) / s2.price * 100) > $1
        AND (SELECT COUNT(*) FROM indicator_snapshots i2
             WHERE i2.symbol = s2.symbol
               AND i2.created_at > s2.created_at
               AND i2.created_at < s2.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
               AND ((i2.price - s2.price) / s2.price * 100) > $1
            ) >= $2
        -- Only count as missed if price didn't dip >3% first (would have been stopped out)
        AND COALESCE((SELECT MIN(i3.price) FROM indicator_snapshots i3
             WHERE i3.symbol = s2.symbol
               AND i3.created_at > s2.created_at
               AND i3.created_at < s2.created_at + INTERVAL '4 hours'
            ), s2.price) >= s2.price * 0.97
    ) sub
    WHERE s.id = sub.signal_id
  `, [MISSED_OPP_THRESHOLD, SUSTAINED_CANDLES]);
  if (missedBuySignals.rowCount > 0) {
    logger.info(`[Learning] Marked ${missedBuySignals.rowCount} non-escalated BUY signals as MISSED_OPPORTUNITY`);
  }

  // Also tag non-escalated SELL signals where price dropped >threshold% sustained as MISSED_OPPORTUNITY
  const missedSellSignals = await client3.query(`
    UPDATE signals s SET
      outcome = 'MISSED_OPPORTUNITY',
      outcome_pnl = sub.drop_pct
    FROM (
      SELECT s2.id as signal_id,
        ((s2.price - MIN(i.price)) / s2.price * 100) as drop_pct
      FROM signals s2
      LEFT JOIN indicator_snapshots i ON i.symbol = s2.symbol
        AND i.created_at > s2.created_at
        AND i.created_at < s2.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      WHERE s2.escalated = false AND s2.signal_type = 'SELL'
        AND s2.outcome = 'PENDING'
        AND s2.created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
      GROUP BY s2.id, s2.price, s2.symbol, s2.created_at
      HAVING s2.price > 0 AND ((s2.price - MIN(i.price)) / s2.price * 100) > $1
        AND (SELECT COUNT(*) FROM indicator_snapshots i2
             WHERE i2.symbol = s2.symbol
               AND i2.created_at > s2.created_at
               AND i2.created_at < s2.created_at + make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
               AND ((s2.price - i2.price) / s2.price * 100) > $1
            ) >= $2
        -- Only count as missed if price didn't rally >3% first (mirrors BUY anti-dip filter)
        AND COALESCE((SELECT MAX(i3.price) FROM indicator_snapshots i3
             WHERE i3.symbol = s2.symbol
               AND i3.created_at > s2.created_at
               AND i3.created_at < s2.created_at + INTERVAL '4 hours'
            ), s2.price) <= s2.price * 1.03
    ) sub
    WHERE s.id = sub.signal_id
  `, [MISSED_OPP_THRESHOLD, SUSTAINED_CANDLES]);
  if (missedSellSignals.rowCount > 0) {
    logger.info(`[Learning] Marked ${missedSellSignals.rowCount} non-escalated SELL signals as MISSED_OPPORTUNITY`);
  }

  // Remaining non-escalated signals older than evaluation window: mark as NOT_TRADED
  await client3.query(`
    UPDATE signals SET outcome = 'NOT_TRADED'
    WHERE escalated = false AND outcome = 'PENDING'
    AND created_at < NOW() - make_interval(hours => ${parseInt(PASS_EVAL_WINDOW_HOURS)})
  `);

  await client3.query('COMMIT');
  } catch (error) {
    await client3.query('ROLLBACK').catch(() => {});
    logger.error(`[Learning] Non-escalated signal evaluation failed: ${error.message}`);
    throw error;
  } finally {
    client3.release();
  }
  logger.info('[Learning] Outcomes updated');
}

// ── Learning Changelog ──────────────────────────────────────

/**
 * Generate a normalized fingerprint for a rule to detect semantic duplicates.
 * Strips statistics, percentages, and trade counts so that "REJECT X — 3/3 losses"
 * and "REJECT X — 2/5 losses" produce the same fingerprint.
 */
function generateRuleFingerprint(ruleType, ruleText) {
  if (typeof ruleText !== 'string') return '';
  const normalized = ruleText
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?%?\s*(?:wr|win\s*rate|trades?|samples?|losses?|wins?|lost|won)/gi, '') // strip stats
    .replace(/\d+\s*\/\s*\d+/g, '')  // strip ratios like 3/5
    .replace(/\$\s*\d+(?:\.\d+)?/g, '')  // strip dollar amounts
    .replace(/avg\s*[+-]?\s*\$?\s*\d+(?:\.\d+)?/gi, '')  // strip avg P&L
    .replace(/\+?\d+(?:\.\d+)?%/g, '')  // strip standalone percentages
    .replace(/\(\s*\)/g, '')  // strip empty parens left behind
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${ruleType}:${normalized}`).digest('hex').substring(0, 16);
}

/**
 * Log a change to the learning_changelog table.
 */
async function logChangelog(client, { changeType, ruleType, ruleText, previousRuleText, reason, stats, fingerprint, learningHistoryId }) {
  if (!CHANGELOG_ENABLED) return;
  const fp = fingerprint || generateRuleFingerprint(ruleType, ruleText);

  // Count prior oscillations for this fingerprint
  const oscResult = await client.query(`
    SELECT COUNT(*) as cnt FROM learning_changelog
    WHERE rule_fingerprint = $1
      AND created_at > NOW() - INTERVAL '1 day' * $2
  `, [fp, CHANGELOG_OSCILLATION_WINDOW_DAYS]);
  const oscillationCount = parseInt(oscResult.rows[0].cnt) || 0;

  await client.query(`
    INSERT INTO learning_changelog (
      change_type, rule_type, rule_text, previous_rule_text, reason,
      win_rate_at_change, total_pnl_at_change, total_trades_at_change,
      rule_fingerprint, oscillation_count, learning_history_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    changeType, ruleType, ruleText, previousRuleText || null, reason,
    stats?.win_rate ?? null, stats?.total_pnl ?? null, stats?.total_trades ?? null,
    fp, oscillationCount, learningHistoryId || null,
  ]);
}

/**
 * Check if a rule fingerprint is oscillating (added/deactivated too many times recently).
 * Returns { isOscillating, count, history } where history contains the last few changes.
 */
async function detectOscillation(client, ruleType, ruleText) {
  if (!CHANGELOG_ENABLED) return { isOscillating: false, count: 0, history: [] };

  const fp = generateRuleFingerprint(ruleType, ruleText);
  const result = await client.query(`
    SELECT change_type, reason, created_at
    FROM learning_changelog
    WHERE rule_fingerprint = $1
      AND created_at > NOW() - INTERVAL '1 day' * $2
    ORDER BY created_at DESC
    LIMIT 10
  `, [fp, CHANGELOG_OSCILLATION_WINDOW_DAYS]);

  const changes = result.rows;
  // Count state transitions (ADDED→DEACTIVATED or vice versa)
  const transitions = changes.filter(c => c.change_type === 'ADDED' || c.change_type === 'DEACTIVATED').length;

  return {
    isOscillating: transitions >= CHANGELOG_OSCILLATION_THRESHOLD,
    count: transitions,
    history: changes,
  };
}

/**
 * Fetch changelog context for the Opus prompt. Returns three sections:
 * 1. Oscillating rules — rules that keep being added and removed
 * 2. Recent changes — what changed in the last N days
 * 3. Deactivation reasons — why rules were removed
 */
async function fetchChangelogContext() {
  if (!CHANGELOG_ENABLED) return null;

  // 1. Oscillating rules (fingerprints with 3+ changes in the window)
  const oscillating = await query(`
    SELECT rule_fingerprint, rule_type, rule_text, COUNT(*) as change_count,
           array_agg(change_type ORDER BY created_at DESC) as change_types,
           array_agg(reason ORDER BY created_at DESC) as reasons
    FROM learning_changelog
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY rule_fingerprint, rule_type, rule_text
    HAVING COUNT(*) >= $2
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `, [CHANGELOG_OSCILLATION_WINDOW_DAYS, CHANGELOG_OSCILLATION_THRESHOLD]);

  // 2. Recent changes (last context_window_days, capped)
  const recent = await query(`
    SELECT change_type, rule_type, rule_text, reason, created_at
    FROM learning_changelog
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [CHANGELOG_CONTEXT_WINDOW_DAYS, CHANGELOG_MAX_CONTEXT_ENTRIES]);

  // 3. Deactivation reasons (why rules were removed — most useful for Opus)
  const deactivations = await query(`
    SELECT rule_type, rule_text, reason, created_at
    FROM learning_changelog
    WHERE change_type IN ('DEACTIVATED', 'EXPIRED', 'OSCILLATION_BLOCKED')
      AND created_at > NOW() - INTERVAL '1 day' * $1
    ORDER BY created_at DESC
    LIMIT 20
  `, [CHANGELOG_CONTEXT_WINDOW_DAYS]);

  if (oscillating.rows.length === 0 && recent.rows.length === 0) return null;

  return {
    oscillating: oscillating.rows,
    recent: recent.rows,
    deactivations: deactivations.rows,
  };
}

// ── Database Rule Saver ─────────────────────────────────────

const toArray = (val) => Array.isArray(val) ? val : [];

/**
 * Parse rule text to extract statistical metadata for the learning_rules table.
 * Returns { sample_size, win_rate, avg_pnl, confidence_score } with nulls for unmatched fields.
 */
function extractRuleMetrics(ruleText) {
  const metrics = { sample_size: null, win_rate: null, avg_pnl: null, confidence_score: null };
  if (typeof ruleText !== 'string') return metrics;

  // "X/Y trades" or "X/Y losses" or "X/Y lost" or "X/Y won"
  const tradeRatioMatch = ruleText.match(/(\d+)\s*\/\s*(\d+)\s*(?:trades?|loss(?:es)?|lost|won|wins?)/i);
  if (tradeRatioMatch) {
    const numerator = parseInt(tradeRatioMatch[1]);
    const denominator = parseInt(tradeRatioMatch[2]);
    if (denominator > 0) {
      metrics.sample_size = denominator;
      // If "X/Y won" or "X/Y wins" → numerator is wins
      if (/won|wins?/i.test(tradeRatioMatch[0])) {
        metrics.win_rate = parseFloat((numerator / denominator * 100).toFixed(1));
      }
      // If "X/Y losses" or "X/Y lost" → numerator is losses, so win_rate = (denom - num) / denom
      else if (/loss(?:es)?|lost/i.test(tradeRatioMatch[0])) {
        metrics.win_rate = parseFloat(((denominator - numerator) / denominator * 100).toFixed(1));
      }
    }
  }

  // Fallback: "N trades" without a ratio (e.g., "8 trades 63% WR")
  if (!metrics.sample_size) {
    const simpleTradeMatch = ruleText.match(/(\d+)\s+trades?\b/i);
    if (simpleTradeMatch) {
      metrics.sample_size = parseInt(simpleTradeMatch[1]);
    }
  }

  // "X% WR" or "X% win rate"
  const wrMatch = ruleText.match(/(\d+(?:\.\d+)?)\s*%\s*WR\b/i) || ruleText.match(/(\d+(?:\.\d+)?)\s*%\s*win\s*rate/i);
  if (wrMatch) {
    metrics.win_rate = parseFloat(wrMatch[1]);
  }

  // "avg $X" or "avg -$X" or "avg +$X" or "avg -X%" or "avg +X%"
  const avgPnlMatch = ruleText.match(/avg\s+([+-]?\$?\s*\d+(?:\.\d+)?)\s*%?/i);
  if (avgPnlMatch) {
    const raw = avgPnlMatch[1].replace(/[\s$]/g, '');
    const parsed = parseFloat(raw);
    if (!isNaN(parsed)) {
      metrics.avg_pnl = parsed;
    }
  }

  // Derive a simple confidence_score from sample_size if available
  if (metrics.sample_size !== null) {
    // Confidence increases with sample size: min(sample_size / 20, 1.0)
    metrics.confidence_score = parseFloat(Math.min(metrics.sample_size / 20, 1.0).toFixed(2));
  }

  return metrics;
}

async function saveLearningRules(analysis, currentStats = null) {
  const client = await getClient();
  let savedCount = 0;
  let blockedCount = 0;
  try {
    await client.query('BEGIN');

    // Fetch rules about to be deactivated (for changelog logging)
    const oldRulesResult = await client.query(`
      SELECT id, rule_type, rule_text FROM learning_rules
      WHERE is_active = true AND created_at < NOW() - INTERVAL '7 days'
    `);

    // Deactivate old rules (>7 days)
    await client.query(`
      UPDATE learning_rules SET is_active = false, deactivated_at = NOW()
      WHERE is_active = true AND created_at < NOW() - INTERVAL '7 days'
    `);

    // Log expired deactivations to changelog
    for (const old of oldRulesResult.rows) {
      await logChangelog(client, {
        changeType: 'EXPIRED',
        ruleType: old.rule_type,
        ruleText: old.rule_text,
        reason: 'Rule expired after 7 days',
        stats: currentStats,
        fingerprint: generateRuleFingerprint(old.rule_type, old.rule_text),
      });
    }

    // Deactivate rules of the types we're about to insert — but only those 48+ hours old
    const typesToReplace = [];
    if (toArray(analysis.haiku_rules).length > 0) typesToReplace.push('haiku_escalation');
    if (toArray(analysis.sonnet_rules).length > 0) typesToReplace.push('sonnet_decision');
    if (toArray(analysis.haiku_escalation_calibration).length > 0) typesToReplace.push('haiku_calibration');
    if (toArray(analysis.exit_rules).length > 0) typesToReplace.push('sonnet_exit');

    if (typesToReplace.length > 0) {
      // Fetch rules about to be replaced (for changelog)
      const replacedResult = await client.query(`
        SELECT id, rule_type, rule_text FROM learning_rules
        WHERE is_active = true
          AND rule_type = ANY($1)
          AND created_at < NOW() - INTERVAL '48 hours'
      `, [typesToReplace]);

      const deactivated = await client.query(`
        UPDATE learning_rules SET is_active = false, deactivated_at = NOW()
        WHERE is_active = true
          AND rule_type = ANY($1)
          AND created_at < NOW() - INTERVAL '48 hours'
      `, [typesToReplace]);

      if (deactivated.rowCount > 0) {
        logger.info(`[Learning] Deactivated ${deactivated.rowCount} old rules (48h+) for types: ${typesToReplace.join(', ')}`);

        // Log replaced deactivations to changelog
        for (const replaced of replacedResult.rows) {
          await logChangelog(client, {
            changeType: 'DEACTIVATED',
            ruleType: replaced.rule_type,
            ruleText: replaced.rule_text,
            reason: 'Replaced by new nightly learning rules',
            stats: currentStats,
            fingerprint: generateRuleFingerprint(replaced.rule_type, replaced.rule_text),
          });
        }
      }
    }

    const allRules = [
      ...toArray(analysis.haiku_rules).map(r => ({ type: 'haiku_escalation', text: typeof r === 'string' ? r : JSON.stringify(r) })),
      ...toArray(analysis.sonnet_rules).map(r => ({ type: 'sonnet_decision', text: typeof r === 'string' ? r : JSON.stringify(r) })),
      ...toArray(analysis.haiku_escalation_calibration).map(r => ({ type: 'haiku_calibration', text: typeof r === 'string' ? r : JSON.stringify(r) })),
      ...toArray(analysis.exit_rules).map(r => ({ type: 'sonnet_exit', text: typeof r === 'string' ? r : JSON.stringify(r) })),
    ];

    for (const rule of allRules) {
      // Check for oscillation before inserting
      const { isOscillating, count, history } = await detectOscillation(client, rule.type, rule.text);
      if (isOscillating) {
        blockedCount++;
        logger.warn(`[Learning] OSCILLATION BLOCKED: "${rule.text.substring(0, 80)}..." (${count} changes in ${CHANGELOG_OSCILLATION_WINDOW_DAYS}d)`);
        await logChangelog(client, {
          changeType: 'OSCILLATION_BLOCKED',
          ruleType: rule.type,
          ruleText: rule.text,
          reason: `Blocked: ${count} add/deactivate cycles in ${CHANGELOG_OSCILLATION_WINDOW_DAYS} days. Last deactivation reason: ${history.find(h => h.change_type === 'DEACTIVATED')?.reason || 'unknown'}`,
          stats: currentStats,
        });
        continue;
      }

      const metrics = extractRuleMetrics(rule.text);
      await client.query(`
        INSERT INTO learning_rules (rule_type, rule_text, is_active, created_at, sample_size, win_rate, avg_pnl, confidence_score)
        VALUES ($1, $2, true, NOW(), $3, $4, $5, $6)
      `, [rule.type, rule.text, metrics.sample_size, metrics.win_rate, metrics.avg_pnl, metrics.confidence_score]);
      savedCount++;

      // Log the addition to changelog
      await logChangelog(client, {
        changeType: 'ADDED',
        ruleType: rule.type,
        ruleText: rule.text,
        reason: analysis.rule_changes || 'Nightly learning update',
        stats: currentStats,
      });
    }

    await client.query('COMMIT');
    logger.info(`[Learning] Saved ${savedCount} learning rules` + (blockedCount > 0 ? `, blocked ${blockedCount} oscillating rules` : ''));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`[Learning] saveLearningRules failed, rolled back: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

async function saveLearningHistory(stats, analysis, promptsUpdated = true) {
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local TZ (EST)
  await query(`
    INSERT INTO learning_history (
      analysis_start_date, analysis_end_date,
      total_trades, winning_trades, losing_trades, win_rate,
      total_pnl, avg_win_pnl, avg_loss_pnl, best_trade_pnl, worst_trade_pnl,
      best_patterns, worst_patterns,
      haiku_prompt_updated, sonnet_prompt_updated,
      new_few_shot_examples, sonnet_analysis
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  `, [
    today, today,
    stats.total_trades, stats.wins, stats.losses, stats.win_rate,
    stats.total_pnl, stats.avg_win, stats.avg_loss, stats.best_trade, stats.worst_trade,
    JSON.stringify(stats.pattern_stats.filter(p => {
      const wr = parseInt(p.total) > 0 ? parseInt(p.wins) / parseInt(p.total) * 100 : 0;
      return wr >= 55;
    })),
    JSON.stringify(stats.pattern_stats.filter(p => {
      const wr = parseInt(p.total) > 0 ? parseInt(p.wins) / parseInt(p.total) * 100 : 0;
      return wr < 40;
    })),
    promptsUpdated, promptsUpdated,
    JSON.stringify([...(toArray(analysis.haiku_few_shots)), ...(toArray(analysis.sonnet_few_shots))]),
    JSON.stringify(analysis),
  ]);

  logger.info('[Learning] Saved learning history');
}

// ── Cleanup ─────────────────────────────────────────────────

async function cleanup() {
  // Old indicator snapshots
  const snapshotResult = await query(`
    DELETE FROM indicator_snapshots
    WHERE created_at < NOW() - INTERVAL '1 day' * $1
  `, [SNAPSHOT_RETENTION_DAYS]);
  if (snapshotResult.rowCount > 0) {
    logger.info(`[Learning] Cleaned ${snapshotResult.rowCount} old indicator snapshots`);
  }

  // Old posted events
  const eventResult = await query(`
    DELETE FROM trade_events
    WHERE posted_to_discord = true AND created_at < NOW() - INTERVAL '30 days'
  `);
  if (eventResult.rowCount > 0) {
    logger.info(`[Learning] Cleaned ${eventResult.rowCount} old trade events`);
  }

  // Deactivate expired learning rules
  const ruleResult = await query(`
    UPDATE learning_rules SET is_active = false
    WHERE is_active = true AND created_at < NOW() - INTERVAL '90 days'
  `);
  if (ruleResult.rowCount > 0) {
    logger.info(`[Learning] Deactivated ${ruleResult.rowCount} expired learning rules`);
  }

  // Delete old deactivated rules (>90 days) to prevent table bloat
  const deleteResult = await query(`
    DELETE FROM learning_rules WHERE is_active = false AND created_at < NOW() - INTERVAL '90 days'
  `);
  if (deleteResult.rowCount > 0) {
    logger.info(`[Learning] Deleted ${deleteResult.rowCount} old deactivated learning rules (>90 days)`);
  }

  // Clean old changelog entries
  const changelogResult = await query(`
    DELETE FROM learning_changelog WHERE created_at < NOW() - INTERVAL '1 day' * $1
  `, [CHANGELOG_RETENTION_DAYS]);
  if (changelogResult.rowCount > 0) {
    logger.info(`[Learning] Cleaned ${changelogResult.rowCount} old changelog entries (>${CHANGELOG_RETENTION_DAYS} days)`);
  }
}

// ── Entry Point ─────────────────────────────────────────────

run().catch(error => {
  logger.error(`[Learning] Fatal error: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});
