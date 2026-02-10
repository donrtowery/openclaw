const fs = require('fs');
const path = require('path');

// Load configuration
const riskConfig = require('../config/risk.json');
const strategyConfig = require('../config/strategy.json');

const DATA_DIR = path.join(__dirname, '../data');
const VALIDATED_TRADES_FILE = path.join(DATA_DIR, 'validated_trades.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const TRADE_HISTORY_FILE = path.join(DATA_DIR, 'trade_history.json');
const CANDLES_DIR = path.join(DATA_DIR, 'candles');
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

// Save positions
function savePositions(positions) {
  try {
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
  } catch (error) {
    console.error('❌ Error saving positions:', error.message);
  }
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

// Save trade history
function saveTradeHistory(history) {
  try {
    fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error('❌ Error saving trade history:', error.message);
  }
}

// Get current price for a symbol
function getCurrentPrice(symbol) {
  try {
    const candleFile = path.join(CANDLES_DIR, `${symbol}_5m.json`);
    if (!fs.existsSync(candleFile)) {
      return null;
    }
    const candles = JSON.parse(fs.readFileSync(candleFile, 'utf8'));
    return candles[candles.length - 1].close;
  } catch (error) {
    console.error(`❌ Error getting price for ${symbol}:`, error.message);
    return null;
  }
}

// Execute a BUY order (paper trading)
function executeBuy(trade) {
  console.log(`\n💵 EXECUTING BUY ORDER (PAPER)`);
  console.log(`   Symbol: ${trade.symbol}`);
  console.log(`   Quantity: ${trade.quantity.toFixed(6)}`);
  console.log(`   Price: $${trade.price.toFixed(2)}`);
  console.log(`   Order Value: $${trade.orderValue.toFixed(2)}`);
  console.log(`   Stop Loss: $${trade.stopLoss.toFixed(2)}`);
  console.log(`   Take Profit: $${trade.takeProfit.toFixed(2)}`);
  
  const positions = getPositions();
  
  // Add new position
  const newPosition = {
    symbol: trade.symbol,
    quantity: trade.quantity,
    entryPrice: trade.price,
    currentPrice: trade.price,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    orderValue: trade.orderValue,
    unrealizedPnL: 0,
    unrealizedPnLPercent: 0,
    entryTime: Date.now(),
    strategy: trade.strategy
  };
  
  positions.push(newPosition);
  savePositions(positions);
  
  // Record in trade history
  const history = getTradeHistory();
  history.push({
    type: 'BUY',
    symbol: trade.symbol,
    quantity: trade.quantity,
    price: trade.price,
    orderValue: trade.orderValue,
    timestamp: Date.now(),
    mode: 'paper'
  });
  saveTradeHistory(history);
  
  console.log(`✅ Position opened successfully (PAPER)`);
  return true;
}

// Execute a SELL order (paper trading)
function executeSell(trade) {
  console.log(`\n💵 EXECUTING SELL ORDER (PAPER)`);
  console.log(`   Symbol: ${trade.symbol}`);
  
  const positions = getPositions();
  const positionIndex = positions.findIndex(p => p.symbol === trade.symbol);
  
  if (positionIndex === -1) {
    console.log(`❌ No position found for ${trade.symbol}`);
    return false;
  }
  
  const position = positions[positionIndex];
  const exitPrice = trade.price;
  const pnl = (exitPrice - position.entryPrice) * position.quantity;
  const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
  
  console.log(`   Entry Price: $${position.entryPrice.toFixed(2)}`);
  console.log(`   Exit Price: $${exitPrice.toFixed(2)}`);
  console.log(`   P&L: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
  
  // Remove position
  positions.splice(positionIndex, 1);
  savePositions(positions);
  
  // Record in trade history
  const history = getTradeHistory();
  history.push({
    type: 'SELL',
    symbol: trade.symbol,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    exitPrice: exitPrice,
    pnl: pnl,
    pnlPercent: pnlPercent,
    holdTime: Date.now() - position.entryTime,
    timestamp: Date.now(),
    mode: 'paper'
  });
  saveTradeHistory(history);
  
  console.log(`✅ Position closed successfully (PAPER)`);
  return true;
}

// Check stop loss and take profit for existing positions
function checkPositions() {
  const positions = getPositions();
  
  if (positions.length === 0) {
    return;
  }
  
  console.log(`\n📊 Checking ${positions.length} open position(s)...`);
  
  let modified = false;
  
  for (let i = positions.length - 1; i >= 0; i--) {
    const position = positions[i];
    const currentPrice = getCurrentPrice(position.symbol);
    
    if (!currentPrice) {
      console.log(`⚠️  Could not get price for ${position.symbol}`);
      continue;
    }
    
    // Update current price and unrealized P&L
    position.currentPrice = currentPrice;
    position.unrealizedPnL = (currentPrice - position.entryPrice) * position.quantity;
    position.unrealizedPnLPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    
    console.log(`   ${position.symbol}: $${currentPrice.toFixed(2)} | P&L: $${position.unrealizedPnL.toFixed(2)} (${position.unrealizedPnLPercent.toFixed(2)}%)`);
    
    // Check stop loss
    if (currentPrice <= position.stopLoss) {
      console.log(`🛑 STOP LOSS HIT for ${position.symbol}!`);
      executeSell({ symbol: position.symbol, price: currentPrice });
      modified = true;
      continue;
    }
    
    // Check take profit
    if (currentPrice >= position.takeProfit) {
      console.log(`🎯 TAKE PROFIT HIT for ${position.symbol}!`);
      executeSell({ symbol: position.symbol, price: currentPrice });
      modified = true;
      continue;
    }
  }
  
  if (!modified && positions.length > 0) {
    savePositions(positions); // Save updated prices
  }
}

// Process pending validated trades
function processPendingTrades() {
  if (!fs.existsSync(VALIDATED_TRADES_FILE)) {
    return;
  }
  
  const validatedTrades = JSON.parse(fs.readFileSync(VALIDATED_TRADES_FILE, 'utf8'));
  
  // Filter only pending trades (last 5 minutes)
  const now = Date.now();
  const pendingTrades = validatedTrades.filter(t => 
    t.status === 'pending' && (now - t.timestamp) < 5 * 60 * 1000
  );
  
  if (pendingTrades.length === 0) {
    return;
  }
  
  console.log(`\n📋 Processing ${pendingTrades.length} pending trade(s)...`);
  
  for (const trade of pendingTrades) {
    if (trade.signal === 'BUY') {
      executeBuy(trade);
    } else if (trade.signal === 'SELL') {
      executeSell(trade);
    }
    
    // Mark as executed
    trade.status = 'executed';
  }
  
  // Save updated validated trades
  fs.writeFileSync(VALIDATED_TRADES_FILE, JSON.stringify(validatedTrades, null, 2));
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

// Print portfolio summary
function printSummary() {
  const positions = getPositions();
  const history = getTradeHistory();
  
  const startingBalance = riskConfig.paperTrading.startingBalanceUSD;
  const totalPnL = history.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  const currentBalance = startingBalance + totalPnL;
  
  console.log(`\n💼 PORTFOLIO SUMMARY (PAPER)`);
  console.log(`   Starting Balance: $${startingBalance.toFixed(2)}`);
  console.log(`   Realized P&L: $${totalPnL.toFixed(2)}`);
  console.log(`   Current Balance: $${currentBalance.toFixed(2)}`);
  console.log(`   Open Positions: ${positions.length}`);
  console.log(`   Total Trades: ${history.filter(h => h.type === 'SELL').length}`);
}

// Main execution loop
async function run() {
  console.log('🚀 Execution Engine Started (PAPER TRADING MODE)');
  console.log(`💵 Starting Balance: $${riskConfig.paperTrading.startingBalanceUSD.toFixed(2)}`);
  console.log('');
  
  if (!isTradingEnabled()) {
    console.log('⚠️  Trading DISABLED - Execution paused');
    console.log('🔄 Will retry in 1 minute...');
    setTimeout(run, 60 * 1000);
    return;
  }
  
  console.log('✅ Trading ENABLED');
  
  // Check existing positions first
  checkPositions();
  
  // Process pending trades
  processPendingTrades();
  
  // Print summary
  printSummary();
  
  console.log('\n🔄 Next check in 1 minute...');
  setTimeout(run, 60 * 1000);
}

process.on('SIGTERM', () => {
  console.log('📴 Shutting down execution engine...');
  process.exit(0);
});

run().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
