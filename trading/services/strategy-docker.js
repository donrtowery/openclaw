const fs = require('fs');
const path = require('path');
const { SMA } = require('technicalindicators');

// Load configuration
const symbols = require('../config/symbols.json');
const strategyConfig = require('../config/strategy.json');
const riskConfig = require('../config/risk.json');

const DATA_DIR = '/home/node/.openclaw/data';
const CANDLES_DIR = path.join(DATA_DIR, 'candles');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const STATE_FILE = '/home/node/.openclaw/trading_state.json';

// Calculate SMA for a dataset
function calculateSMA(prices, period) {
  return SMA.calculate({ period: period, values: prices });
}

// Check if we have a crossover
function detectCrossover(fastSMA, slowSMA) {
  const len = Math.min(fastSMA.length, slowSMA.length);
  if (len < 2) return null;
  
  const current_fast = fastSMA[len - 1];
  const current_slow = slowSMA[len - 1];
  const prev_fast = fastSMA[len - 2];
  const prev_slow = slowSMA[len - 2];
  
  // Bullish crossover: fast crosses above slow
  if (prev_fast <= prev_slow && current_fast > current_slow) {
    return 'BUY';
  }
  
  // Bearish crossover: fast crosses below slow
  if (prev_fast >= prev_slow && current_fast < current_slow) {
    return 'SELL';
  }
  
  return null;
}

// Analyze a single symbol
function analyzeSymbol(symbol) {
  try {
    const candleFile = path.join(CANDLES_DIR, `${symbol}_${symbols.candleInterval}.json`);
    
    if (!fs.existsSync(candleFile)) {
      console.log(`⚠️  No data file for ${symbol}`);
      return null;
    }
    
    const candles = JSON.parse(fs.readFileSync(candleFile, 'utf8'));
    
    if (candles.length < strategyConfig.parameters.slowPeriod) {
      console.log(`⚠️  Not enough data for ${symbol} (need ${strategyConfig.parameters.slowPeriod} candles)`);
      return null;
    }
    
    // Extract close prices
    const closePrices = candles.map(c => c.close);
    
    // Calculate moving averages
    const fastSMA = calculateSMA(closePrices, strategyConfig.parameters.fastPeriod);
    const slowSMA = calculateSMA(closePrices, strategyConfig.parameters.slowPeriod);
    
    // Detect crossover
    const signal = detectCrossover(fastSMA, slowSMA);
    
    if (!signal) {
      return null; // No signal
    }
    
    // Get current price and volume
    const latestCandle = candles[candles.length - 1];
    const currentPrice = latestCandle.close;
    const volume24h = candles.slice(-288).reduce((sum, c) => sum + (c.close * c.volume), 0); // ~24h of 5m candles
    
    // Apply filters
    if (volume24h < strategyConfig.filters.minVolumeUSD) {
      console.log(`⚠️  ${symbol} volume too low: $${volume24h.toFixed(0)}`);
      return null;
    }
    
    // Calculate price change
    const priceChange = ((currentPrice - candles[candles.length - 2].close) / candles[candles.length - 2].close) * 100;
    
    if (Math.abs(priceChange) < strategyConfig.filters.minPriceChangePercent) {
      console.log(`⚠️  ${symbol} price change too small: ${priceChange.toFixed(2)}%`);
      return null;
    }
    
    return {
      symbol: symbol,
      signal: signal,
      price: currentPrice,
      fastSMA: fastSMA[fastSMA.length - 1],
      slowSMA: slowSMA[slowSMA.length - 1],
      volume24h: volume24h,
      priceChange: priceChange,
      timestamp: Date.now(),
      strategy: strategyConfig.strategyType
    };
    
  } catch (error) {
    console.error(`❌ Error analyzing ${symbol}:`, error.message);
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

// Save signals to file
function saveSignals(signals) {
  try {
    const existingSignals = fs.existsSync(SIGNALS_FILE) 
      ? JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'))
      : [];
    
    const allSignals = [...existingSignals, ...signals];
    
    // Keep only last 100 signals
    const recentSignals = allSignals.slice(-100);
    
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(recentSignals, null, 2));
    console.log(`💾 Saved ${signals.length} new signals`);
  } catch (error) {
    console.error('❌ Error saving signals:', error.message);
  }
}

// Main analysis loop
async function run() {
  console.log('🎯 Strategy Engine Started');
  console.log(`📊 Strategy: ${strategyConfig.strategyType}`);
  console.log(`📈 Fast SMA: ${strategyConfig.parameters.fastPeriod}, Slow SMA: ${strategyConfig.parameters.slowPeriod}`);
  console.log('');
  
  // Check if trading is enabled
  if (!isTradingEnabled()) {
    console.log('⚠️  Trading DISABLED - Strategy paused');
    console.log('🔄 Will retry in 1 minute...');
    setTimeout(run, 60 * 1000);
    return;
  }
  
  console.log('✅ Trading ENABLED - Analyzing markets');
  
  const signals = [];
  
  // Analyze each symbol
  for (const symbol of symbols.symbols) {
    console.log(`🔍 Analyzing ${symbol}...`);
    
    const signal = analyzeSymbol(symbol);
    
    if (signal) {
      console.log(`🚨 ${signal.signal} signal for ${symbol} at $${signal.price.toFixed(2)}`);
      console.log(`   Fast SMA: ${signal.fastSMA.toFixed(2)}, Slow SMA: ${signal.slowSMA.toFixed(2)}`);
      signals.push(signal);
    } else {
      console.log(`   No signal for ${symbol}`);
    }
  }
  
  if (signals.length > 0) {
    saveSignals(signals);
    console.log(`✅ Generated ${signals.length} signals`);
  } else {
    console.log('✅ No signals generated (no crossovers detected)');
  }
  
  console.log(`🔄 Next analysis in 5 minutes`);
  
  // Schedule next run in 5 minutes
  setTimeout(run, 5 * 60 * 1000);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 Shutting down strategy engine...');
  process.exit(0);
});

// Start
run().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
