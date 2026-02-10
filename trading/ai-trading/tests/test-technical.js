import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

import { analyzeSymbol, analyzeAll, formatForClaude, formatAllForClaude } from '../lib/technical-analysis.js';
import { getCandles } from '../lib/binance.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) { console.log(`  PASS: ${testName}`); passed++; }
  else { console.log(`  FAIL: ${testName}`); failed++; }
}

// ── Test 1: Raw candle fetch ────────────────────────────────

async function testCandles() {
  console.log('\n== Test 1: Candle Fetch ==');
  const candles = await getCandles('BTCUSDT', '1h', 100);
  assert(candles.length > 50, `Got ${candles.length} 1h candles`);
  assert(candles[0].open > 0, `First candle open: $${candles[0].open}`);
  assert(candles[0].close > 0, `First candle close: $${candles[0].close}`);
  assert(candles[0].volume > 0, `First candle volume: ${candles[0].volume}`);

  const candles5m = await getCandles('BTCUSDT', '5m', 200);
  assert(candles5m.length > 100, `Got ${candles5m.length} 5m candles`);
}

// ── Test 2: Single symbol analysis ──────────────────────────

async function testSingleAnalysis() {
  console.log('\n== Test 2: Single Symbol Analysis (BTCUSDT) ==');
  const start = Date.now();
  const a = await analyzeSymbol('BTCUSDT');
  const elapsed = Date.now() - start;

  assert(!a.error, `No error: ${a.error || 'OK'}`);
  assert(a.price > 0, `Price: $${a.price}`);

  // RSI
  assert(a.rsi !== null, `RSI calculated`);
  if (a.rsi) {
    assert(a.rsi.value >= 0 && a.rsi.value <= 100, `RSI in range: ${a.rsi.value} (${a.rsi.signal})`);
  }

  // MACD
  assert(a.macd !== null, `MACD calculated`);
  if (a.macd) {
    assert(typeof a.macd.macd === 'number', `MACD line: ${a.macd.macd}`);
    assert(typeof a.macd.histogram === 'number', `MACD histogram: ${a.macd.histogram}`);
    assert(['BULLISH', 'BEARISH', 'BULLISH_TREND', 'BEARISH_TREND', 'NEUTRAL'].includes(a.macd.crossover),
      `MACD crossover: ${a.macd.crossover}`);
  }

  // SMAs
  assert(a.sma !== null, `SMA calculated`);
  if (a.sma) {
    assert(a.sma.sma10 > 0, `SMA10: $${a.sma.sma10}`);
    assert(a.sma.sma50 > 0, `SMA50: $${a.sma.sma50}`);
    if (a.sma.sma200) assert(a.sma.sma200 > 0, `SMA200: $${a.sma.sma200}`);
  }

  // EMA
  assert(a.ema !== null, `EMA calculated`);
  if (a.ema) {
    assert(a.ema.ema9 > 0, `EMA9: $${a.ema.ema9}`);
    assert(['BULLISH', 'BEARISH', 'NEUTRAL'].includes(a.ema.signal), `EMA signal: ${a.ema.signal}`);
  }

  // Bollinger Bands
  assert(a.bollingerBands !== null, `Bollinger Bands calculated`);
  if (a.bollingerBands) {
    assert(a.bollingerBands.upper > a.bollingerBands.lower, `BB upper > lower`);
    assert(['UPPER', 'MIDDLE', 'LOWER'].includes(a.bollingerBands.position), `BB position: ${a.bollingerBands.position}`);
  }

  // Volume
  assert(a.volume !== null, `Volume calculated`);
  if (a.volume) {
    assert(a.volume.avg24h > 0, `Avg 24h volume: ${a.volume.avg24h}`);
    assert(a.volume.ratio > 0, `Volume ratio: ${a.volume.ratio}x`);
  }

  // S/R
  assert(Array.isArray(a.support), `Support levels: ${JSON.stringify(a.support)}`);
  assert(Array.isArray(a.resistance), `Resistance levels: ${JSON.stringify(a.resistance)}`);

  // Trend
  assert(a.trend !== null, `Trend calculated`);
  if (a.trend) {
    assert(['BULLISH', 'BEARISH', 'SIDEWAYS'].includes(a.trend.direction), `Trend: ${a.trend.direction}`);
    assert(['STRONG', 'MODERATE', 'WEAK'].includes(a.trend.strength), `Strength: ${a.trend.strength}`);
  }

  console.log(`  Time: ${elapsed}ms`);
}

// ── Test 3: Parallel multi-symbol analysis ──────────────────

async function testParallelAnalysis() {
  console.log('\n== Test 3: Parallel Analysis (3 symbols) ==');
  const start = Date.now();
  const results = await analyzeAll(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const elapsed = Date.now() - start;

  assert(results.length === 3, `Got ${results.length} results`);
  for (const r of results) {
    assert(!r.error, `${r.symbol}: ${r.error || 'OK'} — $${r.price}`);
  }
  console.log(`  Time: ${elapsed}ms (${(elapsed / 3).toFixed(0)}ms avg/symbol)`);
}

// ── Test 4: Full 16-symbol analysis ─────────────────────────

async function testFullAnalysis() {
  console.log('\n== Test 4: Full 16-Symbol Analysis ==');
  const symbols = [
    'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT',
    'ADAUSDT','UNIUSDT','ATOMUSDT','OPUSDT','LINKUSDT','AAVEUSDT','DOTUSDT','MATICUSDT','AVAXUSDT',
    'ALGOUSDT','HBARUSDT','ARBUSDT',
  ];

  const start = Date.now();
  const results = await analyzeAll(symbols);
  const elapsed = Date.now() - start;

  const success = results.filter(r => !r.error).length;
  const errors = results.filter(r => r.error);
  assert(success >= 14, `${success}/16 symbols analyzed successfully`);
  if (errors.length) {
    for (const e of errors) console.log(`  WARN: ${e.symbol} failed: ${e.error}`);
  }
  console.log(`  Time: ${(elapsed / 1000).toFixed(1)}s (${(elapsed / symbols.length).toFixed(0)}ms avg)`);
}

// ── Test 5: Cache test ──────────────────────────────────────

async function testCache() {
  console.log('\n== Test 5: Cache Performance ==');
  const start1 = Date.now();
  await analyzeSymbol('BTCUSDT');
  const first = Date.now() - start1;

  const start2 = Date.now();
  await analyzeSymbol('BTCUSDT');
  const second = Date.now() - start2;

  assert(second < first, `Cached call faster: ${first}ms vs ${second}ms`);
}

// ── Test 6: Error handling ──────────────────────────────────

async function testErrorHandling() {
  console.log('\n== Test 6: Error Handling ==');
  const result = await analyzeSymbol('FAKECOINUSDT');
  assert(result.error !== undefined, `Invalid symbol returns error: ${result.error}`);
  assert(result.symbol === 'FAKECOINUSDT', `Symbol preserved in error result`);
}

// ── Test 7: Claude formatting ───────────────────────────────

async function testFormatting() {
  console.log('\n== Test 7: Claude Prompt Formatting ==');
  const a = await analyzeSymbol('BTCUSDT');
  const formatted = formatForClaude(a);
  assert(formatted.includes('BTCUSDT'), `Contains symbol`);
  assert(formatted.includes('RSI'), `Contains RSI`);
  assert(formatted.includes('MACD'), `Contains MACD`);
  console.log('\n  --- Formatted output ---');
  console.log(formatted.split('\n').map(l => '  ' + l).join('\n'));
  console.log('  -----------------------');
}

// ── Run all ─────────────────────────────────────────────────

async function main() {
  console.log('==========================================');
  console.log('  OpenClaw — Technical Analysis Tests');
  console.log('==========================================');

  await testCandles();
  await testSingleAnalysis();
  await testParallelAnalysis();
  await testFullAnalysis();
  await testCache();
  await testErrorHandling();
  await testFormatting();

  console.log('\n==========================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('==========================================');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
