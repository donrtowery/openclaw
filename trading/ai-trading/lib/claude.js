import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, statSync } from 'fs';
import { query } from '../db/connection.js';
import { formatForClaude } from './technical-analysis.js';
import logger from './logger.js';
import dotenv from 'dotenv';
dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    'anthropic-beta': 'prompt-caching-2024-07-31',
  },
});

export const HAIKU_MODEL = process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001';
export const SONNET_MODEL = process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250929';

export { anthropic };

const API_TIMEOUT_MS = parseInt(process.env.CLAUDE_API_TIMEOUT_MS || '60000');

// ── API Cost Tracker ──
const apiCostTracker = {
  haiku_input_tokens: 0,
  haiku_output_tokens: 0,
  sonnet_input_tokens: 0,
  sonnet_output_tokens: 0,
  haiku_cache_read_tokens: 0,
  sonnet_cache_read_tokens: 0,
  calls: { haiku: 0, sonnet: 0 },
  reset_time: Date.now(),
};

export function getApiCosts() {
  // Pricing per million tokens (as of 2026)
  const HAIKU_INPUT = 0.80, HAIKU_OUTPUT = 4.00, HAIKU_CACHE = 0.08;
  const SONNET_INPUT = 3.00, SONNET_OUTPUT = 15.00, SONNET_CACHE = 0.30;
  const haikuCost = (apiCostTracker.haiku_input_tokens * HAIKU_INPUT + apiCostTracker.haiku_output_tokens * HAIKU_OUTPUT + apiCostTracker.haiku_cache_read_tokens * HAIKU_CACHE) / 1_000_000;
  const sonnetCost = (apiCostTracker.sonnet_input_tokens * SONNET_INPUT + apiCostTracker.sonnet_output_tokens * SONNET_OUTPUT + apiCostTracker.sonnet_cache_read_tokens * SONNET_CACHE) / 1_000_000;
  return {
    haiku: { cost: parseFloat(haikuCost.toFixed(4)), calls: apiCostTracker.calls.haiku },
    sonnet: { cost: parseFloat(sonnetCost.toFixed(4)), calls: apiCostTracker.calls.sonnet },
    total_cost: parseFloat((haikuCost + sonnetCost).toFixed(4)),
    since: new Date(apiCostTracker.reset_time).toISOString(),
  };
}

export function resetApiCosts() {
  apiCostTracker.haiku_input_tokens = 0;
  apiCostTracker.haiku_output_tokens = 0;
  apiCostTracker.sonnet_input_tokens = 0;
  apiCostTracker.sonnet_output_tokens = 0;
  apiCostTracker.haiku_cache_read_tokens = 0;
  apiCostTracker.sonnet_cache_read_tokens = 0;
  apiCostTracker.calls.haiku = 0;
  apiCostTracker.calls.sonnet = 0;
  apiCostTracker.reset_time = Date.now();
}

/**
 * Wrap an API call with a timeout
 */
function withTimeout(promise, timeoutMs = API_TIMEOUT_MS, label = 'API call') {
  let timer;
  const cleanup = () => clearTimeout(timer);
  return Promise.race([
    promise.then(result => { cleanup(); return result; }, err => { cleanup(); throw err; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

/**
 * Retry an async function with exponential backoff.
 * Retries on timeout, rate limit (429), and server errors (5xx).
 */
async function withRetry(fn, { maxAttempts = 3, label = 'API call' } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRetryable = error.message?.includes('timed out')
        || error.status === 429
        || (error.status >= 500 && error.status < 600)
        || error.error?.type === 'overloaded_error';

      if (!isRetryable || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 10000);
      logger.warn(`[API] ${label} attempt ${attempt}/${maxAttempts} failed: ${error.message}. Retrying in ${Math.round(delayMs)}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// Cache loaded prompt text to avoid repeated filesystem reads within the same cycle
let haikuPromptCache = { text: null, mtime: 0 };
let sonnetPromptCache = { text: null, mtime: 0 };
let sonnetExitPromptCache = { text: null, mtime: 0 };
let sonnetPredictionPromptCache = { text: null, mtime: 0 };

function loadPrompt(path, cache) {
  try {
    const stat = statSync(path);
    if (cache.text && stat.mtimeMs === cache.mtime) {
      return cache.text;
    }
    cache.text = readFileSync(path, 'utf8');
    cache.mtime = stat.mtimeMs;
    return cache.text;
  } catch {
    // Fallback: always read
    return readFileSync(path, 'utf8');
  }
}

/**
 * Extract JSON from a response that may contain surrounding prose/markdown.
 * Finds the outermost JSON array or object in the text.
 */
export function extractJSON(text) {
  // Strip markdown code fences first (case-insensitive, any language tag, handle \r\n)
  const cleaned = text.replace(/```\w*\r?\n?/gi, '').trim();

  // Try direct parse first (fast path)
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to bracket extraction
  }

  // Strip trailing commas before closing brackets (common LLM output artifact)
  const noTrailingCommas = cleaned.replace(/,\s*([\]}])/g, '$1');

  // Try parse after trailing comma cleanup
  try {
    return JSON.parse(noTrailingCommas);
  } catch {
    // Fall through to bracket extraction
  }

  // Find the first [ or { and match its closing bracket
  const arrayStart = noTrailingCommas.indexOf('[');
  const objectStart = noTrailingCommas.indexOf('{');

  let start;
  if (arrayStart === -1 && objectStart === -1) {
    throw new Error('No JSON found in response');
  } else if (arrayStart === -1) {
    start = objectStart;
  } else if (objectStart === -1) {
    start = arrayStart;
  } else {
    start = Math.min(arrayStart, objectStart);
  }

  // Walk forward tracking bracket depth (all bracket types)
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < noTrailingCommas.length; i++) {
    const ch = noTrailingCommas[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (depth === 0) {
      return JSON.parse(noTrailingCommas.substring(start, i + 1));
    }
  }

  throw new Error('Unterminated JSON in response');
}

/**
 * Call Haiku to evaluate one or more signals in a single batched call.
 * Uses prompt caching so the system prompt is only billed fully once per 5-min window.
 *
 * Cost savings:
 * - Prompt caching: ~90% reduction on system prompt tokens after first call
 * - Batching: 1 API call instead of N for N signals
 * - formatForClaude: compact ~4-line format vs raw JSON (~75% fewer user tokens)
 *
 * Returns: array of { symbol, signal, strength, escalate, confidence, reasons, concerns, signal_id }
 */
export async function callHaikuBatch(triggeredSignals, config) {
  if (triggeredSignals.length === 0) return [];

  const systemPrompt = loadPrompt('prompts/haiku-scanner.md', haikuPromptCache);

  // Build one user message with all triggered signals
  let userMessage = '';
  if (triggeredSignals.length === 1) {
    userMessage = formatHaikuInput(triggeredSignals[0]);
  } else {
    userMessage = `Evaluate the following ${triggeredSignals.length} signals. Return a JSON array with one evaluation object per signal.\n\n`;
    for (let i = 0; i < triggeredSignals.length; i++) {
      userMessage += `--- Signal ${i + 1} ---\n`;
      userMessage += formatHaikuInput(triggeredSignals[i]);
      userMessage += '\n';
    }
  }

  try {
    const startTime = Date.now();

    const message = await withRetry(
      () => withTimeout(
        anthropic.messages.create({
          model: HAIKU_MODEL,
          max_tokens: Math.min(512 * triggeredSignals.length, 4096),
          system: (() => {
            // Split prompt at LEARNING DATA marker for better cache hits
            const marker = '## LEARNING DATA';
            const markerIdx = systemPrompt.indexOf(marker);
            if (markerIdx > 0) {
              return [
                {
                  type: 'text',
                  text: systemPrompt.substring(0, markerIdx).trimEnd(),
                  cache_control: { type: 'ephemeral' },
                },
                {
                  type: 'text',
                  text: systemPrompt.substring(markerIdx),
                },
              ];
            }
            return [{
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            }];
          })(),
          messages: [{ role: 'user', content: userMessage }],
        }),
        API_TIMEOUT_MS,
        `Haiku batch (${triggeredSignals.length} signals)`
      ),
      { maxAttempts: 3, label: `Haiku batch (${triggeredSignals.length} signals)` }
    );

    const responseText = message.content?.[0]?.text;
    if (!responseText) {
      logger.error('[Haiku] Empty response — no text content returned');
      return triggeredSignals.map(ts => ({
        symbol: ts.symbol, signal: 'NONE', strength: 'WEAK',
        escalate: false, confidence: 0, reasons: ['Empty AI response'],
        concerns: ['API returned no content'], _fallback: true,
      }));
    }
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cacheRead = message.usage.cache_read_input_tokens || 0;
    const cacheCreation = message.usage.cache_creation_input_tokens || 0;
    const duration = Date.now() - startTime;

    apiCostTracker.haiku_input_tokens += inputTokens;
    apiCostTracker.haiku_output_tokens += outputTokens;
    apiCostTracker.haiku_cache_read_tokens += (message.usage.cache_read_input_tokens || 0);
    apiCostTracker.calls.haiku++;

    logger.info(`[Haiku] ${triggeredSignals.length} signal(s) evaluated in ${duration}ms | tokens: ${inputTokens}in/${outputTokens}out | cache: ${cacheRead} read, ${cacheCreation} created`);

    // Parse response — could be single object or array
    let parsed;
    try {
      parsed = extractJSON(responseText);
    } catch (parseErr) {
      logger.error(`[Haiku] JSON parse failed (${parseErr.message}), response: ${responseText.substring(0, 500)}`);
      logger.error(`[Haiku] WARNING: All ${triggeredSignals.length} signal(s) in this batch will be dropped. Check model output format.`);
      // Return safe fallback for all signals
      return triggeredSignals.map(sig => ({
        symbol: sig.symbol,
        signal: 'NONE',
        strength: 'WEAK',
        escalate: false,
        confidence: 0,
        reasons: ['Haiku response was not valid JSON — batch dropped'],
        concerns: [],
        signal_id: null,
      }));
    }

    // Normalize to array
    const results = Array.isArray(parsed) ? parsed : [parsed];

    // Log each signal to database and attach signal_id
    const output = [];
    const availableResults = [...results]; // Copy to allow splicing matched entries
    for (let i = 0; i < triggeredSignals.length; i++) {
      const sig = triggeredSignals[i];
      // Match by symbol first (handles out-of-order responses), splice to prevent double-matching
      const matchIdx = availableResults.findIndex(r => r.symbol === sig.symbol);
      // Always use symbol match or safe fallback — never positional results[i] which may
      // reference an already-consumed result when model reorders output
      const result = matchIdx !== -1
        ? availableResults.splice(matchIdx, 1)[0]
        : {
          symbol: sig.symbol, signal: 'NONE', strength: 'WEAK',
          escalate: false, confidence: 0, reasons: ['No response for this signal'], concerns: [],
        };

      let signalId = null;
      try {
        signalId = await logSignal(sig, result, inputTokens + outputTokens);
      } catch (logErr) {
        logger.error(`[Haiku] Failed to log signal for ${sig.symbol}: ${logErr.message}`);
      }

      logger.info(`[Haiku] ${sig.symbol}: ${result.strength} ${result.signal} conf:${result.confidence} escalate:${result.escalate}`);

      output.push({ ...result, signal_id: signalId });
    }

    return output;

  } catch (error) {
    logger.error('[Haiku] API error:', error.message);
    throw error;
  }
}

/**
 * Single-signal convenience wrapper (calls batch internally)
 */
export async function callHaiku(triggeredSignal, config) {
  const results = await callHaikuBatch([triggeredSignal], config);
  return results[0];
}

/**
 * Call Sonnet for final trading decision.
 * Uses prompt caching for the large system prompt (~12K).
 *
 * Returns: { action, symbol, confidence, position_details, reasoning, risk_assessment, alternative_considered, decision_id }
 */
export async function callSonnet(haikuSignal, triggeredSignal, newsContext, portfolioState, learningRules, config) {
  const systemPrompt = loadPrompt('prompts/sonnet-decision.md', sonnetPromptCache);

  const userMessage = formatSonnetInput(haikuSignal, triggeredSignal, newsContext, portfolioState, learningRules);

  try {
    const startTime = Date.now();

    const message = await withRetry(
      () => withTimeout(
        anthropic.messages.create({
          model: SONNET_MODEL,
          max_tokens: 1024,
          system: (() => {
            // Split prompt at LEARNING DATA marker for better cache hits
            const marker = '## LEARNING DATA';
            const markerIdx = systemPrompt.indexOf(marker);
            if (markerIdx > 0) {
              return [
                {
                  type: 'text',
                  text: systemPrompt.substring(0, markerIdx).trimEnd(),
                  cache_control: { type: 'ephemeral' },
                },
                {
                  type: 'text',
                  text: systemPrompt.substring(markerIdx),
                },
              ];
            }
            return [{
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            }];
          })(),
          messages: [{ role: 'user', content: userMessage }],
        }),
        API_TIMEOUT_MS,
        `Sonnet decision (${triggeredSignal.symbol})`
      ),
      { maxAttempts: 3, label: `Sonnet decision (${triggeredSignal.symbol})` }
    );

    const responseText = message.content?.[0]?.text;
    if (!responseText) {
      logger.error(`[Sonnet] Empty response for ${triggeredSignal.symbol}`);
      return { action: 'PASS', symbol: triggeredSignal.symbol, confidence: 0,
        reasoning: 'Empty AI response — auto-PASS', _fallback: true };
    }
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cacheRead = message.usage.cache_read_input_tokens || 0;
    const duration = Date.now() - startTime;

    apiCostTracker.sonnet_input_tokens += inputTokens;
    apiCostTracker.sonnet_output_tokens += outputTokens;
    apiCostTracker.sonnet_cache_read_tokens += cacheRead;
    apiCostTracker.calls.sonnet++;

    logger.info(`[Sonnet] ${triggeredSignal.symbol} decided in ${duration}ms | tokens: ${inputTokens}in/${outputTokens}out | cache: ${cacheRead} read`);

    let parsed;
    try {
      parsed = extractJSON(responseText);
    } catch (parseErr) {
      logger.error(`[Sonnet] JSON parse failed (${parseErr.message}), response: ${responseText.substring(0, 500)}`);
      logger.error(`[Sonnet] WARNING: Decision for ${triggeredSignal.symbol} defaulting to PASS due to parse failure.`);
      parsed = {
        action: 'PASS',
        symbol: triggeredSignal.symbol,
        confidence: 0,
        position_details: null,
        reasoning: 'Parse error — could not interpret Sonnet response',
        risk_assessment: 'Unable to assess due to parse error',
        alternative_considered: 'N/A',
      };
    }

    // Default PARTIAL_EXIT to 50% if exit_percent not specified (matches exit eval path)
    if (parsed.action === 'PARTIAL_EXIT' && !parsed.position_details?.exit_percent) {
      parsed.position_details = parsed.position_details || {};
      parsed.position_details.exit_percent = 50;
    }

    // Enforce confidence safety net
    parsed = enforceConfidenceThresholds(parsed, config);

    // Log decision with full prompt snapshot (critical for future Haiku training)
    const decisionId = await logDecision(haikuSignal.signal_id, parsed, userMessage, inputTokens + outputTokens);

    logger.info(`[Sonnet] ${triggeredSignal.symbol}: ${parsed.action} conf:${parsed.confidence}`);
    logger.info(`[Sonnet] Reasoning: ${(parsed.reasoning || '').substring(0, 150)}...`);

    return { ...parsed, decision_id: decisionId };

  } catch (error) {
    logger.error('[Sonnet] API error:', error.message);
    throw error;
  }
}

/**
 * Batch Sonnet entry evaluations into a single API call.
 * Each item: { haikuSignal, triggeredSignal, newsContext }
 * Shared context: portfolioState, learningRules, config
 *
 * Returns: array of { action, symbol, confidence, ... , decision_id } in same order as inputs.
 */
export async function callSonnetBatch(items, portfolioState, learningRules, config) {
  if (items.length === 0) return [];

  // Single item — use direct call (no batch overhead)
  if (items.length === 1) {
    const { haikuSignal, triggeredSignal, newsContext } = items[0];
    const result = await callSonnet(haikuSignal, triggeredSignal, newsContext, portfolioState, learningRules, config);
    return [result];
  }

  const systemPrompt = loadPrompt('prompts/sonnet-decision.md', sonnetPromptCache);

  // Build batched user message
  let userMessage = `# BATCH SIGNAL EVALUATION — ${items.length} signals\n\n`;
  userMessage += `Evaluate each signal independently. Return a JSON array with one decision object per signal, in order. Each object must include "symbol".\n\n`;

  // Shared portfolio context (once, not per-signal)
  userMessage += `## Portfolio State\n`;
  userMessage += `Open positions: ${portfolioState.open_count}/${portfolioState.max_positions}\n`;
  userMessage += `Unrealized P&L: ${portfolioState.unrealized_pnl_percent?.toFixed(2) || '0.00'}%\n`;
  userMessage += `Available capital: $${portfolioState.available_capital?.toFixed(2) || '0.00'}\n`;
  if (portfolioState.total_trades > 0) {
    userMessage += `Win rate: ${portfolioState.win_rate?.toFixed(1)}% (${portfolioState.total_trades} trades)\n`;
  }
  if (portfolioState.circuit_breaker_active) {
    userMessage += `\nCIRCUIT BREAKER ACTIVE — ${portfolioState.consecutive_losses} consecutive losses\n`;
  }
  if (portfolioState.market_regime) {
    const mr = portfolioState.market_regime;
    userMessage += `\nMarket Regime: ${mr.regime} (BTC ${mr.btc_trend}, ADX ${mr.btc_adx}, RSI ${mr.btc_rsi}, MACD ${mr.btc_macd})\n`;
    if (mr.regime === 'BEAR') userMessage += `*** BEARISH MARKET — require extra confirmation for BUY signals, prioritize SELL ***\n`;
    else if (mr.regime === 'CAUTIOUS') userMessage += `Caution: BTC showing weakness\n`;
  }
  if (portfolioState.trading_session) {
    userMessage += `Session: ${portfolioState.trading_session.session} — ${portfolioState.trading_session.note}\n`;
  }

  if (learningRules?.length > 0) {
    userMessage += `\n## Dynamic Learning Rules\n`;
    for (const rule of learningRules) {
      userMessage += `- ${rule.rule_text}`;
      if (rule.win_rate) userMessage += ` (${rule.win_rate}% WR, ${rule.sample_size} trades)`;
      userMessage += '\n';
    }
  }
  userMessage += '\n';

  // Per-signal sections
  for (let i = 0; i < items.length; i++) {
    const { haikuSignal, triggeredSignal, newsContext } = items[i];
    userMessage += `--- Signal ${i + 1}: ${triggeredSignal.symbol} ---\n`;
    userMessage += `Haiku: ${haikuSignal.signal} | ${haikuSignal.strength} | conf:${haikuSignal.confidence}\n`;
    userMessage += `Reasons: ${(haikuSignal.reasons || []).join('; ')}\n`;
    if (haikuSignal.concerns?.length) userMessage += `Concerns: ${haikuSignal.concerns.join('; ')}\n`;
    userMessage += formatHaikuInput(triggeredSignal);
    userMessage += `News: ${newsContext || 'No recent news.'}\n\n`;
  }

  try {
    const startTime = Date.now();

    const message = await withRetry(
      () => withTimeout(
        anthropic.messages.create({
          model: SONNET_MODEL,
          max_tokens: Math.min(1024 * items.length, 8192),
          system: (() => {
            const marker = '## LEARNING DATA';
            const markerIdx = systemPrompt.indexOf(marker);
            if (markerIdx > 0) {
              return [
                { type: 'text', text: systemPrompt.substring(0, markerIdx).trimEnd(), cache_control: { type: 'ephemeral' } },
                { type: 'text', text: systemPrompt.substring(markerIdx) },
              ];
            }
            return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
          })(),
          messages: [{ role: 'user', content: userMessage }],
        }),
        API_TIMEOUT_MS * 2, // longer timeout for batch
        `Sonnet batch (${items.length} signals)`
      ),
      { maxAttempts: 3, label: `Sonnet batch (${items.length} signals)` }
    );

    const responseText = message.content?.[0]?.text;
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cacheRead = message.usage.cache_read_input_tokens || 0;
    const duration = Date.now() - startTime;

    apiCostTracker.sonnet_input_tokens += inputTokens;
    apiCostTracker.sonnet_output_tokens += outputTokens;
    apiCostTracker.sonnet_cache_read_tokens += cacheRead;
    apiCostTracker.calls.sonnet++;

    logger.info(`[Sonnet] Batch ${items.length} signals in ${duration}ms | tokens: ${inputTokens}in/${outputTokens}out | cache: ${cacheRead} read`);

    if (!responseText) {
      logger.error(`[Sonnet] Empty batch response`);
      return items.map(({ triggeredSignal }) => ({
        action: 'PASS', symbol: triggeredSignal.symbol, confidence: 0,
        reasoning: 'Empty batch response — auto-PASS', _fallback: true,
      }));
    }

    // Parse response — expect JSON array
    let parsedArray;
    try {
      parsedArray = extractJSON(responseText);
      if (!Array.isArray(parsedArray)) parsedArray = [parsedArray];
    } catch (parseErr) {
      logger.error(`[Sonnet] Batch JSON parse failed: ${parseErr.message}`);
      return items.map(({ triggeredSignal }) => ({
        action: 'PASS', symbol: triggeredSignal.symbol, confidence: 0,
        reasoning: 'Batch parse error — auto-PASS', _fallback: true,
      }));
    }

    // Match results to inputs by symbol name (not positional index)
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const { haikuSignal, triggeredSignal } = items[i];
      const expectedSymbol = triggeredSignal.symbol;

      // Always prefer symbol-name match over positional match
      let parsed = parsedArray.find(p => p.symbol === expectedSymbol);
      if (!parsed && parsedArray[i]) {
        logger.warn(`[Sonnet] No symbol match for ${expectedSymbol} — using positional fallback (got ${parsedArray[i].symbol || 'unknown'})`);
        parsed = parsedArray[i];
      }

      if (!parsed) {
        logger.warn(`[Sonnet] No batch result for ${expectedSymbol} — defaulting to PASS`);
        parsed = { action: 'PASS', symbol: expectedSymbol, confidence: 0, reasoning: 'Missing from batch response' };
      }

      // Ensure symbol field matches expected (guard against Sonnet hallucinating symbols)
      if (parsed.symbol && parsed.symbol !== expectedSymbol) {
        logger.warn(`[Sonnet] Symbol mismatch in batch: expected ${expectedSymbol}, got ${parsed.symbol} — correcting`);
        parsed.symbol = expectedSymbol;
      }

      if (parsed.action === 'PARTIAL_EXIT' && !parsed.position_details?.exit_percent) {
        parsed.position_details = parsed.position_details || {};
        parsed.position_details.exit_percent = 50;
      }

      parsed = enforceConfidenceThresholds(parsed, config);
      const decisionId = await logDecision(haikuSignal.signal_id, parsed, `[batch ${i + 1}/${items.length}]`, inputTokens + outputTokens);

      logger.info(`[Sonnet] ${triggeredSignal.symbol}: ${parsed.action} conf:${parsed.confidence}`);
      logger.info(`[Sonnet] Reasoning: ${(parsed.reasoning || '').substring(0, 150)}...`);

      results.push({ ...parsed, decision_id: decisionId });
    }

    return results;
  } catch (error) {
    logger.error(`[Sonnet] Batch API error: ${error.message}`);
    throw error;
  }
}

/**
 * Call Sonnet for exit evaluation of an open position.
 * Bypasses Haiku — exit scanner's urgency scoring replaces Haiku triage.
 *
 * Returns: { action, symbol, confidence, position_details, reasoning, risk_assessment, alternative_considered, decision_id }
 */
export async function callSonnetExitEval(position, analysis, urgency, newsContext, portfolioState, learningRules, config) {
  const systemPrompt = loadPrompt('prompts/sonnet-exit-eval.md', sonnetExitPromptCache);

  const userMessage = formatExitEvalInput(position, analysis, urgency, newsContext, portfolioState, learningRules);

  try {
    const startTime = Date.now();

    const message = await withRetry(
      () => withTimeout(
        anthropic.messages.create({
          model: SONNET_MODEL,
          max_tokens: 768,
          system: (() => {
            // Split prompt at LEARNING DATA marker for better cache hits
            const marker = '## LEARNING DATA';
            const markerIdx = systemPrompt.indexOf(marker);
            if (markerIdx > 0) {
              return [
                {
                  type: 'text',
                  text: systemPrompt.substring(0, markerIdx).trimEnd(),
                  cache_control: { type: 'ephemeral' },
                },
                {
                  type: 'text',
                  text: systemPrompt.substring(markerIdx),
                },
              ];
            }
            return [{
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            }];
          })(),
          messages: [{ role: 'user', content: userMessage }],
        }),
        API_TIMEOUT_MS,
        `Sonnet exit eval (${position.symbol})`
      ),
      { maxAttempts: 3, label: `Sonnet exit eval (${position.symbol})` }
    );

    const responseText = message.content?.[0]?.text;
    if (!responseText) {
      logger.error(`[Sonnet-Exit] Empty response for ${position.symbol}`);
      return { action: 'HOLD', symbol: position.symbol, confidence: 0,
        reasoning: 'Empty AI response — auto-HOLD', _fallback: true };
    }
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cacheRead = message.usage.cache_read_input_tokens || 0;
    const duration = Date.now() - startTime;

    apiCostTracker.sonnet_input_tokens += inputTokens;
    apiCostTracker.sonnet_output_tokens += outputTokens;
    apiCostTracker.sonnet_cache_read_tokens += cacheRead;
    apiCostTracker.calls.sonnet++;

    logger.info(`[Sonnet-Exit] ${position.symbol} evaluated in ${duration}ms | tokens: ${inputTokens}in/${outputTokens}out | cache: ${cacheRead} read`);

    let parsed;
    try {
      parsed = extractJSON(responseText);
    } catch (parseErr) {
      // For critical urgency (>=70), default to SELL instead of HOLD — the exit scanner
      // already determined this position needs urgent attention
      // Always default to HOLD on parse failure — never auto-sell without AI analysis.
      // Critical urgency positions will be re-evaluated on next exit scan cycle.
      logger.error(`[Sonnet-Exit] JSON parse failed (${parseErr.message}), response: ${responseText.substring(0, 500)}`);
      logger.error(`[Sonnet-Exit] WARNING: Exit eval for ${position.symbol} defaulting to HOLD (urgency: ${urgency?.score || 'unknown'}). Will retry next cycle.`);
      parsed = {
        action: 'HOLD',
        symbol: position.symbol,
        confidence: 0,
        position_details: null,
        reasoning: `Parse error — defaulting to HOLD (urgency ${urgency?.score || 'unknown'}). Will retry next exit scan.`,
        risk_assessment: 'Unable to assess due to parse error',
        alternative_considered: 'N/A',
      };
    }

    // Enforce confidence safety net — check before remapping PARTIAL_EXIT
    parsed = enforceConfidenceThresholds(parsed, config);

    // Preserve original action for logging before remapping
    const originalAction = parsed.action;

    // Map PARTIAL_EXIT to SELL after threshold check (so partial exits use exit threshold, not sell threshold)
    if (parsed.action === 'PARTIAL_EXIT') {
      parsed.action = 'SELL';
      // Ensure exit_percent is preserved (default to 50% for partials, not 100%)
      if (!parsed.position_details?.exit_percent) {
        parsed.position_details = parsed.position_details || {};
        parsed.position_details.exit_percent = 50;
      }
    }

    // Log signal with EXIT_SCANNER trigger
    const signalId = await logExitSignal(position, analysis, urgency);

    // Log decision with original action so learning system sees PARTIAL_EXIT vs SELL accurately
    const decisionId = await logDecision(signalId, { ...parsed, action: originalAction }, userMessage, inputTokens + outputTokens);

    logger.info(`[Sonnet-Exit] ${position.symbol}: ${parsed.action} conf:${parsed.confidence}`);
    logger.info(`[Sonnet-Exit] Reasoning: ${(parsed.reasoning || '').substring(0, 150)}...`);

    return { ...parsed, decision_id: decisionId };

  } catch (error) {
    logger.error('[Sonnet-Exit] API error:', error.message);
    throw error;
  }
}

/**
 * Format exit evaluation input for Sonnet.
 */
function formatExitEvalInput(position, analysis, urgency, newsContext, portfolioState, learningRules) {
  const avgEntry = parseFloat(position.avg_entry_price);
  const currentPrice = analysis.price;
  const holdHours = (Date.now() - new Date(position.entry_time).getTime()) / (1000 * 60 * 60);
  const maxGain = parseFloat(position.max_unrealized_gain_percent || 0);
  const partialExits = position.partial_exits || 0;
  const totalProfitTaken = parseFloat(position.total_profit_taken || 0);

  let msg = `# EXIT EVALUATION REQUEST\n\n`;

  msg += `## Position\n`;
  msg += `Symbol: ${position.symbol} (Tier ${position.tier})\n`;
  msg += `Direction: ${position.direction || 'LONG'}\n`;
  msg += `Entry: $${avgEntry.toFixed(4)} | Current: $${currentPrice.toFixed(4)}\n`;
  msg += `P&L: ${urgency.pnl_percent.toFixed(2)}%\n`;
  msg += `Hold time: ${holdHours.toFixed(1)}h\n`;
  msg += `Size: ${parseFloat(position.current_size).toFixed(6)} | Invested: $${parseFloat(position.total_cost).toFixed(2)}\n`;
  msg += `Peak gain: ${maxGain.toFixed(2)}% | Drawdown from peak: ${urgency.drawdown_from_peak.toFixed(2)}%\n`;
  if (partialExits > 0) {
    msg += `Partial exits: ${partialExits} (profit taken: $${totalProfitTaken.toFixed(2)})\n`;
  }
  msg += '\n';

  msg += `## Exit Scanner Urgency: ${urgency.score} points\n`;
  msg += `Factors:\n`;
  for (const factor of urgency.factors) {
    msg += `- ${factor}\n`;
  }
  msg += '\n';

  msg += `## Technical Indicators\n`;
  msg += formatForClaude(analysis);
  msg += '\n\n';

  msg += `## News Context\n`;
  msg += newsContext || 'No recent news available.\n';
  msg += '\n';

  msg += `## Portfolio State\n`;
  msg += `Open positions: ${portfolioState.open_count}/${portfolioState.max_positions}\n`;
  msg += `Unrealized P&L: ${portfolioState.unrealized_pnl_percent?.toFixed(2) || '0.00'}%\n`;
  msg += `Available capital: $${portfolioState.available_capital?.toFixed(2) || '0.00'}\n`;
  if (portfolioState.total_trades > 0) {
    msg += `Win rate: ${portfolioState.win_rate?.toFixed(1)}% (${portfolioState.total_trades} trades)\n`;
  }

  // Market regime context for exit decisions
  if (portfolioState.market_regime) {
    const mr = portfolioState.market_regime;
    msg += `Market: ${mr.regime} (BTC ${mr.btc_trend}, ADX ${mr.btc_adx}, RSI ${mr.btc_rsi}, MACD ${mr.btc_macd})\n`;
    if (mr.regime === 'BEAR' || mr.regime === 'CAUTIOUS') {
      msg += `Bearish market — lower exit thresholds, cut losses faster\n`;
    }
  }
  msg += '\n';

  // Inject dynamic learning rules (supplements static rules in exit prompt)
  if (learningRules?.length > 0) {
    msg += `## Dynamic Learning Rules (from recent trades)\n`;
    for (const rule of learningRules) {
      msg += `- ${rule.rule_text}`;
      if (rule.win_rate) msg += ` (${rule.win_rate}% WR, ${rule.sample_size} trades)`;
      msg += '\n';
    }
    msg += '\n';
  }

  return msg;
}

/**
 * Log exit scanner signal to the signals table.
 */
async function logExitSignal(position, analysis, urgency) {
  const triggeredBy = ['EXIT_SCANNER', ...urgency.factors.map(f => f.substring(0, 50))];

  const result = await query(`
    INSERT INTO signals (
      symbol, triggered_by, price,
      rsi, macd, macd_signal, macd_histogram,
      sma10, sma30, sma50, sma200, ema9, ema21,
      bb_upper, bb_middle, bb_lower,
      volume_24h, volume_ratio,
      support_nearest, resistance_nearest, trend,
      signal_type, strength, confidence, reasoning, escalated, outcome,
      adx, adx_pdi, adx_mdi, stochrsi_k, stochrsi_d, atr_percent
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
    RETURNING id
  `, [
    position.symbol,
    triggeredBy,
    analysis.price,
    analysis.rsi?.value ?? null,
    analysis.macd?.macd ?? null,
    analysis.macd?.signal ?? null,
    analysis.macd?.histogram ?? null,
    analysis.sma?.sma10 ?? null,
    analysis.sma?.sma30 ?? null,
    analysis.sma?.sma50 ?? null,
    analysis.sma?.sma200 ?? null,
    analysis.ema?.ema9 ?? null,
    analysis.ema?.ema21 ?? null,
    analysis.bollingerBands?.upper ?? null,
    analysis.bollingerBands?.middle ?? null,
    analysis.bollingerBands?.lower ?? null,
    analysis.volume?.current ?? null,
    analysis.volume?.ratio ?? null,
    analysis.support?.[0] ?? null,
    analysis.resistance?.[0] ?? null,
    analysis.trend?.direction ?? null,
    'SELL',
    urgency.score >= 70 ? 'STRONG' : 'MODERATE',
    Math.min(urgency.score / 100, 1.0),
    JSON.stringify(urgency.factors),
    true,
    'PENDING',
    analysis.adx?.value ?? null,
    analysis.adx?.pdi ?? null,
    analysis.adx?.mdi ?? null,
    analysis.stochRsi?.k ?? null,
    analysis.stochRsi?.d ?? null,
    analysis.atr?.percent ?? null,
  ]);

  return result.rows[0].id;
}

/**
 * Format Haiku input using compact formatForClaude from technical-analysis.js.
 * ~4 lines per symbol instead of ~15 lines of raw data = ~75% token savings.
 */
function formatHaikuInput(triggeredSignal) {
  const { symbol, tier, analysis, thresholds_crossed, has_position, position } = triggeredSignal;

  let msg = `${symbol} — Tier ${tier}\n`;
  msg += `Triggered: ${thresholds_crossed.join(', ')}\n\n`;

  // Compact technical data from proven v1 formatter (includes RSI, MACD, SMA200)
  msg += formatForClaude(analysis);
  msg += '\n';

  if (has_position && position) {
    const entryPrice = parseFloat(position.entry_price || position.avg_entry_price);
    const direction = position.direction || 'LONG';
    const pnlPercent = direction === 'SHORT'
      ? ((entryPrice - analysis.price) / entryPrice * 100).toFixed(2)
      : ((analysis.price - entryPrice) / entryPrice * 100).toFixed(2);
    const holdHours = ((Date.now() - new Date(position.entry_time).getTime()) / (1000 * 60 * 60)).toFixed(1);

    msg += `\nEXISTING POSITION:\n`;
    msg += `  Direction: ${direction}\n`;
    msg += `  Entry: ${entryPrice.toFixed(2)} | Current P&L: ${pnlPercent}% | Hold: ${holdHours}h\n`;
    msg += `  Size: ${parseFloat(position.current_size).toFixed(6)} | Invested: $${parseFloat(position.total_cost).toFixed(2)}\n`;
    msg += `  DCAs: ${position.dca_count || 0}\n`;
  } else {
    msg += `\nNO OPEN POSITION — do not escalate SELL signals.\n`;
  }

  if (triggeredSignal.market_regime) {
    const mr = triggeredSignal.market_regime;
    msg += `\nMarket: ${mr.regime} (BTC ${mr.btc_trend}, ADX ${mr.btc_adx}, RSI ${mr.btc_rsi}, MACD ${mr.btc_macd})\n`;
    if (mr.regime === 'BEAR') msg += `*** BEAR MARKET — reduce escalation, prioritize SELL ***\n`;
    else if (mr.regime === 'CAUTIOUS') msg += `Caution: BTC showing weakness\n`;
  }

  return msg;
}

/**
 * Format Sonnet input — includes Haiku's assessment, technicals, news, portfolio, learning
 */
function formatSonnetInput(haikuSignal, triggeredSignal, newsContext, portfolioState, learningRules) {
  let msg = `# SIGNAL EVALUATION REQUEST\n\n`;

  // Haiku's assessment (compact, not full JSON dump)
  msg += `## Haiku's Assessment\n`;
  msg += `Signal: ${haikuSignal.signal} | Strength: ${haikuSignal.strength} | Confidence: ${haikuSignal.confidence}\n`;
  msg += `Reasons: ${(haikuSignal.reasons || []).join('; ')}\n`;
  if (haikuSignal.concerns?.length) {
    msg += `Concerns: ${haikuSignal.concerns.join('; ')}\n`;
  }
  msg += '\n';

  // Technical data (reuse compact Haiku input)
  msg += `## Technical Data\n`;
  msg += formatHaikuInput(triggeredSignal);
  msg += '\n';

  // News
  msg += `## News Context\n`;
  msg += newsContext || 'No recent news available.\n';
  msg += '\n';

  // Portfolio state
  msg += `## Portfolio State\n`;
  msg += `Open positions: ${portfolioState.open_count}/${portfolioState.max_positions}\n`;
  msg += `Unrealized P&L: ${portfolioState.unrealized_pnl_percent?.toFixed(2) || '0.00'}%\n`;
  msg += `Available capital: $${portfolioState.available_capital?.toFixed(2) || '0.00'}\n`;

  if (portfolioState.total_trades > 0) {
    msg += `Win rate: ${portfolioState.win_rate?.toFixed(1)}% (${portfolioState.total_trades} trades)\n`;
  }

  if (portfolioState.circuit_breaker_active) {
    msg += `\nCIRCUIT BREAKER ACTIVE — ${portfolioState.consecutive_losses} consecutive losses\n`;
  }

  // Market regime context
  if (portfolioState.market_regime) {
    const mr = portfolioState.market_regime;
    msg += `\nMarket Regime: ${mr.regime} (BTC ${mr.btc_trend}, ADX ${mr.btc_adx}, RSI ${mr.btc_rsi}, MACD ${mr.btc_macd})\n`;
    if (mr.regime === 'BEAR') {
      msg += `*** BEARISH MARKET — require extra confirmation for BUY signals, prioritize SELL ***\n`;
    } else if (mr.regime === 'CAUTIOUS') {
      msg += `Caution: BTC showing weakness — reduce position sizes, tighten entry criteria\n`;
    }
  }

  // Trading session context
  if (portfolioState.trading_session) {
    msg += `Session: ${portfolioState.trading_session.session} — ${portfolioState.trading_session.note}\n`;
  }
  msg += '\n';

  // Inject dynamic learning rules from DB (supplements static rules in sonnet-decision.md)
  if (learningRules?.length > 0) {
    msg += `## Dynamic Learning Rules (from recent trades)\n`;
    for (const rule of learningRules) {
      msg += `- ${rule.rule_text}`;
      if (rule.win_rate) msg += ` (${rule.win_rate}% WR, ${rule.sample_size} trades)`;
      msg += '\n';
    }
    msg += '\n';
  }

  return msg;
}

/**
 * Enforce confidence safety net — downgrades low-confidence actions
 */
let _confThresholdWarned = false;
function enforceConfidenceThresholds(decision, config) {
  const thresholds = config.confidence_thresholds;
  if (!thresholds) return decision;

  if (!_confThresholdWarned && thresholds.sonnet_minimum_for_dca > thresholds.sonnet_minimum_for_new_entry) {
    logger.warn('[Config] WARNING: DCA confidence threshold exceeds entry threshold — DCA requires MORE confidence than new entries');
    _confThresholdWarned = true;
  }

  if (decision.action === 'BUY' && decision.confidence < thresholds.sonnet_minimum_for_new_entry) {
    logger.warn(`[Sonnet] BUY confidence ${decision.confidence} < ${thresholds.sonnet_minimum_for_new_entry}, downgrading to PASS`);
    decision.action = 'PASS';
    decision.reasoning = (decision.reasoning || '') + ` [Auto-downgraded: confidence below ${thresholds.sonnet_minimum_for_new_entry} threshold]`;
  }

  if (decision.action === 'SHORT' && decision.confidence < thresholds.sonnet_minimum_for_new_entry) {
    logger.warn(`[Sonnet] SHORT confidence ${decision.confidence} < ${thresholds.sonnet_minimum_for_new_entry}, downgrading to PASS`);
    decision.action = 'PASS';
    decision.reasoning = (decision.reasoning || '') + ` [Auto-downgraded: confidence below ${thresholds.sonnet_minimum_for_new_entry} threshold]`;
  }

  if (decision.action === 'SELL' && decision.confidence < thresholds.sonnet_minimum_for_exit) {
    logger.warn(`[Sonnet] SELL confidence ${decision.confidence} < ${thresholds.sonnet_minimum_for_exit}, downgrading to HOLD`);
    decision.action = 'HOLD';
  }

  // PARTIAL_EXIT threshold — configurable, defaults to sonnet_minimum_for_exit
  const partialExitThreshold = thresholds.sonnet_minimum_for_partial_exit ?? thresholds.sonnet_minimum_for_exit ?? 0.55;
  if (decision.action === 'PARTIAL_EXIT' && decision.confidence < partialExitThreshold) {
    logger.warn(`[Sonnet] PARTIAL_EXIT confidence ${decision.confidence} < ${partialExitThreshold}, downgrading to HOLD`);
    decision.action = 'HOLD';
  }

  if (decision.action === 'DCA' && decision.confidence < thresholds.sonnet_minimum_for_dca) {
    logger.warn(`[Sonnet] DCA confidence ${decision.confidence} < ${thresholds.sonnet_minimum_for_dca}, downgrading to HOLD`);
    decision.action = 'HOLD';
  }

  return decision;
}

/**
 * Log Haiku signal to database
 */
async function logSignal(triggeredSignal, haikuResponse, tokensUsed) {
  const analysis = triggeredSignal.analysis;
  const result = await query(`
    INSERT INTO signals (
      symbol, triggered_by, price,
      rsi, macd, macd_signal, macd_histogram,
      sma10, sma30, sma50, sma200, ema9, ema21,
      bb_upper, bb_middle, bb_lower,
      volume_24h, volume_ratio,
      support_nearest, resistance_nearest, trend,
      signal_type, strength, confidence, reasoning, escalated, outcome,
      adx, adx_pdi, adx_mdi, stochrsi_k, stochrsi_d, atr_percent
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
    RETURNING id
  `, [
    triggeredSignal.symbol,
    triggeredSignal.thresholds_crossed,
    analysis.price,
    analysis.rsi?.value ?? null,
    analysis.macd?.macd ?? null,
    analysis.macd?.signal ?? null,
    analysis.macd?.histogram ?? null,
    analysis.sma?.sma10 ?? null,
    analysis.sma?.sma30 ?? null,
    analysis.sma?.sma50 ?? null,
    analysis.sma?.sma200 ?? null,
    analysis.ema?.ema9 ?? null,
    analysis.ema?.ema21 ?? null,
    analysis.bollingerBands?.upper ?? null,
    analysis.bollingerBands?.middle ?? null,
    analysis.bollingerBands?.lower ?? null,
    analysis.volume?.current ?? null,
    analysis.volume?.ratio ?? null,
    analysis.support?.[0] ?? null,
    analysis.resistance?.[0] ?? null,
    analysis.trend?.direction ?? null,
    (() => { const s = String(haikuResponse.signal || '').toUpperCase(); return ['BUY', 'SELL', 'SHORT', 'NONE'].includes(s) ? s : 'NONE'; })(),
    (() => { const s = String(haikuResponse.strength || '').toUpperCase(); return ['STRONG', 'MODERATE', 'WEAK', 'TRAP'].includes(s) ? s : 'WEAK'; })(),
    haikuResponse.confidence || 0,
    JSON.stringify(haikuResponse.reasons || []),
    haikuResponse.escalate || false,
    'PENDING',
    analysis.adx?.value ?? null,
    analysis.adx?.pdi ?? null,
    analysis.adx?.mdi ?? null,
    analysis.stochRsi?.k ?? null,
    analysis.stochRsi?.d ?? null,
    analysis.atr?.percent ?? null,
  ]);

  return result.rows[0].id;
}

/**
 * Log Sonnet decision with full prompt snapshot for future Haiku training
 */
async function logDecision(signalId, sonnetResponse, promptSnapshot, tokensUsed) {
  // Ensure symbol is never NULL — fall back to signal's symbol if Sonnet omits it
  let symbol = sonnetResponse.symbol;
  if (!symbol && signalId) {
    try {
      const sigRow = await query('SELECT symbol FROM signals WHERE id = $1', [signalId]);
      symbol = sigRow.rows[0]?.symbol || null;
    } catch { /* best effort */ }
  }

  // Cap prompt snapshot at 4KB to prevent DB bloat (~50+ decisions/day)
  const cappedSnapshot = promptSnapshot && promptSnapshot.length > 4096
    ? promptSnapshot.substring(0, 4000) + '\n\n[...truncated...]'
    : promptSnapshot;

  const result = await query(`
    INSERT INTO decisions (
      signal_id, symbol, action, confidence, reasoning, risk_assessment,
      alternative_considered, prompt_snapshot, outcome,
      recommended_entry_price, recommended_position_size,
      recommended_exit_price, recommended_exit_percent
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id
  `, [
    signalId,
    symbol,
    sonnetResponse.action,
    sonnetResponse.confidence,
    sonnetResponse.reasoning || '',
    sonnetResponse.risk_assessment || '',
    sonnetResponse.alternative_considered || '',
    cappedSnapshot,
    'PENDING',
    sonnetResponse.position_details?.entry_price ?? null,
    sonnetResponse.position_details?.position_size_coin ?? null,
    sonnetResponse.position_details?.exit_price ?? null,
    sonnetResponse.position_details?.exit_percent ?? null,
  ]);

  return result.rows[0].id;
}

// ── Sonnet Prediction Call ──────────────────────────────────

/**
 * Call Sonnet for a directional prediction (not a trade decision).
 * Uses prompts/sonnet-prediction.md.
 *
 * @param {string} symbol
 * @param {object} analysis - From analyzeSymbol()
 * @param {object} divergenceData - From detectLeadingSignals()
 * @param {object|null} btcCorrelation - BTC correlation data for this symbol
 * @param {object} portfolio - Portfolio state
 * @param {object} config - Trading config
 * @param {object[]} btcLedCandidates - High-beta altcoin candidates (only for BTCUSDT predictions)
 * @returns {Promise<object>} Prediction result
 */
export async function callSonnetPrediction(symbol, analysis, divergenceData, btcCorrelation, portfolio, config, btcLedCandidates = []) {
  const systemPrompt = loadPrompt('prompts/sonnet-prediction.md', sonnetPredictionPromptCache);

  const userParts = [];

  // Symbol + divergence data
  userParts.push(`## Symbol: ${symbol}`);
  userParts.push(`## Divergence Data\n${JSON.stringify(divergenceData, null, 2)}`);

  // Technical analysis
  userParts.push(`## Technical Analysis\n${formatForClaude(analysis)}`);

  // BTC correlation
  if (btcCorrelation) {
    userParts.push(`## BTC Correlation\nPearson r: ${btcCorrelation.pearson_r}, Beta: ${btcCorrelation.beta}, R²: ${btcCorrelation.r_squared}`);
  }

  // Portfolio context (minimal)
  userParts.push(`## Portfolio Context\nOpen positions: ${portfolio.open_count}/${portfolio.max_positions} | Available capital: $${portfolio.available_capital?.toFixed(0) || '?'} | Unrealized P&L: ${portfolio.unrealized_pnl_percent?.toFixed(1) || '?'}%`);

  // BTC-led candidates (only for BTCUSDT)
  if (btcLedCandidates.length > 0) {
    const candidateLines = btcLedCandidates.map(c =>
      `- ${c.symbol}: beta=${c.beta}, ATR=${c.atr_percent}%, vol=${c.volume_ratio}x, score=${c.profit_score}\n  ${formatForClaude(c.analysis)}`
    ).join('\n');
    userParts.push(`## High-Beta Altcoin Candidates for BTC-Led Entry\n${candidateLines}`);
  }

  const userMessage = userParts.join('\n\n');

  const response = await withRetry(async () => {
    return withTimeout(
      anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 1024,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
      }),
      API_TIMEOUT_MS,
      `Sonnet prediction (${symbol})`
    );
  }, { label: `Sonnet prediction (${symbol})` });

  // Track costs
  if (response.usage) {
    apiCostTracker.sonnet_input_tokens += response.usage.input_tokens || 0;
    apiCostTracker.sonnet_output_tokens += response.usage.output_tokens || 0;
    apiCostTracker.sonnet_cache_read_tokens += response.usage.cache_read_input_tokens || 0;
    apiCostTracker.calls.sonnet++;
  }

  const text = response.content?.[0]?.text || '';
  try {
    const parsed = extractJSON(text);
    return {
      prediction: parsed.prediction || 'UP',
      confidence: parseFloat(parsed.confidence) || 0.5,
      timeframe_hours: parseInt(parsed.timeframe_hours) || 24,
      invalidation: parsed.invalidation || '',
      reasoning: parsed.reasoning || '',
      btc_led_candidates: Array.isArray(parsed.btc_led_candidates) ? parsed.btc_led_candidates : [],
    };
  } catch (parseErr) {
    logger.error(`[Claude] Failed to parse Sonnet prediction for ${symbol}: ${parseErr.message}`);
    return {
      prediction: divergenceData.direction === 'BULLISH' ? 'UP' : 'DOWN',
      confidence: 0.50,
      timeframe_hours: 24,
      invalidation: '',
      reasoning: `Parse failure — fallback from divergence direction. Raw: ${text.substring(0, 200)}`,
      btc_led_candidates: [],
    };
  }
}
