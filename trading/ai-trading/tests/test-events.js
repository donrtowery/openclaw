import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

const { queueEvent, getPendingEvents, markEventsPosted, cleanOldEvents, getEventStats } = await import('../lib/events.js');
const { query } = await import('../db/connection.js');

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ${PASS} ${label}`); passed++; }
  else { console.log(`  ${FAIL} ${label}`); failed++; }
}

async function run() {
  console.log('\n=== OpenClaw Event System Test Suite ===\n');

  // ── 1. Queue events ──────────────────────────────────────
  console.log('1. Queue events');
  const ids = [];

  let id = await queueEvent('BUY', 'XRPUSDT', {
    action: 'BUY', symbol: 'XRPUSDT', price: 1.44, positionSize: 600,
    confidence: 0.72, reasoning: 'RSI oversold + MACD bullish', tier: 1,
    openPositions: '1/5',
  });
  ids.push(id);
  assert(id !== null, `BUY event queued (id=${id})`);

  id = await queueEvent('SELL', 'ETHUSDT', {
    action: 'CLOSE', symbol: 'ETHUSDT', entryPrice: 2100, exitPrice: 2200,
    pnl: 28.57, pnlPercent: 4.76, reason: 'TP1 hit', holdDuration: '2d 4h', confidence: 0.85,
  });
  ids.push(id);
  assert(id !== null, `SELL event queued (id=${id})`);

  id = await queueEvent('HOURLY_SUMMARY', null, {
    checkType: 'light', marketPhase: 'SIDEWAYS', symbolsAnalyzed: 25,
    openPositions: [{ symbol: 'XRPUSDT', pnl: 2.35, pnlPercent: 0.39, action: 'HOLD' }],
    newEntrySignals: [], tokensUsed: 2621, cost: 0.0048,
  });
  ids.push(id);
  assert(id !== null, `HOURLY_SUMMARY event queued (id=${id})`);

  id = await queueEvent('SYSTEM', null, {
    message: 'Test event', severity: 'INFO',
  });
  ids.push(id);
  assert(id !== null, `SYSTEM event queued (id=${id})`);

  // ── 2. Fetch pending events ──────────────────────────────
  console.log('\n2. Fetch pending events');
  const pending = await getPendingEvents(50);
  const ourPending = pending.filter(e => ids.includes(e.id));
  assert(ourPending.length === 4, `Found all 4 test events in pending (got ${ourPending.length})`);
  assert(ourPending[0].data.action || ourPending[0].data.checkType || ourPending[0].data.message,
    'Event data is valid JSONB');

  // ── 3. Mark events posted ────────────────────────────────
  console.log('\n3. Mark events as posted');
  const marked = await markEventsPosted(ids);
  assert(marked === 4, `Marked ${marked} events as posted`);

  const afterMark = await getPendingEvents(50);
  const stillPending = afterMark.filter(e => ids.includes(e.id));
  assert(stillPending.length === 0, 'Events no longer appear in pending');

  // ── 4. Event stats ───────────────────────────────────────
  console.log('\n4. Event stats');
  const stats = await getEventStats();
  assert(stats.today_total >= 4, `Today total: ${stats.today_total}`);
  assert(stats.today_posted >= 4, `Today posted: ${stats.today_posted}`);
  assert(typeof stats.pending === 'number', `Pending: ${stats.pending}`);

  // ── 5. API endpoint test ─────────────────────────────────
  console.log('\n5. Dashboard API endpoints');
  const apiKey = process.env.DASHBOARD_API_KEY;
  const port = process.env.DASHBOARD_API_PORT || 3000;
  const base = `http://localhost:${port}/api/dashboard`;

  try {
    // get_events
    let res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ action: 'get_events' }),
    });
    let body = await res.json();
    assert(body.success && Array.isArray(body.data.events), `get_events: ${body.data.count} pending`);

    // get_event_stats
    res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ action: 'get_event_stats' }),
    });
    body = await res.json();
    assert(body.success && typeof body.data.today_total === 'number',
      `get_event_stats: today=${body.data.today_total} pending=${body.data.pending}`);

    // mark_events_posted (empty array — should return error)
    res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ action: 'mark_events_posted', eventIds: [] }),
    });
    body = await res.json();
    assert(body.success && body.data.error, 'mark_events_posted rejects empty array');
  } catch (err) {
    console.log(`  ${FAIL} API test failed: ${err.message}`);
    console.log('         (Is the dashboard API running?)');
    failed++;
  }

  // ── 6. Cleanup ───────────────────────────────────────────
  console.log('\n6. Cleanup');
  await query('DELETE FROM trade_events WHERE id = ANY($1)', [ids]);
  console.log(`  Deleted ${ids.length} test events`);

  // ── Summary ──────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite crashed:', err.message);
  process.exit(1);
});
