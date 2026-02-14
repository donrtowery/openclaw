import { readFileSync } from 'fs';
import twilio from 'twilio';
import logger from './logger.js';
import dotenv from 'dotenv';
dotenv.config();

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const API_KEY = process.env.TWILIO_API_KEY;
const API_SECRET = process.env.TWILIO_API_SECRET;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const TO_NUMBER = process.env.SMS_PHONE_NUMBER;

let client;
if (ACCOUNT_SID && API_KEY && API_SECRET) {
  client = twilio(API_KEY, API_SECRET, { accountSid: ACCOUNT_SID });
}

// Rate limiter: hourKey -> count
const sendCounts = new Map();

// Load SMS config
let smsConfig;
try {
  const config = JSON.parse(readFileSync('config/trading.json', 'utf8'));
  smsConfig = config.sms || {};
} catch {
  smsConfig = {};
}

/**
 * Send an SMS alert for a critical trading event.
 * Returns { sent, message } indicating success or reason for skipping.
 */
export async function sendAlert(alertType, symbol, data) {
  if (!smsConfig.enabled) {
    return { sent: false, message: 'SMS disabled in config' };
  }

  if (!client || !FROM_NUMBER || !TO_NUMBER) {
    return { sent: false, message: 'Missing Twilio credentials or phone numbers' };
  }

  const allowedTypes = smsConfig.alert_types || [];
  if (!allowedTypes.includes(alertType)) {
    return { sent: false, message: `Alert type ${alertType} not in allowed types` };
  }

  // Rate limit check
  const hourKey = new Date().toISOString().slice(0, 13);
  const maxPerHour = smsConfig.max_per_hour || 20;

  // Clean old entries
  for (const key of sendCounts.keys()) {
    if (key !== hourKey) sendCounts.delete(key);
  }

  const currentCount = sendCounts.get(hourKey) || 0;
  if (currentCount >= maxPerHour) {
    logger.warn(`[SMS] Rate limit hit (${currentCount}/${maxPerHour} this hour)`);
    return { sent: false, message: `Rate limit: ${currentCount}/${maxPerHour} per hour` };
  }

  const body = formatSmsMessage(alertType, symbol, data);

  try {
    const result = await client.messages.create({
      body,
      from: FROM_NUMBER,
      to: TO_NUMBER,
    });

    sendCounts.set(hourKey, currentCount + 1);
    logger.info(`[SMS] Sent ${alertType} alert for ${symbol || 'SYSTEM'} (${currentCount + 1}/${maxPerHour}) sid:${result.sid}`);
    return { sent: true, message: 'Sent successfully' };
  } catch (error) {
    logger.error(`[SMS] Twilio error: ${error.message}`);
    return { sent: false, message: error.message };
  }
}

/**
 * Format an SMS message (max 160 chars).
 */
export function formatSmsMessage(alertType, symbol, data) {
  const sym = symbol || '';
  let msg;

  switch (alertType) {
    case 'BUY': {
      const reason = (data.reasoning || '').substring(0, 60);
      msg = `BUY ${sym} @ $${fmtPrice(data.price)} | Conf: ${data.confidence} | ${reason}`;
      break;
    }
    case 'SELL': {
      const sign = data.pnl >= 0 ? '+' : '';
      msg = `SELL ${sym} @ $${fmtPrice(data.price)} | P&L: ${sign}$${fmtNum(data.pnl)} (${sign}${fmtNum(data.pnl_percent)}%)`;
      break;
    }
    case 'DCA': {
      msg = `DCA ${sym} @ $${fmtPrice(data.price)} | Avg now $${fmtPrice(data.new_avg_entry)} | +$${fmtNum(data.cost)}`;
      break;
    }
    case 'PARTIAL_EXIT': {
      const sign = data.pnl >= 0 ? '+' : '';
      msg = `PARTIAL ${sym} ${data.exit_percent}% @ $${fmtPrice(data.price)} | ${sign}$${fmtNum(data.pnl)}`;
      break;
    }
    case 'CIRCUIT_BREAKER': {
      msg = `CIRCUIT BREAKER | ${data.consecutive_losses} losses | Pausing ${data.cooldown_hours}h`;
      break;
    }
    default: {
      msg = `${alertType} ${sym} | ${JSON.stringify(data).substring(0, 100)}`;
    }
  }

  return msg.substring(0, 160);
}

function fmtPrice(n) {
  if (n == null) return '?';
  const num = parseFloat(n);
  return num >= 100 ? num.toFixed(0) : num >= 1 ? num.toFixed(2) : num.toFixed(4);
}

function fmtNum(n) {
  if (n == null) return '?';
  return parseFloat(n).toFixed(2);
}
