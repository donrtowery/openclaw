-- OpenClaw v2 - Predictive Analysis System Migration
-- Run against live DB: psql -U openclaw -d openclaw_db -f db/migration-predictive.sql

BEGIN;

-- ── New table: predictions ──────────────────────────────────
CREATE TABLE predictions (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    tier INTEGER NOT NULL,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('UP', 'DOWN')),
    confidence DECIMAL(4,3) NOT NULL,
    timeframe_hours INTEGER NOT NULL,
    invalidation_criteria TEXT,
    divergence_type VARCHAR(50) NOT NULL,  -- OBV_DIVERGENCE, MACD_ACCELERATION, COMBINED
    divergence_details JSONB,
    reasoning TEXT NOT NULL,
    outcome VARCHAR(30) DEFAULT 'PENDING'
        CHECK (outcome IN ('CORRECT','PARTIALLY_CORRECT','WRONG','INVALIDATED','PENDING','EXPIRED')),
    actual_move_percent DECIMAL(10,4),
    outcome_evaluated_at TIMESTAMPTZ,
    position_id INTEGER REFERENCES positions(id),
    signal_id INTEGER REFERENCES signals(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_predictions_symbol ON predictions(symbol, created_at);
CREATE INDEX idx_predictions_pending ON predictions(outcome, created_at) WHERE outcome = 'PENDING';

COMMENT ON TABLE predictions IS 'Directional predictions from leading indicator divergences (OBV, MACD acceleration). Scored nightly.';

-- ── New table: btc_correlations ─────────────────────────────
CREATE TABLE btc_correlations (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    pearson_r DECIMAL(6,4) NOT NULL,
    beta DECIMAL(6,3) NOT NULL,
    r_squared DECIMAL(6,4),
    window_hours INTEGER NOT NULL DEFAULT 24,
    candle_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_btc_corr_symbol ON btc_correlations(symbol, created_at DESC);

COMMENT ON TABLE btc_correlations IS 'Rolling BTC correlation and beta for each symbol. Updated hourly by engine.';

-- ── ALTER positions: add entry_mode + prediction_id ─────────
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_mode VARCHAR(30) DEFAULT 'REACTIVE'
    CHECK (entry_mode IN ('REACTIVE', 'PREDICTIVE', 'PREDICTIVE_BTC_LED'));
ALTER TABLE positions ADD COLUMN IF NOT EXISTS prediction_id INTEGER REFERENCES predictions(id);

CREATE INDEX idx_positions_entry_mode ON positions(entry_mode) WHERE status = 'OPEN';

-- ── ALTER trades: add entry_mode ────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_mode VARCHAR(30) DEFAULT 'REACTIVE';

-- ── ALTER signals: add signal_source ────────────────────────
ALTER TABLE signals ADD COLUMN IF NOT EXISTS signal_source VARCHAR(20) DEFAULT 'REACTIVE';

-- ── Prediction accuracy view (for nightly learning) ─────────
CREATE OR REPLACE VIEW prediction_accuracy AS
SELECT
    symbol,
    divergence_type,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE outcome IN ('CORRECT','PARTIALLY_CORRECT')) as hits,
    ROUND(
        (COUNT(*) FILTER (WHERE outcome IN ('CORRECT','PARTIALLY_CORRECT'))::numeric /
         NULLIF(COUNT(*) FILTER (WHERE outcome NOT IN ('PENDING','EXPIRED')), 0)) * 100, 1
    ) as accuracy_pct,
    AVG(actual_move_percent) FILTER (WHERE outcome = 'CORRECT') as avg_correct_move
FROM predictions
WHERE outcome != 'PENDING'
GROUP BY symbol, divergence_type;

COMMIT;
