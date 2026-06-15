-- Partial covering index for the hot "latest actionable entry signal" lookup.
-- The query in buildLatestActionableEntrySignalQuery filters out pending_entry
-- placeholders and orders by signal_time DESC, id DESC LIMIT 1.  This partial
-- index pre-filters non-actionable rows and includes payload_json so the entire
-- query can be satisfied from the index without a table lookup.
CREATE INDEX IF NOT EXISTS idx_entry_signals_actionable_latest
    ON entry_signals(channel_key, signal_time DESC, id DESC, payload_json)
    WHERE signal_reason IS NULL OR signal_reason != 'pending_entry';
