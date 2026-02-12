import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { callHaiku, callSonnet, callHaikuBatch } from '../lib/claude.js';
import { getNewsContext } from '../lib/brave-search.js';
import { openPosition, addToPosition, closePosition, getPortfolioSummary } from '../lib/position-manager.js';
import { testConnection, query } from '../db/connection.js';
import { analyzeSymbol } from '../lib/technical-analysis.js';
import { testConnectivity } from '../lib/binance.js';

async function test() {
  console.log('=== OpenClaw v2 — AI Clients & Position Manager Test ===\n');

  const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));

  // 1. Prerequisites
  console.log('1. Database...');
  const dbOk = await testConnection();
  if (!dbOk) { console.error('FAIL: DB'); process.exit(1); }

  console.log('\n2. Binance...');
  const binanceOk = await testConnectivity();
  if (!binanceOk) { console.error('FAIL: Binance'); process.exit(1); }

  // 3. News search
  console.log('\n3. Brave news search (Ethereum)...');
  const news = await getNewsContext('ETHUSDT', 'Ethereum');
  console.log(`   ${news.substring(0, 200).replace(/\n/g, '\n   ')}...`);

  // 4. Get real analysis for a live symbol to use as test input
  console.log('\n4. Getting real ETHUSDT analysis for Haiku test...');
  const ethAnalysis = await analyzeSymbol('ETHUSDT');
  if (ethAnalysis.error) {
    console.error(`   FAIL: ${ethAnalysis.error}`);
    process.exit(1);
  }
  console.log(`   ETH: $${ethAnalysis.price} RSI:${ethAnalysis.rsi?.value} MACD:${ethAnalysis.macd?.crossover} Trend:${ethAnalysis.trend?.direction}`);

  // Build a realistic triggered signal from live data
  const mockTriggered = {
    symbol: 'ETHUSDT',
    tier: 1,
    price: ethAnalysis.price,
    analysis: ethAnalysis,
    thresholds_crossed: ['RSI_OVERSOLD', 'VOLUME_SPIKE'],
    has_position: false,
    position: null,
  };

  // 5. Call Haiku
  console.log('\n5. Calling Haiku (with prompt caching)...');
  const haikuResult = await callHaiku(mockTriggered, config);
  console.log(`   Signal: ${haikuResult.signal} | Strength: ${haikuResult.strength} | Confidence: ${haikuResult.confidence}`);
  console.log(`   Escalate: ${haikuResult.escalate}`);
  console.log(`   Reasons: ${(haikuResult.reasons || []).join('; ')}`);
  console.log(`   signal_id: ${haikuResult.signal_id}`);

  // 6. Call Sonnet (regardless of escalation, for testing)
  console.log('\n6. Calling Sonnet (with prompt caching)...');
  const portfolioState = await getPortfolioSummary(config);
  portfolioState.circuit_breaker_active = false;
  portfolioState.consecutive_losses = 0;

  const sonnetResult = await callSonnet(
    haikuResult,
    mockTriggered,
    news,
    portfolioState,
    [], // no learning rules yet
    config
  );
  console.log(`   Action: ${sonnetResult.action} | Confidence: ${sonnetResult.confidence}`);
  console.log(`   Reasoning: ${(sonnetResult.reasoning || '').substring(0, 200)}...`);
  console.log(`   decision_id: ${sonnetResult.decision_id}`);

  // 7. Test batched Haiku call (2 signals at once)
  console.log('\n7. Testing batched Haiku call (2 signals)...');
  const solAnalysis = await analyzeSymbol('SOLUSDT');
  const batchSignals = [
    mockTriggered,
    {
      symbol: 'SOLUSDT',
      tier: 1,
      price: solAnalysis.price,
      analysis: solAnalysis,
      thresholds_crossed: ['MACD_BULLISH_CROSSOVER'],
      has_position: false,
      position: null,
    },
  ];
  const batchResults = await callHaikuBatch(batchSignals, config);
  for (const r of batchResults) {
    console.log(`   ${r.symbol}: ${r.signal} ${r.strength} conf:${r.confidence} escalate:${r.escalate}`);
  }

  // 8. Position management
  console.log('\n8. Position management...');

  const posId = await openPosition(
    'ETHUSDT', 1, ethAnalysis.price, 800 / ethAnalysis.price, 800,
    'Test entry from AI test', 0.75, sonnetResult.decision_id
  );
  console.log(`   Opened position #${posId}`);

  const dcaResult = await addToPosition(
    posId, ethAnalysis.price * 0.97, 600 / (ethAnalysis.price * 0.97), 600,
    'Test DCA — price dipped 3%', 0.70
  );
  console.log(`   DCA done, new avg: $${dcaResult.newAvgEntry.toFixed(2)}`);

  const portfolio = await getPortfolioSummary(config);
  console.log(`   Portfolio: ${portfolio.open_count} open, $${portfolio.total_invested.toFixed(2)} invested, ${portfolio.unrealized_pnl_percent.toFixed(2)}% P&L`);

  const closeResult = await closePosition(
    posId, ethAnalysis.price * 1.05, 100,
    'Test exit — 5% profit target', 0.80, null
  );
  console.log(`   Closed: P&L $${closeResult.pnl.toFixed(2)} (${closeResult.pnlPercent.toFixed(2)}%)`);

  // 9. Verify database records
  console.log('\n9. Database verification...');
  const signalCount = await query('SELECT COUNT(*) as c FROM signals');
  const decisionCount = await query('SELECT COUNT(*) as c FROM decisions');
  const tradeCount = await query('SELECT COUNT(*) as c FROM trades');
  const posCount = await query('SELECT COUNT(*) as c FROM positions');
  console.log(`   Signals: ${signalCount.rows[0].c}`);
  console.log(`   Decisions: ${decisionCount.rows[0].c}`);
  console.log(`   Trades: ${tradeCount.rows[0].c}`);
  console.log(`   Positions: ${posCount.rows[0].c}`);

  // Check prompt snapshot was saved
  const decisionCheck = await query('SELECT LENGTH(prompt_snapshot) as len FROM decisions ORDER BY id DESC LIMIT 1');
  console.log(`   Prompt snapshot saved: ${decisionCheck.rows[0].len} chars`);

  console.log('\n=== All tests passed ===');
  process.exit(0);
}

test().catch(error => {
  console.error(`\nFAIL: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
