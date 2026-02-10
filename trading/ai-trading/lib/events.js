import { query } from '../db/connection.js';
import logger from './logger.js';

/**
 * Queue a trade event for the Ollama bot to consume.
 * @param {string} eventType - BUY, SELL, CLOSE, DCA, TAKE_PROFIT, CIRCUIT_BREAKER, HOURLY_SUMMARY, DEEP_CHECK_SUMMARY, ALERT, SYSTEM
 * @param {string|null} symbol - Trading pair or null for system events
 * @param {object} data - Event payload (stored as JSONB)
 * @returns {Promise<number>} Inserted event ID
 */
export async function queueEvent(eventType, symbol, data) {
  try {
    const result = await query(
      `INSERT INTO trade_events (event_type, symbol, data)
       VALUES ($1, $2, $3) RETURNING id`,
      [eventType, symbol, JSON.stringify(data)]
    );
    const id = result.rows[0].id;
    logger.info(`Event queued: #${id} ${eventType}${symbol ? ' ' + symbol : ''}`);
    return id;
  } catch (err) {
    logger.error(`Failed to queue event ${eventType}: ${err.message}`);
    return null;
  }
}

/**
 * Get pending (unposted) events, oldest first.
 * @param {number} limit - Max events to return (default 50)
 * @returns {Promise<object[]>}
 */
export async function getPendingEvents(limit = 50) {
  const result = await query(
    `SELECT id, event_type, symbol, data, created_at
     FROM trade_events
     WHERE posted = false
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Mark events as posted by the Ollama bot.
 * @param {number[]} eventIds - Array of event IDs to mark
 * @returns {Promise<number>} Number of rows updated
 */
export async function markEventsPosted(eventIds) {
  if (!eventIds || eventIds.length === 0) return 0;
  const result = await query(
    `UPDATE trade_events
     SET posted = true, posted_at = NOW()
     WHERE id = ANY($1) AND posted = false`,
    [eventIds]
  );
  logger.info(`Marked ${result.rowCount} events as posted`);
  return result.rowCount;
}

/**
 * Delete old posted events to prevent table bloat.
 * @param {number} daysToKeep - Delete posted events older than this (default 7)
 * @returns {Promise<number>} Number of rows deleted
 */
export async function cleanOldEvents(daysToKeep = 7) {
  const result = await query(
    `DELETE FROM trade_events
     WHERE posted = true AND created_at < NOW() - INTERVAL '1 day' * $1`,
    [daysToKeep]
  );
  if (result.rowCount > 0) {
    logger.info(`Cleaned ${result.rowCount} old events (>${daysToKeep} days)`);
  }
  return result.rowCount;
}

/**
 * Get event statistics for monitoring.
 * @returns {Promise<object>}
 */
export async function getEventStats() {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today_total,
       COUNT(*) FILTER (WHERE posted = false)::int AS pending,
       COUNT(*) FILTER (WHERE posted = true AND created_at >= CURRENT_DATE)::int AS today_posted
     FROM trade_events`
  );
  return result.rows[0];
}
