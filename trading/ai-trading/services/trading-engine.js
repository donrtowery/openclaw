import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { query } from '../db/connection.js';
import { testConnection } from '../db/connection.js';
import { testConnectivity, placeOrder, getCurrentPrice } from '../lib/binance.js';
import { initScanner, runScanCycle } from '../lib/scanner.js';
import { callHaikuBatch, callSonnet } from '../lib/claude.js';
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

// ── Main Scan Cycle ─────────────────────────────────────────

async function runCycle() {
  cycleCount++;
  const cycleStart = Date.now();

  logger.info(`[Engine] === Cycle ${cycleCount} ===`);

  // 1. Check circuit breaker
  const cb = await checkCircuitBreaker();
  if (cb.is_active) {
    logger.warn(`[Engine] Circuit breaker ACTIVE (${cb.consecutive_losses} losses). Skipping cycle. Reactivates: ${cb.deactivates_at}`);
    return;
  }

  // 2. Run scanner
  const scanResult = await runScanCycle(tradingConfig);
  logger.info(`[Engine] Scanned ${scanResult.symbols_scanned} symbols in ${scanResult.duration_ms}ms — ${scanResult.triggered.length} triggered`);

  if (scanResult.triggered.length === 0) return;

  // 3. Process triggered signals through Haiku (batched)
  let signalsEscalated = 0;
  let tradesExecuted = 0;

  const haikuResults = await callHaikuBatch(scanResult.triggered, tradingConfig);

  for (let i = 0; i < scanResult.triggered.length; i++) {
    const triggered = scanResult.triggered[i];
    const haikuResult = haikuResults[i];

    if (!haikuResult || !haikuResult.escalate) {
      logger.info(`[Engine] ${triggered.symbol}: Haiku did not escalate (${haikuResult?.strength} ${haikuResult?.signal} conf:${haikuResult?.confidence})`);
      continue;
    }

    // Require at least 2 triggers for escalation — single-indicator signals are noise
    if (triggered.thresholds_crossed.length < 2) {
      logger.info(`[Engine] ${triggered.symbol}: Skipped escalation — single trigger (${triggered.thresholds_crossed[0]})`);
      continue;
    }

    // Skip SELL/PARTIAL_EXIT escalations when we don't hold the coin
    if (haikuResult.signal === 'SELL') {
      const position = await getPositionBySymbol(triggered.symbol);
      if (!position) {
        logger.info(`[Engine] ${triggered.symbol}: Skipped SELL escalation — no open position`);
        continue;
      }
    }

    signalsEscalated++;

    // Escalated — run through Sonnet
    try {
      const result = await processEscalatedSignal(triggered, haikuResult);
      if (result.executed) tradesExecuted++;
    } catch (error) {
      logger.error(`[Engine] Error processing ${triggered.symbol}: ${error.message}`);
    }
  }

  const cycleDuration = Date.now() - cycleStart;
  logger.info(`[Engine] Cycle ${cycleCount} complete in ${cycleDuration}ms — ${signalsEscalated} escalated, ${tradesExecuted} trades`);

  // 4. Hourly tasks (every 12th cycle at 5-min intervals = 1 hour)
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

async function processEscalatedSignal(triggered, haikuResult) {
  const { symbol, tier } = triggered;
  const coinName = symbolNames.get(symbol) || symbol.replace('USDT', '');

  logger.info(`[Engine] ${symbol}: Escalated to Sonnet (${haikuResult.strength} ${haikuResult.signal} conf:${haikuResult.confidence})`);

  // Gather context for Sonnet
  const [news, portfolio, learningRules] = await Promise.all([
    getNewsContext(symbol, coinName),
    getPortfolioSummary(tradingConfig),
    getLearningRules(),
  ]);

  // Add circuit breaker info to portfolio
  const cb = await checkCircuitBreaker();
  portfolio.circuit_breaker_active = cb.is_active;
  portfolio.consecutive_losses = cb.consecutive_losses;

  // Call Sonnet
  const decision = await callSonnet(haikuResult, triggered, news, portfolio, learningRules, tradingConfig);

  // Execute if actionable
  if (['BUY', 'SELL', 'DCA', 'PARTIAL_EXIT'].includes(decision.action)) {
    return await executeDecision(decision, triggered);
  }

  logger.info(`[Engine] ${symbol}: Sonnet chose ${decision.action} — no execution needed`);
  return { escalated: true, executed: false };
}

// ── Execute Sonnet's Decision ───────────────────────────────

async function executeDecision(decision, triggered) {
  const { symbol, tier } = triggered;

  try {
    switch (decision.action) {
      case 'BUY':
        return await executeBuy(decision, triggered);
      case 'SELL':
      case 'PARTIAL_EXIT':
        return await executeSell(decision, triggered);
      case 'DCA':
        return await executeDCA(decision, triggered);
      default:
        logger.warn(`[Engine] Unknown action: ${decision.action}`);
        return { escalated: true, executed: false };
    }
  } catch (error) {
    logger.error(`[Engine] Execution failed for ${symbol}: ${error.message}`);
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
    logger.warn(`[Engine] ${symbol}: BUY rejected — max positions (${openPositions.length}/${tradingConfig.account.max_concurrent_positions})`);
    return { escalated: true, executed: false };
  }

  // Check no existing position on symbol
  const existing = await getPositionBySymbol(symbol);
  if (existing) {
    logger.warn(`[Engine] ${symbol}: BUY rejected — already have open position #${existing.id}`);
    return { escalated: true, executed: false };
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
  const portfolio = await getPortfolioSummary(tradingConfig);
  if (positionSizeUsd > portfolio.available_capital) {
    logger.warn(`[Engine] ${symbol}: BUY rejected — insufficient capital ($${positionSizeUsd} > $${portfolio.available_capital.toFixed(2)} available)`);
    return { escalated: true, executed: false };
  }

  // Execute
  const currentPrice = await getCurrentPrice(symbol);
  const quantity = positionSizeUsd / currentPrice;
  const order = await placeOrder(symbol, 'BUY', quantity);
  const fillPrice = order.price;
  const fillQty = parseFloat(order.executedQty) || quantity;
  const fillCost = fillPrice * fillQty;

  const positionId = await openPosition(
    symbol, tier, fillPrice, fillQty, fillCost,
    decision.reasoning, decision.confidence, decision.decision_id
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

  logger.info(`[Engine] EXECUTED BUY: ${symbol} ${fillQty.toFixed(6)} @ $${fillPrice.toFixed(2)} ($${fillCost.toFixed(2)})`);
  sendAlert('BUY', symbol, { price: fillPrice, confidence: decision.confidence, reasoning: decision.reasoning }).catch(() => {});
  return { escalated: true, executed: true };
}

async function executeSell(decision, triggered) {
  const { symbol } = triggered;

  const position = await getPositionBySymbol(symbol);
  if (!position) {
    logger.warn(`[Engine] ${symbol}: SELL rejected — no open position`);
    return { escalated: true, executed: false };
  }

  // Determine exit percent — Sonnet may specify partial exit
  const exitPercent = decision.position_details?.exit_percent || 100;
  const currentPrice = await getCurrentPrice(symbol);
  const exitSize = parseFloat(position.current_size) * (exitPercent / 100);

  const order = await placeOrder(symbol, 'SELL', exitSize);
  const fillPrice = order.price;

  const closeResult = await closePosition(
    position.id, fillPrice, exitPercent,
    decision.reasoning, decision.confidence, decision.decision_id
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

  logger.info(`[Engine] EXECUTED ${eventType}: ${symbol} ${exitPercent}% @ $${fillPrice.toFixed(2)} | P&L: $${closeResult.pnl.toFixed(2)} (${closeResult.pnlPercent.toFixed(2)}%)`);
  sendAlert('SELL', symbol, { price: fillPrice, pnl: closeResult.pnl, pnl_percent: closeResult.pnlPercent }).catch(() => {});
  return { escalated: true, executed: true };
}

async function executeDCA(decision, triggered) {
  const { symbol, tier } = triggered;

  const position = await getPositionBySymbol(symbol);
  if (!position) {
    logger.warn(`[Engine] ${symbol}: DCA rejected — no open position`);
    return { escalated: true, executed: false };
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
      logger.warn(`[Engine] ${symbol}: DCA rejected — position already at tier max ($${currentInvested.toFixed(2)})`);
      return { escalated: true, executed: false };
    }
  }

  // Check available capital
  const portfolio = await getPortfolioSummary(tradingConfig);
  if (dcaAmountUsd > portfolio.available_capital) {
    logger.warn(`[Engine] ${symbol}: DCA rejected — insufficient capital`);
    return { escalated: true, executed: false };
  }

  const currentPrice = await getCurrentPrice(symbol);
  const quantity = dcaAmountUsd / currentPrice;
  const order = await placeOrder(symbol, 'BUY', quantity);
  const fillPrice = order.price;
  const fillQty = parseFloat(order.executedQty) || quantity;
  const fillCost = fillPrice * fillQty;

  const dcaResult = await addToPosition(
    position.id, fillPrice, fillQty, fillCost,
    decision.reasoning, decision.confidence
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

  logger.info(`[Engine] EXECUTED DCA: ${symbol} ${fillQty.toFixed(6)} @ $${fillPrice.toFixed(2)} | new avg: $${dcaResult.newAvgEntry.toFixed(2)}`);
  sendAlert('DCA', symbol, { price: fillPrice, new_avg_entry: dcaResult.newAvgEntry, cost: fillCost }).catch(() => {});
  return { escalated: true, executed: true };
}

// ── Hourly Risk Check ───────────────────────────────────────

async function runHourlyRiskCheck() {
  const openPositions = await getOpenPositions();
  if (openPositions.length === 0) {
    logger.info('[Engine] Hourly check: no open positions');
    return;
  }

  logger.info(`[Engine] Hourly risk check: ${openPositions.length} open position(s)`);

  for (const pos of openPositions) {
    try {
      const currentPrice = await getCurrentPrice(pos.symbol);
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
  if (cb.is_active && cb.deactivates_at && new Date(cb.deactivates_at) <= new Date()) {
    await query(`
      UPDATE circuit_breaker SET is_active = false, updated_at = NOW() WHERE id = $1
    `, [cb.id]);
    logger.info('[Engine] Circuit breaker auto-deactivated (cooldown expired)');
    return { is_active: false, consecutive_losses: cb.consecutive_losses, deactivates_at: null };
  }

  return {
    is_active: cb.is_active,
    consecutive_losses: cb.consecutive_losses,
    deactivates_at: cb.deactivates_at,
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
          deactivates_at = NOW() + INTERVAL '${cooldownHours} hours'
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

// ── Learning Rules ──────────────────────────────────────────

async function getLearningRules() {
  const result = await query(`
    SELECT * FROM learning_rules
    WHERE is_active = true
      AND rule_type = 'sonnet_decision'
    ORDER BY win_rate DESC NULLS LAST, sample_size DESC NULLS LAST
    LIMIT 5
  `);
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
