import { BinanceUSExchange } from './binance-us.js';

/**
 * Binance.com (international) exchange.
 * Same API structure as Binance.US, different base URL and symbol availability.
 */
export class BinanceComExchange extends BinanceUSExchange {
  constructor(config = {}) {
    super(config);
    this.name = 'binance_com';
    this.baseUrl = config.base_url || 'https://api.binance.com';
    this.apiKey = config.api_key || process.env.BINANCE_COM_API_KEY;
    this.apiSecret = config.api_secret || process.env.BINANCE_COM_SECRET_KEY;
  }
}
