-- OpenClaw AI Trading System - Database Schema
-- Created: 2026-02-09

BEGIN;

-- ============================================================
-- SYMBOLS - 25 tradable symbols with tier classification
-- ============================================================
CREATE TABLE symbols (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20) NOT NULL UNIQUE,
    tier            SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 3),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- POSITIONS - Track open/closed positions with DCA and TP
-- ============================================================
CREATE TABLE positions (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20) NOT NULL REFERENCES symbols(symbol),
    status          VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),

    -- Entry
    entry_price     NUMERIC(18,8) NOT NULL,
    quantity        NUMERIC(18,8) NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,  -- USD value at entry

    -- DCA tracking
    dca_level       SMALLINT NOT NULL DEFAULT 0 CHECK (dca_level BETWEEN 0 AND 2),
    dca1_price      NUMERIC(18,8),
    dca1_amount     NUMERIC(12,2),
    dca2_price      NUMERIC(18,8),
    dca2_amount     NUMERIC(12,2),
    avg_entry_price NUMERIC(18,8) NOT NULL,  -- weighted average after DCAs

    -- Stop loss (calculated from ORIGINAL entry based on tier)
    stop_loss_price NUMERIC(18,8) NOT NULL,

    -- Take profit levels
    tp1_price       NUMERIC(18,8) NOT NULL,  -- +5%
    tp2_price       NUMERIC(18,8) NOT NULL,  -- +8%
    tp3_price       NUMERIC(18,8) NOT NULL,  -- +12%
    tp1_hit         BOOLEAN NOT NULL DEFAULT false,
    tp2_hit         BOOLEAN NOT NULL DEFAULT false,
    tp3_hit         BOOLEAN NOT NULL DEFAULT false,

    -- Remaining quantity after partial TPs
    remaining_qty   NUMERIC(18,8) NOT NULL,

    -- Timestamps and result
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    close_reason    VARCHAR(20) CHECK (close_reason IN ('TP1', 'TP2', 'TP3', 'STOP', 'MANUAL', 'CIRCUIT_BREAKER')),
    realized_pnl    NUMERIC(12,2),
    pnl_percent     NUMERIC(8,4)
);

-- ============================================================
-- TRADES - Every executed trade (entries, DCAs, TPs, stops)
-- ============================================================
CREATE TABLE trades (
    id              SERIAL PRIMARY KEY,
    position_id     INTEGER NOT NULL REFERENCES positions(id),
    symbol          VARCHAR(20) NOT NULL REFERENCES symbols(symbol),
    side            VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    trade_type      VARCHAR(10) NOT NULL CHECK (trade_type IN ('ENTRY', 'DCA1', 'DCA2', 'TP1', 'TP2', 'TP3', 'STOP', 'MANUAL')),
    price           NUMERIC(18,8) NOT NULL,
    quantity        NUMERIC(18,8) NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AI_ANALYSES - Log every Claude API call
-- ============================================================
CREATE TABLE ai_analyses (
    id              SERIAL PRIMARY KEY,
    check_type      VARCHAR(10) NOT NULL CHECK (check_type IN ('LIGHT', 'DEEP', 'ALERT')),
    symbols         TEXT[],           -- array of symbols analyzed
    decision        TEXT,             -- summary of what was decided
    reasoning       TEXT,             -- full reasoning from Claude
    tokens_input    INTEGER,
    tokens_output   INTEGER,
    cost_usd        NUMERIC(8,6),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ALERTS - Price alerts triggered
-- ============================================================
CREATE TABLE alerts (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20) NOT NULL REFERENCES symbols(symbol),
    alert_type      VARCHAR(20) NOT NULL CHECK (alert_type IN ('PRICE_DROP', 'PRICE_SPIKE', 'VOLUME_SPIKE', 'DCA_TRIGGER', 'TP_TRIGGER', 'STOP_TRIGGER')),
    threshold       NUMERIC(8,4),     -- percent threshold that triggered
    price           NUMERIC(18,8) NOT NULL,
    handled         BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TRADE_EVENTS - Queue for Ollama bot to consume
-- ============================================================
CREATE TABLE trade_events (
    id          SERIAL PRIMARY KEY,
    event_type  VARCHAR(50) NOT NULL,
    symbol      VARCHAR(20),
    data        JSONB NOT NULL,
    posted      BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    posted_at   TIMESTAMPTZ
);

-- ============================================================
-- CIRCUIT_BREAKER - Single row tracking
-- ============================================================
CREATE TABLE circuit_breaker (
    id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    consecutive_losses      SMALLINT NOT NULL DEFAULT 0,
    is_paused               BOOLEAN NOT NULL DEFAULT false,
    paused_at               TIMESTAMPTZ,
    resume_at               TIMESTAMPTZ,
    last_updated            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_positions_status ON positions(status);
CREATE INDEX idx_positions_symbol ON positions(symbol);
CREATE INDEX idx_positions_opened_at ON positions(opened_at);
CREATE INDEX idx_positions_status_symbol ON positions(status, symbol);

CREATE INDEX idx_trades_position_id ON trades(position_id);
CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_executed_at ON trades(executed_at);
CREATE INDEX idx_trades_trade_type ON trades(trade_type);

CREATE INDEX idx_ai_analyses_check_type ON ai_analyses(check_type);
CREATE INDEX idx_ai_analyses_created_at ON ai_analyses(created_at);

CREATE INDEX idx_alerts_symbol ON alerts(symbol);
CREATE INDEX idx_alerts_handled ON alerts(handled);
CREATE INDEX idx_alerts_created_at ON alerts(created_at);

CREATE INDEX idx_trade_events_pending ON trade_events (posted, created_at) WHERE posted = false;

-- ============================================================
-- SEED DATA - 25 symbols
-- ============================================================
INSERT INTO symbols (symbol, tier) VALUES
    -- Tier 1: Blue Chips (15% stop, 2 DCA levels)
    ('ETHUSDT', 1),
    ('SOLUSDT', 1),
    ('XRPUSDT', 1),
    ('AVAXUSDT', 1),
    ('DOTUSDT', 1),
    -- Tier 2: Established (10% stop, 1 DCA level)
    ('LINKUSDT', 2),
    ('ADAUSDT', 2),
    ('ATOMUSDT', 2),
    ('NEARUSDT', 2),
    ('POLUSDT', 2),
    ('OPUSDT', 2),
    ('ARBUSDT', 2),
    ('SUIUSDT', 2),
    ('AAVEUSDT', 2),
    ('UNIUSDT', 2),
    ('LDOUSDT', 2),
    ('FILUSDT', 2),
    ('ICPUSDT', 2),
    ('THETAUSDT', 2),
    -- Tier 3: Speculative (5% stop, no DCA)
    ('RENDERUSDT', 3),
    ('JUPUSDT', 3),
    ('GALAUSDT', 3),
    ('XTZUSDT', 3),
    ('GRTUSDT', 3),
    ('SANDUSDT', 3);

-- ============================================================
-- SEED DATA - Circuit breaker (single row)
-- ============================================================
INSERT INTO circuit_breaker (id, consecutive_losses, is_paused)
VALUES (1, 0, false);

COMMIT;
