import Binance from 'binance-api-node';
import logger from './logger.js';

const PAPER_TRADING = process.env.PAPER_TRADING !== 'false';
const API_BASE = process.env.BINANCE_API_URL || 'https://api.binance.us';

// In-memory price cache updated by WebSocket
const priceCache = new Map();

// Paper trading simulated balance
let paperBalance = parseFloat(process.env.PAPER_BALANCE_USD || '6000');

// Binance REST client
let client = null;

function getClient() {
  if (!client) {
    client = Binance.default({
      apiKey: process.env.BINANCE_API_KEY || '',
      apiSecret: process.env.BINANCE_SECRET_KEY || '',
      httpBase: API_BASE,
    });
  }
  return client;
}

// ── WebSocket ──────────────────────────────────────────────

let wsCleanup = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const BASE_DELAY = 2000;

/**
 * Connect to Binance WebSocket for real-time prices.
 * Uses allMiniTickers stream for all symbols in one connection.
 * @param {string[]} symbols - Symbols to track
 * @param {function} onPriceUpdate - Callback: ({symbol, price, volume24h, priceChangePercent})
 */
export function connectWebSocket(symbols, onPriceUpdate) {
  const symbolSet = new Set(symbols.map(s => s.toUpperCase()));
  const binance = getClient();

  function connect() {
    try {
      const clean = binance.ws.allTickers((tickers) => {
        reconnectAttempts = 0; // reset on successful data

        for (const t of tickers) {
          if (!symbolSet.has(t.symbol)) continue;

          const price = parseFloat(t.curDayClose);
          const volume24h = parseFloat(t.totalTradedQuoteAssetVolume);
          const priceChangePercent = parseFloat(t.priceChangePercent);

          priceCache.set(t.symbol, {
            price,
            volume24h,
            priceChangePercent,
            updatedAt: Date.now(),
          });

          if (onPriceUpdate) {
            onPriceUpdate({ symbol: t.symbol, price, volume24h, priceChangePercent });
          }
        }
      });

      wsCleanup = clean;
      logger.info(`WebSocket connected — tracking ${symbols.length} symbols`);
    } catch (err) {
      logger.error(`WebSocket connection error: ${err.message}`);
      scheduleReconnect(symbols, onPriceUpdate);
    }
  }

  connect();
}

function scheduleReconnect(symbols, onPriceUpdate) {
  if (reconnectAttempts >= MAX_RECONNECT) {
    logger.error(`WebSocket: max reconnect attempts (${MAX_RECONNECT}) reached`);
    return;
  }
  reconnectAttempts++;
  const delay = BASE_DELAY * Math.pow(2, reconnectAttempts - 1);
  logger.warn(`WebSocket reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT})`);
  setTimeout(() => connectWebSocket(symbols, onPriceUpdate), delay);
}

/**
 * Disconnect WebSocket cleanly.
 */
export function disconnectWebSocket() {
  if (wsCleanup) {
    try { wsCleanup(); } catch { /* ignore */ }
    wsCleanup = null;
    logger.info('WebSocket disconnected');
  }
}

// ── Market Data (REST fallbacks) ───────────────────────────

/**
 * Get current price for a symbol. Tries cache first, then REST.
 * @param {string} symbol
 * @returns {Promise<number>}
 */
export async function getPrice(symbol) {
  // Try cache first (if fresh within 30s)
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.updatedAt < 30000) {
    return cached.price;
  }

  // REST fallback
  try {
    const binance = getClient();
    const ticker = await binance.prices({ symbol });
    const price = parseFloat(ticker[symbol]);
    priceCache.set(symbol, { price, updatedAt: Date.now() });
    return price;
  } catch (err) {
    logger.error(`getPrice(${symbol}) failed: ${err.message}`);
    // Return stale cache if available
    if (cached) return cached.price;
    throw err;
  }
}

/**
 * Get cached price data (from WebSocket). Returns null if not available.
 * @param {string} symbol
 * @returns {{ price: number, volume24h: number, priceChangePercent: number, updatedAt: number } | null}
 */
export function getCachedPrice(symbol) {
  return priceCache.get(symbol) || null;
}

/**
 * Get all cached prices.
 * @returns {Map}
 */
export function getAllCachedPrices() {
  return priceCache;
}

/**
 * Fetch candlestick data for technical analysis.
 * @param {string} symbol
 * @param {string} interval - e.g. '5m', '1h', '4h', '1d'
 * @param {number} limit - Number of candles (max 1000)
 * @returns {Promise<Array>}
 */
export async function getCandles(symbol, interval = '1h', limit = 100) {
  try {
    const binance = getClient();
    const candles = await binance.candles({ symbol, interval, limit });
    return candles.map(c => ({
      timestamp: c.closeTime,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));
  } catch (err) {
    logger.error(`getCandles(${symbol}, ${interval}) failed: ${err.message}`);
    throw err;
  }
}

// ── Order Execution ────────────────────────────────────────

/**
 * Place a buy order. Paper mode returns simulated fill.
 * @param {string} symbol
 * @param {number} amount - USD amount to spend
 * @returns {Promise<{ symbol, price, quantity, amount, mode }>}
 */
export async function placeBuyOrder(symbol, amount) {
  const price = await getPrice(symbol);
  const quantity = amount / price;

  if (PAPER_TRADING) {
    paperBalance -= amount;
    const fill = {
      symbol,
      price,
      quantity,
      amount,
      mode: 'paper',
      timestamp: Date.now(),
    };
    logger.info(`PAPER BUY: ${symbol} qty=${quantity.toFixed(6)} @ $${price.toFixed(2)} ($${amount})`);
    return fill;
  }

  // Live mode
  try {
    const binance = getClient();
    const order = await binance.order({
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: amount.toFixed(2),
    });
    const fillPrice = parseFloat(order.fills[0]?.price || price);
    const fillQty = parseFloat(order.executedQty);
    const fillAmount = parseFloat(order.cummulativeQuoteQty);
    logger.info(`LIVE BUY: ${symbol} qty=${fillQty} @ $${fillPrice} ($${fillAmount}) orderId=${order.orderId}`);
    return {
      symbol,
      price: fillPrice,
      quantity: fillQty,
      amount: fillAmount,
      mode: 'live',
      orderId: order.orderId,
      timestamp: Date.now(),
    };
  } catch (err) {
    logger.error(`LIVE BUY FAILED: ${symbol} $${amount} — ${err.message}`);
    throw err;
  }
}

/**
 * Place a sell order. Paper mode returns simulated fill.
 * @param {string} symbol
 * @param {number} quantity - Amount of asset to sell
 * @returns {Promise<{ symbol, price, quantity, amount, mode }>}
 */
export async function placeSellOrder(symbol, quantity) {
  const price = await getPrice(symbol);
  const amount = quantity * price;

  if (PAPER_TRADING) {
    paperBalance += amount;
    const fill = {
      symbol,
      price,
      quantity,
      amount,
      mode: 'paper',
      timestamp: Date.now(),
    };
    logger.info(`PAPER SELL: ${symbol} qty=${quantity.toFixed(6)} @ $${price.toFixed(2)} ($${amount.toFixed(2)})`);
    return fill;
  }

  // Live mode
  try {
    const binance = getClient();
    const order = await binance.order({
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: quantity.toFixed(8),
    });
    const fillPrice = parseFloat(order.fills[0]?.price || price);
    const fillQty = parseFloat(order.executedQty);
    const fillAmount = parseFloat(order.cummulativeQuoteQty);
    logger.info(`LIVE SELL: ${symbol} qty=${fillQty} @ $${fillPrice} ($${fillAmount}) orderId=${order.orderId}`);
    return {
      symbol,
      price: fillPrice,
      quantity: fillQty,
      amount: fillAmount,
      mode: 'live',
      orderId: order.orderId,
      timestamp: Date.now(),
    };
  } catch (err) {
    logger.error(`LIVE SELL FAILED: ${symbol} qty=${quantity} — ${err.message}`);
    throw err;
  }
}

/**
 * Get account balance. Paper mode returns simulated balance.
 * @returns {Promise<{ balance: number, mode: string }>}
 */
export async function getAccountBalance() {
  if (PAPER_TRADING) {
    return { balance: paperBalance, mode: 'paper' };
  }

  try {
    const binance = getClient();
    const account = await binance.accountInfo();
    const usdtBalance = account.balances.find(b => b.asset === 'USDT');
    const balance = usdtBalance ? parseFloat(usdtBalance.free) : 0;
    return { balance, mode: 'live' };
  } catch (err) {
    logger.error(`getAccountBalance failed: ${err.message}`);
    throw err;
  }
}
