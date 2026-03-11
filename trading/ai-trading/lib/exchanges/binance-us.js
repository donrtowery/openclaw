import crypto from 'crypto';
import { readFileSync } from 'fs';
import { ExchangeInterface } from './exchange-interface.js';
import logger from '../logger.js';

/**
 * Binance.US exchange implementation.
 * Refactored from lib/binance.js — preserves all existing logic.
 */
export class BinanceUSExchange extends ExchangeInterface {
  constructor(config = {}) {
    super(config);
    this.name = 'binance_us';
    this.baseUrl = config.base_url || process.env.BINANCE_BASE_URL || 'https://api.binance.us';
    this.apiKey = config.api_key || process.env.BINANCE_API_KEY;
    this.apiSecret = config.api_secret || process.env.BINANCE_SECRET_KEY;
    this.exchangeInfoCache = null;
    this.exchangeInfoExpiry = 0;
    this.paperTrading = config.paper_trading ?? (process.env.PAPER_TRADING === 'true');
    this.slippageConfig = null; // lazy-loaded
  }

  sign(queryString) {
    if (!this.apiSecret) throw new Error('BINANCE_SECRET_KEY not set');
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  async request(endpoint, params = {}, method = 'GET', signed = false) {
    let queryString = new URLSearchParams(params).toString();

    if (signed) {
      const timestamp = Date.now();
      queryString += (queryString ? '&' : '') + `timestamp=${timestamp}`;
      const signature = this.sign(queryString);
      queryString += `&signature=${signature}`;
    }

    const url = `${this.baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;
    const options = {
      method,
      headers: signed ? { 'X-MBX-APIKEY': this.apiKey } : {},
    };

    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, options);

        if (!response.ok) {
          const errorText = await response.text();
          if (response.status >= 500 && attempt < MAX_RETRIES) {
            logger.warn(`[${this.name}] ${method} ${endpoint} returned ${response.status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          throw new Error(`${this.name} API ${response.status}: ${errorText}`);
        }

        return await response.json();
      } catch (error) {
        if (attempt < MAX_RETRIES && !error.message.startsWith(`${this.name} API`)) {
          logger.warn(`[${this.name}] ${method} ${endpoint} failed: ${error.message}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        logger.error(`[${this.name}] ${method} ${endpoint} failed: ${error.message}`);
        throw error;
      }
    }
    throw new Error(`${this.name} API request exhausted all retries for ${endpoint}`);
  }

  async getCandles(symbol, interval = '5m', limit = 100) {
    const data = await this.request('/api/v3/klines', { symbol, interval, limit });
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

  async getCurrentPrice(symbol) {
    const data = await this.request('/api/v3/ticker/price', { symbol });
    return parseFloat(data.price);
  }

  async getAllPrices() {
    const data = await this.request('/api/v3/ticker/price');
    const priceMap = {};
    for (const item of data) {
      priceMap[item.symbol] = parseFloat(item.price);
    }
    return priceMap;
  }

  async get24hTicker(symbol) {
    const data = await this.request('/api/v3/ticker/24hr', { symbol });
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

  async getStepSize(symbol) {
    if (!this.exchangeInfoCache || Date.now() > this.exchangeInfoExpiry) {
      const info = await this.request('/api/v3/exchangeInfo');
      const newCache = {};
      for (const s of info.symbols) {
        const lotSize = s.filters.find(f => f.filterType === 'LOT_SIZE');
        if (lotSize) newCache[s.symbol] = parseFloat(lotSize.stepSize);
      }
      this.exchangeInfoCache = newCache;
      this.exchangeInfoExpiry = Date.now() + 24 * 60 * 60 * 1000;
    }
    return this.exchangeInfoCache[symbol] || 0.00000001;
  }

  roundToStepSize(quantity, stepSize) {
    if (stepSize <= 0) return quantity;
    const decimals = Math.max(0, -Math.floor(Math.log10(stepSize)));
    const rounded = Math.floor(quantity / stepSize) * stepSize;
    return parseFloat(rounded.toFixed(decimals));
  }

  _getSlippage(symbol) {
    if (!this.slippageConfig) {
      try {
        const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));
        this.slippageConfig = {
          t1Label: config.position_sizing?.tier_1?.label || '',
          t1Slippage: config.position_sizing?.tier_1?.slippage_pct || 0.0005,
          t2Slippage: config.position_sizing?.tier_2?.slippage_pct || 0.0015,
        };
      } catch {
        this.slippageConfig = {
          t1Label: '',
          t1Slippage: 0.0005,
          t2Slippage: 0.0015,
        };
      }
    }
    const symbolBase = symbol.replace('USDT', '');
    if (this.slippageConfig.t1Label.includes(symbolBase)) return this.slippageConfig.t1Slippage;
    return this.slippageConfig.t2Slippage;
  }

  async placeOrder(symbol, side, quantity, price = null) {
    const isPaper = this.paperTrading;

    if (isPaper) {
      const basePrice = price || await this.getCurrentPrice(symbol);
      const stepSize = await this.getStepSize(symbol);
      const roundedQty = this.roundToStepSize(quantity, stepSize);
      if (roundedQty <= 0) throw new Error(`Paper order quantity ${quantity} rounds to 0 for ${symbol} (step: ${stepSize})`);

      const slippagePct = this._getSlippage(symbol);
      const fillPrice = side === 'BUY' ? basePrice * (1 + slippagePct) : basePrice * (1 - slippagePct);
      const fillCost = fillPrice * roundedQty;
      const feeRate = parseFloat(process.env.TRADING_FEE_RATE || '0.001');
      const commission = fillCost * feeRate;

      const mockOrder = {
        symbol, orderId: `PAPER_${Date.now()}`, side, type: 'MARKET',
        quantity: roundedQty, price: fillPrice, status: 'FILLED',
        executedQty: roundedQty, cummulativeQuoteQty: fillCost,
        fills: [{ price: fillPrice, qty: roundedQty, commission, commissionAsset: 'USDT' }],
      };

      const slippage = ((fillPrice - basePrice) / basePrice * 100).toFixed(3);
      const shortLabel = side === 'SELL' && !price ? ' (SHORT ENTRY)' : '';
      logger.info(`[${this.name}] PAPER TRADE: ${side}${shortLabel} ${roundedQty} ${symbol} @ $${fillPrice.toFixed(4)} (slip: ${slippage}%, fee: $${commission.toFixed(2)})`);
      return mockOrder;
    }

    // Real order
    const stepSize = await this.getStepSize(symbol);
    const roundedQty = this.roundToStepSize(quantity, stepSize);
    if (roundedQty <= 0) throw new Error(`Order quantity ${quantity} rounds to 0 for ${symbol} (step: ${stepSize})`);

    const params = { symbol, side, type: 'MARKET', quantity: String(roundedQty) };
    logger.info(`[${this.name}] REAL TRADE: ${side} ${roundedQty} ${symbol}`);

    let result;
    try {
      result = await this.request('/api/v3/order', params, 'POST', true);
    } catch (orderErr) {
      if (orderErr.message && (orderErr.message.includes('LOT_SIZE') || orderErr.message.includes('QUANTITY') || orderErr.message.includes('stepSize'))) {
        logger.warn(`[${this.name}] Order failed with LOT_SIZE error — invalidating cache and retrying`);
        this.exchangeInfoCache = null;
        this.exchangeInfoExpiry = 0;
        const freshStep = await this.getStepSize(symbol);
        const freshQty = this.roundToStepSize(quantity, freshStep);
        params.quantity = String(freshQty);
        result = await this.request('/api/v3/order', params, 'POST', true);
      } else {
        throw orderErr;
      }
    }

    if (result.status !== 'FILLED' && result.status !== 'PARTIALLY_FILLED') {
      throw new Error(`Order ${result.status}: ${result.orderId} for ${symbol}`);
    }
    if (parseFloat(result.executedQty) === 0) {
      throw new Error(`Order filled 0 quantity: ${result.orderId} for ${symbol}`);
    }

    const executedQty = parseFloat(result.executedQty);
    const requestedQty = parseFloat(result.origQty || quantity);
    if (requestedQty > 0 && executedQty < requestedQty * 0.90) {
      logger.warn(`[${this.name}] Partial fill warning: ${executedQty}/${requestedQty} (${(executedQty/requestedQty*100).toFixed(1)}%) for ${symbol}`);
    }

    const cummulativeQuoteQty = parseFloat(result.cummulativeQuoteQty) || 0;
    const fillPrice = cummulativeQuoteQty > 0 ? cummulativeQuoteQty / executedQty : parseFloat(result.price) || 0;

    return { ...result, price: fillPrice, executedQty, cummulativeQuoteQty };
  }

  async testConnectivity() {
    try {
      await this.request('/api/v3/ping');
      logger.info(`[${this.name}] API connectivity OK`);
      return true;
    } catch (error) {
      logger.error(`[${this.name}] API connectivity failed`);
      return false;
    }
  }

  async getAccountInfo() {
    return await this.request('/api/v3/account', {}, 'GET', true);
  }
}
