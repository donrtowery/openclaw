import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { query } from '../db/connection.js';
import { getOpenPositions, getClosedPositions, getPortfolioSummary } from '../lib/position-manager.js';
import { getPendingEvents, markEventsPosted, getEventStats } from '../lib/events.js';
import { getCurrentPrice } from '../lib/binance.js';
import logger from '../lib/logger.js';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));

const app = express();
app.use(express.json());

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
