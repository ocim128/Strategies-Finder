# Backtest Endpoint Usage

## Purpose

Use the local backtest endpoint when you want an external runner such as `Flux.Native` to call this repo as a backtest engine instead of driving the browser UI.

The endpoint is intended for:

- lean single-run metric checks
- fast local batch evaluation
- randomized parameter search
- `1m` and `5m` Polymarket research
- direct-trade research on higher timeframes such as `4h`

## How It Runs

The endpoint is mounted by the Vite plugin in [`vite.config.ts`](../vite.config.ts). It is available when you run either:

```bash
npm run dev
```

or:

```bash
npm run build
npm run preview
```

Default local base URL:

```text
http://localhost:5173/api/backtest
```

There is no separate standalone backtest server in the current implementation.

## Endpoint List

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/backtest/health` | `GET` | health check + strategy manifest fingerprint |
| `/api/backtest/datasets` | `POST` | upload candles once and receive a reusable `datasetRef` |
| `/api/backtest/:strategyKey` | `POST` | single backtest run |
| `/api/backtest/:strategyKey/batch` | `POST` | many runs over one dataset |
| `/api/backtest/:strategyKey/search/random` | `POST` | seeded randomized parameter search |

## Execution Match Rules

If you want the endpoint to match the UI, keep these inputs identical:

- candle array
- `interval`
- `strategyKey`
- `strategyParams`
- `backtestSettings`
- `context.nowSec`
- `context.blockRange`

Important notes:

- Use `engineMode: "typescript"` when you are validating parity against the UI.
- `annotatePolymarket` is opt-in because it adds extra work.
- `2h` execution now uses the single repo-wide close alignment. There is no parity selector in the request contract.
- Single-run responses return slim performance metrics only, not full trade history.

## Endpoint Capital Profile

The HTTP endpoint intentionally does not expose capital or sizing controls.

Every endpoint run uses:

- `initialCapital: 10000`
- `sizingMode: "fixed"`
- `fixedTradeAmount: 1000`
- `commission: 0.1`

This is intentional to keep the endpoint contract smaller and reduce orchestration complexity. If you see the endpoint always sizing trades at `$1000` with `0.1%` commission, that is expected behavior, not a bug.

If you want a UI run to match an endpoint run, set the UI capital inputs to the same fixed profile before comparing results. Legacy caller-supplied `capitalSettings` payloads are ignored by the endpoint.

The UI now has a `Preview Endpoint` button and a `Copy Endpoint` button in the strategy panel header. `Preview Endpoint` reruns the latest regular UI backtest through the exact HTTP endpoint contract locally, so the visible UI result can match the endpoint before you compare anything. `Copy Endpoint` uploads the exact candle set used by that backtest to `/api/backtest/datasets` and copies only the JSON POST body for `/api/backtest/<strategyKey>`, already filled with a real `datasetRef`, instead of embedding the full candle array. The copied payload still includes the latest UI backtest snapshot for strategy params, backtest settings, block range, and deterministic `nowSec`. For cross-symbol strategies, `Preview Endpoint` and `Copy Endpoint` also include the resolved secondary symbol dataset under `crossSymbol`, so the endpoint does not silently refetch different data. For supported Polymarket runs, `Preview Endpoint` and `Copy Endpoint` automatically set Polymarket annotation on in the endpoint contract so the single-run endpoint can return `polymarketPerformance` without requiring a separate manual toggle in the copied JSON. The UI warns you if the previous UI result differed from the endpoint contract. If you switch symbol or timeframe after the backtest ran, switch back or rerun before previewing or copying so the endpoint request still matches the visible UI result. If the local endpoint is down, the button still copies the JSON body with a placeholder `dataset.ref` and shows the exact `/api/backtest/health` URL to verify before you upload candles manually.

## Dataset Cache

`POST /api/backtest/datasets` stores candles in the local Vite process and returns a reusable `datasetRef`.

Current behavior from the implementation:

- cache is in memory only
- refs disappear on server restart
- entries expire after about 30 minutes
- cache is capped to 200 entries
- request body limit is 100 MB

Use cached datasets for batch and random search. Sending huge candle arrays on every request wastes most of the speed benefit.

## Minimal Flow

1. Start the Vite server.
2. Call `/api/backtest/health`.
3. Upload candles to `/api/backtest/datasets`.
4. Reuse the returned `datasetRef` for single, batch, or random-search requests.

## Health Check

PowerShell:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:5173/api/backtest/health"
```

Response shape:

```json
{
  "ok": true,
  "version": "1.0.0",
  "manifest": {
    "strategyCount": 123,
    "hash": "abcd1234"
  },
  "enginePreference": {
    "rustAvailable": true,
    "rustPreferred": false
  }
}
```

Use `manifest.hash` to detect drift between your external runner and the current repo state.

## Upload Dataset

PowerShell:

```powershell
$body = @{
  candles = @(
    @{ time = 1700000000; open = 100; high = 101; low = 99; close = 100.5; volume = 10 },
    @{ time = 1700000300; open = 100.5; high = 102; low = 100; close = 101.5; volume = 12 }
  )
  keyHint = "btc_5m_sample"
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5173/api/backtest/datasets" `
  -ContentType "application/json" `
  -Body $body
```

Response:

```json
{
  "ok": true,
  "datasetRef": "btc_5m_sample",
  "hash": "2fd0...",
  "candleCount": 2,
  "firstTime": 1700000000,
  "lastTime": 1700000300
}
```

## Single Backtest

Route:

```text
POST /api/backtest/:strategyKey
```

Example with cached dataset:

```json
{
  "symbol": "BTCUSDT",
  "interval": "5m",
  "dataset": { "ref": "btc_5m_sample" },
  "strategyParams": {
    "lookback": 20,
    "threshold": 1.5
  },
  "backtestSettings": {
    "executionModel": "next_open",
    "tradeDirection": "short",
    "allowSameBarExit": true,
    "slippageBps": 0,
    "marketMode": "all"
  },
  "context": {
    "nowSec": 1775400000,
    "blockRange": null,
    "annotatePolymarket": false,
    "engineMode": "typescript"
  }
}
```

PowerShell:

```powershell
$body = @{
  symbol = "BTCUSDT"
  interval = "5m"
  dataset = @{ ref = "btc_5m_sample" }
  strategyParams = @{
    lookback = 20
    threshold = 1.5
  }
  backtestSettings = @{
    executionModel = "next_open"
    tradeDirection = "short"
    allowSameBarExit = $true
    slippageBps = 0
    marketMode = "all"
  }
  context = @{
    nowSec = 1775400000
    blockRange = $null
    annotatePolymarket = $false
    engineMode = "typescript"
  }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5173/api/backtest/<strategyKey>" `
  -ContentType "application/json" `
  -Body $body
```

### Cross-Symbol Request

Cross-symbol endpoint runs must include the resolved secondary symbol dataset explicitly:

```json
{
  "symbol": "XRPUSDT",
  "interval": "5m",
  "dataset": { "ref": "xrp_5m_primary" },
  "strategyParams": {
    "lookback": 30,
    "zThreshold": 0.5
  },
  "backtestSettings": {
    "executionModel": "next_open",
    "tradeDirection": "both",
    "marketMode": "all",
    "crossSymbolSecondary": "DOGEUSDT"
  },
  "crossSymbol": {
    "secondarySymbol": "DOGEUSDT",
    "dataset": { "ref": "doge_5m_secondary" }
  },
  "context": {
    "nowSec": 1775400000,
    "blockRange": null,
    "annotatePolymarket": false,
    "engineMode": "typescript"
  }
}
```

If a strategy declares `crossSymbolConfig` and `crossSymbol` is omitted, the endpoint rejects the request instead of silently fetching unrelated data.

Single-run response includes:

- `engineUsed`
- slim `result` metrics only
- compact `result.polymarketPerformance` when `annotatePolymarket` is enabled and scoring data exists
- `requestFingerprint`
- `strategyManifestFingerprint`
- `timingMs`

## Direct Trade On 4H

Nothing special is required for `4h`. Change only the `interval`, candle dataset, and strategy/settings.

Example:

```json
{
  "symbol": "BTCUSDT",
  "interval": "4h",
  "dataset": { "ref": "btc_4h_dataset" },
  "strategyParams": {
    "fastLength": 10,
    "slowLength": 40
  },
  "backtestSettings": {
    "executionModel": "next_open",
    "tradeDirection": "long",
    "marketMode": "all"
  },
  "context": {
    "nowSec": 1775400000,
    "blockRange": null,
    "annotatePolymarket": false,
    "engineMode": "typescript"
  }
}
```

## Batch Backtest

Route:

```text
POST /api/backtest/:strategyKey/batch
```

Use this when one dataset is shared across many parameter sets.

Example:

```json
{
  "symbol": "BTCUSDT",
  "interval": "5m",
  "dataset": { "ref": "btc_5m_sample" },
  "backtestSettings": {
    "executionModel": "next_open",
    "tradeDirection": "short"
  },
  "context": {
    "nowSec": 1775400000,
    "blockRange": null,
    "annotatePolymarket": false,
    "engineMode": "auto"
  },
  "compact": true,
  "items": [
    {
      "id": "run_1",
      "strategyParams": { "lookback": 12, "threshold": 1.1 }
    },
    {
      "id": "run_2",
      "strategyParams": { "lookback": 18, "threshold": 1.6 }
    }
  ]
}
```

If `compact` is `true`, each batch item returns only ranking metrics instead of the full `BacktestResult`.

## Random Search

Route:

```text
POST /api/backtest/:strategyKey/search/random
```

Example:

```json
{
  "symbol": "BTCUSDT",
  "interval": "1m",
  "dataset": { "ref": "btc_1m_dataset" },
  "baseParams": {
    "lookback": 20,
    "threshold": 1.5
  },
  "randomization": {
    "rangePercent": 35,
    "count": 1000,
    "seed": 42,
    "freezeKeys": ["stopLossAtr", "takeProfitAtr"]
  },
  "backtestSettings": {
    "executionModel": "next_open",
    "tradeDirection": "short"
  },
  "context": {
    "nowSec": 1775400000,
    "blockRange": null,
    "annotatePolymarket": false,
    "engineMode": "auto"
  },
  "ranking": {
    "topN": 100,
    "sortPriority": ["expectancy", "profitFactor", "netProfitPercent"],
    "minTrades": 40,
    "maxTrades": 100000
  },
  "compact": true
}
```

Notes:

- random search is deterministic when `seed` is fixed
- `paramSpecs` can override the default percent-range generation per key
- results are filtered by `minTrades` and `maxTrades` before ranking

## Recommended Flux.Native Flow

1. Call `/health` when your runner starts and store `manifest.hash`.
2. Upload each candle dataset once with `/datasets`.
3. Use `engineMode: "typescript"` first to verify parity with UI runs.
4. Switch to `/batch` or `/search/random` after the request contract is stable.
5. Keep the same `nowSec` for all runs in one search job so closed-candle trimming stays deterministic.
6. Re-upload datasets when the Vite server restarts or the ref expires.

## Current Limitations

- built-in strategies only
- no HTTP route for uploading custom strategy code
- dataset cache is process-local and temporary
- no dataset delete endpoint
