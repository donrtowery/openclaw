/**
 * Backward-compatible Binance wrapper.
 *
 * Delegates all calls to BinanceUSExchange class from lib/exchanges/.
 * All existing imports (`import { getCandles, ... } from './binance.js'`) continue to work.
 *
 * To switch exchanges, modify the instance creation below or use the factory directly.
 */
import dotenv from 'dotenv';
dotenv.config();

import { createExchange } from './exchanges/factory.js';
import { readFileSync } from 'fs';

// Determine which exchange to use from config (default: binance_us)
let exchangeId = 'binance_us';
try {
  const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));
  exchangeId = config.exchange?.primary || 'binance_us';
} catch { /* use default */ }

// Instantiate the exchange — read exchange-specific config if available
let exchangeConfig = {};
try {
  const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));
  exchangeConfig = config.exchange?.exchanges?.[exchangeId] || {};
} catch { /* use defaults from env */ }

const exchange = createExchange(exchangeId, exchangeConfig);

// ── Backward-compatible named exports ────────────────────────

export async function getCandles(symbol, interval = '5m', limit = 100) {
  return exchange.getCandles(symbol, interval, limit);
}

export async function getCurrentPrice(symbol) {
  return exchange.getCurrentPrice(symbol);
}

export async function getAllPrices() {
  return exchange.getAllPrices();
}

export async function get24hTicker(symbol) {
  return exchange.get24hTicker(symbol);
}

export async function placeOrder(symbol, side, quantity, price = null) {
  return exchange.placeOrder(symbol, side, quantity, price);
}

export async function testConnectivity() {
  return exchange.testConnectivity();
}

export async function getAccountInfo() {
  return exchange.getAccountInfo();
}

/** Expose the underlying exchange instance for direct access */
export { exchange };
