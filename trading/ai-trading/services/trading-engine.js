import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { query, endPool, testConnection } from '../db/connection.js';
import { testConnectivity, placeOrder, getCurrentPrice, getAllPrices } from '../lib/binance.js';
import { initScanner, runScanCycle } from '../lib/scanner.js';
import { callHaikuBatch, callSonnet, callSonnetBatch, callSonnetExitEval, callSonnetPrediction, resetApiCosts } from '../lib/claude.js';
import { runExitScan, recordExitCooldown } from '../lib/exit-scanner.js';
import { getNewsContext } from '../lib/brave-search.js';
import {
  openPosition, addToPosition, closePosition,
  getOpenPositions, getPositionBySymbol, getPortfolioSummary,
} from '../lib/position-manager.js';
import { queueEvent } from '../lib/events.js';
import { sendAlert } from '../lib/sms.js';
import { analyzeSymbol } from '../lib/technical-analysis.js';
import { detectLeadingSignals, computeBTCCorrelation, getHighBetaAltcoins, rankBTCLedCandidates } from '../lib/predictive-analyzer.js';
import { createPrediction, canOpenPredictivePosition, calcPredictivePositionSize, linkPredictionToPosition, getSymbolPredictionAccuracy, evaluatePredictions, hasPendingPrediction } from '../lib/prediction-manager.js';
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

// Predictive system state
let lastBtcCorrelationUpdate = 0; // timestamp of last BTC correlation compute

// Escalation rate cache — re-query only every 60 minutes
let escalationRateCache = null;
let escalationRateCacheTime = 0;

// Daily trade counter — resets at midnight EST (TZ=America/New_York)
let dailyTradeCount = 0;
let dailyTradeDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local TZ

// Per-symbol position locking — prevents concurrent buy/sell/DCA on same symbol
const positionLocks = new Map();
const LOCK_TIMEOUT_MS = 60_000; // 60s max wait for lock acquisition

async function withPositionLock(symbol, fn) {
  const waitStart = Date.now();
  while (positionLocks.has(symbol)) {
    if (Date.now() - waitStart > LOCK_TIMEOUT_MS) {
      logger.error(`[Lock] Timeout waiting for lock on ${symbol} after ${LOCK_TIMEOUT_MS}ms — forcing release`);
      positionLocks.delete(symbol);
      break;
    }
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

  // 4. Restore daily trade counter from DB (survives restarts) — only count entries, not exits
  const todayTradesResult = await query(
    "SELECT COUNT(*) as cnt FROM trades WHERE executed_at >= CURRENT_DATE AND trade_type IN ('ENTRY', 'DCA')"
  );
  dailyTradeCount = parseInt(todayTradesResult.rows[0].cnt) || 0;
  if (dailyTradeCount > 0) {
    logger.info(`[Engine] Restored daily entry count: ${dailyTradeCount} entries today`);
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

  // 0. Reset daily trade counter at midnight EST
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local TZ
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
    // Pre-filter: skip single-trigger signals and SELL signals for non-held symbols before Haiku
    const multiTrigger = [];
    let singleSkipped = 0;
    let sellNoPositionSkipped = 0;
    const prefetchedPositions = await getOpenPositions();
    const openPositionSymbols = new Set(prefetchedPositions.map(p => p.symbol));
    for (const sig of scanResult.triggered) {
      if (sig.thresholds_crossed.length < 2) {
        singleSkipped++;
        continue;
      }
      // Skip bearish signals on symbols we don't hold — exit scanner handles held positions
      const isBearish = sig.thresholds_crossed.some(t =>
        t.includes('BEARISH') || t === 'BB_LOWER_TOUCH' || t === 'BB_SQUEEZE'
      ) && !sig.thresholds_crossed.some(t =>
        t.includes('BULLISH') || t === 'VOLUME_SPIKE' || t === 'BB_UPPER_TOUCH'
      );
      if (isBearish && !openPositionSymbols.has(sig.symbol)) {
        sellNoPositionSkipped++;
        continue;
      }
      multiTrigger.push(sig);
    }
    if (singleSkipped > 0 || sellNoPositionSkipped > 0) {
      logger.info(`[Engine] Pre-filtered ${singleSkipped} single-trigger, ${sellNoPositionSkipped} bearish-no-position — ${multiTrigger.length} sent to Haiku`);
    }

    if (multiTrigger.length === 0) {
      logger.info(`[Engine] All triggers were single — skipping Haiku batch`);
    }

    // Inject market regime into triggered signals for Haiku context
    const regime = await getMarketRegime();
    for (const sig of multiTrigger) {
      sig.market_regime = regime;
    }

    const haikuResults = multiTrigger.length > 0 ? await callHaikuBatch(multiTrigger, tradingConfig) : [];

    // Filter to escalatable signals first, then process in parallel
    const openPositions = prefetchedPositions;
    const atMaxPositions = openPositions.length >= tradingConfig.account.max_concurrent_positions;

    let toEscalate = [];
    // Mark filtered signals so they don't show as "pending" in the DB
    const markFiltered = (signalId, reason) => {
      if (signalId) {
        query('UPDATE signals SET outcome = $1 WHERE id = $2 AND outcome = $3', [`FILTERED:${reason}`, signalId, 'PENDING'])
          .catch(err => logger.warn(`[Engine] markFiltered(${signalId}, ${reason}) failed: ${err.message}`));
      }
    };

    if (haikuResults.length !== multiTrigger.length) {
      logger.warn(`[Engine] Haiku batch size mismatch: ${multiTrigger.length} triggered vs ${haikuResults.length} results — processing min(${Math.min(multiTrigger.length, haikuResults.length)})`);
    }

    const processCount = Math.min(multiTrigger.length, haikuResults.length);
    for (let i = 0; i < processCount; i++) {
      const triggered = multiTrigger[i];
      const haikuResult = haikuResults[i];

      if (!haikuResult || !haikuResult.escalate) {
        logger.info(`[Engine] ${triggered.symbol}: Haiku did not escalate (${haikuResult?.strength} ${haikuResult?.signal} conf:${haikuResult?.confidence})`);
        if (haikuResult?.signal_id) {
          query('UPDATE signals SET outcome = $1 WHERE id = $2 AND outcome = $3', ['NEUTRAL', haikuResult.signal_id, 'PENDING'])
            .catch(() => {});
        }
        continue;
      }

      // Dynamic confidence floor — tightens when escalation conversion rate exceeds target
      // Exempt SELL signals: exit decisions for held positions should always reach Sonnet
      if (haikuResult.signal !== 'SELL') {
        const { floor: dynamicConfFloor, stats: confFloorStats } = await getEscalationConfidenceFloor();
        if (haikuResult.confidence < dynamicConfFloor) {
          logger.info(`[Engine] ${triggered.symbol}: Below dynamic confidence floor ${dynamicConfFloor.toFixed(2)} (conf:${haikuResult.confidence}, conversion:${confFloorStats?.convRate?.toFixed(1) || '?'}%)`);
          markFiltered(haikuResult.signal_id, 'CONF_FLOOR');
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
      // SELL signals use same dedup as BUY — exit scanner independently handles held positions
      const dedupMinutes = tradingConfig.escalation.sonnet_dedup_minutes || 30;
      const sellDedupMinutes = dedupMinutes;
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
    // Cached for 60 minutes to avoid running this query every cycle
    try {
      const ESC_RATE_CACHE_TTL = 60 * 60 * 1000; // 60 minutes
      if (!escalationRateCache || (Date.now() - escalationRateCacheTime) > ESC_RATE_CACHE_TTL) {
        const escRateResult = await query(`
          SELECT COUNT(*) as total,
            COUNT(*) FILTER (WHERE escalated = true) as escalated
          FROM signals WHERE created_at > NOW() - INTERVAL '24 hours'
        `);
        escalationRateCache = {
          rollingTotal: parseInt(escRateResult.rows[0]?.total) || 0,
          rollingEscalated: parseInt(escRateResult.rows[0]?.escalated) || 0,
        };
        escalationRateCacheTime = Date.now();
      }
      const { rollingTotal, rollingEscalated } = escalationRateCache;
      const rollingEscRate = rollingTotal > 20 ? (rollingEscalated / rollingTotal * 100) : 0;

      // Skip throttle during stagnation — don't tighten when we're already not trading
      const isStagnating = escConfFloorCache.stats?.stagnation === true;
      if (rollingEscRate > 35 && !isStagnating) {
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

      const marketRegime = prefetchedRegime;
      const tradingSession = getTradingSession();
      const enrichedPortfolio = { ...sharedPortfolio, market_regime: marketRegime, trading_session: tradingSession };

      // Phase 1: Batch Sonnet evaluation (single API call for all escalated signals)
      const sonnetInputs = toEscalate.map(({ triggered, haikuResult }, i) => {
        const news = newsResults[i].status === 'fulfilled' ? newsResults[i].value : 'No recent news available.';
        logger.info(`[Engine] ${triggered.symbol}: Escalated to Sonnet (${haikuResult.strength} ${haikuResult.signal} conf:${haikuResult.confidence})`);
        lastSonnetEvaluation.set(triggered.symbol, Date.now());
        return { haikuSignal: haikuResult, triggeredSignal: triggered, newsContext: news };
      });

      let sonnetDecisions;
      try {
        sonnetDecisions = await callSonnetBatch(sonnetInputs, enrichedPortfolio, learningRules, tradingConfig);
      } catch (error) {
        logger.error(`[Engine] Sonnet batch failed: ${error.message}`);
        sonnetDecisions = toEscalate.map(({ triggered }) => ({
          action: 'PASS', symbol: triggered.symbol, confidence: 0,
          reasoning: 'Batch API error — auto-PASS',
        }));
      }

      // Phase 2: Sequential execution (preserves capital safety)
      for (let i = 0; i < toEscalate.length; i++) {
        const { triggered, haikuResult } = toEscalate[i];
        const decision = sonnetDecisions[i];
        if (!decision) continue;

        // Update signal outcome based on Sonnet's decision
        const signalOutcome = ['BUY', 'SHORT', 'DCA'].includes(decision.action) ? 'WIN'
          : ['SELL', 'PARTIAL_EXIT'].includes(decision.action) ? 'WIN'
          : decision.action === 'PASS' ? 'NOT_TRADED'
          : 'NEUTRAL';
        if (haikuResult.signal_id) {
          query('UPDATE signals SET outcome = $1 WHERE id = $2 AND outcome = $3', [signalOutcome, haikuResult.signal_id, 'PENDING'])
            .catch(err => logger.warn(`[Engine] Signal outcome update failed: ${err.message}`));
        }

        try {
          if (['BUY', 'SHORT', 'SELL', 'DCA', 'PARTIAL_EXIT'].includes(decision.action)) {
            const result = await withPositionLock(triggered.symbol, () => executeDecision(decision, triggered));
            if (result.executed) {
              tradesExecuted++;
              if (['BUY', 'SHORT', 'DCA'].includes(decision.action)) dailyTradeCount++;
              invalidatePortfolioCache();
              const refreshedPortfolio = await getCachedPortfolio();
              sharedPortfolio = { ...refreshedPortfolio, circuit_breaker_active: cb.is_active, consecutive_losses: cb.consecutive_losses };
            }
          } else {
            await markDecisionExecuted(decision.decision_id, false, `Sonnet chose ${decision.action}`);
            logger.info(`[Engine] ${triggered.symbol}: Sonnet chose ${decision.action} — no execution needed`);
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

  // 4. Predictive analysis cycle — runs every 3 scan cycles (~30 min)
  const predConfig = tradingConfig.predictive || {};
  const predScanMinutes = predConfig.scan_interval_minutes || 30;
  const predCycleInterval = Math.max(1, Math.round(predScanMinutes / (tradingConfig.scanner.interval_minutes || 10)));
  if (predConfig.enabled && !skipNewEntries && cycleCount % predCycleInterval === 0) {
    try {
      await runPredictiveCycle();
    } catch (error) {
      logger.error(`[Engine] Predictive cycle error: ${error.message}`);
      logger.error(error.stack);
    }
    // Score any predictions whose timeframe has elapsed
    try {
      const evalResult = await evaluatePredictions();
      if (evalResult.evaluated > 0) {
        logger.info(`[Engine] Prediction scoring: ${evalResult.evaluated} evaluated, ${evalResult.correct} correct, ${evalResult.wrong} wrong`);
      }
    } catch (error) {
      logger.error(`[Engine] Prediction scoring error: ${error.message}`);
    }
  }

  // 5. Exit scanner — ALWAYS runs, even during circuit breaker / drawdown protection
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

  // 6. Hourly tasks (dynamic based on scan interval)
  const cyclesPerHour = Math.round(60 / (tradingConfig.scanner?.interval_minutes || 10));
  if (cycleCount % cyclesPerHour === 0) {
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
      case 'SHORT':
        result = await executeShort(decision, triggered);
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

  // Hard overbought gate: reject T2 buys when StochRSI K > 85 (T1 threshold: K > 92)
  // This is a code-level guard — Sonnet's prompt says the same but can rationalize around it
  try {
    const snapResult = await query(
      'SELECT stoch_rsi_k FROM indicator_snapshots WHERE symbol = $1 ORDER BY created_at DESC LIMIT 1',
      [symbol]
    );
    const stochK = snapResult.rows[0] ? parseFloat(snapResult.rows[0].stoch_rsi_k) : null;
    if (stochK !== null) {
      const stochLimit = tier >= 2 ? 85 : 92;
      if (stochK > stochLimit) {
        const reason = `BUY rejected — StochRSI K ${stochK.toFixed(1)} > ${stochLimit} (T${tier} overbought gate)`;
        logger.warn(`[Engine] ${symbol}: ${reason}`);
        return { escalated: true, executed: false, reason };
      }
    }
  } catch (err) {
    logger.warn(`[Engine] ${symbol}: StochRSI gate check failed: ${err.message} — allowing trade`);
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
  const drawdownSevereThreshold = tradingConfig.position_sizing?.drawdown_severe_threshold || -7;
  const drawdownReduceThreshold = tradingConfig.position_sizing?.drawdown_reduce_threshold || -5;
  if (portfolioPnlPct < drawdownSevereThreshold) {
    positionSizeUsd = Math.round(positionSizeUsd * 0.5);
    logger.warn(`[Engine] ${symbol}: Drawdown sizing: 50% reduction (portfolio ${portfolioPnlPct.toFixed(1)}% < ${drawdownSevereThreshold}%)`);
  } else if (portfolioPnlPct < drawdownReduceThreshold) {
    positionSizeUsd = Math.round(positionSizeUsd * 0.8);
    logger.warn(`[Engine] ${symbol}: Drawdown sizing: 20% reduction (portfolio ${portfolioPnlPct.toFixed(1)}% < ${drawdownReduceThreshold}%)`);
  }
  // Kelly criterion sizing: adapt to actual win rate and payoff ratio
  const kellyConfig = tradingConfig.position_sizing.kelly || {};
  if (kellyConfig.enabled && buyPortfolio.total_trades >= (kellyConfig.min_trades || 20)) {
    const kellyFraction = calcKellyFraction(buyPortfolio, kellyConfig);
    if (kellyFraction !== 1.0) {
      const kellySize = Math.round(positionSizeUsd * kellyFraction);
      logger.info(`[Engine] ${symbol}: Kelly sizing: $${positionSizeUsd} → $${kellySize} (fraction: ${kellyFraction.toFixed(2)}, WR: ${buyPortfolio.win_rate.toFixed(1)}%, payoff: ${(Math.abs(buyPortfolio.avg_win) / Math.abs(buyPortfolio.avg_loss || 1)).toFixed(2)})`);
      positionSizeUsd = kellySize;
    }
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

async function executeShort(decision, triggered) {
  const { symbol, tier } = triggered;
  const shortConfig = tradingConfig.short_selling || {};

  if (!shortConfig.enabled) {
    const reason = 'SHORT rejected — short selling disabled in config';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  if (shortConfig.paper_only && !tradingConfig.account.paper_trading) {
    const reason = 'SHORT rejected — short selling is paper-only, but live trading is enabled';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Check max short positions
  const openPositions = await getOpenPositions();
  const shortPositions = openPositions.filter(p => p.direction === 'SHORT');
  const maxShorts = shortConfig.max_short_positions || 2;
  if (shortPositions.length >= maxShorts) {
    const reason = `SHORT rejected — max short positions (${shortPositions.length}/${maxShorts})`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Check no existing position on symbol (any direction)
  const existing = await getPositionBySymbol(symbol);
  if (existing) {
    const reason = `SHORT rejected — already have open ${existing.direction} position #${existing.id}`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Position sizing — same as BUY but for shorts
  const tierKey = `tier_${tier}`;
  const tierConfig = tradingConfig.position_sizing[tierKey];
  let positionSizeUsd = decision.position_details?.position_size_usd ?? tierConfig?.base_position_usd ?? 600;

  // Cap at tier max
  if (tierConfig?.max_position_usd && positionSizeUsd > tierConfig.max_position_usd) {
    positionSizeUsd = tierConfig.max_position_usd;
  }

  // Confidence scaling
  if (decision.confidence < 0.85) {
    const scaleFactor = Math.min(Math.pow(decision.confidence / 0.85, 2), 1.0);
    positionSizeUsd = Math.round(positionSizeUsd * scaleFactor);
  }

  const shortPortfolio = await getCachedPortfolio();
  if (positionSizeUsd < 10) {
    const reason = `SHORT rejected — position size too small ($${positionSizeUsd.toFixed(2)})`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }
  if (positionSizeUsd > shortPortfolio.available_capital) {
    const reason = `SHORT rejected — insufficient capital ($${positionSizeUsd} > $${shortPortfolio.available_capital.toFixed(2)} available)`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Execute — paper mode SELL acts as short entry
  const estimatedPrice = await getCurrentPrice(symbol);
  const estimatedQty = positionSizeUsd / estimatedPrice;
  const order = await placeOrder(symbol, 'SELL', estimatedQty);
  const fillPrice = order.price;
  const fillQty = parseFloat(order.executedQty) || estimatedQty;
  const fillCost = parseFloat(order.cummulativeQuoteQty) || (fillPrice * fillQty);

  const positionId = await openPosition(
    symbol, tier, fillPrice, fillQty, fillCost,
    decision.reasoning, decision.confidence, decision.decision_id,
    tradingConfig.account.paper_trading, 'SHORT'
  );

  await queueEvent('SHORT', symbol, {
    position_id: positionId,
    price: fillPrice,
    quantity: fillQty,
    cost: fillCost,
    tier,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  });

  invalidatePortfolioCache();
  logger.info(`[Engine] EXECUTED SHORT: ${symbol} ${fillQty.toFixed(6)} @ $${fillPrice.toFixed(2)} ($${fillCost.toFixed(2)})`);
  sendAlert('SHORT', symbol, { price: fillPrice, confidence: decision.confidence, reasoning: decision.reasoning }).catch(() => {});
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
  let intendedExitPercent = parseFloat(decision.position_details?.exit_percent) || 100;
  const currentPrice = await getCurrentPrice(symbol);
  const currentSize = parseFloat(position.current_size);
  if (!currentSize || isNaN(currentSize) || currentSize <= 0) {
    const reason = 'SELL rejected — position has invalid size';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Auto-close: upgrade to full exit if position has had 4+ partial exits or remaining value would be < $50
  if (intendedExitPercent < 100) {
    const partialCount = parseInt(position.partial_exits) || 0;
    if (partialCount >= 4) {
      logger.info(`[Engine] ${symbol}: Upgrading to full exit — ${partialCount} partial exits already (max 4)`);
      intendedExitPercent = 100;
    } else {
      const remainingValue = currentSize * currentPrice * (1 - intendedExitPercent / 100);
      if (remainingValue < 50) {
        logger.info(`[Engine] ${symbol}: Upgrading to full exit — remaining value would be $${remainingValue.toFixed(2)} (< $50 dust threshold)`);
        intendedExitPercent = 100;
      }
    }
  }

  const exitSize = currentSize * (intendedExitPercent / 100);

  const orderSide = (position.direction === 'SHORT') ? 'BUY' : 'SELL';
  const order = await placeOrder(symbol, orderSide, exitSize);
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

  if (position.direction === 'SHORT') {
    const reason = 'DCA rejected — not supported for SHORT positions';
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

// ── Predictive Analysis Cycle ────────────────────────────────

async function runPredictiveCycle() {
  const predConfig = tradingConfig.predictive || {};
  if (!predConfig.enabled) return;

  const predStart = Date.now();
  logger.info('[Engine] Running predictive analysis cycle...');

  try {
    // 1. Update BTC correlations if cache expired (hourly)
    const corrUpdateInterval = (predConfig.btc_correlation?.update_interval_minutes || 60) * 60 * 1000;
    if (Date.now() - lastBtcCorrelationUpdate > corrUpdateInterval) {
      await updateBTCCorrelations();
      lastBtcCorrelationUpdate = Date.now();
    }

    // 2. Get T1 symbols for divergence analysis
    const t1Result = await query(
      "SELECT symbol, tier FROM symbols WHERE is_active = true AND tier = 1"
    );
    const t1Symbols = t1Result.rows;

    if (t1Symbols.length === 0) {
      logger.info('[Engine] Predictive: no T1 symbols to analyze');
      return;
    }

    // 3. Analyze T1 symbols with candle data for divergence detection
    let predictionsCreated = 0;
    let tradesExecuted = 0;

    for (const sym of t1Symbols) {
      try {
        // Check if we can still open predictive positions
        const canOpen = await canOpenPredictivePosition(predConfig);
        if (!canOpen) {
          logger.info('[Engine] Predictive: max predictive positions reached — stopping scan');
          break;
        }

        // Check for existing position on this symbol
        const existing = await getPositionBySymbol(sym.symbol);
        if (existing) continue;

        // Analyze with candles included
        const analysis = await analyzeSymbol(sym.symbol, { includeCandles: true });
        if (analysis.error || !analysis._candles1h) continue;

        // Detect leading indicator divergences
        const divergence = detectLeadingSignals(sym.symbol, analysis, analysis._candles1h, predConfig);
        if (!divergence) continue;

        logger.info(`[Engine] Predictive: ${sym.symbol} divergence detected — ${divergence.divergence_type} ${divergence.direction} (strength: ${divergence.combined_strength})`);

        // Deduplication: skip if a matching PENDING prediction already exists
        const predDirection = divergence.direction === 'BULLISH' ? 'UP' : 'DOWN';
        const isDuplicate = await hasPendingPrediction(sym.symbol, predDirection, divergence.divergence_type);
        if (isDuplicate) {
          logger.info(`[Engine] Predictive: ${sym.symbol} skipping — pending ${predDirection} ${divergence.divergence_type} prediction already exists`);
          continue;
        }

        // Auto-calibration: raise threshold if rolling accuracy is poor, reset if acceptable
        const defaultThreshold = predConfig.confidence_threshold || 0.70;
        let confidenceThreshold = defaultThreshold;
        const symbolAccuracy = await getSymbolPredictionAccuracy(sym.symbol);
        if (symbolAccuracy !== null && symbolAccuracy < 40) {
          confidenceThreshold = 0.80;
          logger.info(`[Engine] Predictive: ${sym.symbol} accuracy ${symbolAccuracy.toFixed(1)}% < 40% — threshold raised to 0.80`);
        } else if (symbolAccuracy !== null && symbolAccuracy >= 50) {
          confidenceThreshold = defaultThreshold;
          logger.info(`[Engine] Predictive: ${sym.symbol} accuracy ${symbolAccuracy.toFixed(1)}% >= 50% — threshold at default ${defaultThreshold}`);
        }

        // Get BTC correlation for context
        const corrResult = await query(
          'SELECT pearson_r, beta, r_squared FROM btc_correlations WHERE symbol = $1 ORDER BY created_at DESC LIMIT 1',
          [sym.symbol]
        );
        const btcCorr = corrResult.rows[0] || null;

        // Get portfolio for Sonnet context
        const portfolio = await getCachedPortfolio();

        // Call Sonnet for prediction
        const predResult = await callSonnetPrediction(
          sym.symbol, analysis, divergence, btcCorr, portfolio, tradingConfig
        );

        logger.info(`[Engine] Predictive: ${sym.symbol} Sonnet prediction — ${predResult.prediction} conf:${predResult.confidence} timeframe:${predResult.timeframe_hours}h`);

        // Store prediction regardless of confidence (for learning)
        const predId = await createPrediction({
          symbol: sym.symbol,
          tier: sym.tier,
          direction: predResult.prediction,
          confidence: predResult.confidence,
          timeframe_hours: predResult.timeframe_hours,
          invalidation_criteria: predResult.invalidation,
          divergence_type: divergence.divergence_type,
          divergence_details: {
            obv: divergence.obv,
            macd: divergence.macd,
            combined_strength: divergence.combined_strength,
          },
          reasoning: predResult.reasoning,
        });
        predictionsCreated++;

        // Execute if confidence meets threshold and prediction is bullish (UP)
        if (predResult.confidence >= confidenceThreshold && predResult.prediction === 'UP') {
          const execResult = await executePredictiveBuy(
            sym.symbol, sym.tier, predResult, predId, 'PREDICTIVE'
          );
          if (execResult.executed) tradesExecuted++;
        }

        // BTC-led path: if BTCUSDT has bullish prediction with high confidence
        if (sym.symbol === 'BTCUSDT' && predResult.prediction === 'UP' &&
            predResult.confidence >= (predConfig.btc_led_confidence_threshold || 0.75)) {
          const btcLedResult = await runBTCLedEntries(predResult, analysis, portfolio, predConfig);
          tradesExecuted += btcLedResult.executed;
        }
      } catch (err) {
        logger.error(`[Engine] Predictive: error analyzing ${sym.symbol}: ${err.message}`);
      }
    }

    const duration = Date.now() - predStart;
    logger.info(`[Engine] Predictive cycle complete in ${duration}ms — ${predictionsCreated} predictions, ${tradesExecuted} trades`);
  } catch (err) {
    logger.error(`[Engine] Predictive cycle error: ${err.message}`);
  }
}

/**
 * Execute a predictive BUY entry.
 */
async function executePredictiveBuy(symbol, tier, prediction, predictionId, entryMode) {
  try {
    // Check available capital
    const portfolio = await getCachedPortfolio();
    const positionSizeUsd = calcPredictivePositionSize(tier, prediction.confidence, tradingConfig);

    if (positionSizeUsd < 10) {
      logger.info(`[Engine] Predictive: ${symbol} position too small ($${positionSizeUsd})`);
      return { executed: false };
    }
    if (positionSizeUsd > portfolio.available_capital) {
      logger.info(`[Engine] Predictive: ${symbol} insufficient capital ($${positionSizeUsd} > $${portfolio.available_capital.toFixed(2)})`);
      return { executed: false };
    }

    // Check no existing position
    const existing = await getPositionBySymbol(symbol);
    if (existing) {
      logger.info(`[Engine] Predictive: ${symbol} already has position #${existing.id}`);
      return { executed: false };
    }

    const estimatedPrice = await getCurrentPrice(symbol);
    const estimatedQty = positionSizeUsd / estimatedPrice;
    const order = await placeOrder(symbol, 'BUY', estimatedQty);
    const fillPrice = order.price;
    const fillQty = parseFloat(order.executedQty) || estimatedQty;
    const fillCost = parseFloat(order.cummulativeQuoteQty) || (fillPrice * fillQty);

    const positionId = await openPosition(
      symbol, tier, fillPrice, fillQty, fillCost,
      `[PREDICTIVE] ${prediction.reasoning}`, prediction.confidence, null,
      tradingConfig.account.paper_trading, 'LONG', entryMode, predictionId
    );

    await linkPredictionToPosition(predictionId, positionId);

    await queueEvent('BUY', symbol, {
      position_id: positionId,
      price: fillPrice,
      quantity: fillQty,
      cost: fillCost,
      tier,
      confidence: prediction.confidence,
      reasoning: `[${entryMode}] ${prediction.reasoning}`,
      entry_mode: entryMode,
    });

    invalidatePortfolioCache();
    dailyTradeCount++;
    logger.info(`[Engine] EXECUTED ${entryMode} BUY: ${symbol} ${fillQty.toFixed(6)} @ $${fillPrice.toFixed(2)} ($${fillCost.toFixed(2)})`);
    sendAlert('BUY', symbol, { price: fillPrice, confidence: prediction.confidence, reasoning: `[${entryMode}] ${prediction.reasoning}` }).catch(() => {});
    return { executed: true };
  } catch (err) {
    logger.error(`[Engine] Predictive BUY failed for ${symbol}: ${err.message}`);
    return { executed: false };
  }
}

/**
 * BTC-led altcoin entry path.
 * When BTC prediction is UP with high confidence, evaluate high-beta altcoins.
 */
async function runBTCLedEntries(btcPrediction, btcAnalysis, portfolio, predConfig) {
  let executed = 0;

  try {
    const betaThreshold = predConfig.btc_correlation?.high_beta_threshold || 1.5;
    const minRSquared = predConfig.btc_correlation?.min_r_squared || 0.30;
    const maxCandidates = predConfig.btc_correlation?.max_btc_led_candidates || 3;

    const correlations = await getHighBetaAltcoins(betaThreshold, minRSquared);
    if (correlations.length === 0) {
      logger.info('[Engine] BTC-led: no high-beta altcoins found');
      return { executed: 0 };
    }

    // Analyze all candidates
    const analysesMap = new Map();
    for (const corr of correlations) {
      try {
        const analysis = await analyzeSymbol(corr.symbol);
        if (!analysis.error) analysesMap.set(corr.symbol, analysis);
      } catch { /* skip */ }
    }

    // Rank by profit potential
    const ranked = rankBTCLedCandidates(correlations, analysesMap, maxCandidates);
    if (ranked.length === 0) {
      logger.info('[Engine] BTC-led: no viable candidates after ranking');
      return { executed: 0 };
    }

    logger.info(`[Engine] BTC-led: ${ranked.length} candidates — ${ranked.map(c => `${c.symbol}(β${c.beta},score:${c.profit_score})`).join(', ')}`);

    // Get Sonnet evaluation for each candidate via the BTC prediction call
    const refreshedPortfolio = await getCachedPortfolio();
    const btcLedPredResult = await callSonnetPrediction(
      'BTCUSDT', btcAnalysis, {
        direction: 'BULLISH',
        divergence_type: 'BTC_LED_EVALUATION',
        combined_strength: btcPrediction.confidence,
      }, null, refreshedPortfolio, tradingConfig, ranked
    );

    // Process BTC-led candidates from Sonnet's response
    for (const candidate of btcLedPredResult.btc_led_candidates) {
      if (candidate.action !== 'BUY' || !candidate.confidence) continue;
      if (candidate.confidence < (predConfig.confidence_threshold || 0.70)) continue;

      // Check we can still open predictive positions
      const canOpen = await canOpenPredictivePosition(predConfig);
      if (!canOpen) break;

      // Hard cap: total open positions (reactive + predictive) must not exceed combined limit
      const allOpenPositions = await getOpenPositions();
      const totalPositionCap = (tradingConfig.account.max_concurrent_positions || 7) + (predConfig.max_concurrent_predictive_positions || 3);
      if (allOpenPositions.length >= totalPositionCap) {
        logger.info(`[Engine] BTC-led: total position cap reached (${allOpenPositions.length}/${totalPositionCap}) — stopping`);
        break;
      }

      // Check no existing position
      const existing = await getPositionBySymbol(candidate.symbol);
      if (existing) continue;

      // Get tier for this symbol
      const symResult = await query('SELECT tier FROM symbols WHERE symbol = $1 AND is_active = true', [candidate.symbol]);
      if (symResult.rows.length === 0) continue;
      const tier = symResult.rows[0].tier;

      // Create prediction record for the BTC-led entry
      const predId = await createPrediction({
        symbol: candidate.symbol,
        tier,
        direction: 'UP',
        confidence: candidate.confidence,
        timeframe_hours: btcPrediction.timeframe_hours || 24,
        invalidation_criteria: `BTC reverses. ${btcPrediction.invalidation || ''}`,
        divergence_type: 'BTC_LED',
        divergence_details: {
          btc_prediction_confidence: btcPrediction.confidence,
          beta: ranked.find(r => r.symbol === candidate.symbol)?.beta || 0,
        },
        reasoning: candidate.reasoning || `BTC-led entry based on BTC UP prediction (conf: ${btcPrediction.confidence})`,
      });

      const execResult = await executePredictiveBuy(
        candidate.symbol, tier, { ...candidate, timeframe_hours: btcPrediction.timeframe_hours },
        predId, 'PREDICTIVE_BTC_LED'
      );

      if (execResult.executed) executed++;
    }
  } catch (err) {
    logger.error(`[Engine] BTC-led entries error: ${err.message}`);
  }

  return { executed };
}

/**
 * Update BTC correlations for all active symbols.
 */
async function updateBTCCorrelations() {
  try {
    const symbolResult = await query("SELECT symbol FROM symbols WHERE is_active = true AND symbol != 'BTCUSDT'");
    const btcAnalysis = await analyzeSymbol('BTCUSDT', { includeCandles: true });
    if (btcAnalysis.error || !btcAnalysis._candles1h) {
      logger.warn('[Engine] BTC correlation update: failed to get BTC candles');
      return;
    }

    const windowHours = tradingConfig.predictive?.btc_correlation?.window_hours || 24;
    const btcCandles = btcAnalysis._candles1h.slice(-windowHours);
    let updated = 0;

    // Process symbols in batches of 5 for concurrency
    const BATCH_SIZE = 5;
    const symbols = symbolResult.rows;
    for (let batchStart = 0; batchStart < symbols.length; batchStart += BATCH_SIZE) {
      const batch = symbols.slice(batchStart, batchStart + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async (row) => {
        const altAnalysis = await analyzeSymbol(row.symbol, { includeCandles: true });
        if (altAnalysis.error || !altAnalysis._candles1h) return null;

        const altCandles = altAnalysis._candles1h.slice(-windowHours);
        const corr = computeBTCCorrelation(btcCandles, altCandles);

        if (corr.candle_count >= 8) {
          await query(`
            INSERT INTO btc_correlations (symbol, pearson_r, beta, r_squared, window_hours, candle_count)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [row.symbol, corr.pearson_r, corr.beta, corr.r_squared, windowHours, corr.candle_count]);
          return row.symbol;
        }
        return null;
      }));

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled' && results[i].value) {
          updated++;
        } else if (results[i].status === 'rejected') {
          logger.warn(`[Engine] BTC correlation for ${batch[i].symbol}: ${results[i].reason?.message}`);
        }
      }
    }

    logger.info(`[Engine] BTC correlations updated: ${updated} symbols`);
  } catch (err) {
    logger.error(`[Engine] BTC correlation update error: ${err.message}`);
  }
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

  // Deduplicate candidates by symbol (keep highest urgency, preserve currentPrice)
  const seenSymbols = new Map();
  for (const candidate of exitResult.candidates) {
    const sym = candidate.position.symbol;
    if (!seenSymbols.has(sym) || candidate.urgency.score > seenSymbols.get(sym).urgency.score) {
      seenSymbols.set(sym, {
        position: candidate.position,
        analysis: candidate.analysis,
        urgency: candidate.urgency,
        currentPrice: candidate.currentPrice,
      });
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
  const partialExitThisCycle = new Set(); // Track symbols that already had a partial exit this cycle

  for (let i = 0; i < dedupedCandidates.length; i++) {
    const { position, urgency, currentPrice } = dedupedCandidates[i];

    if (sonnetResults[i].status === 'rejected') {
      logger.error(`[Engine] Exit eval failed for ${position.symbol}: ${sonnetResults[i].reason?.message}`);
      recordExitCooldown(`${position.symbol}:${position.direction || 'LONG'}`);
      continue;
    }

    // Mark dedup only after Sonnet call succeeded (failed calls shouldn't block entry-side escalation)
    lastSonnetEvaluation.set(position.symbol, Date.now());

    const decision = sonnetResults[i].value;

    if (['SELL', 'PARTIAL_EXIT'].includes(decision.action)) {
      const exitPercent = parseFloat(decision.position_details?.exit_percent) || 100;
      const isPartial = exitPercent < 99;

      // Prevent multiple partial exits for same symbol in one cycle
      if (isPartial && partialExitThisCycle.has(position.symbol)) {
        logger.info(`[Engine] ${position.symbol}: Skipping additional partial exit — already had one this cycle`);
        recordExitCooldown(`${position.symbol}:${position.direction || 'LONG'}`);
        await markDecisionExecuted(decision.decision_id, false, 'Partial exit already executed this cycle');
        continue;
      }

      const triggered = { symbol: position.symbol, tier: position.tier };
      const result = await withPositionLock(position.symbol, () => executeSell(decision, triggered));

      if (result.executed) {
        exitsExecuted++;
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
          partialExitThisCycle.add(position.symbol);
          logger.info(`[Engine] ${position.symbol}: Partial exit — skipping cooldown and dedup for follow-up evaluation`);
          lastSonnetEvaluation.delete(position.symbol);
        } else {
          recordExitCooldown(`${position.symbol}:${position.direction || 'LONG'}`);
        }
      } else {
        recordExitCooldown(`${position.symbol}:${position.direction || 'LONG'}`);
      }

      await markDecisionExecuted(decision.decision_id, result.executed, result.reason || null);
    } else {
      recordExitCooldown(`${position.symbol}:${position.direction || 'LONG'}`);
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
      const direction = pos.direction || 'LONG';
      const pnlPercent = direction === 'SHORT'
        ? ((avgEntry - currentPrice) / avgEntry * 100)
        : ((currentPrice - avgEntry) / avgEntry * 100);
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
      AND d.action IN ('BUY', 'SHORT', 'SELL', 'DCA', 'PARTIAL_EXIT')
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
    // Stagnation detection: if no entries in the last 12 hours, force floor to baseline.
    // This breaks the death spiral where high conversion → high floor → no trades → conversion stays high.
    const recentEntries = await query(`
      SELECT COUNT(*) as cnt FROM trades
      WHERE trade_type IN ('ENTRY', 'DCA') AND executed_at > NOW() - INTERVAL '12 hours'
    `);
    const entriesLast12h = parseInt(recentEntries.rows[0].cnt) || 0;

    if (entriesLast12h === 0) {
      logger.info(`[Engine] Escalation floor RESET to baseline ${baseFloor} — stagnation detected (0 entries in 12h)`);
      escConfFloorCache = { floor: baseFloor, stats: { convRate: 0, totalNum: 0, tradedNum: 0, elevated: false, stagnation: true }, expiry: Date.now() + 30 * 60 * 1000 };
      return escConfFloorCache;
    }

    // Exclude exit scanner HOLDs from denominator — they aren't entry escalations
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE action IN ('BUY','SHORT','SELL','DCA','PARTIAL_EXIT') AND executed = true) AS traded,
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

    if (totalNum < 5) {
      // Not enough data to compute meaningful rate — use baseline (raised from 3 to 5 for better signal)
      escConfFloorCache = { floor: baseFloor, stats: { convRate: 0, totalNum, tradedNum, elevated: false }, expiry: Date.now() + 60 * 60 * 1000 };
      return escConfFloorCache;
    }

    const convRate = (tradedNum / totalNum) * 100;

    let floor = baseFloor;
    let elevated = false;
    if (convRate > targetMax) {
      const overshootRatio = (convRate - targetMax) / targetMax;
      const boost = Math.min(overshootRatio * 0.30, 0.15);
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

// ── Kelly Criterion Position Sizing ──────────────────────────

function calcKellyFraction(portfolio, kellyConfig = {}) {
  const winRate = (portfolio.win_rate || 0) / 100;
  const avgWin = Math.abs(portfolio.avg_win) || 1;
  const avgLoss = Math.abs(portfolio.avg_loss) || 1;
  const payoffRatio = avgWin / avgLoss;

  // Kelly formula: f* = (bp - q) / b where p=win rate, q=1-p, b=payoff ratio
  const kelly = (payoffRatio * winRate - (1 - winRate)) / payoffRatio;

  // Half-Kelly for safety (standard practice)
  const halfKelly = kelly / 2;

  const minFraction = kellyConfig.min_fraction ?? 0.2;
  const maxFraction = kellyConfig.max_fraction ?? 1.5;

  return Math.max(minFraction, Math.min(halfKelly, maxFraction));
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

      const direction = pos.direction || 'LONG';
      const pnlPercent = direction === 'SHORT'
        ? ((avgEntry - currentPrice) / avgEntry) * 100
        : ((currentPrice - avgEntry) / avgEntry) * 100;
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

          const closeSide = (pos.direction || 'LONG') === 'SHORT' ? 'BUY' : 'SELL';
          const order = await placeOrder(pos.symbol, closeSide, currentSize);
          const fillPrice = order.price;

          const closeResult = await closePosition(
            pos.id, fillPrice, 100,
            `[EMERGENCY] Hard stop-loss at ${pnlPercent.toFixed(2)}% (threshold: ${threshold}%)`,
            1.0, null, tradingConfig.account.paper_trading
          );

          await recordLoss(pos.symbol, closeResult.pnl);
          invalidatePortfolioCache();

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
  // TZ=America/New_York — getHours() returns EST/EDT automatically
  const estHour = new Date().getHours();

  // Session boundaries in EST (no DST math needed — OS handles it)
  if (estHour >= 9 && estHour < 16)
    return { session: 'US', note: 'US session — highest volume', hour_est: estHour };
  if (estHour >= 3 && estHour < 9)
    return { session: 'EUROPE', note: 'European session — moderate volume', hour_est: estHour };
  if (estHour >= 16 && estHour < 20)
    return { session: 'LATE_US', note: 'Late US/early Asia — declining volume', hour_est: estHour };
  return { session: 'ASIA', note: 'Asian session — typically lower volume', hour_est: estHour };
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
