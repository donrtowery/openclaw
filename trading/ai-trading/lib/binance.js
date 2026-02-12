import crypto from 'crypto';
import dotenv from 'dotenv';
import logger from './logger.js';

dotenv.config();

const BASE_URL = process.env.BINANCE_BASE_URL || 'https://api.binance.us';
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_SECRET_KEY;

/**
 * Generate HMAC-SHA256 signature for authenticated requests
 */
function sign(queryString) {
  return crypto
    .createHmac('sha256', API_SECRET)
    .update(queryString)
    .digest('hex');
}

/**
 * Make a request to the Binance API
 */
async function request(endpoint, params = {}, method = 'GET', signed = false) {
  let queryString = new URLSearchParams(params).toString();

  if (signed) {
    const timestamp = Date.now();
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}`;
    const signature = sign(queryString);
    queryString += `&signature=${signature}`;
  }

  const url = `${BASE_URL}${endpoint}${queryString ? '?' + queryString : ''}`;
  const options = {
    method,
    headers: signed ? { 'X-MBX-APIKEY': API_KEY } : {},
  };

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        // Retry on 5xx server errors, not on 4xx client errors
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          logger.warn(`[Binance] ${method} ${endpoint} returned ${response.status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw new Error(`Binance API ${response.status}: ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      // Retry on network errors (timeouts, connection refused), not on parse errors
      if (attempt < MAX_RETRIES && !error.message.startsWith('Binance API')) {
        logger.warn(`[Binance] ${method} ${endpoint} failed: ${error.message}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      logger.error(`[Binance] ${method} ${endpoint} failed: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Get candlestick data.
 * Named `getCandles` to match the import in technical-analysis.js (v1 proven file).
 * Returns objects with: open, high, low, close, volume, openTime, closeTime
 */
export async function getCandles(symbol, interval = '5m', limit = 100) {
  const data = await request('/api/v3/klines', { symbol, interval, limit });

  return data.map(candle => ({
    openTime: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
    closeTime: candle[6],
  }));
}

/**
 * Get current price for a symbol
 */
export async function getCurrentPrice(symbol) {
  const data = await request('/api/v3/ticker/price', { symbol });
  return parseFloat(data.price);
}

/**
 * Get current prices for all symbols
 */
export async function getAllPrices() {
  const data = await request('/api/v3/ticker/price');
  const priceMap = {};
  for (const item of data) {
    priceMap[item.symbol] = parseFloat(item.price);
  }
  return priceMap;
}

/**
 * Get 24h ticker data (volume, price change, etc.)
 */
export async function get24hTicker(symbol) {
  const data = await request('/api/v3/ticker/24hr', { symbol });

  return {
    symbol: data.symbol,
    priceChange: parseFloat(data.priceChange),
    priceChangePercent: parseFloat(data.priceChangePercent),
    volume: parseFloat(data.volume),
    quoteVolume: parseFloat(data.quoteVolume),
    openPrice: parseFloat(data.openPrice),
    highPrice: parseFloat(data.highPrice),
    lowPrice: parseFloat(data.lowPrice),
    lastPrice: parseFloat(data.lastPrice),
  };
}

/**
 * Place an order (paper or real depending on PAPER_TRADING env)
 */
export async function placeOrder(symbol, side, quantity, price = null) {
  const isPaper = process.env.PAPER_TRADING === 'true';

  if (isPaper) {
    const currentPrice = price || await getCurrentPrice(symbol);
    const mockOrder = {
      symbol,
      orderId: `PAPER_${Date.now()}`,
      side,
      type: 'MARKET',
      quantity,
      price: currentPrice,
      status: 'FILLED',
      executedQty: quantity,
      cummulativeQuoteQty: currentPrice * quantity,
      fills: [{
        price: currentPrice,
        qty: quantity,
        commission: 0,
        commissionAsset: 'USDT',
      }],
    };

    logger.info(`[Binance] PAPER TRADE: ${side} ${quantity} ${symbol} @ $${currentPrice}`);
    return mockOrder;
  }

  // Real order
  const params = {
    symbol,
    side,
    type: 'MARKET',
    quantity: quantity.toFixed(8),
  };

  logger.info(`[Binance] REAL TRADE: ${side} ${quantity} ${symbol}`);
  return await request('/api/v3/order', params, 'POST', true);
}

/**
 * Test connectivity to Binance API
 */
export async function testConnectivity() {
  try {
    await request('/api/v3/ping');
    logger.info('[Binance] API connectivity OK');
    return true;
  } catch (error) {
    logger.error('[Binance] API connectivity failed');
    return false;
  }
}

/**
 * Get account information (authenticated)
 */
export async function getAccountInfo() {
  return await request('/api/v3/account', {}, 'GET', true);
}
