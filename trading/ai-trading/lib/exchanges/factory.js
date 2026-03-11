import { BinanceUSExchange } from './binance-us.js';
import { BinanceComExchange } from './binance-com.js';
import { CoinbaseExchange } from './coinbase.js';
import { KrakenExchange } from './kraken.js';

const EXCHANGE_CLASSES = {
  binance_us: BinanceUSExchange,
  binance_com: BinanceComExchange,
  coinbase: CoinbaseExchange,
  kraken: KrakenExchange,
};

/**
 * Create an exchange instance from config.
 *
 * @param {string} exchangeId - Exchange identifier (binance_us, binance_com, coinbase, kraken)
 * @param {object} config - Exchange-specific config (api_key, api_secret, base_url, etc.)
 * @returns {ExchangeInterface}
 */
export function createExchange(exchangeId, config = {}) {
  const ExchangeClass = EXCHANGE_CLASSES[exchangeId];
  if (!ExchangeClass) {
    throw new Error(`Unknown exchange: ${exchangeId}. Available: ${Object.keys(EXCHANGE_CLASSES).join(', ')}`);
  }
  return new ExchangeClass(config);
}

/** List available exchange IDs */
export function getAvailableExchanges() {
  return Object.keys(EXCHANGE_CLASSES);
}
