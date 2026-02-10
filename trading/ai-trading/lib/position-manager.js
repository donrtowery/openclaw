import { query, getClient } from '../db/connection.js';
import {
  getTierForSymbol,
  calculateStopLoss,
  calculateTakeProfits,
  recordLoss,
  recordWin,
} from './risk-manager.js';
import { createRequire } from 'module';
import logger from './logger.js';

const require = createRequire(import.meta.url);
const tiersConfig = require('../config/tiers.json');
const tradingConfig = require('../config/trading.json');

/**
 * Open a new position with calculated stop/TP levels and record the entry trade.
 * Uses a transaction to ensure position + trade are created atomically.
 * @param {string} symbol
 * @param {number} price - Entry price
 * @param {number} amount - USD amount (default $600)
 * @returns {Promise<object>} The created position
 */
export async function openPosition(symbol, price, amount = 600) {
  const tierInfo = getTierForSymbol(symbol);
  if (!tierInfo) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }

  const quantity = amount / price;
  const stopLossPrice = calculateStopLoss(symbol, price);
  const takeProfits = calculateTakeProfits(price);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const posResult = await client.query(
      `INSERT INTO positions (
        symbol, entry_price, quantity, amount,
        avg_entry_price, stop_loss_price,
        tp1_price, tp2_price, tp3_price,
        remaining_qty
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        symbol, price, quantity, amount,
        price, stopLossPrice,
        takeProfits.tp1, takeProfits.tp2, takeProfits.tp3,
        quantity,
      ]
    );

    const position = posResult.rows[0];

    await client.query(
      `INSERT INTO trades (position_id, symbol, side, trade_type, price, quantity, amount)
       VALUES ($1, $2, 'BUY', 'ENTRY', $3, $4, $5)`,
      [position.id, symbol, price, quantity, amount]
    );

    await client.query('COMMIT');
    return position;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a DCA buy, update position average entry, and recalculate TP levels.
 * Stop loss stays anchored to the ORIGINAL entry price.
 * @param {number} positionId
 * @param {number} dcaLevel - 1 or 2
 * @param {number} price - Current price (DCA buy price)
 * @returns {Promise<object>} Updated position
 */
export async function executeDCA(positionId, dcaLevel, price) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const posResult = await client.query(
      'SELECT * FROM positions WHERE id = $1 AND status = $2 FOR UPDATE',
      [positionId, 'OPEN']
    );
    if (posResult.rows.length === 0) {
      throw new Error(`No open position found with id ${positionId}`);
    }

    const position = posResult.rows[0];
    const tierInfo = getTierForSymbol(position.symbol);
    const dcaKey = `dca${dcaLevel}`;
    const dcaConfig = tierInfo.config[dcaKey];

    if (!dcaConfig) {
      throw new Error(`DCA level ${dcaLevel} not available for ${position.symbol}`);
    }

    if (position.dca_level >= dcaLevel) {
      throw new Error(`DCA${dcaLevel} already executed for position ${positionId}`);
    }

    const dcaAmount = dcaConfig.amount;
    const dcaQuantity = dcaAmount / price;

    // Calculate new weighted average entry price
    const totalQty = parseFloat(position.quantity) + dcaQuantity;
    const totalCost =
      parseFloat(position.avg_entry_price) * parseFloat(position.quantity) +
      price * dcaQuantity;
    const newAvgEntry = totalCost / totalQty;

    // Recalculate take profits from new average entry
    const newTP = calculateTakeProfits(newAvgEntry);

    // Build DCA column updates
    const dcaPriceCol = `dca${dcaLevel}_price`;
    const dcaAmountCol = `dca${dcaLevel}_amount`;

    await client.query(
      `UPDATE positions SET
        dca_level = $1,
        ${dcaPriceCol} = $2,
        ${dcaAmountCol} = $3,
        quantity = quantity + $4,
        remaining_qty = remaining_qty + $4,
        avg_entry_price = $5,
        tp1_price = $6, tp2_price = $7, tp3_price = $8,
        amount = amount + $9
      WHERE id = $10`,
      [
        dcaLevel, price, dcaAmount,
        dcaQuantity, newAvgEntry,
        newTP.tp1, newTP.tp2, newTP.tp3,
        dcaAmount, positionId,
      ]
    );

    const tradeType = `DCA${dcaLevel}`;
    await client.query(
      `INSERT INTO trades (position_id, symbol, side, trade_type, price, quantity, amount)
       VALUES ($1, $2, 'BUY', $3, $4, $5, $6)`,
      [positionId, position.symbol, tradeType, price, dcaQuantity, dcaAmount]
    );

    await client.query('COMMIT');

    const updated = await query('SELECT * FROM positions WHERE id = $1', [positionId]);
    return updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a take profit sell (partial position).
 * TP1 = 50%, TP2 = 30%, TP3 = 20% of remaining quantity.
 * @param {number} positionId
 * @param {string} tpLevel - 'TP1', 'TP2', or 'TP3'
 * @param {number} currentPrice
 * @returns {Promise<object>} Updated position
 */
export async function executeTakeProfit(positionId, tpLevel, currentPrice) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const posResult = await client.query(
      'SELECT * FROM positions WHERE id = $1 AND status = $2 FOR UPDATE',
      [positionId, 'OPEN']
    );
    if (posResult.rows.length === 0) {
      throw new Error(`No open position found with id ${positionId}`);
    }

    const position = posResult.rows[0];
    const remainingQty = parseFloat(position.remaining_qty);

    // Determine sell percentage based on TP level
    const tpConfig = tiersConfig.takeProfit[tpLevel.toLowerCase()];
    if (!tpConfig) {
      throw new Error(`Invalid TP level: ${tpLevel}`);
    }

    const sellPercent = tpConfig.sellPercent / 100;
    const sellQty = remainingQty * sellPercent;
    const sellAmount = sellQty * currentPrice;
    const newRemainingQty = remainingQty - sellQty;

    // Mark TP level as hit
    const tpHitCol = `${tpLevel.toLowerCase()}_hit`;

    await client.query(
      `UPDATE positions SET
        ${tpHitCol} = true,
        remaining_qty = $1
      WHERE id = $2`,
      [newRemainingQty, positionId]
    );

    await client.query(
      `INSERT INTO trades (position_id, symbol, side, trade_type, price, quantity, amount)
       VALUES ($1, $2, 'SELL', $3, $4, $5, $6)`,
      [positionId, position.symbol, tpLevel, currentPrice, sellQty, sellAmount]
    );

    // If TP3 hit, close the position entirely
    if (tpLevel === 'TP3') {
      const pnl = await calculatePositionPnL(client, positionId, currentPrice, newRemainingQty);
      await client.query(
        `UPDATE positions SET
          status = 'CLOSED', closed_at = NOW(), close_reason = 'TP3',
          realized_pnl = $1, pnl_percent = $2, remaining_qty = 0
        WHERE id = $3`,
        [pnl.realized, pnl.percent, positionId]
      );
      await recordWin();
    }

    await client.query('COMMIT');

    const updated = await query('SELECT * FROM positions WHERE id = $1', [positionId]);
    return updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close a position entirely (stop loss, manual, or circuit breaker).
 * Sells all remaining quantity at the given price.
 * @param {number} positionId
 * @param {number} price - Exit price
 * @param {string} reason - 'STOP', 'MANUAL', or 'CIRCUIT_BREAKER'
 * @returns {Promise<object>} Closed position
 */
export async function closePosition(positionId, price, reason) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const posResult = await client.query(
      'SELECT * FROM positions WHERE id = $1 AND status = $2 FOR UPDATE',
      [positionId, 'OPEN']
    );
    if (posResult.rows.length === 0) {
      throw new Error(`No open position found with id ${positionId}`);
    }

    const position = posResult.rows[0];
    const remainingQty = parseFloat(position.remaining_qty);
    const sellAmount = remainingQty * price;

    // Record the closing trade
    const tradeType = reason === 'STOP' ? 'STOP' : 'MANUAL';
    await client.query(
      `INSERT INTO trades (position_id, symbol, side, trade_type, price, quantity, amount)
       VALUES ($1, $2, 'SELL', $3, $4, $5, $6)`,
      [positionId, position.symbol, tradeType, price, remainingQty, sellAmount]
    );

    // Calculate total P&L across all trades for this position
    // Pass 0 for remainingQty since the closing SELL trade above already covers it
    const pnl = await calculatePositionPnL(client, positionId, price, 0);

    await client.query(
      `UPDATE positions SET
        status = 'CLOSED', closed_at = NOW(), close_reason = $1,
        realized_pnl = $2, pnl_percent = $3, remaining_qty = 0
      WHERE id = $4`,
      [reason, pnl.realized, pnl.percent, positionId]
    );

    // Update circuit breaker
    if (pnl.realized < 0) {
      await recordLoss();
    } else {
      await recordWin();
    }

    await client.query('COMMIT');

    const updated = await query('SELECT * FROM positions WHERE id = $1', [positionId]);
    return updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Calculate total realized P&L for a position by summing all trades.
 * @param {pg.PoolClient} client - DB client (within transaction)
 * @param {number} positionId
 * @param {number} finalPrice - Price for remaining unsold quantity
 * @param {number} remainingQty - Quantity not yet sold
 * @returns {Promise<{ realized: number, percent: number }>}
 */
async function calculatePositionPnL(client, positionId, finalPrice, remainingQty) {
  const tradesResult = await client.query(
    'SELECT side, price, quantity, amount FROM trades WHERE position_id = $1',
    [positionId]
  );

  let totalBought = 0;  // total USD spent buying
  let totalSold = 0;    // total USD received selling (already recorded)

  for (const trade of tradesResult.rows) {
    if (trade.side === 'BUY') {
      totalBought += parseFloat(trade.amount);
    } else {
      totalSold += parseFloat(trade.amount);
    }
  }

  // Add the value of remaining quantity at final price
  totalSold += remainingQty * finalPrice;

  const realized = totalSold - totalBought;
  const percent = totalBought > 0 ? (realized / totalBought) * 100 : 0;

  return { realized: Math.round(realized * 100) / 100, percent: Math.round(percent * 100) / 100 };
}

/**
 * Get all open positions.
 * @returns {Promise<object[]>}
 */
export async function getOpenPositions() {
  const result = await query(
    `SELECT p.*, s.tier
     FROM positions p
     JOIN symbols s ON s.symbol = p.symbol
     WHERE p.status = 'OPEN'
     ORDER BY p.opened_at`
  );
  return result.rows;
}

/**
 * Check if there's already an open position for a symbol.
 * @param {string} symbol
 * @returns {Promise<object | null>}
 */
export async function getPositionBySymbol(symbol) {
  const result = await query(
    `SELECT * FROM positions WHERE symbol = $1 AND status = 'OPEN'`,
    [symbol]
  );
  return result.rows[0] || null;
}

/**
 * Check if a symbol is in cooldown (closed within cooldownHours).
 * @param {string} symbol
 * @returns {Promise<{ onCooldown: boolean, closedAt?: Date, hoursAgo?: number, hoursRemaining?: number }>}
 */
export async function isSymbolOnCooldown(symbol) {
  const cooldownHours = tradingConfig.cooldownHours || 24;
  const result = await query(
    `SELECT symbol, closed_at FROM positions
     WHERE symbol = $1 AND status = 'CLOSED' AND closed_at > NOW() - INTERVAL '1 hour' * $2
     ORDER BY closed_at DESC LIMIT 1`,
    [symbol, cooldownHours]
  );
  if (result.rows.length === 0) {
    return { onCooldown: false };
  }
  const closedAt = new Date(result.rows[0].closed_at);
  const hoursAgo = Math.round((Date.now() - closedAt.getTime()) / 3600000);
  const hoursRemaining = Math.max(0, cooldownHours - hoursAgo);
  return { onCooldown: true, closedAt, hoursAgo, hoursRemaining };
}

/**
 * Get all symbols closed within cooldownHours (for Claude prompt context).
 * @returns {Promise<Array<{ symbol: string, closedAt: Date, hoursAgo: number, exitPrice: number }>>}
 */
export async function getRecentlyClosedSymbols() {
  const cooldownHours = tradingConfig.cooldownHours || 24;
  const result = await query(
    `SELECT p.symbol, p.closed_at, p.avg_entry_price,
            t.price AS exit_price
     FROM positions p
     LEFT JOIN LATERAL (
       SELECT price FROM trades
       WHERE position_id = p.id AND side = 'SELL'
       ORDER BY executed_at DESC LIMIT 1
     ) t ON true
     WHERE p.status = 'CLOSED' AND p.closed_at > NOW() - INTERVAL '1 hour' * $1
     ORDER BY p.closed_at DESC`,
    [cooldownHours]
  );
  return result.rows.map(r => ({
    symbol: r.symbol,
    closedAt: new Date(r.closed_at),
    hoursAgo: Math.round((Date.now() - new Date(r.closed_at).getTime()) / 3600000),
    exitPrice: parseFloat(r.exit_price || r.avg_entry_price),
  }));
}
