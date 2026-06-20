-- Committee aggregate-score alert rules. One row per committee_tag (v1 treats
-- all tagged subscriptions as one committee, so the canonical tag is "default").
--
-- Hysteresis: `last_fired_score_sign` records the sign of the score at the last
-- fired alert (-1, 0, +1). An alert only fires when the current score's sign
-- differs AND crosses the matching threshold, preventing spam on threshold flap
-- and duplicate alerts every cron tick while the score stays on one side.
--
-- Default: disabled. Created on first upsert; not seeded here so a fresh deploy
-- has no rules until the user opts in.
CREATE TABLE IF NOT EXISTS committee_alert_rules (
    committee_tag TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    long_threshold INTEGER NOT NULL DEFAULT 1,
    short_threshold INTEGER NOT NULL DEFAULT -1,
    last_fired_score_sign INTEGER NOT NULL DEFAULT 0,
    last_fired_at TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
