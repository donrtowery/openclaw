import { query } from '../db/connection.js';
import logger from './logger.js';

/*
 * Event data examples:
 *
 * BUY:  { price, quantity, position_size, confidence, reasoning, tier, haiku_strength, position_id }
 * SELL: { price, entry_price, pnl, pnl_percent, hold_hours, reasoning, trade_type }
 * DCA:  { price, quantity, cost, new_avg_entry, total_invested, confidence, reasoning }
 * CIRCUIT_BREAKER: { consecutive_losses, last_loss_symbol, last_loss_pnl, cooldown_hours }
 * HOURLY_SUMMARY:  { open_positions, unrealized_pnl, realized_pnl, win_rate, total_trades }
 * SYSTEM: { type, message }
 */

/**
 * Queue a trade event for Discord consumption.
 * Returns the event ID.
 */
export async function queueEvent(eventType, symbol, data) {
  const result = await query(`
    INSERT INTO trade_events (event_type, symbol, metadata, posted_to_discord, created_at)
    VALUES ($1, $2, $3, false, NOW())
    RETURNING id
  `, [eventType, symbol, JSON.stringify(data)]);

  const eventId = result.rows[0].id;
  logger.info(`[Events] Queued ${eventType}${symbol ? ` ${symbol}` : ''} (event #${eventId})`);
  return eventId;
}

/**
 * Get pending (unposted) events for Discord bot to consume.
 */
export async function getPendingEvents(limit = 50) {
  const result = await query(`
    SELECT * FROM trade_events
    WHERE posted_to_discord = false
    ORDER BY created_at ASC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

/**
 * Mark events as posted after Discord bot processes them.
 */
export async function markEventsPosted(eventIds) {
  if (!eventIds || eventIds.length === 0) return 0;

  const result = await query(`
    UPDATE trade_events
    SET posted_to_discord = true, posted_at = NOW()
    WHERE id = ANY($1) AND posted_to_discord = false
  `, [eventIds]);

  const count = result.rowCount;
  logger.info(`[Events] Marked ${count} event(s) as posted`);
  return count;
}

/**
 * Get event queue statistics.
 */
export async function getEventStats() {
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE posted_to_discord = false) AS pending,
      COUNT(*) FILTER (WHERE posted_to_discord = true AND posted_at >= CURRENT_DATE) AS posted_today,
      COUNT(*) FILTER (WHERE posted_to_discord = true) AS posted_total
    FROM trade_events
  `);
  const row = result.rows[0];
  return {
    pending: parseInt(row.pending) || 0,
    posted_today: parseInt(row.posted_today) || 0,
    posted_total: parseInt(row.posted_total) || 0,
  };
}

/**
 * Delete old posted events to prevent table bloat.
 */
export async function cleanOldEvents(daysToKeep = 30) {
  const result = await query(`
    DELETE FROM trade_events
    WHERE posted_to_discord = true AND created_at < NOW() - INTERVAL '1 day' * $1
  `, [daysToKeep]);

  if (result.rowCount > 0) {
    logger.info(`[Events] Cleaned ${result.rowCount} old event(s) (>${daysToKeep} days)`);
  }
  return result.rowCount;
}
