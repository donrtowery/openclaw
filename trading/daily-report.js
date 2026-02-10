const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// Gmail SMTP config
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER || '',
    pass: process.env.BREVO_SMTP_PASS || ''
  }
});

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
  const signals = readJSON('signals.json') || {};

  // Calculate stats
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

  // Build HTML email
  const html = `
    <html>
      <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
        <div style="max-width: 600px; background: white; padding: 20px; border-radius: 8px; margin: 0 auto;">
          <h2 style="color: #333;">🤖 Daily Trading Report</h2>
          <p style="color: #666;">Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}</p>
          
          <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
          
          <h3 style="color: #333;">📊 Performance Summary</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Total Trades:</strong></td>
              <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;"><strong>${totalTrades}</strong></td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee;">Win Rate:</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${winRate}% (${profitableTrades}/${totalTrades})</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee;">Total P&L:</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; color: ${totalPnL >= 0 ? 'green' : 'red'}; font-weight: bold;">$${totalPnL.toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee;">Avg Win:</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; color: green;">$${avgWin}</td>
            </tr>
            <tr>
              <td style="padding: 8px;">Avg Loss:</td>
              <td style="padding: 8px; text-align: right; color: red;">$${avgLoss}</td>
            </tr>
          </table>

          <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">

          <h3 style="color: #333;">📈 Open Positions (${positions.length})</h3>
          ${positions.length > 0 
            ? `<table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                <tr style="background: #f9f9f9;">
                  <td style="padding: 8px; border: 1px solid #eee;"><strong>Symbol</strong></td>
                  <td style="padding: 8px; border: 1px solid #eee;"><strong>Side</strong></td>
                  <td style="padding: 8px; border: 1px solid #eee;"><strong>Entry</strong></td>
                  <td style="padding: 8px; border: 1px solid #eee;"><strong>Current</strong></td>
                  <td style="padding: 8px; border: 1px solid #eee;"><strong>P&L</strong></td>
                </tr>
                ${positions.map(p => `
                  <tr>
                    <td style="padding: 8px; border: 1px solid #eee;">${p.symbol}</td>
                    <td style="padding: 8px; border: 1px solid #eee;">${p.side}</td>
                    <td style="padding: 8px; border: 1px solid #eee;">$${(p.entryPrice || 0).toFixed(2)}</td>
                    <td style="padding: 8px; border: 1px solid #eee;">$${(p.currentPrice || p.entryPrice || 0).toFixed(2)}</td>
                    <td style="padding: 8px; border: 1px solid #eee; color: ${(p.unrealizedPnL || 0) >= 0 ? 'green' : 'red'};">$${(p.unrealizedPnL || 0).toFixed(2)}</td>
                  </tr>
                `).join('')}
              </table>`
            : `<p style="color: #666;">No open positions</p>`
          }

          <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">

          <h3 style="color: #333;">⚠️ Alerts</h3>
          ${positions.length === 0 && totalTrades === 0 
            ? `<p style="color: #666;">System operational. Waiting for trade signals...</p>`
            : `<p style="color: #666;">System operational. ✅</p>`
          }

          <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">

          <p style="color: #999; font-size: 12px;">Trading Bot Status: <strong>Paper Trading (Simulation)</strong></p>
        </div>
      </body>
    </html>
  `;

  return html;
}

async function sendReport() {
  const html = generateReport();
  
  try {
    await transporter.sendMail({
      from: 'a1cb1a001@smtp-brevo.com',
      to: 'donrtowery@gmail.com',
      subject: `📊 Trading Report - ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`,
      html: html
    });
    console.log('✅ Report sent successfully');
} catch (err) {
    console.error('❌ Error sending report:', err.message);
  }
}

sendReport();
