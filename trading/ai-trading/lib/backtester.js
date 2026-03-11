import { query } from '../db/connection.js';
import { detectThresholdCrossings } from './scanner.js';
import { computeExitUrgency } from './exit-scanner.js';
import logger from './logger.js';

/**
 * Backtester — replays historical indicator_snapshots through signal detection
 * and a rule-based decision model to evaluate strategy performance.
 */
export class Backtester {
  constructor(config, options = {}) {
    this.config = config;
    this.startDate = options.startDate;
    this.endDate = options.endDate;
    this.symbols = options.symbols || null; // null = all active
    this.verbose = options.verbose || false;

    // Virtual portfolio state
    this.virtualCapital = config.account.total_capital;
    this.positions = new Map(); // symbol -> { entry_price, size, cost, tier, entry_time, max_gain }
    this.closedTrades = [];
    this.signalsGenerated = 0;
    this.signalsEscalated = 0;
    this.totalPnl = 0;
  }

  async run() {
    const startTime = Date.now();
    logger.info(`[Backtest] Starting: ${this.startDate} to ${this.endDate}`);

    // Fetch all snapshots in the date range
    const snapshots = await this.fetchSnapshots();
    if (snapshots.length === 0) {
      logger.warn('[Backtest] No snapshots found in date range');
      return this.generateReport(Date.now() - startTime);
    }

    // Group snapshots by timestamp (cycle)
    const cycles = this.groupByCycle(snapshots);
    logger.info(`[Backtest] ${snapshots.length} snapshots across ${cycles.length} cycles`);

    // Replay each cycle
    let previousBySymbol = new Map();

    for (const cycle of cycles) {
      const currentBySymbol = new Map();
      for (const snap of cycle.snapshots) {
        currentBySymbol.set(snap.symbol, snap);
      }

      // Detect signals
      for (const [symbol, current] of currentBySymbol) {
        const previous = previousBySymbol.get(symbol);
        if (!previous) continue; // Need baseline first

        const analysis = this.snapshotToAnalysis(current);
        const prevAnalysis = this.snapshotToAnalysis(previous);

        const crossed = detectThresholdCrossings(
          symbol, analysis, prevAnalysis,
          this.config.scanner.thresholds
        );

        if (crossed.length > 0) {
          this.signalsGenerated++;
          this.processSignal(symbol, crossed, analysis, cycle.timestamp);
        }

        // Check exit urgency for open positions
        if (this.positions.has(symbol)) {
          this.checkExit(symbol, analysis, cycle.timestamp);
        }
      }

      previousBySymbol = currentBySymbol;
    }

    // Close any remaining open positions at last known price
    for (const [symbol, pos] of this.positions) {
      const lastCycle = cycles[cycles.length - 1];
      const lastSnap = lastCycle.snapshots.find(s => s.symbol === symbol);
      if (lastSnap) {
        this.closePosition(symbol, parseFloat(lastSnap.price), 'END_OF_BACKTEST', lastCycle.timestamp);
      }
    }

    const duration = Date.now() - startTime;
    const report = this.generateReport(duration);

    // Save to DB
    await this.saveReport(report);

    return report;
  }

  async fetchSnapshots() {
    let sql = `
      SELECT * FROM indicator_snapshots
      WHERE created_at >= $1 AND created_at <= $2
    `;
    const params = [this.startDate, this.endDate];

    if (this.symbols && this.symbols.length > 0) {
      sql += ` AND symbol = ANY($3)`;
      params.push(this.symbols);
    }

    sql += ` ORDER BY created_at, symbol`;

    const result = await query(sql, params);
    return result.rows;
  }

  groupByCycle(snapshots) {
    const cycles = [];
    let currentCycle = null;

    for (const snap of snapshots) {
      const ts = new Date(snap.created_at).getTime();
      // Group within 2-minute window (snapshots in same cycle)
      if (!currentCycle || Math.abs(ts - currentCycle.timestamp) > 2 * 60 * 1000) {
        currentCycle = { timestamp: ts, snapshots: [] };
        cycles.push(currentCycle);
      }
      currentCycle.snapshots.push(snap);
    }

    return cycles;
  }

  /**
   * Convert a DB snapshot row back into an analysis object
   * compatible with detectThresholdCrossings and computeExitUrgency.
   */
  snapshotToAnalysis(snap) {
    return {
      symbol: snap.symbol,
      price: parseFloat(snap.price),
      rsi: snap.rsi != null ? { value: parseFloat(snap.rsi), signal: this.rsiSignal(parseFloat(snap.rsi)) } : null,
      macd: snap.macd != null ? {
        macd: parseFloat(snap.macd),
        signal: parseFloat(snap.macd_signal),
        histogram: parseFloat(snap.macd_histogram),
        crossover: this.macdCrossover(snap),
      } : null,
      ema: snap.ema9 != null && snap.ema21 != null ? {
        ema9: parseFloat(snap.ema9),
        ema21: parseFloat(snap.ema21),
        signal: parseFloat(snap.ema9) > parseFloat(snap.ema21) ? 'BULLISH' : 'BEARISH',
      } : null,
      volume: snap.volume_ratio != null ? {
        ratio: parseFloat(snap.volume_ratio),
        current: parseFloat(snap.volume_24h || 0),
        trend: 'STABLE',
      } : null,
      bollingerBands: snap.bb_upper != null ? {
        upper: parseFloat(snap.bb_upper),
        middle: parseFloat(snap.bb_middle),
        lower: parseFloat(snap.bb_lower),
        width: this.bbWidth(snap),
        position: this.bbPosition(snap),
      } : null,
      adx: snap.adx != null ? {
        value: parseFloat(snap.adx),
        signal: snap.adx_signal || 'WEAK_TREND',
      } : null,
      stochRsi: snap.stoch_rsi_k != null ? {
        k: parseFloat(snap.stoch_rsi_k),
        d: parseFloat(snap.stoch_rsi_d),
        signal: this.stochRsiSignal(parseFloat(snap.stoch_rsi_k), parseFloat(snap.stoch_rsi_d)),
      } : null,
      obv: snap.obv != null ? { value: parseFloat(snap.obv), trend: 'FLAT' } : null,
      trend: snap.trend ? { direction: snap.trend, strength: 'MODERATE' } : null,
      atr: snap.atr != null ? { value: parseFloat(snap.atr), percent: parseFloat(snap.atr_percent || 0) } : null,
      ichimoku: snap.ichimoku_signal ? { signal: snap.ichimoku_signal } : null,
      vwap: snap.vwap != null ? {
        value: parseFloat(snap.vwap),
        signal: parseFloat(snap.price) > parseFloat(snap.vwap) * 1.02 ? 'ABOVE' :
                parseFloat(snap.price) < parseFloat(snap.vwap) * 0.98 ? 'BELOW' : 'NEUTRAL',
      } : null,
      sma: {
        sma50: snap.sma50 != null ? parseFloat(snap.sma50) : null,
        sma200: snap.sma200 != null ? parseFloat(snap.sma200) : null,
      },
      support: snap.support_nearest != null ? [parseFloat(snap.support_nearest)] : [],
      resistance: snap.resistance_nearest != null ? [parseFloat(snap.resistance_nearest)] : [],
    };
  }

  // Helper signal classifiers for snapshot reconstruction
  rsiSignal(val) {
    if (val < 30) return 'OVERSOLD';
    if (val < 40) return 'APPROACHING_OVERSOLD';
    if (val > 70) return 'OVERBOUGHT';
    if (val > 60) return 'APPROACHING_OVERBOUGHT';
    return 'NEUTRAL';
  }

  macdCrossover(snap) {
    // Without previous MACD, infer from current values
    const macd = parseFloat(snap.macd);
    const signal = parseFloat(snap.macd_signal);
    if (macd > signal) return 'BULLISH_TREND';
    if (macd < signal) return 'BEARISH_TREND';
    return 'NEUTRAL';
  }

  bbWidth(snap) {
    const upper = parseFloat(snap.bb_upper);
    const lower = parseFloat(snap.bb_lower);
    const middle = parseFloat(snap.bb_middle);
    const width = upper - lower;
    const avgWidth = middle * 0.04;
    if (width < avgWidth * 0.5) return 'NARROW';
    if (width > avgWidth * 1.5) return 'WIDE';
    return 'NORMAL';
  }

  bbPosition(snap) {
    const price = parseFloat(snap.price);
    const upper = parseFloat(snap.bb_upper);
    const lower = parseFloat(snap.bb_lower);
    const range = upper - lower;
    if (range <= 0) return 'MIDDLE';
    const pct = (price - lower) / range;
    if (pct < 0.2) return 'LOWER';
    if (pct > 0.8) return 'UPPER';
    return 'MIDDLE';
  }

  stochRsiSignal(k, d) {
    if (k < 20 && d < 20) return 'OVERSOLD';
    if (k > 80 && d > 80) return 'OVERBOUGHT';
    if (k > d && k < 30) return 'BULLISH_CROSS';
    if (k < d && k > 70) return 'BEARISH_CROSS';
    return 'NEUTRAL';
  }

  /**
   * Rule-based signal processing (mimics Haiku/Sonnet without API calls).
   * Uses simple heuristics based on the system's known patterns.
   */
  processSignal(symbol, crossed, analysis, timestamp) {
    // Skip if already have a position
    if (this.positions.has(symbol)) return;

    // Skip if at max positions
    if (this.positions.size >= this.config.account.max_concurrent_positions) return;

    // Simple rule-based entry: require 2+ bullish crossings + RSI not overbought
    const bullishCrossings = crossed.filter(c =>
      ['RSI_OVERSOLD', 'MACD_BULLISH_CROSSOVER', 'EMA_BULLISH_CROSSOVER',
       'VOLUME_SPIKE', 'STOCHRSI_BULLISH_CROSS', 'TREND_TURNED_BULLISH',
       'ICHIMOKU_BULLISH_CROSS', 'VWAP_CROSS_ABOVE', 'BB_LOWER_TOUCH'].includes(c)
    );

    if (bullishCrossings.length >= 2) {
      // Check RSI is not overbought
      if (analysis.rsi && analysis.rsi.value > 65) return;

      // Check volume is reasonable
      if (analysis.volume && analysis.volume.ratio < 1.0) return;

      this.signalsEscalated++;
      this.openPosition(symbol, analysis.price, 1, timestamp);

      if (this.verbose) {
        logger.info(`[Backtest] BUY ${symbol} @ $${analysis.price.toFixed(2)} — ${bullishCrossings.join(', ')}`);
      }
    }
  }

  openPosition(symbol, price, tier, timestamp) {
    const tierKey = `tier_${tier}`;
    const baseSize = this.config.position_sizing[tierKey]?.base_position_usd ?? 600;
    const cost = Math.min(baseSize, this.virtualCapital);
    if (cost < 10) return;

    const size = cost / price;
    this.virtualCapital -= cost;

    this.positions.set(symbol, {
      entry_price: price,
      size,
      cost,
      tier,
      entry_time: timestamp,
      max_gain: 0,
    });
  }

  checkExit(symbol, analysis, timestamp) {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    const currentPrice = analysis.price;
    const pnlPercent = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
    pos.max_gain = Math.max(pos.max_gain, pnlPercent);

    // Build position-like object for computeExitUrgency
    const posObj = {
      symbol,
      tier: pos.tier,
      avg_entry_price: pos.entry_price,
      current_size: pos.size,
      entry_time: new Date(pos.entry_time),
      max_unrealized_gain_percent: pos.max_gain,
      dca_count: 0,
    };

    const urgency = computeExitUrgency(posObj, analysis, currentPrice);

    if (urgency.score >= (this.config.exit_scanner?.urgency_threshold ?? 30)) {
      this.closePosition(symbol, currentPrice, urgency.factors.join(', '), timestamp);
      if (this.verbose) {
        logger.info(`[Backtest] EXIT ${symbol} @ $${currentPrice.toFixed(2)} | urgency ${urgency.score} | ${urgency.factors.join(', ')}`);
      }
    }
  }

  closePosition(symbol, exitPrice, reason, timestamp) {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    const exitValue = pos.size * exitPrice;
    const feeRate = this.config.fees?.rate ?? 0.001;
    const fees = (pos.cost + exitValue) * feeRate;
    const pnl = exitValue - pos.cost - fees;
    const pnlPercent = (pnl / pos.cost) * 100;
    const holdHours = (timestamp - pos.entry_time) / (1000 * 60 * 60);

    this.virtualCapital += exitValue - (exitValue * feeRate);
    this.totalPnl += pnl;
    this.positions.delete(symbol);

    this.closedTrades.push({
      symbol,
      entry_price: pos.entry_price,
      exit_price: exitPrice,
      pnl,
      pnl_percent: pnlPercent,
      hold_hours: holdHours,
      max_gain: pos.max_gain,
      exit_reason: reason,
      entry_time: new Date(pos.entry_time).toISOString(),
      exit_time: new Date(timestamp).toISOString(),
    });
  }

  generateReport(durationMs) {
    const wins = this.closedTrades.filter(t => t.pnl > 0);
    const losses = this.closedTrades.filter(t => t.pnl <= 0);
    const totalTrades = this.closedTrades.length;

    // Max drawdown calculation
    let peak = this.config.account.total_capital;
    let maxDrawdown = 0;
    let runningCapital = this.config.account.total_capital;
    for (const trade of this.closedTrades) {
      runningCapital += trade.pnl;
      peak = Math.max(peak, runningCapital);
      const drawdown = ((peak - runningCapital) / peak) * 100;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    // Sharpe ratio (annualized, assuming ~8760 hours/year)
    let sharpeRatio = 0;
    if (totalTrades >= 2) {
      const returns = this.closedTrades.map(t => t.pnl_percent);
      const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
      const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1);
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        const avgHoldHours = this.closedTrades.reduce((s, t) => s + t.hold_hours, 0) / totalTrades;
        const tradesPerYear = 8760 / (avgHoldHours || 24);
        sharpeRatio = (avgReturn / stdDev) * Math.sqrt(tradesPerYear);
      }
    }

    return {
      start_date: this.startDate,
      end_date: this.endDate,
      symbols: this.symbols,
      duration_ms: durationMs,
      total_trades: totalTrades,
      wins: wins.length,
      losses: losses.length,
      win_rate: totalTrades > 0 ? (wins.length / totalTrades * 100) : 0,
      total_pnl: this.totalPnl,
      avg_win: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
      avg_loss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
      max_drawdown_percent: maxDrawdown,
      sharpe_ratio: sharpeRatio,
      signals_generated: this.signalsGenerated,
      signals_escalated: this.signalsEscalated,
      final_capital: this.virtualCapital,
      trades: this.closedTrades,
    };
  }

  async saveReport(report) {
    try {
      await query(`
        INSERT INTO backtest_runs (start_date, end_date, symbols, config_snapshot, results)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        this.startDate,
        this.endDate,
        this.symbols,
        JSON.stringify(this.config),
        JSON.stringify(report),
      ]);
      logger.info(`[Backtest] Results saved to backtest_runs table`);
    } catch (error) {
      logger.error(`[Backtest] Failed to save results: ${error.message}`);
    }
  }
}
