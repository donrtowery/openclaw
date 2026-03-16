// ── Dashboard App ──────────────────────────────────────────

let activeTab = 'overview';
let refreshTimer = null;
const REFRESH_MS = 30000;
let historyOffset = 0;
const HISTORY_PAGE = 20;

// ── Tab Switching ──────────────────────────────────────────

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  loadTabData(tab);
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Data Loading ───────────────────────────────────────────

async function loadTabData(tab) {
  if (!getApiKey()) return;
  try {
    switch (tab) {
      case 'overview': await loadOverview(); break;
      case 'performance': await loadPerformance(); break;
      case 'signals': await loadSignals(); break;
      case 'learning': await loadLearning(); break;
      case 'history': await Promise.all([loadHistory(false), loadTradeLog()]); break;
      case 'controls': await loadControls(); break;
    }
    document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
  } catch (e) {
    if (e.message !== 'Unauthorized') console.error(`[${tab}] Load error:`, e);
  }
}

// ── Overview Tab ───────────────────────────────────────────

async function loadOverview() {
  const [summary, positions, engine, balance] = await Promise.all([
    apiCall('get_portfolio_summary'),
    apiCall('get_positions'),
    apiCall('get_engine_status'),
    apiCall('get_balance_history', { days: 30 }),
  ]);

  const s = summary.data;
  const totalPnl = parseFloat(s.realized_pnl) || 0;
  const todayPnl = parseFloat(s.today_pnl) || 0;

  setText('stat-balance', fmtCurrency(balance.data.current_balance, 0), pnlStatClass(balance.data.current_balance - balance.data.starting_capital));
  setText('stat-total-pnl', fmtCurrency(totalPnl), pnlStatClass(totalPnl));
  setText('stat-today-pnl', fmtCurrency(todayPnl), pnlStatClass(todayPnl));
  const unrealizedPnl = parseFloat(s.unrealized_pnl) || 0;
  setText('stat-unrealized-pnl', fmtCurrency(unrealizedPnl), pnlStatClass(unrealizedPnl));
  setText('stat-win-rate', (s.win_rate || 0).toFixed(1) + '%');

  setEngineStatus(engine.data.status);
  setPaperBadge(s);

  // Positions table
  const tbody = document.querySelector('#positions-table tbody');
  const emptyMsg = document.getElementById('positions-empty');
  const pos = positions.data || [];

  if (pos.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
  } else {
    emptyMsg.style.display = 'none';
    tbody.innerHTML = pos.map(p => {
      const pnl = parseFloat(p.live_pnl_percent) || 0;
      const pnlUsd = parseFloat(p.live_pnl_usd) || 0;
      const modeBadge = p.entry_mode === 'PREDICTIVE' ? ' <span class="badge badge-pred">PRED</span>'
        : p.entry_mode === 'PREDICTIVE_BTC_LED' ? ' <span class="badge badge-btc-led">BTC-LED</span>'
        : '';
      return `<tr class="${pnl >= 0 ? 'row-green' : 'row-red'}">
        <td><strong>${p.symbol}</strong>${modeBadge}</td>
        <td>T${p.tier}</td>
        <td>${p.direction || 'LONG'}</td>
        <td>${fmtPrice(p.avg_entry_price)}</td>
        <td>${fmtPrice(p.live_price)}</td>
        <td class="${pnlClass(pnl)}">${fmtPercent(pnl)}</td>
        <td class="${pnlClass(pnlUsd)}">${fmtCurrency(pnlUsd)}</td>
        <td>${fmtCurrency(p.total_cost, 0)}</td>
        <td>${fmtDuration(p.entry_time)}</td>
      </tr>`;
    }).join('');
  }

  // Balance chart
  const hist = balance.data.history || [];
  if (hist.length > 0) {
    createOrUpdateChart('balance-chart', 'line', {
      labels: hist.map(h => shortDay(h.day)),
      datasets: [{
        label: 'Balance',
        data: hist.map(h => h.balance),
        borderColor: '#58a6ff',
        backgroundColor: 'rgba(88, 166, 255, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
      }],
    }, {
      options: {
        scales: { y: { ticks: { callback: v => '$' + v.toLocaleString() } } },
        plugins: { legend: { display: false } },
      },
    });
  }

  // Prediction accuracy table
  try {
    const predAcc = await apiCall('get_prediction_accuracy');
    const predTbody = document.querySelector('#pred-accuracy-table tbody');
    const predEmpty = document.getElementById('pred-accuracy-empty');
    const predData = predAcc.data || [];

    if (predData.length === 0) {
      predTbody.innerHTML = '';
      predEmpty.style.display = 'block';
    } else {
      predEmpty.style.display = 'none';
      predTbody.innerHTML = predData.map(r => {
        const acc = parseFloat(r.accuracy_pct) || 0;
        const accClass = acc >= 60 ? 'text-green' : acc >= 40 ? 'text-yellow' : 'text-red';
        return `<tr>
          <td>${r.symbol}</td>
          <td>${r.divergence_type}</td>
          <td>${r.total}</td>
          <td>${r.hits}</td>
          <td class="${accClass}">${acc.toFixed(1)}%</td>
          <td>${parseFloat(r.avg_correct_move || 0).toFixed(2)}%</td>
        </tr>`;
      }).join('');
    }
  } catch { /* prediction table is optional */ }
}

// ── Performance Tab ────────────────────────────────────────

async function loadPerformance() {
  const [pnl, trades] = await Promise.all([
    apiCall('get_daily_pnl', { days: 30 }),
    apiCall('get_daily_trades', { days: 30 }),
  ]);

  const pnlData = pnl.data || [];
  const tradeData = trades.data || [];

  // Summary stats
  let totalTrades = 0, totalWins = 0, totalLosses = 0, sumWin = 0, sumLoss = 0;
  for (const d of pnlData) {
    totalTrades += d.closed_count;
    totalWins += d.wins;
    totalLosses += d.losses;
    if (d.daily_pnl >= 0) sumWin += d.daily_pnl;
    else sumLoss += Math.abs(d.daily_pnl);
  }
  const avgWin = totalWins > 0 ? sumWin / totalWins : 0;
  const avgLoss = totalLosses > 0 ? sumLoss / totalLosses : 0;
  const profitFactor = sumLoss > 0 ? (sumWin / sumLoss).toFixed(2) : sumWin > 0 ? 'Inf' : '--';

  setText('perf-total-trades', totalTrades);
  setText('perf-avg-win', fmtCurrency(avgWin), 'positive');
  setText('perf-avg-loss', fmtCurrency(avgLoss), 'negative');
  setText('perf-profit-factor', profitFactor);

  // Daily P&L chart
  const pnlValues = pnlData.map(d => parseFloat(d.daily_pnl) || 0);
  createOrUpdateChart('pnl-chart', 'bar', {
    labels: pnlData.map(d => shortDay(d.day)),
    datasets: [{
      label: 'Daily P&L',
      data: pnlValues,
      backgroundColor: buildBarColors(pnlValues),
      borderRadius: 3,
    }],
  }, {
    options: {
      scales: { y: { ticks: { callback: v => '$' + v } } },
      plugins: { legend: { display: false } },
    },
  });

  // Trade count chart
  createOrUpdateChart('trades-chart', 'bar', {
    labels: tradeData.map(d => shortDay(d.day)),
    datasets: [
      { label: 'Entries', data: tradeData.map(d => d.entries), backgroundColor: '#58a6ff', borderRadius: 3 },
      { label: 'Exits', data: tradeData.map(d => d.exits), backgroundColor: '#db6d28', borderRadius: 3 },
      { label: 'DCAs', data: tradeData.map(d => d.dcas), backgroundColor: '#d29922', borderRadius: 3 },
    ],
  }, {
    options: {
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
    },
  });
}

// ── Signals Tab ────────────────────────────────────────────

async function loadSignals() {
  loadRecentSignals();
  const result = await apiCall('get_escalation_stats', { days: 30 });
  const { signals_by_day, decisions_by_day, top_symbols } = result.data;

  // Signals per day chart
  createOrUpdateChart('signals-chart', 'bar', {
    labels: signals_by_day.map(d => shortDay(d.day)),
    datasets: [
      { label: 'Escalated', data: signals_by_day.map(d => d.escalated), backgroundColor: '#db6d28', borderRadius: 3 },
      { label: 'Skipped', data: signals_by_day.map(d => d.skipped), backgroundColor: '#484f58', borderRadius: 3 },
    ],
  }, {
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
  });

  // Decisions chart
  createOrUpdateChart('decisions-chart', 'bar', {
    labels: decisions_by_day.map(d => shortDay(d.day)),
    datasets: [
      { label: 'BUY', data: decisions_by_day.map(d => d.buys), backgroundColor: '#3fb950', borderRadius: 3 },
      { label: 'PASS', data: decisions_by_day.map(d => d.passes), backgroundColor: '#484f58', borderRadius: 3 },
      { label: 'SELL', data: decisions_by_day.map(d => d.sells), backgroundColor: '#f85149', borderRadius: 3 },
      { label: 'HOLD', data: decisions_by_day.map(d => d.holds), backgroundColor: '#58a6ff', borderRadius: 3 },
    ],
  }, {
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
  });

  // Top symbols table
  const tbody = document.querySelector('#symbols-table tbody');
  const emptyMsg = document.getElementById('symbols-empty');
  if (top_symbols.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
  } else {
    emptyMsg.style.display = 'none';
    tbody.innerHTML = top_symbols.map(s => {
      const conv = s.escalated > 0 ? ((s.executed_buys / s.escalated) * 100).toFixed(1) + '%' : '--';
      return `<tr>
        <td><strong>${s.symbol}</strong></td>
        <td>${s.total_signals}</td>
        <td>${s.escalated}</td>
        <td>${s.executed_buys}</td>
        <td>${conv}</td>
      </tr>`;
    }).join('');
  }
}

// ── Learning Tab ───────────────────────────────────────────

const _typeLabels = {
  'haiku_escalation': 'Haiku Escalation',
  'haiku_calibration': 'Haiku Calibration',
  'sonnet_decision': 'Sonnet Decision',
  'sonnet_exit': 'Sonnet Exit',
};

const _changeColors = {
  'ADDED': 'pnl-positive', 'DEACTIVATED': 'pnl-negative',
  'MODIFIED': 'text-yellow', 'EXPIRED': '', 'OSCILLATION_BLOCKED': 'text-orange',
};

function _ruleClass(text) {
  if (text.startsWith('REJECT') || text.startsWith('STOP')) return 'rule-reject';
  if (text.startsWith('ESCALATE') || text.startsWith('APPROVE') || text.startsWith('START')) return 'rule-approve';
  if (text.startsWith('EXIT')) return 'rule-exit';
  if (text.startsWith('HOLD') || text.startsWith('TRAIL') || text.startsWith('PARTIAL_EXIT')) return 'rule-hold';
  if (text.startsWith('REDUCE')) return 'rule-reject';
  return '';
}

async function loadLearning() {
  const result = await apiCall('get_learning_report');
  const { sessions, changelog } = result.data;
  const container = document.getElementById('learning-container');

  if (!sessions || sessions.length === 0) {
    container.innerHTML = '<p class="empty-msg">No learning sessions found</p>';
    return;
  }

  container.innerHTML = sessions.map((session, idx) => {
    const sessionDate = new Date(session.created_est);
    const dateStr = fmtDateTime(session.created_est);
    const pnl = parseFloat(session.total_pnl) || 0;
    const wr = parseFloat(session.win_rate) || 0;
    const updatedList = [
      session.haiku_prompt_updated ? 'Haiku' : null,
      session.sonnet_prompt_updated ? 'Sonnet' : null,
    ].filter(Boolean).join(', ') || 'None';

    // Parse Opus analysis for rules
    let analysis = null;
    try { analysis = JSON.parse(session.sonnet_analysis); } catch {}
    const haikuRuleCount = (analysis?.haiku_rules?.length || 0) + (analysis?.haiku_escalation_calibration?.length || 0);
    const sonnetRuleCount = analysis?.sonnet_rules?.length || 0;
    const exitRuleCount = analysis?.exit_rules?.length || 0;

    // Build rules from Opus analysis (grouped by type)
    const ruleGroups = {};
    if (analysis) {
      for (const [key, rules] of Object.entries(analysis)) {
        if (!Array.isArray(rules)) continue;
        const label = key === 'haiku_rules' ? 'Haiku Escalation'
          : key === 'haiku_escalation_calibration' ? 'Haiku Calibration'
          : key === 'sonnet_rules' ? 'Sonnet Decision'
          : key === 'exit_rules' ? 'Sonnet Exit'
          : null;
        if (!label) continue;
        ruleGroups[label] = rules;
      }
    }

    const rulesHtml = Object.keys(ruleGroups).length > 0
      ? `<div class="learning-rule-groups">${Object.entries(ruleGroups).map(([label, items]) => `
          <div class="rule-group">
            <h4>${label}</h4>
            <ul class="rule-list">
              ${items.map(r => `<li class="${_ruleClass(r)}">${r}</li>`).join('')}
            </ul>
          </div>`).join('')}</div>`
      : '<p class="empty-msg">No rules generated</p>';

    // Filter changelog entries for this session (within 5 min of session time)
    const sessionTime = new Date(session.created_est).getTime();
    const sessionChanges = changelog.filter(c => {
      const ct = new Date(c.created_est).getTime();
      return Math.abs(ct - sessionTime) < 5 * 60 * 1000;
    });

    const changelogHtml = sessionChanges.length > 0
      ? `<div class="table-wrapper"><table>
          <thead><tr><th>Change</th><th>Type</th><th>Rule</th></tr></thead>
          <tbody>${sessionChanges.map(c => `<tr>
            <td class="${_changeColors[c.change_type] || ''}">${c.change_type}</td>
            <td>${_typeLabels[c.rule_type] || c.rule_type}</td>
            <td style="font-size:0.85em">${c.rule_text}</td>
          </tr>`).join('')}</tbody>
        </table></div>`
      : '<p class="empty-msg">No rule changes</p>';

    return `
      <div class="learning-session ${idx === 0 ? '' : 'learning-session-prev'}">
        <h2 class="learning-date">${idx === 0 ? 'Latest' : 'Previous'} Session — ${dateStr}</h2>

        <div class="stat-cards">
          <div class="stat-card">
            <div class="stat-label">Win Rate</div>
            <div class="stat-value">${wr.toFixed(1)}%</div>
            <div class="stat-sub">${session.winning_trades}W / ${session.losing_trades}L of ${session.total_trades}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">30-Day P&L</div>
            <div class="stat-value ${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">${fmtCurrency(pnl)}</div>
            <div class="stat-sub">Best: ${fmtCurrency(parseFloat(session.best_trade_pnl) || 0)} / Worst: ${fmtCurrency(parseFloat(session.worst_trade_pnl) || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Prompts Updated</div>
            <div class="stat-value" style="font-size:1.2rem">${updatedList}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Rules Generated</div>
            <div class="stat-value" style="font-size:1.2rem">${haikuRuleCount + sonnetRuleCount + exitRuleCount}</div>
            <div class="stat-sub">Haiku: ${haikuRuleCount} | Sonnet: ${sonnetRuleCount} | Exit: ${exitRuleCount}</div>
          </div>
        </div>

        <div class="section">
          <h3>Rules</h3>
          ${rulesHtml}
        </div>

        <div class="section">
          <h3>Rule Changes</h3>
          ${changelogHtml}
        </div>
      </div>
    `;
  }).join('');
}

// ── Recent Signals Table ───────────────────────────────────

async function loadRecentSignals() {
  const result = await apiCall('get_recent_signals', { limit: 20 });
  const signals = result.data || [];
  const tbody = document.querySelector('#recent-signals-table tbody');
  const emptyMsg = document.getElementById('recent-signals-empty');

  if (signals.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  const typeColors = { 'BUY': 'pnl-positive', 'SELL': 'pnl-negative', 'NONE': '' };
  const strengthColors = { 'STRONG': 'text-blue', 'MODERATE': 'text-yellow', 'WEAK': '', 'TRAP': 'pnl-negative' };
  const actionColors = {
    'BUY': 'pnl-positive', 'SHORT': 'pnl-negative', 'SELL': 'pnl-negative',
    'PARTIAL_EXIT': 'text-orange', 'DCA': 'text-yellow',
    'HOLD': 'text-blue', 'PASS': '',
  };

  tbody.innerHTML = signals.map(s => {
    const triggers = (s.triggered_by || []).join(', ');
    const sonnetAction = s.sonnet_action || '--';
    const sonnetClass = actionColors[s.sonnet_action] || '';
    const sonnetDisplay = s.sonnet_action && s.sonnet_conf
      ? `${sonnetAction} (${parseFloat(s.sonnet_conf).toFixed(2)})`
      : sonnetAction;
    return `<tr>
      <td>${fmtDateTime(s.created_est)}</td>
      <td><strong>${s.symbol}</strong></td>
      <td class="${typeColors[s.signal_type] || ''}">${s.signal_type}</td>
      <td class="${strengthColors[s.strength] || ''}">${s.strength || '--'}</td>
      <td>${s.confidence != null ? parseFloat(s.confidence).toFixed(2) : '--'}</td>
      <td class="${sonnetClass}">${sonnetDisplay}</td>
      <td style="font-size:0.85em">${triggers}</td>
    </tr>`;
  }).join('');
}

// ── Trade History Tab ──────────────────────────────────────

async function loadHistory(append) {
  if (!append) historyOffset = 0;
  const result = await apiCall('get_closed_trades', { limit: HISTORY_PAGE + historyOffset });
  const allTrades = result.data || [];
  const trades = append ? allTrades.slice(historyOffset) : allTrades;

  const tbody = document.querySelector('#history-table tbody');
  const emptyMsg = document.getElementById('history-empty');
  const loadMore = document.getElementById('load-more-btn');

  if (allTrades.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
    loadMore.style.display = 'none';
    return;
  }

  emptyMsg.style.display = 'none';

  const rows = allTrades.map((t, i) => {
    const pnl = parseFloat(t.realized_pnl) || 0;
    const pnlPct = parseFloat(t.realized_pnl_percent) || 0;
    const entryPrice = parseFloat(t.avg_entry_price) || parseFloat(t.entry_price) || 0;
    const exitPrice = parseFloat(t.exit_price) || 0;
    const totalCost = parseFloat(t.total_cost) || parseFloat(t.entry_cost) || 0;
    const sellValue = totalCost + pnl;
    const fees = parseFloat(t.total_fees) || 0;
    const dcaCount = parseInt(t.dca_count) || 0;
    const maxGain = parseFloat(t.max_unrealized_gain_percent) || 0;
    const maxLoss = parseFloat(t.max_unrealized_loss_percent) || 0;

    return `<tr class="${pnl >= 0 ? 'row-green' : 'row-red'} expandable-row" data-idx="${i}" style="cursor:pointer">
      <td><strong>${t.symbol}</strong></td>
      <td class="${pnlClass(pnl)}">${fmtCurrency(pnl)}</td>
      <td class="${pnlClass(pnlPct)}">${fmtPercent(pnlPct)}</td>
      <td>${fmtDateTime(t.entry_time)}</td>
      <td>${fmtDateTime(t.exit_time)}</td>
      <td>${t.hold_hours ? parseFloat(t.hold_hours).toFixed(1) : '--'}</td>
      <td>T${t.tier}</td>
    </tr>
    <tr class="detail-row" id="detail-${i}" style="display:none">
      <td colspan="7">
        <div class="trade-detail">
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">Entry Price</span>
              <span class="detail-value">${fmtPrice(entryPrice)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Exit Price</span>
              <span class="detail-value">${fmtPrice(exitPrice)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Total Purchased</span>
              <span class="detail-value">${fmtCurrency(totalCost)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Sell Value</span>
              <span class="detail-value ${pnlClass(pnl)}">${fmtCurrency(sellValue)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Net P&L</span>
              <span class="detail-value ${pnlClass(pnl)}">${fmtCurrency(pnl)} (${fmtPercent(pnlPct)})</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Fees Paid</span>
              <span class="detail-value">${fmtCurrency(fees)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">DCAs</span>
              <span class="detail-value">${dcaCount}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Peak Gain / Loss</span>
              <span class="detail-value"><span class="pnl-positive">${fmtPercent(maxGain)}</span> / <span class="pnl-negative">${fmtPercent(-Math.abs(maxLoss))}</span></span>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');

  tbody.innerHTML = rows;
  historyOffset = allTrades.length;
  loadMore.style.display = allTrades.length >= HISTORY_PAGE ? 'block' : 'none';
}

document.getElementById('load-more-btn').addEventListener('click', async () => {
  const loadMore = document.getElementById('load-more-btn');
  loadMore.disabled = true;
  try {
    await loadHistory(true);
  } finally {
    loadMore.disabled = false;
  }
});

document.querySelector('#history-table').addEventListener('click', (e) => {
  const row = e.target.closest('.expandable-row');
  if (!row) return;
  const idx = row.dataset.idx;
  const detail = document.getElementById('detail-' + idx);
  if (!detail) return;
  const isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : 'table-row';
  row.classList.toggle('expanded', !isOpen);
});

// ── Trade Log (All Trades) ─────────────────────────────────

async function loadTradeLog() {
  const result = await apiCall('get_trade_log', { limit: 50 });
  const trades = result.data || [];
  const tbody = document.querySelector('#trade-log-table tbody');
  const emptyMsg = document.getElementById('trade-log-empty');

  if (trades.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  const typeColors = {
    'ENTRY': 'text-blue',
    'DCA': 'text-yellow',
    'PARTIAL_EXIT': 'text-orange',
    'FULL_EXIT': 'text-red',
  };

  const modeBadges = {
    'REACTIVE': '',
    'PREDICTIVE': '<span class="badge badge-pred">PRED</span>',
    'PREDICTIVE_BTC_LED': '<span class="badge badge-btc-led">BTC-LED</span>',
  };

  tbody.innerHTML = trades.map(t => {
    const pnl = parseFloat(t.pnl) || 0;
    const pnlPct = parseFloat(t.pnl_percent) || 0;
    const price = parseFloat(t.price) || 0;
    const cost = parseFloat(t.cost) || 0;
    const exitPct = t.exit_percent != null ? t.exit_percent + '%' : '--';
    const typeClass = typeColors[t.trade_type] || '';
    const modeBadge = modeBadges[t.entry_mode] || '';
    const isExit = t.trade_type.includes('EXIT');
    const pnlDisplay = isExit ? `<span class="${pnlClass(pnl)}">${fmtCurrency(pnl)}</span>` : '--';
    const pnlPctDisplay = isExit ? `<span class="${pnlClass(pnlPct)}">${fmtPercent(pnlPct)}</span>` : '--';

    return `<tr>
      <td>${fmtDateTime(t.executed_est)}</td>
      <td><strong>${t.symbol}</strong></td>
      <td class="${typeClass}">${t.trade_type}</td>
      <td>${fmtPrice(price)}</td>
      <td>${fmtCurrency(cost)}</td>
      <td>${exitPct}</td>
      <td>${pnlDisplay}</td>
      <td>${pnlPctDisplay}</td>
      <td>${modeBadge}</td>
    </tr>`;
  }).join('');
}

// ── Controls Tab ───────────────────────────────────────────

async function loadControls() {
  const [engine, settings, positions] = await Promise.all([
    apiCall('get_engine_status'),
    apiCall('get_settings'),
    apiCall('get_positions'),
  ]);

  // Engine status
  const status = engine.data.status;
  const dot = document.getElementById('ctrl-engine-dot');
  const label = document.getElementById('ctrl-engine-label');
  dot.className = 'status-dot ' + (status === 'running' ? 'running' : 'stopped');
  label.textContent = status === 'running' ? 'Running' : 'Stopped';

  // Settings
  const s = settings.data;
  document.getElementById('set-max-pos').value = s.max_positions;
  document.getElementById('set-paper').value = String(s.paper_trading);
  document.getElementById('set-t1').value = s.tier_1_base;
  document.getElementById('set-t2').value = s.tier_2_base;
  document.getElementById('set-t3').value = s.tier_3_base;
  document.getElementById('set-scanner').value = s.scanner_interval;

  // Position selector for close
  const select = document.getElementById('close-select');
  const pos = positions.data || [];
  select.innerHTML = '<option value="">Select position...</option>' +
    pos.map(p => `<option value="${p.id}">${p.symbol} (${fmtPercent(p.live_pnl_percent)})</option>`).join('');
}

// Engine controls
document.getElementById('btn-pause').addEventListener('click', async () => {
  if (!confirm('Pause the trading engine?')) return;
  try {
    await apiCall('pause_trading');
    setEngineStatus('stopped');
    loadControls();
  } catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-resume').addEventListener('click', async () => {
  if (!confirm('Resume the trading engine?')) return;
  try {
    await apiCall('resume_trading');
    setEngineStatus('running');
    loadControls();
  } catch (e) { alert('Error: ' + e.message); }
});

// Settings form
document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('settings-status');
  statusEl.textContent = 'Saving...';
  statusEl.style.color = 'var(--text-dim)';
  try {
    await apiCall('update_settings', {
      settings: {
        max_positions: parseInt(document.getElementById('set-max-pos').value),
        paper_trading: document.getElementById('set-paper').value === 'true',
        tier_1_base: parseFloat(document.getElementById('set-t1').value),
        tier_2_base: parseFloat(document.getElementById('set-t2').value),
        tier_3_base: parseFloat(document.getElementById('set-t3').value),
        scanner_interval: parseInt(document.getElementById('set-scanner').value),
      },
    });
    statusEl.textContent = 'Saved';
    statusEl.style.color = 'var(--green)';
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.style.color = 'var(--red)';
  }
});

// Close position
document.getElementById('btn-close-one').addEventListener('click', async () => {
  const posId = document.getElementById('close-select').value;
  const reason = document.getElementById('close-reason').value.trim();
  if (!posId) return alert('Select a position');
  if (reason.length < 10) return alert('Reason must be at least 10 characters');
  if (!confirm('Close this position?')) return;
  try {
    const result = await apiCall('close_position', { position_id: parseInt(posId), reason });
    alert(`Closed ${result.symbol}: ${fmtCurrency(result.pnl)} (${fmtPercent(result.pnl_percent)})`);
    loadControls();
  } catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-close-all').addEventListener('click', async () => {
  const reason = document.getElementById('close-reason').value.trim();
  if (reason.length < 10) return alert('Reason must be at least 10 characters');
  if (!confirm('CLOSE ALL POSITIONS? This cannot be undone.')) return;
  try {
    const result = await apiCall('close_all_positions', { reason });
    alert(`Closed ${result.closed}/${result.total} positions. Total P&L: ${fmtCurrency(result.total_pnl)}`);
    loadControls();
  } catch (e) { alert('Error: ' + e.message); }
});

// AI Chat
document.getElementById('btn-chat').addEventListener('click', async () => {
  const input = document.getElementById('chat-input');
  const response = document.getElementById('chat-response');
  const question = input.value.trim();
  if (!question) return;

  response.textContent = 'Thinking...';
  try {
    const result = await apiCall('ai_chat', { question });
    response.textContent = result.data.answer;
  } catch (e) {
    response.textContent = 'Error: ' + e.message;
  }
});

document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-chat').click();
});

// ── Shared Helpers ─────────────────────────────────────────

function setText(id, text, className) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'stat-value' + (className ? ' ' + className : '');
}

function setEngineStatus(status) {
  const dot = document.getElementById('engine-dot');
  const label = document.getElementById('engine-label');
  dot.className = 'status-dot ' + (status === 'running' ? 'running' : 'stopped');
  label.textContent = status === 'running' ? 'Running' : 'Stopped';
}

function setPaperBadge(summary) {
  const badge = document.getElementById('paper-badge');
  // Check if paper trading is active by looking at the summary data
  // The portfolio summary doesn't directly include paper_trading, so we also check via settings
  apiCall('get_settings').then(res => {
    badge.style.display = res.data.paper_trading ? 'inline' : 'none';
  }).catch(() => {});
}

// ── Auto-refresh ───────────────────────────────────────────

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => loadTabData(activeTab), REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ── Init ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (checkApiKey()) {
    loadTabData('overview');
  }
  startRefresh();
});
