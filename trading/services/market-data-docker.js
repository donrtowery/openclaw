const Binance = require('binance-api-node').default;
const fs = require('fs');
const path = require('path');

// Load configuration
const symbols = require('../config/symbols.json');
const dotenv = require('dotenv');

// Docker paths
dotenv.config({ path: '/home/node/.openclaw/.env.trading' });

const DATA_DIR = '/home/node/.openclaw/data';
const CANDLES_DIR = path.join(DATA_DIR, 'candles');
const STATE_FILE = '/home/node/.openclaw/trading_state.json';

// Initialize BinanceUS client
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_SECRET_KEY,
  httpBase: 'https://api.binance.us'
});

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(CANDLES_DIR)) {
  fs.mkdirSync(CANDLES_DIR, { recursive: true });
}

// Fetch candles for a symbol
async function fetchCandles(symbol, interval = '5m', limit = 100) {
  try {
    console.log(`📊 Fetching ${interval} candles for ${symbol}...`);
    
    const candles = await client.candles({
      symbol: symbol,
      interval: interval,
      limit: limit
    });

    console.log(`✅ Received ${candles.length} candles for ${symbol}`);
    
    // Transform to simpler format
    const formatted = candles.map(c => ({
      timestamp: c.closeTime,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume)
    }));

    // Save to file
    const filename = path.join(CANDLES_DIR, `${symbol}_${interval}.json`);
    fs.writeFileSync(filename, JSON.stringify(formatted, null, 2));
    console.log(`💾 Saved to ${filename}`);

    return formatted;
  } catch (error) {
    console.error(`❌ Error fetching ${symbol}:`, error.message);
    return null;
  }
}

// Check if trading is enabled
function isTradingEnabled() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return state.tradingEnabled === true;
    }
  } catch (error) {
    console.error('⚠️  Error reading trading state:', error.message);
  }
  return false;
}

// Main loop
async function run() {
  console.log('🚀 Market Data Ingester Started');
  console.log(`📋 Watching symbols: ${symbols.symbols.join(', ')}`);
  console.log(`⏱️  Interval: ${symbols.candleInterval}`);
  console.log('');

  // Check if trading is enabled
  const tradingEnabled = isTradingEnabled();
  
  if (!tradingEnabled) {
    console.log('⚠️  Trading DISABLED - Data collection paused');
    console.log('🔄 Will retry in 1 minute...');
    setTimeout(run, 60 * 1000); // Check again in 1 minute
    return;
  }

  console.log('✅ Trading ENABLED - Collecting data');

  // Fetch data for all symbols
  for (const symbol of symbols.symbols) {
    await fetchCandles(symbol, symbols.candleInterval, 100);
    
    // Rate limiting - wait 1 second between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('✅ Data fetch complete');
  console.log(`🔄 Next update in ${symbols.candleInterval} (5 minutes)`);
  
  // Schedule next run in 5 minutes
  setTimeout(run, 5 * 60 * 1000);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 Shutting down market data ingester...');
  process.exit(0);
});

// Start
run().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
