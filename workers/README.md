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

## Request Example

```json
{
  "streamId": "ethusdt-1h-exhaustion",
  "symbol": "ETHUSDT",
  "interval": "1h",
  "strategyKey": "exhaustion_spike_pullback",
  "strategyParams": {
    "spikeAtrMult": 2.5,
    "pullbackEma": 21,
    "maxWaitBars": 4
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
- Subscription `backtestSettings` preserve the surviving percentage take-profit modes: `fixed` and `mfe_bootstrap`.

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
  "streamId": "ethusdt-120m-testa2",
  "symbol": "ETHUSDT",
  "interval": "120m",
  "strategyKey": "exhaustion_spike_pullback",
  "strategyParams": { "spikeAtrMult": 0, "pullbackEma": -28, "maxWaitBars": 32 },
  "backtestSettings": { "tradeDirection": "both", "executionModel": "next_open" },
  "freshnessBars": 1,
  "notifyTelegram": true,
  "enabled": true
}
```

## D1 Setup

1. Create D1 DB and bind it as `SIGNALS_DB` in Wrangler config.
2. Apply migration:

```bash
wrangler d1 migrations apply signal --local
wrangler d1 migrations apply signal --remote
```

Migration file:
- `workers/migrations/0001_entry_signals.sql`
- `workers/migrations/0002_signal_subscriptions.sql`
- `workers/migrations/0003_exit_alerts.sql`
- `workers/migrations/0004_rename_candle_time_col.sql`
- `workers/migrations/0005_actionable_entry_signal_index.sql`
- `workers/migrations/0006_committee_state_columns.sql`
- `workers/migrations/0007_committee_tag.sql`
- `workers/migrations/0008_committee_alert_rules.sql`

## Strategy Support Contract

- Worker strategy support is derived from `lib/strategies/manifest.ts` through the shared strategy library.
- If you add or rename a built-in strategy, redeploy the Worker after the manifest change or subscriptions can fail with `worker_strategy_not_supported:<key>`.
- `GET /health` exposes the worker's current supported strategy keys so the UI can detect an outdated deployment.

## Telegram (Optional)

Set worker secrets:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Then send `notifyTelegram: true` in request body.

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
