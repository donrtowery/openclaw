const fs = require('fs');
const path = require('path');

// Load configuration
const riskConfig = require('../config/risk.json');
const symbols = require('../config/symbols.json');

const DATA_DIR = path.join(__dirname, '../data');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const VALIDATED_TRADES_FILE = path.join(DATA_DIR, 'validated_trades.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const TRADE_HISTORY_FILE = path.join(DATA_DIR, 'trade_history.json');
const STATE_FILE = path.join(process.env.HOME || '/home/node', '.openclaw/trading_state.json');

// Get current positions
function getPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('⚠️  Error reading positions:', error.message);
  }
  return [];
}

// Get trade history
function getTradeHistory() {
  try {
    if (fs.existsSync(TRADE_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(TRADE_HISTORY_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('⚠️  Error reading trade history:', error.message);
  }
  return [];
}

// Calculate total exposure
function calculateTotalExposure(positions, portfolioValue) {
  const totalExposure = positions.reduce((sum, pos) => {
    return sum + (pos.quantity * pos.entryPrice);
  }, 0);
  return (totalExposure / portfolioValue) * 100;
}

// Check circuit breaker
function isCircuitBreakerTriggered(tradeHistory) {
  if (!riskConfig.circuitBreaker.enabled) {
    return false;
  }
  
  // Check consecutive losses
  const recentTrades = tradeHistory.slice(-10); // Last 10 trades
  let consecutiveLosses = 0;
  
  for (let i = recentTrades.length - 1; i >= 0; i--) {
    const trade = recentTrades[i];
    if (trade.pnl && trade.pnl < 0) {
      consecutiveLosses++;
    } else if (trade.pnl && trade.pnl > 0) {
      break; // Stop counting at first win
    }
  }
  
  if (consecutiveLosses >= riskConfig.circuitBreaker.consecutiveLosses) {
    return `${consecutiveLosses} consecutive losses`;
  }
  
  // Check max drawdown
  const startingBalance = riskConfig.paperTrading.startingBalanceUSD;
  const currentBalance = calculateCurrentBalance(tradeHistory);
  const drawdown = ((startingBalance - currentBalance) / startingBalance) * 100;
  
  if (drawdown >= riskConfig.circuitBreaker.maxDrawdownPercent) {
    return `${drawdown.toFixed(2)}% drawdown`;
  }
  
  return false;
}

// Calculate current balance
function calculateCurrentBalance(tradeHistory) {
  const startingBalance = riskConfig.paperTrading.startingBalanceUSD;
  const totalPnL = tradeHistory.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  return startingBalance + totalPnL;
}

// Calculate position size
function calculatePositionSize(signal, portfolioValue) {
  const maxPositionValue = portfolioValue * (riskConfig.positionSizing.maxPositionSizePercent / 100);
  const quantity = maxPositionValue / signal.price;
  const orderValue = quantity * signal.price;
  
  return {
    quantity: quantity,
    orderValue: orderValue,
    percentOfPortfolio: (orderValue / portfolioValue) * 100
  };
}

// Validate a signal against risk rules
function validateSignal(signal) {
  const positions = getPositions();
  const tradeHistory = getTradeHistory();
  const portfolioValue = calculateCurrentBalance(tradeHistory);
  
  console.log(`\n🔍 Validating ${signal.signal} signal for ${signal.symbol}`);
  console.log(`   Price: $${signal.price.toFixed(2)}`);
  
  // Check if paper trading mode
  if (!riskConfig.paperTrading.enabled) {
    console.log('❌ REJECTED: Paper trading is disabled');
    return { valid: false, reason: 'paper_trading_disabled' };
  }
  
  // Check circuit breaker
  const circuitBreaker = isCircuitBreakerTriggered(tradeHistory);
  if (circuitBreaker) {
    console.log(`❌ REJECTED: Circuit breaker triggered (${circuitBreaker})`);
    return { valid: false, reason: 'circuit_breaker', detail: circuitBreaker };
  }
  
  // Check max concurrent positions
  if (positions.length >= symbols.maxConcurrentPositions) {
    console.log(`❌ REJECTED: Max concurrent positions (${positions.length}/${symbols.maxConcurrentPositions})`);
    return { valid: false, reason: 'max_positions_reached' };
  }
  
  // Check if already have position in this symbol
  const existingPosition = positions.find(p => p.symbol === signal.symbol);
  if (existingPosition && signal.signal === 'BUY') {
    console.log('❌ REJECTED: Already have position in this symbol');
    return { valid: false, reason: 'position_already_exists' };
  }
  
  if (!existingPosition && signal.signal === 'SELL') {
    console.log('❌ REJECTED: No position to sell');
    return { valid: false, reason: 'no_position_to_sell' };
  }
  
  // Calculate position size
  const positionSize = calculatePositionSize(signal, portfolioValue);
  
  // Check minimum order value
  if (positionSize.orderValue < riskConfig.positionSizing.minOrderValueUSD) {
    console.log(`❌ REJECTED: Order value too small ($${positionSize.orderValue.toFixed(2)} < $${riskConfig.positionSizing.minOrderValueUSD})`);
    return { valid: false, reason: 'order_value_too_small' };
  }
  
  // Check total exposure
  const totalExposure = calculateTotalExposure(positions, portfolioValue);
  const newExposure = totalExposure + positionSize.percentOfPortfolio;
  
  if (newExposure > riskConfig.positionSizing.maxTotalExposurePercent) {
    console.log(`❌ REJECTED: Would exceed max exposure (${newExposure.toFixed(2)}% > ${riskConfig.positionSizing.maxTotalExposurePercent}%)`);
    return { valid: false, reason: 'max_exposure_exceeded' };
  }
  
  // Calculate stop loss and take profit
  const stopLoss = signal.price * (1 - riskConfig.stopLoss.defaultPercent / 100);
  const takeProfit = signal.price * (1 + riskConfig.takeProfit.defaultPercent / 100);
  
  console.log(`✅ APPROVED:`);
  console.log(`   Quantity: ${positionSize.quantity.toFixed(6)}`);
  console.log(`   Order Value: $${positionSize.orderValue.toFixed(2)} (${positionSize.percentOfPortfolio.toFixed(2)}% of portfolio)`);
  console.log(`   Stop Loss: $${stopLoss.toFixed(2)} (-${riskConfig.stopLoss.defaultPercent}%)`);
  console.log(`   Take Profit: $${takeProfit.toFixed(2)} (+${riskConfig.takeProfit.defaultPercent}%)`);
  
  return {
    valid: true,
    trade: {
      ...signal,
      quantity: positionSize.quantity,
      orderValue: positionSize.orderValue,
      stopLoss: stopLoss,
      takeProfit: takeProfit,
      portfolioPercent: positionSize.percentOfPortfolio,
      timestamp: Date.now(),
      status: 'pending'
    }
  };
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

// Save validated trades
function saveValidatedTrades(trades) {
  try {
    const existing = fs.existsSync(VALIDATED_TRADES_FILE)
      ? JSON.parse(fs.readFileSync(VALIDATED_TRADES_FILE, 'utf8'))
      : [];
    
    const all = [...existing, ...trades];
    const recent = all.slice(-100); // Keep last 100
    
    fs.writeFileSync(VALIDATED_TRADES_FILE, JSON.stringify(recent, null, 2));
    console.log(`💾 Saved ${trades.length} validated trades`);
  } catch (error) {
    console.error('❌ Error saving validated trades:', error.message);
  }
}

// Main validation loop
async function run() {
  console.log('🛡️  Risk Manager Started');
  console.log(`📊 Max Position Size: ${riskConfig.positionSizing.maxPositionSizePercent}%`);
  console.log(`🎯 Max Total Exposure: ${riskConfig.positionSizing.maxTotalExposurePercent}%`);
  console.log(`🛑 Stop Loss: ${riskConfig.stopLoss.defaultPercent}%`);
  console.log(`💰 Take Profit: ${riskConfig.takeProfit.defaultPercent}%`);
  console.log('');
  
  // Check if trading is enabled
  if (!isTradingEnabled()) {
    console.log('⚠️  Trading DISABLED - Risk manager paused');
    console.log('🔄 Will retry in 1 minute...');
    setTimeout(run, 60 * 1000);
    return;
  }
  
  console.log('✅ Trading ENABLED - Processing signals');
  
  // Read signals
  if (!fs.existsSync(SIGNALS_FILE)) {
    console.log('⚠️  No signals file found');
    console.log('🔄 Next check in 1 minute...');
    setTimeout(run, 60 * 1000);
    return;
  }
  
  const signals = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));
  
  // Filter only new signals (last 10 minutes)
  const now = Date.now();
  const newSignals = signals.filter(s => (now - s.timestamp) < 10 * 60 * 1000);
  
  if (newSignals.length === 0) {
    console.log('✅ No new signals to process');
    console.log('🔄 Next check in 1 minute...');
    setTimeout(run, 60 * 1000);
    return;
  }
  
  console.log(`📋 Processing ${newSignals.length} new signals...`);
  
  const validatedTrades = [];
  
  for (const signal of newSignals) {
    const result = validateSignal(signal);
    
    if (result.valid) {
      validatedTrades.push(result.trade);
    }
  }
  
  if (validatedTrades.length > 0) {
    saveValidatedTrades(validatedTrades);
    console.log(`✅ Validated ${validatedTrades.length}/${newSignals.length} signals`);
  } else {
    console.log(`✅ No signals passed validation (0/${newSignals.length})`);
  }
  
  console.log('🔄 Next check in 1 minute...');
  setTimeout(run, 60 * 1000);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 Shutting down risk manager...');
  process.exit(0);
});

// Start
run().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
