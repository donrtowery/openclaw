// ── Chart.js Helpers ───────────────────────────────────────

const chartInstances = {};

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  plugins: {
    legend: { labels: { color: '#8b949e', boxWidth: 12, padding: 12 } },
    tooltip: {
      backgroundColor: '#161b22',
      borderColor: '#30363d',
      borderWidth: 1,
      titleColor: '#e6edf3',
      bodyColor: '#e6edf3',
      padding: 8,
    },
  },
  scales: {
    x: {
      ticks: { color: '#8b949e', maxRotation: 45, font: { size: 11 } },
      grid: { color: '#21262d' },
    },
    y: {
      ticks: { color: '#8b949e', font: { size: 11 } },
      grid: { color: '#21262d' },
    },
  },
};

function createOrUpdateChart(canvasId, type, data, extraOpts = {}) {
  const existing = chartInstances[canvasId];
  if (existing) {
    existing.data = data;
    if (extraOpts.options?.scales) {
      Object.assign(existing.options.scales, extraOpts.options.scales);
    }
    existing.update('none');
    return existing;
  }

  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return null;

  const opts = JSON.parse(JSON.stringify(CHART_DEFAULTS));
  if (extraOpts.options) {
    if (extraOpts.options.plugins) Object.assign(opts.plugins, extraOpts.options.plugins);
    if (extraOpts.options.scales) {
      for (const [k, v] of Object.entries(extraOpts.options.scales)) {
        opts.scales[k] = { ...opts.scales[k], ...v };
      }
    }
  }

  const chart = new Chart(ctx, { type, data, options: opts });
  chartInstances[canvasId] = chart;
  return chart;
}

function buildBarColors(values) {
  return values.map(v => v >= 0 ? '#3fb950' : '#f85149');
}
