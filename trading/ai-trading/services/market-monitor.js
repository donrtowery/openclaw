import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

import logger from '../lib/logger.js';
import { query } from '../db/connection.js';
import pool from '../db/connection.js';
import { connectWebSocket, disconnectWebSocket, getCachedPrice } from '../lib/binance.js';
import { queueEvent } from '../lib/events.js';
import { getOpenPositions } from '../lib/position-manager.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tiersConfig = require('../config/tiers.json');

// All tracked symbols from config
const ALL_SYMBOLS = Object.values(tiersConfig.tiers).flatMap(t => t.symbols);
const LEAD_SYMBOL = ALL_SYMBOLS[0]; // First tier-1 symbol for hourly tracking

// ── Alert de-duplication ───────────────────────────────────

// Track last alert time: "SYMBOL:ALERT_TYPE" => timestamp
const lastAlertMap = new Map();
const DEDUP_WINDOW = 60 * 60 * 1000; // 1 hour

function canFireAlert(symbol, alertType) {
  const key = `${symbol}:${alertType}`;
  const last = lastAlertMap.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW) return false;
  lastAlertMap.set(key, Date.now());
  return true;
}

// ── Lead symbol hourly tracking ────────────────────────────

const leadHourlyPrices = []; // { price, timestamp }
const MAX_LEAD_HISTORY = 12; // 12 hours

function recordLeadHourly(price) {
  leadHourlyPrices.push({ price, timestamp: Date.now() });
  if (leadHourlyPrices.length > MAX_LEAD_HISTORY) leadHourlyPrices.shift();
}

function checkLeadHourlyMove() {
  if (leadHourlyPrices.length < 2) return null;
  const oldest = leadHourlyPrices[0];
  const now = getCachedPrice(LEAD_SYMBOL);
  if (!now) return null;

  const change = ((now.price - oldest.price) / oldest.price) * 100;
  if (Math.abs(change) >= 5) {
    return { change, from: oldest.price, to: now.price };
  }
  return null;
}

// ── Alert firing ───────────────────────────────────────────

async function fireAlert(symbol, alertType, threshold, price) {
  if (!canFireAlert(symbol, alertType)) return;

  try {
    const result = await query(
      `INSERT INTO alerts (symbol, alert_type, threshold, price)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [symbol, alertType, threshold, price]
    );
    const alert = result.rows[0];

    logger.info(`ALERT: ${alertType} ${symbol} @ $${price.toFixed(2)} (threshold: ${threshold}%)`);

    queueEvent('ALERT', symbol, {
      alertType: alertType,
      symbol,
      details: `${symbol} ${alertType.replace('_', ' ').toLowerCase()} ${threshold}% @ $${price.toFixed(2)}`,
    }).catch(() => {});
  } catch (err) {
    logger.error(`Failed to fire alert ${alertType} ${symbol}: ${err.message}`);
  }
}

// ── Position monitoring ────────────────────────────────────

async function checkPositionAlerts() {
  try {
    const positions = await getOpenPositions();

    for (const pos of positions) {
      const cached = getCachedPrice(pos.symbol);
      if (!cached) continue;

      const entryPrice = parseFloat(pos.entry_price);
      const currentPrice = cached.price;
      const changePercent = ((currentPrice - entryPrice) / entryPrice) * 100;

      // Check position movement thresholds: +/-5%, +/-10%, +/-15%
      for (const threshold of [5, 10, 15]) {
        if (changePercent <= -threshold) {
          await fireAlert(pos.symbol, 'PRICE_DROP', threshold, currentPrice);
        }
        if (changePercent >= threshold) {
          await fireAlert(pos.symbol, 'PRICE_SPIKE', threshold, currentPrice);
        }
      }

      // Stop loss proximity (<2% away)
      const stopPrice = parseFloat(pos.stop_loss_price);
      const distToStop = ((currentPrice - stopPrice) / currentPrice) * 100;
      if (distToStop < 2 && distToStop > 0) {
        await fireAlert(pos.symbol, 'STOP_TRIGGER', distToStop, currentPrice);
      }

      // Actual stop loss hit
      if (currentPrice <= stopPrice) {
        await fireAlert(pos.symbol, 'STOP_TRIGGER', 0, currentPrice);
      }

      // TP triggers
      if (!pos.tp1_hit && currentPrice >= parseFloat(pos.tp1_price)) {
        await fireAlert(pos.symbol, 'TP_TRIGGER', 5, currentPrice);
      }
      if (!pos.tp2_hit && currentPrice >= parseFloat(pos.tp2_price)) {
        await fireAlert(pos.symbol, 'TP_TRIGGER', 8, currentPrice);
      }
      if (!pos.tp3_hit && currentPrice >= parseFloat(pos.tp3_price)) {
        await fireAlert(pos.symbol, 'TP_TRIGGER', 12, currentPrice);
      }

      // DCA trigger
      if (pos.dca_level < 1) {
        const dca1Price = entryPrice * 0.95; // -5%
        if (currentPrice <= dca1Price) {
          await fireAlert(pos.symbol, 'DCA_TRIGGER', 5, currentPrice);
        }
      }
    }
  } catch (err) {
    logger.error(`Position alert check failed: ${err.message}`);
  }
}

// ── Volume spike detection ─────────────────────────────────

// Track baseline volumes per symbol
const volumeBaseline = new Map();

function checkVolumeSpike(symbol, volume24h) {
  const baseline = volumeBaseline.get(symbol);

  if (!baseline) {
    volumeBaseline.set(symbol, { total: volume24h, count: 1 });
    return;
  }

  // Update rolling average
  baseline.total += volume24h;
  baseline.count++;
  const avg = baseline.total / baseline.count;

  // Spike if > 200% of average
  if (volume24h > avg * 2 && baseline.count > 5) {
    fireAlert(symbol, 'VOLUME_SPIKE', 200, getCachedPrice(symbol)?.price || 0);
  }
}

// ── Main ───────────────────────────────────────────────────

let checkInterval = null;
let btcRecordInterval = null;

async function start() {
  logger.info('Market Monitor starting...');
  logger.info(`Tracking ${ALL_SYMBOLS.length} symbols`);

  // Connect WebSocket
  connectWebSocket(ALL_SYMBOLS, (update) => {
    checkVolumeSpike(update.symbol, update.volume24h);
  });

  // Check positions for alerts every 30 seconds
  checkInterval = setInterval(checkPositionAlerts, 30 * 1000);

  // Record lead symbol hourly price every hour
  btcRecordInterval = setInterval(() => {
    const lead = getCachedPrice(LEAD_SYMBOL);
    if (lead) {
      recordLeadHourly(lead.price);
      const hourlyMove = checkLeadHourlyMove();
      if (hourlyMove) {
        fireAlert(LEAD_SYMBOL, hourlyMove.change > 0 ? 'PRICE_SPIKE' : 'PRICE_DROP',
          Math.abs(hourlyMove.change).toFixed(1), hourlyMove.to);
      }
    }
  }, 60 * 60 * 1000);

  // Initial lead symbol record
  setTimeout(() => {
    const lead = getCachedPrice(LEAD_SYMBOL);
    if (lead) recordLeadHourly(lead.price);
  }, 10000);

  logger.info('Market Monitor running');
}

function shutdown() {
  logger.info('Market Monitor shutting down...');
  if (checkInterval) clearInterval(checkInterval);
  if (btcRecordInterval) clearInterval(btcRecordInterval);
  disconnectWebSocket();
  pool.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => {
  logger.error(`Market Monitor fatal: ${err.message}`);
  process.exit(1);
});
