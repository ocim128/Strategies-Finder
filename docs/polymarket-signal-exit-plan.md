# Polymarket Signal Exit Plan

## Goal

Add a new Polymarket evaluation mode for `1m` chart runs that:

- uses the normal chart backtest to decide entry and exit timestamps
- enters at a locally captured Polymarket YES/NO price inside the mapped `5m` event
- exits at a locally captured Polymarket YES/NO price when the chart trade closes by `signal` inside that same event
- falls back to final binary outcome settlement when no same-event signal exit happens
- keeps the current hold-to-resolution Polymarket mode unchanged
- works consistently in manual backtest, Finder Polymarket mode, and Hunt runs that delegate to Finder

This is a Polymarket scoring extension, not a replacement backtest engine.

## Purpose

The current Polymarket path only answers one question:

- "Was the trade direction correct by final outcome?"

That is useful, but too coarse for `1m` research. It does not reward trades that:

- enter well
- take profit early
- avoid a late reversal before event resolution

The new mode should answer a more practical question:

- "If I trade the Polymarket contract itself, using my chart strategy for timing, what happens if I exit on the chart sell signal before final resolution?"

## Why This Must Stay Event-Based

Do not stitch Polymarket prices across consecutive `5m` events.

Each `5m` Polymarket market is a different contract. Price resetting between events is expected and correct. The backtest must therefore be trade-based, not continuous-price-based.

The safe rule is:

- one scored Polymarket trade belongs to one event
- a trade never carries into the next event
- if the chart trade is still open when the event ends, the Polymarket leg settles to the final binary outcome and stops there

## V1 Scope

Support only:

- `1m` chart interval
- manual backtest UI
- existing backtest result annotation flow
- Finder Polymarket mode
- Hunt runs that call Finder Polymarket mode
- Quick View
- Trades panel
- Polymarket diagnostics tab
- locally stored Polymarket quote points

Keep working:

- current `resolve_hold` Polymarket behavior
- `polymarketOutcomeSymbol`
- existing `1m` event mapping logic

V1 assumptions:

- quote data is already captured and can be loaded locally
- a single executable price per side is enough in v1
- use normalized prices in `0..1`

## Non-Goals For V1

- Worker or alert changes
- endpoint changes
- bridge export changes
- continuous Polymarket chart stitching
- carrying a position into the next `5m` event
- full orderbook replay
- bid/ask microstructure modeling
- replacing the app-wide main ROI badge with Polymarket ROI
- `5m`, `15m`, `1h`, or `4h` signal-exit support

## Current Repo Facts

These existing seams should be reused:

- `lib/backtest-service.ts` already runs the normal backtest, then optionally annotates Polymarket results
- `lib/polymarket-trade-annotations.ts` already maps backtest trades to Polymarket events
- `lib/polymarket-outcome-evaluator.ts` already builds Polymarket summaries from trades
- `lib/polymarket-1m-5m-bridge.ts` already has event containment and dedupe helpers
- `lib/types/polymarket-outcomes.ts` already carries trade-level and summary-level Polymarket fields
- `lib/local-sqlite-polymarket-api.ts` and `vite.config.ts` already expose local SQLite load/store paths for Polymarket outcomes
- `lib/finder/finder-runner-polymarket.ts` is the dedicated Polymarket Finder execution path
- `lib/hunt/hunt-runner.ts` is a thin orchestrator on top of Finder, not a second evaluation engine

Important limitation today:

- `polymarket_outcomes` only stores event checkpoints and final resolution
- that is enough for entry scoring and final-outcome scoring
- that is not enough for arbitrary signal exits inside the event

Important non-solution:

- `lib/polymarket-fill-history.ts` is for diagnostics and remote history summaries
- do not use it as the core backtest fill source
- the new mode must stay deterministic against local data

Important audit correction:

- the first draft treated manual backtest as the primary implementation surface
- that is too narrow if Finder and Hunt must support the feature
- the shared Polymarket signal-exit evaluator must be the primary execution core
- manual backtest and Finder should both call that core
- Hunt should inherit behavior through Finder instead of adding a second implementation

## Architecture Direction

Build one shared pure evaluator for Polymarket signal-exit pricing and reuse it in all supported surfaces.

Recommended shape:

- normal chart backtest still produces `Trade[]`
- a shared Polymarket evaluator turns those trades into Polymarket-scored trades and summary
- manual backtest annotation calls that evaluator
- Finder Polymarket mode calls that evaluator
- Hunt gets the behavior automatically because it already delegates to Finder

Do not implement separate pricing logic in:

- `lib/polymarket-trade-annotations.ts`
- `lib/finder/finder-runner-polymarket.ts`

If those two paths drift, manual backtest, Finder, and Hunt will rank the same candidate differently.

## Product Rules

### Trade selection

Keep the existing event-minded discipline:

- map each chart trade to the containing `5m` Polymarket event
- score at most one Polymarket trade per event
- ignore later duplicate trades inside the same event

Use the same "first eligible trade wins" rule as the current `1m` Polymarket flow unless a stronger reason appears during implementation.

### Entry behavior

For the new mode:

- do not use `polymarketEntryOffset`
- allow entry on any minute inside the containing `5m` event
- fill using the first locally captured side price at or after the chart trade entry timestamp within the same event

If no valid entry quote exists inside the event:

- leave the trade unscored
- count it as a missing-price trade

### Exit behavior

If the chart trade closes with `exitReason === "signal"` and the exit timestamp is still inside the same event:

- exit using the latest locally captured side price at or before the chart exit timestamp

If the chart trade does not produce a same-event signal exit:

- settle to final outcome at event end
- YES settles to `1` if outcome is up, else `0`
- NO settles to `1` if outcome is down, else `0`

If there is a same-event signal exit but no usable local quote before that exit:

- do not silently settle to resolution
- mark the trade unscored because required quote data is missing

This keeps "no sell logic" separate from "data missing".

### PnL model

Use side-native prices.

For a long chart trade:

- Polymarket side is YES
- entry uses `yes_price`
- signal exit uses `yes_price`
- resolution exit uses `1` or `0`

For a short chart trade:

- Polymarket side is NO
- entry uses `no_price`
- signal exit uses `no_price`
- resolution exit uses `1` or `0`

Per-trade PnL:

```text
marketPnl = marketExitPrice - marketEntryPrice
```

V1 unit:

- normalized dollars per one share contract
- UI may display the same values in cents for readability

### Supported chart exits

Only signal exits should close the Polymarket leg early in v1.

Treat these as final-outcome holds:

- `stop_loss`
- `take_profit`
- `trailing_stop`
- `time_stop`
- `partial`
- `probation_fail`
- `end_of_data`

Reason:

- the requested mode is explicitly "exit when sell logic triggered"
- this keeps the first implementation simple and predictable

## New Data Contract

Add a new local SQLite table for captured Polymarket price points.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS polymarket_price_points (
    series_id TEXT NOT NULL,
    event_start_ts INTEGER NOT NULL,
    event_end_ts INTEGER NOT NULL,
    market_slug TEXT NOT NULL DEFAULT '',
    yes_token_id TEXT NOT NULL,
    no_token_id TEXT NOT NULL DEFAULT '',
    ts INTEGER NOT NULL,
    yes_price REAL,
    no_price REAL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(series_id, event_start_ts, ts)
);

CREATE INDEX IF NOT EXISTS idx_pm_price_points_series_time
    ON polymarket_price_points(series_id, ts);

CREATE INDEX IF NOT EXISTS idx_pm_price_points_event_time
    ON polymarket_price_points(series_id, event_start_ts, ts);
```

Use a simple row type in v1:

```ts
export interface PolymarketPricePoint {
  series_id: string;
  event_start_ts: number;
  event_end_ts: number;
  market_slug: string;
  yes_token_id: string;
  no_token_id: string;
  ts: number;
  yes_price: number | null;
  no_price: number | null;
  updated_at: number;
}
```

Why this shape:

- keyed by event, because this feature is event-based
- keyed by timestamp, because exits are time-based
- stores both YES and NO directly, so v1 does not have to infer one from the other

## Settings Contract

Add one new Polymarket setting:

```ts
polymarketExitMode?: "resolve_hold" | "signal_exit_same_event";
```

Rules:

- default is `"resolve_hold"`
- only show this control when `polymarketAnnotationEnabled` is on
- only show the non-default mode on `1m`
- when `signal_exit_same_event` is selected, hide `polymarketEntryOffset`
- mark the new setting Rust-unsupported
- preserve the field in settings capture, saved configs, endpoint-style snapshots, and Hunt profiles

Do not overload `executionModel`. This is a Polymarket evaluation choice, not a chart fill model.

Important compatibility rule:

- `polymarketEntryOffset` must remain persisted for old profiles and old runs
- when `polymarketExitMode = signal_exit_same_event`, `polymarketEntryOffset` is ignored rather than deleted

## Finder And Hunt Contract

This section is required for a correct implementation.

### Finder is the primary research surface

For this feature, Finder is not an optional follow-up. It is one of the main execution surfaces.

When `options.polymarketScoringEnabled` is on and `settings.polymarketExitMode = signal_exit_same_event`:

- Finder must still use `lib/finder/finder-runner-polymarket.ts`
- Finder must load local price points once per run, not once per candidate
- Finder must reuse one shared signal-exit evaluator across all candidates

### Do not fan out 1m candidates by offset in the new mode

Current `1m` Polymarket Finder behavior expands one candidate into five offset variants using `polymarketEntryOffset`.

That must not happen in `signal_exit_same_event`.

Rules:

- one parameter set produces one Polymarket evaluation
- Finder must not inject `polymarketEntryOffset` into candidate params
- Finder must not multiply `totalRuns` by five
- Hunt survivor grouping must therefore stay stable and not split one candidate into five pseudo-candidates

### Rank-mode restrictions for the new mode

The old Polymarket rank modes were designed for binary final-outcome scoring.

For `signal_exit_same_event`, keep the first cut simple:

- supported rank modes:
  - `expectancy`
  - `expectancyTrades`
  - `profitFactor`
  - `profitFactorTrades`
- unsupported rank modes:
  - `balanced`
  - `accuracy`
  - `volume`

Why:

- early exit PnL is a trade-value problem, not mainly a classification problem
- blocking the old classification-first rank modes is simpler and safer than inventing weak pseudo-baselines in v1

Finder behavior:

- if a blocked rank mode is selected while `signal_exit_same_event` is active, fail early with a clear status message

### Hunt behavior

Hunt should not get new execution logic of its own.

Required behavior:

- Hunt profile capture/import/export must preserve `polymarketExitMode`
- Hunt runs inherit the feature automatically through Finder
- one enabled profile with matching UI context should produce the same results as Finder for the same strategies and run settings

Hunt-specific rule:

- `polymarketLockOffset` becomes irrelevant in `signal_exit_same_event`
- keep it persisted for backward compatibility, but ignore or disable it in Hunt UI when the profile uses the new mode

`polymarketAfterTakeProfitOnly` may remain available because it filters chart trades before Polymarket evaluation and does not depend on offset fan-out.

## Result Contract

Extend trade annotation with the minimum fields needed to render and debug signal-exit behavior.

Suggested additions to `TradePolymarketOutcome`:

```ts
evaluationMode?: "resolve_hold" | "signal_exit_same_event";
marketExitPrice?: number | null;
marketExitTs?: number | null;
marketExitSource?: "signal" | "resolution";
marketPnl?: number | null;
```

Suggested additions to `BacktestPolymarketTradeSummary`:

```ts
evaluationMode?: "resolve_hold" | "signal_exit_same_event";
signalExitedTrades?: number;
resolvedTrades?: number;
missingPriceTrades?: number;
netPnl?: number;
grossProfit?: number;
grossLoss?: number;
profitFactor?: number;
expectancy?: number;
avgEntryPrice?: number;
avgExitPrice?: number;
```

Important V1 rule:

- do not overwrite `BacktestResult.netProfit`, `equityCurve`, or other core chart metrics
- keep Polymarket signal-exit performance as a separate Polymarket summary

That is the safest first implementation.

Suggested additions to `PolymarketEvalResult` for Finder/Hunt parity:

```ts
evaluationMode?: "resolve_hold" | "signal_exit_same_event";
signalExitedTrades?: number;
resolvedTrades?: number;
missingPriceTrades?: number;
netPnl?: number;
avgExitPrice?: number;
```

This keeps Finder/Hunt ranking and rendering aligned with the manual summary contract.

## Minimal Runtime Flow

Use the existing chart backtest to produce trades first.

Then run a Polymarket post-pass:

```text
1. run normal chart backtest
2. if Polymarket annotation is disabled, stop
3. if polymarketExitMode = resolve_hold, use current path
4. if polymarketExitMode = signal_exit_same_event:
   - load outcome rows
   - load local price points
   - map trades to events
   - dedupe to one scored trade per event
   - compute entry fill
   - compute same-event signal exit fill if available
   - else settle to final outcome
   - attach trade annotations
   - build Polymarket summary
5. commit annotated result
```

Finder and Hunt should use the same core, with a different caller shape:

```text
1. load chart data once
2. load Polymarket outcomes once
3. load local price points once
4. run each strategy candidate to produce chart trades
5. call the shared Polymarket signal-exit evaluator
6. rank candidates by supported Polymarket metrics
7. let Hunt aggregate Finder output across profiles
```

Performance rule:

- local price point loading and event indexing must be amortized across the run
- per-candidate work should only evaluate trades against already indexed local data

## Implementation Phases

### Phase 1. Local data surface

Purpose:

- make intra-event Polymarket prices available locally and deterministically

Files:

- `vite.config.ts`
- `lib/local-sqlite-polymarket-api.ts`
- `lib/types/polymarket-outcomes.ts`

Tasks:

- add `polymarket_price_points` SQLite table and indexes
- add `PolymarketPricePoint` type
- add `loadPolymarketPricePoints(...)`
- add `storePolymarketPricePoints(...)` only if the repo needs a repo-owned ingestor path

Exit condition:

- browser code can load local price points by time range without remote fetches

### Phase 2. Evaluation helpers

Purpose:

- build the smallest possible deterministic pricing layer for entry and same-event signal exits
- make that layer reusable by manual backtest and Finder

Suggested new helper file:

- `lib/polymarket-price-points.ts`
- `lib/polymarket-signal-exit-evaluator.ts`

Tasks:

- index local price points by event
- add helper to find entry fill at or after `entryTs`
- add helper to find signal exit fill at or before `exitTs`
- keep lookup logic isolated from rendering code
- expose one pure evaluator that accepts:
  - `trades`
  - `outcomes`
  - `pricePoints`
  - `interval`
  - `strategyKey`
  - `evaluationMode`

Do not add a broad quote-engine abstraction in v1.

Exit condition:

- one pure helper can turn `(trade, outcomeRow, eventPoints)` into Polymarket entry/exit prices
- the same helper is suitable for both manual annotation and Finder ranking

### Phase 3. Annotation mode

Purpose:

- add the new Polymarket signal-exit mode without breaking the current hold-to-resolution path

Files:

- `lib/polymarket-trade-annotations.ts`
- `lib/polymarket-outcome-evaluator.ts`
- `lib/backtest-service.ts`
- `lib/types/polymarket-outcomes.ts`

Tasks:

- add `polymarketExitMode`
- keep `resolve_hold` as the existing default path
- add a new `signal_exit_same_event` evaluation path
- reuse current event mapping and dedupe logic for `1m`
- annotate each scored trade with entry price, exit price, exit source, and PnL
- build a separate Polymarket summary for the new mode

Important behavior:

- no cross-event carry
- no fallback from missing signal-exit quote to resolution
- no use of `polymarketEntryOffset` in the new mode

Exit condition:

- a `1m` backtest can produce a stable Polymarket signal-exit summary from local price points

### Phase 4. Finder Polymarket mode

Purpose:

- make parameter search use the same signal-exit semantics as manual backtests

Files:

- `lib/finder/finder-runner-polymarket.ts`
- `lib/finder/finder-engine.ts`
- `lib/types/finder.ts`

Tasks:

- load local price points once per Finder Polymarket run
- call the shared signal-exit evaluator for each candidate
- keep one evaluation per parameter set in `1m` signal-exit mode
- do not inject `polymarketEntryOffset` into candidate params
- block unsupported rank modes with a clear status message
- reuse existing expectancy and profit-factor metric families

Exit condition:

- Finder Polymarket mode ranks `signal_exit_same_event` candidates without offset fan-out
- the same candidate scores the same way in manual backtest and Finder

### Phase 5. Hunt pass-through support

Purpose:

- ensure Hunt can use the feature without inventing separate logic

Files:

- `lib/hunt/hunt-model.ts`
- `lib/hunt/hunt-profile-capture.ts`
- `lib/hunt/hunt-runner.ts`
- `lib/hunt/hunt-results.ts`

Tasks:

- preserve `polymarketExitMode` in profile capture/import/export
- keep Hunt profile parity with current UI
- ignore or disable offset-lock controls when the profile uses signal-exit mode
- confirm survivor grouping is not split by fake offset params

Exit condition:

- a one-profile Hunt run matches Finder output for the same profile
- multi-profile Hunt runs can aggregate signal-exit Finder candidates normally

### Phase 6. Settings and UI wiring

Purpose:

- expose the new mode clearly, with minimal UI churn

Files:

- `html-partials/tab-settings-section-execution.html`
- `lib/backtest-settings-resolver.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/rust-settings-sanitizer.ts`

Tasks:

- add `Polymarket Exit Mode` control
- show it only when Polymarket annotation is enabled
- keep it effectively `1m`-only
- hide `polymarketEntryOffset` when signal-exit mode is selected
- hide or disable offset-lock controls in Finder/Hunt when signal-exit mode is selected
- force TypeScript engine when the new mode is active

Exit condition:

- the setting can be saved, restored, and applied without drifting old configs

### Phase 7. Result rendering

Purpose:

- make the new mode visible without rewriting the whole results stack

Files:

- `lib/quick-view.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`

Tasks:

- show which Polymarket mode produced the summary
- show signal-exit counts vs resolution-settled counts
- show entry and exit price for scored trades
- show PnL/expectancy/profit factor from the Polymarket summary

V1 rendering rule:

- do not replace the main chart backtest metrics
- add a clearly labeled Polymarket performance section

Exit condition:

- a user can tell, from the UI alone, whether a trade exited by signal or by final outcome

## File Map For The Later Implementation Pass

Primary files:

- `docs/polymarket.md`
- `vite.config.ts`
- `lib/local-sqlite-polymarket-api.ts`
- `lib/types/polymarket-outcomes.ts`
- `lib/polymarket-price-points.ts`
- `lib/polymarket-signal-exit-evaluator.ts`
- `lib/polymarket-trade-annotations.ts`
- `lib/polymarket-outcome-evaluator.ts`
- `lib/backtest-service.ts`
- `lib/finder/finder-runner-polymarket.ts`
- `lib/finder/finder-engine.ts`
- `lib/types/finder.ts`
- `lib/hunt/hunt-model.ts`
- `lib/hunt/hunt-profile-capture.ts`
- `lib/hunt/hunt-runner.ts`
- `lib/hunt/hunt-results.ts`
- `html-partials/tab-settings-section-execution.html`
- `lib/backtest-settings-resolver.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/rust-settings-sanitizer.ts`
- `lib/quick-view.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`

## Test Plan

Add focused tests before broad UI work.

Suggested new spec:

- `tests/polymarket-signal-exit.spec.ts`

Required cases:

- long trade enters and exits by signal inside one event
- short trade enters and exits by signal inside one event
- trade with no same-event signal exit settles to final outcome
- trade whose chart exit happens after event end still settles to final outcome
- duplicate trades inside one event only score once
- missing entry quote leaves trade unscored
- missing same-event exit quote leaves trade unscored
- event reset between consecutive `5m` markets does not affect scoring

Required Finder cases:

- `1m` signal-exit Finder mode evaluates one result per parameter set, not five offsets
- Finder does not inject `polymarketEntryOffset` into params in the new mode
- blocked rank modes fail early with a clear status message
- supported expectancy/profit-factor rank modes work with signal-exit eval data
- local price points load once per run, not once per candidate

Required Hunt cases:

- Hunt profile capture/import/export preserves `polymarketExitMode`
- one-profile Hunt run matches Finder output for the same profile
- survivor grouping is not split by offset-only param drift

Also update or recheck:

- `tests/polymarket-trade-annotations.spec.ts`
- `tests/polymarket-outcome-evaluator.spec.ts`
- `tests/finder-polymarket.spec.ts`
- `tests/hunt-results.spec.ts`
- `tests/quick-view-polymarket.spec.ts`
- `tests/settings-compat.spec.ts`
- `tests/feature-dom-contracts.spec.ts`

## Acceptance Checklist

The feature is done when all of the following are true:

1. `1m` backtests can keep the current hold-to-resolution Polymarket mode unchanged.
2. A new `signal_exit_same_event` mode can score entry and same-event signal exit from local price points.
3. If no same-event signal exit exists, the trade settles to final outcome.
4. No trade is carried into the next event.
5. Missing quote data is explicit in the summary instead of silently converted into a win or loss.
6. The UI clearly shows which trades exited by signal and which settled by resolution.
7. The main chart backtest metrics remain untouched in v1.
8. Finder `1m` signal-exit mode does not fan out into five offset variants.
9. Hunt profiles preserve the new setting and one-profile Hunt matches Finder for the same context.

## Validation Commands

Run from this repo:

```bash
npm run typecheck
```

```bash
npm run test -- polymarket
```

```bash
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

## One-Line Rule For The Implementer

Use the chart strategy only for timing. Use Polymarket event prices only for Polymarket entry/exit PnL. Never stitch one `5m` event market into the next.
