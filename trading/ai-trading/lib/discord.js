import logger from './logger.js';

const WEBHOOK_TRADING = process.env.DISCORD_WEBHOOK_TRADING;
const WEBHOOK_DASHBOARD = process.env.DISCORD_WEBHOOK_DASHBOARD;

const COLORS = {
  green: 0x2ecc71,
  red: 0xe74c3c,
  yellow: 0xf39c12,
  blue: 0x3498db,
};

/**
 * Send a payload to a Discord webhook.
 * @param {string} webhookUrl
 * @param {object} payload
 */
async function sendWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    logger.warn('Discord webhook URL not configured — skipping');
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`Discord webhook failed (${res.status}): ${body}`);
    }
  } catch (err) {
    logger.error(`Discord webhook error: ${err.message}`);
  }
}

/**
 * Post a trade alert embed to #trading-alerts.
 * @param {string} message - Plain text fallback
 * @param {object} [embed] - Optional Discord embed object
 */
export async function postTradeAlert(message, embed) {
  const payload = { content: embed ? undefined : message };
  if (embed) payload.embeds = [embed];
  await sendWebhook(WEBHOOK_TRADING, payload);
}

/**
 * Post a dashboard update to #dashboard.
 * @param {string} message
 * @param {object} [embed]
 */
export async function postDashboard(message, embed) {
  const payload = { content: embed ? undefined : message };
  if (embed) payload.embeds = [embed];
  await sendWebhook(WEBHOOK_DASHBOARD, payload);
}

/**
 * Format a position into a Discord embed.
 * @param {object} position - Position row from DB
 * @param {number} [currentPrice] - Current price for unrealized P&L
 * @returns {object} Discord embed
 */
export function formatPosition(position, currentPrice) {
  const entryPrice = parseFloat(position.avg_entry_price);
  const pnlPercent = currentPrice
    ? (((currentPrice - entryPrice) / entryPrice) * 100).toFixed(2)
    : null;
  const pnlUsd = currentPrice
    ? ((currentPrice - entryPrice) * parseFloat(position.remaining_qty)).toFixed(2)
    : null;
  const isProfit = pnlPercent && parseFloat(pnlPercent) >= 0;

  const fields = [
    { name: 'Entry Price', value: `$${entryPrice.toFixed(2)}`, inline: true },
    { name: 'Amount', value: `$${parseFloat(position.amount).toFixed(0)}`, inline: true },
    { name: 'DCA Level', value: `${position.dca_level}/2`, inline: true },
  ];

  if (currentPrice) {
    fields.push(
      { name: 'Current Price', value: `$${currentPrice.toFixed(2)}`, inline: true },
      { name: 'P&L', value: `$${pnlUsd} (${pnlPercent}%)`, inline: true },
    );
  }

  fields.push(
    { name: 'Stop Loss', value: `$${parseFloat(position.stop_loss_price).toFixed(2)}`, inline: true },
    { name: 'TP1/TP2/TP3', value: [
      position.tp1_hit ? '~~TP1~~' : `$${parseFloat(position.tp1_price).toFixed(2)}`,
      position.tp2_hit ? '~~TP2~~' : `$${parseFloat(position.tp2_price).toFixed(2)}`,
      position.tp3_hit ? '~~TP3~~' : `$${parseFloat(position.tp3_price).toFixed(2)}`,
    ].join(' / '), inline: false },
  );

  return {
    title: `${position.symbol} — ${position.status}`,
    color: position.status === 'CLOSED'
      ? (parseFloat(position.realized_pnl) >= 0 ? COLORS.green : COLORS.red)
      : (isProfit ? COLORS.green : COLORS.red),
    fields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format Claude's analysis into a Discord embed.
 * @param {object} analysis - { checkType, decisions, marketPhase, tokensUsed, cost }
 * @returns {object} Discord embed
 */
export function formatAnalysis(analysis) {
  const decisions = analysis.decisions || [];
  const decisionText = decisions.length > 0
    ? decisions.map(d => `**${d.symbol}**: ${d.action} — ${d.reasoning}`).join('\n')
    : 'No actions recommended';

  const fields = [
    { name: 'Decisions', value: decisionText.slice(0, 1024), inline: false },
  ];

  if (analysis.marketPhase) {
    fields.unshift({ name: 'Market Phase', value: analysis.marketPhase, inline: true });
  }
  if (analysis.newEntries && analysis.newEntries.length > 0) {
    fields.push({
      name: 'New Entry Opportunities',
      value: analysis.newEntries.map(e => `**${e.symbol}**: ${e.reasoning}`).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  fields.push({
    name: 'Cost',
    value: `${analysis.tokensUsed || 0} tokens ($${(analysis.cost || 0).toFixed(4)})`,
    inline: true,
  });

  return {
    title: `AI Analysis — ${analysis.checkType || 'CHECK'}`,
    color: COLORS.blue,
    fields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format a price alert into a Discord embed.
 * @param {object} alert - Alert row from DB
 * @returns {object} Discord embed
 */
export function formatAlert(alert) {
  const typeLabels = {
    PRICE_DROP: 'Price Drop',
    PRICE_SPIKE: 'Price Spike',
    VOLUME_SPIKE: 'Volume Spike',
    DCA_TRIGGER: 'DCA Trigger',
    TP_TRIGGER: 'Take Profit Trigger',
    STOP_TRIGGER: 'Stop Loss Trigger',
  };

  const isNegative = ['PRICE_DROP', 'STOP_TRIGGER'].includes(alert.alert_type);
  const color = isNegative ? COLORS.red : ['TP_TRIGGER'].includes(alert.alert_type) ? COLORS.green : COLORS.yellow;

  return {
    title: `Alert: ${typeLabels[alert.alert_type] || alert.alert_type}`,
    color,
    fields: [
      { name: 'Symbol', value: alert.symbol, inline: true },
      { name: 'Price', value: `$${parseFloat(alert.price).toFixed(2)}`, inline: true },
      { name: 'Threshold', value: alert.threshold ? `${alert.threshold}%` : 'N/A', inline: true },
    ],
    timestamp: new Date(alert.created_at).toISOString(),
  };
}
