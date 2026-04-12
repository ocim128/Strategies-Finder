# Polymarket Guide

This repo has multiple Polymarket features that look related in the UI but use different contracts in code.

The main split is:

- direct Polymarket market charting
- Polymarket crypto outcome scoring for backtests and Finder
- diagnostics and deployability analysis on scored runs
- bridge export for downstream `external_signal` bots

Most breakage here comes from mixing those paths together.

## Quick Answers

If you want to open a Polymarket market on the chart:

- use the `PM` button in the timeframe bar, or search/paste a Polymarket slug or event URL
- this goes through the Polymarket data provider, not the outcome-scoring path

If you want to score a strategy against resolved Polymarket crypto events:

- enable `Polymarket Annotation`
- use `executionModel = next_open`
- sync local outcome rows first with `npm run poly:sync-outcomes:all`
- optionally set `Polymarket Outcome Symbol` if the chart symbol is different from the outcome target

If you want bot bridge files for `external_signal`:

- use the `Polymarket` strategy-panel tab
- select a saved config
- stay on a supported `5m` chart for `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, or `XRPUSDT`

## The Four Polymarket Contracts

### 1. Direct Polymarket market charting

This is the provider path for opening a real Polymarket event market as chart data.

Important behavior:

- accepts full Polymarket event URLs
- accepts canonical inputs like `PM:<slug>`, `polymarket:<slug>`, or plain event slugs
- accepts side selection via `:up`, `:down`, `:yes`, `:no`, or URL query params `outcome` / `side`
- the `PM` button opens Polymarket markets on `1m` first
- chart candles come from Polymarket history, not SQLite outcome rows

Core files:

- `lib/dataProviders/polymarket.ts`
- `lib/asset-search-service.ts`
- `lib/handlers/ui-event-handlers.ts`
- `html-partials/header.html`

### 2. Crypto outcome scoring

This is the research path for asking whether executed trades would have predicted the resolved crypto event correctly and what price would have been paid on Polymarket.

Important behavior:

- scores executed trades, not raw signals
- uses local SQLite outcome rows, not live Polymarket fetches
- requires `next_open`
- supports outcome-symbol override through `polymarketOutcomeSymbol`
- stores the resolved target on `BacktestResult.polymarketTradeSummary.outcomeSymbol` so later UI reloads do not drift

Core files:

- `lib/polymarket-btc5m.ts`
- `lib/polymarket-trade-annotations.ts`
- `lib/polymarket-outcome-evaluator.ts`
- `lib/backtest-service.ts`
- `lib/backtest-executor.ts`
- `lib/finder/finder-runner-polymarket.ts`

### 3. Diagnostics and deployability analysis

This is the read/analysis layer on top of scored trades.

It powers:

- Quick View payout diagnostics
- Trades panel outcome badges
- the `Polymarket` strategy-panel diagnostics tab
- fillability and deployability analysis in the Polymarket tab

Important behavior:

- Quick View and Trades can reuse stored trade annotations or stored summary from an already-scored result
- the Polymarket tab actively reloads outcome rows only for the `1m` / `5m` bridge-supported surface
- the Polymarket tab also enriches rows with CLOB history snapshots to estimate whether a target cents price was realistically fillable during the event window

Core files:

- `lib/quick-view.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`
- `lib/polymarket-fill-history.ts`
- `lib/polymarket-deployability-analysis.ts`

### 4. Bridge export

This is a separate contract for generating local bridge files and bot env snippets.

Important behavior:

- uses the current chart symbol and interval, not `polymarketOutcomeSymbol`
- requires a saved config
- only supports supported crypto symbols on `5m`
- blocks cross-symbol strategies
- exports `polymarketEntryOffset` into the signal payload when present

Core files:

- `html-partials/tab-polymarket.html`
- `lib/polymarket-panel-service.ts`
- `scripts/export-latest-entry-signal.ts`
- `scripts/export-latest-ensemble-entry-signal.ts`

## Supported Outcome Targets

The repo-level Polymarket crypto outcome target symbols are fixed:

- `BTCUSDT`
- `ETHUSDT`
- `SOLUSDT`
- `XRPUSDT`

These map to fixed SQLite `series_id` values in `lib/polymarket-btc5m.ts`.

If you add another target, update:

- `lib/polymarket-btc5m.ts`
- `scripts/polymarket-sync-outcomes.ts`
- `html-partials/tab-settings-section-execution.html`
- support messages in Finder / panel / ensemble paths
- focused Polymarket tests

## Current Support Matrix

| Surface | Symbol / target rule | Interval support | Important notes |
| --- | --- | --- | --- |
| Direct Polymarket charting | any valid Polymarket event slug or URL | provider can aggregate to requested chart interval; PM button opens `1m` first | charting path only |
| Backtest annotation | chart symbol must resolve to a supported target, or `polymarketOutcomeSymbol` must override to one | `1m`, `5m`, `15m`, `1h`, `4h` | requires `next_open` |
| Headless `evaluatePolymarketOutcomes(...)` | caller supplies outcome rows directly | depends on supplied chart data and rows | still `next_open` only |
| Finder Polymarket mode | same target-resolution rule as backtests | `1m`, `5m`, `15m`, `1h`, `4h` | `grid` and `random` only; no combo; no multi-timeframe |
| Endpoint Preview / Copy | same target-resolution rule as backtests | same as backtest annotation | auto-enables endpoint annotation for supported runs |
| Quick View | can reuse stored scored result; lazy reload path uses active target resolution | stored-result reuse is broad; active lazy reload is `1m` / `5m` | prefers stored summary target |
| Trades panel | can reuse stored scored result; lazy reload path uses active target resolution | stored-result reuse is broad; active lazy reload is `1m` / `5m` | prefers stored summary target |
| Polymarket diagnostics tab | same target-resolution rule as backtests | `1m`, `5m` | active diagnostics tab and bridge export are separate features sharing one panel |
| Bridge export | current chart symbol only | `5m` | saved config required; no cross-symbol strategies |
| Ensemble Polymarket | current chart symbol only | `5m` | separate implementation path |

Two important nuances:

- Backtest scoring and Finder support more intervals than the Polymarket diagnostics tab.
- `polymarketOutcomeSymbol` helps research-time scoring, but bridge export intentionally stays chart-symbol based.

## Outcome Data Model

Outcome scoring is built around local SQLite rows, not live remote fetches during evaluation.

Main row contract: `lib/types/polymarket-outcomes.ts`

Each `PolymarketOutcomeRow` contains:

- fixed `series_id`
- event and market slug
- `event_start_ts` and `event_end_ts`
- YES and NO token ids
- YES checkpoint prices at:
  - open
  - `+1m`
  - `+2m`
  - `+3m`
  - `+4m`
- `resolved_outcome_up`

Browser-side load/store helpers:

- `lib/local-sqlite-polymarket-api.ts`
- `/api/sqlite/load-polymarket-outcomes`
- `/api/sqlite/store-polymarket-outcomes`

The outcome-scoring path is intentionally deterministic against the local snapshot. It does not query remote Polymarket APIs on demand.

## Sync Workflow

Outcome scoring only works after the local SQLite rows exist.

Run from this repo with `npm run dev` active unless you are using `--dry-run`.

Common commands:

```bash
npm run poly:sync-outcomes
```

```bash
npm run poly:sync-outcomes:all
```

```bash
npm run poly:sync-outcomes:repair
```

```bash
npm run poly:sync-outcomes:repair:all
```

Direct single-symbol sync:

```bash
..\..\..\node_modules\.bin\esno scripts\polymarket-sync-outcomes.ts --symbol BTCUSDT
```

Useful notes from the current script:

- default `npm run poly:sync-outcomes` syncs the default BTC series
- `--all` walks all supported symbols
- existing rows are skipped by default
- `--refresh-recent <n>` or the `:repair` scripts rewrite recent rows after sync logic changes
- the script fetches remote Polymarket data, normalizes it, then writes through the local Vite SQLite endpoint

## How Scoring Works

### 5m

- direct event match
- trade entry timestamp must match the 5m outcome event start

### 1m

- uses the `1m -> 5m` bridge
- `polymarketEntryOffset` selects minute `0..4`
- only trades entering on the selected offset score
- duplicate trades in the same event bucket are ignored
- the backtest summary stores `duplicateTradesIgnored` and a full `timingProfile`

### 15m, 1h, 4h

- groups multiple 5m rows into a larger super-event
- `15m` uses offsets `0..2`
- `1h` uses offsets `0..11`
- `4h` uses offsets `0..47`
- Finder can evaluate all valid offsets or lock one with `polymarketLockOffset`
- the manual UI only exposes `polymarketEntryOffset` on `1m`, so ordinary UI backtests on these larger intervals effectively use the default offset unless the setting is injected another way

## Finder Polymarket Mode

Finder uses a dedicated Polymarket runner instead of bolting scoring onto the normal sort path.

Current behavior:

- file: `lib/finder/finder-runner-polymarket.ts`
- loads outcome rows once per run
- supports cross-symbol outcome scoring through `backtestSettings.polymarketOutcomeSymbol`
- reuses normal strategy execution and backtest machinery
- ranks by Polymarket-specific metrics such as accuracy, expectancy, or profit factor

Current restrictions:

- `grid` and `random` only
- `multiTimeframeEnabled` is blocked
- `comboEnabled` is blocked

Current offset behavior:

- `1m` evaluates minute offsets `0..4`
- `15m`, `1h`, and `4h` evaluate sub-event offsets for the grouped super-events
- `polymarketLockOffset` only matters in random mode for multi-sub-event intervals

## Settings and Persistence

User-facing controls live in the Backtest Realism section:

- `polymarketAnnotationEnabled`
- `polymarketOutcomeSymbol`
- `polymarketEntryOffset`

Current UI rules:

- `polymarketOutcomeSymbol` only shows when annotation is enabled
- `polymarketEntryOffset` only shows when annotation is enabled and the chart interval is `1m`

Resolver and compatibility files:

- `lib/backtest-settings-resolver.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/rust-settings-sanitizer.ts`

Important compatibility points:

- `polymarketOutcomeSymbol` is normalized to uppercase
- Polymarket settings are marked Rust-unsupported
- endpoint copy/preview preserves `polymarketOutcomeSymbol` in the request contract even though Rust does not consume it directly

## Endpoint Behavior

Relevant files:

- `lib/backtest-endpoint-copy.ts`
- `lib/backtest-endpoint-execution.ts`
- `lib/backtest-endpoint-settings.ts`
- `docs/backtest-endpoint.md`

Current behavior:

- Preview / Copy auto-enable endpoint annotation for supported Polymarket runs
- the copied payload keeps the selected `polymarketOutcomeSymbol`
- this is done for parity with the visible UI backtest snapshot

Important implication:

- the endpoint contract is broader than the visible toggle state because supported runs are auto-annotated for convenience and parity

## Polymarket Tab: Diagnostics vs Bridge Export

The `Polymarket` strategy-panel tab contains two different features:

- Bridge Export
- Polymarket Diagnostics

Diagnostics focuses on scored historical trades and includes:

- payout expectancy by event price
- break-even win rate and edge versus break-even
- timing buckets
- snapshot filter suggestions
- fill-adjusted deployability analysis using background Polymarket history fetches

Bridge Export focuses on downstream automation and includes:

- saved-config selection
- downloadable PowerShell bridge script
- bot env snippet copy
- latest-entry export integration

Do not treat a change to one as automatically affecting the other.

## Bridge Export Contract

Bridge export is intentionally narrower than research-time scoring.

Current rules:

- chart must be a supported `5m` crypto symbol
- saved config must exist
- referenced strategy must still be available in the registry
- cross-symbol strategies are rejected
- export uses the current chart symbol and interval
- export keeps `polymarketEntryOffset` in the JSON signal payload when present
- export does not switch to `polymarketOutcomeSymbol`

Downstream surfaces tied to this contract:

- `scripts/export-latest-entry-signal.ts`
- `scripts/export-latest-ensemble-entry-signal.ts`
- `workers/README.md`

## Change Checklist

If you touch Polymarket code, first decide which contract you are editing:

- provider-side charting
- outcome-symbol resolution
- trade annotation semantics
- Finder Polymarket ranking
- diagnostics rendering
- fillability / deployability analysis
- endpoint parity
- bridge export

Then verify the matching files together.

### If you change direct charting

Update together:

- `lib/dataProviders/polymarket.ts`
- `lib/asset-search-service.ts`
- `lib/handlers/ui-event-handlers.ts`

### If you change settings or persistence

Update together:

- `html-partials/tab-settings-section-execution.html`
- `lib/backtest-settings-resolver.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/handlers/state-subscriptions.ts`
- settings compatibility tests

### If you change scoring semantics

Recheck together:

- `lib/polymarket-trade-annotations.ts`
- `lib/backtest-service.ts`
- `lib/backtest-executor.ts`
- `lib/polymarket-outcome-evaluator.ts`
- `lib/finder/finder-runner-polymarket.ts`
- `lib/quick-view.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`

### If you change bridge export

Keep aligned:

- `lib/polymarket-panel-service.ts`
- `scripts/export-latest-entry-signal.ts`
- `scripts/export-latest-ensemble-entry-signal.ts`
- `workers/README.md`

## Validation Targets

Core:

```bash
npm run typecheck
```

Focused Polymarket tests:

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-trade-annotations.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\finder-polymarket.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-outcome-evaluator.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\quick-view-polymarket.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-deployability-analysis.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

## Rule Of Thumb

Use this mental shortcut:

- charting a market uses the Polymarket provider
- scoring a backtest uses local SQLite outcome rows
- diagnostics read scored results and sometimes reload missing rows
- bridge export is a bot-facing file-generation path with tighter rules

When those are kept separate, Polymarket changes stay predictable.
