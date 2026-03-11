import crypto from 'crypto';
import { ExchangeInterface } from './exchange-interface.js';
import logger from '../logger.js';

/**
 * Kraken exchange implementation.
 * Stub — basic structure for future implementation.
 *
 * Key differences from Binance:
 * - REST base: https://api.kraken.com
 * - Public: /0/public/, Private: /0/private/
 * - Auth: nonce + HMAC-SHA512 with API-Sign header
 * - Symbol format: XXBTZUSD (or XBT/USD pair format)
 */

// Kraken uses non-standard symbol names
const SYMBOL_MAP = {
  BTCUSDT: 'XXBTZUSD', ETHUSDT: 'XETHZUSD', SOLUSDT: 'SOLUSD',
  XRPUSDT: 'XXRPZUSD', ADAUSDT: 'ADAUSD', DOTUSDT: 'DOTUSD',
  LINKUSDT: 'LINKUSD', AVAXUSDT: 'AVAXUSD', BNBUSDT: 'BNBUSD',
  POLUSDT: 'POLUSD', ATOMUSDT: 'ATOMUSD', NEARUSDT: 'NEARUSD',
  OPUSDT: 'OPUSD', ARBUSDT: 'ARBUSD', SUIUSDT: 'SUIUSD',
  AAVEUSDT: 'AAVEUSD', UNIUSDT: 'UNIUSD',
};

const REVERSE_MAP = Object.fromEntries(Object.entries(SYMBOL_MAP).map(([k, v]) => [v, k]));

export class KrakenExchange extends ExchangeInterface {
  constructor(config = {}) {
    super(config);
    this.name = 'kraken';
    this.baseUrl = config.base_url || 'https://api.kraken.com';
    this.apiKey = config.api_key || process.env.KRAKEN_API_KEY;
    this.apiSecret = config.api_secret || process.env.KRAKEN_SECRET_KEY;
  }

  normalizeSymbol(internalSymbol) {
    return SYMBOL_MAP[internalSymbol] || internalSymbol.replace('USDT', 'USD');
  }

  toInternalSymbol(exchangeSymbol) {
    return REVERSE_MAP[exchangeSymbol] || exchangeSymbol.replace('USD', '') + 'USDT';
  }

  async request(path, params = {}, isPrivate = false) {
    const url = `${this.baseUrl}${path}`;
    let response;

    if (isPrivate) {
      const nonce = Date.now() * 1000;
      const body = new URLSearchParams({ ...params, nonce }).toString();
      const sha256 = crypto.createHash('sha256').update(String(nonce) + body).digest();
      const hmac = crypto.createHmac('sha512', Buffer.from(this.apiSecret || '', 'base64'))
        .update(Buffer.concat([Buffer.from(path), sha256]))
        .digest('base64');
      response = await fetch(url, {
        method: 'POST',
        body,
        headers: {
          'API-Key': this.apiKey,
          'API-Sign': hmac,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
    } else {
      const qs = Object.keys(params).length > 0 ? '?' + new URLSearchParams(params).toString() : '';
      response = await fetch(`${url}${qs}`);
    }

    if (!response.ok) throw new Error(`Kraken API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    if (data.error && data.error.length > 0) throw new Error(`Kraken error: ${data.error.join(', ')}`);
    return data.result;
  }

  async getCandles(symbol, interval = '5m', limit = 100) {
    const pair = this.normalizeSymbol(symbol);
    const intervalMap = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
    const krakenInterval = intervalMap[interval] || 5;

    const result = await this.request('/0/public/OHLC', { pair, interval: krakenInterval });
    const pairData = Object.values(result)[0] || [];

    return pairData.slice(-limit).map(c => ({
      openTime: parseInt(c[0]) * 1000,
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6]),
      closeTime: (parseInt(c[0]) + krakenInterval * 60) * 1000,
    }));
  }

  async getCurrentPrice(symbol) {
    const pair = this.normalizeSymbol(symbol);
    const result = await this.request('/0/public/Ticker', { pair });
    const tickerData = Object.values(result)[0];
    return parseFloat(tickerData.c[0]); // Last trade close price
  }

  async getAllPrices() {
    const pairs = Object.values(SYMBOL_MAP).join(',');
    const result = await this.request('/0/public/Ticker', { pair: pairs });
    const priceMap = {};
    for (const [pair, data] of Object.entries(result)) {
      const internal = this.toInternalSymbol(pair);
      priceMap[internal] = parseFloat(data.c[0]);
    }
    return priceMap;
  }

  async get24hTicker(symbol) {
    const pair = this.normalizeSymbol(symbol);
    const result = await this.request('/0/public/Ticker', { pair });
    const data = Object.values(result)[0];
    return {
      symbol,
      priceChange: parseFloat(data.c[0]) - parseFloat(data.o),
      priceChangePercent: ((parseFloat(data.c[0]) - parseFloat(data.o)) / parseFloat(data.o) * 100),
      volume: parseFloat(data.v[1]), // 24h volume
      quoteVolume: 0,
      openPrice: parseFloat(data.o),
      highPrice: parseFloat(data.h[1]),
      lowPrice: parseFloat(data.l[1]),
      lastPrice: parseFloat(data.c[0]),
    };
  }

  async placeOrder(symbol, side, quantity, price = null) {
    // Stub — would use /0/private/AddOrder
    throw new Error('Kraken placeOrder not yet implemented — use paper mode with Binance');
  }

  async testConnectivity() {
    try {
      await this.request('/0/public/SystemStatus');
      logger.info(`[${this.name}] API connectivity OK`);
      return true;
    } catch (error) {
      logger.error(`[${this.name}] API connectivity failed: ${error.message}`);
      return false;
    }
  }

  async getAccountInfo() {
    return await this.request('/0/private/Balance', {}, true);
  }
}
