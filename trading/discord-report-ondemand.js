const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1469647097845256225/kG6bdmHMhyC0Nb2vovSxSCKy0eCt4g-SiCNthZ-lYaNbLRZvebHE_6sL340Q1qiVN-eg';
const dataDir = path.join(process.env.HOME, '.openclaw/data');

function readJSON(filename) {
  try {
    const filePath = path.join(dataDir, filename);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.error(`Error reading ${filename}:`, err.message);
  }
  return null;
}

function generateReport() {
  const tradeHistory = readJSON('trade_history.json') || [];
  const positions = readJSON('positions.json') || [];
  const signals = readJSON('signals.json') || [];
  
  // Get recent signals (last 24 hours)
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const recentSignals = signals.filter(s => s.timestamp > oneDayAgo);
  
  // Calculate metrics
  const totalTrades = tradeHistory.filter(t => t.type === 'SELL').length;
  const profitableTrades = tradeHistory.filter(t => t.pnl && t.pnl > 0).length;
  const totalPnL = tradeHistory.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const winRate = totalTrades > 0 ? ((profitableTrades / totalTrades) * 100).toFixed(2) : 0;
  
  const avgWin = profitableTrades > 0
    ? (tradeHistory.filter(t => t.pnl && t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / profitableTrades).toFixed(2)
    : 0;
  
  const avgLoss = (totalTrades - profitableTrades) > 0
    ? (tradeHistory.filter(t => t.pnl && t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0) / (totalTrades - profitableTrades)).toFixed(2)
    : 0;
  
  // Get last 24h trades
  const recentTrades = tradeHistory.filter(t => t.timestamp > oneDayAgo && t.type === 'SELL');
  const last24hPnL = recentTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  
  // Current balance
  const startingBalance = 10000;
  const currentBalance = startingBalance + totalPnL;
  
  return {
    totalTrades,
    profitableTrades,
    totalPnL,
    winRate,
    avgWin,
    avgLoss,
    positions,
    recentSignals,
    recentTrades,
    last24hPnL,
    currentBalance,
    startingBalance
  };
}

async function sendDiscordReport(customMessage = null) {
  try {
    const report = generateReport();
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    
    // Build position details
    let positionDetails = 'None';
    if (report.positions.length > 0) {
      positionDetails = report.positions.map(p => 
        `${p.symbol}: ${p.quantity.toFixed(4)} @ $${p.entryPrice.toFixed(2)} | P&L: $${(p.unrealizedPnL || 0).toFixed(2)} (${(p.unrealizedPnLPercent || 0).toFixed(2)}%)`
      ).join('\n');
    }
    
    // Build recent activity
    let recentActivity = 'No activity';
    if (report.recentTrades.length > 0) {
      recentActivity = `${report.recentTrades.length} trades | P&L: $${report.last24hPnL.toFixed(2)}`;
    }
    
    const embed = {
      title: customMessage || '📊 Daily Trading Report',
      description: `Generated: ${now}`,
      color: report.totalPnL >= 0 ? 3066993 : 15158332, // Green if profit, red if loss
      fields: [
        {
          name: '💼 Portfolio',
          value: `Balance: $${report.currentBalance.toFixed(2)}\nTotal P&L: $${report.totalPnL.toFixed(2)} (${((report.totalPnL / report.startingBalance) * 100).toFixed(2)}%)`,
          inline: false
        },
        {
          name: '📈 Performance',
          value: `Total Trades: ${report.totalTrades}\nWin Rate: ${report.winRate}% (${report.profitableTrades}/${report.totalTrades})\nAvg Win: $${report.avgWin} | Avg Loss: $${report.avgLoss}`,
          inline: false
        },
        {
          name: '📊 Open Positions',
          value: positionDetails,
          inline: false
        },
        {
          name: '🕐 Last 24 Hours',
          value: recentActivity,
          inline: false
        }
      ],
      footer: {
        text: 'OpenClaw Trading Bot | Paper Trading | BTC/ETH/SOL'
      }
    };
    
    // Add alert if circuit breaker might trigger
    const losingStreak = report.recentTrades.slice(-3).every(t => t.pnl < 0);
    if (losingStreak && report.recentTrades.length >= 3) {
      embed.fields.push({
        name: '⚠️ Alert',
        value: '3 consecutive losses - circuit breaker may trigger soon!',
        inline: false
      });
    }
    
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [embed]
    });
    
    console.log('✅ Discord report sent');
  } catch (err) {
    console.error('❌ Error sending Discord report:', err.message);
    process.exit(1);
  }
}

// Check for custom message from command line
const customMessage = process.argv[2];
sendDiscordReport(customMessage);
