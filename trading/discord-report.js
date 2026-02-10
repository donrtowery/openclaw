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

  const totalTrades = tradeHistory.length;
  const profitableTrades = tradeHistory.filter(t => t.pnl && t.pnl > 0).length;
  const totalPnL = tradeHistory.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const winRate = totalTrades > 0 ? ((profitableTrades / totalTrades) * 100).toFixed(2) : 0;
  const avgWin = profitableTrades > 0 
    ? (tradeHistory.filter(t => t.pnl && t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / profitableTrades).toFixed(2)
    : 0;
  const avgLoss = (totalTrades - profitableTrades) > 0
    ? (tradeHistory.filter(t => t.pnl && t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0) / (totalTrades - profitableTrades)).toFixed(2)
    : 0;

  return {
    totalTrades,
    profitableTrades,
    totalPnL,
    winRate,
    avgWin,
    avgLoss,
    positions
  };
}

async function sendDiscordReport() {
  try {
    const report = generateReport();
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    const embed = {
      title: '📊 Daily Trading Report',
      description: `Generated: ${now}`,
      color: 3447003,
      fields: [
        {
          name: 'Total Trades',
          value: `${report.totalTrades}`,
          inline: true
        },
        {
          name: 'Win Rate',
          value: `${report.winRate}% (${report.profitableTrades}/${report.totalTrades})`,
          inline: true
        },
        {
          name: 'Total P&L',
          value: `$${report.totalPnL.toFixed(2)}`,
          inline: true
        },
        {
          name: 'Avg Win',
          value: `$${report.avgWin}`,
          inline: true
        },
        {
          name: 'Avg Loss',
          value: `$${report.avgLoss}`,
          inline: true
        },
        {
          name: 'Open Positions',
          value: `${report.positions.length}`,
          inline: true
        }
      ],
      footer: {
        text: 'Claw Trading Bot | Paper Trading'
      }
    };

    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [embed]
    });

    console.log('✅ Discord report sent');
  } catch (err) {
    console.error('❌ Error sending Discord report:', err.message);
    process.exit(1);
  }
}

sendDiscordReport();
