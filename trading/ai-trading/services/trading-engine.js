import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { query } from '../db/connection.js';
import { testConnection } from '../db/connection.js';
import { testConnectivity, placeOrder, getCurrentPrice, getAllPrices } from '../lib/binance.js';
import { initScanner, runScanCycle } from '../lib/scanner.js';
import { callHaikuBatch, callSonnet, callSonnetExitEval } from '../lib/claude.js';
import { runExitScan, recordExitCooldown } from '../lib/exit-scanner.js';
import { getNewsContext } from '../lib/brave-search.js';
import {
  openPosition, addToPosition, closePosition,
  getOpenPositions, getPositionBySymbol, getPortfolioSummary,
} from '../lib/position-manager.js';
import { queueEvent } from '../lib/events.js';
import { sendAlert } from '../lib/sms.js';
import logger from '../lib/logger.js';

// ── Config ──────────────────────────────────────────────────

const tradingConfig = JSON.parse(readFileSync('config/trading.json', 'utf8'));

// ── State ───────────────────────────────────────────────────

let isRunning = false;
let scanIntervalId = null;
let cycleCount = 0;

// Symbol name lookup (filled on init)
const symbolNames = new Map(); // ETHUSDT -> Ethereum

// Per-cycle portfolio summary cache — invalidated after each trade execution
let portfolioCache = null;

// Sonnet deduplication — tracks last escalation time per symbol
const lastSonnetEvaluation = new Map();

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

  // 4. Initialize scanner
  await initScanner();

  // 5. Queue engine start event
  await queueEvent('ENGINE_START', null, {
    paper_trading: tradingConfig.account.paper_trading,
    symbols: symbolResult.rows.length,
    capital: tradingConfig.account.total_capital,
  });

  // 6. Set up graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 7. Start scan loop
  isRunning = true;
  const intervalMs = (tradingConfig.scanner.interval_minutes || 5) * 60 * 1000;

  logger.info(`Trading engine running — scanning every ${tradingConfig.scanner.interval_minutes} minutes`);
  logger.info(`Paper trading: ${tradingConfig.account.paper_trading}`);
  logger.info(`Capital: $${tradingConfig.account.total_capital} | Max positions: ${tradingConfig.account.max_concurrent_positions}`);

  // Run first scan immediately
  await runCycle();

  // Then schedule recurring scans
  scanIntervalId = setInterval(async () => {
    if (!isRunning) return;
    try {
      await runCycle();
    } catch (error) {
      logger.error(`[Engine] Cycle error: ${error.message}`);
      logger.error(error.stack);
    }
  }, intervalMs);
}

// ── Portfolio Cache ──────────────────────────────────────────

async function getCachedPortfolio() {
  if (!portfolioCache) {
    portfolioCache = await getPortfolioSummary(tradingConfig);
  }
  return portfolioCache;
}

function invalidatePortfolioCache() {
  portfolioCache = null;
}

// ── Main Scan Cycle ─────────────────────────────────────────

async function runCycle() {
  cycleCount++;
  const cycleStart = Date.now();
  invalidatePortfolioCache();

  logger.info(`[Engine] === Cycle ${cycleCount} ===`);

  // 1. Check circuit breaker
  const cb = await checkCircuitBreaker();
  if (cb.is_active) {
    logger.warn(`[Engine] Circuit breaker ACTIVE (${cb.consecutive_losses} losses). Skipping cycle. Reactivates: ${cb.reactivates_at}`);
    return;
  }

  // 1b. Check portfolio drawdown
  const maxDrawdownPct = tradingConfig.circuit_breaker.max_drawdown_percent || 10;
  const drawdownPortfolio = await getCachedPortfolio();
  if (drawdownPortfolio.total_pnl_percent < -maxDrawdownPct) {
    logger.warn(`[Engine] DRAWDOWN PROTECTION: total P&L ${drawdownPortfolio.total_pnl_percent.toFixed(2)}% exceeds -${maxDrawdownPct}% limit. Skipping cycle.`);
    await queueEvent('DRAWDOWN_PAUSE', null, {
      total_pnl_percent: drawdownPortfolio.total_pnl_percent,
      max_drawdown_percent: maxDrawdownPct,
    });
    return;
  }

  // 2. Run scanner
  const scanResult = await runScanCycle(tradingConfig);
  logger.info(`[Engine] Scanned ${scanResult.symbols_scanned} symbols in ${scanResult.duration_ms}ms — ${scanResult.triggered.length} triggered`);

  // 3. Process triggered signals through Haiku (batched)
  let signalsEscalated = 0;
  let tradesExecuted = 0;

  if (scanResult.triggered.length > 0) {
    const haikuResults = await callHaikuBatch(scanResult.triggered, tradingConfig);

    // Filter to escalatable signals first, then process in parallel
    const openPositions = await getOpenPositions();
    const atMaxPositions = openPositions.length >= tradingConfig.account.max_concurrent_positions;

    const toEscalate = [];
    for (let i = 0; i < scanResult.triggered.length; i++) {
      const triggered = scanResult.triggered[i];
      const haikuResult = haikuResults[i];

      if (!haikuResult || !haikuResult.escalate) {
        logger.info(`[Engine] ${triggered.symbol}: Haiku did not escalate (${haikuResult?.strength} ${haikuResult?.signal} conf:${haikuResult?.confidence})`);
        continue;
      }

      // Require at least 2 triggers — unless Haiku is STRONG with high confidence
      if (triggered.thresholds_crossed.length < 2) {
        if (haikuResult.strength === 'STRONG' && haikuResult.confidence >= 0.7) {
          logger.info(`[Engine] ${triggered.symbol}: Single trigger but Haiku STRONG conf:${haikuResult.confidence} — allowing escalation`);
        } else {
          logger.info(`[Engine] ${triggered.symbol}: Skipped escalation — single trigger (${triggered.thresholds_crossed[0]})`);
          continue;
        }
      }

      // Skip SELL/PARTIAL_EXIT escalations when we don't hold the coin
      if (haikuResult.signal === 'SELL') {
        const position = await getPositionBySymbol(triggered.symbol);
        if (!position) {
          logger.info(`[Engine] ${triggered.symbol}: Skipped SELL escalation — no open position`);
          continue;
        }
      }

      // Skip BUY escalations when portfolio is at max positions
      if (haikuResult.signal === 'BUY' && atMaxPositions) {
        logger.info(`[Engine] ${triggered.symbol}: Skipped BUY escalation — portfolio at max positions (${openPositions.length}/${tradingConfig.account.max_concurrent_positions})`);
        continue;
      }

      // Sonnet dedup — skip if recently evaluated (unless it's a SELL with open position)
      const dedupMinutes = tradingConfig.escalation.sonnet_dedup_minutes || 30;
      const lastEval = lastSonnetEvaluation.get(triggered.symbol);
      if (lastEval && haikuResult.signal !== 'SELL' && (Date.now() - lastEval) < dedupMinutes * 60 * 1000) {
        const minutesAgo = ((Date.now() - lastEval) / 60000).toFixed(0);
        logger.info(`[Engine] ${triggered.symbol}: Skipped escalation — Sonnet evaluated ${minutesAgo}m ago (dedup: ${dedupMinutes}m)`);
        continue;
      }

      toEscalate.push({ triggered, haikuResult });
    }

    signalsEscalated = toEscalate.length;

    // Process all escalated signals through Sonnet in parallel
    if (toEscalate.length > 0) {
      // Pre-fetch shared context once (not per-signal)
      const [cachedPortfolio, learningRules, cb] = await Promise.all([
        getCachedPortfolio(),
        getLearningRules(),
        checkCircuitBreaker(),
      ]);
      const sharedPortfolio = {
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

      const results = await Promise.allSettled(
        toEscalate.map(({ triggered, haikuResult }, i) => {
          const news = newsResults[i].status === 'fulfilled' ? newsResults[i].value : 'No recent news available.';
          return processEscalatedSignal(triggered, haikuResult, news, sharedPortfolio, learningRules);
        })
      );
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled' && results[i].value.executed) {
          tradesExecuted++;
        } else if (results[i].status === 'rejected') {
          logger.error(`[Engine] Error processing ${toEscalate[i].triggered.symbol}: ${results[i].reason?.message}`);
        }
      }
    }
  }

  const cycleDuration = Date.now() - cycleStart;
  logger.info(`[Engine] Cycle ${cycleCount} complete in ${cycleDuration}ms — ${signalsEscalated} escalated, ${tradesExecuted} trades`);

  // 4. Exit scanner — evaluates open positions for exit conditions
  const exitConfig = tradingConfig.exit_scanner || {};
  const exitInterval = exitConfig.interval_cycles || 3;
  if (exitConfig.enabled !== false && cycleCount % exitInterval === 0) {
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
      const portfolio = await getPortfolioSummary(tradingConfig);
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

async function processEscalatedSignal(triggered, haikuResult, news, portfolio, learningRules) {
  const { symbol, tier } = triggered;

  logger.info(`[Engine] ${symbol}: Escalated to Sonnet (${haikuResult.strength} ${haikuResult.signal} conf:${haikuResult.confidence})`);
  lastSonnetEvaluation.set(symbol, Date.now());

  // Call Sonnet (context pre-fetched by caller)
  const decision = await callSonnet(haikuResult, triggered, news, portfolio, learningRules, tradingConfig);

  // Execute if actionable
  if (['BUY', 'SELL', 'DCA', 'PARTIAL_EXIT'].includes(decision.action)) {
    return await executeDecision(decision, triggered);
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

  // Check max positions
  const openPositions = await getOpenPositions();
  if (openPositions.length >= tradingConfig.account.max_concurrent_positions) {
    const reason = `BUY rejected — max positions (${openPositions.length}/${tradingConfig.account.max_concurrent_positions})`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
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
  let positionSizeUsd = decision.position_details?.position_size_usd || tierConfig?.base_position_usd || 600;

  // Cap at tier max
  if (tierConfig?.max_position_usd && positionSizeUsd > tierConfig.max_position_usd) {
    positionSizeUsd = tierConfig.max_position_usd;
  }

  // Check available capital
  const buyPortfolio = await getCachedPortfolio();
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
  const exitPercent = decision.position_details?.exit_percent || 100;
  const currentPrice = await getCurrentPrice(symbol);
  const exitSize = parseFloat(position.current_size) * (exitPercent / 100);

  const order = await placeOrder(symbol, 'SELL', exitSize);
  const fillPrice = order.price;

  const closeResult = await closePosition(
    position.id, fillPrice, exitPercent,
    decision.reasoning, decision.confidence, decision.decision_id,
    tradingConfig.account.paper_trading
  );

  // Circuit breaker tracking
  if (closeResult.isFull) {
    if (closeResult.pnl < 0) {
      await recordLoss(symbol, closeResult.pnl);
    } else {
      await resetCircuitBreaker();
    }
  }

  const eventType = closeResult.isFull ? 'SELL' : 'PARTIAL_EXIT';
  await queueEvent(eventType, symbol, {
    position_id: position.id,
    price: fillPrice,
    exit_percent: exitPercent,
    pnl: closeResult.pnl,
    pnl_percent: closeResult.pnlPercent,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  });

  invalidatePortfolioCache();
  logger.info(`[Engine] EXECUTED ${eventType}: ${symbol} ${exitPercent}% @ $${fillPrice.toFixed(2)} | P&L: $${closeResult.pnl.toFixed(2)} (${closeResult.pnlPercent.toFixed(2)}%)`);
  sendAlert('SELL', symbol, { price: fillPrice, pnl: closeResult.pnl, pnl_percent: closeResult.pnlPercent }).catch(() => {});
  return { escalated: true, executed: true };
}

async function executeDCA(decision, triggered) {
  const { symbol, tier } = triggered;

  const position = await getPositionBySymbol(symbol);
  if (!position) {
    const reason = 'DCA rejected — no open position';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // Safety net: DCA only makes sense when price is below avg entry
  const avgEntry = parseFloat(position.avg_entry_price);
  const currentPrice = await getCurrentPrice(symbol);
  const dropPercent = ((avgEntry - currentPrice) / avgEntry * 100);
  if (dropPercent < 3) {
    const reason = `DCA rejected — price $${currentPrice.toFixed(4)} is only ${dropPercent.toFixed(1)}% below avg entry $${avgEntry.toFixed(4)} (need ≥3% drop)`;
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  // DCA amount — use Sonnet's recommendation or tier-based default
  const tierKey = `tier_${tier}`;
  const tierConfig = tradingConfig.position_sizing[tierKey];
  let dcaAmountUsd = decision.position_details?.position_size_usd || tierConfig?.base_position_usd || 600;

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

  // Check available capital
  const dcaPortfolio = await getCachedPortfolio();
  if (dcaAmountUsd > dcaPortfolio.available_capital) {
    const reason = 'DCA rejected — insufficient capital';
    logger.warn(`[Engine] ${symbol}: ${reason}`);
    return { escalated: true, executed: false, reason };
  }

  const estimatedPrice = await getCurrentPrice(symbol);
  const estimatedQty = dcaAmountUsd / estimatedPrice;
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
  const [cachedPortfolio, learningRules, cb] = await Promise.all([
    getCachedPortfolio(),
    getLearningRules(),
    checkCircuitBreaker(),
  ]);

  const portfolio = {
    ...cachedPortfolio,
    circuit_breaker_active: cb.is_active,
    consecutive_losses: cb.consecutive_losses,
  };

  // Pre-fetch news for all candidates in parallel (tier-based item count)
  const newsResults = await Promise.allSettled(
    exitResult.candidates.map(c => {
      const coinName = symbolNames.get(c.position.symbol) || c.position.symbol.replace('USDT', '');
      const newsItems = c.position.tier === 1 ? 3 : c.position.tier === 2 ? 2 : 1;
      return getNewsContext(c.position.symbol, coinName, newsItems);
    })
  );

  // Log all candidates and mark dedup before parallel Sonnet calls
  for (const candidate of exitResult.candidates) {
    logger.info(`[Engine] Exit eval: ${candidate.position.symbol} urgency ${candidate.urgency.score} — ${candidate.urgency.factors.join(', ')}`);
    lastSonnetEvaluation.set(candidate.position.symbol, Date.now());
  }

  // Fire all Sonnet exit evals in parallel for better prompt cache hits
  const sonnetResults = await Promise.allSettled(
    exitResult.candidates.map((candidate, i) => {
      const news = newsResults[i].status === 'fulfilled' ? newsResults[i].value : 'No recent news available.';
      return callSonnetExitEval(
        candidate.position, candidate.analysis, candidate.urgency,
        news, portfolio, learningRules, tradingConfig
      );
    })
  );

  // Process results sequentially (executions need ordering for portfolio consistency)
  let exitsExecuted = 0;

  for (let i = 0; i < exitResult.candidates.length; i++) {
    const { position, urgency, currentPrice } = exitResult.candidates[i];

    if (sonnetResults[i].status === 'rejected') {
      logger.error(`[Engine] Exit eval failed for ${position.symbol}: ${sonnetResults[i].reason?.message}`);
      recordExitCooldown(position.symbol);
      continue;
    }

    const decision = sonnetResults[i].value;

    if (['SELL', 'PARTIAL_EXIT'].includes(decision.action)) {
      const exitPercent = decision.position_details?.exit_percent || 100;
      const isPartial = exitPercent < 99;

      const triggered = { symbol: position.symbol, tier: position.tier };
      const result = await executeSell(decision, triggered);

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
          logger.info(`[Engine] ${position.symbol}: Partial exit — skipping cooldown for follow-up evaluation`);
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
    RETURNING consecutive_losses
  `, [symbol, pnl]);

  const losses = result.rows[0].consecutive_losses;

  if (losses >= maxLosses) {
    await query(`
      UPDATE circuit_breaker
      SET is_active = true, activated_at = NOW(),
          reactivates_at = NOW() + INTERVAL '${cooldownHours} hours'
      WHERE id = 1
    `);
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
  await query('UPDATE circuit_breaker SET consecutive_losses = 0, updated_at = NOW() WHERE id = 1');
}

// ── Learning Rules (cached 1hr — only changes nightly) ──────

let learningRulesCache = { data: null, expiry: 0 };

async function getLearningRules() {
  if (learningRulesCache.data && Date.now() < learningRulesCache.expiry) {
    return learningRulesCache.data;
  }
  const result = await query(`
    SELECT * FROM learning_rules
    WHERE is_active = true
      AND rule_type = 'sonnet_decision'
    ORDER BY win_rate DESC NULLS LAST, sample_size DESC NULLS LAST
    LIMIT 5
  `);
  learningRulesCache = { data: result.rows, expiry: Date.now() + 60 * 60 * 1000 };
  return result.rows;
}

// ── Graceful Shutdown ───────────────────────────────────────

async function shutdown() {
  logger.info('[Engine] Shutting down...');
  isRunning = false;

  if (scanIntervalId) {
    clearInterval(scanIntervalId);
  }

  try {
    await queueEvent('ENGINE_STOP', null, { cycle_count: cycleCount });
  } catch {
    // DB may already be closing
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
