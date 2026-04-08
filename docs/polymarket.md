# Polymarket Implementation

This repo has two separate Polymarket surfaces:

- Polymarket market-data/chart access
- Polymarket crypto outcome scoring for backtests, Finder, and diagnostics

This document is about the implementation contracts for both, with emphasis on the crypto outcome-scoring path.

## High-Level Map

Core files:

- `lib/polymarket-btc5m.ts`
  Supported crypto outcome target mapping, support checks, and SQLite loaders.
- `lib/polymarket-trade-annotations.ts`
  Trade annotation, scoring, 1m bridge logic, timing profile generation, and summary building.
- `lib/polymarket-outcome-evaluator.ts`
  Headless helper for evaluating a strategy against outcome rows outside the main UI flow.
- `lib/polymarket-panel-service.ts`
  Strategy-panel Polymarket diagnostics tab and bridge export controls.
- `lib/quick-view.ts`
  On-demand Polymarket payout diagnostics in the chart overlay.
- `lib/renderers/tradesRenderer.ts`
  On-demand trade-level Polymarket outcome badges in the Trades panel.
- `lib/finder/finder-runner-polymarket.ts`
  Finder mode that ranks parameter sets by Polymarket outcome performance.
- `scripts/polymarket-sync-outcomes.ts`
  Sync closed crypto outcome rows into local SQLite.
- `lib/dataProviders/polymarket.ts`
  Polymarket event/market data provider for direct event charting.

Settings and UI wiring:

- `html-partials/tab-settings-section-execution.html`
  Backtest Realism controls for Polymarket annotation, outcome target selection, and 1m entry offset.
- `lib/backtest-settings-resolver.ts`
  Default values, localStorage-compatible coercion, and uppercase normalization for `polymarketOutcomeSymbol`.
- `lib/backtest-settings-dom-contract.ts`
  Typed DOM field contract and Rust-support metadata for the Polymarket settings.
- `lib/handlers/state-subscriptions.ts`
  Visibility rules for showing `polymarketOutcomeSymbol` and `polymarketEntryOffset` only when they apply.
- `lib/backtest-endpoint-settings.ts`
  Preserves `polymarketOutcomeSymbol` in the endpoint payload even though the Rust engine does not consume it directly.
- `lib/rust-settings-sanitizer.ts`
  Marks Polymarket annotation fields as Rust-unsupported so they do not drift into the engine request.

Storage and API glue:

- `lib/local-sqlite-polymarket-api.ts`
  Browser-side helpers for loading and storing synced Polymarket outcome rows through the local Vite API.
- `/api/sqlite/load-polymarket-outcomes`
  Reads a time-bounded slice of outcome rows by fixed series id.
- `/api/sqlite/store-polymarket-outcomes`
  Persists synced rows into the local SQLite-backed cache used by scoring and diagnostics.

Key types:

- `lib/types/polymarket-outcomes.ts`
- `lib/types/strategies.ts`

## Two Different Polymarket Features

### 1. Direct Polymarket event charting

This is the provider path for opening a Polymarket event or slug as chart data.

Relevant surfaces:

- `PM` button in the timeframe/header UI
- symbol search accepting Polymarket slugs or URLs
- `lib/dataProviders/polymarket.ts`
- `lib/asset-search-service.ts`

This path is about charting Polymarket market prices directly.

### 2. Polymarket crypto outcome scoring

This is the backtest/Finder path for asking:

- did an executed trade predict the correct 5m crypto event outcome?
- what was the Polymarket price paid for that prediction?
- what was the payout expectancy after entry price?

This path uses locally synced crypto outcome rows from SQLite, not live Polymarket chart candles.

## Supported Crypto Outcome Targets

The repo-level supported 5m crypto outcome target series are:

- `BTCUSDT`
- `ETHUSDT`
- `SOLUSDT`
- `XRPUSDT`

These map to fixed SQLite series ids in `lib/polymarket-btc5m.ts`.

## Outcome Symbol Override

The scoring path now supports a dedicated backtest setting:

- `polymarketOutcomeSymbol`

Behavior:

- empty string means `same as chart`
- a non-empty value must resolve to one of the supported crypto target symbols
- if the override is invalid, the run is treated as unsupported for Polymarket scoring

This is intentionally a backtest setting, not a Finder-only setting.

That keeps one shared contract across:

- regular backtests
- Finder Polymarket mode
- Quick View
- Trades panel
- Polymarket diagnostics tab
- endpoint preview/copy parity

## Current Surface Behavior

| Surface | Chart interval support | Outcome target support | Notes |
| --- | --- | --- | --- |
| Backtest annotation | `5m`, `1m`, `15m`, `1h`, `4h` | supported target series via chart symbol or `polymarketOutcomeSymbol` | requires `executionModel = next_open` |
| Quick View | `5m`, `1m` | uses stored result summary target or current setting | on-demand load |
| Trades panel | `5m`, `1m` | uses stored result summary target or current setting | on-demand load |
| Polymarket diagnostics tab | `5m`, `1m` | uses stored result summary target or current setting | on-demand load |
| Finder Polymarket mode | `1m`, `5m`, `15m`, `1h`, `4h` | supported target series via chart symbol or `polymarketOutcomeSymbol` | dedicated Polymarket ranking path |
| Endpoint preview/copy | same as supported annotation path | preserves `polymarketOutcomeSymbol` | auto-enables annotation for supported runs |
| Bridge export | `5m` only | still chart-symbol based | not cross-symbol aware |
| Ensemble Polymarket | `5m` only | still chart-symbol based | separate implementation path |

## Core Outcome Data Flow

For crypto outcome scoring, the implementation flow is:

1. Resolve the effective outcome target symbol.
2. Convert that symbol to a fixed 5m SQLite `seriesId`.
3. Load outcome rows for the relevant chart time range from `/api/sqlite/load-polymarket-outcomes`.
4. Map executed trades to outcome rows.
5. Annotate each scored trade with:
   - predicted side
   - actual resolved direction
   - win/loss
   - YES price
   - NO price
   - paid entry price
   - selected entry offset when relevant
6. Build a result summary for the run.

The summary is stored on `BacktestResult.polymarketTradeSummary`.

## Local Storage And API Contract

The crypto outcome-scoring path is built around the local SQLite cache, not direct live API calls from the scorer.

Important pieces:

- the sync CLI fetches closed Polymarket event data from remote APIs
- the sync CLI writes normalized rows through `/api/sqlite/store-polymarket-outcomes`
- runtime scoring surfaces load rows through `/api/sqlite/load-polymarket-outcomes`
- the load request is keyed by fixed `seriesId` plus a chart-derived time range
- `lib/local-sqlite-polymarket-api.ts` is the shared browser helper for those calls

That split matters because research-time scoring is intentionally deterministic against a local snapshot. The scorer does not query remote Polymarket APIs on demand.

## Important Result Contract

`BacktestPolymarketTradeSummary` is the shared summary contract for downstream UI consumers.

Important fields:

- `seriesId`
- `outcomeSymbol`
- `outcomeRowsLoaded`
- `scoredTrades`
- `missingOutcomeTrades`
- `unscoredTrades`
- `entryOffset`
- `duplicateTradesIgnored`
- `timingProfile`

`outcomeSymbol` is important because it keeps downstream UI stable after the run is complete.

Without that field, the user could:

1. run a cross-symbol Polymarket backtest
2. change the settings dropdown later
3. accidentally make Quick View or Trades re-load a different target series for the old result

The implementation now stores the resolved outcome target on the result summary to avoid that drift.

## Trade Annotation Rules

The Polymarket scoring path evaluates executed trades, not raw strategy signals.

Important rules:

- `next_open` is the required execution model for scoring
- no trades means no annotation
- unsupported target series means no annotation
- scoring is timestamp-based, not correlation-based

For `5m`:

- trade entry timestamp is matched directly to the 5m outcome event start timestamp

For `1m`:

- the repo uses the 1m -> 5m bridge
- the entry is mapped into the containing 5m event window
- `polymarketEntryOffset` selects minute `0..4`
- one trade per event is scored
- duplicates in the same event are ignored

For `15m`, `1h`, and `4h`:

- the repo groups 5m outcome rows into higher-interval super-events for annotation and Finder scoring

## Finder Polymarket Mode

Finder has a dedicated Polymarket runner instead of layering Polymarket scoring onto the normal Finder sort path.

Implementation details:

- file: `lib/finder/finder-runner-polymarket.ts`
- loads outcome rows once per run
- reuses normal strategy execution and backtest machinery
- ranks parameter sets by Polymarket-specific metrics
- supports `1m`, `5m`, `15m`, `1h`, and `4h`

Important Finder contracts:

- `multiTimeframeEnabled` is blocked in Polymarket mode
- `comboEnabled` is blocked in Polymarket mode
- `grid` and `random` are supported
- `polymarketLockOffset` locks the evaluated minute offset when applicable
- `polymarketAfterTakeProfitOnly` filters the evaluated trade set before scoring

Cross-symbol behavior:

- the chart symbol can be unsupported for crypto Polymarket scoring
- Finder can still score if `backtestSettings.polymarketOutcomeSymbol` is set to a supported target series

Example:

- chart symbol `NEARUSDT`
- outcome target `ETHUSDT`

That is now valid in Finder Polymarket mode.

## UI Consumers

Three UI surfaces can load or reuse Polymarket scoring after a run:

- Trades panel
- Quick View overlay
- Polymarket diagnostics tab

They follow this rule:

- prefer the result's stored `polymarketTradeSummary.outcomeSymbol`
- fall back to the current settings control if the result has no stored target yet

That keeps an already-scored result internally consistent.

## Settings UI

Relevant controls in the Backtest Realism section:

- `polymarketAnnotationEnabled`
- `polymarketOutcomeSymbol`
- `polymarketEntryOffset`

Behavior:

- `polymarketOutcomeSymbol` is only shown when annotation is enabled
- `polymarketEntryOffset` is only shown for `1m` when annotation is enabled

## Endpoint Behavior

Endpoint-related files:

- `lib/backtest-endpoint-copy.ts`
- `lib/backtest-endpoint-execution.ts`
- `lib/backtest-endpoint-settings.ts`
- `docs/backtest-endpoint.md`

Important behavior:

- endpoint preview/copy auto-enables Polymarket annotation for supported runs
- `polymarketOutcomeSymbol` is preserved in the endpoint backtest settings contract
- it is still treated as Rust-unsupported for sanitization
- it is intentionally not stripped from the endpoint request payload so annotation parity can survive copy/preview

## Bridge Export

The Polymarket panel also has bridge export tools for downstream `external_signal` consumers.

Relevant surfaces:

- `html-partials/tab-polymarket.html`
- `lib/polymarket-panel-service.ts`
- `scripts/export-latest-entry-signal.ts`
- `scripts/export-latest-ensemble-entry-signal.ts`

Current limitation:

- bridge export remains chart-symbol based
- it currently supports the supported crypto chart symbols on `5m`
- it does not currently use `polymarketOutcomeSymbol` as an alternate target

That is intentional separation. The bridge path is not the same contract as research-time scoring.

## Change Checklist

If you change Polymarket behavior, verify the correct contract instead of patching one surface in isolation.

- If you add or rename a Polymarket settings control, update the partial, `lib/backtest-settings-resolver.ts`, `lib/backtest-settings-dom-contract.ts`, `lib/handlers/state-subscriptions.ts`, and the compatibility tests together.
- If you add a new supported crypto outcome target, update `lib/polymarket-btc5m.ts`, the sync script input validation, support messages, and focused Polymarket tests together.
- If you change trade annotation semantics, recheck regular backtests, Finder Polymarket mode, Quick View, Trades, and the Polymarket diagnostics tab. They all consume the same scored-trade contract.
- If you change endpoint parity behavior, recheck `lib/backtest-endpoint-settings.ts`, `lib/backtest-endpoint-copy.ts`, `lib/backtest-endpoint-execution.ts`, and `docs/backtest-endpoint.md`.
- If you touch bridge export, keep `lib/polymarket-panel-service.ts`, `scripts/export-latest-entry-signal.ts`, and `scripts/export-latest-ensemble-entry-signal.ts` aligned.

## Syncing Outcome Rows

Before crypto outcome scoring works, the local SQLite outcome rows must exist.

Commands:

```bash
npm run poly:sync-outcomes:all
```

Single symbol:

```bash
..\..\..\node_modules\.bin\esno scripts\polymarket-sync-outcomes.ts --symbol BTCUSDT
```

Repair recent rows:

```bash
npm run poly:sync-outcomes:repair
```

The sync script writes outcome rows used by:

- annotation
- Finder Polymarket mode
- Quick View
- Trades panel
- Polymarket diagnostics tab

## Headless Evaluation Helper

`lib/polymarket-outcome-evaluator.ts` exists for code-level evaluation outside the main UI backtest path.

Use it when you already have:

- chart candles
- a strategy
- strategy params
- outcome rows

Important contract:

- the evaluator itself is generic over `chartData + outcomes`
- the repo-level support restriction mainly comes from which outcome series can be loaded from SQLite

## Known Limitations

- supported crypto outcome target series are still fixed to `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, and `XRPUSDT`
- bridge export is not cross-symbol aware
- Ensemble Polymarket is still same-symbol `5m`
- Quick View, Trades, and the Polymarket tab only do on-demand reload for `5m` and `1m`
- direct Polymarket event charting is a different provider path than crypto outcome scoring
- scoring says whether a timed prediction matched the resolved outcome, not whether the chart symbol is causally predictive

## Validation Targets

Focused tests:

- `tests/polymarket-trade-annotations.spec.ts`
- `tests/finder-polymarket.spec.ts`
- `tests/polymarket-outcome-evaluator.spec.ts`
- `tests/quick-view-polymarket.spec.ts`
- `tests/feature-dom-contracts.spec.ts`

Useful commands:

```bash
npm run typecheck
```

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-trade-annotations.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\finder-polymarket.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

## Practical Rule Of Thumb

If you are changing Polymarket behavior, ask which contract you are touching:

- provider-side Polymarket charting
- crypto outcome series resolution
- trade annotation semantics
- Finder Polymarket ranking
- diagnostics rendering
- endpoint parity
- bridge export

Most breakage in this area comes from mixing those contracts together instead of keeping them explicit.
