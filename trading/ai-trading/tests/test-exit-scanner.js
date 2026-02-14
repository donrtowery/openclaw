import dotenv from 'dotenv';
dotenv.config();

import { computeExitUrgency, isInExitCooldown, recordExitCooldown } from '../lib/exit-scanner.js';

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── Unit Tests ──────────────────────────────────────────────

function testAXSUSDTScenario() {
  console.log('\n── AXSUSDT Scenario (RSI 88, +13%, held 23h, BB upper, drawdown from peak) ──');

  const position = {
    avg_entry_price: '1.36',
    entry_time: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
    max_unrealized_gain_percent: '25',
    current_size: '400',
    total_cost: '544',
  };
  const analysis = {
    price: 1.54,
    rsi: { value: 88.57, signal: 'OVERBOUGHT' },
    macd: { crossover: 'BULLISH_TREND', histogram: 0.028 },
    bollingerBands: { position: 'UPPER', upper: 1.56, middle: 1.45, lower: 1.34 },
    trend: { direction: 'BULLISH', strength: 'MODERATE' },
    volume: { ratio: 0.5, trend: 'DECREASING' },
  };

  const urgency = computeExitUrgency(position, analysis, 1.54);

  assert('Score >= 70 (critical)', urgency.score >= 70, `Got ${urgency.score}`);
  assert('RSI factor detected', urgency.factors.some(f => f.includes('RSI')));
  assert('P&L factor detected', urgency.factors.some(f => f.includes('P&L')));
  assert('Hold time factor detected', urgency.factors.some(f => f.includes('Held')));
  assert('BB upper factor detected', urgency.factors.some(f => f.includes('BB upper')));
  assert('Drawdown factor detected', urgency.factors.some(f => f.includes('Drawdown')));
  assert('P&L ~13%', Math.abs(urgency.pnl_percent - 13.24) < 1, `Got ${urgency.pnl_percent.toFixed(2)}%`);
  console.log(`  INFO  Score: ${urgency.score} | Factors: ${urgency.factors.join(', ')}`);
}

function testHealthyPosition() {
  console.log('\n── Healthy Position (low urgency) ──');

  const position = {
    avg_entry_price: '100',
    entry_time: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    max_unrealized_gain_percent: '3',
  };
  const analysis = {
    price: 103,
    rsi: { value: 55, signal: 'NEUTRAL' },
    macd: { crossover: 'BULLISH_TREND', histogram: 0.5 },
    bollingerBands: { position: 'MIDDLE' },
    trend: { direction: 'BULLISH', strength: 'MODERATE' },
  };

  const urgency = computeExitUrgency(position, analysis, 103);

  assert('Score < 40 (below threshold)', urgency.score < 40, `Got ${urgency.score}`);
  assert('Few or no factors', urgency.factors.length <= 1, `Got ${urgency.factors.length} factors`);
  console.log(`  INFO  Score: ${urgency.score} | Factors: ${urgency.factors.join(', ') || 'none'}`);
}

function testDeepLoss() {
  console.log('\n── Deep Loss Scenario ──');

  const position = {
    avg_entry_price: '100',
    entry_time: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString(),
    max_unrealized_gain_percent: '2',
  };
  const analysis = {
    price: 88,
    rsi: { value: 38, signal: 'NEUTRAL' },
    macd: { crossover: 'BEARISH', histogram: -0.5 },
    bollingerBands: { position: 'LOWER' },
    trend: { direction: 'BEARISH', strength: 'STRONG' },
  };

  const urgency = computeExitUrgency(position, analysis, 88);

  assert('Score >= 40 (above threshold)', urgency.score >= 40, `Got ${urgency.score}`);
  assert('Deep loss detected', urgency.factors.some(f => f.includes('deep loss')));
  assert('MACD bearish detected', urgency.factors.some(f => f.includes('MACD')));
  assert('Trend bearish detected', urgency.factors.some(f => f.includes('BEARISH')));
  assert('Hold > 24h detected', urgency.factors.some(f => f.includes('Held')));
  console.log(`  INFO  Score: ${urgency.score} | Factors: ${urgency.factors.join(', ')}`);
}

function testOverboughtWithSmallProfit() {
  console.log('\n── Overbought RSI + Small Profit ──');

  const position = {
    avg_entry_price: '50',
    entry_time: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    max_unrealized_gain_percent: '8',
  };
  const analysis = {
    price: 53,
    rsi: { value: 82, signal: 'OVERBOUGHT' },
    macd: { crossover: 'BULLISH', histogram: 0.1 },
    bollingerBands: { position: 'UPPER' },
    trend: { direction: 'BULLISH', strength: 'MODERATE' },
  };

  const urgency = computeExitUrgency(position, analysis, 53);

  // RSI 82 = +15, PnL 6% = +10, BB upper = +10, drawdown ~2% from 8% peak but < 3 = 0
  assert('Score >= 35 (near threshold)', urgency.score >= 35, `Got ${urgency.score}`);
  assert('RSI factor detected', urgency.factors.some(f => f.includes('RSI')));
  console.log(`  INFO  Score: ${urgency.score} | Factors: ${urgency.factors.join(', ')}`);
}

function testCooldownLogic() {
  console.log('\n── Cooldown Logic ──');

  assert('Not in cooldown before recording', isInExitCooldown('TESTUSDT', 30) === false);

  recordExitCooldown('TESTUSDT');

  assert('In cooldown after recording', isInExitCooldown('TESTUSDT', 30) === true);
  assert('Different symbol not in cooldown', isInExitCooldown('OTHERUSDT', 30) === false);
  assert('Zero cooldown bypasses', isInExitCooldown('TESTUSDT', 0) === false);
}

function testDrawdownFromPeak() {
  console.log('\n── Drawdown from Peak ──');

  const position = {
    avg_entry_price: '10',
    entry_time: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    max_unrealized_gain_percent: '20',
  };
  const analysis = {
    price: 10.5,
    rsi: { value: 50, signal: 'NEUTRAL' },
    macd: { crossover: 'BEARISH_TREND', histogram: -0.01 },
    bollingerBands: { position: 'MIDDLE' },
    trend: { direction: 'SIDEWAYS', strength: 'WEAK' },
  };

  const urgency = computeExitUrgency(position, analysis, 10.5);

  // P&L = 5%, drawdown from peak = 20% - 5% = 15%, hold 30h
  assert('Drawdown from peak > 10% detected', urgency.factors.some(f => f.includes('Drawdown')));
  assert('Drawdown factor is high scoring', urgency.score >= 40, `Got ${urgency.score}`);
  assert('Drawdown value ~15%', Math.abs(urgency.drawdown_from_peak - 15) < 1, `Got ${urgency.drawdown_from_peak.toFixed(1)}%`);
  console.log(`  INFO  Score: ${urgency.score} | Drawdown: ${urgency.drawdown_from_peak.toFixed(1)}%`);
}

// ── Integration Test via API ────────────────────────────────

async function testDashboardEndpoint() {
  console.log('\n── Dashboard API: get_exit_scanner_status ──');

  const BASE_URL = `http://127.0.0.1:${process.env.DASHBOARD_API_PORT || 3000}`;
  const API_KEY = process.env.DASHBOARD_API_KEY;

  try {
    const res = await fetch(`${BASE_URL}/api/dashboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ action: 'get_exit_scanner_status' }),
    });
    const body = await res.json();

    assert('Endpoint returns 200', res.status === 200);
    assert('Response has data', !!body.data);
    assert('Response has config', !!body.data.config);
    assert('Config has enabled flag', body.data.config.enabled !== undefined);
    assert('Response has recent_evaluations', Array.isArray(body.data.recent_evaluations));
    console.log(`  INFO  Config: ${JSON.stringify(body.data.config)}`);
    console.log(`  INFO  Recent evaluations: ${body.data.recent_evaluations.length}`);
  } catch (error) {
    console.log(`  SKIP  Dashboard API not running: ${error.message}`);
  }
}

// ── Runner ─────────────────────────────────────────────────

async function run() {
  console.log('=== Exit Scanner Test Suite ===');

  // Unit tests (no I/O)
  testAXSUSDTScenario();
  testHealthyPosition();
  testDeepLoss();
  testOverboughtWithSmallProfit();
  testDrawdownFromPeak();
  testCooldownLogic();

  // Integration test (needs running API)
  await testDashboardEndpoint();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
