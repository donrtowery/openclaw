import dotenv from 'dotenv';
dotenv.config();

import { testConnection, query } from '../db/connection.js';
import { testConnectivity } from '../lib/binance.js';

const checks = [];
let hasFailure = false;
let hasWarning = false;

function ok(name, detail) {
  checks.push({ status: 'OK', name, detail });
}
function warn(name, detail) {
  checks.push({ status: 'WARN', name, detail });
  hasWarning = true;
}
function fail(name, detail) {
  checks.push({ status: 'FAIL', name, detail });
  hasFailure = true;
}

async function run() {
  console.log('=== OpenClaw v2 Health Check ===\n');

  // 1. Database
  try {
    const dbOk = await testConnection();
    if (dbOk) ok('database', 'Connected');
    else fail('database', 'Connection returned false');
  } catch (e) {
    fail('database', e.message);
  }

  // 2. Symbols
  try {
    const r = await query('SELECT COUNT(*) as c FROM symbols WHERE is_active = true');
    const count = parseInt(r.rows[0].c);
    if (count >= 25) ok('symbols', `${count} active`);
    else if (count > 0) warn('symbols', `Only ${count} active (expected 25)`);
    else fail('symbols', 'No active symbols');
  } catch (e) {
    fail('symbols', e.message);
  }

  // 3. Open positions
  try {
    const r = await query("SELECT COUNT(*) as c FROM positions WHERE status = 'OPEN'");
    ok('openPositions', `${r.rows[0].c} open`);
  } catch (e) {
    fail('openPositions', e.message);
  }

  // 4. Circuit breaker
  try {
    const r = await query('SELECT is_active, consecutive_losses FROM circuit_breaker ORDER BY id LIMIT 1');
    if (r.rows.length > 0) {
      const cb = r.rows[0];
      if (cb.is_active) {
        warn('circuitBreaker', `ACTIVE (${cb.consecutive_losses} consecutive losses)`);
      } else {
        ok('circuitBreaker', `inactive, ${cb.consecutive_losses} consecutive losses`);
      }
    } else {
      warn('circuitBreaker', 'No circuit breaker row found');
    }
  } catch (e) {
    fail('circuitBreaker', e.message);
  }

  // 5. Pending events
  try {
    const r = await query('SELECT COUNT(*) as c FROM trade_events WHERE posted_to_discord = false');
    const count = parseInt(r.rows[0].c);
    if (count > 100) warn('pendingEvents', `${count} pending (queue backing up)`);
    else ok('pendingEvents', `${count} pending`);
  } catch (e) {
    fail('pendingEvents', e.message);
  }

  // 6. Dashboard API
  try {
    const resp = await fetch('http://localhost:3000/health', { signal: AbortSignal.timeout(3000) });
    if (resp.ok) ok('dashboardApi', `HTTP ${resp.status}`);
    else warn('dashboardApi', `HTTP ${resp.status}`);
  } catch {
    warn('dashboardApi', 'Unreachable (not running?)');
  }

  // 7. Recent snapshots
  try {
    const r = await query("SELECT COUNT(*) as c FROM indicator_snapshots WHERE created_at > NOW() - INTERVAL '10 minutes'");
    const count = parseInt(r.rows[0].c);
    if (count > 0) ok('recentSnapshots', `${count} in last 10 min`);
    else warn('recentSnapshots', '0 in last 10 min (scanner may be down)');
  } catch (e) {
    fail('recentSnapshots', e.message);
  }

  // 8. Binance
  try {
    const binOk = await testConnectivity();
    if (binOk) ok('binance', 'Connected');
    else fail('binance', 'Connectivity test returned false');
  } catch (e) {
    fail('binance', e.message);
  }

  // Print results
  for (const c of checks) {
    const icon = c.status === 'OK' ? '\x1b[32m✅' : c.status === 'WARN' ? '\x1b[33m⚠️ ' : '\x1b[31m❌';
    console.log(`${icon} ${c.name}: ${c.status} (${c.detail})\x1b[0m`);
  }

  console.log('');
  if (hasFailure) {
    console.log('\x1b[31mOverall: ❌ FAILURES DETECTED\x1b[0m');
    process.exit(1);
  } else if (hasWarning) {
    const warnCount = checks.filter(c => c.status === 'WARN').length;
    console.log(`\x1b[33mOverall: ⚠️  ISSUES FOUND (${warnCount} warning${warnCount > 1 ? 's' : ''})\x1b[0m`);
    process.exit(0);
  } else {
    console.log('\x1b[32mOverall: ✅ ALL SYSTEMS HEALTHY\x1b[0m');
    process.exit(0);
  }
}

run().catch(e => {
  console.error(`Health check failed: ${e.message}`);
  process.exit(1);
});
