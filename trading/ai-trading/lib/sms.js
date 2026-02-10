import logger from './logger.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tradingConfig = require('../config/trading.json');

const API_KEY = process.env.TEXTBELT_API_KEY;
const PHONE = process.env.SMS_PHONE_NUMBER;
const SMS_CONFIG = tradingConfig.sms || {};
const MAX_PER_HOUR = SMS_CONFIG.maxPerHour || 20;

// ── State ────────────────────────────────────────────────────
let enabled = false;
let sentThisHour = 0;
let quotaExhausted = false;

// Reset hourly counter
setInterval(() => { sentThisHour = 0; quotaExhausted = false; }, 60 * 60 * 1000);

// ── Init check ───────────────────────────────────────────────
if (!API_KEY || API_KEY === 'your_textbelt_key_here') {
  logger.warn('SMS: TEXTBELT_API_KEY not configured — SMS alerts disabled');
} else if (!PHONE || PHONE === '+15551234567') {
  logger.warn('SMS: SMS_PHONE_NUMBER not configured — SMS alerts disabled');
} else if (SMS_CONFIG.enabled === false) {
  logger.info('SMS: Disabled in config');
} else {
  enabled = true;
  logger.info(`SMS: Enabled — sending to ${PHONE.slice(0, -4)}****`);
}

/**
 * Check if a specific alert type is enabled in config.
 */
function isAlertTypeEnabled(type) {
  if (!SMS_CONFIG.alertTypes) return true;
  return SMS_CONFIG.alertTypes.includes(type);
}

/**
 * Send an SMS via TextBelt.
 * @param {string} message
 * @returns {Promise<{success: boolean, quotaRemaining?: number, error?: string}>}
 */
export async function sendSMS(message) {
  if (!enabled) return { success: false, error: 'SMS disabled' };

  if (quotaExhausted) {
    logger.warn('SMS: Quota exhausted — skipping');
    return { success: false, error: 'Quota exhausted' };
  }

  if (sentThisHour >= MAX_PER_HOUR) {
    logger.warn(`SMS: Rate limit hit (${MAX_PER_HOUR}/hr) — skipping`);
    return { success: false, error: 'Rate limit exceeded' };
  }

  // Truncate to 160 chars
  const text = message.length > 160 ? message.slice(0, 157) + '...' : message;

  try {
    const res = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: PHONE, message: text, key: API_KEY }),
    });

    const data = await res.json();
    sentThisHour++;

    if (data.success) {
      logger.info(`SMS sent: "${text}" | quota=${data.quotaRemaining}`);
      if (data.quotaRemaining < 10) {
        logger.warn(`SMS: Low quota remaining: ${data.quotaRemaining}`);
      }
      if (data.quotaRemaining === 0) {
        quotaExhausted = true;
        logger.error('SMS: Quota is 0 — disabling until next hour');
      }
      return { success: true, quotaRemaining: data.quotaRemaining };
    } else {
      logger.error(`SMS failed: ${data.error || 'Unknown error'}`);
      return { success: false, error: data.error || 'Send failed' };
    }
  } catch (err) {
    logger.error(`SMS API error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Format price with commas for readability.
 */
function fmtPrice(price) {
  const n = parseFloat(price);
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toPrecision(4);
}

/**
 * Send a formatted trade alert SMS.
 * @param {"BUY"|"SELL"|"DCA"|"TAKE_PROFIT"} type
 * @param {string} symbol
 * @param {number} price
 * @param {object} details - Extra info (confidence, pnl, dcaLevel, tpLevel, reasoning, etc.)
 */
export async function sendTradeAlert(type, symbol, price, details = {}) {
  if (!isAlertTypeEnabled(type)) return;

  const icons = { BUY: '\u{1F7E2}', SELL: '\u{1F534}', DCA: '\u{1F535}', TAKE_PROFIT: '\u{1F4B0}' };
  const icon = icons[type] || '\u{26A0}\u{FE0F}';
  const p = fmtPrice(price);
  let msg;

  switch (type) {
    case 'BUY':
      msg = `${icon} BUY ${symbol} @ ${p}`;
      if (details.confidence) msg += ` | Conf: ${details.confidence.toFixed(2)}`;
      if (details.reasoning) msg += ` | ${details.reasoning.slice(0, 60)}`;
      break;

    case 'SELL':
      msg = `${icon} SELL ${symbol} @ ${p}`;
      if (details.pnl !== undefined) msg += ` | P&L: $${parseFloat(details.pnl).toFixed(2)}`;
      if (details.pnlPercent !== undefined) msg += ` (${parseFloat(details.pnlPercent).toFixed(1)}%)`;
      if (details.reason) msg += ` | ${details.reason}`;
      break;

    case 'DCA':
      msg = `${icon} DCA${details.dcaLevel || ''} ${symbol} @ ${p}`;
      if (details.avgEntry) msg += ` | Avg now ${fmtPrice(details.avgEntry)}`;
      if (details.dcaLevel) msg += ` | DCA ${details.dcaLevel}/2 used`;
      break;

    case 'TAKE_PROFIT':
      msg = `${icon} ${details.tpLevel || 'TP'} ${symbol} @ ${p}`;
      if (details.pnl !== undefined) msg += ` | +$${Math.abs(parseFloat(details.pnl)).toFixed(2)}`;
      if (details.sellPercent) msg += ` | Took ${details.sellPercent}% profit`;
      break;

    default:
      msg = `${icon} ${type} ${symbol} @ ${p}`;
  }

  return sendSMS(msg);
}

/**
 * Send a critical system alert SMS.
 * @param {string} message
 */
export async function sendSystemAlert(message) {
  if (!isAlertTypeEnabled('CIRCUIT_BREAKER')) return;
  return sendSMS(message);
}

export { enabled as smsEnabled };
