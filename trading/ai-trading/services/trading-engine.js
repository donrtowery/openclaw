import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

import cron from 'node-cron';
import logger from '../lib/logger.js';
import { query } from '../db/connection.js';
import pool from '../db/connection.js';
import { getPrice, getAllCachedPrices, connectWebSocket, disconnectWebSocket } from '../lib/binance.js';
import { lightCheck, deepCheck, alertCheck } from '../lib/claude.js';
import { queueEvent, cleanOldEvents } from '../lib/events.js';
import {
  openPosition, executeDCA, executeTakeProfit, closePosition,
  getOpenPositions, getPositionBySymbol,
  isSymbolOnCooldown, getRecentlyClosedSymbols,
} from '../lib/position-manager.js';
import {
  checkCircuitBreaker, canOpenPosition, shouldStopLoss,
  shouldTakeProfit, shouldDCA, getTierForSymbol,
} from '../lib/risk-manager.js';
import { sendTradeAlert, sendSystemAlert } from '../lib/sms.js';
import { getMarketSentiment } from '../lib/brave-search.js';
import { analyzeAll, analyzeSymbol, formatAllForClaude, formatForClaude } from '../lib/technical-analysis.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tiersConfig = require('../config/tiers.json');
const tradingConfig = require('../config/trading.json');

const ALL_SYMBOLS = Object.values(tiersConfig.tiers).flatMap(t => t.symbols);
const CONF = tradingConfig.confidenceThresholds;

// ── Price helpers ──────────────────────────────────────────

async function getPricesMap() {
  const prices = {};
  const cached = getAllCachedPrices();
  for (const [symbol, data] of cached) {
    prices[symbol] = data.price;
  }
  for (const symbol of ALL_SYMBOLS) {
    if (!prices[symbol]) {
      try { prices[symbol] = await getPrice(symbol); } catch { /* skip */ }
    }
  }
  return prices;
}

// ── Execute AI decisions on existing positions ──────────────

async function executeDecisions(decisions, prices) {
  const actions = [];

  for (const decision of decisions) {
    try {
      const price = prices[decision.symbol];
      if (!price) { logger.warn(`No price for ${decision.symbol}, skipping`); continue; }

      const position = await getPositionBySymbol(decision.symbol);
      const confidence = decision.confidence || 0;

      if (decision.action === 'CLOSE' && position) {
        if (confidence < CONF.minSellConfidence) {
          logger.info(`Skip CLOSE ${decision.symbol}: confidence ${confidence} < ${CONF.minSellConfidence}`);
          continue;
        }
        // Minimum hold time check (does not apply to stop losses — those are in runSafetyChecks)
        const minHoldHours = tradingConfig.minimumHoldHours || 4;
        if (position.opened_at) {
          const holdMs = Date.now() - new Date(position.opened_at).getTime();
          const holdH = holdMs / 3600000;
          if (holdH < minHoldHours) {
            logger.info(`Skipping CLOSE on ${decision.symbol} — held only ${Math.floor(holdH)}h (minimum: ${minHoldHours}h). Will reassess next check.`);
            continue;
          }
        }
        const closed = await closePosition(position.id, price, 'MANUAL');
        const holdMs = closed.opened_at ? Date.now() - new Date(closed.opened_at).getTime() : 0;
        const holdH = Math.floor(holdMs / 3600000);
        const holdDuration = holdH >= 24 ? `${Math.floor(holdH / 24)}d ${holdH % 24}h` : `${holdH}h`;
        logger.info(`Closed ${decision.symbol}: P&L $${closed.realized_pnl} (conf=${confidence}) ${decision.reasoning}`);
        actions.push(`CLOSED ${decision.symbol}: $${closed.realized_pnl}`);
        queueEvent('CLOSE', decision.symbol, {
          action: 'CLOSE', symbol: decision.symbol,
          entryPrice: parseFloat(closed.avg_entry_price), exitPrice: price,
          pnl: parseFloat(closed.realized_pnl), pnlPercent: parseFloat(closed.pnl_percent),
          reason: 'AI decision', holdDuration, confidence,
        }).catch(() => {});
        sendTradeAlert('SELL', decision.symbol, price, {
          pnl: closed.realized_pnl, pnlPercent: closed.pnl_percent, reason: 'AI decision',
        }).catch(() => {});
      }

      if (decision.action === 'DCA' && position) {
        if (confidence < CONF.minDCAConfidence) {
          logger.info(`Skip DCA ${decision.symbol}: confidence ${confidence} < ${CONF.minDCAConfidence}`);
          continue;
        }
        const dcaCheck = shouldDCA(position, price);
        if (dcaCheck) {
          const updated = await executeDCA(position.id, dcaCheck.level, price);
          logger.info(`DCA${dcaCheck.level} ${decision.symbol} @ $${price.toFixed(2)} (conf=${confidence})`);
          actions.push(`DCA${dcaCheck.level} ${decision.symbol}`);
          queueEvent('DCA', decision.symbol, {
            action: 'DCA', symbol: decision.symbol, dcaPrice: price,
            originalEntry: parseFloat(position.entry_price),
            newAverage: parseFloat(updated.avg_entry_price),
            dcaLevel: `${dcaCheck.level}/2`,
            additionalSize: dcaCheck.amount, totalSize: parseFloat(updated.amount),
            confidence,
          }).catch(() => {});
          sendTradeAlert('DCA', decision.symbol, price, {
            dcaLevel: dcaCheck.level, avgEntry: parseFloat(updated.avg_entry_price),
          }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error(`Failed to execute decision for ${decision.symbol}: ${err.message}`);
    }
  }
  return actions;
}

// ── Execute new entries ─────────────────────────────────────

async function executeNewEntries(entries, prices) {
  const cb = await checkCircuitBreaker();
  if (cb.isPaused) {
    logger.info('Circuit breaker paused — skipping entries');
    queueEvent('CIRCUIT_BREAKER', null, {
      action: 'CIRCUIT_BREAKER', status: 'ACTIVATED',
      consecutiveLosses: cb.consecutiveLosses,
      pauseDuration: '24h',
    }).catch(() => {});
    sendSystemAlert('\u26A0\uFE0F Circuit breaker ON \u2014 3 consecutive losses. Trading paused 24h.').catch(() => {});
    return [];
  }

  const actions = [];
  for (const entry of entries) {
    try {
      const confidence = entry.confidence || 0;
      if (confidence < CONF.minBuyConfidence) {
        logger.info(`Skip BUY ${entry.symbol}: confidence ${confidence} < ${CONF.minBuyConfidence}`);
        continue;
      }

      const { canOpen } = await canOpenPosition();
      if (!canOpen) { logger.info('Max positions reached — done with entries'); break; }

      const existing = await getPositionBySymbol(entry.symbol);
      if (existing) { logger.info(`Already hold ${entry.symbol} — skipping`); continue; }

      // Cooldown check: skip if symbol was closed recently
      const cooldown = await isSymbolOnCooldown(entry.symbol);
      if (cooldown.onCooldown) {
        logger.info(`Skipping BUY on ${entry.symbol} — cooldown active (closed ${cooldown.hoursAgo}h ago, ${cooldown.hoursRemaining}h remaining)`);
        continue;
      }

      const price = prices[entry.symbol];
      if (!price) continue;

      const position = await openPosition(entry.symbol, price, tradingConfig.positionSize);
      const openCount = (await getOpenPositions()).length;
      const tier = getTierForSymbol(entry.symbol)?.tier || 0;
      logger.info(`OPENED ${entry.symbol} @ $${price.toFixed(2)} (conf=${confidence}) — ${entry.reasoning}`);
      actions.push(`OPENED ${entry.symbol} @ $${price.toFixed(2)} (conf=${confidence})`);
      queueEvent('BUY', entry.symbol, {
        action: 'BUY', symbol: entry.symbol, price,
        positionSize: tradingConfig.positionSize, confidence,
        reasoning: entry.reasoning, tier,
        openPositions: `${openCount}/${tradingConfig.maxConcurrentPositions}`,
      }).catch(() => {});
      sendTradeAlert('BUY', entry.symbol, price, {
        confidence, reasoning: entry.reasoning,
      }).catch(() => {});
    } catch (err) {
      logger.error(`Failed to open ${entry.symbol}: ${err.message}`);
    }
  }
  return actions;
}

// ── Rule-based safety checks (before AI) ────────────────────

async function runSafetyChecks(prices) {
  const positions = await getOpenPositions();
  const actions = [];

  for (const pos of positions) {
    const price = prices[pos.symbol];
    if (!price) continue;

    if (shouldStopLoss(pos, price)) {
      try {
        const closed = await closePosition(pos.id, price, 'STOP');
        const holdMs = closed.opened_at ? Date.now() - new Date(closed.opened_at).getTime() : 0;
        const holdH = Math.floor(holdMs / 3600000);
        const holdDuration = holdH >= 24 ? `${Math.floor(holdH / 24)}d ${holdH % 24}h` : `${holdH}h`;
        logger.info(`STOP LOSS ${pos.symbol} @ $${price.toFixed(2)}: P&L $${closed.realized_pnl}`);
        actions.push(`STOP ${pos.symbol}: $${closed.realized_pnl}`);
        queueEvent('SELL', pos.symbol, {
          action: 'CLOSE', symbol: pos.symbol,
          entryPrice: parseFloat(closed.avg_entry_price), exitPrice: price,
          pnl: parseFloat(closed.realized_pnl), pnlPercent: parseFloat(closed.pnl_percent),
          reason: 'Stop loss', holdDuration, confidence: 1.0,
        }).catch(() => {});
        sendTradeAlert('SELL', pos.symbol, price, {
          pnl: closed.realized_pnl, pnlPercent: closed.pnl_percent, reason: 'Stop loss',
        }).catch(() => {});
      } catch (err) {
        logger.error(`Stop loss failed ${pos.symbol}: ${err.message}`);
      }
      continue;
    }

    const tp = shouldTakeProfit(pos, price);
    if (tp) {
      try {
        const updated = await executeTakeProfit(pos.id, tp.level, price);
        const tpSellPct = { TP1: 50, TP2: 30, TP3: 20 };
        const entryP = parseFloat(pos.avg_entry_price);
        const profitTaken = (price - entryP) * parseFloat(pos.remaining_qty) * (tpSellPct[tp.level] / 100);
        logger.info(`${tp.level} HIT ${pos.symbol} @ $${price.toFixed(2)}`);
        actions.push(`${tp.level} ${pos.symbol}`);
        queueEvent('TAKE_PROFIT', pos.symbol, {
          action: 'TAKE_PROFIT', symbol: pos.symbol, tpLevel: tp.level,
          tpPrice: price, profitTaken: Math.round(profitTaken * 100) / 100,
          percentSold: tpSellPct[tp.level],
          remainingSize: Math.round(parseFloat(updated.remaining_qty) * price * 100) / 100,
          totalPnl: updated.realized_pnl ? parseFloat(updated.realized_pnl) : Math.round((price - entryP) * parseFloat(pos.quantity) * 100) / 100,
        }).catch(() => {});
        sendTradeAlert('TAKE_PROFIT', pos.symbol, price, {
          tpLevel: tp.level, sellPercent: tpSellPct[tp.level],
        }).catch(() => {});
      } catch (err) {
        logger.error(`Take profit failed ${pos.symbol}: ${err.message}`);
      }
    }
  }
  return actions;
}

// ── Scheduled check ────────────────────────────────────────

async function runScheduledCheck() {
  const now = new Date();
  const hour = now.getUTCHours();
  const isDeepCheck = [0, 6, 12, 18].includes(hour);

  logger.info(`Running ${isDeepCheck ? 'DEEP' : 'HOURLY'} check at ${now.toISOString()}`);

  try {
    const prices = await getPricesMap();
    const safetyActions = await runSafetyChecks(prices);
    const positions = await getOpenPositions();
    const cb = await checkCircuitBreaker();

    // Run technical analysis on all symbols
    logger.info('Running technical analysis on all symbols...');
    const taStart = Date.now();
    const analyses = await analyzeAll(ALL_SYMBOLS);
    const taTime = ((Date.now() - taStart) / 1000).toFixed(1);
    const successCount = analyses.filter(a => !a.error).length;
    logger.info(`TA complete: ${successCount}/${ALL_SYMBOLS.length} symbols in ${taTime}s`);

    const technicalSummary = formatAllForClaude(analyses);

    // Get recently closed symbols for cooldown context
    const recentlyClosed = await getRecentlyClosedSymbols();
    if (recentlyClosed.length > 0) {
      logger.info(`Cooldown active for: ${recentlyClosed.map(r => `${r.symbol}(${r.hoursAgo}h ago)`).join(', ')}`);
    }

    let analysis;
    if (isDeepCheck) {
      // Deep check: technicals + news
      let newsContext = '';
      try {
        newsContext = await getMarketSentiment();
      } catch (err) {
        logger.warn(`News fetch failed: ${err.message}`);
      }
      analysis = await deepCheck(positions, prices, newsContext, cb, technicalSummary, recentlyClosed);
    } else {
      // Hourly: technicals only
      analysis = await lightCheck(positions, prices, cb, technicalSummary, recentlyClosed);
    }

    // Safety: filter out symbols that appear in both CLOSE decisions and BUY entries
    let decisions = analysis.decisions || [];
    let newEntries = analysis.newEntries || [];
    const closeSymbols = new Set(decisions.filter(d => d.action === 'CLOSE').map(d => d.symbol));
    const buySymbols = new Set(newEntries.map(e => e.symbol));
    const conflictSymbols = [...closeSymbols].filter(s => buySymbols.has(s));
    if (conflictSymbols.length > 0) {
      logger.warn(`Same-check conflict: CLOSE+BUY on ${conflictSymbols.join(', ')} — ignoring both actions for these symbols`);
      decisions = decisions.filter(d => !conflictSymbols.includes(d.symbol));
      newEntries = newEntries.filter(e => !conflictSymbols.includes(e.symbol));
    }

    // Execute decisions
    const decisionActions = await executeDecisions(decisions, prices);
    const entryActions = await executeNewEntries(newEntries, prices);

    // Queue summary event for Ollama bot
    const allActions = [...safetyActions, ...decisionActions, ...entryActions];
    const summaryType = isDeepCheck ? 'DEEP_CHECK_SUMMARY' : 'HOURLY_SUMMARY';
    const positionsAfter = await getOpenPositions();
    const summaryData = {
      checkType: isDeepCheck ? 'deep' : 'light',
      marketPhase: analysis.marketPhase || 'UNKNOWN',
      symbolsAnalyzed: ALL_SYMBOLS.length,
      openPositions: positionsAfter.map(p => {
        const entry = parseFloat(p.avg_entry_price);
        const cur = prices[p.symbol] || entry;
        return {
          symbol: p.symbol,
          pnl: Math.round((cur - entry) * parseFloat(p.remaining_qty) * 100) / 100,
          pnlPercent: Math.round(((cur - entry) / entry) * 10000) / 100,
          action: (analysis.decisions || []).find(d => d.symbol === p.symbol)?.action || 'HOLD',
        };
      }),
      newEntrySignals: (analysis.newEntries || []).map(e => ({
        symbol: e.symbol,
        confidence: e.confidence || 0,
        reason: (e.confidence || 0) < CONF.minBuyConfidence
          ? `Below threshold (${CONF.minBuyConfidence})`
          : e.reasoning,
      })),
      tokensUsed: analysis.tokensUsed || 0,
      cost: analysis.cost || 0,
    };
    if (isDeepCheck) {
      summaryData.newsHeadlines = analysis.summary ? [analysis.summary] : [];
    }
    queueEvent(summaryType, null, summaryData).catch(() => {});

    logger.info(`Check complete: ${allActions.length} actions, ${analysis.tokensUsed} tokens, $${(analysis.cost || 0).toFixed(4)}`);
  } catch (err) {
    logger.error(`Scheduled check failed: ${err.message}`);
  }
}

// ── Alert response loop ────────────────────────────────────

async function processUnhandledAlerts() {
  try {
    const result = await query(
      `SELECT * FROM alerts WHERE handled = false ORDER BY created_at LIMIT 10`
    );
    if (result.rows.length === 0) return;

    logger.info(`Processing ${result.rows.length} unhandled alerts`);

    for (const alert of result.rows) {
      try {
        const cb = await checkCircuitBreaker();
        const position = await getPositionBySymbol(alert.symbol);
        let currentPrice;
        try { currentPrice = await getPrice(alert.symbol); } catch { currentPrice = parseFloat(alert.price); }

        // Get TA for the alerted symbol
        let taSummary = '';
        try {
          const ta = await analyzeSymbol(alert.symbol);
          taSummary = formatForClaude(ta);
        } catch { /* proceed without TA */ }

        const response = await alertCheck(alert, position, currentPrice, cb, taSummary);
        const confidence = response.confidence || 0;

        if (response.action === 'CLOSE' && position && confidence >= CONF.minSellConfidence) {
          await closePosition(position.id, currentPrice, 'MANUAL');
          logger.info(`Alert: closed ${alert.symbol} @ $${currentPrice.toFixed(2)} (conf=${confidence})`);
        } else if (response.action === 'DCA' && position && confidence >= CONF.minDCAConfidence) {
          const dcaCheck = shouldDCA(position, currentPrice);
          if (dcaCheck) {
            await executeDCA(position.id, dcaCheck.level, currentPrice);
            logger.info(`Alert: DCA${dcaCheck.level} ${alert.symbol} (conf=${confidence})`);
          }
        } else if (response.action === 'BUY' && !position && !cb.isPaused && confidence >= CONF.minBuyConfidence) {
          const cooldown = await isSymbolOnCooldown(alert.symbol);
          if (cooldown.onCooldown) {
            logger.info(`Alert: skipping BUY on ${alert.symbol} — cooldown active (closed ${cooldown.hoursAgo}h ago, ${cooldown.hoursRemaining}h remaining)`);
          } else {
            const { canOpen } = await canOpenPosition();
            if (canOpen) {
              await openPosition(alert.symbol, currentPrice, tradingConfig.positionSize);
              logger.info(`Alert: opened ${alert.symbol} @ $${currentPrice.toFixed(2)} (conf=${confidence})`);
            }
          }
        }

        await query('UPDATE alerts SET handled = true WHERE id = $1', [alert.id]);
      } catch (err) {
        logger.error(`Alert ${alert.id} (${alert.symbol}) failed: ${err.message}`);
        await query('UPDATE alerts SET handled = true WHERE id = $1', [alert.id]);
      }
    }
  } catch (err) {
    logger.error(`Alert processing failed: ${err.message}`);
  }
}

// ── Main ───────────────────────────────────────────────────

let alertInterval = null;

async function start() {
  logger.info('Trading Engine starting...');
  logger.info(`Mode: ${process.env.PAPER_TRADING !== 'false' ? 'PAPER' : 'LIVE'}`);
  logger.info(`Position size: $${tradingConfig.positionSize}`);
  logger.info(`Max positions: ${tradingConfig.maxConcurrentPositions}`);
  logger.info(`Buy confidence threshold: ${CONF.minBuyConfidence}`);

  connectWebSocket(ALL_SYMBOLS, null);

  logger.info('Waiting 15s for WebSocket price data...');
  await new Promise(resolve => setTimeout(resolve, 15000));

  // Hourly cron
  cron.schedule('0 * * * *', () => {
    runScheduledCheck().catch(err => logger.error(`Cron error: ${err.message}`));
  });

  // Daily event cleanup at midnight UTC
  cron.schedule('0 0 * * *', () => {
    cleanOldEvents(7).catch(err => logger.error(`Event cleanup error: ${err.message}`));
  });

  queueEvent('SYSTEM', null, {
    message: 'Trading engine started', severity: 'INFO',
  }).catch(() => {});

  // Alert loop every 30s
  alertInterval = setInterval(() => {
    processUnhandledAlerts().catch(err => logger.error(`Alert loop error: ${err.message}`));
  }, 30 * 1000);

  logger.info('Running initial check...');
  await runScheduledCheck();

  logger.info('Trading Engine running — hourly TA+AI checks + 30s alert loop');
}

function shutdown() {
  logger.info('Trading Engine shutting down...');
  if (alertInterval) clearInterval(alertInterval);
  disconnectWebSocket();
  pool.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => {
  logger.error(`Trading Engine fatal: ${err.message}`);
  process.exit(1);
});
