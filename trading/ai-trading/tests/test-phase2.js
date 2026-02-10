import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

import { query, getClient } from '../db/connection.js';
import pool from '../db/connection.js';
import {
  getTierForSymbol, calculateStopLoss, calculateDCAPrice,
  calculateTakeProfits, checkCircuitBreaker, canOpenPosition,
  shouldDCA, shouldStopLoss, shouldTakeProfit,
} from '../lib/risk-manager.js';
import {
  openPosition, executeDCA, executeTakeProfit, closePosition,
  getOpenPositions, getPositionBySymbol,
} from '../lib/position-manager.js';
import { postTradeAlert } from '../lib/discord.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  PASS: ${testName}`);
    passed++;
  } else {
    console.log(`  FAIL: ${testName}`);
    failed++;
  }
}

// ── Test 1: Database connection ────────────────────────────

async function testDatabase() {
  console.log('\n== Test 1: Database Connection ==');
  try {
    const result = await query('SELECT NOW() AS now');
    assert(result.rows.length === 1, 'Can execute query');

    const symbols = await query('SELECT COUNT(*)::int AS count FROM symbols');
    assert(symbols.rows[0].count === 16, '16 symbols exist');

    const cb = await query('SELECT * FROM circuit_breaker WHERE id = 1');
    assert(cb.rows.length === 1, 'Circuit breaker row exists');
    assert(cb.rows[0].is_paused === false, 'Circuit breaker not paused');
  } catch (err) {
    console.log(`  FAIL: Database connection — ${err.message}`);
    failed++;
  }
}

// ── Test 2: Risk manager calculations ──────────────────────

async function testRiskManager() {
  console.log('\n== Test 2: Risk Manager ==');

  // Tier lookups
  const btc = getTierForSymbol('BTCUSDT');
  assert(btc && btc.tier === 1, 'BTC is Tier 1');

  const ada = getTierForSymbol('ADAUSDT');
  assert(ada && ada.tier === 2, 'ADA is Tier 2');

  const algo = getTierForSymbol('ALGOUSDT');
  assert(algo && algo.tier === 3, 'ALGO is Tier 3');

  const unknown = getTierForSymbol('FAKEUSDT');
  assert(unknown === null, 'Unknown symbol returns null');

  // Stop losses
  const btcStop = calculateStopLoss('BTCUSDT', 100000);
  assert(btcStop === 85000, `BTC stop loss at 15%: $${btcStop}`);

  const adaStop = calculateStopLoss('ADAUSDT', 1.00);
  assert(adaStop === 0.90, `ADA stop loss at 10%: $${adaStop}`);

  const algoStop = calculateStopLoss('ALGOUSDT', 0.50);
  assert(algoStop === 0.475, `ALGO stop loss at 5%: $${algoStop}`);

  // DCA prices
  const btcDCA1 = calculateDCAPrice('BTCUSDT', 100000, 1);
  assert(btcDCA1 === 95000, `BTC DCA1 at -5%: $${btcDCA1}`);

  const btcDCA2 = calculateDCAPrice('BTCUSDT', 100000, 2);
  assert(btcDCA2 === 90000, `BTC DCA2 at -10%: $${btcDCA2}`);

  const algoDCA = calculateDCAPrice('ALGOUSDT', 0.50, 1);
  assert(algoDCA === null, 'ALGO has no DCA (Tier 3)');

  // Take profits
  const tp = calculateTakeProfits(100);
  assert(tp.tp1 === 105, `TP1 at +5%: $${tp.tp1}`);
  assert(tp.tp2 === 108, `TP2 at +8%: $${tp.tp2}`);
  assert(Math.abs(tp.tp3 - 112) < 0.001, `TP3 at +12%: $${tp.tp3}`);

  // Circuit breaker
  const cb = await checkCircuitBreaker();
  assert(cb.isPaused === false, 'Circuit breaker not paused');

  // Can open position
  const { canOpen } = await canOpenPosition();
  assert(canOpen === true, 'Can open new position');
}

// ── Test 3: Position lifecycle ─────────────────────────────

async function testPositionManager() {
  console.log('\n== Test 3: Position Manager (lifecycle) ==');

  let testPositionId = null;

  try {
    // Open a position
    const pos = await openPosition('BTCUSDT', 100000, 600);
    testPositionId = pos.id;
    assert(pos.symbol === 'BTCUSDT', 'Position opened for BTCUSDT');
    assert(parseFloat(pos.entry_price) === 100000, 'Entry price correct');
    assert(parseFloat(pos.amount) === 600, 'Amount is $600');
    assert(parseFloat(pos.stop_loss_price) === 85000, 'Stop loss at 85000 (15%)');
    assert(parseFloat(pos.tp1_price) === 105000, 'TP1 at 105000');

    // DCA1
    const dca1 = await executeDCA(pos.id, 1, 95000);
    assert(dca1.dca_level === 1, 'DCA level updated to 1');
    assert(parseFloat(dca1.amount) === 900, 'Total amount now $900');
    // Avg entry should be weighted: (600*100000 + 300*95000) / (0.006 + 0.003157...)
    const avgEntry = parseFloat(dca1.avg_entry_price);
    assert(avgEntry > 95000 && avgEntry < 100000, `Avg entry between 95k-100k: $${avgEntry.toFixed(2)}`);
    // Stop loss stays at original
    assert(parseFloat(dca1.stop_loss_price) === 85000, 'Stop loss unchanged after DCA');

    // TP1 hit (sell 50% at 105% of avg entry)
    const tp1Price = parseFloat(dca1.tp1_price);
    const tp1 = await executeTakeProfit(pos.id, 'TP1', tp1Price);
    assert(tp1.tp1_hit === true, 'TP1 marked as hit');
    assert(parseFloat(tp1.remaining_qty) < parseFloat(dca1.remaining_qty), 'Remaining qty reduced after TP1');

    // Close position
    const closed = await closePosition(pos.id, tp1Price, 'MANUAL');
    assert(closed.status === 'CLOSED', 'Position closed');
    assert(closed.close_reason === 'MANUAL', 'Close reason is MANUAL');
    assert(closed.realized_pnl !== null, `Realized P&L: $${closed.realized_pnl}`);

    // Verify getPositionBySymbol returns null for closed
    const check = await getPositionBySymbol('BTCUSDT');
    assert(check === null, 'No open BTC position after close');

    // Verify trades were recorded
    const trades = await query('SELECT * FROM trades WHERE position_id = $1 ORDER BY id', [pos.id]);
    assert(trades.rows.length === 4, `4 trades recorded (ENTRY, DCA1, TP1, MANUAL): got ${trades.rows.length}`);

  } catch (err) {
    console.log(`  FAIL: Position lifecycle — ${err.message}`);
    failed++;
  }

  // Cleanup test data
  if (testPositionId) {
    try {
      await query('DELETE FROM trades WHERE position_id = $1', [testPositionId]);
      await query('DELETE FROM positions WHERE id = $1', [testPositionId]);
      // Reset circuit breaker
      await query('UPDATE circuit_breaker SET consecutive_losses = 0, is_paused = false, paused_at = NULL, resume_at = NULL WHERE id = 1');
      console.log('  (Test data cleaned up)');
    } catch (err) {
      console.log(`  Warning: cleanup failed — ${err.message}`);
    }
  }
}

// ── Test 4: Discord webhook ────────────────────────────────

async function testDiscord() {
  console.log('\n== Test 4: Discord Webhook ==');
  if (!process.env.DISCORD_WEBHOOK_TRADING) {
    console.log('  SKIP: DISCORD_WEBHOOK_TRADING not set');
    return;
  }

  try {
    await postTradeAlert('Test message from OpenClaw AI Trading Phase 2 test');
    assert(true, 'Discord webhook sent (check channel for message)');
  } catch (err) {
    console.log(`  FAIL: Discord webhook — ${err.message}`);
    failed++;
  }
}

// ── Test 5: Binance connection ─────────────────────────────

async function testBinance() {
  console.log('\n== Test 5: Binance Connection ==');
  try {
    const { getPrice } = await import('../lib/binance.js');
    const btcPrice = await getPrice('BTCUSDT');
    assert(btcPrice > 0, `BTC price: $${btcPrice.toFixed(2)}`);
  } catch (err) {
    if (err.message.includes('API') || err.message.includes('key') || err.message.includes('restricted')) {
      console.log(`  SKIP: Binance API not configured — ${err.message}`);
    } else {
      console.log(`  FAIL: Binance — ${err.message}`);
      failed++;
    }
  }
}

// ── Run all tests ──────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  OpenClaw AI Trading — Phase 2 Tests');
  console.log('========================================');

  await testDatabase();
  await testRiskManager();
  await testPositionManager();
  await testDiscord();
  await testBinance();

  console.log('\n========================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('========================================');

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  pool.end();
  process.exit(1);
});
