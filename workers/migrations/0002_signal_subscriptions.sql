CREATE TABLE IF NOT EXISTS signal_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    strategy_key TEXT NOT NULL,
    strategy_params_json TEXT NOT NULL,
    backtest_settings_json TEXT NOT NULL,
    freshness_bars INTEGER NOT NULL DEFAULT 1,
    notify_telegram INTEGER NOT NULL DEFAULT 1,
    candle_limit INTEGER NOT NULL DEFAULT 350,
    last_processed_closed_candle_time INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    last_status TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signal_subscriptions_enabled
    ON signal_subscriptions(enabled, updated_at DESC);
