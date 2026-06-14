# Synthetic Pair Support

This document describes how to generate and use synthetic pair data for backtest and Finder research.

## Overview

Synthetic pairs let you experiment with markets that don't exist as exchange-listed symbols. For example, `BNBPAXG` = `BNBUSDT / PAXGUSDT` produces a different volatility surface than either leg alone.

The synthetic pair system generates an ordinary OHLCV JSON file from two real symbols. Once generated, the data looks like any normal market to the backtest engine, Finder, and other research tools.

## Quick Start

### From the UI

1. Open the **Data Mining** tab.
2. Scroll to **Synthetic Pair**.
3. Enter **Base Symbol** (e.g. `BNBUSDT`) and **Quote Symbol** (e.g. `PAXGUSDT`).
4. Enter the **Interval** (e.g. `15m`).
5. The derived symbol name updates automatically (e.g. `BNBPAXG`).
6. Click **Generate & Load**.
7. The synthetic chart loads. Run backtests and Finder as usual.

### From the CLI

```bash
# Fetch from Binance and generate locally
npm run synthetic:pair -- --base-symbol BNBUSDT --quote-symbol PAXGUSDT --interval 15m --bars 10000

# Use local JSON files (offline, no network)
npm run synthetic:pair -- --base-symbol BNBUSDT --quote-symbol PAXGUSDT --interval 15m --bars 2000 --base-file base.json --quote-file quote.json

# Custom output path and symbol
npm run synthetic:pair -- --base-symbol ETHUSDT --quote-symbol PAXGUSDT --symbol ETHPAXG --interval 5m --bars 8000 --out my-pair.json
```

Output is saved to `price-data/synthetic/<SYMBOL>-<interval>.json` by default.

Import the generated JSON via **Data Mining → Import JSON → Load JSON to Chart**.

## How It Works

### Candle Formula

For each aligned timestamp, the synthetic candle is computed as a ratio:

- `open = base.open / quote.open`
- `close = base.close / quote.close`
- `high = max(open, close, base.high / quote.high, base.low / quote.low)`
- `low = min(open, close, base.high / quote.high, base.low / quote.low)`
- `volume = min(base.volume, quote.volume)`

By default the UI and CLI also try to fetch a finer divisible source interval, build the ratio on those sub-bars, then aggregate back to the target interval. This captures more realistic intrabar extremes than building directly from target-timeframe bars.

### Alignment

- Only timestamps present in **both** the base and quote series are used (intersection-only).
- Both inputs are sorted ascending and deduped by last-write-wins before alignment.
- Bars where the quote `open`, `close`, `high`, or `low` are zero or non-finite are dropped.
- If fewer than `minBars` (default 1) valid synthetic bars remain, generation fails with an error.

### Symbol Derivation

The default synthetic symbol strips the longest common suffix between the two input symbols:

- `BNBUSDT` + `PAXGUSDT` → common suffix `USDT` → `BNB` + `PAXG` → `BNBPAXG`
- `ETHUSDT` + `PAXGUSDT` → `ETHPAXG`

You can override the symbol name with the `--symbol` CLI flag or by typing a custom name.

## Supported Surfaces

Once synthetic data is loaded as the active chart, these features work normally:

| Surface | Status | Notes |
|---|---|---|
| Manual backtest | Works | No special handling needed |
| Finder (single/random/genetic) | Works | Operates on active chart data |
| Walk Forward | Works | Operates on active chart data |
| Monte Carlo | Works | Uses backtest results |
| Data Mining export | Works | Export CSV/JSON from loaded synthetic data |
| Polymarket annotation | Works | Set `Polymarket Outcome Symbol` to a real leg (e.g. `BTCUSDT`) |

## Polymarket Integration

Synthetic pairs produce strategy signals from the synthetic chart, but Polymarket outcomes are evaluated against real markets. To use Polymarket with a synthetic pair:

1. Generate and load the synthetic pair (e.g. `BTCXRP` from `BTCUSDT` + `XRPUSDT`).
2. In Polymarket Settings, set **Polymarket Outcome Symbol** to the real leg you want to score against (e.g. `BTCUSDT`).
3. Enable **Polymarket Annotation**.
4. Run the backtest as usual.

The backtest signals come from the synthetic pair chart data, but win/loss is scored against the real Polymarket events for the outcome symbol you specified.

This works because the `isSecondMarketPolymarketSupported` gate checks the outcome symbol (when set) instead of the chart symbol. If you leave the outcome symbol empty, it falls back to the chart symbol, which won't match any Polymarket market for synthetic pairs.

## Unsupported Surfaces

| Surface | Current behavior | Reason |
|---|---|---|
| Worker alerts | Not applicable | Synthetic symbols don't map to real markets |
| Scanner | Skips | Scanner uses provider-backed symbols |
| Portfolio Lab | Not tested | Requires multi-symbol provider resolution |
| Polymarket bridge | Not applicable | No CLOB orderbook for synthetic pairs |
| Live streaming | Not applicable | No exchange to stream from |

## Saved Configurations

Synthetic pair metadata is automatically saved with strategy configurations. When you load a saved config that was created while a synthetic pair was active, the system automatically:

1. Reads the stored `baseSymbol` and `quoteSymbol` from the config
2. Re-fetches both legs from the data provider
3. Regenerates the synthetic pair chart
4. Applies the strategy and backtest settings

No manual steps needed — just load the config and the synthetic chart appears.

Old configs without `syntheticPair` metadata continue to work normally (backward compatible).

## Limitations

### Execution realism

Sub-bar reconstruction reduces false TP/SL fills materially, but synthetic pairs are still research-grade. They do not model cross-leg latency, spread, borrow, hedge slippage, or partial fills. For execution-grade validation, use lower-timeframe or tick data and treat the synthetic pair as signal research rather than fill-truth.

### Volume

Synthetic volume uses the less-liquid leg as a proxy: `min(base.volume, quote.volume)`. This is better than zero for filters and diagnostics, but it is still not tradable market volume.

### Provider metadata

Imported synthetic data shows as "synthetic" provider in the Data Mining panel. Some provider-specific features (historical fetch, SQLite sync) don't apply to synthetic symbols.

### Data depth

Synthetic bar count is limited by the overlap between the two input series. If one symbol has significantly fewer bars, the synthetic series will be short.

## Architecture

### Key files

| Purpose | Path |
|---|---|
| Pure transform module | `scripts/lib/synthetic-pair.ts` |
| CLI script | `scripts/build-synthetic-pair.ts` |
| Data Mining UI wiring | `lib/data-mining-manager.ts` (see `generateSyntheticPair()`) |
| Data Mining DOM contract | `lib/data-mining-dom.ts` |
| HTML controls | `html-partials/tab-datamining.html` |

### Data flow

1. User provides two symbols + interval (UI or CLI).
2. Both candle series are fetched via existing `DataManager.fetchDataDetached()` or `fetchBinanceDataWithLimit()`.
3. `buildSyntheticPairDataset()` aligns, computes ratio bars, and applies the less-liquid-leg volume proxy.
4. When a finer divisible interval is available, the UI/CLI build sub-bars first and aggregate them back to the requested interval.
5. Result is loaded via `commitOhlcvData()` + `registerImportedData()`.
6. Backtest/Finder operate on the synthetic data as if it were a normal market.

### Tests

- `tests/synthetic-pair-transform.spec.ts` — ratio formula, alignment, error handling, payload shape
- `tests/build-synthetic-pair-script.spec.ts` — CLI argument parsing
