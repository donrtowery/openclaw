import dotenv from 'dotenv';
dotenv.config();

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { query, testConnection } from '../db/connection.js';
import { queueEvent } from '../lib/events.js';
import logger from '../lib/logger.js';
import Anthropic from '@anthropic-ai/sdk';
import { extractJSON } from '../lib/claude.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SONNET_MODEL = process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250929';

const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));
const SNAPSHOT_RETENTION_DAYS = config.learning.snapshot_retention_days || 30;
const MISSED_OPP_THRESHOLD = config.learning.missed_opportunity_threshold_pct || 5.0;
const SUSTAINED_CANDLES = config.learning.sustained_candles_required || 6;
const ESC_CONV_TARGET_MIN = config.learning.escalation_conversion_target_min || 15;
const ESC_CONV_TARGET_MAX = config.learning.escalation_conversion_target_max || 30;
const PASS_EVAL_WINDOW_HOURS = config.learning.pass_evaluation_window_hours || 48;
const DEFENSIVE_WIN_RATE_THRESHOLD = config.learning.defensive_mode_win_rate_threshold || 50;
const DEFENSIVE_MAX_ESC_TARGET = config.learning.defensive_mode_max_escalation_target || 15;
const DEFENSIVE_MIN_ESCALATE_RATIO = config.learning.defensive_mode_min_escalate_ratio || 0.2;

async function run() {
  logger.info('[Learning] === Nightly Learning Job Started ===');

  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('[Learning] Database connection failed');
    process.exit(1);
  }

  // ── Step 1: Evaluate outcomes first (so stats reflect latest data) ──

  await updateOutcomes();

  // ── Step 2: Calculate statistics ──────────────────────────

  const stats = await calculateStats();

  logger.info(`[Learning] Stats: ${stats.total_trades} trades, ${stats.win_rate.toFixed(1)}% win rate, $${stats.total_pnl.toFixed(2)} total P&L`);
  logger.info(`[Learning] Missed BUY opportunities: ${stats.missed_opportunities.length} non-escalated, ${stats.missed_pass_decisions.length} Sonnet PASS`);
  logger.info(`[Learning] Missed SELL opportunities: ${stats.missed_sell_opportunities.length} non-escalated, ${stats.missed_sell_pass_decisions.length} Sonnet PASS`);

  const totalEscalated = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.total_escalated), 0);
  const totalTraded = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.led_to_trade), 0);
  const totalPassed = stats.escalation_accuracy.reduce((sum, r) => sum + parseInt(r.passed), 0);
  const escConvRate = totalEscalated > 0 ? (totalTraded / totalEscalated * 100).toFixed(1) : '0.0';
  logger.info(`[Learning] Escalation accuracy: ${totalEscalated} escalated → ${totalTraded} traded (${escConvRate}%), ${totalPassed} PASSed`);
  logger.info(`[Learning] PASS outcomes: ${parseInt(stats.pass_outcome_summary.correct_pass) || 0} CORRECT_PASS, ${parseInt(stats.pass_outcome_summary.missed_opportunity) || 0} MISSED_OPPORTUNITY`);
  logger.info(`[Learning] PASS patterns (Sonnet rejects, min 5 samples): ${stats.pass_patterns.length} | Missed escalation patterns: ${stats.missed_escalation_patterns.length}`);
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

  // ── Step 3: Call Sonnet for analysis (ONE call) ───────────

  const analysis = await callSonnetForAnalysis(stats, defensiveMode, trajectoryRows);

  // ── Step 3b: Validate Sonnet's generated rules ────────────
  // Run validation BEFORE injecting corrective rules so the contradiction
  // detector doesn't strip system-generated calibration rules.

  validateAnalysis(analysis, defensiveMode);

  // ── Step 3c: Enforce escalation conversion rate bounds ────
  // These corrective rules are injected AFTER validation so they are
  // never removed by the contradiction detector.

  const currentEscRate = parseFloat(escConvRate);
  if (defensiveMode) {
    // In defensive mode, corrective rule is ALWAYS a STOP — never push the bot to trade more when losing
    logger.warn(`[Learning] DEFENSIVE MODE: Prepending capital preservation STOP rule (overrides escalation conversion logic)`);
    const corrective = `STOP: DEFENSIVE MODE — win rate ${stats.win_rate.toFixed(1)}%, P&L $${stats.total_pnl.toFixed(2)}. Capital preservation is priority #1. Only escalate HIGH-confidence signals with 3+ strong confirmations. Reject all MODERATE and WEAK signals.`;
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

  await updatePromptFiles(stats, analysis);

  // ── Step 5: Update database ───────────────────────────────

  await saveLearningRules(analysis);
  await saveLearningHistory(stats, analysis);

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
      CASE WHEN p.total_cost > p.entry_cost THEN 'with_dca' ELSE 'no_dca' END as dca_type,
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
      AVG(realized_pnl_percent) as avg_pnl_pct,
      AVG(max_unrealized_gain_percent) as avg_max_gain_pct,
      AVG(hold_hours) as avg_hold_hours
    FROM positions
    WHERE status = 'CLOSED' AND exit_time > NOW() - INTERVAL '30 days'
    GROUP BY exit_category
  `);

  // Missed opportunities: signals not escalated where price moved favorably within 24h
  // Uses indicator_snapshots for actual price data instead of just checking if a trade happened
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
        AND i.created_at < s.created_at + INTERVAL '24 hours'
    ) sub ON true
    WHERE s.escalated = false AND s.signal_type = 'BUY'
      AND s.created_at > NOW() - INTERVAL '30 days'
      AND s.created_at < NOW() - INTERVAL '24 hours'
      AND sub.max_price_24h IS NOT NULL
    ORDER BY potential_gain_pct DESC
    LIMIT 20
  `);

  // Missed SELL opportunities: SELL signals not escalated where price dropped >2% in 24h
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
        AND i.created_at < s.created_at + INTERVAL '24 hours'
    ) sub ON true
    WHERE s.escalated = false AND s.signal_type = 'SELL'
      AND s.created_at > NOW() - INTERVAL '30 days'
      AND s.created_at < NOW() - INTERVAL '24 hours'
      AND sub.min_price_24h IS NOT NULL
    ORDER BY potential_drop_pct DESC
    LIMIT 20
  `);

  // Missed PASS decisions: Sonnet passed on BUY signals where price rose >2% in 24h
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
        AND i.created_at < s.created_at + INTERVAL '24 hours'
    ) sub ON true
    WHERE d.action = 'PASS' AND s.signal_type = 'BUY'
      AND d.created_at > NOW() - INTERVAL '30 days'
      AND d.created_at < NOW() - INTERVAL '24 hours'
      AND sub.max_price_24h IS NOT NULL
      AND s.price > 0
      AND ((sub.max_price_24h - s.price) / s.price * 100) > $1
    ORDER BY potential_gain_pct DESC
    LIMIT 20
  `, [MISSED_OPP_THRESHOLD]);

  // Missed SELL PASS decisions: Sonnet passed on SELL signals where price dropped >threshold in 24h
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
        AND i.created_at < s.created_at + INTERVAL '24 hours'
    ) sub ON true
    WHERE d.action = 'PASS' AND s.signal_type = 'SELL'
      AND d.created_at > NOW() - INTERVAL '30 days'
      AND d.created_at < NOW() - INTERVAL '24 hours'
      AND sub.min_price_24h IS NOT NULL
      AND s.price > 0
      AND ((s.price - sub.min_price_24h) / s.price * 100) > $1
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
    HAVING COUNT(CASE WHEN d.outcome IN ('CORRECT_PASS', 'MISSED_OPPORTUNITY') THEN 1 END) >= 5
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
    profit_factor: totalLossesPnl > 0 ? totalWinsPnl / totalLossesPnl : totalWinsPnl > 0 ? Infinity : 0,
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
  };
}

// ── Sonnet Analysis Call ────────────────────────────────────

async function callSonnetForAnalysis(stats, defensiveMode = false, trajectoryRows = []) {
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
    prompt += `Profit factor: ${stats.profit_factor === Infinity ? '∞' : stats.profit_factor.toFixed(2)}\n`;
    prompt += `Hold time: Winners ${stats.avg_hold_winners.toFixed(1)}h, Losers ${stats.avg_hold_losers.toFixed(1)}h\n`;
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
    prompt = `This is a new trading bot with no closed trades yet. Analyze the signal data below — especially missed opportunities — to generate initial rules and calibrate aggressiveness.\n\n`;
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

  // Missed opportunities — consolidated into one section with type markers
  const allMissed = [];
  const missedNonEscalated = stats.missed_opportunities.filter(m => parseFloat(m.potential_gain_pct) > MISSED_OPP_THRESHOLD);
  for (const m of missedNonEscalated.slice(0, 5)) {
    allMissed.push(`[NOT_ESC] ${m.symbol} ${m.strength} conf:${m.confidence} +${parseFloat(m.potential_gain_pct).toFixed(1)}%`);
  }
  for (const m of stats.missed_pass_decisions.slice(0, 5)) {
    allMissed.push(`[SONNET_PASS] ${m.symbol} Haiku:${m.haiku_strength} conf:${m.haiku_conf} +${parseFloat(m.potential_gain_pct).toFixed(1)}%`);
  }
  const missedSellNonEscalated = stats.missed_sell_opportunities.filter(m => parseFloat(m.potential_drop_pct) > MISSED_OPP_THRESHOLD);
  for (const m of missedSellNonEscalated.slice(0, 3)) {
    allMissed.push(`[SELL_NOT_ESC] ${m.symbol} ${m.strength} -${parseFloat(m.potential_drop_pct).toFixed(1)}%`);
  }
  for (const m of stats.missed_sell_pass_decisions.slice(0, 3)) {
    allMissed.push(`[SELL_PASS] ${m.symbol} Haiku:${m.haiku_strength} -${parseFloat(m.potential_drop_pct).toFixed(1)}%`);
  }
  if (allMissed.length > 0) {
    prompt += `MISSED OPPORTUNITIES (price moved >${MISSED_OPP_THRESHOLD}% sustained for ${SUSTAINED_CANDLES}+ candles in 24h):\n`;
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

  prompt += `HOW TO INTERPRET:\n`;
  prompt += `- Haiku over-escalates → Sonnet correctly passes → reduce Haiku escalation for that pattern\n`;
  prompt += `- Haiku escalates → Sonnet wrongly passes (MISSED_OPPORTUNITY) → Sonnet was wrong, NOT Haiku\n`;
  prompt += `- Haiku doesn't escalate → price moves favorably → Haiku was too conservative\n`;
  prompt += `- A healthy system has ${ESC_CONV_TARGET_MIN}-${ESC_CONV_TARGET_MAX}% escalation conversion rate. 100% conversion = too conservative.\n\n`;

  // Patterns Sonnet consistently passes on
  if (stats.pass_patterns.length > 0) {
    prompt += `PATTERNS SONNET CONSISTENTLY PASSES (>=70% PASS rate, min 5 samples):\n`;
    for (const p of stats.pass_patterns) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      prompt += `${triggers} (${p.trend}) ${p.strength}: ${p.total} escalated, ${p.pass_rate}% PASSed\n`;
    }
    prompt += '\n';
  }

  // Sonnet's MISSED_OPPORTUNITY decisions — framed as SONNET ERRORS
  if (stats.missed_pass_decisions.length > 0) {
    prompt += `SONNET BUY ERRORS (wrong to pass — price rose >${MISSED_OPP_THRESHOLD}% sustained):\n`;
    for (const m of stats.missed_pass_decisions.slice(0, 5)) {
      prompt += `${m.symbol} Haiku:${m.haiku_strength} conf:${m.haiku_conf} → passed → +${parseFloat(m.potential_gain_pct).toFixed(1)}% | ${(m.reasoning || '').substring(0, 60)}\n`;
    }
    prompt += '\n';
  }

  // Sonnet's MISSED SELL decisions
  if (stats.missed_sell_pass_decisions.length > 0) {
    prompt += `SONNET SELL ERRORS (wrong to pass — price dropped >${MISSED_OPP_THRESHOLD}% sustained):\n`;
    for (const m of stats.missed_sell_pass_decisions.slice(0, 5)) {
      prompt += `${m.symbol} Haiku:${m.haiku_strength} conf:${m.haiku_conf} → passed → -${parseFloat(m.potential_drop_pct).toFixed(1)}% | ${(m.reasoning || '').substring(0, 60)}\n`;
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
  prompt += `- Haiku receives a 4-line compact format per signal:\n`;
  prompt += `  Line 1: symbol, price, trend direction + strength\n`;
  prompt += `  Line 2: RSI value + signal (oversold/overbought/neutral), MACD crossover (bullish/bearish), volume ratio + trend\n`;
  prompt += `  Line 3: price vs SMA200, golden-cross/death-cross, EMA signal (bullish/bearish), BB position + width\n`;
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
  prompt += `- If you want to restrict a broad category, use multiple specific rules instead of one blanket rule\n\n`;

  if (defensiveMode) {
    prompt += `CONSTRAINTS: Max 15 haiku_rules (combined). >=60% MUST be STOP/REJECT/REDUCE (DEFENSIVE MODE). Max escalation target: ${DEFENSIVE_MAX_ESC_TARGET}%. No STOP rules with <5 samples. LOSING TRADE PATTERNS are the #1 priority — generate REJECT/REDUCE rules for every losing pattern. START rules allowed ONLY for patterns with >70% WR and positive P&L. Include SELL-side rules. No duplicate rules.\n\n`;
    prompt += `Focus on: CAPITAL PRESERVATION. What is losing money? What patterns should be stopped? Which losing trades should never have been taken? Only promote patterns with strong evidence of profitability (>70% WR, positive P&L, 5+ samples). Do NOT generate rules to trade more.`;
  } else {
    prompt += `CONSTRAINTS: Max 15 haiku_rules (combined). >=40% must be ESCALATE/START. Target ${ESC_CONV_TARGET_MIN}-${ESC_CONV_TARGET_MAX}% escalation conversion. No STOP rules with <5 samples. MISSED_OPPORTUNITY = Sonnet error, not Haiku. No blanket rejections — only STOP patterns with confirmed CORRECT_PASS (price didn't move). Include SELL-side rules. No duplicate rules. LOSING TRADE PATTERNS must generate REJECT/REDUCE rules — do not only focus on missed opportunities.\n\n`;

    if (hasTrades) {
      prompt += `Focus on: >70% WR patterns (promote), <40% WR patterns (warn), missed opportunities (both non-escalated and Sonnet PASS), optimal hold times, DCA effectiveness.`;
    } else {
      prompt += `Focus on: missed opportunities (what should have been escalated or bought), signal quality (which triggers produce real moves), and calibrating Haiku escalation thresholds and Sonnet confidence. The bot may be too conservative — analyze whether passes were justified.`;
    }
  }

  try {
    const message = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 8192,
      system: [{ type: 'text', text: 'You are a conservative trading performance analyst for a utility-focused crypto bot. Quality over quantity — never bias toward more trading. Losing trades matter as much as missed opportunities. Respond with valid JSON only. Be concise — short rule strings, no lengthy explanations.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text;
    logger.info(`[Learning] Sonnet analysis: ${message.usage.input_tokens}in/${message.usage.output_tokens}out tokens, stop_reason: ${message.stop_reason}`);

    if (message.stop_reason === 'max_tokens') {
      logger.warn(`[Learning] Sonnet response truncated at max_tokens — JSON may be incomplete`);
    }

    let parsed;
    try {
      parsed = extractJSON(text);
    } catch (parseError) {
      logger.error(`[Learning] Failed to parse Sonnet response: ${parseError.message}`);
      logger.warn(`[Learning] Returning empty analysis — prompts will not be updated this cycle`);
      return {
        haiku_rules: [],
        sonnet_rules: [],
        haiku_escalation_calibration: [],
        haiku_few_shots: [],
        sonnet_few_shots: [],
        rule_changes: 'Parse failure — no changes this cycle',
      };
    }
    return parsed;
  } catch (error) {
    logger.error(`[Learning] Sonnet call failed: ${error.message}`);
    throw error;
  }
}

// ── Rule Validator ──────────────────────────────────────────

function validateAnalysis(analysis, defensiveMode = false) {
  const haikuRules = toArray(analysis.haiku_rules);
  const calibrationRules = toArray(analysis.haiku_escalation_calibration);
  const allHaikuRules = [...haikuRules, ...calibrationRules];
  const issues = [];

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

  // Check ESCALATE/START ratio — threshold depends on defensive mode
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

  // Remove STOP rules that reference <5 samples
  const filterLowSampleRules = (rules) => {
    return rules.filter(r => {
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      const upper = text.toUpperCase();
      if (!upper.startsWith('STOP') && !upper.startsWith('SKIP') && !upper.startsWith('REJECT')) return true;
      // Try to extract sample count from rule text
      const sampleMatch = text.match(/(\d+)\s*(trade|sample|evaluated|case)/i);
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
  const SPECIFIC_KEYWORDS = /\b(T[12]|RSI|MACD|BB|VOLUME|EMA|SMA200|GOLDEN.CROSS|DEATH.CROSS|SUPPORT|RESISTANCE)\b/gi;

  for (const approve of approveRules) {
    for (const reject of rejectRules) {
      // Extract only specific indicator keywords (not generic strength terms)
      const approveKeywords = [...new Set((approve.text.toUpperCase().match(SPECIFIC_KEYWORDS) || []).map(k => k.replace(/[.-]/g, '_')))];
      const rejectKeywords = [...new Set((reject.text.toUpperCase().match(SPECIFIC_KEYWORDS) || []).map(k => k.replace(/[.-]/g, '_')))];

      if (approveKeywords.length >= 2 && rejectKeywords.length >= 2) {
        const overlap = approveKeywords.filter(k => rejectKeywords.includes(k));
        // Require 3+ specific indicator overlaps AND matching tier/strength for a true contradiction.
        // Without tier/strength matching, rules targeting different contexts are falsely flagged.
        const approveUpper = approve.text.toUpperCase();
        const rejectUpper = reject.text.toUpperCase();
        const sameTier = (approveUpper.includes('T1') && rejectUpper.includes('T1')) ||
                         (approveUpper.includes('T2') && rejectUpper.includes('T2')) ||
                         (!approveUpper.match(/\bT[12]\b/) && !rejectUpper.match(/\bT[12]\b/));
        const sameStrength = ['STRONG', 'MODERATE', 'WEAK'].some(s =>
          approveUpper.includes(s) && rejectUpper.includes(s));
        if (overlap.length >= 3 && (sameTier || sameStrength)) {
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

async function updatePromptFiles(stats, analysis) {
  const date = new Date().toISOString().split('T')[0];

  // Shared performance header
  let perfHeader = `\n## LEARNING DATA\n`;
  perfHeader += `(Updated: ${date} | ${stats.total_trades} trades | ${stats.win_rate.toFixed(1)}% win rate)\n\n`;
  perfHeader += `PERFORMANCE:\n`;
  perfHeader += `- ${stats.win_rate.toFixed(1)}% WR (${stats.wins}W/${stats.losses}L) | PF: ${stats.profit_factor === Infinity ? '∞' : stats.profit_factor.toFixed(2)}\n`;
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

  // START escalating patterns
  if (stats.missed_escalation_patterns.length > 0) {
    haikuSection += `START ESCALATING (you filtered these out but price moved favorably):\n`;
    for (const p of stats.missed_escalation_patterns.slice(0, 5)) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      haikuSection += `- ${triggers} (${p.trend}) ${p.strength}: ${p.total} missed, avg +${parseFloat(p.avg_gain_pct).toFixed(1)}% gain\n`;
    }
    haikuSection += '\n';
  }

  // SONNET WAS WRONG section — show MISSED_OPPORTUNITY PASS decisions
  if (stats.missed_pass_decisions.length > 0) {
    haikuSection += `SONNET WAS WRONG (these PASSed signals SHOULD have been escalated — Sonnet erred, not you):\n`;
    for (const m of stats.missed_pass_decisions.slice(0, 5)) {
      haikuSection += `- ${m.symbol} ${m.haiku_strength} conf:${m.haiku_conf} → Sonnet passed → price rose +${parseFloat(m.potential_gain_pct).toFixed(1)}%`;
      if (m.reasoning) haikuSection += ` | Sonnet's reason: ${m.reasoning.substring(0, 80)}`;
      haikuSection += '\n';
    }
    haikuSection += `Keep escalating signals like these — Sonnet needs to see them.\n\n`;
  }

  // Missed SELL signals — Haiku didn't escalate SELL signals but price dropped
  if (stats.missed_sell_pass_decisions.length > 0) {
    haikuSection += `MISSED SELL SIGNALS (you didn't escalate these SELL signals but price dropped):\n`;
    for (const m of stats.missed_sell_pass_decisions.slice(0, 5)) {
      haikuSection += `- ${m.symbol} ${m.haiku_strength} conf:${m.haiku_conf} → Sonnet passed → price dropped -${parseFloat(m.potential_drop_pct).toFixed(1)}%`;
      if (m.reasoning) haikuSection += ` | Sonnet's reason: ${m.reasoning.substring(0, 80)}`;
      haikuSection += '\n';
    }
    haikuSection += `Escalate SELL signals for existing positions — missed sells mean unrealized losses.\n\n`;
  } else if (stats.missed_sell_opportunities.length > 0) {
    const missedSellFiltered = stats.missed_sell_opportunities.filter(m => parseFloat(m.potential_drop_pct) > MISSED_OPP_THRESHOLD);
    if (missedSellFiltered.length > 0) {
      haikuSection += `MISSED SELL SIGNALS (you didn't escalate these SELL signals but price dropped):\n`;
      for (const m of missedSellFiltered.slice(0, 5)) {
        haikuSection += `- ${m.symbol} ${m.strength} conf:${m.confidence} @ $${parseFloat(m.signal_price).toFixed(4)} → min $${parseFloat(m.min_price_24h).toFixed(4)} (-${parseFloat(m.potential_drop_pct).toFixed(1)}%)\n`;
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
  const sonnetRules = analysis.sonnet_rules || [];

  // ── Sonnet section with losing trade patterns ──
  let sonnetSection = perfHeader;
  if (stats.losing_patterns.length > 0) {
    sonnetSection += `BAD TRADE PATTERNS (these setups consistently lost money — REJECT or REDUCE):\n`;
    for (const p of stats.losing_patterns.slice(0, 5)) {
      const triggers = Array.isArray(p.triggered_by) ? p.triggered_by.join('+') : p.triggered_by;
      sonnetSection += `- ${triggers} (${p.trend}) ${p.strength}: ${p.losses}/${p.total} lost, avg $${parseFloat(p.avg_loss_usd).toFixed(2)}\n`;
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
    if (stats.avg_hold_losers > stats.avg_hold_winners * 1.3 && stats.avg_hold_losers > 0) {
      exitSection += `- WARNING: Losers held ${((stats.avg_hold_losers / stats.avg_hold_winners - 1) * 100).toFixed(0)}% longer than winners — cut losses faster\n`;
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
    const words = new Set(normalized.split(' ').filter(w => w.length > 2));
    let isDuplicate = false;
    for (const existing of seen) {
      const existingWords = new Set(existing.split(' ').filter(w => w.length > 2));
      const intersection = [...words].filter(w => existingWords.has(w));
      const overlap = Math.max(words.size, existingWords.size) > 0
        ? intersection.length / Math.min(words.size, existingWords.size)
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
      section += `${i + 1}. ${flattenRule(cappedRules[i])}\n`;
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
  await query('BEGIN');
  try {
  // Update signals that led to winning trades
  await query(`
    UPDATE signals SET outcome = 'WIN', outcome_pnl = p.realized_pnl
    FROM decisions d
    JOIN positions p ON p.open_decision_id = d.id
    WHERE signals.id = d.signal_id
    AND p.status = 'CLOSED' AND p.realized_pnl > 0
    AND signals.outcome = 'PENDING'
  `);

  // Update signals that led to losing trades
  await query(`
    UPDATE signals SET outcome = 'LOSS', outcome_pnl = p.realized_pnl
    FROM decisions d
    JOIN positions p ON p.open_decision_id = d.id
    WHERE signals.id = d.signal_id
    AND p.status = 'CLOSED' AND p.realized_pnl < 0
    AND signals.outcome = 'PENDING'
  `);

  // Update decisions that led to wins/losses
  await query(`
    UPDATE decisions SET outcome = 'WIN', outcome_pnl = p.realized_pnl
    FROM positions p
    WHERE p.open_decision_id = decisions.id
    AND p.status = 'CLOSED' AND p.realized_pnl > 0
    AND decisions.outcome = 'PENDING'
  `);

  await query(`
    UPDATE decisions SET outcome = 'LOSS', outcome_pnl = p.realized_pnl
    FROM positions p
    WHERE p.open_decision_id = decisions.id
    AND p.status = 'CLOSED' AND p.realized_pnl < 0
    AND decisions.outcome = 'PENDING'
  `);

  // Update signals for breakeven trades
  await query(`
    UPDATE signals SET outcome = 'NEUTRAL', outcome_pnl = 0
    FROM decisions d
    JOIN positions p ON p.open_decision_id = d.id
    WHERE signals.id = d.signal_id
    AND p.status = 'CLOSED' AND p.realized_pnl = 0
    AND signals.outcome = 'PENDING'
  `);

  // Update decisions for breakeven trades
  await query(`
    UPDATE decisions SET outcome = 'NEUTRAL', outcome_pnl = 0
    FROM positions p
    WHERE p.open_decision_id = decisions.id
    AND p.status = 'CLOSED' AND p.realized_pnl = 0
    AND decisions.outcome = 'PENDING'
  `);

  // PASS decisions older than configured window: evaluate against actual price movement
  // BUY signals where price rose >threshold% sustained for N candles → MISSED_OPPORTUNITY
  const missedBuys = await query(`
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
        AND i.created_at < s.created_at + INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
      WHERE d2.action = 'PASS' AND d2.outcome = 'PENDING'
        AND s.signal_type = 'BUY'
        AND d2.created_at < NOW() - INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
      GROUP BY d2.id, s.price, s.symbol, s.created_at
      HAVING s.price > 0 AND ((MAX(i.price) - s.price) / s.price * 100) > $1
        AND (SELECT COUNT(*) FROM indicator_snapshots i2
             WHERE i2.symbol = s.symbol
               AND i2.created_at > s.created_at
               AND i2.created_at < s.created_at + INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
               AND ((i2.price - s.price) / s.price * 100) > $1
            ) >= $2
    ) sub
    WHERE d.id = sub.decision_id
  `, [MISSED_OPP_THRESHOLD, SUSTAINED_CANDLES]);
  if (missedBuys.rowCount > 0) {
    logger.info(`[Learning] Marked ${missedBuys.rowCount} BUY PASS decisions as MISSED_OPPORTUNITY`);
  }

  // SELL signals where price dropped >threshold% sustained for N candles → MISSED_OPPORTUNITY
  const missedSells = await query(`
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
        AND i.created_at < s.created_at + INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
      WHERE d2.action = 'PASS' AND d2.outcome = 'PENDING'
        AND s.signal_type = 'SELL'
        AND d2.created_at < NOW() - INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
      GROUP BY d2.id, s.price, s.symbol, s.created_at
      HAVING s.price > 0 AND ((s.price - MIN(i.price)) / s.price * 100) > $1
        AND (SELECT COUNT(*) FROM indicator_snapshots i2
             WHERE i2.symbol = s.symbol
               AND i2.created_at > s.created_at
               AND i2.created_at < s.created_at + INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
               AND ((s.price - i2.price) / s.price * 100) > $1
            ) >= $2
    ) sub
    WHERE d.id = sub.decision_id
  `, [MISSED_OPP_THRESHOLD, SUSTAINED_CANDLES]);
  if (missedSells.rowCount > 0) {
    logger.info(`[Learning] Marked ${missedSells.rowCount} SELL PASS decisions as MISSED_OPPORTUNITY`);
  }

  // Remaining PASS decisions older than evaluation window: mark as CORRECT_PASS
  await query(`
    UPDATE decisions SET outcome = 'CORRECT_PASS'
    WHERE action = 'PASS' AND outcome = 'PENDING'
    AND created_at < NOW() - INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
  `);

  // Also tag non-escalated BUY signals that moved >threshold% sustained as MISSED_OPPORTUNITY
  const missedBuySignals = await query(`
    UPDATE signals s SET
      outcome = 'MISSED_OPPORTUNITY',
      outcome_pnl = sub.gain_pct
    FROM (
      SELECT s2.id as signal_id,
        ((MAX(i.price) - s2.price) / s2.price * 100) as gain_pct
      FROM signals s2
      LEFT JOIN indicator_snapshots i ON i.symbol = s2.symbol
        AND i.created_at > s2.created_at
        AND i.created_at < s2.created_at + INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
      WHERE s2.escalated = false AND s2.signal_type = 'BUY'
        AND s2.outcome = 'PENDING'
        AND s2.created_at < NOW() - INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
      GROUP BY s2.id, s2.price, s2.symbol, s2.created_at
      HAVING s2.price > 0 AND ((MAX(i.price) - s2.price) / s2.price * 100) > $1
        AND (SELECT COUNT(*) FROM indicator_snapshots i2
             WHERE i2.symbol = s2.symbol
               AND i2.created_at > s2.created_at
               AND i2.created_at < s2.created_at + INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
               AND ((i2.price - s2.price) / s2.price * 100) > $1
            ) >= $2
    ) sub
    WHERE s.id = sub.signal_id
  `, [MISSED_OPP_THRESHOLD, SUSTAINED_CANDLES]);
  if (missedBuySignals.rowCount > 0) {
    logger.info(`[Learning] Marked ${missedBuySignals.rowCount} non-escalated BUY signals as MISSED_OPPORTUNITY`);
  }

  // Also tag non-escalated SELL signals where price dropped >threshold% sustained as MISSED_OPPORTUNITY
  const missedSellSignals = await query(`
    UPDATE signals s SET
      outcome = 'MISSED_OPPORTUNITY',
      outcome_pnl = sub.drop_pct
    FROM (
      SELECT s2.id as signal_id,
        ((s2.price - MIN(i.price)) / s2.price * 100) as drop_pct
      FROM signals s2
      LEFT JOIN indicator_snapshots i ON i.symbol = s2.symbol
        AND i.created_at > s2.created_at
        AND i.created_at < s2.created_at + INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
      WHERE s2.escalated = false AND s2.signal_type = 'SELL'
        AND s2.outcome = 'PENDING'
        AND s2.created_at < NOW() - INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
      GROUP BY s2.id, s2.price, s2.symbol, s2.created_at
      HAVING s2.price > 0 AND ((s2.price - MIN(i.price)) / s2.price * 100) > $1
        AND (SELECT COUNT(*) FROM indicator_snapshots i2
             WHERE i2.symbol = s2.symbol
               AND i2.created_at > s2.created_at
               AND i2.created_at < s2.created_at + INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
               AND ((s2.price - i2.price) / s2.price * 100) > $1
            ) >= $2
    ) sub
    WHERE s.id = sub.signal_id
  `, [MISSED_OPP_THRESHOLD, SUSTAINED_CANDLES]);
  if (missedSellSignals.rowCount > 0) {
    logger.info(`[Learning] Marked ${missedSellSignals.rowCount} non-escalated SELL signals as MISSED_OPPORTUNITY`);
  }

  // Remaining non-escalated signals older than evaluation window: mark as NOT_TRADED
  await query(`
    UPDATE signals SET outcome = 'NOT_TRADED'
    WHERE escalated = false AND outcome = 'PENDING'
    AND created_at < NOW() - INTERVAL '${PASS_EVAL_WINDOW_HOURS} hours'
  `);

  await query('COMMIT');
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
  logger.info('[Learning] Outcomes updated');
}

// ── Database Rule Saver ─────────────────────────────────────

const toArray = (val) => Array.isArray(val) ? val : [];

async function saveLearningRules(analysis) {
  try {
    await query('BEGIN');

    // Deactivate old rules (>7 days)
    await query(`
      UPDATE learning_rules SET is_active = false
      WHERE is_active = true AND created_at < NOW() - INTERVAL '7 days'
    `);

    // Deactivate all current rules of the types we're about to insert (prevents duplicates)
    const typesToReplace = [];
    if (toArray(analysis.haiku_rules).length > 0) typesToReplace.push('haiku_escalation');
    if (toArray(analysis.sonnet_rules).length > 0) typesToReplace.push('sonnet_decision');
    if (toArray(analysis.haiku_escalation_calibration).length > 0) typesToReplace.push('haiku_calibration');
    if (typesToReplace.length > 0) {
      const deactivated = await query(`
        UPDATE learning_rules SET is_active = false
        WHERE is_active = true AND rule_type = ANY($1)
      `, [typesToReplace]);
      if (deactivated.rowCount > 0) {
        logger.info(`[Learning] Deactivated ${deactivated.rowCount} old rules for types: ${typesToReplace.join(', ')}`);
      }
    }

    const allRules = [
      ...toArray(analysis.haiku_rules).map(r => ({ type: 'haiku_escalation', text: typeof r === 'string' ? r : JSON.stringify(r) })),
      ...toArray(analysis.sonnet_rules).map(r => ({ type: 'sonnet_decision', text: typeof r === 'string' ? r : JSON.stringify(r) })),
      ...toArray(analysis.haiku_escalation_calibration).map(r => ({ type: 'haiku_calibration', text: typeof r === 'string' ? r : JSON.stringify(r) })),
    ];

    // Reset sequence to avoid PK conflicts (can drift after manual inserts or partial failures)
    await query(`SELECT setval(pg_get_serial_sequence('learning_rules', 'id'), COALESCE((SELECT MAX(id) FROM learning_rules), 0) + 1, false)`);

    for (const rule of allRules) {
      await query(`
        INSERT INTO learning_rules (rule_type, rule_text, is_active, created_at)
        VALUES ($1, $2, true, NOW())
        ON CONFLICT (id) DO UPDATE SET
          rule_type = EXCLUDED.rule_type,
          rule_text = EXCLUDED.rule_text,
          is_active = true,
          created_at = NOW()
      `, [rule.type, rule.text]);
    }

    await query('COMMIT');
    logger.info(`[Learning] Saved ${allRules.length} learning rules`);
  } catch (error) {
    await query('ROLLBACK').catch(() => {});
    logger.error(`[Learning] saveLearningRules failed, rolled back: ${error.message}`);
    throw error;
  }
}

async function saveLearningHistory(stats, analysis) {
  const today = new Date().toISOString().split('T')[0];
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
      return wr >= 70;
    })),
    JSON.stringify(stats.pattern_stats.filter(p => {
      const wr = parseInt(p.total) > 0 ? parseInt(p.wins) / parseInt(p.total) * 100 : 0;
      return wr < 40;
    })),
    true, true,
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
}

// ── Entry Point ─────────────────────────────────────────────

run().catch(error => {
  logger.error(`[Learning] Fatal error: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});
