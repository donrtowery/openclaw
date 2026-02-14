import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, statSync } from 'fs';
import { query } from '../db/connection.js';
import { formatForClaude } from './technical-analysis.js';
import logger from './logger.js';
import dotenv from 'dotenv';
dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const HAIKU_MODEL = process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001';
export const SONNET_MODEL = process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250929';

export { anthropic };

// Cache loaded prompt text to avoid repeated filesystem reads within the same cycle
let haikuPromptCache = { text: null, mtime: 0 };
let sonnetPromptCache = { text: null, mtime: 0 };
let sonnetExitPromptCache = { text: null, mtime: 0 };

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
  // Strip markdown code fences first
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // Try direct parse first (fast path)
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to bracket extraction
  }

  // Find the first [ or { and match its closing bracket
  const arrayStart = cleaned.indexOf('[');
  const objectStart = cleaned.indexOf('{');

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
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (depth === 0) {
      return JSON.parse(cleaned.substring(start, i + 1));
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

    const message = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512 * triggeredSignals.length,
      system: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const responseText = message.content[0].text;
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cacheRead = message.usage.cache_read_input_tokens || 0;
    const cacheCreation = message.usage.cache_creation_input_tokens || 0;
    const duration = Date.now() - startTime;

    logger.info(`[Haiku] ${triggeredSignals.length} signal(s) evaluated in ${duration}ms | tokens: ${inputTokens}in/${outputTokens}out | cache: ${cacheRead} read, ${cacheCreation} created`);

    // Parse response — could be single object or array
    let parsed;
    try {
      parsed = extractJSON(responseText);
    } catch {
      logger.error(`[Haiku] JSON parse failed, response: ${responseText.substring(0, 500)}`);
      // Return safe fallback for all signals
      return triggeredSignals.map(sig => ({
        symbol: sig.symbol,
        signal: 'NONE',
        strength: 'WEAK',
        escalate: false,
        confidence: 0,
        reasons: ['Haiku response was not valid JSON'],
        concerns: [],
        signal_id: null,
      }));
    }

    // Normalize to array
    const results = Array.isArray(parsed) ? parsed : [parsed];

    // Log each signal to database and attach signal_id
    const output = [];
    for (let i = 0; i < triggeredSignals.length; i++) {
      const sig = triggeredSignals[i];
      const result = results[i] || {
        symbol: sig.symbol, signal: 'NONE', strength: 'WEAK',
        escalate: false, confidence: 0, reasons: ['No response for this signal'], concerns: [],
      };

      const signalId = await logSignal(sig, result, inputTokens + outputTokens);

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

    const message = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 2048,
      system: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const responseText = message.content[0].text;
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cacheRead = message.usage.cache_read_input_tokens || 0;
    const duration = Date.now() - startTime;

    logger.info(`[Sonnet] ${triggeredSignal.symbol} decided in ${duration}ms | tokens: ${inputTokens}in/${outputTokens}out | cache: ${cacheRead} read`);

    let parsed;
    try {
      parsed = extractJSON(responseText);
    } catch {
      logger.error(`[Sonnet] JSON parse failed, response: ${responseText.substring(0, 500)}`);
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

    const message = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1536,
      system: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const responseText = message.content[0].text;
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cacheRead = message.usage.cache_read_input_tokens || 0;
    const duration = Date.now() - startTime;

    logger.info(`[Sonnet-Exit] ${position.symbol} evaluated in ${duration}ms | tokens: ${inputTokens}in/${outputTokens}out | cache: ${cacheRead} read`);

    let parsed;
    try {
      parsed = extractJSON(responseText);
    } catch {
      logger.error(`[Sonnet-Exit] JSON parse failed, response: ${responseText.substring(0, 500)}`);
      parsed = {
        action: 'HOLD',
        symbol: position.symbol,
        confidence: 0,
        position_details: null,
        reasoning: 'Parse error — could not interpret Sonnet response',
        risk_assessment: 'Unable to assess due to parse error',
        alternative_considered: 'N/A',
      };
    }

    // Map PARTIAL_EXIT to SELL with exit_percent for compatibility with enforceConfidenceThresholds
    if (parsed.action === 'PARTIAL_EXIT') {
      parsed.action = 'SELL';
    }

    // Enforce confidence safety net
    parsed = enforceConfidenceThresholds(parsed, config);

    // Log signal with EXIT_SCANNER trigger
    const signalId = await logExitSignal(position, analysis, urgency);

    // Log decision
    const decisionId = await logDecision(signalId, parsed, userMessage, inputTokens + outputTokens);

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
  msg += '\n';
  if (analysis.rsi) msg += `RSI: ${analysis.rsi.value}\n`;
  if (analysis.macd) msg += `MACD histogram: ${analysis.macd.histogram}, crossover: ${analysis.macd.crossover}\n`;
  if (analysis.volume) msg += `Volume ratio: ${analysis.volume.ratio}x, trend: ${analysis.volume.trend}\n`;
  if (analysis.sma?.sma200 != null) msg += `SMA200: ${analysis.sma.sma200}\n`;
  msg += '\n';

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
  msg += '\n';

  if (learningRules?.length > 0) {
    msg += `## Lessons from Past Trades\n`;
    for (const rule of learningRules.slice(0, 5)) {
      msg += `- ${rule.rule_text}`;
      if (rule.win_rate && rule.sample_size) {
        msg += ` (${rule.win_rate}% win rate, ${rule.sample_size} trades)`;
      }
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
      signal_type, strength, confidence, reasoning, escalated, outcome
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
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

  // Compact technical data from proven v1 formatter
  msg += formatForClaude(analysis);
  msg += '\n';

  // Add raw numbers Haiku needs that formatForClaude compresses
  if (analysis.rsi) msg += `RSI: ${analysis.rsi.value}\n`;
  if (analysis.macd) msg += `MACD histogram: ${analysis.macd.histogram}, crossover: ${analysis.macd.crossover}\n`;
  if (analysis.sma?.sma200 != null) msg += `SMA200: ${analysis.sma.sma200}\n`;

  if (has_position && position) {
    const entryPrice = parseFloat(position.entry_price || position.avg_entry_price);
    const pnlPercent = ((analysis.price - entryPrice) / entryPrice * 100).toFixed(2);
    const holdHours = ((Date.now() - new Date(position.entry_time).getTime()) / (1000 * 60 * 60)).toFixed(1);

    msg += `\nEXISTING POSITION:\n`;
    msg += `  Entry: ${entryPrice.toFixed(2)} | Current P&L: ${pnlPercent}% | Hold: ${holdHours}h\n`;
    msg += `  Size: ${parseFloat(position.current_size).toFixed(6)} | Invested: $${parseFloat(position.total_cost).toFixed(2)}\n`;
  } else {
    msg += `\nNO OPEN POSITION — do not escalate SELL signals.\n`;
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
  msg += '\n';

  // Learning rules (top 5, brief)
  if (learningRules?.length > 0) {
    msg += `## Lessons from Past Trades\n`;
    for (const rule of learningRules.slice(0, 5)) {
      msg += `- ${rule.rule_text}`;
      if (rule.win_rate && rule.sample_size) {
        msg += ` (${rule.win_rate}% win rate, ${rule.sample_size} trades)`;
      }
      msg += '\n';
    }
    msg += '\n';
  }

  return msg;
}

/**
 * Enforce confidence safety net — downgrades low-confidence actions
 */
function enforceConfidenceThresholds(decision, config) {
  const thresholds = config.confidence_thresholds;
  if (!thresholds) return decision;

  if (decision.action === 'BUY' && decision.confidence < thresholds.sonnet_minimum_for_new_entry) {
    logger.warn(`[Sonnet] BUY confidence ${decision.confidence} < ${thresholds.sonnet_minimum_for_new_entry}, downgrading to PASS`);
    decision.action = 'PASS';
    decision.reasoning += ` [Auto-downgraded: confidence below ${thresholds.sonnet_minimum_for_new_entry} threshold]`;
  }

  if (decision.action === 'SELL' && decision.confidence < thresholds.sonnet_minimum_for_exit) {
    logger.warn(`[Sonnet] SELL confidence ${decision.confidence} < ${thresholds.sonnet_minimum_for_exit}, downgrading to HOLD`);
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
      signal_type, strength, confidence, reasoning, escalated, outcome
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
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
    haikuResponse.signal || 'NONE',
    haikuResponse.strength || 'WEAK',
    haikuResponse.confidence || 0,
    JSON.stringify(haikuResponse.reasons || []),
    haikuResponse.escalate || false,
    'PENDING',
  ]);

  return result.rows[0].id;
}

/**
 * Log Sonnet decision with full prompt snapshot for future Haiku training
 */
async function logDecision(signalId, sonnetResponse, promptSnapshot, tokensUsed) {
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
    sonnetResponse.symbol,
    sonnetResponse.action,
    sonnetResponse.confidence,
    sonnetResponse.reasoning || '',
    sonnetResponse.risk_assessment || '',
    sonnetResponse.alternative_considered || '',
    promptSnapshot,
    'PENDING',
    sonnetResponse.position_details?.entry_price ?? null,
    sonnetResponse.position_details?.position_size_coin ?? null,
    sonnetResponse.position_details?.exit_price ?? null,
    sonnetResponse.position_details?.exit_percent ?? null,
  ]);

  return result.rows[0].id;
}
