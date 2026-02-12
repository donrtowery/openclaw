import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { testConnection, query } from '../db/connection.js';
import { testConnectivity } from '../lib/binance.js';
import { initScanner, runScanCycle } from '../lib/scanner.js';
import { getPortfolioSummary } from '../lib/position-manager.js';

async function test() {
  console.log('=== OpenClaw v2 — Engine Integration Test ===\n');

  const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));

  // 1. Database
  console.log('1. Database connection...');
  const dbOk = await testConnection();
  if (!dbOk) { console.error('FAIL: Database'); process.exit(1); }
  console.log('   OK\n');

  // 2. Binance
  console.log('2. Binance API...');
  const binanceOk = await testConnectivity();
  if (!binanceOk) { console.error('FAIL: Binance'); process.exit(1); }
  console.log('   OK\n');

  // 3. Scanner init
  console.log('3. Scanner initialization...');
  const symbols = await initScanner();
  console.log(`   ${symbols.length} active symbols\n`);

  // 4. First scan (baseline)
  console.log('4. First scan (establishing baseline)...');
  const scan1 = await runScanCycle(config);
  console.log(`   ${scan1.symbols_scanned} symbols in ${scan1.duration_ms}ms`);
  console.log(`   Triggered: ${scan1.triggered.length} (expected 0 on baseline)\n`);

  // 5. Second scan (check for crossings)
  console.log('5. Second scan (checking for threshold crossings)...');
  const scan2 = await runScanCycle(config);
  console.log(`   ${scan2.symbols_scanned} symbols in ${scan2.duration_ms}ms`);
  console.log(`   Triggered: ${scan2.triggered.length}`);
  if (scan2.triggered.length > 0) {
    for (const t of scan2.triggered) {
      console.log(`     ${t.symbol}: ${t.thresholds_crossed.join(', ')} (has_position=${t.has_position})`);
    }
  }
  console.log('');

  // 6. Portfolio summary
  console.log('6. Portfolio summary...');
  const portfolio = await getPortfolioSummary(config);
  console.log(`   Open positions: ${portfolio.open_count}/${portfolio.max_positions}`);
  console.log(`   Total invested: $${portfolio.total_invested.toFixed(2)}`);
  console.log(`   Available capital: $${portfolio.available_capital.toFixed(2)}`);
  console.log(`   Unrealized P&L: $${portfolio.unrealized_pnl.toFixed(2)} (${portfolio.unrealized_pnl_percent.toFixed(2)}%)`);
  console.log(`   Realized P&L: $${portfolio.realized_pnl.toFixed(2)}`);
  console.log(`   Win rate: ${portfolio.win_rate.toFixed(1)}% (${portfolio.total_trades} trades)\n`);

  // 7. Circuit breaker
  console.log('7. Circuit breaker...');
  const cbResult = await query('SELECT * FROM circuit_breaker ORDER BY id LIMIT 1');
  const cb = cbResult.rows[0];
  console.log(`   Active: ${cb.is_active}`);
  console.log(`   Consecutive losses: ${cb.consecutive_losses}\n`);

  // 8. Database stats
  console.log('8. Database stats...');
  const tables = ['symbols', 'positions', 'trades', 'signals', 'decisions', 'indicator_snapshots', 'trade_events'];
  for (const table of tables) {
    const r = await query(`SELECT COUNT(*) as c FROM ${table}`);
    console.log(`   ${table}: ${r.rows[0].c} rows`);
  }

  // Recent snapshots
  const recentSnaps = await query(
    "SELECT COUNT(*) as c FROM indicator_snapshots WHERE created_at > NOW() - INTERVAL '10 minutes'"
  );
  console.log(`   (snapshots in last 10min: ${recentSnaps.rows[0].c})\n`);

  // 9. Config verification
  console.log('9. Config verification...');
  console.log(`   Capital: $${config.account.total_capital}`);
  console.log(`   Max positions: ${config.account.max_concurrent_positions}`);
  console.log(`   Scan interval: ${config.scanner.interval_minutes}min`);
  console.log(`   Signal cooldown: ${config.scanner.signal_cooldown_minutes}min`);
  console.log(`   Circuit breaker: ${config.circuit_breaker.consecutive_losses_to_activate} losses / ${config.circuit_breaker.cooldown_hours}h\n`);

  console.log('=== All components operational ===');
  console.log('Ready to start engine: node services/trading-engine.js\n');
  process.exit(0);
}

test().catch(error => {
  console.error(`FAIL: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
