import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

import { deepCheck } from '../lib/claude.js';
import { getPrice } from '../lib/binance.js';
import { analyzeAll, formatAllForClaude } from '../lib/technical-analysis.js';
import { getMarketSentiment } from '../lib/brave-search.js';

const symbols = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','UNIUSDT','ATOMUSDT','OPUSDT','LINKUSDT','AAVEUSDT','DOTUSDT','MATICUSDT','AVAXUSDT',
  'ALGOUSDT','HBARUSDT','ARBUSDT',
];

async function run() {
  console.log('==========================================');
  console.log('  TEST: Deep Check (technicals + news)');
  console.log('==========================================\n');

  const prices = {};
  for (const s of symbols) {
    try { prices[s] = await getPrice(s); } catch {}
  }
  console.log(`Prices loaded: ${Object.keys(prices).length}/16`);

  const start = Date.now();
  const analyses = await analyzeAll(symbols);
  const taTime = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`TA complete: ${analyses.filter(a => !a.error).length}/16 in ${taTime}s`);

  const taSummary = formatAllForClaude(analyses);

  const newsStart = Date.now();
  const news = await getMarketSentiment();
  console.log(`News loaded: ${news.split('\n').length} lines in ${((Date.now() - newsStart) / 1000).toFixed(1)}s\n`);

  const result = await deepCheck([], prices, news, { isPaused: false, consecutiveLosses: 0 }, taSummary);

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
