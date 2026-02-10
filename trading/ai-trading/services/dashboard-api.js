import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

import express from 'express';
import logger from '../lib/logger.js';
import { query } from '../db/connection.js';
import pool from '../db/connection.js';
import { getPrice, getCachedPrice } from '../lib/binance.js';
import { getPendingEvents, markEventsPosted, getEventStats } from '../lib/events.js';

const app = express();
app.use(express.json());

const API_KEY = process.env.DASHBOARD_API_KEY || '';
const PORT = parseInt(process.env.DASHBOARD_API_PORT || '3000');

// ── Rate limiting (simple in-memory) ───────────────────────

const rateLimiter = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimiter.get(ip);

  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    rateLimiter.set(ip, { windowStart: now, count: 1 });
    return true;
  }

  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// ── Middleware ──────────────────────────────────────────────

app.use((req, res, next) => {
  if (!checkRateLimit(req.ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded (60/min)' });
  }

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  next();
});

// ── Handlers ───────────────────────────────────────────────

async function getPositions() {
  const result = await query(
    `SELECT p.*, s.tier FROM positions p
     JOIN symbols s ON s.symbol = p.symbol
     WHERE p.status = 'OPEN' ORDER BY p.opened_at`
  );

  const positions = [];
  for (const row of result.rows) {
    const entry = parseFloat(row.avg_entry_price);
    let currentPrice = getCachedPrice(row.symbol)?.price;
    if (!currentPrice) {
      try { currentPrice = await getPrice(row.symbol); } catch { currentPrice = entry; }
    }
    const pnlPct = ((currentPrice - entry) / entry * 100);
    const pnlUsd = (currentPrice - entry) * parseFloat(row.remaining_qty);

    positions.push({
      id: row.id,
      symbol: row.symbol,
      tier: row.tier,
      entryPrice: entry,
      currentPrice,
      quantity: parseFloat(row.remaining_qty),
      amount: parseFloat(row.amount),
      pnlPercent: Math.round(pnlPct * 100) / 100,
      pnlUsd: Math.round(pnlUsd * 100) / 100,
      dcaLevel: row.dca_level,
      stopLoss: parseFloat(row.stop_loss_price),
      tp1Hit: row.tp1_hit,
      tp2Hit: row.tp2_hit,
      tp3Hit: row.tp3_hit,
      openedAt: row.opened_at,
    });
  }
  return positions;
}

async function getBtcPrice() {
  let price = getCachedPrice('BTCUSDT');
  if (!price) {
    const p = await getPrice('BTCUSDT');
    price = { price: p, priceChangePercent: 0 };
  }
  return {
    price: price.price,
    change24hPercent: price.priceChangePercent || 0,
    updatedAt: price.updatedAt || Date.now(),
  };
}

async function getLastSignal() {
  const result = await query(
    `SELECT * FROM ai_analyses ORDER BY created_at DESC LIMIT 1`
  );
  if (result.rows.length === 0) return { message: 'No analyses yet' };
  const row = result.rows[0];
  return {
    checkType: row.check_type,
    decision: row.decision,
    reasoning: row.reasoning,
    tokens: (row.tokens_input || 0) + (row.tokens_output || 0),
    cost: parseFloat(row.cost_usd || 0),
    createdAt: row.created_at,
  };
}

async function getWeekPnl() {
  const result = await query(
    `SELECT
       COUNT(*)::int AS total_trades,
       COUNT(CASE WHEN realized_pnl > 0 THEN 1 END)::int AS wins,
       COUNT(CASE WHEN realized_pnl < 0 THEN 1 END)::int AS losses,
       COALESCE(SUM(realized_pnl), 0)::numeric(12,2) AS total_pnl,
       COALESCE(AVG(realized_pnl), 0)::numeric(12,2) AS avg_pnl
     FROM positions
     WHERE status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '7 days'`
  );
  const row = result.rows[0];
  return {
    period: '7 days',
    totalTrades: row.total_trades,
    wins: row.wins,
    losses: row.losses,
    winRate: row.total_trades > 0 ? Math.round((row.wins / row.total_trades) * 100) : 0,
    totalPnl: parseFloat(row.total_pnl),
    avgPnl: parseFloat(row.avg_pnl),
  };
}

async function getPortfolioSummary() {
  // Open positions
  const openResult = await query(
    `SELECT COUNT(*)::int AS open_count FROM positions WHERE status = 'OPEN'`
  );

  // All-time stats
  const statsResult = await query(
    `SELECT
       COUNT(*)::int AS total_closed,
       COUNT(CASE WHEN realized_pnl > 0 THEN 1 END)::int AS wins,
       COALESCE(SUM(realized_pnl), 0)::numeric(12,2) AS total_pnl
     FROM positions WHERE status = 'CLOSED'`
  );

  // Circuit breaker
  const cbResult = await query('SELECT * FROM circuit_breaker WHERE id = 1');

  // AI costs
  const costResult = await query(
    `SELECT COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS total_cost,
            COUNT(*)::int AS total_calls
     FROM ai_analyses`
  );

  const stats = statsResult.rows[0];
  const cb = cbResult.rows[0];
  const costs = costResult.rows[0];

  return {
    openPositions: openResult.rows[0].open_count,
    maxPositions: 5,
    totalClosed: stats.total_closed,
    wins: stats.wins,
    winRate: stats.total_closed > 0 ? Math.round((stats.wins / stats.total_closed) * 100) : 0,
    totalPnl: parseFloat(stats.total_pnl),
    circuitBreaker: {
      consecutiveLosses: cb.consecutive_losses,
      isPaused: cb.is_paused,
      resumeAt: cb.resume_at,
    },
    aiCosts: {
      totalCalls: costs.total_calls,
      totalCost: parseFloat(costs.total_cost),
    },
  };
}

// ── Event handlers ────────────────────────────────────────

async function getEvents() {
  const events = await getPendingEvents(50);
  return { events, count: events.length };
}

async function handleMarkEventsPosted(body) {
  const ids = body?.eventIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'eventIds array required' };
  }
  const marked = await markEventsPosted(ids);
  return { marked };
}

async function handleGetEventStats() {
  return getEventStats();
}

// ── Route ──────────────────────────────────────────────────

const handlers = {
  get_positions: getPositions,
  get_btc_price: getBtcPrice,
  get_last_signal: getLastSignal,
  get_week_pnl: getWeekPnl,
  get_portfolio_summary: getPortfolioSummary,
  get_events: getEvents,
  mark_events_posted: handleMarkEventsPosted,
  get_event_stats: handleGetEventStats,
};

app.post('/api/dashboard', async (req, res) => {
  const { action } = req.body;

  if (!action || !handlers[action]) {
    return res.status(400).json({
      error: 'Invalid action',
      validActions: Object.keys(handlers),
    });
  }

  try {
    const result = await handlers[action](req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`Dashboard ${action} failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Start ──────────────────────────────────────────────────

const BIND_HOST = process.env.DASHBOARD_BIND_HOST || '0.0.0.0';

const server = app.listen(PORT, BIND_HOST, () => {
  logger.info(`Dashboard API listening on ${BIND_HOST}:${PORT}`);
});

function shutdown() {
  logger.info('Dashboard API shutting down...');
  server.close();
  pool.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
