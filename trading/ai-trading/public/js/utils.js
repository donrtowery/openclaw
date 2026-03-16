// ── Formatting Helpers ─────────────────────────────────────

function fmtCurrency(val, decimals = 2) {
  if (val == null || isNaN(val)) return '--';
  const n = parseFloat(val);
  const prefix = n >= 0 ? '' : '-';
  return prefix + '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPercent(val, decimals = 2) {
  if (val == null || isNaN(val)) return '--';
  const n = parseFloat(val);
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
}

function fmtPrice(val) {
  if (val == null || isNaN(val)) return '--';
  const n = parseFloat(val);
  if (n >= 100) return '$' + n.toFixed(2);
  if (n >= 1) return '$' + n.toFixed(4);
  return '$' + n.toFixed(6);
}

function fmtDate(val) {
  if (!val) return '--';
  const d = new Date(val);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

function fmtDateTime(val) {
  if (!val) return '--';
  const d = new Date(val);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
}

function fmtDuration(entryTime) {
  if (!entryTime) return '--';
  const ms = Date.now() - new Date(entryTime).getTime();
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return Math.round(hours * 60) + 'm';
  if (hours < 48) return hours.toFixed(1) + 'h';
  return (hours / 24).toFixed(1) + 'd';
}

function pnlClass(val) {
  if (val == null) return '';
  return parseFloat(val) >= 0 ? 'pnl-positive' : 'pnl-negative';
}

function pnlStatClass(val) {
  if (val == null) return '';
  return parseFloat(val) >= 0 ? 'positive' : 'negative';
}

function shortDay(val) {
  if (!val) return '';
  const d = new Date(val);
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/New_York' });
}
