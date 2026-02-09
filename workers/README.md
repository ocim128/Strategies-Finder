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

## Automatic 2h Runs (new candle only)

Cron is configured in `wrangler.toml`:

```toml
[triggers]
crons = ["1 */2 * * *"]
```

Behavior:
- Runs every 2 hours at minute `01` UTC.
- For each enabled subscription, worker fetches Binance candles.
- It only evaluates when a **new closed candle** exists (`last_processed_closed_candle_time` guard).
- This avoids duplicate alerts between candle closes.
- Worker now auto-fallbacks across multiple Binance hosts (`data-api.binance.vision`, `api.binance.com`, `api1..4`, `api.binance.us`).
- If Binance is fully blocked from Worker egress, it falls back to Bybit klines (`spot` then `linear`) for continuity.

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

## Telegram (Optional)

Set worker secrets:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Then send `notifyTelegram: true` in request body.

## Optional Env: Binance Endpoint Override

If your Worker region still gets blocked, set a custom CSV of API bases:

- `BINANCE_API_BASES`
- `BYBIT_API_BASES`

Example value:

```text
https://data-api.binance.vision,https://api.binance.us
```

```text
https://api.bybit.com
```
