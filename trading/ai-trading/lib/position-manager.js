import { readFileSync } from 'fs';
import { query, getClient } from '../db/connection.js';
import logger from './logger.js';
import { getCurrentPrice, getAllPrices } from './binance.js';

// Trading fee rate (Binance standard: 0.1% per side) — config > env > default
const _tradingConfig = (() => { try { return JSON.parse(readFileSync('config/trading.json', 'utf8')); } catch { return {}; } })();
const FEE_RATE = parseFloat(process.env.TRADING_FEE_RATE || _tradingConfig?.fees?.rate || '0.001');

/**
 * Open a new position
 * @param {string} direction - 'LONG' (default) or 'SHORT'
 */
export async function openPosition(symbol, tier, entryPrice, entrySize, entryCost, reasoning, confidence, decisionId, paperTrade = true, direction = 'LONG') {
  const entryFee = entryCost * FEE_RATE;
  const costWithFees = entryCost + entryFee;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const result = await client.query(`
      INSERT INTO positions (
        symbol, status, tier, direction,
        entry_price, entry_time, entry_size, entry_cost,
        current_price, current_size, total_cost, avg_entry_price,
        entry_reasoning, entry_confidence, open_decision_id,
        total_fees
      ) VALUES ($1, 'OPEN', $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `, [
      symbol, tier, direction,
      entryPrice, entrySize, costWithFees,
      entryPrice, entrySize, costWithFees, entryPrice,
      reasoning, confidence, decisionId,
      entryFee,
    ]);

    const positionId = result.rows[0].id;

    // Log entry trade
    await client.query(`
      INSERT INTO trades (position_id, symbol, trade_type, direction, price, size, cost, reasoning, confidence, paper_trade)
      VALUES ($1, $2, 'ENTRY', $3, $4, $5, $6, $7, $8, $9)
    `, [positionId, symbol, direction, entryPrice, entrySize, costWithFees, reasoning, confidence, paperTrade]);

    await client.query('COMMIT');
    const dirLabel = direction === 'SHORT' ? 'SHORT ' : '';
    logger.info(`[Position] Opened ${dirLabel}#${positionId} ${symbol} @ $${entryPrice.toFixed(2)} ($${entryCost.toFixed(2)} + $${entryFee.toFixed(2)} fee)`);
    return positionId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Add to existing position (DCA)
 */
export async function addToPosition(positionId, dcaPrice, dcaSize, dcaCost, reasoning, confidence, paperTrade = true) {
  const dcaFee = dcaCost * FEE_RATE;
  const dcaCostWithFees = dcaCost + dcaFee;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const posResult = await client.query('SELECT * FROM positions WHERE id = $1 FOR UPDATE', [positionId]);
    if (posResult.rows.length === 0) throw new Error(`Position ${positionId} not found`);

    const pos = posResult.rows[0];
    const oldSize = parseFloat(pos.current_size);
    const oldCost = parseFloat(pos.total_cost);
    const newTotalSize = oldSize + dcaSize;

    if (newTotalSize <= 0) throw new Error(`Invalid DCA: size would become ${newTotalSize}`);

    const newTotalCost = oldCost + dcaCostWithFees;
    // Compute avg entry from raw costs (excluding fees) to avoid inflating P&L basis
    // total_cost includes fees for cost tracking, but avg_entry should reflect actual price
    const oldRawCost = oldSize * parseFloat(pos.avg_entry_price);
    const newAvgEntry = (oldRawCost + dcaCost) / newTotalSize;
    const newTotalFees = parseFloat(pos.total_fees || 0) + dcaFee;

    await client.query(`
      UPDATE positions
      SET current_size = $1, total_cost = $2, avg_entry_price = $3, current_price = $4,
          total_fees = $5, dca_count = COALESCE(dca_count, 0) + 1, updated_at = NOW()
      WHERE id = $6
    `, [newTotalSize, newTotalCost, newAvgEntry, dcaPrice, newTotalFees, positionId]);

    await client.query(`
      INSERT INTO trades (position_id, symbol, trade_type, direction, price, size, cost, reasoning, confidence, paper_trade)
      VALUES ($1, $2, 'DCA', $3, $4, $5, $6, $7, $8, $9)
    `, [positionId, pos.symbol, pos.direction || 'LONG', dcaPrice, dcaSize, dcaCostWithFees, reasoning, confidence, paperTrade]);

    await client.query('COMMIT');
    logger.info(`[Position] DCA #${positionId} @ $${dcaPrice.toFixed(2)}, new avg: $${newAvgEntry.toFixed(2)} (fee: $${dcaFee.toFixed(2)})`);
    return { newAvgEntry, newTotalSize, newTotalCost };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close position (full or partial exit)
 * exitPercent should reflect actual fill — caller must adjust for partial fills.
 */
export async function closePosition(positionId, exitPrice, exitPercent, reasoning, confidence, decisionId, paperTrade = true) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const posResult = await client.query('SELECT * FROM positions WHERE id = $1 FOR UPDATE', [positionId]);
    if (posResult.rows.length === 0) throw new Error(`Position ${positionId} not found`);

    const pos = posResult.rows[0];
    if (pos.status !== 'OPEN') {
      await client.query('ROLLBACK');
      throw new Error(`Position ${positionId} is already ${pos.status}`);
    }
    const currentSize = parseFloat(pos.current_size);
    if (!currentSize || isNaN(currentSize) || currentSize <= 0) {
      await client.query('ROLLBACK');
      throw new Error(`Position ${positionId} has invalid size: ${pos.current_size}`);
    }
    exitPercent = Math.min(Math.max(exitPercent, 0), 100);
    const avgEntry = parseFloat(pos.avg_entry_price);
    const direction = pos.direction || 'LONG';
    const exitSize = currentSize * (exitPercent / 100);
    const exitValue = exitSize * exitPrice;
    const exitFee = exitValue * FEE_RATE;
    const netExitValue = exitValue - exitFee;
    // Use total_cost / current_size for all-in cost (includes entry fees) instead of raw avg_entry_price
    const allInCostPerUnit = parseFloat(pos.total_cost) / currentSize;
    const costBasis = exitSize * allInCostPerUnit;
    // Direction-aware P&L
    let pnl;
    if (direction === 'SHORT') {
      // SHORT: profit = (entry_price - exit_price) * size - all fees
      // Can't use costBasis (entry+fees) directly because fee accounting is inverted for shorts
      const rawPnl = (avgEntry - exitPrice) * exitSize;
      const totalEntryFees = Math.max(0, parseFloat(pos.total_cost) - currentSize * avgEntry);
      const proportionalEntryFee = (exitSize / currentSize) * totalEntryFees;
      pnl = rawPnl - proportionalEntryFee - exitFee;
    } else {
      // LONG: profit = exit_proceeds - cost_basis
      pnl = netExitValue - costBasis;
    }
    const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    const isFull = exitPercent >= 99;
    const tradeType = isFull ? 'FULL_EXIT' : 'PARTIAL_EXIT';
    const newTotalFees = parseFloat(pos.total_fees || 0) + exitFee;

    if (isFull) {
      const entryTime = new Date(pos.entry_time);
      const holdHours = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);
      const totalProfit = parseFloat(pos.total_profit_taken || 0) + pnl;
      // Query total capital deployed (entry + all DCAs) — the true denominator for P&L%
      // This handles DCA'd positions correctly (entry_cost only has initial entry)
      // and isn't reduced by partial exits (unlike total_cost)
      const capitalResult = await client.query(
        "SELECT COALESCE(SUM(cost), 0) as total_deployed FROM trades WHERE position_id = $1 AND trade_type IN ('ENTRY', 'DCA')",
        [positionId]
      );
      const totalCapitalDeployed = parseFloat(capitalResult.rows[0].total_deployed) || parseFloat(pos.entry_cost);
      const finalPnlPercent = totalCapitalDeployed > 0 ? (totalProfit / totalCapitalDeployed) * 100 : 0;

      await client.query(`
        UPDATE positions
        SET status = 'CLOSED', exit_price = $1, exit_time = NOW(), exit_reasoning = $2,
            exit_confidence = $3, realized_pnl = $4, realized_pnl_percent = $5,
            hold_hours = $6, close_decision_id = $7, current_size = 0,
            total_fees = $8, updated_at = NOW()
        WHERE id = $9
      `, [exitPrice, reasoning, confidence, totalProfit, finalPnlPercent, holdHours, decisionId, newTotalFees, positionId]);

      logger.info(`[Position] CLOSED #${positionId} @ $${exitPrice.toFixed(2)} | P&L: $${totalProfit.toFixed(2)} (${finalPnlPercent.toFixed(2)}%) | fees: $${newTotalFees.toFixed(2)} | held ${holdHours.toFixed(1)}h`);
    } else {
      const remainingSize = Math.max(0, currentSize - exitSize);
      // Preserve proportional cost including fees — remaining coins keep their share of total_cost
      const remainingCost = currentSize > 0 ? (remainingSize / currentSize) * parseFloat(pos.total_cost) : 0;
      const partialExits = (pos.partial_exits || 0) + 1;
      const totalProfit = parseFloat(pos.total_profit_taken || 0) + pnl;

      await client.query(`
        UPDATE positions
        SET current_size = $1, total_cost = $2, partial_exits = $3,
            total_profit_taken = $4, current_price = $5, total_fees = $6, updated_at = NOW()
        WHERE id = $7
      `, [remainingSize, remainingCost, partialExits, totalProfit, exitPrice, newTotalFees, positionId]);

      logger.info(`[Position] PARTIAL EXIT #${positionId} ${exitPercent}% @ $${exitPrice.toFixed(2)} | profit: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%) | fee: $${exitFee.toFixed(2)}`);
    }

    // Log trade
    await client.query(`
      INSERT INTO trades (
        position_id, symbol, trade_type, direction, price, size, cost,
        exit_percent, pnl, pnl_percent, reasoning, confidence, paper_trade
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [positionId, pos.symbol, tradeType, direction, exitPrice, exitSize, netExitValue,
        exitPercent, pnl, pnlPercent, reasoning, confidence, paperTrade]);

    await client.query('COMMIT');
    return { pnl, pnlPercent, isFull };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get all open positions
 */
export async function getOpenPositions() {
  const result = await query('SELECT * FROM positions WHERE status = $1 ORDER BY entry_time DESC', ['OPEN']);
  return result.rows;
}

/**
 * Get open position by symbol (or null).
 * @param {string} direction - optional, filter by direction ('LONG' or 'SHORT')
 */
export async function getPositionBySymbol(symbol, direction = null) {
  if (direction) {
    const result = await query(
      'SELECT * FROM positions WHERE symbol = $1 AND status = $2 AND direction = $3 LIMIT 1',
      [symbol, 'OPEN', direction]
    );
    return result.rows[0] || null;
  }
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
export async function getPortfolioSummary(config, options = {}) {
  const totalCapital = config?.account?.total_capital || 6000;
  const maxPositions = config?.account?.max_concurrent_positions || 5;
  const openPositions = await getOpenPositions();

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalPartialProfitTaken = 0;
  let totalUnrealizedPnl = 0;

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
      const currentSize = parseFloat(pos.current_size) || 0;
      const currentValue = currentSize * currentPrice;
      // Use remaining cost basis (already reduced by partial exits) not original total_cost
      const invested = parseFloat(pos.total_cost) || 0;

      totalInvested += invested;
      totalCurrentValue += currentValue;
      totalPartialProfitTaken += parseFloat(pos.total_profit_taken || 0) || 0;

      const direction = pos.direction || 'LONG';
      const posUnrealizedPnl = direction === 'SHORT'
        ? invested - currentValue  // SHORT: profit when current value < invested
        : currentValue - invested; // LONG: profit when current value > invested
      totalUnrealizedPnl += posUnrealizedPnl;

      // Update live price in DB (skip when called from exit scanner which already has fresh prices)
      if (!options.skipPriceUpdate) {
        await query('UPDATE positions SET current_price = $1, updated_at = NOW() WHERE id = $2', [currentPrice, pos.id]);
      }
    } catch (error) {
      logger.error(`[Position] Price fetch failed for ${pos.symbol}: ${error.message}`);
      // Use last known price
      const fallbackInvested = parseFloat(pos.total_cost) || 0;
      const fallbackCurrentValue = (parseFloat(pos.current_size) || 0) * (parseFloat(pos.current_price || pos.entry_price) || 0);
      totalInvested += fallbackInvested;
      totalCurrentValue += fallbackCurrentValue;
      totalPartialProfitTaken += parseFloat(pos.total_profit_taken || 0) || 0;

      const direction = pos.direction || 'LONG';
      const posUnrealizedPnl = direction === 'SHORT'
        ? fallbackInvested - fallbackCurrentValue  // SHORT: profit when current value < invested
        : fallbackCurrentValue - fallbackInvested; // LONG: profit when current value > invested
      totalUnrealizedPnl += posUnrealizedPnl;
    }
  }

  // Unrealized P&L = direction-aware sum computed per-position in the loop above
  const unrealizedPnl = totalUnrealizedPnl;

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

  // Total P&L includes realized + unrealized + profit already taken from partial exits on open positions
  const totalPnl = unrealizedPnl + realizedPnl + totalPartialProfitTaken;

  return {
    open_count: openPositions.length,
    max_positions: maxPositions,
    total_invested: totalInvested,
    total_current_value: totalCurrentValue,
    // Cap available capital at totalCapital - totalInvested to prevent over-leverage
    // (realized profits from closed trades do NOT expand the deployable capital pool)
    available_capital: Math.max(0, totalCapital - totalInvested),
    total_portfolio_value: (totalCapital - totalInvested) + totalCurrentValue + realizedPnl + totalPartialProfitTaken,
    unrealized_pnl: unrealizedPnl,
    unrealized_pnl_percent: totalInvested > 0 ? (unrealizedPnl / totalInvested * 100) : 0,
    realized_pnl: realizedPnl,
    today_pnl: todayPnl,
    total_pnl: totalPnl,
    total_pnl_percent: totalCapital > 0 ? (totalPnl / totalCapital * 100) : 0,
    total_trades: totalTrades,
    wins,
    losses: parseInt(stats.losses) || 0,
    win_rate: totalTrades > 0 ? (wins / totalTrades * 100) : 0,
    avg_win: parseFloat(stats.avg_win) || 0,
    avg_loss: parseFloat(stats.avg_loss) || 0,
  };
}
