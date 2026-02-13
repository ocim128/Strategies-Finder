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
- `POST /api/subscriptions/delete`
  - Soft-disables a subscription by default (`enabled=0`, keeps history)
  - Optional hard-delete: `{ "streamId": "...", "hardDelete": true }`
- `POST /api/subscriptions/run-now`
  - Runs one subscription immediately for testing
- `GET /health`

## Request Example

```json
{
  "streamId": "ethusdt-1h-shock",
  "symbol": "ETHUSDT",
  "interval": "1h",
  "strategyKey": "shock_reversion_trend_gate",
  "strategyParams": {
    "shockLookback": 99,
    "shockZ": 11.7095
  },
  "backtestSettings": {
    "tradeDirection": "short",
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
- Send at least 200 candles per call (worker validates this).
- `time` can be unix seconds, unix milliseconds, ISO string, or business-day object.

## Automatic Scheduled Runs (new candle only)

Cron is configured in `wrangler.toml`:

```toml
[triggers]
crons = ["0 * * * *"]
```

Behavior:
- Runs every hour on minute `00` UTC.
- Worker aligns processing to around second `10` of that minute before evaluating subscriptions.
- Interval gating prevents unnecessary checks for higher timeframes (for example, `2h` subscriptions are skipped on non-due hours).
- For each enabled subscription, worker fetches market candles from Binance endpoints only.
- It only evaluates when a **new closed candle** exists (`last_processed_closed_candle_time` guard).
- This avoids duplicate alerts between candle closes.
- Worker tries `api.binance.us` first, then falls back across Binance hosts (`data-api.binance.vision`, `api.binance.com`, `api1..4`).

Create subscription example:

```json
{
  "streamId": "ethusdt-120m-testa2",
  "symbol": "ETHUSDT",
  "interval": "120m",
  "strategyKey": "exhaustion_spike_pullback",
  "strategyParams": { "spikeAtrMult": 0, "pullbackEma": -28, "maxWaitBars": 32 },
  "backtestSettings": { "tradeDirection": "both", "executionModel": "next_open", "tradeFilterMode": "close" },
  "freshnessBars": 1,
  "notifyTelegram": true,
  "enabled": true
}
```

## D1 Setup

1. Create D1 DB and bind it as `SIGNALS_DB` in Wrangler config.
2. Apply migration:

```bash
wrangler d1 migrations apply strategy_signals --local
wrangler d1 migrations apply strategy_signals --remote
```

Migration file:
- `workers/migrations/0001_entry_signals.sql`
- `workers/migrations/0002_signal_subscriptions.sql`
- `workers/migrations/0003_exit_alerts.sql`

## Telegram (Optional)

Set worker secrets:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Then send `notifyTelegram: true` in request body.

## Optional Env: Binance Endpoint Override

If your Worker region still gets blocked, set a custom CSV of API bases:

- `BINANCE_API_BASES`

Example value:

```text
https://api.binance.us,https://data-api.binance.vision,https://api.binance.com
```
