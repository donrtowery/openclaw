import { query } from '../db/connection.js';
import logger from './logger.js';
import { getCurrentPrice, getAllPrices } from './binance.js';

/**
 * Open a new position
 */
export async function openPosition(symbol, tier, entryPrice, entrySize, entryCost, reasoning, confidence, decisionId, paperTrade = true) {
  const result = await query(`
    INSERT INTO positions (
      symbol, status, tier,
      entry_price, entry_time, entry_size, entry_cost,
      current_price, current_size, total_cost, avg_entry_price,
      entry_reasoning, entry_confidence, open_decision_id
    ) VALUES ($1, 'OPEN', $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id
  `, [
    symbol, tier,
    entryPrice, entrySize, entryCost,
    entryPrice, entrySize, entryCost, entryPrice,
    reasoning, confidence, decisionId,
  ]);

  const positionId = result.rows[0].id;

  // Log entry trade
  await query(`
    INSERT INTO trades (position_id, symbol, trade_type, price, size, cost, reasoning, confidence, paper_trade)
    VALUES ($1, $2, 'ENTRY', $3, $4, $5, $6, $7, $8)
  `, [positionId, symbol, entryPrice, entrySize, entryCost, reasoning, confidence, paperTrade]);

  logger.info(`[Position] Opened #${positionId} ${symbol} @ $${entryPrice.toFixed(2)} (${entrySize.toFixed(6)} coins, $${entryCost.toFixed(2)})`);

  return positionId;
}

/**
 * Add to existing position (DCA)
 */
export async function addToPosition(positionId, dcaPrice, dcaSize, dcaCost, reasoning, confidence, paperTrade = true) {
  const posResult = await query('SELECT * FROM positions WHERE id = $1', [positionId]);
  if (posResult.rows.length === 0) throw new Error(`Position ${positionId} not found`);

  const pos = posResult.rows[0];
  const oldSize = parseFloat(pos.current_size);
  const oldCost = parseFloat(pos.total_cost);
  const newTotalSize = oldSize + dcaSize;
  const newTotalCost = oldCost + dcaCost;
  const newAvgEntry = newTotalCost / newTotalSize;

  await query(`
    UPDATE positions
    SET current_size = $1, total_cost = $2, avg_entry_price = $3, current_price = $4, updated_at = NOW()
    WHERE id = $5
  `, [newTotalSize, newTotalCost, newAvgEntry, dcaPrice, positionId]);

  await query(`
    INSERT INTO trades (position_id, symbol, trade_type, price, size, cost, reasoning, confidence, paper_trade)
    VALUES ($1, $2, 'DCA', $3, $4, $5, $6, $7, $8)
  `, [positionId, pos.symbol, dcaPrice, dcaSize, dcaCost, reasoning, confidence, paperTrade]);

  logger.info(`[Position] DCA #${positionId} @ $${dcaPrice.toFixed(2)}, new avg: $${newAvgEntry.toFixed(2)}`);

  return { newAvgEntry, newTotalSize, newTotalCost };
}

/**
 * Close position (full or partial exit)
 */
export async function closePosition(positionId, exitPrice, exitPercent, reasoning, confidence, decisionId, paperTrade = true) {
  const posResult = await query('SELECT * FROM positions WHERE id = $1', [positionId]);
  if (posResult.rows.length === 0) throw new Error(`Position ${positionId} not found`);

  const pos = posResult.rows[0];
  const currentSize = parseFloat(pos.current_size);
  const avgEntry = parseFloat(pos.avg_entry_price);
  const exitSize = currentSize * (exitPercent / 100);
  const exitValue = exitSize * exitPrice;
  const costBasis = exitSize * avgEntry;
  const pnl = exitValue - costBasis;
  const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
  const isFull = exitPercent >= 99;
  const tradeType = isFull ? 'FULL_EXIT' : 'PARTIAL_EXIT';

  if (isFull) {
    const entryTime = new Date(pos.entry_time);
    const holdHours = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);
    const totalProfit = parseFloat(pos.total_profit_taken || 0) + pnl;
    const totalCost = parseFloat(pos.total_cost);
    const finalPnlPercent = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;

    await query(`
      UPDATE positions
      SET status = 'CLOSED', exit_price = $1, exit_time = NOW(), exit_reasoning = $2,
          exit_confidence = $3, realized_pnl = $4, realized_pnl_percent = $5,
          hold_hours = $6, close_decision_id = $7, current_size = 0, updated_at = NOW()
      WHERE id = $8
    `, [exitPrice, reasoning, confidence, totalProfit, finalPnlPercent, holdHours, decisionId, positionId]);

    logger.info(`[Position] CLOSED #${positionId} @ $${exitPrice.toFixed(2)} | P&L: $${totalProfit.toFixed(2)} (${finalPnlPercent.toFixed(2)}%) | held ${holdHours.toFixed(1)}h`);
  } else {
    const remainingSize = currentSize - exitSize;
    const remainingCost = parseFloat(pos.total_cost) - costBasis;
    const partialExits = (pos.partial_exits || 0) + 1;
    const totalProfit = parseFloat(pos.total_profit_taken || 0) + pnl;

    await query(`
      UPDATE positions
      SET current_size = $1, total_cost = $2, partial_exits = $3,
          total_profit_taken = $4, current_price = $5, updated_at = NOW()
      WHERE id = $6
    `, [remainingSize, remainingCost, partialExits, totalProfit, exitPrice, positionId]);

    logger.info(`[Position] PARTIAL EXIT #${positionId} ${exitPercent}% @ $${exitPrice.toFixed(2)} | profit: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
  }

  // Log trade
  await query(`
    INSERT INTO trades (
      position_id, symbol, trade_type, price, size, cost,
      exit_percent, pnl, pnl_percent, reasoning, confidence, paper_trade
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `, [positionId, pos.symbol, tradeType, exitPrice, exitSize, exitValue,
      exitPercent, pnl, pnlPercent, reasoning, confidence, paperTrade]);

  return { pnl, pnlPercent, isFull };
}

/**
 * Get all open positions
 */
export async function getOpenPositions() {
  const result = await query('SELECT * FROM positions WHERE status = $1 ORDER BY entry_time DESC', ['OPEN']);
  return result.rows;
}

/**
 * Get open position by symbol (or null)
 */
export async function getPositionBySymbol(symbol) {
  const result = await query(
    'SELECT * FROM positions WHERE symbol = $1 AND status = $2 LIMIT 1',
    [symbol, 'OPEN']
  );
  return result.rows[0] || null;
}

/**
 * Get closed positions for learning
 */
export async function getClosedPositions(limit = 50) {
  const result = await query(
    'SELECT * FROM positions WHERE status = $1 ORDER BY exit_time DESC LIMIT $2',
    ['CLOSED', limit]
  );
  return result.rows;
}

/**
 * Get full portfolio summary with live prices.
 * Reads total_capital from config to avoid hardcoding.
 */
export async function getPortfolioSummary(config) {
  const totalCapital = config?.account?.total_capital || 6000;
  const maxPositions = config?.account?.max_concurrent_positions || 5;
  const openPositions = await getOpenPositions();

  let totalInvested = 0;
  let totalCurrentValue = 0;

  // Fetch all prices in one API call instead of N individual calls
  let priceMap = {};
  if (openPositions.length > 0) {
    try {
      priceMap = await getAllPrices();
    } catch (error) {
      logger.error(`[Position] Bulk price fetch failed: ${error.message}`);
    }
  }

  for (const pos of openPositions) {
    try {
      const currentPrice = priceMap[pos.symbol] || await getCurrentPrice(pos.symbol);
      const currentValue = parseFloat(pos.current_size) * currentPrice;
      const invested = parseFloat(pos.total_cost);

      totalInvested += invested;
      totalCurrentValue += currentValue;

      // Update live price in DB
      await query('UPDATE positions SET current_price = $1, updated_at = NOW() WHERE id = $2', [currentPrice, pos.id]);
    } catch (error) {
      logger.error(`[Position] Price fetch failed for ${pos.symbol}: ${error.message}`);
      // Use last known price
      totalInvested += parseFloat(pos.total_cost);
      totalCurrentValue += parseFloat(pos.current_size) * parseFloat(pos.current_price || pos.entry_price);
    }
  }

  const unrealizedPnl = totalCurrentValue - totalInvested;

  // Realized P&L from closed positions
  const realizedResult = await query(
    'SELECT COALESCE(SUM(realized_pnl), 0) as realized_pnl FROM positions WHERE status = $1',
    ['CLOSED']
  );
  const realizedPnl = parseFloat(realizedResult.rows[0].realized_pnl);

  // Today's realized P&L (positions closed today + partial exits taken today on open positions)
  const todayResult = await query(
    `SELECT COALESCE(SUM(realized_pnl), 0) as today_pnl
     FROM positions WHERE status = 'CLOSED' AND exit_time >= CURRENT_DATE`
  );
  const todayPnl = parseFloat(todayResult.rows[0].today_pnl);

  // Win/loss stats
  const statsResult = await query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as wins,
      COUNT(CASE WHEN realized_pnl < 0 THEN 1 END) as losses,
      AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) as avg_win,
      AVG(CASE WHEN realized_pnl < 0 THEN realized_pnl END) as avg_loss
    FROM positions WHERE status = 'CLOSED'
  `);
  const stats = statsResult.rows[0];
  const totalTrades = parseInt(stats.total) || 0;
  const wins = parseInt(stats.wins) || 0;

  return {
    open_count: openPositions.length,
    max_positions: maxPositions,
    total_invested: totalInvested,
    total_current_value: totalCurrentValue,
    available_capital: totalCapital - totalInvested,
    unrealized_pnl: unrealizedPnl,
    unrealized_pnl_percent: totalInvested > 0 ? (unrealizedPnl / totalInvested * 100) : 0,
    realized_pnl: realizedPnl,
    today_pnl: todayPnl,
    total_pnl: unrealizedPnl + realizedPnl,
    total_pnl_percent: totalCapital > 0 ? ((unrealizedPnl + realizedPnl) / totalCapital * 100) : 0,
    total_trades: totalTrades,
    wins,
    losses: parseInt(stats.losses) || 0,
    win_rate: totalTrades > 0 ? (wins / totalTrades * 100) : 0,
    avg_win: parseFloat(stats.avg_win) || 0,
    avg_loss: parseFloat(stats.avg_loss) || 0,
  };
}
