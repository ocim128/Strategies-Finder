-- Committee feature: cached latest evaluation state per subscription.
-- Written by the cron after every due evaluation; read by the batched
-- /api/subscriptions/states endpoint so batched reads do not have to
-- re-run evaluateLatestEntrySignal per stream. The JSON payload includes
-- latestTrade, latestEntry, closedCandleTimeSec and latestClose.
ALTER TABLE signal_subscriptions ADD COLUMN latest_state_json TEXT NULL;
