import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync } from 'fs';
import { query } from '../db/connection.js';
import { getOpenPositions, getClosedPositions, getPortfolioSummary, closePosition, getPositionBySymbol } from '../lib/position-manager.js';
import { getPendingEvents, markEventsPosted, getEventStats, queueEvent } from '../lib/events.js';
import { getCurrentPrice, placeOrder } from '../lib/binance.js';
import { getNewsContext } from '../lib/brave-search.js';
import { anthropic, SONNET_MODEL, HAIKU_MODEL, extractJSON } from '../lib/claude.js';
import { analyzeSymbol, formatForClaude } from '../lib/technical-analysis.js';
import logger from '../lib/logger.js';

const execAsync = promisify(exec);

// Cache the exit-eval prompt for analyze_position (same prompt the exit scanner uses)
let analyzePromptCache = null;
function getAnalyzeSystemPrompt() {
  if (!analyzePromptCache) {
    analyzePromptCache = readFileSync('prompts/sonnet-exit-eval.md', 'utf8');
  }
  return analyzePromptCache;
}

let config = JSON.parse(readFileSync('config/trading.json', 'utf8'));

const app = express();
app.use(express.json());

// ── CORS ─────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.DASHBOARD_API_PORT || 3000;
const HOST = process.env.DASHBOARD_API_HOST || '0.0.0.0';
const API_KEY = process.env.DASHBOARD_API_KEY;

// ── Health check (no auth) ──────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── Auth middleware ──────────────────────────────────────────

function authenticate(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Main dashboard endpoint ─────────────────────────────────

app.post('/api/dashboard', authenticate, async (req, res) => {
  const { action, ...params } = req.body;

  if (!action) {
    return res.status(400).json({ error: 'Missing action field' });
  }

  try {
    const result = await handleAction(action, params);
    res.json(result);
  } catch (error) {
    logger.error(`[API] Error handling ${action}: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ── Action router ───────────────────────────────────────────

async function handleAction(action, params) {
  switch (action) {
    case 'get_portfolio_summary': {
      const data = await getPortfolioSummary(config);
      return { data };
    }

    case 'get_positions': {
      const positions = await getOpenPositions();
      const enriched = [];
      for (const pos of positions) {
        try {
          const currentPrice = await getCurrentPrice(pos.symbol);
          const avgEntry = parseFloat(pos.avg_entry_price);
          const pnlPercent = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry * 100) : 0;
          enriched.push({
            ...pos,
            live_price: currentPrice,
            live_pnl_percent: parseFloat(pnlPercent.toFixed(2)),
          });
        } catch {
          enriched.push(pos);
        }
      }
      return { data: enriched };
    }

    case 'get_closed_trades': {
      const limit = params.limit || 20;
      const data = await getClosedPositions(limit);
      return { data };
    }

    case 'get_signals': {
      const limit = params.limit || 20;
      const result = await query(
        'SELECT * FROM signals ORDER BY created_at DESC LIMIT $1',
        [limit]
      );
      return { data: result.rows };
    }

    case 'get_decisions': {
      const limit = params.limit || 20;
      // Exclude prompt_snapshot to save bandwidth — it's huge
      const result = await query(`
        SELECT id, signal_id, symbol, action, confidence, reasoning, risk_assessment,
               alternative_considered, executed, execution_notes, outcome, outcome_pnl,
               recommended_entry_price, recommended_position_size,
               recommended_exit_price, recommended_exit_percent, created_at
        FROM decisions ORDER BY created_at DESC LIMIT $1
      `, [limit]);
      return { data: result.rows };
    }

    case 'get_events': {
      const data = await getPendingEvents(params.limit);
      return { data };
    }

    case 'mark_events_posted': {
      const { eventIds } = params;
      if (!Array.isArray(eventIds) || eventIds.length === 0) {
        return { error: 'eventIds must be a non-empty array' };
      }
      const count = await markEventsPosted(eventIds);
      return { success: true, marked: count };
    }

    case 'get_event_stats': {
      const data = await getEventStats();
      return { data };
    }

    case 'get_learning_stats': {
      const rulesResult = await query(
        'SELECT * FROM learning_rules WHERE is_active = true ORDER BY win_rate DESC NULLS LAST'
      );
      const statsResult = await query(`
        SELECT COUNT(*) as total,
               COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as wins,
               COALESCE(SUM(realized_pnl), 0) as total_pnl
        FROM positions WHERE status = 'CLOSED'
      `);
      const stats = statsResult.rows[0];
      const total = parseInt(stats.total) || 0;
      const wins = parseInt(stats.wins) || 0;
      return {
        data: {
          rules: rulesResult.rows,
          overall_win_rate: total > 0 ? parseFloat((wins / total * 100).toFixed(1)) : 0,
          total_trades: total,
          total_pnl: parseFloat(stats.total_pnl) || 0,
        },
      };
    }

    // ── Engine Status & Recent Actions ────────────────────────

    case 'get_engine_status': {
      try {
        const { stdout } = await execAsync('systemctl is-active openclaw-engine');
        return { data: { status: stdout.trim() === 'active' ? 'running' : 'stopped' } };
      } catch {
        return { data: { status: 'stopped' } };
      }
    }

    case 'get_recent_actions': {
      const limit = params.limit || 20;
      const result = await query(`
        SELECT id, event_type, symbol, metadata, created_at
        FROM trade_events
        WHERE event_type IN ('BUY', 'SELL', 'PARTIAL_EXIT', 'DCA', 'EXIT_SCANNER_ACTION', 'SYSTEM', 'CIRCUIT_BREAKER')
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit]);
      return {
        data: result.rows.map(e => ({
          id: e.id,
          action: e.event_type,
          symbol: e.symbol,
          details: e.metadata,
          timestamp: e.created_at,
        })),
      };
    }

    case 'ai_chat': {
      const { question } = params;
      if (!question || typeof question !== 'string') {
        return { error: 'question is required' };
      }

      const portfolio = await getPortfolioSummary(config);
      const positions = await getOpenPositions();
      const recentTrades = await query(
        `SELECT symbol, realized_pnl, realized_pnl_percent, exit_time
         FROM positions WHERE status = 'CLOSED' ORDER BY exit_time DESC LIMIT 5`
      );

      // Compact formatting instead of raw JSON.stringify
      let userMsg = `${question}\n\n## Portfolio\n`;
      userMsg += `Capital: $${portfolio.available_capital.toFixed(0)} avail / $${(portfolio.total_invested + portfolio.available_capital).toFixed(0)} total\n`;
      userMsg += `Positions: ${portfolio.open_count}/${portfolio.max_positions} | Unrealized: ${portfolio.unrealized_pnl_percent?.toFixed(2) || 0}%\n`;
      userMsg += `Realized: $${portfolio.realized_pnl?.toFixed(2)} | Today: $${portfolio.today_pnl?.toFixed(2)} | Win rate: ${portfolio.win_rate?.toFixed(1)}% (${portfolio.total_trades} trades)\n`;

      if (positions.length > 0) {
        userMsg += `\n## Open Positions\n`;
        for (const p of positions) {
          const entry = parseFloat(p.avg_entry_price);
          const pnl = p.live_pnl_percent != null ? p.live_pnl_percent : 0;
          userMsg += `${p.symbol} T${p.tier}: entry $${entry.toFixed(4)} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% | $${parseFloat(p.total_cost).toFixed(0)} invested\n`;
        }
      }

      if (recentTrades.rows.length > 0) {
        userMsg += `\n## Recent Closed\n`;
        for (const t of recentTrades.rows) {
          userMsg += `${t.symbol}: ${parseFloat(t.realized_pnl) >= 0 ? '+' : ''}$${parseFloat(t.realized_pnl).toFixed(2)} (${parseFloat(t.realized_pnl_percent).toFixed(2)}%)\n`;
        }
      }

      const message = await anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 512,
        system: [{
          type: 'text',
          text: 'You are OpenClaw, an AI crypto trading assistant. Answer concisely (2-3 paragraphs max) based on the portfolio data provided. Be direct and actionable.',
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: userMsg }],
      });

      return { data: { answer: message.content[0].text } };
    }

    // ── Exit Scanner Status ───────────────────────────────────

    case 'get_exit_scanner_status': {
      const recentExitSignals = await query(`
        SELECT s.id, s.symbol, s.price, s.confidence, s.reasoning, s.created_at,
               d.action, d.confidence as decision_confidence, d.reasoning as decision_reasoning, d.executed
        FROM signals s
        LEFT JOIN decisions d ON d.signal_id = s.id
        WHERE 'EXIT_SCANNER' = ANY(s.triggered_by)
        ORDER BY s.created_at DESC
        LIMIT $1
      `, [params.limit || 20]);

      return {
        data: {
          config: config.exit_scanner || {},
          recent_evaluations: recentExitSignals.rows,
        },
      };
    }

    // ── Mobile Emergency Controls ──────────────────────────────

    case 'pause_trading': {
      await execAsync('sudo systemctl stop openclaw-engine');
      await queueEvent('SYSTEM', null, { type: 'pause_trading', message: 'Trading engine stopped via mobile dashboard' });
      logger.info('[API] Trading engine stopped via mobile dashboard');
      return { success: true, message: 'Trading engine stopped' };
    }

    case 'resume_trading': {
      await execAsync('sudo systemctl start openclaw-engine');
      await queueEvent('SYSTEM', null, { type: 'resume_trading', message: 'Trading engine started via mobile dashboard' });
      logger.info('[API] Trading engine started via mobile dashboard');
      return { success: true, message: 'Trading engine started' };
    }

    case 'close_position': {
      const { position_id, reason } = params;
      if (!position_id) return { error: 'position_id is required' };
      if (!reason || typeof reason !== 'string' || reason.length < 10) {
        return { error: 'reason is required (min 10 characters)' };
      }

      const posResult = await query('SELECT * FROM positions WHERE id = $1 AND status = $2', [position_id, 'OPEN']);
      if (posResult.rows.length === 0) return { error: `No open position with id ${position_id}` };
      const position = posResult.rows[0];

      const currentPrice = await getCurrentPrice(position.symbol);
      const exitSize = parseFloat(position.current_size);
      const order = await placeOrder(position.symbol, 'SELL', exitSize);
      const fillPrice = order.price;

      const closeResult = await closePosition(
        position.id, fillPrice, 100,
        reason, 1.0, null,
        config.account.paper_trading
      );

      await queueEvent('SELL', position.symbol, {
        position_id: position.id,
        price: fillPrice,
        exit_percent: 100,
        pnl: closeResult.pnl,
        pnl_percent: closeResult.pnlPercent,
        reasoning: `[Mobile] ${reason}`,
      });

      return {
        success: true,
        symbol: position.symbol,
        fill_price: fillPrice,
        pnl: parseFloat(closeResult.pnl.toFixed(2)),
        pnl_percent: parseFloat(closeResult.pnlPercent.toFixed(2)),
      };
    }

    case 'close_all_positions': {
      const { reason } = params;
      if (!reason || typeof reason !== 'string' || reason.length < 10) {
        return { error: 'reason is required (min 10 characters)' };
      }

      const positions = await getOpenPositions();
      if (positions.length === 0) return { error: 'No open positions to close' };

      let totalPnl = 0;
      const results = [];

      for (const position of positions) {
        try {
          const currentPrice = await getCurrentPrice(position.symbol);
          const exitSize = parseFloat(position.current_size);
          const order = await placeOrder(position.symbol, 'SELL', exitSize);
          const fillPrice = order.price;

          const closeResult = await closePosition(
            position.id, fillPrice, 100,
            reason, 1.0, null,
            config.account.paper_trading
          );

          totalPnl += closeResult.pnl;
          results.push({ symbol: position.symbol, pnl: closeResult.pnl, pnl_percent: closeResult.pnlPercent });

          await queueEvent('SELL', position.symbol, {
            position_id: position.id,
            price: fillPrice,
            exit_percent: 100,
            pnl: closeResult.pnl,
            pnl_percent: closeResult.pnlPercent,
            reasoning: `[Mobile] ${reason}`,
          });
        } catch (err) {
          logger.error(`[API] Failed to close ${position.symbol}: ${err.message}`);
          results.push({ symbol: position.symbol, error: err.message });
        }
      }

      await queueEvent('SYSTEM', null, {
        type: 'close_all_positions',
        message: `Closed ${results.filter(r => !r.error).length}/${positions.length} positions via mobile`,
        total_pnl: totalPnl,
        reason,
      });

      return {
        success: true,
        closed: results.filter(r => !r.error).length,
        total: positions.length,
        total_pnl: parseFloat(totalPnl.toFixed(2)),
        results,
      };
    }

    case 'analyze_position': {
      const { symbol } = params;
      if (!symbol) return { error: 'symbol is required' };

      const position = await getPositionBySymbol(symbol);
      if (!position) return { error: `No open position for ${symbol}` };

      // Get coin name for news search
      const symResult = await query('SELECT name FROM symbols WHERE symbol = $1', [symbol]);
      const coinName = symResult.rows[0]?.name || symbol.replace('USDT', '');

      // Fetch fresh live indicators + news in parallel
      const [liveAnalysis, newsContext] = await Promise.all([
        analyzeSymbol(symbol),
        getNewsContext(symbol, coinName),
      ]);

      const avgEntry = parseFloat(position.avg_entry_price);
      const currentPrice = liveAnalysis.price;
      const pnlPercent = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry * 100) : 0;
      const holdHours = ((Date.now() - new Date(position.entry_time).getTime()) / (1000 * 60 * 60));
      const maxGain = parseFloat(position.max_unrealized_gain_percent || 0);

      // Compact prompt using formatForClaude (same format as exit scanner)
      let analysisPrompt = `## Position\n`;
      analysisPrompt += `Symbol: ${symbol} (Tier ${position.tier})\n`;
      analysisPrompt += `Entry: $${avgEntry.toFixed(4)} | Current: $${currentPrice.toFixed(4)}\n`;
      analysisPrompt += `P&L: ${pnlPercent.toFixed(2)}% | Hold time: ${holdHours.toFixed(1)}h\n`;
      analysisPrompt += `Size: ${parseFloat(position.current_size).toFixed(6)} | Invested: $${parseFloat(position.total_cost).toFixed(2)}\n`;
      analysisPrompt += `Peak gain: ${maxGain.toFixed(2)}% | Drawdown from peak: ${(maxGain - pnlPercent).toFixed(2)}%\n\n`;
      analysisPrompt += `## Technical Indicators\n`;
      analysisPrompt += formatForClaude(liveAnalysis);
      if (liveAnalysis.rsi) analysisPrompt += `\nRSI: ${liveAnalysis.rsi.value}`;
      if (liveAnalysis.macd) analysisPrompt += `\nMACD histogram: ${liveAnalysis.macd.histogram}, crossover: ${liveAnalysis.macd.crossover}`;
      if (liveAnalysis.volume) analysisPrompt += `\nVolume ratio: ${liveAnalysis.volume.ratio}x`;
      analysisPrompt += `\n\n## News\n${newsContext}\n\n`;
      analysisPrompt += `Respond in JSON: { "recommendation": "HOLD"|"SELL"|"DCA", "confidence": 0.0-1.0, "reasoning": "...", "key_levels": { "support": number, "resistance": number }, "risk_factors": ["..."] }`;

      // Use the exit-eval system prompt (same one used by exit scanner — benefits from shared cache)
      const message = await anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 768,
        system: [{
          type: 'text',
          text: getAnalyzeSystemPrompt(),
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: analysisPrompt }],
      });

      const analysis = extractJSON(message.content[0].text);

      return {
        data: {
          symbol,
          current_price: currentPrice,
          pnl_percent: parseFloat(pnlPercent.toFixed(2)),
          hold_hours: parseFloat(holdHours.toFixed(1)),
          ...analysis,
        },
      };
    }

    case 'update_settings': {
      const { settings } = params;
      if (!settings || typeof settings !== 'object') return { error: 'settings object is required' };

      // Re-read config fresh to avoid stale data
      const freshConfig = JSON.parse(readFileSync('config/trading.json', 'utf8'));

      if (settings.max_positions !== undefined) {
        const val = parseInt(settings.max_positions);
        if (isNaN(val) || val < 1 || val > 20) return { error: 'max_positions must be between 1 and 20' };
        freshConfig.account.max_concurrent_positions = val;
      }

      if (settings.paper_trading !== undefined) {
        if (typeof settings.paper_trading !== 'boolean') return { error: 'paper_trading must be a boolean' };
        freshConfig.account.paper_trading = settings.paper_trading;
      }

      if (settings.tier_1_base !== undefined) {
        const val = parseFloat(settings.tier_1_base);
        if (isNaN(val) || val < 50 || val > 5000) return { error: 'tier_1_base must be between 50 and 5000' };
        freshConfig.position_sizing.tier_1.base_position_usd = val;
      }

      if (settings.tier_2_base !== undefined) {
        const val = parseFloat(settings.tier_2_base);
        if (isNaN(val) || val < 50 || val > 5000) return { error: 'tier_2_base must be between 50 and 5000' };
        freshConfig.position_sizing.tier_2.base_position_usd = val;
      }

      if (settings.tier_3_base !== undefined) {
        const val = parseFloat(settings.tier_3_base);
        if (isNaN(val) || val < 50 || val > 5000) return { error: 'tier_3_base must be between 50 and 5000' };
        freshConfig.position_sizing.tier_3.base_position_usd = val;
      }

      if (settings.scanner_interval !== undefined) {
        const val = parseInt(settings.scanner_interval);
        if (isNaN(val) || val < 1 || val > 60) return { error: 'scanner_interval must be between 1 and 60 minutes' };
        freshConfig.scanner.interval_minutes = val;
      }

      writeFileSync('config/trading.json', JSON.stringify(freshConfig, null, 2) + '\n');
      config = freshConfig;

      await queueEvent('SYSTEM', null, {
        type: 'update_settings',
        message: 'Settings updated via mobile dashboard',
        changes: settings,
      });

      logger.info(`[API] Settings updated: ${JSON.stringify(settings)}`);

      return {
        success: true,
        settings: {
          max_positions: freshConfig.account.max_concurrent_positions,
          paper_trading: freshConfig.account.paper_trading,
          tier_1_base: freshConfig.position_sizing.tier_1.base_position_usd,
          tier_2_base: freshConfig.position_sizing.tier_2.base_position_usd,
          tier_3_base: freshConfig.position_sizing.tier_3.base_position_usd,
          scanner_interval: freshConfig.scanner.interval_minutes,
        },
      };
    }

    default:
      return { error: `Unknown action: ${action}` };
  }
}

// ── Error handler ───────────────────────────────────────────

app.use((err, _req, res, _next) => {
  logger.error(`[API] Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ───────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  logger.info(`[API] Dashboard API running on ${HOST}:${PORT}`);
});
