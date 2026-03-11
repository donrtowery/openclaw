/**
 * Abstract exchange interface — all exchange implementations must extend this.
 */
export class ExchangeInterface {
  constructor(config = {}) {
    this.name = 'unknown';
    this.config = config;
  }

  /** Get OHLCV candlestick data */
  async getCandles(symbol, interval = '5m', limit = 100) {
    throw new Error(`${this.name}: getCandles not implemented`);
  }

  /** Get current price for a single symbol */
  async getCurrentPrice(symbol) {
    throw new Error(`${this.name}: getCurrentPrice not implemented`);
  }

  /** Get current prices for all symbols (bulk) */
  async getAllPrices() {
    throw new Error(`${this.name}: getAllPrices not implemented`);
  }

  /** Get 24h ticker data (volume, price change, etc.) */
  async get24hTicker(symbol) {
    throw new Error(`${this.name}: get24hTicker not implemented`);
  }

  /** Place a market order */
  async placeOrder(symbol, side, quantity, price = null) {
    throw new Error(`${this.name}: placeOrder not implemented`);
  }

  /** Test API connectivity */
  async testConnectivity() {
    throw new Error(`${this.name}: testConnectivity not implemented`);
  }

  /** Get account information */
  async getAccountInfo() {
    throw new Error(`${this.name}: getAccountInfo not implemented`);
  }

  /**
   * Normalize internal symbol format (BTCUSDT) to exchange-specific format.
   * Override in exchange implementations that use different formats.
   */
  normalizeSymbol(internalSymbol) {
    return internalSymbol;
  }

  /**
   * Convert exchange-specific symbol to internal format (BTCUSDT).
   * Override in exchange implementations that use different formats.
   */
  toInternalSymbol(exchangeSymbol) {
    return exchangeSymbol;
  }
}
