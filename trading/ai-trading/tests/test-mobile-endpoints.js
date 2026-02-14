import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = `http://127.0.0.1:${process.env.DASHBOARD_API_PORT || 3000}`;
const API_KEY = process.env.DASHBOARD_API_KEY;

let passed = 0;
let failed = 0;

async function api(action, params = {}) {
  const res = await fetch(`${BASE_URL}/api/dashboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ action, ...params }),
  });
  return { status: res.status, body: await res.json() };
}

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ─── Test suites ────────────────────────────────────────────

async function testHealth() {
  console.log('\n── Health Check ──');
  const res = await fetch(`${BASE_URL}/health`);
  const body = await res.json();
  assert('Health endpoint returns 200', res.status === 200);
  assert('Health has status ok', body.status === 'ok');
}

async function testAuthReject() {
  console.log('\n── Auth Rejection ──');
  const res = await fetch(`${BASE_URL}/api/dashboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong-key' },
    body: JSON.stringify({ action: 'get_portfolio_summary' }),
  });
  assert('Bad API key returns 401', res.status === 401);
}

async function testPauseResume() {
  console.log('\n── Pause / Resume Trading ──');

  // Pause
  const pause = await api('pause_trading');
  assert('pause_trading succeeds', pause.body.success === true, JSON.stringify(pause.body));

  // Verify engine is stopped
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync('systemctl is-active openclaw-engine');
    assert('Engine is inactive after pause', stdout.trim() !== 'active', stdout.trim());
  } catch {
    // exit code 3 = inactive, which is expected
    assert('Engine is inactive after pause', true);
  }

  // Resume
  const resume = await api('resume_trading');
  assert('resume_trading succeeds', resume.body.success === true, JSON.stringify(resume.body));

  // Give it a moment to start
  await new Promise(r => setTimeout(r, 2000));

  try {
    const { stdout } = await execAsync('systemctl is-active openclaw-engine');
    assert('Engine is active after resume', stdout.trim() === 'active', stdout.trim());
  } catch (e) {
    assert('Engine is active after resume', false, e.message);
  }
}

async function testClosePositionErrors() {
  console.log('\n── Close Position (error cases) ──');

  // Missing position_id
  const r1 = await api('close_position', {});
  assert('Missing position_id returns error', r1.body.error && r1.body.error.includes('position_id'));

  // Short reason
  const r2 = await api('close_position', { position_id: 1, reason: 'short' });
  assert('Short reason returns error', r2.body.error && r2.body.error.includes('10 characters'));

  // Non-existent position
  const r3 = await api('close_position', { position_id: 999999, reason: 'Testing non-existent position close' });
  assert('Non-existent position returns error', r3.body.error && r3.body.error.includes('999999'));
}

async function testCloseAllErrors() {
  console.log('\n── Close All Positions (error cases) ──');

  // Missing reason
  const r1 = await api('close_all_positions', {});
  assert('Missing reason returns error', !!r1.body.error);

  // Short reason
  const r2 = await api('close_all_positions', { reason: 'short' });
  assert('Short reason returns error', r2.body.error && r2.body.error.includes('10 characters'));
}

async function testClosePositionLive() {
  console.log('\n── Close Position (live) ──');

  // Check if there are any open positions
  const positions = await api('get_positions');
  if (!positions.body.data || positions.body.data.length === 0) {
    console.log('  SKIP  No open positions to close');
    return;
  }

  const pos = positions.body.data[0];
  console.log(`  INFO  Attempting to close position #${pos.id} (${pos.symbol})`);

  const result = await api('close_position', {
    position_id: pos.id,
    reason: 'Test close from mobile endpoint test script',
  });

  assert('close_position succeeds', result.body.success === true, JSON.stringify(result.body));
  if (result.body.success) {
    assert('Response has symbol', !!result.body.symbol);
    assert('Response has pnl', result.body.pnl !== undefined);
    assert('Response has pnl_percent', result.body.pnl_percent !== undefined);
    console.log(`  INFO  Closed ${result.body.symbol} | P&L: $${result.body.pnl} (${result.body.pnl_percent}%)`);
  }
}

async function testAnalyzePosition() {
  console.log('\n── Analyze Position ──');

  // Error: missing symbol
  const r1 = await api('analyze_position', {});
  assert('Missing symbol returns error', !!r1.body.error);

  // Error: no position for symbol
  const r2 = await api('analyze_position', { symbol: 'FAKECOINUSDT' });
  assert('Non-existent symbol returns error', !!r2.body.error);

  // Live test if there are open positions
  const positions = await api('get_positions');
  if (!positions.body.data || positions.body.data.length === 0) {
    console.log('  SKIP  No open positions to analyze');
    return;
  }

  const sym = positions.body.data[0].symbol;
  console.log(`  INFO  Analyzing ${sym} (this calls Claude, may take 10-20s)...`);

  const result = await api('analyze_position', { symbol: sym });
  assert('analyze_position succeeds', !!result.body.data, JSON.stringify(result.body));
  if (result.body.data) {
    const d = result.body.data;
    assert('Has recommendation', !!d.recommendation);
    assert('Has confidence 0-1', d.confidence >= 0 && d.confidence <= 1);
    assert('Has reasoning', typeof d.reasoning === 'string' && d.reasoning.length > 10);
    console.log(`  INFO  Recommendation: ${d.recommendation} (${(d.confidence * 100).toFixed(0)}%)`);
    console.log(`  INFO  Reasoning: ${d.reasoning.substring(0, 120)}...`);
  }
}

async function testUpdateSettings() {
  console.log('\n── Update Settings ──');

  // Error: missing settings object
  const r1 = await api('update_settings', {});
  assert('Missing settings returns error', !!r1.body.error);

  // Error: out-of-range value
  const r2 = await api('update_settings', { settings: { max_positions: 50 } });
  assert('Out-of-range max_positions returns error', !!r2.body.error);

  const r3 = await api('update_settings', { settings: { tier_1_base: 10 } });
  assert('Out-of-range tier_1_base returns error', !!r3.body.error);

  // Valid update: change scanner interval then change it back
  const r4 = await api('update_settings', { settings: { scanner_interval: 10 } });
  assert('Valid settings update succeeds', r4.body.success === true, JSON.stringify(r4.body));
  if (r4.body.success) {
    assert('Returned scanner_interval is 10', r4.body.settings.scanner_interval === 10);
  }

  // Restore original value
  const r5 = await api('update_settings', { settings: { scanner_interval: 5 } });
  assert('Settings restored', r5.body.success === true);
}

async function testUnknownAction() {
  console.log('\n── Unknown Action ──');
  const r = await api('nonexistent_action');
  assert('Unknown action returns error', !!r.body.error);
}

// ─── Runner ─────────────────────────────────────────────────

async function run() {
  console.log('=== OpenClaw Mobile Endpoints Test Suite ===');
  console.log(`Target: ${BASE_URL}`);
  console.log(`API Key: ${API_KEY ? API_KEY.substring(0, 4) + '...' : 'NOT SET'}`);

  try {
    await testHealth();
    await testAuthReject();
    await testUnknownAction();
    await testPauseResume();
    await testClosePositionErrors();
    await testCloseAllErrors();
    await testUpdateSettings();
    await testAnalyzePosition();
    // Run live close LAST since it modifies state
    await testClosePositionLive();
  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    console.error(err.stack);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
