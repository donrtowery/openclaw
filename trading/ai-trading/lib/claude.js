import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/connection.js';
import logger from './logger.js';

const MODEL = 'claude-haiku-4-5-20251001';

// Haiku pricing per million tokens
const INPUT_COST_PER_M = 1.00;
const OUTPUT_COST_PER_M = 5.00;

let anthropic = null;

function getAnthropicClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

const SYSTEM_PROMPT = `You are a crypto trading analyst using technical analysis. You receive RSI, MACD, SMA, EMA, Bollinger Bands, volume, and support/resistance data.

Risk tiers:
- Tier 1 (ETH, SOL, XRP, AVAX, DOT): Blue chips. 15% stop, 2 DCA levels (-5%, -10%), high conviction
- Tier 2 (LINK, ADA, ATOM, NEAR, POL, OP, ARB, SUI, AAVE, UNI, LDO, FIL, ICP, THETA): Established. 10% stop, 1 DCA (-5%), medium conviction
- Tier 3 (RENDER, JUP, GALA, XTZ, GRT, SAND): Speculative. 5% stop, no DCA, low conviction
- TPs: +5% (sell 50%), +8% (sell 30%), +12% (sell 20%)
- Position: $600, max 5 concurrent

EXISTING POSITIONS:
- HOLD if trend supports and no TP/SL hit
- CLOSE if multiple indicators turn against (RSI overbought + MACD bearish + resistance)
- DCA if at DCA trigger AND indicators show temporary dip (RSI oversold, support, declining volume)

NEW ENTRIES — only BUY if 3+ conditions met:
- RSI < 40 (approaching oversold)
- MACD bullish crossover or positive momentum
- Price near support level
- Volume stable or increasing
- Price not far below SMA200
- Be conservative — better to miss than enter bad trade

Always respond in valid JSON. Be concise.`;

function calculateCost(inputTokens, outputTokens) {
  return (inputTokens * INPUT_COST_PER_M + outputTokens * OUTPUT_COST_PER_M) / 1_000_000;
}

async function logAnalysis(checkType, symbols, decision, reasoning, inputTokens, outputTokens) {
  const cost = calculateCost(inputTokens, outputTokens);
  try {
    await query(
      `INSERT INTO ai_analyses (check_type, symbols, decision, reasoning, tokens_input, tokens_output, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [checkType, symbols, decision, reasoning, inputTokens, outputTokens, cost]
    );
  } catch (err) {
    logger.error(`Failed to log AI analysis: ${err.message}`);
  }
  return cost;
}

async function askClaude(userPrompt, maxTokens = 1500) {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.text || '{}';
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;

  let parsed;
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    parsed = JSON.parse(jsonMatch[1].trim());
  } catch {
    logger.warn(`Claude returned non-JSON response, using raw text`);
    parsed = { raw: text };
  }

  return { parsed, text, inputTokens, outputTokens };
}

function formatPositionsForPrompt(positions, prices) {
  if (positions.length === 0) return 'No open positions.';

  return positions.map(p => {
    const entry = parseFloat(p.avg_entry_price);
    const current = prices[p.symbol] || entry;
    const pnlPct = ((current - entry) / entry * 100).toFixed(2);
    const dca = p.dca_level > 0 ? ` DCA${p.dca_level}` : '';
    const tps = [
      p.tp1_hit ? 'TP1*' : 'TP1',
      p.tp2_hit ? 'TP2*' : 'TP2',
      p.tp3_hit ? 'TP3*' : 'TP3',
    ].join('/');
    return `${p.symbol}: entry=$${entry.toFixed(2)} now=$${current.toFixed(2)} P&L=${pnlPct}%${dca} SL=$${parseFloat(p.stop_loss_price).toFixed(2)} ${tps}`;
  }).join('\n');
}

// ── Public API ─────────────────────────────────────────────

/**
 * Hourly check — assess positions AND scan all symbols for entries.
 * @param {object[]} positions - Open positions
 * @param {object} prices - { symbol: price }
 * @param {object} circuitBreaker - { isPaused, consecutiveLosses }
 * @param {string} technicalSummary - Formatted TA for all 25 symbols
 * @returns {Promise<object>}
 */
export async function lightCheck(positions, prices, circuitBreaker, technicalSummary, recentlyClosed = []) {
  const posText = formatPositionsForPrompt(positions, prices);
  const cbStatus = circuitBreaker.isPaused
    ? `PAUSED (${circuitBreaker.consecutiveLosses} losses)`
    : `Active (${circuitBreaker.consecutiveLosses} losses)`;

  const heldSymbols = new Set(positions.map(p => p.symbol));
  const canBuy = !circuitBreaker.isPaused && positions.length < 5;

  const cooldownText = recentlyClosed.length > 0
    ? `\nCOOLDOWN — Do NOT recommend buying these symbols (closed within 24h):\n${recentlyClosed.map(r => `- ${r.symbol} (closed ${r.hoursAgo}h ago, sold at $${r.exitPrice.toFixed(4)})`).join('\n')}\n`
    : '';

  const prompt = `HOURLY CHECK — monitor positions + scan for entries.

Circuit breaker: ${cbStatus} | Positions: ${positions.length}/5
${cooldownText}
Open positions:
${posText}

Technical analysis (all 25 symbols):
${technicalSummary}

Tasks:
1. For each open position: HOLD, CLOSE, or DCA with confidence 0.0-1.0
2. ${canBuy ? 'Scan all symbols for BUY opportunities (exclude symbols already held and symbols on cooldown). Only recommend if confidence >= 0.7 and 3+ technical conditions met.' : 'At max positions or paused — no new entries.'}

JSON response:
{
  "marketPhase": "BULL|BEAR|SIDEWAYS",
  "existingPositions": [{"symbol":"...","action":"HOLD|CLOSE|DCA","confidence":0.0,"reasoning":"..."}],
  "newEntries": [{"symbol":"...","action":"BUY","confidence":0.0,"reasoning":"..."}],
  "summary": "..."
}`;

  try {
    const { parsed, text, inputTokens, outputTokens } = await askClaude(prompt);
    const symbols = [...heldSymbols];
    const posDecisions = (parsed.existingPositions || []).map(d => `${d.symbol}:${d.action}`).join(', ');
    const entries = (parsed.newEntries || []).map(e => `${e.symbol}(${e.confidence})`).join(', ');
    const decision = `phase=${parsed.marketPhase || '?'} pos=[${posDecisions}] entries=[${entries}]`;
    const cost = await logAnalysis('LIGHT', symbols, decision, text, inputTokens, outputTokens);

    logger.info(`Light check: ${inputTokens + outputTokens} tokens, $${cost.toFixed(4)} — phase=${parsed.marketPhase} entries=[${entries}]`);

    return {
      checkType: 'LIGHT',
      marketPhase: parsed.marketPhase || 'UNKNOWN',
      decisions: parsed.existingPositions || [],
      newEntries: parsed.newEntries || [],
      summary: parsed.summary || '',
      tokensUsed: inputTokens + outputTokens,
      cost,
    };
  } catch (err) {
    logger.error(`Light check failed: ${err.message}`);
    return { checkType: 'LIGHT', marketPhase: 'UNKNOWN', decisions: [], newEntries: [], tokensUsed: 0, cost: 0 };
  }
}

/**
 * 6-hourly deep check — same as light but adds news context.
 * @param {object[]} positions
 * @param {object} prices
 * @param {string} newsContext - Brave Search news
 * @param {object} circuitBreaker
 * @param {string} technicalSummary - Formatted TA for all 25 symbols
 * @returns {Promise<object>}
 */
export async function deepCheck(positions, prices, newsContext, circuitBreaker, technicalSummary, recentlyClosed = []) {
  const posText = formatPositionsForPrompt(positions, prices);
  const cbStatus = circuitBreaker.isPaused
    ? `PAUSED (${circuitBreaker.consecutiveLosses} losses)`
    : `Active (${circuitBreaker.consecutiveLosses} losses)`;

  const heldSymbols = new Set(positions.map(p => p.symbol));
  const canBuy = !circuitBreaker.isPaused && positions.length < 5;

  const cooldownText = recentlyClosed.length > 0
    ? `\nCOOLDOWN — Do NOT recommend buying these symbols (closed within 24h):\n${recentlyClosed.map(r => `- ${r.symbol} (closed ${r.hoursAgo}h ago, sold at $${r.exitPrice.toFixed(4)})`).join('\n')}\n`
    : '';

  const prompt = `DEEP CHECK — full analysis with news + technicals.

Circuit breaker: ${cbStatus} | Positions: ${positions.length}/5
${cooldownText}
Open positions:
${posText}

Technical analysis (all 25 symbols):
${technicalSummary}

Market news & sentiment:
${newsContext || 'No news available.'}

Tasks:
1. For each open position: HOLD, CLOSE, or DCA with confidence 0.0-1.0
2. ${canBuy ? 'Scan all symbols for BUY opportunities (exclude held and symbols on cooldown). Require confidence >= 0.7, 3+ technical conditions, and no contradicting news.' : 'At max positions or paused — no new entries.'}
3. Factor news into analysis — negative news (hacks, bans, crashes) reduces entry confidence, positive news (ETFs, adoption) increases it. When news contradicts technicals, favor caution.

JSON response:
{
  "marketPhase": "BULL|BEAR|SIDEWAYS",
  "existingPositions": [{"symbol":"...","action":"HOLD|CLOSE|DCA","confidence":0.0,"reasoning":"..."}],
  "newEntries": [{"symbol":"...","action":"BUY","confidence":0.0,"reasoning":"..."}],
  "summary": "..."
}`;

  try {
    const { parsed, text, inputTokens, outputTokens } = await askClaude(prompt, 2000);
    const symbols = [...heldSymbols];
    const posDecisions = (parsed.existingPositions || []).map(d => `${d.symbol}:${d.action}`).join(', ');
    const entries = (parsed.newEntries || []).map(e => `${e.symbol}(${e.confidence})`).join(', ');
    const decision = `phase=${parsed.marketPhase || '?'} pos=[${posDecisions}] entries=[${entries}]`;
    const cost = await logAnalysis('DEEP', symbols, decision, text, inputTokens, outputTokens);

    logger.info(`Deep check: ${inputTokens + outputTokens} tokens, $${cost.toFixed(4)} — phase=${parsed.marketPhase} entries=[${entries}]`);

    return {
      checkType: 'DEEP',
      marketPhase: parsed.marketPhase || 'UNKNOWN',
      decisions: parsed.existingPositions || [],
      newEntries: parsed.newEntries || [],
      summary: parsed.summary || '',
      tokensUsed: inputTokens + outputTokens,
      cost,
    };
  } catch (err) {
    logger.error(`Deep check failed: ${err.message}`);
    return { checkType: 'DEEP', marketPhase: 'UNKNOWN', decisions: [], newEntries: [], tokensUsed: 0, cost: 0 };
  }
}

/**
 * Alert check — tactical response to a price alert with TA context.
 * @param {object} alert
 * @param {object} position
 * @param {number} currentPrice
 * @param {object} circuitBreaker
 * @param {string} technicalSummary - Formatted TA for the alerted symbol
 * @returns {Promise<object>}
 */
export async function alertCheck(alert, position, currentPrice, circuitBreaker, technicalSummary) {
  const cbStatus = circuitBreaker.isPaused ? 'PAUSED' : 'Active';

  let posContext = 'No position in this symbol.';
  if (position) {
    const entry = parseFloat(position.avg_entry_price);
    const pnl = ((currentPrice - entry) / entry * 100).toFixed(2);
    posContext = `Position: entry=$${entry.toFixed(2)} now=$${currentPrice.toFixed(2)} P&L=${pnl}% DCA=${position.dca_level} SL=$${parseFloat(position.stop_loss_price).toFixed(2)}`;
  }

  const prompt = `ALERT CHECK — tactical decision needed.

Circuit breaker: ${cbStatus}
Alert: ${alert.alert_type} on ${alert.symbol} at $${parseFloat(alert.price).toFixed(2)}
Current price: $${currentPrice.toFixed(2)}
${posContext}

Technical analysis:
${technicalSummary || 'TA unavailable.'}

Decide: HOLD, CLOSE, DCA, BUY, or IGNORE. Include confidence 0.0-1.0.

JSON: {"action":"HOLD|CLOSE|DCA|BUY|IGNORE","confidence":0.0,"reasoning":"..."}`;

  try {
    const { parsed, text, inputTokens, outputTokens } = await askClaude(prompt);
    const cost = await logAnalysis('ALERT', [alert.symbol], `${parsed.action || 'IGNORE'}(${parsed.confidence || 0})`, text, inputTokens, outputTokens);

    logger.info(`Alert check ${alert.symbol}: ${parsed.action}(${parsed.confidence}) — ${inputTokens + outputTokens} tokens, $${cost.toFixed(4)}`);

    return {
      checkType: 'ALERT',
      action: parsed.action || 'IGNORE',
      confidence: parsed.confidence || 0,
      reasoning: parsed.reasoning || '',
      tokensUsed: inputTokens + outputTokens,
      cost,
    };
  } catch (err) {
    logger.error(`Alert check failed for ${alert.symbol}: ${err.message}`);
    return { checkType: 'ALERT', action: 'IGNORE', confidence: 0, reasoning: 'Error', tokensUsed: 0, cost: 0 };
  }
}
