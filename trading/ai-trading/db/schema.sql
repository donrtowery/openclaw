-- OpenClaw v2 - AI-Driven Trading System
-- NO RIGID RULES - ALL DECISIONS MADE BY AI

-- Drop existing
DROP TABLE IF EXISTS trade_events CASCADE;
DROP TABLE IF EXISTS learning_history CASCADE;
DROP TABLE IF EXISTS learning_rules CASCADE;
DROP TABLE IF EXISTS indicator_snapshots CASCADE;
DROP TABLE IF EXISTS decisions CASCADE;
DROP TABLE IF EXISTS signals CASCADE;
DROP TABLE IF EXISTS trades CASCADE;
DROP TABLE IF EXISTS positions CASCADE;
DROP TABLE IF EXISTS circuit_breaker CASCADE;
DROP TABLE IF EXISTS symbols CASCADE;

-- 1. SYMBOLS - 25 cryptocurrencies across 3 tiers
-- Tiers indicate position size and risk tolerance, NOT automatic triggers
CREATE TABLE symbols (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    tier INTEGER NOT NULL CHECK (tier >= 1 AND tier <= 4),
    is_active BOOLEAN DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE symbols IS 'Tier 1 = blue chip (larger positions), Tier 2 = established (medium), Tier 3 = speculative (smaller positions)';

-- 2. POSITIONS - Open and closed positions
CREATE TABLE positions (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    status VARCHAR(10) NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
    tier INTEGER NOT NULL,

    -- Entry
    entry_price DECIMAL(20,8) NOT NULL,
    entry_time TIMESTAMPTZ NOT NULL,
    entry_size DECIMAL(20,8) NOT NULL,
    entry_cost DECIMAL(20,8) NOT NULL,
    entry_reasoning TEXT,
    entry_confidence DECIMAL(4,3),

    -- Current state (for open positions)
    current_price DECIMAL(20,8),
    current_size DECIMAL(20,8),
    total_cost DECIMAL(20,8),  -- Includes any DCAs
    avg_entry_price DECIMAL(20,8),  -- Weighted average after DCAs

    -- Exit (for closed positions)
    exit_price DECIMAL(20,8),
    exit_time TIMESTAMPTZ,
    exit_reasoning TEXT,
    exit_confidence DECIMAL(4,3),

    -- P&L (calculated on close)
    realized_pnl DECIMAL(20,8),
    realized_pnl_percent DECIMAL(10,4),

    -- Partial exits tracking
    partial_exits INTEGER DEFAULT 0,
    total_profit_taken DECIMAL(20,8) DEFAULT 0,

    -- AI decision links
    open_signal_id INTEGER,
    open_decision_id INTEGER,
    close_signal_id INTEGER,
    close_decision_id INTEGER,

    -- Metadata
    hold_hours DECIMAL(10,2),
    max_unrealized_gain_percent DECIMAL(10,4),
    max_unrealized_loss_percent DECIMAL(10,4),

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_positions_status ON positions(status);
CREATE INDEX idx_positions_symbol ON positions(symbol);
CREATE INDEX idx_positions_open ON positions(symbol, status) WHERE status = 'OPEN';

-- 3. TRADES - Individual executions (entries, DCAs, partial exits, full exits)
CREATE TABLE trades (
    id SERIAL PRIMARY KEY,
    position_id INTEGER REFERENCES positions(id),
    symbol VARCHAR(20) NOT NULL,
    trade_type VARCHAR(20) NOT NULL CHECK (trade_type IN ('ENTRY', 'DCA', 'PARTIAL_EXIT', 'FULL_EXIT')),

    price DECIMAL(20,8) NOT NULL,
    size DECIMAL(20,8) NOT NULL,
    cost DECIMAL(20,8) NOT NULL,

    -- For exits
    exit_percent INTEGER,  -- % of position sold
    pnl DECIMAL(20,8),
    pnl_percent DECIMAL(10,4),

    -- Context
    reasoning TEXT,
    confidence DECIMAL(4,3),

    -- Binance
    binance_order_id VARCHAR(100),
    paper_trade BOOLEAN DEFAULT true,

    executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trades_position ON trades(position_id);
CREATE INDEX idx_trades_symbol ON trades(symbol, executed_at);

-- 4. SIGNALS - EVERY Haiku evaluation (escalated or not)
CREATE TABLE signals (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,

    -- What triggered this signal
    triggered_by TEXT[],  -- ['RSI_OVERSOLD', 'MACD_CROSSOVER', 'VOLUME_SPIKE']

    -- Market snapshot
    price DECIMAL(20,8) NOT NULL,
    rsi DECIMAL(6,2),
    macd DECIMAL(20,8),
    macd_signal DECIMAL(20,8),
    macd_histogram DECIMAL(20,8),
    sma10 DECIMAL(20,8),
    sma30 DECIMAL(20,8),
    sma50 DECIMAL(20,8),
    sma200 DECIMAL(20,8),
    ema9 DECIMAL(20,8),
    ema21 DECIMAL(20,8),
    bb_upper DECIMAL(20,8),
    bb_middle DECIMAL(20,8),
    bb_lower DECIMAL(20,8),
    volume_24h DECIMAL(20,8),
    volume_ratio DECIMAL(6,2),
    support_nearest DECIMAL(20,8),
    resistance_nearest DECIMAL(20,8),
    trend VARCHAR(20),

    -- Haiku's evaluation
    signal_type VARCHAR(10) CHECK (signal_type IN ('BUY', 'SELL', 'NONE')),
    strength VARCHAR(20) CHECK (strength IN ('STRONG', 'MODERATE', 'WEAK', 'TRAP')),
    confidence DECIMAL(4,3),
    reasoning TEXT,
    escalated BOOLEAN DEFAULT false,

    -- Outcome (filled by nightly learning)
    outcome VARCHAR(20) CHECK (outcome IN ('WIN', 'LOSS', 'NEUTRAL', 'NOT_TRADED', 'MISSED_OPPORTUNITY', 'PENDING')),
    outcome_pnl DECIMAL(20,8),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_signals_symbol ON signals(symbol, created_at);
CREATE INDEX idx_signals_escalated ON signals(escalated);
CREATE INDEX idx_signals_outcome ON signals(outcome) WHERE outcome IS NOT NULL;

-- 5. DECISIONS - Every Sonnet decision
CREATE TABLE decisions (
    id SERIAL PRIMARY KEY,
    signal_id INTEGER REFERENCES signals(id),
    symbol VARCHAR(20) NOT NULL,

    -- Decision
    action VARCHAR(20) NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD', 'DCA', 'PARTIAL_EXIT', 'PASS')),
    confidence DECIMAL(4,3) NOT NULL,

    -- If BUY/DCA
    recommended_entry_price DECIMAL(20,8),
    recommended_position_size DECIMAL(20,8),

    -- If SELL/PARTIAL_EXIT
    recommended_exit_price DECIMAL(20,8),
    recommended_exit_percent INTEGER,  -- % of position to sell

    -- Reasoning (critical for learning)
    reasoning TEXT NOT NULL,
    risk_assessment TEXT,
    technical_analysis TEXT,
    news_sentiment TEXT,
    alternative_considered TEXT,

    -- Context provided to Sonnet
    open_positions_count INTEGER,
    portfolio_pnl_percent DECIMAL(10,4),
    has_position_in_symbol BOOLEAN,
    existing_position_pnl_percent DECIMAL(10,4),

    -- CRITICAL: Full prompt snapshot for future Haiku training
    prompt_snapshot TEXT,

    -- Execution
    executed BOOLEAN DEFAULT false,
    execution_notes TEXT,

    -- Outcome (filled by nightly learning)
    outcome VARCHAR(20) CHECK (outcome IN ('WIN', 'LOSS', 'NEUTRAL', 'CORRECT_HOLD', 'CORRECT_PASS', 'MISSED_OPPORTUNITY', 'PENDING')),
    outcome_pnl DECIMAL(20,8),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_decisions_signal ON decisions(signal_id);
CREATE INDEX idx_decisions_action ON decisions(action);
CREATE INDEX idx_decisions_outcome ON decisions(outcome) WHERE outcome IS NOT NULL;

-- 6. INDICATOR_SNAPSHOTS - 5-min snapshots for all symbols
CREATE TABLE indicator_snapshots (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,

    price DECIMAL(20,8) NOT NULL,
    rsi DECIMAL(6,2),
    macd DECIMAL(20,8),
    macd_signal DECIMAL(20,8),
    macd_histogram DECIMAL(20,8),
    sma10 DECIMAL(20,8),
    sma30 DECIMAL(20,8),
    sma50 DECIMAL(20,8),
    sma200 DECIMAL(20,8),
    ema9 DECIMAL(20,8),
    ema21 DECIMAL(20,8),
    bb_upper DECIMAL(20,8),
    bb_middle DECIMAL(20,8),
    bb_lower DECIMAL(20,8),
    volume_24h DECIMAL(20,8),
    volume_ratio DECIMAL(6,2),
    support_nearest DECIMAL(20,8),
    resistance_nearest DECIMAL(20,8),
    trend VARCHAR(20),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_snapshots_symbol_time ON indicator_snapshots(symbol, created_at);
CREATE INDEX idx_snapshots_cleanup ON indicator_snapshots(created_at);  -- For nightly cleanup

-- 7. LEARNING_RULES - Active rules from nightly analysis
CREATE TABLE learning_rules (
    id SERIAL PRIMARY KEY,
    rule_type VARCHAR(50) NOT NULL,  -- 'haiku_escalation', 'sonnet_decision', 'pattern'
    rule_text TEXT NOT NULL,

    -- Supporting evidence
    sample_size INTEGER,
    win_rate DECIMAL(5,2),
    avg_pnl DECIMAL(20,8),
    confidence_score DECIMAL(4,3),

    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX idx_learning_rules_active ON learning_rules(is_active, rule_type);

-- 8. LEARNING_HISTORY - Nightly analysis results
CREATE TABLE learning_history (
    id SERIAL PRIMARY KEY,

    -- Period analyzed
    analysis_start_date DATE NOT NULL,
    analysis_end_date DATE NOT NULL,

    -- Statistics
    total_trades INTEGER,
    winning_trades INTEGER,
    losing_trades INTEGER,
    win_rate DECIMAL(5,2),
    total_pnl DECIMAL(20,8),
    avg_win_pnl DECIMAL(20,8),
    avg_loss_pnl DECIMAL(20,8),
    best_trade_pnl DECIMAL(20,8),
    worst_trade_pnl DECIMAL(20,8),

    -- Pattern analysis
    best_patterns JSONB,  -- Indicator combos with high win rates
    worst_patterns JSONB,  -- Patterns to avoid

    -- Prompt updates
    haiku_prompt_updated BOOLEAN DEFAULT false,
    sonnet_prompt_updated BOOLEAN DEFAULT false,
    new_few_shot_examples JSONB,

    -- Sonnet's insights
    sonnet_analysis TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. TRADE_EVENTS - Queue for Ollama to consume and post to Discord
CREATE TABLE trade_events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(30) NOT NULL,
    symbol VARCHAR(20),

    -- Event details
    price DECIMAL(20,8),
    size DECIMAL(20,8),
    confidence DECIMAL(4,3),
    reasoning TEXT,
    pnl DECIMAL(20,8),
    pnl_percent DECIMAL(10,4),

    -- Flexible data
    metadata JSONB,

    -- Processing
    posted_to_discord BOOLEAN DEFAULT false,
    posted_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_pending ON trade_events(posted_to_discord, created_at) WHERE posted_to_discord = false;

-- 10. CIRCUIT_BREAKER - Tracks consecutive losses
CREATE TABLE circuit_breaker (
    id SERIAL PRIMARY KEY,
    consecutive_losses INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT false,
    activated_at TIMESTAMPTZ,
    reactivates_at TIMESTAMPTZ,
    last_loss_symbol VARCHAR(20),
    last_loss_pnl DECIMAL(20,8),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize
INSERT INTO circuit_breaker (consecutive_losses, is_active) VALUES (0, false);
