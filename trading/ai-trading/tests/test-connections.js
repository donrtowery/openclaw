import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';
import Binance from 'binance-api-node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

async function main() {
  console.log('==========================================');
  console.log('  OpenClaw AI Trading — Connection Tests');
  console.log('==========================================');

  // 1. Database
  console.log('\n== 1. Database Connection ==');
  try {
    const pool = new pg.Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    const res = await pool.query('SELECT NOW() AS now, (SELECT COUNT(*) FROM symbols) AS symbols');
    console.log(`  Connected: ${res.rows[0].now}`);
    console.log(`  Symbols in DB: ${res.rows[0].symbols}`);
    console.log('  PASS');
    await pool.end();
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }

  // 2. Binance API
  console.log('\n== 2. Binance API ==');
  try {
    const client = Binance.default({
      apiKey: process.env.BINANCE_API_KEY,
      apiSecret: process.env.BINANCE_SECRET_KEY,
      httpBase: 'https://api.binance.us',
    });
    const btc = await client.prices({ symbol: 'BTCUSDT' });
    const eth = await client.prices({ symbol: 'ETHUSDT' });
    const sol = await client.prices({ symbol: 'SOLUSDT' });
    console.log(`  BTC: $${parseFloat(btc.BTCUSDT).toFixed(2)}`);
    console.log(`  ETH: $${parseFloat(eth.ETHUSDT).toFixed(2)}`);
    console.log(`  SOL: $${parseFloat(sol.SOLUSDT).toFixed(2)}`);
    console.log('  PASS');
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }

  // 3. Discord Webhooks
  console.log('\n== 3. Discord Webhooks ==');
  try {
    const tradingEmbed = {
      title: 'OpenClaw AI Trading — Connection Test',
      color: 0x2ecc71,
      fields: [
        { name: 'Status', value: 'Trading webhook connected', inline: false },
        { name: 'Mode', value: 'Paper Trading', inline: true },
        { name: 'Phase', value: 'Phase 2 Complete', inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Live Connection Test' },
    };
    const res1 = await fetch(process.env.DISCORD_WEBHOOK_TRADING, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [tradingEmbed] }),
    });
    console.log(`  Trading webhook: ${res1.ok ? 'PASS' : 'FAIL'} (${res1.status})`);

    const dashEmbed = {
      title: 'OpenClaw Dashboard — Connection Test',
      color: 0x3498db,
      fields: [
        { name: 'Status', value: 'Dashboard webhook connected', inline: false },
        { name: 'System', value: 'All services ready', inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Live Connection Test' },
    };
    const res2 = await fetch(process.env.DISCORD_WEBHOOK_DASHBOARD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [dashEmbed] }),
    });
    console.log(`  Dashboard webhook: ${res2.ok ? 'PASS' : 'FAIL'} (${res2.status})`);
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }

  // 4. Paper Trading Mode
  console.log('\n== 4. Paper Trading Mode ==');
  const paperMode = process.env.PAPER_TRADING;
  console.log(`  PAPER_TRADING=${paperMode}`);
  if (paperMode === 'true') {
    console.log('  PASS — Paper mode ACTIVE (no real trades will execute)');
  } else {
    console.log('  WARNING — Paper mode is NOT active!');
  }

  // 5. Anthropic API Key (format check only)
  console.log('\n== 5. Anthropic API Key (format only) ==');
  const key = process.env.ANTHROPIC_API_KEY || '';
  const validFormat = key.startsWith('sk-ant-api03-') && key.length > 50;
  console.log(`  Key prefix: ${key.slice(0, 16)}...`);
  console.log(`  Key length: ${key.length} chars`);
  console.log(`  ${validFormat ? 'PASS — Format valid (NOT calling API to save tokens)' : 'FAIL — Unexpected key format'}`);

  console.log('\n==========================================');
  console.log('  All connection tests complete');
  console.log('==========================================');
}

main().catch(err => {
  console.error('Test runner error:', err.message);
  process.exit(1);
});
