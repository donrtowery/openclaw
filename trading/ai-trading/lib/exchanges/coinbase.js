import crypto from 'crypto';
import { ExchangeInterface } from './exchange-interface.js';
import logger from '../logger.js';

/**
 * Coinbase Advanced Trade API exchange implementation.
 * Stub — basic structure for future implementation.
 *
 * Key differences from Binance:
 * - REST base: https://api.coinbase.com/api/v3/brokerage/
 * - Auth: JWT or API key with HMAC-SHA256
 * - Symbol format: BTC-USD (not BTCUSDT)
 */
export class CoinbaseExchange extends ExchangeInterface {
  constructor(config = {}) {
    super(config);
    this.name = 'coinbase';
    this.baseUrl = config.base_url || 'https://api.coinbase.com';
    this.apiKey = config.api_key || process.env.COINBASE_API_KEY;
    this.apiSecret = config.api_secret || process.env.COINBASE_SECRET_KEY;
  }

  /** Convert BTCUSDT → BTC-USD */
  normalizeSymbol(internalSymbol) {
    const base = internalSymbol.replace('USDT', '');
    return `${base}-USD`;
  }

  /** Convert BTC-USD → BTCUSDT */
  toInternalSymbol(exchangeSymbol) {
    return exchangeSymbol.replace('-USD', '') + 'USDT';
  }

  async getCandles(symbol, interval = '5m', limit = 100) {
    // Map interval format: '5m' → 'FIVE_MINUTE', '1h' → 'ONE_HOUR'
    const intervalMap = {
      '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE',
      '1h': 'ONE_HOUR', '6h': 'SIX_HOUR', '1d': 'ONE_DAY',
    };
    const granularity = intervalMap[interval] || 'FIVE_MINUTE';
    const productId = this.normalizeSymbol(symbol);

    const end = Math.floor(Date.now() / 1000);
    const seconds = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
    const start = end - (seconds[interval] || 300) * limit;

    const url = `${this.baseUrl}/api/v3/brokerage/market/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`;
    const response = await fetch(url, { headers: this._authHeaders('GET', `/api/v3/brokerage/market/products/${productId}/candles`) });

    if (!response.ok) throw new Error(`Coinbase API ${response.status}: ${await response.text()}`);
    const data = await response.json();

    return (data.candles || []).map(c => ({
      openTime: parseInt(c.start) * 1000,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
      closeTime: (parseInt(c.start) + (seconds[interval] || 300)) * 1000,
    })).reverse(); // Coinbase returns newest first
  }

  async getCurrentPrice(symbol) {
    const productId = this.normalizeSymbol(symbol);
    const url = `${this.baseUrl}/api/v3/brokerage/market/products/${productId}`;
    const response = await fetch(url, { headers: this._authHeaders('GET', `/api/v3/brokerage/market/products/${productId}`) });
    if (!response.ok) throw new Error(`Coinbase API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return parseFloat(data.price);
  }

  async getAllPrices() {
    const url = `${this.baseUrl}/api/v3/brokerage/market/products?product_type=SPOT`;
    const response = await fetch(url, { headers: this._authHeaders('GET', '/api/v3/brokerage/market/products') });
    if (!response.ok) throw new Error(`Coinbase API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const priceMap = {};
    for (const product of (data.products || [])) {
      if (product.quote_currency_id === 'USD') {
        const internal = this.toInternalSymbol(`${product.base_currency_id}-USD`);
        priceMap[internal] = parseFloat(product.price);
      }
    }
    return priceMap;
  }

  async get24hTicker(symbol) {
    const productId = this.normalizeSymbol(symbol);
    const url = `${this.baseUrl}/api/v3/brokerage/market/products/${productId}`;
    const response = await fetch(url, { headers: this._authHeaders('GET', `/api/v3/brokerage/market/products/${productId}`) });
    if (!response.ok) throw new Error(`Coinbase API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return {
      symbol,
      priceChange: parseFloat(data.price_percentage_change_24h || 0),
      priceChangePercent: parseFloat(data.price_percentage_change_24h || 0),
      volume: parseFloat(data.volume_24h || 0),
      quoteVolume: 0,
      openPrice: 0,
      highPrice: 0,
      lowPrice: 0,
      lastPrice: parseFloat(data.price),
    };
  }

  async placeOrder(symbol, side, quantity, price = null) {
    // Stub — would use /api/v3/brokerage/orders
    throw new Error('Coinbase placeOrder not yet implemented — use paper mode with Binance');
  }

  async testConnectivity() {
    try {
      const url = `${this.baseUrl}/api/v3/brokerage/market/products?limit=1`;
      const response = await fetch(url);
      const ok = response.ok;
      logger.info(`[${this.name}] API connectivity ${ok ? 'OK' : 'FAILED'}`);
      return ok;
    } catch (error) {
      logger.error(`[${this.name}] API connectivity failed: ${error.message}`);
      return false;
    }
  }

  async getAccountInfo() {
    throw new Error('Coinbase getAccountInfo not yet implemented');
  }

  _authHeaders(method, path) {
    if (!this.apiKey || !this.apiSecret) return {};
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method.toUpperCase() + path;
    const signature = crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');
    return {
      'CB-ACCESS-KEY': this.apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'Content-Type': 'application/json',
    };
  }
}
