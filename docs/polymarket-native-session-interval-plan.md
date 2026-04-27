# Polymarket Native Session Interval Plan

## Goal

- add native Polymarket outcome session selection: `5m`, `15m`, `1h`
- keep default session as `5m`
- use the selected session in manual backtest annotation
- show selected-session Polymarket performance in Quick View and the Polymarket diagnostics tab

## Assumptions

- this request means native outcome session selection, not the existing Finder `15m`/`1h` chart-interval bridge built from `5m` rows
- v1 scope is manual backtest, Quick View, Trades lazy reload, and the Polymarket diagnostics tab
- Finder, Hunt, endpoint, Strategy Ensemble, and bridge export stay on current behavior unless explicitly extended later
- `signal_exit_same_event` stays fenced to the current `1m` chart flow
- chart interval and Polymarket outcome session are separate contracts; `marketContext.interval` stays the chart interval

## Current Gaps

- [lib/polymarket-btc5m.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-btc5m.ts) resolves one `5m` series per symbol
- [lib/polymarket-trade-annotations.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-trade-annotations.ts) only treats `1m` bridge or native `5m` as first-class scoring paths
- [lib/quick-view/quick-view-service.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/quick-view/quick-view-service.ts), [lib/polymarket-outcome-loader.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-outcome-loader.ts), and [lib/polymarket-panel-service.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-panel-service.ts) still gate support as `1m` or `5m`
- [scripts/polymarket-sync-outcomes.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/scripts/polymarket-sync-outcomes.ts) must load the new native session series or SQLite will stay empty for `15m`/`1h`
- [package.json](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/package.json) scripts `poly:sync-outcomes` and `poly:sync-outcomes:all` still imply `5m`-only sync targets
- [lib/handlers/state-subscriptions.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/handlers/state-subscriptions.ts) only manages the current Polymarket rows and labels for `5m`-centric behavior
- native `15m` and `1h` outcome rows do not expose minute `5+` checkpoint fields, so payout metrics cannot rely on `yes_entry_minute_1_price` to `yes_entry_minute_4_price`
- [vite.config.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/vite.config.ts) server-side `/api/sqlite/ensure-polymarket-price-points` still fetches only `300s` windows

## Phase 1 - Settings Contract

**Purpose**

Add one explicit setting for native Polymarket session selection without breaking saved configs.

**Changes**

- add `polymarketOutcomeInterval` to:
  - [lib/types/strategies.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/types/strategies.ts)
  - [lib/settings-model.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/settings-model.ts)
  - [lib/backtest-settings-resolver.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/backtest-settings-resolver.ts)
  - [lib/backtest-settings-dom-contract.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/backtest-settings-dom-contract.ts)
  - [lib/polymarket-dom-reader.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-dom-reader.ts)
  - [lib/rust-settings-sanitizer.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/rust-settings-sanitizer.ts)
  - [lib/handlers/state-subscriptions-dom.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/handlers/state-subscriptions-dom.ts)
  - [lib/handlers/state-subscriptions.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/handlers/state-subscriptions.ts)
- add a session select in [html-partials/tab-settings-section-execution.html](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/html-partials/tab-settings-section-execution.html)
- show the select only when Polymarket annotation is enabled
- default missing or legacy values to `5m`

**Verification**

- legacy saved settings load with `polymarketOutcomeInterval = "5m"`
- save/load strategy config preserves the new key

## Phase 2 - Outcome Series Registry

**Purpose**

Resolve native SQLite series by symbol plus selected outcome session instead of assuming `5m`.

**Changes**

- generalize the series lookup in [lib/polymarket-btc5m.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-btc5m.ts)
- keep the file name in this pass to avoid broad churn; only broaden its internals
- keep the existing SQLite `polymarket_outcomes` table shape; reuse `series_id`, `interval`, `event_start_ts`, and `event_end_ts`
- add session-aware helpers:
  - `resolvePolymarketOutcomeInterval(...)`
  - `getEffectivePolymarketSeriesId(...)`
  - `isSupportedPolymarketOutcomeRun(...)`
- register real series ids for `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `XRPUSDT` across `5m`, `15m`, `1h`
- update [scripts/polymarket-sync-outcomes.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/scripts/polymarket-sync-outcomes.ts) to sync those native series ids
- extend sync targets to `{ symbol, interval, seriesId }`
- make `npm run poly:sync-outcomes:all` mean all supported symbols across supported native sessions
- update CLI help text and positional parsing so `--all`, `--symbol`, and default mode describe interval-aware behavior

**Verification**

- selected `5m` keeps current series ids
- selected `15m` and `1h` load the expected native series ids
- `npm run poly:sync-outcomes:all` resolves native `5m`, `15m`, and `1h` targets correctly

## Phase 3 - Backtest Annotation Path

**Purpose**

Score manual backtests against the selected native outcome session and persist enough metadata for reload parity.

**Changes**

- thread `polymarketOutcomeInterval` through:
  - [lib/backtest-service.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/backtest-service.ts)
  - [lib/polymarket-trade-annotations.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-trade-annotations.ts)
- extend [lib/types/polymarket-outcomes.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/types/polymarket-outcomes.ts) with `outcomeInterval`
- for native `15m` and `1h`, map trades by containing event timestamp, not exact `entryTime === event_start_ts`
- store minute offset inside the selected session on each scored trade when available
- persist `outcomeInterval` on the result summary; do not write it into `marketContext.interval`
- do not reuse Finder's grouped-`5m` multi-interval path here; this is a different contract

**Verification**

- [tests/polymarket-native-session-intervals.spec.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/tests/polymarket-native-session-intervals.spec.ts)
- [tests/backtest-result-context.spec.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/tests/backtest-result-context.spec.ts)
- regression: missing `outcomeInterval` still behaves as `5m`

## Phase 4 - Entry Pricing For Native `15m` And `1h`

**Purpose**

Keep Quick View payout metrics meaningful for native sessions that extend beyond the first five minutes.

**Changes**

- use local price points for resolve-hold entry pricing when the selected native session is `15m` or `1h`
- price entry from the first quote at or after the chart trade entry timestamp inside the selected event
- keep native `5m` on the existing checkpoint-price path
- extend [lib/polymarket-price-points-ingest.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-price-points-ingest.ts) to fetch through `event_end_ts`, not fixed `event_start_ts + 300`
- extend the matching server-side logic in [vite.config.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/vite.config.ts) so `/api/sqlite/ensure-polymarket-price-points` uses `event_end_ts`
- treat legacy caches as incomplete when they only cover the first `5m` of a longer native event
- if native-session price points are unavailable, keep classification metrics and mark payout fields `n/a`; do not silently reuse `5m` checkpoint prices

**Verification**

- [tests/polymarket-price-points-ingest.spec.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/tests/polymarket-price-points-ingest.spec.ts)
- [tests/polymarket-sync-outcomes-cli.spec.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/tests/polymarket-sync-outcomes-cli.spec.ts)
- add one annotation test where entry minute is greater than `4` and `marketEntryPrice` is still populated

## Phase 5 - Quick View And Diagnostics UI

**Purpose**

Show selected-session Polymarket performance in UI reload paths without drifting to the active settings panel.

**Changes**

- update support gates in:
  - [lib/quick-view/quick-view-service.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/quick-view/quick-view-service.ts)
  - [lib/quick-view/quick-view-renderer.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/quick-view/quick-view-renderer.ts)
  - [lib/polymarket-outcome-loader.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-outcome-loader.ts)
  - [lib/polymarket-panel-service.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/polymarket-panel-service.ts)
  - [lib/renderers/tradesRenderer.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/renderers/tradesRenderer.ts)
- resolve outcome interval from stored result summary first, current DOM second
- include `outcomeInterval` in lazy-loader cache signatures
- replace hardcoded `5m` labels with selected-session labels in:
  - Quick View summary copy
  - Polymarket panel empty/support text
  - bucket titles and hints
- for native `15m` and `1h`, Quick View shows summary cards only; do not add `15m` or `1h` minute-profile tables in v1
- keep Quick View compact; detailed minute tables stay in the Polymarket tab

**Verification**

- Quick View shows native `15m` or `1h` mode on a stored result after refresh or lazy reload
- Polymarket diagnostics tab rebuilds the same selected-session summary as the original backtest

## Phase 6 - Fences, Tests, Docs

**Purpose**

Avoid contract drift in shared Polymarket settings surfaces.

**Changes**

- keep these surfaces explicitly fenced to current behavior until a separate change extends them:
  - Finder native-session scoring in [lib/finder/finder-runner-polymarket.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/finder/finder-runner-polymarket.ts)
  - Hunt apply-result behavior in [lib/hunt/hunt-service.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/hunt/hunt-service.ts)
  - endpoint Preview / Copy / HTTP execution in [lib/backtest-endpoint-copy.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/backtest-endpoint-copy.ts), [lib/backtest-endpoint-settings.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/backtest-endpoint-settings.ts), and [lib/backtest-endpoint-execution.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/backtest-endpoint-execution.ts)
  - Strategy Ensemble Polymarket in [lib/strategy-ensemble-service.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/strategy-ensemble-service.ts) and [lib/strategy-ensemble-polymarket-runner.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/strategy-ensemble-polymarket-runner.ts)
  - bridge export
- unsupported surfaces ignore or strip `polymarketOutcomeInterval`; they do not silently switch series
- update docs:
  - [docs/polymarket.md](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/docs/polymarket.md)
  - [README.md](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/README.md) if the user-facing support summary changes

**Validation**

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\polymarket-native-session-intervals.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\polymarket-price-points-ingest.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\polymarket-sync-outcomes-cli.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\quick-view-polymarket.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\polymarket-trade-annotations.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\settings-compat.spec.ts`

## Success Criteria

- user can pick `5m`, `15m`, or `1h` native Polymarket session
- default remains `5m`
- manual backtest stores `seriesId`, `outcomeSymbol`, and `outcomeInterval` on the result
- native `15m` and `1h` runs score against the correct native session rows
- Quick View and the Polymarket diagnostics tab show the selected-session Polymarket performance after reload
