# Synthetic Pair Support

This document describes how to generate and use synthetic pair data for backtest and Finder research.

## Overview

Synthetic pairs let you experiment with markets that don't exist as exchange-listed symbols. For example, `BNBPAXG` = `BNBUSDT / PAXGUSDT` produces a different volatility surface than either leg alone.

The synthetic pair system generates an ordinary OHLCV JSON file from two real symbols. Once generated, the data looks like any normal market to the backtest engine, Finder, and other research tools.

## Quick Start

### From the UI

The chart's pair search also accepts `BASE+QUOTE`, such as `AAPL•+NVDA•`
for local IBKR stocks or `BTC+ETH` for Binance symbols. Select the result
marked **Synthetic** by clicking it or using Arrow Down then Enter. It builds
and loads the base/quote ratio at the current chart interval using the same
generator and saved-configuration metadata as Data Mining. Both legs must
exist in their provider catalogs; use `•` to select local IBKR data. If only
one stock leg has `•`, the other bare ticker is treated as IBKR too. Crypto
legs follow the selected Binance Spot/Futures market.

Local IBKR synthetic charts accept overnight and weekend gaps in whole
target bars. The cadence check still requires an adjacent target bar and
rejects a cached series built at a different timeframe.

1. Open the **Data Mining** tab.
2. Scroll to **Synthetic Pair**.
3. Enter **Base Symbol** (e.g. `BNBUSDT`) and **Quote Symbol** (e.g. `PAXGUSDT`).
4. Enter the **Interval** (e.g. `15m`).
5. The derived symbol name updates automatically (e.g. `BNBPAXG`).
6. Click **Generate & Load**.
7. The synthetic chart loads. Run backtests and Finder as usual.

The UI generator targets 50,000 final synthetic bars when the source data overlap allows it. Finder's **Data Window** control can run current-chart and Symbol Universe runs against one fifth of the loaded data; **5/5 newest** is the latest roughly 10,000 bars on a 50,000-bar synthetic series.

### From the CLI

```bash
# Fetch from Binance and generate locally
npm run synthetic:pair -- --base-symbol BNBUSDT --quote-symbol PAXGUSDT --interval 15m --bars 50000

# Use local JSON files (offline, no network)
npm run synthetic:pair -- --base-symbol BNBUSDT --quote-symbol PAXGUSDT --interval 15m --bars 2000 --base-file base.json --quote-file quote.json

# Custom output path and symbol
npm run synthetic:pair -- --base-symbol ETHUSDT --quote-symbol PAXGUSDT --symbol ETHPAXG --interval 5m --bars 8000 --out my-pair.json
```

Output is saved to `price-data/synthetic/<SYMBOL>-<interval>.json` by default.

The run summary distinguishes two different bar counts:

- `AlignedSourceBars` — source candles present in both legs after
  intersection-only alignment, counted before any aggregation.
- `SyntheticBars` — the final target-interval bar count written to the payload.
- `Dropped` — source alignment losses only: base source bars with no aligned
  quote counterpart. Merging several aligned source bars into one target bar
  is aggregation, not a loss, so a fully aligned 8:1 reconstruction reports
  `Dropped=0` while `AlignedSourceBars=8` and `SyntheticBars=1`. When the
  payload was aggregated, a final `Aggregated ...` line names the effective
  source interval.

Import the generated JSON via **Data Mining → Import JSON → Load JSON to Chart**.

## How It Works

### Equal-dollar two-leg execution

Append `@50/50` to a pair to backtest a fixed-quantity long/short portfolio:
`AAPL•+NVDA•@50/50`. The shorthand `AAPL•+NVDA•@` is identical and is
canonicalized to `@50/50`. Crypto pairs such as `BTC+ETH@` work too. Other
allocations are rejected; there is no settings toggle.

The chart and strategy indicators still use BASE / QUOTE. A long signal buys
BASE and shorts QUOTE; a short signal reverses both legs. Each entry allocates
half its configured trade notional to each leg, with commissions charged in
addition. Quantities stay fixed until exit; there is no continuous rebalancing.
Overlapping entries keep their own entry prices. Partial exits close the same
fraction of both legs. For a $1,000 long, BASE +10% and QUOTE +5% earns $25
before costs, rather than the ratio backtest's approximately $47.62.

Entry and exit slippage apply independently to each leg. Fees use both legs'
actual entry/exit notionals. Equity and drawdown mark the remaining leg
quantities to market. Percentage stops, profit targets and break-even use the
combined gross portfolio return relative to the entry notional, before fees
and exit slippage. ATR distances still originate from ratio indicators and
are applied on the entry-relative portfolio price scale. Trade entry/exit
prices remain ratios for chart markers; `Trade.legs` records both legs' sides,
quantities, fills and fees. Fixed ratio-price stop/target lines are omitted
because a portfolio-return threshold has no constant ratio-price equivalent.

The generator retains aligned source OHLC samples, including finer sub-bars.
Intrabar ranges use matched leg extrema; stop/target fills interpolate the
two leg prices in the first source sample bracketing the threshold. A stop
gap fills at the target bar's opening leg prices; TP fills stay capped.
This remains an OHLC approximation with the execution-realism limitations
below. Ratio-only adverse stop-stress envelopes are not supported for `@`.

The mode travels with saved/shared configurations and Finder/Batch symbol
lists. Its in-memory cache identity is separate from a plain ratio pair;
ratio-only disk cache files are bypassed. Finder uses the portfolio's dollar
metrics directly, without the legacy ratio-neutral log adjustment. Full,
compact, OOS and Asset Opportunity next-exit runs use the shared TypeScript
simulator. Fixed-horizon Asset Opportunity measurements use the two leg
returns before costs. Rust acceleration is fenced off for these datasets.
Unfinished next-open bridge bars retain only each leg's known opening price.

Pairs without a suffix retain the existing ratio behavior.

Symbol Universe in [Monte Carlo](monte-carlo.md#symbol-universe) supports ratio
and `@50/50` instruments through the shared TypeScript Batch executor. Leg
samples survive loading, slicing and execution-aware preparation. Each
instrument bootstraps complete records with both legs kept together. Simulations
normalize 50/50 P&L by gross entry notional; ordinary/ratio allocation includes
entry commission. Missing/inconsistent legs fail explicitly. Universe v1
rejects partial exits, keeps separate accounts and does not apply Finder's
pair-neutral ranking transformation.

### Finder execution performance

Single-position `@50/50` runs can use the TypeScript Finder fast path,
including indexed signal preparation and the signal-only scan when no bar
risk, drawdown or Sharpe calculation is required. Both kernels share leg
fills, fees and trade records. Overlapping/trailing/break-even and other
unsupported configurations retain the shared fallback. Rust remains blocked.
Portfolio OHLC conversion is cached for the active position's current candle;
price checks avoid temporary leg-point arrays. Exit fill helpers live outside
the per-bar loop so the TypeScript loader does not create/name functions on
every check. The leg attachment pass merges sorted timestamps directly and
trusts the normalized-source contract instead of building a per-bar Map and
revalidating both source series for every pair.

`scripts/bench-synthetic-equal-weight.ts` exercises deterministic 24,000-bar
windows with 5,699 `true_range_skew_acceptance` signals, commissions and
slippage. Node 22.16.0, three discarded warmups and nine measured runs gave
these median times before/after the optimization:

| Work | Before | After |
| --- | ---: | ---: |
| 30m pair construction | 6.48 ms | 2.71 ms |
| Next-open simulation with Sharpe | 25.53 ms | 4.87 ms |
| Signal-close simulation | 15.05 ms | 3.71 ms |
| Cold pair construction + signals + simulation | 37.96 ms | 16.19 ms |

The cold case rebuilds the pair and strategy features each run; source legs
are already in memory, so it excludes disk/network I/O and does not predict
the complete 1,000-symbol Finder runtime. All nine benchmark result SHA-256
fingerprints match the pre-optimization report. Signal generation is unchanged.
To capture and compare reports (run commands through RTK as required):

```powershell
npm.cmd exec -- esno scripts/bench-synthetic-equal-weight.ts --out artifacts/pair-before.json
npm.cmd exec -- esno scripts/bench-synthetic-equal-weight.ts --compare artifacts/pair-before.json --out artifacts/pair-after.json
```

The comparison rejects differing datasets, signals or result fingerprints.

The cumulative-return Universe workload has a separate benchmark:
`scripts/bench-finder-equal-weight-universe.ts`. It builds 64 cold 24,000-bar
30m pairs with one shared leg, evaluates two cumulative-return percentile
candidates, and verifies the complete scalar result inventory with SHA-256.
It includes pair construction, signal generation, simulation and Sharpe, with
fees and slippage; it excludes disk/network I/O and browser rendering.
One discarded warmup and three measured runs on Node 22.16.0 gave a median
of 1,614 ms before and 1,324 ms after the following changes (18% less time):

- Cumulative Return Percentile Reversion prepares one-bar returns once and
  retains at most four rank series per window. Threshold-only candidates
  reuse compatible ranks. When the actual threshold comparisons permit only
  the minimum and unique maximum, monotone queues replace sorted-window
  percentile updates. Other thresholds retain full percentile ranks, including
  lower-bound tie behavior and the existing signal warmup/reason strings.
- Normalized pair candles reserve their leg field at construction, avoiding
  a separate property store per candle during execution-leg attachment.
- Fixed/percent simulations skip ATR and its OHLC arrays when neither risk
  settings nor filters consume ATR. Adaptive sizing, ATR risk/filter settings
  and the public full precompute API retain their existing ATR series.

Capture with `npm exec -- esno scripts/bench-finder-equal-weight-universe.ts
--out artifacts/universe-before.json`, then repeat with
`--compare artifacts/universe-before.json --out artifacts/universe-after.json`.
All measured result fingerprints matched. This deterministic fixture does
not reproduce a complete 1,001-pair local-data run; host load, history depth,
parameters and filesystem cache state affect the live improvement.

The four-strategy follow-up benchmark uses the production worker pool and
local 30m CSV seeds: `scripts/bench-finder-universe-strategies.ts`. It pairs
64 local assets with AAPL and runs the diagnostic's entropy alignment,
short-term overextension, pivot midpoint and probability-boundary strategies,
with two seeded candidates each, fees, slippage and Sharpe. One warmup and
three measured four-worker runs gave 3,774 ms before and 3,579 ms after the
follow-up changes (about 5% less elapsed time); summed backtest time fell
about 16%. Result inventories matched by SHA-256, including a one-worker
replay. This includes local loading and worker startup, with warmed filesystem
caches; it is not the original 1,001-pair request.

The follow-up counts repeated timestamp gaps to calculate the exact median
cadence without copying/sorting every candle delta, and selects Sharpe's daily
endpoints in that same timestamp pass. Rolling medians use a fixed numeric
buffer rather than allocating splice results on every bar. Normalized 50/50
pair construction attaches validated execution samples during the ratio merge;
non-grid timestamps and skipped invalid ratios retain the general bucket
attachment path. Exhausted idle workers release their dataset heaps while
other strategies finish; result release order and cancellation are unchanged.

Capture with `npm exec -- esno scripts/bench-finder-universe-strategies.ts
--out artifacts/multi-before.json`, then repeat with
`--compare artifacts/multi-before.json --out artifacts/multi-after.json`.
`--workers 1` checks sequential worker parity. The comparison checks CSV
size/mtime identity and all candidate results; do not sync the sources between
reports. The benchmark does not change the source CSVs.

`tests/synthetic-pair-fast-path.spec.ts` compares all trades, leg fills,
metrics and endpoint exclusions against the fallback for long/short/both,
three execution models, 30m and aggregated 4h source data, costs, partials,
confirmation, hold/cooldown and Kelly sizing, with and without retained trades.

### Candle Formula

For each aligned timestamp, the synthetic candle is computed as a ratio:

- `open = base.open / quote.open`
- `close = base.close / quote.close`
- `high = max(open, close, base.high / quote.high, base.low / quote.low)`
- `low = min(open, close, base.high / quote.high, base.low / quote.low)`
- `volume = min(base.volume, quote.volume)`

The two legs' highs and lows need not occur at the same instant. These matched-extreme divisions approximate an inner range; they can miss ratio excursions within a source candle. By default the UI and CLI try to fetch a finer divisible source interval, build the ratio on those sub-bars, then aggregate back to the target interval. This reduces the uncertainty without resolving the path inside each source candle.

### Conservative stop-loss stress test

Use `synthetic:stress-stops` to assume that each source candle's adverse leg extremes coincide:

- Long SL uses `base.low / quote.high` as the possible low.
- Short SL uses `base.high / quote.low` as the possible high.
- The source envelopes are aggregated to the target timeframe.
- A possible stop touch takes priority over TP, including stops on `next_open` entry bars.
- Strategy signals, indicator calculations, entry prices, TP checks, trailing updates and final closing prices use the original matched candles. The widened favorable wick cannot award an additional TP.
- Unfinished target bars contribute only their known opening price; their future wicks are excluded.

This is an adverse stop scenario, not a reconstruction of synchronized prices or a mathematical worst-case bound on total portfolio PNL. Earlier stops change position availability and subsequent entries. Stop gaps and slippage retain the ordinary engine behavior.

Save a copied endpoint request body as `config.json` and run against the two local seed CSVs or OHLCV JSON files. The strategy key must be supplied because the copied body may omit it. On Windows PowerShell use `npm.cmd` to preserve argument names:

```powershell
npm.cmd run synthetic:stress-stops -- --config config.json --strategy dmi_direction_confirmation --base-file price-data/ibkr/csv/30m/MU.csv --quote-file price-data/ibkr/csv/30m/CRWD.csv --source-interval 30m --out artifacts/mu-crwd-stop-stress
```

The runner uses the endpoint's fixed profile: $10,000 initial capital, $1,000 trade amount and 0.1% commission per side. It runs in TypeScript and preserves the supplied parameters, settings, evaluation time and block range. It rebuilds the dataset from the files; the request's `dataset.ref` is not read. For an exact comparison, use the seed snapshots that produced that reference.

Output includes `report.json`, baseline/stress trade lists, `baseline.json` and `envelope.json`. Inspect the report to compare baseline and stress metrics. Importing `envelope.json` into the chart produces a different experiment: it also changes strategy indicators/signals and widens TP checks. It does not reproduce the adverse-only stop run.

The transform APIs and generation CLI also support an explicit outer-envelope mode:

```powershell
npm.cmd run synthetic:pair -- --base-symbol MU --quote-symbol CRWD --symbol MU-CRWD-STRESS --interval 4h --bars 50000 --base-file mu-30m.json --quote-file crwd-30m.json --source-interval 30m --wick-mode worst_case
```

This generates `high = max(open, close, base.high / quote.low)` and `low = min(open, close, base.low / quote.high)`. The payload records `source.wickMode: "worst_case"`, and the default output filename ends in `-stress.json`. Stress generation rejects malformed or non-positive aligned leg OHLC rather than quietly narrowing the range. Ordinary generation remains `matched` by default, including existing chart, Batch and Finder loaders.

The `--source-interval` override accepts a source that divides the target exactly, including local JSON inputs. The default source selector has a 12:1 subdivision cap: a `4h` run normally selects `30m`, even when finer catalog intervals exist. Explicit finer data reduces the stress envelope; use the actual interval of the supplied files.

Internal executor callers can supply `backtestRunOptions.stopLossStressRanges`, a map keyed by `timeKey`, to run the same adverse-only checks. These transient ranges require TypeScript; they are not saved settings or part of the HTTP endpoint request contract. Every intrabar candle checked while a position is active must have a valid positive envelope encompassing its original range. Full, compact, combined, and single-position simulations share this contract.

### Alignment

- Only timestamps present in **both** the base and quote series are used (intersection-only).
- Both inputs are sorted ascending and deduped by last-write-wins before alignment.
- Bars where the quote `open`, `close`, `high`, or `low` are zero or non-finite are dropped.
- If fewer than `minBars` (default 1) valid synthetic bars remain, generation fails with an error.

`meta.alignedBars` / `meta.droppedBars` describe the SOURCE interval: a
dropped bar is a base source bar with no aligned quote bar. The UI's
synthetic diagnostics use the pipeline's effective source interval — when a
finer seed interval was selected but a leg only exists at the target
interval, the fallback reports the target interval and `aggregated: false`
even though a sub-bar interval was initially chosen.

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
| Batch Backtest | Works | Replays the current strategy/settings across pasted real or synthetic pairs |
| OPEN_SCORE USD (Batch) | Works | Historical open-position score replay over Batch synthetic/real pair artifacts |
| TOP_MEAN (Batch) | Works | Explicit IBKR/crypto pair-list coordinator with historical replay and current snapshot output |
| Fast TOP_RAW (Batch) | Works | Marked local stock assets; sampled ratios and full finalist scoring at one frozen endpoint; see [scan guide](top-raw-scan.md) |
| Walk Forward | Works | Operates on active chart data |
| Monte Carlo | Works | Uses backtest results |
| Data Mining export | Works | Export CSV/JSON from loaded synthetic data |

## Unsupported Surfaces

| Surface | Current behavior | Reason |
|---|---|---|
| Worker alerts | Not applicable | Synthetic symbols don't map to real markets |
| Scanner | Skips | Scanner uses provider-backed symbols |
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

Sub-bar reconstruction reduces uncertainty, but synthetic pairs are still research-grade. Matched wicks can omit stop touches; outer-envelope wicks can assume touches that never happened. They do not model cross-leg latency, spread, borrow, hedge slippage, or partial fills. For execution-grade validation, use lower-timeframe or tick data and treat the synthetic pair as signal research rather than fill-truth.

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
| Adverse-only stop stress runner | `scripts/stress-synthetic-stops.ts` |
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

### Pipeline helper

The shared fetch → align → aggregate pipeline lives in `buildSyntheticPairFromLegs()` in `scripts/lib/synthetic-pair.ts`. Data Mining and the shared Batch/Finder loaders route through it, so changes to source-interval resolution, source-bar accounting, or aggregation apply across those consumers. Two options encode the per-callsite variations that previously drifted:

- `sourceBarsCap` — Finder passes `DATA_CHART_TOTAL_LIMIT` to keep remote gap-fill bounded.
- `tailSliceBars` — a caller can trim the final bars to a target limit.
- `allowEmptyLegs` — Data Mining uses this to emit its own per-leg diagnostics before failing.
- `assumeNormalizedLegs` — canonical loaders (Binance sanitize, IBKR CSV
  sort/dedupe, server persistence normalization) return ascending,
  deduplicated, numerically-timed candles, so Batch and Data Mining build
  pairs through the fused normalized transform instead of re-parsing each
  leg. Data Mining verifies each leg with `ensureNormalizedLegBars` at its
  fetch boundary: the scan checks the canonical parser's observable contract
  (numeric, normalized Unix-second times in strict order, finite numeric
  OHLC and volume) and returns canonical input zero-copy; anything else is
  re-normalized through `parseOhlcvBars`, so ISO strings, BusinessDay
  objects, millisecond/string timestamps, duplicates, and invalid rows
  convert exactly like the generic path. The generic
  parser stays for arbitrary external inputs such as the CLI's file mode
  and the Worker API's remote candles.

### IBKR Synthetic Pairs & 4H Aggregation

For IBKR synthetic 4H pairs, 30m seed CSV files (`price-data/ibkr/csv/30m/`) are required. The ratio is built from 30m bars first and then aggregated to 4H to avoid conflating extremes from pre-aggregated 4H legs. The TOP_MEAN Coordinator (`lib/batch-backtest/sp500-pair-enumerator.ts`) enforces this invariant for IBKR legs in the supplied pair list.

### Tests

- `tests/synthetic-pair-transform.spec.ts` — ratio formula, alignment, error handling, payload shape, pipeline helper
- `tests/build-synthetic-pair-script.spec.ts` — CLI argument parsing
- `tests/sp500-pair-enumerator.spec.ts` — IBKR 30m seed availability & canonical pair enumeration
- `tests/asset-search-service.spec.ts` — synthetic search, exact leg lookup, provider markers
- `tests/symbol-search-handler.browser.spec.ts` — click/keyboard loading, metadata, stock session gaps, wrong-timeframe cache rejection
