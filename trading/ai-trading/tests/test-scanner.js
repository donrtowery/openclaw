import dotenv from 'dotenv';
dotenv.config();

import { testConnectivity, getCandles, getCurrentPrice } from '../lib/binance.js';
import { testConnection, query } from '../db/connection.js';
import { analyzeSymbol } from '../lib/technical-analysis.js';
import { initScanner, runScanCycle } from '../lib/scanner.js';
import { readFileSync } from 'fs';

async function test() {
  console.log('=== OpenClaw v2 Scanner Test ===\n');

  // Load config
  const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));

  // 1. Database
  console.log('1. Database connection...');
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('FAIL: Database connection failed');
    process.exit(1);
  }

  // 2. Binance
  console.log('\n2. Binance API connectivity...');
  const binanceOk = await testConnectivity();
  if (!binanceOk) {
    console.error('FAIL: Binance connection failed');
    process.exit(1);
  }

  // 3. Candle fetch
  console.log('\n3. Fetching candles (ETHUSDT 5m)...');
  const candles = await getCandles('ETHUSDT', '5m', 10);
  console.log(`   Got ${candles.length} candles`);
  console.log(`   Latest: open=${candles[candles.length - 1].open} close=${candles[candles.length - 1].close} vol=${candles[candles.length - 1].volume.toFixed(2)}`);

  // 4. Current price
  console.log('\n4. Current price...');
  const ethPrice = await getCurrentPrice('ETHUSDT');
  console.log(`   ETHUSDT: $${ethPrice}`);

  // 5. Technical analysis (single symbol, uses proven v1 code)
  console.log('\n5. Full technical analysis (ETHUSDT)...');
  const analysis = await analyzeSymbol('ETHUSDT');
  if (analysis.error) {
    console.error(`   FAIL: ${analysis.error}`);
  } else {
    console.log(`   Price: $${analysis.price}`);
    console.log(`   RSI: ${analysis.rsi?.value} (${analysis.rsi?.signal})`);
    console.log(`   MACD: histogram=${analysis.macd?.histogram} (${analysis.macd?.crossover})`);
    console.log(`   EMAs: ema9=${analysis.ema?.ema9} ema21=${analysis.ema?.ema21} (${analysis.ema?.signal})`);
    console.log(`   Trend: ${analysis.trend?.direction} (${analysis.trend?.strength})`);
    console.log(`   Volume: ${analysis.volume?.ratio}x (${analysis.volume?.trend})`);
    console.log(`   BB: position=${analysis.bollingerBands?.position} width=${analysis.bollingerBands?.width}`);
    console.log(`   Support: ${analysis.support?.join(', ') || 'none'}`);
    console.log(`   Resistance: ${analysis.resistance?.join(', ') || 'none'}`);
  }

  // 6. Scanner init
  console.log('\n6. Scanner initialization...');
  const symbols = await initScanner();
  console.log(`   ${symbols.length} active symbols loaded`);

  // 7. First scan (baseline — no crossings expected)
  console.log('\n7. Running first scan cycle (establishing baseline)...');
  const scan1 = await runScanCycle(config);
  console.log(`   Scanned: ${scan1.symbols_scanned} symbols`);
  console.log(`   Duration: ${scan1.duration_ms}ms`);
  console.log(`   Triggered: ${scan1.triggered.length} (expected 0 on first run)`);

  // 8. Check database snapshots
  console.log('\n8. Database snapshots...');
  const countResult = await query('SELECT COUNT(*) as count FROM indicator_snapshots');
  console.log(`   Snapshots saved: ${countResult.rows[0].count}`);

  // Show a sample
  if (scan1.snapshots.length > 0) {
    const sample = scan1.snapshots[0];
    console.log(`   Sample: ${sample.symbol} $${sample.price} RSI=${sample.rsi?.value} trend=${sample.trend?.direction}`);
  }

  // 9. Second scan (may detect crossings if data shifted)
  console.log('\n9. Running second scan immediately (testing crossing detection)...');
  const scan2 = await runScanCycle(config);
  console.log(`   Scanned: ${scan2.symbols_scanned} symbols`);
  console.log(`   Duration: ${scan2.duration_ms}ms`);
  console.log(`   Triggered: ${scan2.triggered.length}`);

  if (scan2.triggered.length > 0) {
    console.log('   Signals:');
    for (const sig of scan2.triggered) {
      console.log(`     ${sig.symbol}: ${sig.thresholds_crossed.join(', ')} (has_position=${sig.has_position})`);
    }
  }

  // 10. Final snapshot count
  const finalCount = await query('SELECT COUNT(*) as count FROM indicator_snapshots');
  console.log(`\n10. Total snapshots in DB: ${finalCount.rows[0].count}`);

  console.log('\n=== All tests passed ===');
  process.exit(0);
}

test().catch(error => {
  console.error(`\nFAIL: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
