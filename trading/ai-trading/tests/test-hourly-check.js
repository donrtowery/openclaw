import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

import { lightCheck } from '../lib/claude.js';
import { getPrice } from '../lib/binance.js';
import { analyzeAll, formatAllForClaude } from '../lib/technical-analysis.js';

const symbols = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','UNIUSDT','ATOMUSDT','OPUSDT','LINKUSDT','AAVEUSDT','DOTUSDT','MATICUSDT','AVAXUSDT',
  'ALGOUSDT','HBARUSDT','ARBUSDT',
];

async function run() {
  console.log('==========================================');
  console.log('  TEST: Hourly Check (technicals only)');
  console.log('==========================================\n');

  const prices = {};
  for (const s of symbols) {
    try { prices[s] = await getPrice(s); } catch {}
  }
  console.log(`Prices loaded: ${Object.keys(prices).length}/16`);

  const start = Date.now();
  const analyses = await analyzeAll(symbols);
  const taTime = ((Date.now() - start) / 1000).toFixed(1);
  const success = analyses.filter(a => !a.error).length;
  console.log(`TA complete: ${success}/16 symbols in ${taTime}s\n`);

  const taSummary = formatAllForClaude(analyses);

  const result = await lightCheck([], prices, { isPaused: false, consecutiveLosses: 0 }, taSummary);

  console.log(`Market phase: ${result.marketPhase}`);
  console.log(`Summary: ${result.summary}\n`);

  if (result.decisions?.length) {
    console.log('Position decisions:');
    for (const d of result.decisions) {
      console.log(`  ${d.symbol}: ${d.action} (conf=${d.confidence}) — ${d.reasoning}`);
    }
  }

  console.log('\nNew entry recommendations:');
  if (result.newEntries?.length) {
    for (const e of result.newEntries) {
      console.log(`  ${e.symbol}: BUY (conf=${e.confidence}) — ${e.reasoning}`);
    }
  } else {
    console.log('  None');
  }

  console.log(`\nTokens: ${result.tokensUsed} | Cost: $${(result.cost || 0).toFixed(4)}`);
  process.exit(0);
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
