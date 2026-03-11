import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { query, endPool } from '../db/connection.js';
import { testConnection } from '../db/connection.js';
import { testConnectivity, placeOrder, getCurrentPrice, getAllPrices } from '../lib/binance.js';
import { initScanner, runScanCycle } from '../lib/scanner.js';
import { callHaikuBatch, callSonnet, callSonnetExitEval, resetApiCosts } from '../lib/claude.js';
import { runExitScan, recordExitCooldown } from '../lib/exit-scanner.js';
import { getNewsContext } from '../lib/brave-search.js';
import {
  openPosition, addToPosition, closePosition,
  getOpenPositions, getPositionBySymbol, getPortfolioSummary,
} from '../lib/position-manager.js';
import { queueEvent } from '../lib/events.js';
import { sendAlert } from '../lib/sms.js';
import { analyzeSymbol } from '../lib/technical-analysis.js';
import logger from '../lib/logger.js';

// ── Config ──────────────────────────────────────────────────

const tradingConfig = JSON.parse(readFileSync('config/trading.json', 'utf8'));

// Sync PAPER_TRADING env with config so lib/binance.js reads the same source of truth
process.env.PAPER_TRADING = String(tradingConfig.account.paper_trading);

// ── State ───────────────────────────────────────────────────

let isRunning = false;
let scanIntervalId = null;
let stopLossIntervalId = null;
let cycleCount = 0;
let cycleInProgress = false;

// Symbol name lookup (filled on init)
const symbolNames = new Map(); // ETHUSDT -> Ethereum

// Per-cycle portfolio summary cache — invalidated after each trade execution
let portfolioCache = null;
let portfolioCachePromise = null; // prevents concurrent fetches

// Sonnet deduplication — tracks last escalation time per symbol
const lastSonnetEvaluation = new Map();

// Daily trade counter — resets at midnight UTC
let dailyTradeCount = 0;
let dailyTradeDate = new Date().toISOString().split('T')[0];

// Per-symbol position locking — prevents concurrent buy/sell/DCA on same symbol
const positionLocks = new Map();

async function withPositionLock(symbol, fn) {
  while (positionLocks.has(symbol)) {
    await positionLocks.get(symbol).catch(() => {});
  }
  let resolve;
  const lockPromise = new Promise(r => { resolve = r; });
  positionLocks.set(symbol, lockPromise);
  try {
    return await fn();
  } finally {
    positionLocks.delete(symbol);
    resolve();
  }
}

// ── Startup ─────────────────────────────────────────────────

async function start() {
  logger.info('=== OpenClaw v2 Trading Engine Starting ===');

  // 1. Test database
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('Database connection failed — aborting');
    process.exit(1);
  }

  // 2. Test Binance
  const binanceOk = await testConnectivity();
  if (!binanceOk) {
    logger.error('Binance connection failed — aborting');
    process.exit(1);
  }

  // 3. Load symbol names for news searches
  const symbolResult = await query('SELECT symbol, name FROM symbols WHERE is_active = true');
  for (const row of symbolResult.rows) {
    symbolNames.set(row.symbol, row.name);
  }

  // 4. Restore daily trade counter from DB (survives restarts)
  const todayTradesResult = await query(
    "SELECT COUNT(*) as cnt FROM trades WHERE executed_at >= CURRENT_DATE"
  );
  dailyTradeCount = parseInt(todayTradesResult.rows[0].cnt) || 0;
  if (dailyTradeCount > 0) {
    logger.info(`[Engine] Restored daily trade count: ${dailyTradeCount} trades today`);
  }

  // 5. Startup state reconciliation
  await reconcileState();

  // 6. Initialize scanner
  await initScanner();

  // 7. Queue engine start event
  await queueEvent('ENGINE_START', null, {
    paper_trading: tradingConfig.account.paper_trading,
    symbols: symbolResult.rows.length,
    capital: tradingConfig.account.total_capital,
  });

  // 8. Set up graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 9. Start scan loop
  isRunning = true;
  const intervalMs = (tradingConfig.scanner.interval_minutes || 5) * 60 * 1000;

  logger.info(`Trading engine running — scanning every ${tradingConfig.scanner.interval_minutes} minutes`);
  logger.info(`Paper trading: ${tradingConfig.account.paper_trading}`);
  logger.info(`Capital: $${tradingConfig.account.total_capital} | Max positions: ${tradingConfig.account.max_concurrent_positions}`);

  // Run first scan immediately (catch transient errors like subsequent cycles do)
  try {
    cycleInProgress = true;
    await runCycle();
  } catch (error) {
    logger.error(`[Engine] First cycle error: ${error.message}`);
    logger.error(error.stack);
  } finally {
    cycleInProgress = false;
  }

  // Then schedule recurring scans
  scanIntervalId = setInterval(async () => {
    if (!isRunning) return;
    if (cycleInProgress) {
      logger.warn('[Engine] Previous cycle still running — skipping this interval');
      return;
    }
    try {
      cycleInProgress = true;
      await runCycle();
    } catch (error) {
      logger.error(`[Engine] Cycle error: ${error.message}`);
      logger.error(error.stack);
    } finally {
      cycleInProgress = false;
    }
  }, intervalMs);

  // 10. Start emergency stop-loss monitor (independent of scan cycle)
  const stopLossConfig = tradingConfig.emergency_stop_loss || {};
  if (stopLossConfig.enabled !== false) {
    const stopLossIntervalMs = stopLossConfig.check_interval_ms || 30000;
    stopLossIntervalId = setInterval(runEmergencyStopCheck, stopLossIntervalMs);
    logger.info(`Emergency stop-loss monitor active — checking every ${stopLossIntervalMs / 1000}s (T1: ${stopLossConfig.tier_1_percent ?? -20}%, T2: ${stopLossConfig.tier_2_percent ?? -15}%)`);
  }
}

// ── Portfolio Cache ──────────────────────────────────────────

async function getCachedPortfolio() {
  if (portfolioCache) return portfolioCache;
  // Prevent concurrent fetches — second caller awaits the same promise
  if (!portfolioCachePromise) {
    portfolioCachePromise = getPortfolioSummary(tradingConfig).then(result => {
      portfolioCache = result;
      portfolioCachePromise = null;
      return result;
    }).catch(err => {
      portfolioCachePromise = null;
      throw err;
    });
  }
  return portfolioCachePromise;
}

function invalidatePortfolioCache() {
  portfolioCache = null;
  portfolioCachePromise = null;
}

// ── Main Scan Cycle ─────────────────────────────────────────

async function runCycle() {
  cycleCount++;
  const cycleStart = Date.now();
  invalidatePortfolioCache();
  recordHeartbeat();

  // Prune stale Sonnet dedup entries (older than 2x dedup window)
  const dedupTTL = (tradingConfig.escalation.sonnet_dedup_minutes || 30) * 2 * 60 * 1000;
  for (const [sym, ts] of lastSonnetEvaluation) {
    if (cycleStart - ts > dedupTTL) lastSonnetEvaluation.delete(sym);
  }

  logger.info(`[Engine] === Cycle ${cycleCount} ===`);

  // 0. Reset daily trade counter at midnight UTC
  const today = new Date().toISOString().split('T')[0];
  if (today !== dailyTradeDate) {
    logger.info(`[Engine] New trading day ${today} — resetting daily trade count (was ${dailyTradeCount})`);
    dailyTradeCount = 0;
    dailyTradeDate = today;
    resetApiCosts();
    logger.info(`[Engine] API cost tracker reset for new day`);
  }

  // 0b. Check max trades per day — block new entries but ALWAYS allow exit scans
  const maxTradesPerDay = tradingConfig.account.max_trades_per_day || 20;
  let skipNewEntries = false;
  if (dailyTradeCount >= maxTradesPerDay) {
    logger.warn(`[Engine] Daily trade limit reached (${dailyTradeCount}/${maxTradesPerDay}). Blocking new entries only.`);
    skipNewEntries = true;
  }

  // 1. Check circuit breaker and drawdown — block new entries but ALWAYS allow exit scans
  const cb = await checkCircuitBreaker();
  const maxDrawdownPct = tradingConfig.circuit_breaker.max_drawdown_percent || 10;
  const drawdownPortfolio = await getCachedPortfolio();
  // Use unrealized P&L only for drawdown — all-time realized losses would permanently block entries
  const drawdownActive = drawdownPortfolio.unrealized_pnl_percent < -maxDrawdownPct;
  skipNewEntries = skipNewEntries || cb.is_active || drawdownActive;

  if (cb.is_active) {
    logger.warn(`[Engine] Circuit breaker ACTIVE (${cb.consecutive_losses} losses). Blocking new entries. Reactivates: ${cb.reactivates_at}`);
  }
  if (drawdownActive) {
    logger.warn(`[Engine] DRAWDOWN PROTECTION: unrealized P&L ${drawdownPortfolio.unrealized_pnl_percent.toFixed(2)}% exceeds -${maxDrawdownPct}% limit. Blocking new entries.`);
    await queueEvent('DRAWDOWN_PAUSE', null, {
      unrealized_pnl_percent: drawdownPortfolio.unrealized_pnl_percent,
      max_drawdown_percent: maxDrawdownPct,
    });
  }

  // 2. Run scanner (skip if entries blocked — but exit scan still runs below)
  let signalsEscalated = 0;
  let tradesExecuted = 0;

  if (!skipNewEntries) {
  try {
  const scanResult = await runScanCycle(tradingConfig);
  logger.info(`[Engine] Scanned ${scanResult.symbols_scanned} symbols in ${scanResult.duration_ms}ms — ${scanResult.triggered.length} triggered`);

  // 3. Process triggered signals through Haiku (batched)

  if (scanResult.triggered.length > 0) {
    // Inject market regime into triggered signals for Haiku context
    const regime = await getMarketRegime();
    for (const sig of scanResult.triggered) {
      sig.market_regime = regime;
    }

    const haikuResults = await callHaikuBatch(scanResult.triggered, tradingConfig);

    // Filter to escalatable signals first, then process in parallel
    const openPositions = await getOpenPositions();
    const atMaxPositions = openPositions.length >= tradingConfig.account.max_concurrent_positions;

    let toEscalate = [];
    // Mark filtered signals so they don't show as "pending" in the DB
    const markFiltered = (signalId, reason) => {
      if (signalId) {
        query('UPDATE signals SET outcome = $1 WHERE id = $2 AND outcome = $3', [`FILTERED:${reason}`, signalId, 'PENDING'])
          .catch(err => logger.warn(`[Engine] markFiltered(${signalId}, ${reason}) failed: ${err.message}`));
      }
    };

    if (haikuResults.length !== scanResult.triggered.length) {
      logger.warn(`[Engine] Haiku batch size mismatch: ${scanResult.triggered.length} triggered vs ${haikuResults.length} results — processing min(${Math.min(scanResult.triggered.length, haikuResults.length)})`);
    }

    const processCount = Math.min(scanResult.triggered.length, haikuResults.length);
    for (let i = 0; i < processCount; i++) {
      const triggered = scanResult.triggered[i];
      const haikuResult = haikuResults[i];

      if (!haikuResult || !haikuResult.escalate) {
        logger.info(`[Engine] ${triggered.symbol}: Haiku did not escalate (${haikuResult?.strength} ${haikuResult?.signal} conf:${haikuResult?.confidence})`);
        continue;
      }

      // Dynamic confidence floor — tightens when escalation conversion rate exceeds target
      const { floor: dynamicConfFloor, stats: confFloorStats } = await getEscalationConfidenceFloor();
      if (haikuResult.confidence < dynamicConfFloor) {
        logger.info(`[Engine] ${triggered.symbol}: Below dynamic confidence floor ${dynamicConfFloor.toFixed(2)} (conf:${haikuResult.confidence}, conversion:${confFloorStats?.convRate?.toFixed(1) || '?'}%)`);
        markFiltered(haikuResult.signal_id, 'CONF_FLOOR');
        continue;
      }

      // Require at least 2 triggers — unless Haiku is STRONG with high confidence
      if (triggered.thresholds_crossed.length < 2) {
        if (haikuResult.strength === 'STRONG' && haikuResult.confidence >= 0.7) {
          logger.info(`[Engine] ${triggered.symbol}: Single trigger but Haiku STRONG conf:${haikuResult.confidence} — allowing escalation`);
        } else {
          logger.info(`[Engine] ${triggered.symbol}: Skipped escalation — single trigger (${triggered.thresholds_crossed[0]})`);
          markFiltered(haikuResult.signal_id, 'SINGLE_TRIGGER');
          continue;
        }
      }

      // Skip SELL/PARTIAL_EXIT escalations when we don't hold the coin
      if (haikuResult.signal === 'SELL') {
        const position = await getPositionBySymbol(triggered.symbol);
        if (!position) {
          logger.info(`[Engine] ${triggered.symbol}: Skipped SELL escalation — no open position`);
          markFiltered(haikuResult.signal_id, 'NO_POSITION');
          continue;
        }
      }

      // Skip BUY escalations when portfolio is at max positions
      if (haikuResult.signal === 'BUY' && atMaxPositions) {
        logger.info(`[Engine] ${triggered.symbol}: Skipped BUY escalation — portfolio at max positions (${openPositions.length}/${tradingConfig.account.max_concurrent_positions})`);
        markFiltered(haikuResult.signal_id, 'MAX_POSITIONS');
        continue;
      }

      // Sonnet dedup — skip if recently evaluated
      // SELL signals use shorter dedup (10 min) to avoid same-cycle double eval while still allowing timely exits
      const dedupMinutes = tradingConfig.escalation.sonnet_dedup_minutes || 30;
      const sellDedupMinutes = Math.min(10, dedupMinutes);
      const effectiveDedupMinutes = haikuResult.signal === 'SELL' ? sellDedupMinutes : dedupMinutes;
      const lastEval = lastSonnetEvaluation.get(triggered.symbol);
      if (lastEval && (Date.now() - lastEval) < effectiveDedupMinutes * 60 * 1000) {
        const minutesAgo = ((Date.now() - lastEval) / 60000).toFixed(0);
        logger.info(`[Engine] ${triggered.symbol}: Skipped escalation — Sonnet evaluated ${minutesAgo}m ago (dedup: ${effectiveDedupMinutes}m)`);
        markFiltered(haikuResult.signal_id, 'DEDUP');
        continue;
      }

      toEscalate.push({ triggered, haikuResult });
    }

    // Hard escalation throttle — if rolling 24h rate exceeds 35%, raise minimum confidence
    try {
      const escRateResult = await query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE escalated = true) as escalated
        FROM signals WHERE created_at > NOW() - INTERVAL '24 hours'
      `);
      const rollingTotal = parseInt(escRateResult.rows[0]?.total) || 0;
      const rollingEscalated = parseInt(escRateResult.rows[0]?.escalated) || 0;
      const rollingEscRate = rollingTotal > 20 ? (rollingEscalated / rollingTotal * 100) : 0;

      if (rollingEscRate > 35) {
        const minConf = 0.75;
        const beforeCount = toEscalate.length;
        toEscalate = toEscalate.filter(s => s.haikuResult.confidence >= minConf);
        if (toEscalate.length < beforeCount) {
          logger.warn(`[Engine] Escalation throttle: filtered ${beforeCount - toEscalate.length} signals (24h rate ${rollingEscRate.toFixed(1)}% > 35%, min conf raised to ${minConf})`);
        }
      }
    } catch (throttleErr) {
      logger.warn(`[Engine] Escalation throttle check failed: ${throttleErr.message}`);
    }

    signalsEscalated = toEscalate.length;

    // Process all escalated signals through Sonnet in parallel
    if (toEscalate.length > 0) {
      // Pre-fetch shared context once (not per-signal)
      const [cachedPortfolio, learningRules, cb, prefetchedRegime] = await Promise.all([
        getCachedPortfolio(),
        getLearningRules(),
        checkCircuitBreaker(),
        getMarketRegime(),
      ]);
      let sharedPortfolio = {
        ...cachedPortfolio,
        circuit_breaker_active: cb.is_active,
        consecutive_losses: cb.consecutive_losses,
      };

      // Pre-fetch news for all escalated symbols in parallel (tier-based item count)
      const newsResults = await Promise.allSettled(
        toEscalate.map(({ triggered }) => {
          const coinName = symbolNames.get(triggered.symbol) || triggered.symbol.replace('USDT', '');
          const newsItems = triggered.tier === 1 ? 3 : triggered.tier === 2 ? 2 : 1;
          return getNewsContext(triggered.symbol, coinName, newsItems);
        })
      );

      // Process sequentially to prevent parallel BUYs from over-committing capital
      for (let i = 0; i < toEscalate.length; i++) {
        const { triggered, haikuResult } = toEscalate[i];
        const news = newsResults[i].status === 'fulfilled' ? newsResults[i].value : 'No recent news available.';
        try {
          const result = await processEscalatedSignal(triggered, haikuResult, news, sharedPortfolio, learningRules, prefetchedRegime);
          if (result.executed) {
            tradesExecuted++;
            dailyTradeCount++;
            // Refresh portfolio so the next signal in this cycle sees updated capital/positions
            invalidatePortfolioCache();
            const refreshedPortfolio = await getCachedPortfolio();
            sharedPortfolio = { ...refreshedPortfolio, circuit_breaker_active: cb.is_active, consecutive_losses: cb.consecutive_losses };
          }
        } catch (error) {
          logger.error(`[Engine] Error processing ${triggered.symbol}: ${error.message}`);
        }
      }
    }
  }
  } catch (error) {
    logger.error(`[Engine] Entry scanner error: ${error.message}`);
    logger.error(error.stack);
  }
  } // end if (!skipNewEntries)

  const cycleDuration = Date.now() - cycleStart;
  logger.info(`[Engine] Cycle ${cycleCount} complete in ${cycleDuration}ms — ${signalsEscalated} escalated, ${tradesExecuted} trades`);

  // 4. Exit scanner — ALWAYS runs, even during circuit breaker / drawdown protection
  const exitConfig = tradingConfig.exit_scanner || {};
  const regime = await getMarketRegime();
  const exitInterval = (regime.regime === 'BEAR' || regime.regime === 'CAUTIOUS') ? 1 : (exitConfig.interval_cycles || 3);
  if (exitConfig.enabled !== false && (cycleCount === 1 || cycleCount % exitInterval === 0)) {
    try {
      await runExitScanCycle();
    } catch (error) {
      logger.error(`[Engine] Exit scan error: ${error.message}`);
      logger.error(error.stack);
    }
  }

  // 5. Hourly tasks (every 12th cycle at 5-min intervals = 1 hour)
  if (cycleCount % 12 === 0) {
    try {
      await runHourlyRiskCheck();
      invalidatePortfolioCache(); // Fresh data after risk check price updates
      const portfolio = await getCachedPortfolio();
      await queueEvent('HOURLY_SUMMARY', null, {
        cycle: cycleCount,
        open_positions: portfolio.open_count,
        unrealized_pnl: portfolio.unrealized_pnl,
        unrealized_pnl_percent: portfolio.unrealized_pnl_percent,
        realized_pnl: portfolio.realized_pnl,
        win_rate: portfolio.win_rate,
        total_trades: portfolio.total_trades,
      });
    } catch (error) {
      logger.error(`[Engine] Hourly task error: ${error.message}`);
    }
  }
}

// ── Process Escalated Signal (Haiku → Sonnet → Execute) ─────

async function processEscalatedSignal(triggered, haikuResult, news, portfolio, learningRules, prefetchedRegime) {
  const { symbol, tier } = triggered;

  logger.info(`[Engine] ${symbol}: Escalated to Sonnet (${haikuResult.strength} ${haikuResult.signal} conf:${haikuResult.confidence})`);
  lastSonnetEvaluation.set(symbol, Date.now());

  // Use pre-fetched market regime (avoids redundant API call per signal)
  const marketRegime = prefetchedRegime;
  const tradingSession = getTradingSession();
  const enrichedPortfolio = { ...portfolio, market_regime: marketRegime, trading_session: tradingSession };

  // Call Sonnet (context pre-fetched by caller)
  const decision = await callSonnet(haikuResult, triggered, news, enrichedPortfolio, learningRules, tradingConfig);

  // Execute if actionable (with per-symbol lock to prevent concurrent operations)
  if (['BUY', 'SELL', 'DCA', 'PARTIAL_EXIT'].includes(decision.action)) {
    return await withPositionLock(symbol, () => executeDecision(decision, triggered));
  }

  // Non-actionable (PASS/HOLD) — mark decision so it's not orphaned
  await markDecisionExecuted(decision.decision_id, false, `Sonnet chose ${decision.action}`);
  logger.info(`[Engine] ${symbol}: Sonnet chose ${decision.action} — no execution needed`);
  return { escalated: true, executed: false };
}

// ── Mark Decision Executed ───────────────────────────────────

async function markDecisionExecuted(decisionId, executed, notes) {
  if (!decisionId) return;
  try {
    await query(
      'UPDATE decisions SET executed = $1, execution_notes = $2 WHERE id = $3',
      [executed, notes || null, decisionId]
    );
  } catch (error) {
    logger.error(`[Engine] Failed to update decision #${decisionId}: ${error.message}`);
  }
}

// ── Execute Sonnet's Decision ───────────────────────────────

async function executeDecision(decision, triggered) {
  const { symbol, tier } = triggered;

  try {
    let result;
    switch (decision.action) {
      case 'BUY':
        result = await executeBuy(decision, triggered);
        break;
      case 'SELL':
      case 'PARTIAL_EXIT':
        result = await executeSell(decision, triggered);
        break;
      case 'DCA':
        result = await executeDCA(decision, triggered);
        break;
      default:
        logger.warn(`[Engine] Unknown action: ${decision.action}`);
        await markDecisionExecuted(decision.decision_id, false, `Unknown action: ${decision.action}`);
        return { escalated: true, executed: false };
    }

    await markDecisionExecuted(decision.decision_id, result.executed, result.reason || null);
    return result;
  } catch (error) {
    logger.error(`[Engine] Execution failed for ${symbol}: ${error.message}`);
    await markDecisionExecuted(decision.decision_id, false, `Execution error: ${error.message}`);
    await queueEvent('EXECUTION_ERROR', symbol, {
      action: decision.action,
      error: error.message,
      decision_id: decision.decision_id,
    });
    return { escalated: true, executed: false };
  }
}

async function executeBuy(decision, triggered) {
  const { symbol, tier } = triggered;

  // Fresh drawdown check (cycle-start check may be stale after earlier trades)
  const freshPortfolio = await getCachedPortfolio();
  const maxDrawdownPct = tradingConfig.circuit_breaker.max_drawdown_percent || 10;
  if (freshPortfolio.unrealized_pnl_percent < -maxDrawdownPct) {
    const reason = `BUY rejected — drawdown protection (${freshPortfolio.unrealized_pnl_percent.toFixed(1)}% < -${maxDrawdownPct}%)`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Check max positions
  const openPositions = await getOpenPositions();
  if (openPositions.length >= tradingConfig.account.max_concurrent_positions) {
    const reason = `BUY rejected — max positions (${openPositions.length}/${tradingConfig.account.max_concurrent_positions})`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Check tier concentration limit
  const maxPerTier = tradingConfig.account.max_positions_per_tier;
  if (maxPerTier) {
    const tierKey2 = `tier_${tier}`;
    const tierLimit = maxPerTier[tierKey2];
    if (tierLimit) {
      const tierPositions = openPositions.filter(p => p.tier === tier);
      if (tierPositions.length >= tierLimit) {
        const reason = `BUY rejected — tier ${tier} concentration limit (${tierPositions.length}/${tierLimit})`;
        logger.warn(`[Engine] ${symbol}: ${reason}`);
        return { escalated: true, executed: false, reason };
      }
    }
  }

  // Check no existing position on symbol
  const existing = await getPositionBySymbol(symbol);
  if (existing) {
    const reason = `BUY rejected — already have open position #${existing.id}`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Determine position size — use Sonnet's recommendation or tier default
  const tierKey = `tier_${tier}`;
  const tierConfig = tradingConfig.position_sizing[tierKey];
  if (!tierConfig) {
    logger.warn(`[Engine] ${symbol}: No tier config for tier_${tier} — using fallback sizing`);
  }
  let positionSizeUsd = decision.position_details?.position_size_usd ?? tierConfig?.base_position_usd ?? 600;

  // Cap position size at 1.5x tier base to prevent Sonnet over-sizing
  if (decision.position_details?.position_size_usd && tierConfig?.base_position_usd &&
      decision.position_details.position_size_usd > tierConfig.base_position_usd * 1.5) {
    const cappedSize = Math.round(tierConfig.base_position_usd * 1.5);
    logger.warn(`[Engine] ${symbol}: Sonnet suggested $${decision.position_details.position_size_usd} but T${tier} base is $${tierConfig.base_position_usd} — capping at $${cappedSize}`);
    positionSizeUsd = cappedSize;
  }

  // Cap at tier max
  if (tierConfig?.max_position_usd && positionSizeUsd > tierConfig.max_position_usd) {
    positionSizeUsd = tierConfig.max_position_usd;
  }

  // Confidence-scaled sizing: scale down for lower confidence
  const confScaling = tradingConfig.position_sizing.confidence_scaling !== false;
  if (confScaling && decision.confidence < 0.85) {
    const scaleFactor = Math.min(Math.pow(decision.confidence / 0.85, 2), 1.0); // Quadratic: 0.65→0.58x, 0.70→0.68x, 0.75→0.78x, 0.80→0.89x, 0.85+→1.0x
    const scaledSize = Math.round(positionSizeUsd * scaleFactor);
    if (scaledSize < positionSizeUsd) {
      logger.info(`[Engine] ${symbol}: Confidence-scaled sizing: $${positionSizeUsd} → $${scaledSize} (conf:${decision.confidence})`);
      positionSizeUsd = scaledSize;
    }
  }

  // Portfolio drawdown-aware sizing: reduce when underwater
  const buyPortfolio = await getCachedPortfolio();
  const portfolioPnlPct = buyPortfolio.total_pnl_percent || 0;
  if (portfolioPnlPct < -7) {
    positionSizeUsd = Math.round(positionSizeUsd * 0.5);
    logger.warn(`[Engine] ${symbol}: Drawdown sizing: 50% reduction (portfolio ${portfolioPnlPct.toFixed(1)}% < -7%)`);
  } else if (portfolioPnlPct < -5) {
    positionSizeUsd = Math.round(positionSizeUsd * 0.8);
    logger.warn(`[Engine] ${symbol}: Drawdown sizing: 20% reduction (portfolio ${portfolioPnlPct.toFixed(1)}% < -5%)`);
  }
  if (positionSizeUsd < 10) {
    const reason = `BUY rejected — position size too small ($${positionSizeUsd.toFixed(2)})`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }
  if (positionSizeUsd > buyPortfolio.available_capital) {
    const reason = `BUY rejected — insufficient capital ($${positionSizeUsd} > $${buyPortfolio.available_capital.toFixed(2)} available)`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Execute — use estimated quantity for order, but record actual fill values
  const estimatedPrice = await getCurrentPrice(symbol);
  const estimatedQty = positionSizeUsd / estimatedPrice;
  const order = await placeOrder(symbol, 'BUY', estimatedQty);
  const fillPrice = order.price;
  const fillQty = parseFloat(order.executedQty) || estimatedQty;
  const fillCost = parseFloat(order.cummulativeQuoteQty) || (fillPrice * fillQty);

  const positionId = await openPosition(
    symbol, tier, fillPrice, fillQty, fillCost,
    decision.reasoning, decision.confidence, decision.decision_id,
    tradingConfig.account.paper_trading
  );

  await queueEvent('BUY', symbol, {
    position_id: positionId,
    price: fillPrice,
    quantity: fillQty,
    cost: fillCost,
    tier,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  });

  invalidatePortfolioCache();
  logger.info(`[Engine] EXECUTED BUY: ${symbol} ${fillQty.toFixed(6)} @ $${fillPrice.toFixed(2)} ($${fillCost.toFixed(2)})`);
  sendAlert('BUY', symbol, { price: fillPrice, confidence: decision.confidence, reasoning: decision.reasoning }).catch(() => {});
  return { escalated: true, executed: true };
}

async function executeSell(decision, triggered) {
  const { symbol } = triggered;

  const position = await getPositionBySymbol(symbol);
  if (!position) {
    const reason = 'SELL rejected — no open position';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Determine exit percent — Sonnet may specify partial exit
  const intendedExitPercent = parseFloat(decision.position_details?.exit_percent) || 100;
  const currentPrice = await getCurrentPrice(symbol);
  const currentSize = parseFloat(position.current_size);
  if (!currentSize || isNaN(currentSize) || currentSize <= 0) {
    const reason = 'SELL rejected — position has invalid size';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }
  const exitSize = currentSize * (intendedExitPercent / 100);

  const order = await placeOrder(symbol, 'SELL', exitSize);
  const fillPrice = order.price;
  const fillQty = parseFloat(order.executedQty) || exitSize;

  // Use actual filled quantity to compute real exit percent (handles partial fills)
  const actualExitPercent = Math.min((fillQty / parseFloat(position.current_size)) * 100, 100);
  if (Math.abs(actualExitPercent - intendedExitPercent) > 1) {
    logger.warn(`[Engine] ${symbol}: Partial fill — intended ${intendedExitPercent}% but filled ${actualExitPercent.toFixed(1)}%`);
  }

  const closeResult = await closePosition(
    position.id, fillPrice, actualExitPercent,
    decision.reasoning, decision.confidence, decision.decision_id,
    tradingConfig.account.paper_trading
  );

  // Clear Sonnet dedup on full exit so symbol can be re-entered immediately
  const exitPercent = parseFloat(decision.position_details?.exit_percent) || 100;
  if (closeResult.isFull || exitPercent >= 99) {
    lastSonnetEvaluation.delete(symbol);
  }

  // Circuit breaker tracking — any loss increments, any profit resets
  if (closeResult.pnl < 0) {
    await recordLoss(symbol, closeResult.pnl);
  } else if (closeResult.pnl > 0) {
    await resetCircuitBreaker();
  }

  const eventType = closeResult.isFull ? 'SELL' : 'PARTIAL_EXIT';
  await queueEvent(eventType, symbol, {
    position_id: position.id,
    price: fillPrice,
    exit_percent: actualExitPercent,
    pnl: closeResult.pnl,
    pnl_percent: closeResult.pnlPercent,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  });

  invalidatePortfolioCache();
  logger.info(`[Engine] EXECUTED ${eventType}: ${symbol} ${actualExitPercent.toFixed(1)}% @ $${fillPrice.toFixed(2)} | P&L: $${closeResult.pnl.toFixed(2)} (${closeResult.pnlPercent.toFixed(2)}%)`);
  sendAlert('SELL', symbol, { price: fillPrice, pnl: closeResult.pnl, pnl_percent: closeResult.pnlPercent }).catch(() => {});
  return { escalated: true, executed: true };
}

async function executeDCA(decision, triggered) {
  const { symbol, tier } = triggered;

  // Check if DCA is enabled in config
  if (tradingConfig.dca?.enabled === false) {
    const reason = 'DCA rejected — DCA disabled in config (0% historical win rate)';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  const position = await getPositionBySymbol(symbol);
  if (!position) {
    const reason = 'DCA rejected — no open position';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Block DCA when overall performance is poor
  const dcaPortfolioCheck = await getCachedPortfolio();
  if (dcaPortfolioCheck.win_rate < 50) {
    const reason = `DCA blocked — overall win rate ${dcaPortfolioCheck.win_rate.toFixed(1)}% < 50%. Fix base strategy before averaging down.`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // DCA count limit — max 2 DCAs per position
  const maxDcaCount = tradingConfig.dca?.max_dca_count || 2;
  const dcaCountResult = await query(
    "SELECT COUNT(*) as cnt FROM trades WHERE position_id = $1 AND trade_type = 'DCA'",
    [position.id]
  );
  const currentDcaCount = parseInt(dcaCountResult.rows[0].cnt) || 0;
  if (currentDcaCount >= maxDcaCount) {
    const reason = `DCA rejected — already ${currentDcaCount} DCAs (max ${maxDcaCount}). Exit and re-enter instead.`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // DCA size limit — each DCA capped at 50% of original entry
  const maxDcaPctOfOriginal = tradingConfig.dca?.max_dca_pct_of_original || 50;

  // Safety net: DCA only makes sense when price is below avg entry
  const avgEntry = parseFloat(position.avg_entry_price);
  const currentPrice = await getCurrentPrice(symbol);
  const dropPercent = ((avgEntry - currentPrice) / avgEntry * 100);
  if (dropPercent < 5) {
    const reason = `DCA rejected — price $${currentPrice.toFixed(4)} is only ${dropPercent.toFixed(1)}% below avg entry $${avgEntry.toFixed(4)} (need ≥5% drop)`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // DCA amount — use Sonnet's recommendation or tier-based default
  const tierKey = `tier_${tier}`;
  const tierConfig = tradingConfig.position_sizing[tierKey];
  let dcaAmountUsd = decision.position_details?.position_size_usd ?? tierConfig?.base_position_usd ?? 600;

  // Confidence-scaled DCA sizing
  const confScaling = tradingConfig.position_sizing.confidence_scaling !== false;
  if (confScaling && decision.confidence < 0.80) {
    const scaleFactor = Math.min(decision.confidence / 0.80, 1.0);
    const scaledDca = Math.round(dcaAmountUsd * scaleFactor);
    if (scaledDca < dcaAmountUsd) {
      logger.info(`[Engine] ${symbol}: DCA confidence-scaled: $${dcaAmountUsd} → $${scaledDca} (conf:${decision.confidence})`);
      dcaAmountUsd = scaledDca;
    }
  }

  // Cap DCA at percentage of original entry cost
  const originalEntry = parseFloat(position.entry_cost);
  const maxDcaUsd = originalEntry * (maxDcaPctOfOriginal / 100);
  if (dcaAmountUsd > maxDcaUsd) {
    logger.info(`[Engine] ${symbol}: DCA capped at $${maxDcaUsd.toFixed(2)} (${maxDcaPctOfOriginal}% of original $${originalEntry.toFixed(2)})`);
    dcaAmountUsd = maxDcaUsd;
  }

  // Check total won't exceed tier max
  const currentInvested = parseFloat(position.total_cost);
  if (tierConfig?.max_position_usd && (currentInvested + dcaAmountUsd) > tierConfig.max_position_usd) {
    dcaAmountUsd = tierConfig.max_position_usd - currentInvested;
    if (dcaAmountUsd <= 0) {
      const reason = `DCA rejected — position already at tier max ($${currentInvested.toFixed(2)})`;
      logger.warn(`[Engine] ${symbol}: ${reason}`);
      return { escalated: true, executed: false, reason };
    }
  }

  // Minimum DCA check (Binance MIN_NOTIONAL is typically $10)
  if (dcaAmountUsd < 10) {
    const reason = `DCA rejected — amount too small ($${dcaAmountUsd.toFixed(2)})`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Check available capital
  const dcaPortfolio = await getCachedPortfolio();
  if (dcaAmountUsd > dcaPortfolio.available_capital) {
    const reason = 'DCA rejected — insufficient capital';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Reuse currentPrice from earlier check instead of a second API call
  const estimatedQty = dcaAmountUsd / currentPrice;
  const order = await placeOrder(symbol, 'BUY', estimatedQty);
  const fillPrice = order.price;
  const fillQty = parseFloat(order.executedQty) || estimatedQty;
  const fillCost = parseFloat(order.cummulativeQuoteQty) || (fillPrice * fillQty);

  const dcaResult = await addToPosition(
    position.id, fillPrice, fillQty, fillCost,
    decision.reasoning, decision.confidence,
    tradingConfig.account.paper_trading
  );

  await queueEvent('DCA', symbol, {
    position_id: position.id,
    price: fillPrice,
    quantity: fillQty,
    cost: fillCost,
    new_avg_entry: dcaResult.newAvgEntry,
    total_invested: dcaResult.newTotalCost,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  });

  invalidatePortfolioCache();
  logger.info(`[Engine] EXECUTED DCA: ${symbol} ${fillQty.toFixed(6)} @ $${fillPrice.toFixed(2)} | new avg: $${dcaResult.newAvgEntry.toFixed(2)}`);
  sendAlert('DCA', symbol, { price: fillPrice, new_avg_entry: dcaResult.newAvgEntry, cost: fillCost }).catch(() => {});
  return { escalated: true, executed: true };
}

// ── Exit Scanner Cycle ──────────────────────────────────────

async function runExitScanCycle() {
  const exitStart = Date.now();
  logger.info('[Engine] Running exit scan...');

  const exitResult = await runExitScan(tradingConfig);

  if (exitResult.candidates.length === 0) {
    logger.info(`[Engine] Exit scan: ${exitResult.positions_checked} positions checked, none above threshold`);
    return;
  }

  // Pre-fetch shared context once (not per-candidate)
  const [cachedPortfolio, exitLearningRules, cb, regime] = await Promise.all([
    getCachedPortfolio(),
    getExitLearningRules(),
    checkCircuitBreaker(),
    getMarketRegime(),
  ]);

  const portfolio = {
    ...cachedPortfolio,
    circuit_breaker_active: cb.is_active,
    consecutive_losses: cb.consecutive_losses,
    market_regime: regime,
  };

  // Deduplicate candidates by symbol (keep highest urgency)
  const seenSymbols = new Map();
  for (const candidate of exitResult.candidates) {
    const sym = candidate.position.symbol;
    if (!seenSymbols.has(sym) || candidate.urgency.score > seenSymbols.get(sym).urgency.score) {
      seenSymbols.set(sym, candidate);
    }
  }
  const dedupedCandidates = [...seenSymbols.values()];
  if (dedupedCandidates.length < exitResult.candidates.length) {
    logger.info(`[Engine] Exit candidates deduped: ${exitResult.candidates.length} → ${dedupedCandidates.length}`);
  }

  // Log all candidates (dedup set after Sonnet success, not before — failed calls shouldn't block entry-side)
  for (const candidate of dedupedCandidates) {
    logger.info(`[Engine] Exit eval: ${candidate.position.symbol} urgency ${candidate.urgency.score} — ${candidate.urgency.factors.join(', ')}`);
  }

  // Pre-fetch news for all deduped candidates in parallel (tier-based item count)
  const newsResults = await Promise.allSettled(
    dedupedCandidates.map(c => {
      const coinName = symbolNames.get(c.position.symbol) || c.position.symbol.replace('USDT', '');
      const newsItems = c.position.tier === 1 ? 3 : c.position.tier === 2 ? 2 : 1;
      return getNewsContext(c.position.symbol, coinName, newsItems);
    })
  );

  // Fire all Sonnet exit evals in parallel for better prompt cache hits
  const sonnetResults = await Promise.allSettled(
    dedupedCandidates.map((candidate, i) => {
      const news = newsResults[i].status === 'fulfilled' ? newsResults[i].value : 'No recent news available.';
      return callSonnetExitEval(
        candidate.position, candidate.analysis, candidate.urgency,
        news, portfolio, exitLearningRules, tradingConfig
      );
    })
  );

  // Process results sequentially (executions need ordering for portfolio consistency)
  let exitsExecuted = 0;

  for (let i = 0; i < dedupedCandidates.length; i++) {
    const { position, urgency, currentPrice } = dedupedCandidates[i];

    if (sonnetResults[i].status === 'rejected') {
      logger.error(`[Engine] Exit eval failed for ${position.symbol}: ${sonnetResults[i].reason?.message}`);
      recordExitCooldown(position.symbol);
      continue;
    }

    // Mark dedup only after Sonnet call succeeded (failed calls shouldn't block entry-side escalation)
    lastSonnetEvaluation.set(position.symbol, Date.now());

    const decision = sonnetResults[i].value;

    if (['SELL', 'PARTIAL_EXIT'].includes(decision.action)) {
      const exitPercent = parseFloat(decision.position_details?.exit_percent) || 100;
      const isPartial = exitPercent < 99;

      const triggered = { symbol: position.symbol, tier: position.tier };
      const result = await withPositionLock(position.symbol, () => executeSell(decision, triggered));

      if (result.executed) {
        exitsExecuted++;
        dailyTradeCount++;
        await queueEvent('EXIT_SCANNER_ACTION', position.symbol, {
          action: decision.action,
          urgency_score: urgency.score,
          urgency_factors: urgency.factors,
          confidence: decision.confidence,
          reasoning: decision.reasoning,
        });
        sendAlert('SELL', position.symbol, {
          price: currentPrice,
          pnl_percent: urgency.pnl_percent,
          reasoning: `[ExitScanner] ${(decision.reasoning || '').substring(0, 80)}`,
        }).catch(() => {});

        if (isPartial) {
          logger.info(`[Engine] ${position.symbol}: Partial exit — skipping cooldown and dedup for follow-up evaluation`);
          lastSonnetEvaluation.delete(position.symbol);
        } else {
          recordExitCooldown(position.symbol);
        }
      } else {
        recordExitCooldown(position.symbol);
      }

      await markDecisionExecuted(decision.decision_id, result.executed, result.reason || null);
    } else {
      recordExitCooldown(position.symbol);
      await markDecisionExecuted(decision.decision_id, false, `Exit eval: ${decision.action}`);
      logger.info(`[Engine] ${position.symbol}: Exit eval — Sonnet chose ${decision.action}`);
    }
  }

  const exitDuration = Date.now() - exitStart;
  logger.info(`[Engine] Exit scan complete in ${exitDuration}ms — ${exitsExecuted} exit(s) executed`);
}

// ── Hourly Risk Check ───────────────────────────────────────

async function runHourlyRiskCheck() {
  const openPositions = await getOpenPositions();
  if (openPositions.length === 0) {
    logger.info('[Engine] Hourly check: no open positions');
    return;
  }

  logger.info(`[Engine] Hourly risk check: ${openPositions.length} open position(s)`);

  // Fetch all prices in one call instead of N individual calls
  let priceMap = {};
  try {
    priceMap = await getAllPrices();
  } catch (error) {
    logger.error(`[Engine] Bulk price fetch failed for risk check: ${error.message}`);
  }

  for (const pos of openPositions) {
    try {
      const currentPrice = priceMap[pos.symbol] || await getCurrentPrice(pos.symbol);
      const avgEntry = parseFloat(pos.avg_entry_price);
      const pnlPercent = ((currentPrice - avgEntry) / avgEntry * 100);
      const holdHours = (Date.now() - new Date(pos.entry_time).getTime()) / (1000 * 60 * 60);

      // Track max unrealized gain/loss
      const maxGain = parseFloat(pos.max_unrealized_gain_percent || 0);
      const maxLoss = parseFloat(pos.max_unrealized_loss_percent || 0);
      const newMaxGain = Math.max(maxGain, pnlPercent);
      const newMaxLoss = Math.min(maxLoss, pnlPercent);

      await query(`
        UPDATE positions
        SET current_price = $1, max_unrealized_gain_percent = $2, max_unrealized_loss_percent = $3, updated_at = NOW()
        WHERE id = $4
      `, [currentPrice, newMaxGain, newMaxLoss, pos.id]);

      const status = pnlPercent >= 0 ? `+${pnlPercent.toFixed(2)}%` : `${pnlPercent.toFixed(2)}%`;
      logger.info(`[Engine] ${pos.symbol} #${pos.id}: $${currentPrice.toFixed(2)} (${status}) held ${holdHours.toFixed(1)}h`);
    } catch (error) {
      logger.error(`[Engine] Risk check failed for ${pos.symbol}: ${error.message}`);
    }
  }
}

// ── Circuit Breaker ─────────────────────────────────────────

async function checkCircuitBreaker() {
  const result = await query('SELECT * FROM circuit_breaker ORDER BY id LIMIT 1');
  if (result.rows.length === 0) return { is_active: false, consecutive_losses: 0 };

  const cb = result.rows[0];

  // Auto-deactivate if cooldown expired
  if (cb.is_active && cb.reactivates_at && new Date(cb.reactivates_at) <= new Date()) {
    await query(`
      UPDATE circuit_breaker SET is_active = false, updated_at = NOW() WHERE id = $1
    `, [cb.id]);
    logger.info('[Engine] Circuit breaker auto-deactivated (cooldown expired)');
    return { is_active: false, consecutive_losses: cb.consecutive_losses, reactivates_at: null };
  }

  return {
    is_active: cb.is_active,
    consecutive_losses: cb.consecutive_losses,
    reactivates_at: cb.reactivates_at,
  };
}

async function recordLoss(symbol, pnl) {
  const maxLosses = tradingConfig.circuit_breaker.consecutive_losses_to_activate;
  const cooldownHours = tradingConfig.circuit_breaker.cooldown_hours;

  const result = await query(`
    UPDATE circuit_breaker
    SET consecutive_losses = consecutive_losses + 1,
        last_loss_symbol = $1, last_loss_pnl = $2, updated_at = NOW()
    WHERE id = 1
    RETURNING consecutive_losses
  `, [symbol, pnl]);

  if (result.rows.length === 0) {
    logger.warn('[Engine] Circuit breaker row (id=1) not found — skipping loss recording');
    return;
  }
  const losses = result.rows[0].consecutive_losses;

  if (losses >= maxLosses) {
    await query(`
      UPDATE circuit_breaker
      SET is_active = true, activated_at = NOW(),
          reactivates_at = NOW() + make_interval(hours => $1)
      WHERE id = 1
    `, [cooldownHours]);
    logger.warn(`[Engine] CIRCUIT BREAKER ACTIVATED — ${losses} consecutive losses. Pausing for ${cooldownHours}h.`);
    sendAlert('CIRCUIT_BREAKER', null, { consecutive_losses: losses, cooldown_hours: cooldownHours }).catch(() => {});
    await queueEvent('CIRCUIT_BREAKER', null, {
      consecutive_losses: losses,
      last_loss_symbol: symbol,
      last_loss_pnl: pnl,
      cooldown_hours: cooldownHours,
    });
  } else {
    logger.warn(`[Engine] Loss recorded: ${symbol} $${pnl.toFixed(2)} (${losses}/${maxLosses} before circuit breaker)`);
  }
}

async function resetCircuitBreaker() {
  const result = await query('UPDATE circuit_breaker SET consecutive_losses = 0, updated_at = NOW() WHERE id = 1');
  if (result.rowCount === 0) {
    logger.warn('[Engine] resetCircuitBreaker: no circuit_breaker row with id=1 found');
  }
}

// ── Startup State Reconciliation ─────────────────────────────

async function reconcileState() {
  logger.info('[Engine] Running startup state reconciliation...');
  let issues = 0;

  // 1. Detect open positions with size = 0 (should be CLOSED)
  const zeroSizeResult = await query(
    "SELECT id, symbol FROM positions WHERE status = 'OPEN' AND current_size <= 0"
  );
  for (const pos of zeroSizeResult.rows) {
    logger.warn(`[Engine] Reconcile: Position #${pos.id} ${pos.symbol} has zero size but status=OPEN — closing`);
    await query(
      "UPDATE positions SET status = 'CLOSED', exit_time = NOW(), exit_reasoning = 'Auto-reconciled: zero size', updated_at = NOW() WHERE id = $1",
      [pos.id]
    );
    issues++;
  }

  // 2. Detect stale PENDING signals older than 7 days
  const staleSignals = await query(
    "UPDATE signals SET outcome = 'NEUTRAL' WHERE outcome = 'PENDING' AND created_at < NOW() - INTERVAL '7 days' RETURNING id"
  );
  if (staleSignals.rows.length > 0) {
    logger.warn(`[Engine] Reconcile: Marked ${staleSignals.rows.length} stale PENDING signals as NEUTRAL`);
    issues += staleSignals.rows.length;
  }

  // 3. Detect stale PENDING decisions older than 7 days
  const staleDecisions = await query(
    "UPDATE decisions SET outcome = 'NEUTRAL' WHERE outcome = 'PENDING' AND created_at < NOW() - INTERVAL '7 days' RETURNING id"
  );
  if (staleDecisions.rows.length > 0) {
    logger.warn(`[Engine] Reconcile: Marked ${staleDecisions.rows.length} stale PENDING decisions as NEUTRAL`);
    issues += staleDecisions.rows.length;
  }

  // 4. Detect decisions marked executed=true but no corresponding trade (last 24h only to reduce noise)
  const orphanDecisions = await query(`
    SELECT d.id, d.symbol, d.action FROM decisions d
    WHERE d.executed = true
      AND d.action IN ('BUY', 'SELL', 'DCA', 'PARTIAL_EXIT')
      AND d.created_at > NOW() - INTERVAL '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM trades t
        WHERE t.position_id IN (SELECT p.id FROM positions p WHERE p.open_decision_id = d.id OR p.close_decision_id = d.id)
          AND t.executed_at > d.created_at - INTERVAL '1 hour'
      )
  `);
  if (orphanDecisions.rows.length > 0) {
    logger.warn(`[Engine] Reconcile: ${orphanDecisions.rows.length} decision(s) marked executed but no trade found`);
    for (const d of orphanDecisions.rows) {
      logger.warn(`[Engine]   Decision #${d.id} ${d.symbol} ${d.action} — may need manual review`);
    }
    issues += orphanDecisions.rows.length;
  }

  // 5. Detect stale prices on open positions (may indicate API issues or delisted symbols)
  const stalePrices = await query(
    "SELECT id, symbol, current_price, updated_at FROM positions WHERE status = 'OPEN' AND updated_at < NOW() - INTERVAL '2 hours'"
  );
  for (const pos of stalePrices.rows) {
    logger.warn(`[Engine] Reconcile: Position #${pos.id} ${pos.symbol} price stale since ${pos.updated_at} — may need manual review`);
    issues++;
  }

  // 6. Data integrity check — open positions with invalid cost/size/entry
  const badData = await query(
    "SELECT id, symbol, total_cost, current_size, avg_entry_price FROM positions WHERE status = 'OPEN' AND (total_cost <= 0 OR current_size <= 0 OR avg_entry_price <= 0)"
  );
  for (const pos of badData.rows) {
    logger.warn(`[Engine] Reconcile: Position #${pos.id} ${pos.symbol} has invalid data — cost:${pos.total_cost} size:${pos.current_size} avg_entry:${pos.avg_entry_price}`);
    issues++;
  }

  if (issues === 0) {
    logger.info('[Engine] State reconciliation: no issues found');
  } else {
    logger.warn(`[Engine] State reconciliation: ${issues} issue(s) detected`);
  }
}

// ── Heartbeat ────────────────────────────────────────────────

let lastHeartbeat = Date.now();

function recordHeartbeat() {
  lastHeartbeat = Date.now();
}

// ── Dynamic Escalation Confidence Floor (cached 1hr) ────────

let escConfFloorCache = { floor: null, stats: null, expiry: 0 };

async function getEscalationConfidenceFloor() {
  if (escConfFloorCache.floor !== null && Date.now() < escConfFloorCache.expiry) {
    return escConfFloorCache;
  }

  const baseFloor = tradingConfig.escalation.min_confidence_to_escalate || 0.60;
  const targetMax = tradingConfig.learning?.escalation_conversion_target_max || 30;

  try {
    // Exclude exit scanner HOLDs from denominator — they aren't entry escalations
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE action IN ('BUY','SELL','DCA','PARTIAL_EXIT') AND executed = true) AS traded,
        COUNT(*) AS total
      FROM decisions
      WHERE created_at > NOW() - INTERVAL '48 hours'
        AND NOT (action = 'HOLD' AND signal_id IN (
          SELECT id FROM signals WHERE triggered_by @> ARRAY['EXIT_SCANNER']
        ))
    `);

    const { traded, total } = result.rows[0];
    const totalNum = parseInt(total) || 0;
    const tradedNum = parseInt(traded) || 0;

    if (totalNum < 3) {
      // Not enough data to compute meaningful rate
      escConfFloorCache = { floor: baseFloor, stats: { convRate: 0, totalNum, tradedNum, elevated: false }, expiry: Date.now() + 60 * 60 * 1000 };
      return escConfFloorCache;
    }

    const convRate = (tradedNum / totalNum) * 100;

    let floor = baseFloor;
    let elevated = false;
    if (convRate > targetMax) {
      const overshootRatio = (convRate - targetMax) / targetMax;
      const boost = Math.min(overshootRatio * 0.30, 0.25);
      floor = baseFloor + boost;
      elevated = true;
      logger.info(`[Engine] Escalation confidence floor ELEVATED: ${floor.toFixed(2)} (conversion ${convRate.toFixed(1)}% > ${targetMax}% target, boost +${boost.toFixed(2)})`);
    }

    escConfFloorCache = { floor, stats: { convRate, totalNum, tradedNum, elevated }, expiry: Date.now() + 60 * 60 * 1000 };
    return escConfFloorCache;
  } catch (error) {
    logger.error(`[Engine] getEscalationConfidenceFloor error: ${error.message}`);
    escConfFloorCache = { floor: baseFloor, stats: null, expiry: Date.now() + 5 * 60 * 1000 };
    return escConfFloorCache;
  }
}

// ── Learning Rules (cached 1hr — only changes nightly) ──────

let learningRulesCache = { data: null, expiry: 0 };

async function getLearningRules() {
  if (learningRulesCache.data && Date.now() < learningRulesCache.expiry) {
    return learningRulesCache.data;
  }
  // Fetch APPROVE and REJECT rules separately to ensure both types are represented
  const [approveResult, rejectResult] = await Promise.all([
    query(`
      SELECT * FROM learning_rules
      WHERE is_active = true AND rule_type = 'sonnet_decision'
        AND rule_text ~* '^(APPROVE|START)'
      ORDER BY win_rate DESC NULLS LAST, sample_size DESC NULLS LAST
      LIMIT 4
    `),
    query(`
      SELECT * FROM learning_rules
      WHERE is_active = true AND rule_type = 'sonnet_decision'
        AND rule_text ~* '^(REJECT|STOP|REDUCE)'
      ORDER BY sample_size DESC NULLS LAST, created_at DESC
      LIMIT 4
    `),
  ]);
  const combined = [...approveResult.rows, ...rejectResult.rows].slice(0, 8);
  learningRulesCache = { data: combined, expiry: Date.now() + 60 * 60 * 1000 };
  return combined;
}

// ── Exit Learning Rules (cached 1hr — exit-specific rules for exit eval) ──

let exitRulesCache = { data: null, expiry: 0 };

async function getExitLearningRules() {
  if (exitRulesCache.data && Date.now() < exitRulesCache.expiry) {
    return exitRulesCache.data;
  }
  const result = await query(`
    SELECT * FROM learning_rules
    WHERE is_active = true
      AND rule_type = 'sonnet_exit'
    ORDER BY win_rate DESC NULLS LAST, sample_size DESC NULLS LAST
    LIMIT 5
  `);
  // Return empty array if no exit-specific rules — entry rules are irrelevant for exit evaluation
  if (result.rows.length === 0) {
    exitRulesCache = { data: [], expiry: Date.now() + 60 * 60 * 1000 };
    return [];
  }
  exitRulesCache = { data: result.rows, expiry: Date.now() + 60 * 60 * 1000 };
  return result.rows;
}

// ── Emergency Stop-Loss Monitor ──────────────────────────────

let stopLossInProgress = false;

async function runEmergencyStopCheck() {
  if (stopLossInProgress) return;
  stopLossInProgress = true;
  try {
    const openPositions = await getOpenPositions();
    if (openPositions.length === 0) return;

    const priceMap = await getAllPrices();

    for (const pos of openPositions) {
      const currentPrice = priceMap[pos.symbol];
      if (!currentPrice) continue;

      const avgEntry = parseFloat(pos.avg_entry_price);
      if (!avgEntry || avgEntry <= 0) continue;

      const pnlPercent = ((currentPrice - avgEntry) / avgEntry) * 100;
      const tier = pos.tier || 1;
      const stopConfig = tradingConfig.emergency_stop_loss || {};
      const threshold = tier === 1
        ? (stopConfig.tier_1_percent ?? -20)
        : (stopConfig.tier_2_percent ?? -15);

      if (pnlPercent <= threshold) {
        logger.warn(`[EMERGENCY] Stop-loss triggered: ${pos.symbol} #${pos.id} at ${pnlPercent.toFixed(2)}% (threshold: ${threshold}%)`);

        await withPositionLock(pos.symbol, async () => {
          // Re-check position is still open (may have been closed by exit scanner)
          const freshPos = await getPositionBySymbol(pos.symbol);
          if (!freshPos || freshPos.id !== pos.id) return;

          const currentSize = parseFloat(freshPos.current_size);
          if (!currentSize || currentSize <= 0) return;

          const order = await placeOrder(pos.symbol, 'SELL', currentSize);
          const fillPrice = order.price;

          const closeResult = await closePosition(
            pos.id, fillPrice, 100,
            `[EMERGENCY] Hard stop-loss at ${pnlPercent.toFixed(2)}% (threshold: ${threshold}%)`,
            1.0, null, tradingConfig.account.paper_trading
          );

          await recordLoss(pos.symbol, closeResult.pnl);
          invalidatePortfolioCache();
          dailyTradeCount++;

          await queueEvent('EMERGENCY_STOP', pos.symbol, {
            position_id: pos.id,
            price: fillPrice,
            pnl: closeResult.pnl,
            pnl_percent: closeResult.pnlPercent,
            threshold_percent: threshold,
            tier,
          });

          sendAlert('CIRCUIT_BREAKER', pos.symbol, {
            price: fillPrice,
            pnl_percent: closeResult.pnlPercent,
            reasoning: `[EMERGENCY] Stop-loss: ${pnlPercent.toFixed(1)}% loss exceeded ${threshold}% threshold`,
          }).catch(() => {});

          logger.warn(`[EMERGENCY] EXECUTED stop-loss: ${pos.symbol} @ $${fillPrice.toFixed(2)} | P&L: $${closeResult.pnl.toFixed(2)} (${closeResult.pnlPercent.toFixed(2)}%)`);
        });
      }
    }
  } catch (error) {
    logger.error(`[EMERGENCY] Stop-loss check error: ${error.message}`);
  } finally {
    stopLossInProgress = false;
  }
}

// ── Market Regime Detection ─────────────────────────────────

let marketRegimeCache = { regime: null, expiry: 0 };

async function getMarketRegime() {
  if (marketRegimeCache.regime && Date.now() < marketRegimeCache.expiry) {
    return marketRegimeCache.regime;
  }
  try {
    const btcAnalysis = await analyzeSymbol('BTCUSDT');

    const btcTrend = btcAnalysis.trend?.direction || 'NEUTRAL';
    const btcAdx = btcAnalysis.adx?.value || 0;
    const btcRsi = btcAnalysis.rsi?.value || 50;
    const btcMacd = btcAnalysis.macd?.crossover || 'NEUTRAL';

    let regime = 'NEUTRAL';
    if (btcTrend === 'BULLISH' && btcAdx >= 25) regime = 'BULL';
    else if (btcTrend === 'BEARISH' && btcAdx >= 25) regime = 'BEAR';
    else if (btcTrend === 'BEARISH' || btcRsi < 40) regime = 'CAUTIOUS';
    else if (btcTrend === 'BULLISH' || btcRsi > 60) regime = 'FAVORABLE';

    const result = {
      regime,
      btc_trend: btcTrend,
      btc_adx: btcAdx,
      btc_rsi: btcRsi,
      btc_macd: btcMacd,
    };

    marketRegimeCache = { regime: result, expiry: Date.now() + 10 * 60 * 1000 }; // 10 min cache
    logger.info(`[Engine] Market regime: ${regime} (BTC ${btcTrend}, ADX ${btcAdx}, RSI ${btcRsi})`);
    return result;
  } catch (error) {
    logger.warn(`[Engine] Market regime detection failed: ${error.message}`);
    return { regime: 'NEUTRAL', btc_trend: 'UNKNOWN', btc_adx: 0, btc_rsi: 50, btc_macd: 'UNKNOWN' };
  }
}

// ── Trading Session Detection ───────────────────────────────

function getTradingSession() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMonth = now.getUTCMonth(); // 0-indexed

  // DST approximation: March (2) through October (9) for US/Europe
  const isDST = utcMonth >= 2 && utcMonth <= 9;

  // Session boundaries shift ~1h earlier during DST
  const europeOpen = isDST ? 6 : 7;   // London ~8am local
  const usOpen = isDST ? 13 : 14;     // NYSE ~9:30am local
  const usClose = isDST ? 20 : 21;    // NYSE ~4pm local

  if (utcHour >= usOpen && utcHour < usClose)
    return { session: 'US', note: 'US session — highest volume', is_dst: isDST };
  if (utcHour >= europeOpen && utcHour < usOpen)
    return { session: 'EUROPE', note: 'European session — moderate volume', is_dst: isDST };
  if (utcHour >= 0 && utcHour < europeOpen)
    return { session: 'ASIA', note: 'Asian session — typically lower volume', is_dst: isDST };
  return { session: 'LATE_US', note: 'Late US/early Asia — declining volume', is_dst: isDST };
}

// ── Graceful Shutdown ───────────────────────────────────────

let shutdownInProgress = false;
async function shutdown() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  logger.info('[Engine] Shutting down...');
  isRunning = false;

  if (scanIntervalId) {
    clearInterval(scanIntervalId);
  }
  if (stopLossIntervalId) {
    clearInterval(stopLossIntervalId);
  }

  // Wait for in-progress cycle to finish (up to 60s)
  if (cycleInProgress) {
    logger.info('[Engine] Waiting for in-progress cycle to complete...');
    const deadline = Date.now() + 60000;
    while (cycleInProgress && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (cycleInProgress) {
      logger.warn('[Engine] Cycle did not complete within 60s — forcing shutdown');
    }
  }

  try {
    await queueEvent('ENGINE_STOP', null, { cycle_count: cycleCount });
  } catch {
    // DB may already be closing
  }

  try {
    await endPool();
  } catch {
    // Pool may already be ended
  }

  logger.info(`[Engine] Stopped after ${cycleCount} cycles`);
  process.exit(0);
}

// ── Entry Point ─────────────────────────────────────────────

start().catch(error => {
  logger.error(`[Engine] Fatal startup error: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});
