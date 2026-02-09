CREATE TABLE IF NOT EXISTS entry_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_key TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    stream_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    strategy_key TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('long', 'short')),
    signal_time INTEGER NOT NULL,
    signal_price REAL NOT NULL,
    signal_reason TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entry_signals_channel_time
    ON entry_signals(channel_key, signal_time DESC);

CREATE INDEX IF NOT EXISTS idx_entry_signals_stream_time
    ON entry_signals(stream_id, signal_time DESC);
