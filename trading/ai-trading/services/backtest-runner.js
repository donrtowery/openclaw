import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { Backtester } from '../lib/backtester.js';
import { endPool } from '../db/connection.js';
import logger from '../lib/logger.js';

const tradingConfig = JSON.parse(readFileSync('config/trading.json', 'utf8'));

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    startDate: null,
    endDate: null,
    symbols: null,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start':
        opts.startDate = args[++i];
        break;
      case '--end':
        opts.endDate = args[++i];
        break;
      case '--symbols':
        opts.symbols = args[++i].split(',').map(s => s.trim().toUpperCase());
        break;
      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: node services/backtest-runner.js [options]

Options:
  --start DATE     Start date (YYYY-MM-DD), default: 30 days ago
  --end DATE       End date (YYYY-MM-DD), default: today
  --symbols LIST   Comma-separated symbol list (e.g., BTCUSDT,ETHUSDT)
  --verbose, -v    Log individual trades
  --help, -h       Show this help
`);
        process.exit(0);
    }
  }

  // Defaults
  if (!opts.startDate) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    opts.startDate = d.toISOString().split('T')[0];
  }
  if (!opts.endDate) {
    opts.endDate = new Date().toISOString().split('T')[0];
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  console.log(`\n=== OpenClaw v2 Backtest ===`);
  console.log(`Period: ${opts.startDate} to ${opts.endDate}`);
  console.log(`Symbols: ${opts.symbols ? opts.symbols.join(', ') : 'all active'}`);
  console.log(`Capital: $${tradingConfig.account.total_capital}`);
  console.log('');

  const backtester = new Backtester(tradingConfig, {
    startDate: opts.startDate,
    endDate: opts.endDate,
    symbols: opts.symbols,
    verbose: opts.verbose,
  });

  const report = await backtester.run();

  // Print results
  console.log(`\n=== Results ===`);
  console.log(`Duration: ${(report.duration_ms / 1000).toFixed(1)}s`);
  console.log(`Signals detected: ${report.signals_generated}`);
  console.log(`Signals escalated: ${report.signals_escalated}`);
  console.log(`Total trades: ${report.total_trades}`);
  console.log(`Win rate: ${report.win_rate.toFixed(1)}%`);
  console.log(`Total P&L: $${report.total_pnl.toFixed(2)}`);
  console.log(`Avg win: $${report.avg_win.toFixed(2)}`);
  console.log(`Avg loss: $${report.avg_loss.toFixed(2)}`);
  console.log(`Max drawdown: ${report.max_drawdown_percent.toFixed(2)}%`);
  console.log(`Sharpe ratio: ${report.sharpe_ratio.toFixed(2)}`);
  console.log(`Final capital: $${report.final_capital.toFixed(2)}`);

  if (report.trades.length > 0) {
    console.log(`\n=== Trade Log ===`);
    for (const t of report.trades) {
      const arrow = t.pnl >= 0 ? '+' : '';
      console.log(`  ${t.symbol}: ${t.entry_time.slice(0,16)} → ${t.exit_time.slice(0,16)} | $${t.entry_price.toFixed(2)} → $${t.exit_price.toFixed(2)} | ${arrow}$${t.pnl.toFixed(2)} (${arrow}${t.pnl_percent.toFixed(1)}%) | ${t.hold_hours.toFixed(1)}h | ${t.exit_reason.substring(0, 60)}`);
    }
  }

  console.log(`\nResults saved to backtest_runs table.`);

  await endPool();
}

main().catch(err => {
  console.error(`Backtest failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
