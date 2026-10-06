# Entry Signal Worker (Cloudflare)

This worker evaluates streamed candles against a strategy and emits **fresh entry signals**.
It deduplicates signals in D1, so the same entry is only produced once.

## Endpoints

- `POST /api/stream/signal`
  - Input: stream payload with `strategyKey`, `strategyParams`, `backtestSettings`, and `candles[]`
  - Output: `newEntry: true|false` and latest signal payload
- `GET /api/stream/signals?streamId=...&limit=50`
  - Returns recent stored entry signals for a stream
- `POST /api/subscriptions/upsert`
  - Stores/updates an auto-run subscription (pair + timeframe + strategy config)
- `GET /api/subscriptions`
  - Lists configured subscriptions
- `GET /api/subscriptions/state?streamId=...`
  - Returns the live state for one subscription (open position, last trade, last signal, last evaluation)
- `POST /api/subscriptions/states`
  - Batched version of `GET /api/subscriptions/state` — accepts `{ streamIds: [...] }` and returns one state record per id
- `POST /api/subscriptions/delete`
  - Soft-disables a subscription by default (`enabled=0`, keeps history)
  - Optional hard-delete: `{ "streamId": "...", "hardDelete": true }`
- `POST /api/subscriptions/run-now`
  - Runs one subscription immediately for testing
- `POST /api/subscriptions/run-with-candles`
  - Runs one subscription with caller-supplied candles (used by the local candle proxy path)
- `GET /health`
  - Returns worker metadata plus `supportedStrategyKeys`, `supportedStrategyCount`, and `strategyManifestFingerprint`

### Committee Alert Rules

- `GET /api/committee-alert/rules`
- `POST /api/committee-alert/rules`
  - Committee alert rule list / upsert (internal tooling route)

## Request Example

```json
{
  "streamId": "ethusdt-1h-ema-confirm",
  "symbol": "ETHUSDT",
  "interval": "1h",
  "strategyKey": "ema_confirmation",
  "strategyParams": {
    "emaPeriod": 50
  },
  "backtestSettings": {
    "tradeDirection": "both",
    "executionModel": "next_open"
  },
  "freshnessBars": 1,
  "notifyTelegram": false,
  "candles": [
    { "time": 1739062800, "open": 2780.1, "high": 2785.9, "low": 2776.2, "close": 2783.5, "volume": 10500.2 }
  ]
}
```

Notes:
- Send at least `MIN_CLOSED_CANDLES` closed candles per call. The code fallback is `200`; `wrangler.toml` currently sets `120`.
- `time` can be unix seconds, unix milliseconds, ISO string, or business-day object.
- Subscription `backtestSettings` normalize the percentage take-profit mode through `resolveTakeProfitMode` (`lib/take-profit-settings.ts`): unknown values fall back to `fixed`, and the adaptive percentage modes (`mfe_bootstrap`, `edge_weighted`, `expectancy_optimal`, `regime_calibrated`, `information_coefficient`, `path_efficiency`, `serial_dependency`, `minimum_surprisal`) are accepted.

## Automatic Scheduled Runs (new candle only)

Cron is configured in `wrangler.toml`:

```toml
[triggers]
crons = ["* * * * *"]
```

Behavior:
- Runs every minute.
- Worker aligns processing to around second `10` of each minute before evaluating subscriptions.
- Interval gating prevents unnecessary checks for higher timeframes (for example, `2h` subscriptions are skipped on non-due minutes/hours).
- For each enabled subscription, worker fetches market candles from Binance-compatible endpoints.
- Exact parity with the app requires the symbol to use Binance data as well; non-Binance chart providers are not exact-match Worker inputs.
- `2h` subscriptions are composed from `1h` source candles inside the worker so close-hour parity (`odd`/`even`) stays deterministic across providers.
- It only evaluates when a **new closed candle** exists (`last_processed_closed_candle_time` guard).
- This avoids duplicate alerts between candle closes.
- Worker queries configured Binance-compatible hosts in configured order and uses the first successful response. Keep the fastest/reliable proxy first.

Live Positions / Last Trade parity notes:
- Local verification now trims to the latest closed candle before comparing against the Worker.
- For `next_open`, local verification also appends the same synthetic next-open bridge candle used by the Worker.

Create subscription example:

```json
{
  "streamId": "ethusdt-120m-ema-confirm",
  "symbol": "ETHUSDT",
  "interval": "120m",
  "strategyKey": "ema_confirmation",
  "strategyParams": { "emaPeriod": 50 },
  "backtestSettings": { "tradeDirection": "both", "executionModel": "next_open" },
  "freshnessBars": 1,
  "notifyTelegram": true,
  "enabled": true
}
```

## D1 Setup

1. Create D1 DB and bind it as `SIGNALS_DB` in Wrangler config. The checked-in
   `workers/wrangler.toml` uses `database_name = "signal"`; if your deployment
   binds a different database, substitute its name in the commands below
   instead of assuming the sample name.
2. Apply migration:

```bash
wrangler d1 migrations apply <SIGNALS_DB database_name> --local
wrangler d1 migrations apply <SIGNALS_DB database_name> --remote
```

Migration files:
- `workers/migrations/0001_entry_signals.sql`
- `workers/migrations/0002_signal_subscriptions.sql`
- `workers/migrations/0003_exit_alerts.sql`
- `workers/migrations/0004_rename_candle_time_col.sql`
- `workers/migrations/0005_actionable_entry_signal_index.sql`
- `workers/migrations/0006_alert_state_schema.sql`

A database initialized solely from the migrations above supports everything
the worker reads and writes: subscription upsert (including `committee_tag`),
cached `latest_state_json` state, and `committee_alert_rules`.

### Existing deployments with manual schema changes

`0006` adds `signal_subscriptions.committee_tag` and
`signal_subscriptions.latest_state_json` with `ALTER TABLE ... ADD COLUMN`,
which SQLite cannot make idempotent. If a deployment manually added either
column (or created `committee_alert_rules`) before this migration existed,
inventory its schema and migration history first and reconcile before
applying `0006`:

1. List the live schema:
   `wrangler d1 execute <database_name> --remote --command "SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'"`
   and `... --command "PRAGMA table_info(signal_subscriptions)"`.
2. Compare column/table definitions against `0006_alert_state_schema.sql`.
   Manually created objects whose definitions differ from the migration must
   be reconciled (recreated or altered to match) — do not mark `0006` as
   applied without checking the complete schema, and do not drop data.
3. Apply additive schema changes before deploying a Worker build that requires
   them. A Worker code rollback leaves the additive schema in place; production
   database rollback requires a verified backup, not reverse migrations.

## Strategy Support Contract

- Worker strategy support is derived from the generated eager manifest
  (`lib/strategies/manifest-eager.ts`) through `lib/strategies/library.ts`.
- If you add or rename a built-in strategy, run `npm run strategies:sync-manifest` and redeploy the Worker after the manifest change or subscriptions can fail with `worker_strategy_not_supported:<key>`.
- `GET /health` exposes the worker's current supported strategy keys so the UI can detect an outdated deployment.

## Exit Notifications

With `notifyExit` enabled on a subscription, an exit message is sent when the
notified entry's position actually closes in the worker's evaluation: matching
is by executed entry identity (entry time and direction); legacy stored
payloads without an entry time match through the configured execution shift
applied to their stored source signal time. `end_of_data` closures count as
still-open positions and never notify, a partial exit alone never sends a
full-position close message, and ordinary opposite-signal closes, stop-loss,
take-profit, and time closes all notify with the actual exit fill price and
time. Delivery is best effort: the dedupe key in the status
(`;exit_alert:...`) is persisted only after a successful Telegram send, and
failures are logged without fabricating success so the next evaluation
retries. Status-based dedupe does not guarantee exactly-once notification
under concurrent cron/manual runs.

## Telegram (Optional)

Set worker secrets:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Then send `notifyTelegram: true` in request body.

## Browser Request Deadlines

The browser alert client applies its 10-second request deadline through JSON
or text body consumption, including `/health`. A stalled body reports a timeout
even after successful headers. Mutations remain single-attempt because a
timed-out response does not establish whether the Worker committed the change.

## Worker API Token (Optional)

Set `WORKER_API_TOKEN` to require `Authorization: Bearer <token>` on all non-health endpoints.
`GET /health` remains public so the app can verify deployment metadata.

## Optional Env: Market Endpoint Override

If your Worker region still gets blocked, set a custom CSV of Binance-compatible API bases:

- `MARKET_DATA_API_BASES` (preferred)
- `BINANCE_API_BASES`

Example value:

```text
https://api.mexc.com,https://api.binance.us,https://data-api.binance.vision
```

## Optional Env: Minimum Closed Candles

- `MIN_CLOSED_CANDLES`
  - Code fallback: `200`
  - Current `wrangler.toml` value: `120`
