/**
 * Multi-exchange routing wrapper.
 *
 * Routes API calls to the correct exchange based on each symbol's
 * `exchange` column in the symbols table. Falls back to the primary
 * exchange (from config) for unknown symbols.
 *
 * All existing imports continue to work:
 *   import { getCandles, getCurrentPrice, placeOrder, ... } from './binance.js';
 */
import dotenv from 'dotenv';
dotenv.config();

import { createExchange } from './exchanges/factory.js';
import { readFileSync } from 'fs';
import { query } from '../db/connection.js';

const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));
const primaryId = config.exchange?.primary || 'binance_us';

// Exchange instances keyed by exchange ID
const exchanges = {};
// Symbol → exchange ID mapping
const symbolExchangeMap = {};
let initialized = false;

function getOrCreateExchange(exchangeId) {
  if (!exchanges[exchangeId]) {
    const exConfig = {
      ...(config.exchange?.exchanges?.[exchangeId] || {}),
      paper_trading: config.account?.paper_trading,
    };
    exchanges[exchangeId] = createExchange(exchangeId, exConfig);
  }
  return exchanges[exchangeId];
}

// Always create the primary exchange eagerly
getOrCreateExchange(primaryId);

async function ensureInit() {
  if (initialized) return;
  initialized = true;
  try {
    const result = await query('SELECT symbol, exchange FROM symbols WHERE is_active = true');
    for (const row of result.rows) {
      const exId = row.exchange || primaryId;
      symbolExchangeMap[row.symbol] = exId;
      getOrCreateExchange(exId);
    }
    const exIds = [...new Set(Object.values(symbolExchangeMap))];
    if (exIds.length > 1) {
      console.log(`[Exchange] Multi-exchange routing active: ${exIds.join(', ')} (${Object.keys(symbolExchangeMap).length} symbols)`);
    }
  } catch (e) {
    console.error('[Exchange] Failed to load symbol-exchange map, using primary only:', e.message);
  }
}

function getExchangeForSymbol(symbol) {
  return exchanges[symbolExchangeMap[symbol]] || exchanges[primaryId];
}

// ── Exported Functions ─────────────────────────────────────

export async function getCandles(symbol, interval = '5m', limit = 100) {
  await ensureInit();
  return getExchangeForSymbol(symbol).getCandles(symbol, interval, limit);
}

export async function getCurrentPrice(symbol) {
  await ensureInit();
  return getExchangeForSymbol(symbol).getCurrentPrice(symbol);
}

export async function getAllPrices() {
  await ensureInit();
  const allPrices = {};
  for (const [id, ex] of Object.entries(exchanges)) {
    try {
      const prices = await ex.getAllPrices();
      Object.assign(allPrices, prices);
    } catch (e) {
      console.error(`[Exchange] Failed to get prices from ${id}: ${e.message}`);
    }
  }
  return allPrices;
}

export async function get24hTicker(symbol) {
  await ensureInit();
  return getExchangeForSymbol(symbol).get24hTicker(symbol);
}

export async function placeOrder(symbol, side, quantity, price = null) {
  await ensureInit();
  return getExchangeForSymbol(symbol).placeOrder(symbol, side, quantity, price);
}

export async function testConnectivity() {
  await ensureInit();
  const results = {};
  for (const [id, ex] of Object.entries(exchanges)) {
    results[id] = await ex.testConnectivity();
  }
  return results;
}

export async function getAccountInfo() {
  await ensureInit();
  return exchanges[primaryId].getAccountInfo();
}

/** Expose exchange instances for direct access */
export { exchanges as exchange };
