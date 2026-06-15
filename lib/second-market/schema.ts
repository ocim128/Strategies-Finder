import type { DatabaseSync } from "node:sqlite";

export const SECOND_MARKET_SCHEMA_VERSION = 1;

const SECOND_MARKET_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS binance_1s_candles (
    symbol TEXT NOT NULL,
    market_type TEXT NOT NULL,
    ts INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    trade_count INTEGER,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(symbol, market_type, ts)
);

-- idx_binance_1s_symbol_time removed: identical columns to PRIMARY KEY(symbol, market_type, ts).
DROP INDEX IF EXISTS idx_binance_1s_symbol_time;

CREATE TABLE IF NOT EXISTS polymarket_clob_1s_quotes (
    series_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    outcome_interval TEXT NOT NULL DEFAULT '5m',
    event_start_ts INTEGER NOT NULL,
    event_end_ts INTEGER NOT NULL,
    condition_id TEXT NOT NULL DEFAULT '',
    market_slug TEXT NOT NULL DEFAULT '',
    yes_token_id TEXT NOT NULL,
    no_token_id TEXT NOT NULL DEFAULT '',
    sample_ts INTEGER NOT NULL,
    yes_bid REAL,
    yes_ask REAL,
    yes_mid REAL,
    yes_last REAL,
    no_bid REAL,
    no_ask REAL,
    no_mid REAL,
    no_last REAL,
    source TEXT NOT NULL,
    source_ts_ms INTEGER,
    quote_age_ms INTEGER,
    quality_flags TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(series_id, event_start_ts, yes_token_id, sample_ts)
);

-- idx_clob_1s_symbol_time replaced by idx_clob_1s_symbol_time_sts below
-- (covers same WHERE queries + ORDER BY source_ts_ms without temp sort).
DROP INDEX IF EXISTS idx_clob_1s_symbol_time;

CREATE INDEX IF NOT EXISTS idx_clob_1s_symbol_series_time
    ON polymarket_clob_1s_quotes(symbol, series_id, sample_ts);

CREATE INDEX IF NOT EXISTS idx_clob_1s_event_time
    ON polymarket_clob_1s_quotes(series_id, event_start_ts, sample_ts);

CREATE INDEX IF NOT EXISTS idx_clob_1s_symbol_time_sts
    ON polymarket_clob_1s_quotes(symbol, sample_ts, source_ts_ms);

CREATE TABLE IF NOT EXISTS polymarket_reference_1s_prices (
    symbol TEXT NOT NULL,
    reference_source TEXT NOT NULL,
    source_symbol TEXT NOT NULL,
    ts INTEGER NOT NULL,
    source_ts_ms INTEGER NOT NULL,
    received_ts_ms INTEGER,
    reference_price REAL NOT NULL,
    full_accuracy_value TEXT NOT NULL DEFAULT '',
    is_carried_forward INTEGER NOT NULL DEFAULT 0,
    quality_flags TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(symbol, reference_source, source_ts_ms)
);

CREATE INDEX IF NOT EXISTS idx_reference_1s_symbol_time
    ON polymarket_reference_1s_prices(symbol, reference_source, ts);

CREATE TABLE IF NOT EXISTS polymarket_gamma_snapshots (
    series_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    outcome_interval TEXT NOT NULL DEFAULT '5m',
    market_id TEXT NOT NULL,
    condition_id TEXT NOT NULL DEFAULT '',
    market_slug TEXT NOT NULL DEFAULT '',
    event_start_ts INTEGER NOT NULL,
    event_end_ts INTEGER NOT NULL,
    snapshot_ts INTEGER NOT NULL,
    gamma_yes_price REAL,
    gamma_no_price REAL,
    last_trade_price REAL,
    liquidity REAL,
    volume REAL,
    open_interest REAL,
    active INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    remote_updated_at INTEGER,
    raw_json_hash TEXT NOT NULL DEFAULT '',
    raw_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(series_id, market_id, snapshot_ts)
);

CREATE INDEX IF NOT EXISTS idx_gamma_symbol_time
    ON polymarket_gamma_snapshots(symbol, snapshot_ts);

CREATE INDEX IF NOT EXISTS idx_gamma_event_time
    ON polymarket_gamma_snapshots(series_id, event_start_ts, snapshot_ts);

CREATE TABLE IF NOT EXISTS second_data_sync_state (
    source TEXT NOT NULL,
    symbol TEXT NOT NULL,
    series_id TEXT NOT NULL DEFAULT '',
    cursor_ts INTEGER,
    cursor_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(source, symbol, series_id)
);

CREATE TABLE IF NOT EXISTS second_data_quality_runs (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    binance_seconds INTEGER NOT NULL,
    clob_quote_seconds INTEGER NOT NULL,
    reference_price_seconds INTEGER NOT NULL,
    gamma_snapshot_count INTEGER NOT NULL,
    binance_gap_count INTEGER NOT NULL,
    clob_gap_count INTEGER NOT NULL,
    reference_gap_count INTEGER NOT NULL,
    exact_quote_coverage_pct REAL NOT NULL,
    max_quote_age_sec INTEGER,
    max_reference_age_sec INTEGER,
    created_at INTEGER NOT NULL
);
`;

export function ensureSecondMarketSchema(db: DatabaseSync): void {
    db.exec(SECOND_MARKET_SCHEMA_SQL);
    db.prepare(`
        INSERT INTO schema_meta(key, value)
        VALUES ('second_market_schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SECOND_MARKET_SCHEMA_VERSION));
}
