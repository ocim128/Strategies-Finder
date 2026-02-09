# Entry Signal Worker (Cloudflare)

This worker evaluates streamed candles against a strategy and emits **fresh entry signals**.
It deduplicates signals in D1, so the same entry is only produced once.

## Endpoints

- `POST /api/stream/signal`
  - Input: stream payload with `strategyKey`, `strategyParams`, `backtestSettings`, and `candles[]`
  - Output: `newEntry: true|false` and latest signal payload
- `GET /api/stream/signals?streamId=...&limit=50`
  - Returns recent stored entry signals for a stream
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

## D1 Setup

1. Create D1 DB and bind it as `SIGNALS_DB` in Wrangler config.
2. Apply migration:

```bash
wrangler d1 migrations apply strategy_signals --local
wrangler d1 migrations apply strategy_signals --remote
```

Migration file:
- `workers/migrations/0001_entry_signals.sql`

## Telegram (Optional)

Set worker secrets:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Then send `notifyTelegram: true` in request body.
