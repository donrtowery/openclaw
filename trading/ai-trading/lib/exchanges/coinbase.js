import crypto from 'crypto';
import { readFileSync } from 'fs';
import { ExchangeInterface } from './exchange-interface.js';
import logger from '../logger.js';

/**
 * Coinbase Advanced Trade API exchange implementation.
 * Uses CDP API key authentication (JWT/ES256).
 * Symbol format: BTC-USD (internally stored as BTCUSDT).
 */
export class CoinbaseExchange extends ExchangeInterface {
  constructor(config = {}) {
    super(config);
    this.name = 'coinbase';
    this.baseUrl = 'https://api.coinbase.com';
    this.apiKey = config.api_key || process.env.COINBASE_API_KEY;
    this.privateKey = this._loadPrivateKey(config);
    this.paperTrading = config.paper_trading ?? (process.env.PAPER_TRADING === 'true');
    if (!this.privateKey && !this.paperTrading) {
      logger.warn('[coinbase] Private key not loaded — live trading will fail. Check COINBASE_PRIVATE_KEY_PATH or COINBASE_PRIVATE_KEY env vars.');
    }
    this.productCache = null;
    this.productCacheExpiry = 0;
    this._lastRequestTime = 0;
  }

  _loadPrivateKey(config) {
    const keyPath = config.private_key_path || process.env.COINBASE_PRIVATE_KEY_PATH;
    if (keyPath) {
      try { return readFileSync(keyPath, 'utf8'); } catch { /* fall through */ }
    }
    const keyEnv = process.env.COINBASE_PRIVATE_KEY;
    if (keyEnv) return keyEnv.replace(/\\n/g, '\n');
    return null;
  }

  /** Convert BTCUSDT → BTC-USD */
  normalizeSymbol(internalSymbol) {
    return internalSymbol.replace('USDT', '') + '-USD';
  }

  /** Convert BTC-USD → BTCUSDT */
  toInternalSymbol(exchangeSymbol) {
    return exchangeSymbol.replace('-USD', '') + 'USDT';
  }

  // ── JWT Auth ─────────────────────────────────────────────

  _base64url(input) {
    const buf = typeof input === 'string' ? Buffer.from(input) : input;
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  _generateJWT(method, path) {
    const header = {
      alg: 'ES256',
      kid: this.apiKey,
      typ: 'JWT',
      nonce: crypto.randomBytes(16).toString('hex'),
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: this.apiKey,
      iss: 'coinbase-cloud',
      nbf: now,
      exp: now + 300,
      aud: ['cdp_service'],
    };

    if (method && path) {
      // Strip query string for URI claim
      const cleanPath = path.split('?')[0];
      payload.uri = `${method.toUpperCase()} api.coinbase.com${cleanPath}`;
    }

    const headerB64 = this._base64url(JSON.stringify(header));
    const payloadB64 = this._base64url(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const signature = crypto.sign('SHA256', Buffer.from(signingInput), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    });

    return `${signingInput}.${this._base64url(signature)}`;
  }

  _authHeaders(method, path) {
    if (!this.apiKey || !this.privateKey) return { 'Content-Type': 'application/json' };
    const jwt = this._generateJWT(method, path);
    return {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    };
  }

  // ── Rate Limiting ───────────────────────────────────────

  async _throttle() {
    // Chain-based throttle: each request waits for the previous one's delay
    const minInterval = 120; // ~8 req/sec max
    const prev = this._throttleChain || Promise.resolve();
    this._throttleChain = prev.then(() => new Promise(resolve => {
      const now = Date.now();
      const elapsed = now - this._lastRequestTime;
      const wait = Math.max(0, minInterval - elapsed);
      setTimeout(() => {
        this._lastRequestTime = Date.now();
        resolve();
      }, wait);
    }));
    return this._throttleChain;
  }

  // ── HTTP Request ─────────────────────────────────────────

  async _request(method, path, body = null) {
    await this._throttle();
    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: this._authHeaders(method, path),
    };
    if (body) options.body = JSON.stringify(body);

    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, options);

        if (!response.ok) {
          const errText = await response.text();
          if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
            const backoff = response.status === 429 ? 2000 * (attempt + 1) : 500 * (attempt + 1);
            logger.warn(`[${this.name}] ${method} ${path} returned ${response.status}, retrying in ${backoff}ms (${attempt + 1}/${MAX_RETRIES})...`);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          throw new Error(`Coinbase API ${response.status}: ${errText}`);
        }

        return await response.json();
      } catch (error) {
        if (attempt < MAX_RETRIES && !error.message.startsWith('Coinbase API')) {
          logger.warn(`[${this.name}] ${method} ${path} failed: ${error.message}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Coinbase API request exhausted all retries for ${path}`);
  }

  // ── Market Data ──────────────────────────────────────────

  async getCandles(symbol, interval = '5m', limit = 100) {
    const intervalMap = {
      '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE',
      '1h': 'ONE_HOUR', '4h': 'SIX_HOUR', '6h': 'SIX_HOUR', '1d': 'ONE_DAY',
    };
    const granularity = intervalMap[interval] || 'FIVE_MINUTE';
    const productId = this.normalizeSymbol(symbol);

    const end = Math.floor(Date.now() / 1000);
    const seconds = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '6h': 21600, '1d': 86400 };
    const start = end - (seconds[interval] || 300) * limit;

    const path = `/api/v3/brokerage/market/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`;
    const data = await this._request('GET', path);

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
    const path = `/api/v3/brokerage/market/products/${productId}`;
    const data = await this._request('GET', path);
    return parseFloat(data.price);
  }

  async getAllPrices() {
    const path = '/api/v3/brokerage/market/products?product_type=SPOT';
    const data = await this._request('GET', path);
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
    const path = `/api/v3/brokerage/market/products/${productId}`;
    const data = await this._request('GET', path);
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

  // ── Product Info (for order sizing) ──────────────────────

  async _getProductInfo(symbol) {
    if (!this.productCache || Date.now() > this.productCacheExpiry) {
      const data = await this._request('GET', '/api/v3/brokerage/market/products?product_type=SPOT&limit=500');
      this.productCache = {};
      for (const p of (data.products || [])) {
        if (p.quote_currency_id === 'USD') {
          const internal = this.toInternalSymbol(`${p.base_currency_id}-USD`);
          this.productCache[internal] = {
            base_increment: parseFloat(p.base_increment) || 0.00000001,
            base_min_size: parseFloat(p.base_min_size) || 0,
            quote_min_size: parseFloat(p.quote_min_size) || 1,
          };
        }
      }
      this.productCacheExpiry = Date.now() + 24 * 60 * 60 * 1000;
    }
    return this.productCache[symbol] || { base_increment: 0.00000001, base_min_size: 0, quote_min_size: 1 };
  }

  _roundToIncrement(quantity, increment) {
    if (increment <= 0) return quantity;
    const decimals = Math.max(0, -Math.floor(Math.log10(increment)));
    const rounded = Math.floor(quantity / increment) * increment;
    return parseFloat(rounded.toFixed(decimals));
  }

  // ── Order Placement ──────────────────────────────────────

  async placeOrder(symbol, side, quantity, price = null) {
    if (this.paperTrading) {
      return this._paperOrder(symbol, side, quantity, price);
    }
    return this._realOrder(symbol, side, quantity);
  }

  async _paperOrder(symbol, side, quantity, price = null) {
    const basePrice = price || await this.getCurrentPrice(symbol);
    const productInfo = await this._getProductInfo(symbol);
    const roundedQty = this._roundToIncrement(quantity, productInfo.base_increment);
    if (roundedQty <= 0) throw new Error(`Paper order quantity ${quantity} rounds to 0 for ${symbol} (increment: ${productInfo.base_increment})`);

    const slippagePct = 0.001; // 0.1%
    const fillPrice = side === 'BUY' ? basePrice * (1 + slippagePct) : basePrice * (1 - slippagePct);
    const fillCost = fillPrice * roundedQty;
    const feeRate = parseFloat(process.env.COINBASE_FEE_RATE || '0.006'); // 0.6% default taker
    const commission = fillCost * feeRate;

    const mockOrder = {
      symbol, orderId: `CB_PAPER_${Date.now()}`, side, type: 'MARKET',
      quantity: roundedQty, price: fillPrice, status: 'FILLED',
      executedQty: roundedQty, cummulativeQuoteQty: fillCost,
      fills: [{ price: fillPrice, qty: roundedQty, commission, commissionAsset: 'USD' }],
    };

    const slippage = ((fillPrice - basePrice) / basePrice * 100).toFixed(3);
    logger.info(`[${this.name}] PAPER TRADE: ${side} ${roundedQty} ${symbol} @ $${fillPrice.toFixed(4)} (slip: ${slippage}%, fee: $${commission.toFixed(2)})`);
    return mockOrder;
  }

  async _realOrder(symbol, side, quantity) {
    const productId = this.normalizeSymbol(symbol);
    const productInfo = await this._getProductInfo(symbol);
    const roundedQty = this._roundToIncrement(quantity, productInfo.base_increment);
    if (roundedQty <= 0) throw new Error(`Order quantity ${quantity} rounds to 0 for ${symbol} (increment: ${productInfo.base_increment})`);

    const clientOrderId = crypto.randomUUID();
    const body = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: side.toUpperCase(),
      order_configuration: {
        market_market_ioc: {
          base_size: String(roundedQty),
        },
      },
    };

    logger.info(`[${this.name}] REAL TRADE: ${side} ${roundedQty} ${symbol} (${productId})`);

    const result = await this._request('POST', '/api/v3/brokerage/orders', body);

    if (!result.success) {
      const errMsg = result.error_response?.message || result.error_response?.error || JSON.stringify(result);
      throw new Error(`Coinbase order failed: ${errMsg}`);
    }

    const orderId = result.success_response.order_id;

    // Poll for fill (market IOC should fill near-instantly)
    let order;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
      const detail = await this._request('GET', `/api/v3/brokerage/orders/historical/${orderId}`);
      order = detail.order;
      if (order.status === 'FILLED' || order.status === 'CANCELLED' || order.status === 'EXPIRED') break;
    }

    if (!order || order.status !== 'FILLED') {
      const status = order?.status || 'UNKNOWN';
      throw new Error(`Coinbase order not filled: ${orderId} status=${status}`);
    }

    const filledSize = parseFloat(order.filled_size) || 0;
    const filledValue = parseFloat(order.filled_value) || 0;
    const fillPrice = filledSize > 0 ? filledValue / filledSize : 0;
    const totalFees = parseFloat(order.total_fees) || 0;

    if (filledSize === 0) {
      throw new Error(`Coinbase order filled 0 quantity: ${orderId}`);
    }

    logger.info(`[${this.name}] FILLED: ${side} ${filledSize} ${symbol} @ $${fillPrice.toFixed(4)} (fees: $${totalFees.toFixed(2)})`);

    return {
      symbol, orderId, side, type: 'MARKET',
      quantity: filledSize, price: fillPrice, status: 'FILLED',
      executedQty: filledSize, cummulativeQuoteQty: filledValue,
      fills: [{ price: fillPrice, qty: filledSize, commission: totalFees, commissionAsset: 'USD' }],
    };
  }

  // ── Account & Connectivity ───────────────────────────────

  async testConnectivity() {
    try {
      const path = '/api/v3/brokerage/market/products?limit=1';
      await this._request('GET', path);
      logger.info(`[${this.name}] API connectivity OK`);
      return true;
    } catch (error) {
      logger.error(`[${this.name}] API connectivity failed: ${error.message}`);
      return false;
    }
  }

  async getAccountInfo() {
    const data = await this._request('GET', '/api/v3/brokerage/accounts');
    return data;
  }
}
