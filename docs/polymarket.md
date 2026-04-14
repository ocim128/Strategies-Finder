# Polymarket Guide

This repo has several Polymarket features that share UI space but use different runtime contracts.

Keep these paths separate:

- direct Polymarket market charting
- Polymarket outcome scoring for backtests, Finder, and Hunt
- diagnostics and deployability analysis on scored trades
- bridge export for downstream `external_signal` bots

Most Polymarket regressions come from mixing those paths together.

## Quick Answers

If you want to open a Polymarket market on the chart:

- use the `PM` button in the timeframe bar, or search/paste a Polymarket slug or event URL
- this uses the Polymarket data provider, not the outcome-scoring path

If you want to score a strategy against resolved Polymarket crypto events:

- enable `Polymarket Annotation`
- use `executionModel = next_open`
- sync local outcome rows first with `npm run poly:sync-outcomes:all`
- optionally set `Polymarket Outcome Symbol` if the chart symbol is different from the outcome target
- choose `Polymarket Exit Mode`:
  - `resolve_hold` scores at final event resolution
  - `signal_exit_same_event` is `1m` + `next_open` only and uses locally cached Polymarket price points for same-event entry and exit pricing

If you want bridge files for `external_signal`:

- use the `Polymarket` strategy-panel tab
- select a saved config
- stay on a supported `5m` chart
- bridge export does not consume `polymarketExitMode`; it stays an entry-signal bundle contract

If you want endpoint Preview / Copy or Strategy Ensemble parity:

- both stay on `resolve_hold`
- `signal_exit_same_event` is explicitly fenced out there

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

### 2. Outcome scoring and annotation

This is the research path for asking whether executed chart trades would have been correct on the Polymarket contract and, in `1m` signal-exit mode, what the realized Polymarket trade PnL would have been.

Important behavior:

- scores executed trades, not raw signals
- uses local SQLite outcome rows, not live outcome fetches during evaluation
- `signal_exit_same_event` also uses local SQLite price points for intra-event pricing
- `lib/polymarket-outcome-evaluator.ts` remains the headless resolve-hold helper when the caller only supplies outcome rows
- stores the resolved target on `BacktestResult.polymarketTradeSummary.outcomeSymbol` so later UI reloads do not drift
- stores the applied evaluation mode on `BacktestResult.polymarketTradeSummary.evaluationMode`

Core files:

- `lib/polymarket-btc5m.ts`
- `lib/polymarket-trade-annotations.ts`
- `lib/polymarket-outcome-evaluator.ts`
- `lib/polymarket-exit-mode.ts`
- `lib/polymarket-signal-exit-evaluator.ts`
- `lib/polymarket-price-points.ts`
- `lib/polymarket-price-points-ingest.ts`
- `lib/backtest-service.ts`
- `lib/finder/finder-runner-polymarket.ts`

### 3. Diagnostics and deployability analysis

This is the read and analysis layer on top of scored trades.

It powers:

- Quick View payout diagnostics
- Trades panel outcome badges
- the `Polymarket` strategy-panel diagnostics tab
- fillability and deployability analysis in the Polymarket tab

Important behavior:

- Quick View, Trades, and the Polymarket tab can rebuild Polymarket annotations lazily
- when the active result uses `signal_exit_same_event`, the lazy rebuild path also ensures local price points before recomputing
- the Polymarket tab still has its own fillability and deployability analysis path using Polymarket history snapshots

Core files:

- `lib/quick-view.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`
- `lib/polymarket-diagnostics-utils.ts`
- `lib/polymarket-fill-history.ts`
- `lib/polymarket-deployability-analysis.ts`

### 4. Bridge export

This is a separate contract for generating local bridge files and bot env snippets.

Important behavior:

- uses the current chart symbol and interval, not `polymarketOutcomeSymbol`
- requires a saved config
- only supports supported crypto symbols on `5m`
- blocks cross-symbol strategies
- keeps `polymarketEntryOffset` in the JSON signal payload when present
- does not switch to `signal_exit_same_event`

Core files:

- `html-partials/tab-polymarket.html`
- `lib/polymarket-panel-service.ts`
- `scripts/export-latest-entry-signal.ts`
- `scripts/export-latest-ensemble-entry-signal.ts`

## Exit Modes

### `resolve_hold`

This is the default mode.

Behavior:

- keeps the existing final-outcome scoring path
- `5m` uses direct event matching
- `1m` uses the `1m -> 5m` bridge plus `polymarketEntryOffset`
- Finder also supports the existing `15m`, `1h`, and `4h` resolve-hold paths
- metrics stay classification-first: wins, losses, win rate, baseline delta, break-even style payout diagnostics

### `signal_exit_same_event`

This is the new pricing-aware mode.

Effective gating:

- annotation must be enabled
- chart interval must be `1m`
- execution model must be `next_open`
- otherwise the effective mode downgrades to `resolve_hold` through `resolveEffectivePolymarketExitMode(...)`

Behavior:

- uses the normal chart backtest only for timing
- because chart timing comes from the shared `next_open` engine, a full `signal` exit blocks re-entry on that same bar; the earliest new chart entry is the next `1m` bar
- long trades buy YES; short trades buy NO
- entry fill uses the first locally captured side price at or after the chart trade entry timestamp inside the containing `5m` event
- if `trade.exitReason === "signal"` and the chart exit timestamp is still inside the same event, exit fill uses the latest locally captured side price at or before the chart exit timestamp
- the signal-exit quote must be later than the chosen entry quote
- if no same-event signal exit applies, the Polymarket leg settles to final binary resolution at event end
- only the first eligible trade per `5m` event is scored; later duplicates in that event are ignored
- if the entry quote is missing, the trade is unscored
- if a same-event signal exit is required but no usable exit quote exists, the trade is unscored and counted as a missing-price trade
- only `exitReason === "signal"` can close early in this mode; stop-loss, take-profit, trailing stop, time stop, partial, probation fail, and end-of-data all settle at final outcome

PnL semantics:

- `marketPnl = marketExitPrice - marketEntryPrice`
- `isProfitable` means realized Polymarket PnL was greater than zero
- zero PnL is neutral, not profitable and not losing
- Quick View and the Polymarket diagnostics tab label signal-exit rates as profitable-trade rates, not prediction-accuracy win rates
- neutral scored trades stay visible as neutral / flat instead of being folded into losses
- summary metrics shift to priced-trade behavior:
  - profitable trades
  - losing trades
  - signal-exited trades
  - resolved trades
  - missing-price trades
  - net PnL
  - expectancy
  - profit factor

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

## Support Matrix

| Surface | `resolve_hold` | `signal_exit_same_event` | Important notes |
| --- | --- | --- | --- |
| Direct Polymarket charting | not applicable | not applicable | provider path only |
| Manual backtest annotation | current shared scoring path | `1m` + `next_open` only | same chart backtest, Polymarket post-pass |
| Headless `evaluatePolymarketOutcomes(...)` | resolve-hold only | not supported | caller supplies outcome rows only; no price-point input surface |
| Finder Polymarket mode | `1m`, `5m`, `15m`, `1h`, `4h` | `1m` + `next_open` only | `grid` and `random` only; no combo; no multi-timeframe |
| Hunt | same as Finder | same as Finder | preserves `polymarketExitMode` in profiles |
| Quick View / Trades / Polymarket diagnostics reload | can reuse stored summary broadly | `1m` only when price points are available or can be ensured | active consumers, not passive renderers |
| Endpoint Preview / Copy / HTTP execution | `resolve_hold` only | not supported | `polymarketExitMode` is stripped |
| Strategy Ensemble Polymarket | `resolve_hold` only | not supported | explicit fence in the ensemble path |
| Bridge export | separate contract | separate contract | ignores `polymarketExitMode`; still chart-symbol `5m` entry-signal export |

Two important nuances:

- `signal_exit_same_event` is intentionally narrower than general Polymarket scoring.
- endpoint and ensemble surfaces still expose Polymarket annotation, but only in `resolve_hold`.

## Outcome And Price Data Model

Outcome scoring is built around local SQLite rows, not live remote outcome fetches during evaluation.

Main outcome-row contract:

- `lib/types/polymarket-outcomes.ts`

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

Signal-exit mode adds a second local data surface:

- SQLite table: `polymarket_price_points`
- browser API: `loadPolymarketPricePoints(...)`
- browser API: `storePolymarketPricePoints(...)`
- browser API: `ensurePolymarketPricePoints(...)`

Each `PolymarketPricePoint` contains:

- `series_id`
- `event_start_ts`
- `event_end_ts`
- `market_slug`
- YES and NO token ids
- quote timestamp `ts`
- `yes_price`
- `no_price`
- `updated_at`

Relevant Vite SQLite routes:

- `/api/sqlite/load-polymarket-outcomes`
- `/api/sqlite/store-polymarket-outcomes`
- `/api/sqlite/load-polymarket-price-points`
- `/api/sqlite/store-polymarket-price-points`
- `/api/sqlite/ensure-polymarket-price-points`

Important behavior:

- price points are event-keyed, not treated as one continuous market series
- `ensurePricePointsForOutcomes(...)` loads existing local rows by event start, fetches missing event histories, then stores the missing rows locally
- first-run `1m` signal-exit backtests or Finder runs may trigger on-demand price-point ingestion
- there is no separate manual sync command required for price points
- outcome rows still require the normal `poly:sync-outcomes` flow

## Sync Workflow

Outcome scoring only works after the local SQLite outcome rows exist.

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

Useful notes:

- default `npm run poly:sync-outcomes` syncs the default BTC series
- `--all` walks all supported symbols
- existing rows are skipped by default
- `--refresh-recent <n>` or the `:repair` scripts rewrite recent rows after sync logic changes
- the sync script fetches remote Polymarket outcome data, normalizes it, then writes through the local Vite SQLite endpoint

Price points are different:

- they are ensured on demand by the scoring surfaces that need them
- they are fetched from Polymarket history by event and cached into `polymarket_price_points`

## Finder And Hunt Behavior

Finder uses a dedicated Polymarket runner instead of bolting scoring onto the normal sort path.

Current behavior:

- file: `lib/finder/finder-runner-polymarket.ts`
- loads outcome rows once per run
- in `signal_exit_same_event`, ensures price points once per run
- supports cross-symbol outcome scoring through `backtestSettings.polymarketOutcomeSymbol`
- reuses normal strategy execution and backtest machinery
- applies signal-exit evaluation through the shared evaluator, not a Finder-only pricing path

Signal-exit restrictions:

- `grid` and `random` only
- `multiTimeframeEnabled` is blocked
- `comboEnabled` is blocked
- supported rank modes:
  - `expectancy`
  - `expectancyTrades`
  - `profitFactor`
  - `profitFactorTrades`
- blocked rank modes:
  - `balanced`
  - `accuracy`
  - `volume`

Important signal-exit differences versus the old `1m` bridge mode:

- Finder does not fan out one parameter set into five offset variants
- `polymarketEntryOffset` is ignored in signal-exit mode
- `polymarketLockOffset` becomes irrelevant and the UI disables it
- applying a Finder result preserves `polymarketExitMode` and only writes `polymarketEntryOffset` back when the effective mode is still `resolve_hold`

Hunt behavior:

- Hunt preserves `polymarketExitMode` in run settings and saved profiles
- Hunt inherits the actual execution logic from Finder
- applying a Hunt survivor follows the same mode-aware rule as Finder result application

## Settings And Persistence

User-facing controls live in the Backtest Realism section:

- `polymarketAnnotationEnabled`
- `polymarketOutcomeSymbol`
- `polymarketEntryOffset`
- `polymarketExitMode`

Current UI rules:

- `polymarketOutcomeSymbol` shows when annotation is enabled
- `polymarketExitMode` shows when annotation is enabled
- `polymarketEntryOffset` only shows when annotation is enabled, interval is `1m`, and the selected exit mode is not `signal_exit_same_event`
- Finder and Hunt rank-mode dropdowns disable unsupported rank modes when signal-exit mode is selected

Persistence and compatibility:

- `polymarketExitMode` defaults to `resolve_hold`
- invalid persisted values normalize back to `resolve_hold`
- Hunt uses the same default and normalization behavior
- `polymarketOutcomeSymbol` is normalized to uppercase
- `polymarketEntryOffset` stays persisted for backward compatibility even when ignored by signal-exit mode
- Polymarket settings are Rust-unsupported
- `signal_exit_same_event` requires the TypeScript engine

Resolver and compatibility files:

- `lib/backtest-settings-resolver.ts`
- `lib/settings-model.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/rust-settings-sanitizer.ts`

## Endpoint, Ensemble, And Bridge Fences

These fences are intentional. Do not assume shared helper growth means parity everywhere.

Endpoint behavior:

- endpoint Preview / Copy auto-enable Polymarket annotation for supported runs
- endpoint request building strips `polymarketExitMode`
- endpoint execution therefore stays on `resolve_hold`

Relevant files:

- `lib/backtest-endpoint-copy.ts`
- `lib/backtest-endpoint-execution.ts`
- `lib/backtest-endpoint-settings.ts`
- `docs/backtest-endpoint.md`

Strategy Ensemble behavior:

- Strategy Ensemble Polymarket remains `resolve_hold` only
- signal-exit support is intentionally not wired there yet

Relevant file:

- `lib/strategy-ensemble-service.ts`

Bridge export behavior:

- still uses chart symbol plus chart interval
- still requires supported `5m` crypto symbols
- still blocks cross-symbol strategies
- still exports entry-signal files, not exit-mode research state

## Polymarket Tab: Diagnostics vs Bridge Export

The `Polymarket` strategy-panel tab contains two different features:

- Bridge Export
- Polymarket Diagnostics

Diagnostics focuses on scored historical trades and includes:

- payout expectancy by event price
- break-even win rate and edge versus break-even in `resolve_hold`
- signal-exit counts and realized PnL metrics in `signal_exit_same_event`
- timing buckets
- snapshot profile diagnostics
- fill-adjusted deployability analysis

Bridge Export focuses on downstream automation and includes:

- saved-config selection
- downloadable PowerShell bridge script
- bot env snippet copy
- latest-entry export integration

Do not treat a change to one as automatically affecting the other.

## Change Checklist

If you touch Polymarket code, first decide which contract you are editing:

- provider-side charting
- outcome-symbol resolution
- `resolve_hold` scoring semantics
- `signal_exit_same_event` pricing semantics
- local price-point storage or ingestion
- Finder or Hunt Polymarket ranking
- diagnostics rendering
- fillability or deployability analysis
- endpoint parity fences
- bridge export

Then verify the matching files together.

### If you change settings or persistence

Update together:

- `html-partials/tab-settings-section-execution.html`
- `lib/backtest-settings-resolver.ts`
- `lib/settings-model.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/rust-settings-sanitizer.ts`

### If you change signal-exit scoring semantics

Recheck together:

- `lib/polymarket-exit-mode.ts`
- `lib/polymarket-signal-exit-evaluator.ts`
- `lib/polymarket-price-points.ts`
- `lib/polymarket-trade-annotations.ts`
- `lib/backtest-service.ts`
- `lib/finder/finder-runner-polymarket.ts`
- `lib/quick-view.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`
- `lib/polymarket-diagnostics-utils.ts`

### If you change local price-point storage or ingestion

Keep aligned:

- `lib/local-sqlite-polymarket-api.ts`
- `lib/polymarket-price-points-ingest.ts`
- `vite.config.ts`

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
..\..\..\node_modules\.bin\esno tests\polymarket-signal-exit.spec.ts
```

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
..\..\..\node_modules\.bin\esno tests\polymarket-diagnostics-utils.spec.ts
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
- `1m` signal-exit scoring also uses local SQLite price points
- diagnostics read scored results and may lazily rebuild them
- bridge export is a bot-facing file-generation path with tighter rules

When those stay separate, Polymarket changes remain predictable.
