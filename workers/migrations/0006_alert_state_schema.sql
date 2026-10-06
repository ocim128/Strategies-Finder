-- Alert state schema required by the entry-signal worker:
-- - nullable committee_tag / latest_state_json on signal_subscriptions
--   (existing rows need no backfill; an unevaluated subscription keeps the
--   worker's existing no_cached_state behavior)
-- - the committee_alert_rules table backing the aggregate-score alert pass,
--   with defaults matching the current handlers: disabled, thresholds +1/-1,
--   sign 0, null fire time, current timestamp.
--
-- SQLite ADD COLUMN is not idempotent: deployments that manually added these
-- columns or this table must reconcile their schema before applying this
-- migration (see the D1 Setup section in workers/README.md).

ALTER TABLE signal_subscriptions ADD COLUMN committee_tag TEXT;
ALTER TABLE signal_subscriptions ADD COLUMN latest_state_json TEXT;

CREATE TABLE IF NOT EXISTS committee_alert_rules (
    committee_tag TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    long_threshold INTEGER NOT NULL DEFAULT 1,
    short_threshold INTEGER NOT NULL DEFAULT -1,
    last_fired_score_sign INTEGER NOT NULL DEFAULT 0,
    last_fired_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
