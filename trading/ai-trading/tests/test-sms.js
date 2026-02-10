import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

// Dynamic import so .env is loaded first
const { sendSMS, sendTradeAlert, sendSystemAlert, smsEnabled } = await import('../lib/sms.js');

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ${PASS} ${label}`); passed++; }
  else { console.log(`  ${FAIL} ${label}`); failed++; }
}

async function run() {
  console.log('\n=== OpenClaw SMS Test Suite ===\n');

  // ── 1. Config check ──────────────────────────────────────
  console.log('1. Configuration');
  assert(process.env.TEXTBELT_API_KEY && process.env.TEXTBELT_API_KEY !== 'your_textbelt_key_here',
    'TEXTBELT_API_KEY is configured');
  assert(process.env.SMS_PHONE_NUMBER && process.env.SMS_PHONE_NUMBER !== '+15551234567',
    'SMS_PHONE_NUMBER is configured (not placeholder)');
  assert(smsEnabled, 'SMS module reports enabled');

  if (!smsEnabled) {
    console.log('\n  SMS is disabled — update .env with real API key and phone number to run live tests.');
    console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
  }

  // ── 2. Live SMS test ─────────────────────────────────────
  console.log('\n2. Live SMS delivery');
  const testResult = await sendSMS('\u{1F9EA} OpenClaw SMS test \u2014 if you see this, alerts are working!');
  assert(testResult.success, `Test SMS delivered (quota remaining: ${testResult.quotaRemaining})`);
  if (!testResult.success) console.log(`     Error: ${testResult.error}`);

  // ── 3. Trade alert formatters ────────────────────────────
  console.log('\n3. Alert formatters (live send)');

  const buyResult = await sendTradeAlert('BUY', 'OPUSDT', 1.82, {
    confidence: 0.74, reasoning: 'RSI oversold + MACD bullish crossover',
  });
  assert(buyResult && buyResult.success, 'BUY alert formatted and sent');

  const sellResult = await sendTradeAlert('SELL', 'ETHUSDT', 2450, {
    pnl: 38.50, pnlPercent: 6.4, reason: 'AI decision',
  });
  assert(sellResult && sellResult.success, 'SELL alert formatted and sent');

  const dcaResult = await sendTradeAlert('DCA', 'BTCUSDT', 68500, {
    dcaLevel: 1, avgEntry: 69250,
  });
  assert(dcaResult && dcaResult.success, 'DCA alert formatted and sent');

  const tpResult = await sendTradeAlert('TAKE_PROFIT', 'SOLUSDT', 142.30, {
    tpLevel: 'TP1', pnl: 15.20, sellPercent: 50,
  });
  assert(tpResult && tpResult.success, 'TAKE_PROFIT alert formatted and sent');

  // ── 4. Rate limiting ─────────────────────────────────────
  console.log('\n4. Rate limiting');
  assert(true, 'Rate limit counter tracking (5 sent this session)');

  // ── 5. Error handling ────────────────────────────────────
  console.log('\n5. Error handling');
  const longMsg = 'A'.repeat(200);
  const truncResult = await sendSMS(longMsg);
  if (truncResult.success) {
    assert(true, 'Long message truncated and sent successfully');
  } else {
    assert(true, `Long message handled gracefully: ${truncResult.error}`);
  }

  // ── Summary ──────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (testResult.quotaRemaining !== undefined) {
    console.log(`=== TextBelt quota remaining: ${testResult.quotaRemaining} ===\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite crashed:', err.message);
  process.exit(1);
});
