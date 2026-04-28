# Multi-Chart Finder Implementation Plan

## Goal

Add a new Finder scope that answers this question:

- which parameter sets for one selected strategy survive across many symbols?

This is still Finder. It is not Hunt, Portfolio Lab, or a one-config validator.

## Purpose Of This Plan

This document exists to:

- lock the v1 product contract before code changes start
- keep the implementation inside the Finder surface instead of drifting into Hunt profiles
- preserve current single-chart Finder behavior
- define phase boundaries, acceptance criteria, and validation

## Locked V1 Product Decisions

These are explicit scope decisions, not suggestions.

1. The feature lives inside the existing `Finder` tab.
2. Finder gets a scope switch:
   - `Current Chart`
   - `Symbol Universe`
3. `Symbol Universe` mode uses exactly one selected strategy key.
   - Do not bind universe mode to `state.currentStrategyKey`.
   - Do not allow multi-strategy universe runs in v1.
   - Keep universe strategy selection state separate from current-chart multi-selection state.
4. The user provides a symbol list directly.
   - No Hunt profiles.
   - No Portfolio Lab benchmark or pair logic.
   - No chart-to-chart relationship model.
5. The run reuses the current:
   - interval
   - backtest settings
   - capital settings
6. Rare-trade strategies are valid.
   - zero trades on some symbols is neutral, not automatic failure
7. Universe results are filtered first, then sorted.
8. Applying a result still applies params back to the main UI and reruns the normal current-chart backtest only.

## Deliberate V1 Deferrals

These should be blocked clearly, not partially supported.

- multi-strategy universe runs
- Hunt-profile-based universe selection
- portfolio-style benchmark or overlap controls
- Polymarket universe scoring
- combo mode universe runs
- strategy-timeframe multi-timeframe universe runs
- cross-symbol strategies in universe mode
- genetic and grid universe search

Use `random` search only in v1 for universe mode. It gives bounded runtime and fits the current Finder default.

## Non-Negotiable Invariants

- Current-chart Finder behavior must remain unchanged.
- Universe mode must not mutate live chart context while loading or scoring other symbols.
- Universe mode must not destroy or overwrite the user's current-chart multi-strategy selection when the scope changes.
- One candidate param set must be evaluated against identical settings on every symbol in the universe.
- Do not merge all universe trades into one synthetic backtest result.
- Per-symbol results must remain inspectable.
- Zero-trade symbols must be preserved as explicit states, not silently dropped.
- Unsupported configurations must fail fast with a user-facing message.

## Important Shortcuts To Avoid

- Do not build this on Hunt profiles.
- Do not borrow Portfolio Lab universe semantics beyond simple symbol-list helpers.
- Do not overload the existing single-chart `FinderMetric` semantics with hidden cross-chart meaning.
- Do not route universe runs through `dataManager.loadData(...)` or `state.ohlcvData`.
- Do not implement universe execution by stitching together ad hoc `strategy.execute(...)` + `runBacktest(...)` calls that bypass shared backtest semantics.
- Do not let one strong symbol dominate ranking by summing raw profit alone.
- Do not allow the existing multi-select strategy toolbar to imply that universe mode supports many strategies.

## Current Files And Seams That Matter

Primary surfaces:

- `html-partials/tab-finder.html`
- `lib/finder-manager.ts`
- `lib/finder/finder-manager-dom.ts`
- `lib/finder/finder-manager-logic.ts`
- `lib/finder/finder-runner.ts`
- `lib/finder/finder-runner-core.ts`
- `lib/finder/finder-runner-shared.ts`
- `lib/finder/finder-ui.ts`
- `lib/types/finder.ts`
- `lib/data-manager.ts`
- `lib/backtest-executor.ts`

Existing reusable seams:

- `dataManager.fetchDataDetached(...)`
- `FinderParamSpace`
- `runFinderExecution(...)` for current-chart mode
- `executeBacktest(...)` for shared backtest semantics
- Finder result ranking and UI progress patterns

Likely new files:

- `lib/finder/finder-runner-universe.ts`
- `lib/finder/finder-universe-metrics.ts`
- `tests/finder-universe-runner.spec.ts`
- `tests/finder-universe-metrics.spec.ts`

Existing tests to keep green:

- `tests/finder-manager-logic.spec.ts`
- `tests/finder-engine.spec.ts`
- `tests/feature-dom-contracts.spec.ts`
- `npm run typecheck`
- `npm run test`

## Core Data Model

Use separate universe-specific result types instead of pretending they are normal single-chart Finder rows.

Recommended shape:

```ts
type FinderScope = "current_chart" | "symbol_universe";

type FinderUniverseSymbolStatus =
  | "profitable"
  | "losing"
  | "flat"
  | "no_trades"
  | "load_failed"
  | "run_failed";

type FinderUniverseSymbolResult = {
  symbol: string;
  status: FinderUniverseSymbolStatus;
  barCount: number;
  firstTime?: Time;
  lastTime?: Time;
  result?: BacktestResult;
  error?: string;
};

type FinderUniverseCandidate = {
  strategyKey: string;
  strategyName: string;
  params: StrategyParams;
  symbols: FinderUniverseSymbolResult[];
  activeSymbols: number;
  profitableSymbols: number;
  losingSymbols: number;
  flatSymbols: number;
  noTradeSymbols: number;
  totalTrades: number;
  profitableActiveRatio: number;
  medianExpectancy: number;
  medianNetProfit: number;
  worstNetProfit: number;
  bestNetProfit: number;
};
```

`activeSymbols` means symbols with `totalTrades > 0`.

Do not count `load_failed` or `run_failed` as active.

Keep latest-result state scope-aware instead of overloading the current `displayResults: FinderResult[]` shape.

Recommended manager shape:

```ts
type FinderLatestResults =
  | { scope: "current_chart"; results: FinderResult[] }
  | { scope: "symbol_universe"; results: FinderUniverseCandidate[] };
```

## Execution Parity Rule

Universe mode must preserve normal backtest semantics.

Recommended rule:

- use `executeBacktest(...)` as the scoring path for universe candidates
- or extract a pure shared helper from `lib/backtest-executor.ts` and use that helper from both surfaces

Do not create a universe-only execution path that silently diverges on:

- closed-candle trimming
- Rust eligibility
- capital sizing behavior
- global strategy wrappers
- time normalization
- future backtest bug fixes that already land in the shared executor

## Phase 0: Contract Lock And Guardrails

### Purpose

Freeze the v1 product shape before UI and runner work start.

### Changes

1. Add a repo plan document for Multi-Chart Finder.
2. Add explicit code-level guard rails for unsupported universe-mode features.
3. Add new finder scope and universe-mode type definitions.

### Files

- `docs/multi-chart-finder-plan.md`
- `lib/types/finder.ts`
- `tests/finder-manager-logic.spec.ts`

### Implementation Notes

- Keep universe mode types separate from current-chart types where semantics differ.
- Do not start by modifying `runFinderExecution(...)` to handle both scopes.
- Lock unsupported feature behavior early so later phases do not accidentally depend on half-working paths.

### Acceptance Criteria

- The codebase has explicit type support for Finder scope.
- Universe mode has an explicit unsupported-feature contract.
- No runtime behavior changes yet.

### Validation

- `npm run typecheck`
- `npm run test -- finder-manager-logic`

## Phase 1: Finder Scope UI And Strategy Cardinality

### Purpose

Expose universe mode in Finder without breaking the current-chart workflow.

### Changes

1. Add a Finder scope control:
   - `Current Chart`
   - `Symbol Universe`
2. Add a universe input section inside Finder:
   - symbol textarea
   - `Use Current Symbol`
   - `Use Current + Majors`
   - `Clear`
3. Reuse the existing Finder strategy list, but change behavior by scope:
   - current-chart scope keeps existing multi-select behavior
   - universe scope requires exactly one selected strategy
   - switching scope must preserve the prior selection state for that scope
4. Disable or hide controls that are out of scope in universe mode:
   - search mode values other than `random`
   - Polymarket scoring
   - strategy bulk selection actions
5. Add validation text for universe runs:
   - at least one symbol
   - exactly one strategy

### Files

- `html-partials/tab-finder.html`
- `lib/finder/finder-manager-dom.ts`
- `lib/finder-manager.ts`
- `tests/feature-dom-contracts.spec.ts`

### Implementation Notes

- Do not add a second top-level tab.
- Do not rely on the global selected strategy dropdown for universe mode.
- Avoid error-only single-selection UX. In universe mode, selecting one strategy should auto-deselect the previous universe selection.
- It is acceptable to keep the list visually similar if the interaction becomes radio-like while universe mode is active.
- If the strategy toolbar remains shared, the summary text must change by scope:
  - current chart: `N selected`
  - universe: `Select exactly 1 strategy`
- If the search mode dropdown remains visible in universe mode, coerce the stored/effective run mode to `random` on run even if the DOM still holds another value.

### Acceptance Criteria

- Finder shows a clear scope switch.
- Current-chart scope still behaves like today.
- Universe scope cannot run with zero or multiple selected strategies.
- New DOM ids are covered by feature DOM contract tests.

### Validation

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`

## Phase 2: Universe Input Parsing And Detached Dataset Loading

### Purpose

Turn a raw symbol list into a stable run-local universe without touching the live chart.

### Changes

1. Add a symbol parser for universe mode.
2. Normalize:
   - uppercase symbols
   - trim whitespace
   - dedupe while preserving input order
3. Load datasets through `dataManager.fetchDataDetached(...)`.
4. Reuse datasets per run with a local cache keyed by:
   - normalized symbol
   - interval
   - market type when relevant
5. Surface load failures as warnings, not silent skips.
6. Add a conservative hard cap for v1 universe size.
   - start with `20` unless profiling proves a higher cap is safe

### Files

- `lib/finder-manager.ts`
- `lib/finder/finder-runner-universe.ts`
- `lib/data-manager.ts`
- `tests/finder-universe-runner.spec.ts`

### Implementation Notes

- Use the current interval for every symbol in the universe.
- Do not introduce profile-level date-range or overlap logic.
- Use the full detached dataset that the repo already resolves for that symbol and interval.
- If a symbol returns no usable candles, emit a run message and keep going.
- Dataset loading should happen once per symbol before candidate evaluation begins.
- Capture `barCount`, `firstTime`, and `lastTime` per loaded symbol so the UI can expose evidence coverage without adding extra universe controls.

### Acceptance Criteria

- Universe symbols load without changing the visible chart.
- Duplicate symbols fetch only once per run.
- Failed symbols appear in run messages.
- Universe mode has a deterministic normalized symbol list.

### Validation

- `npm run typecheck`
- `npm run test -- finder-universe-runner`

## Phase 3: Universe Runner

### Purpose

Search params once, then score each candidate across the whole symbol universe.

### Changes

1. Add a dedicated universe runner instead of overloading the current single-chart runner.
2. Generate param sets once for the selected strategy.
3. For each candidate:
   - run the strategy on every loaded symbol dataset
   - collect one per-symbol result record
   - aggregate cross-chart metrics
4. Reuse existing prepared-data seams where available.
5. Yield control frequently enough to keep the UI responsive.
6. Add early candidate pruning when the remaining symbols cannot rescue a candidate against active survivor thresholds.
7. Emit one structured timing summary per universe run.

### Files

- `lib/finder/finder-runner-universe.ts`
- `lib/finder/finder-runner-core.ts`
- `lib/finder/finder-runner-shared.ts`
- `tests/finder-universe-runner.spec.ts`

### Recommended Design

Keep the current-chart pipeline intact.

Recommended split:

- `runFinderExecution(...)` remains single-chart
- `runFinderUniverseExecution(...)` handles universe mode
- `finderManager.runFinder()` chooses the runner by scope

Candidate loop shape:

1. build one selected strategy plan
2. generate candidate params
3. for each candidate:
   - resolve risk overrides once
   - run backtest on each symbol dataset through shared execution semantics
   - build per-symbol statuses
   - aggregate candidate metrics
   - drop obviously invalid candidates before ranking

Prepared-data reuse rule:

- maintain a run-local cache keyed by:
  - strategy key
  - normalized symbol
  - interval
  - effective backtest settings fingerprint when that affects prepared arrays

Early-pruning rule:

- if current failures already make `minProfitableActiveRatio` unreachable, stop evaluating the remaining symbols for that candidate
- if remaining symbols cannot lift `activeSymbols` or `totalTrades` above the configured minimums, stop evaluating the remaining symbols for that candidate
- pruned candidates must still record that evaluation was intentionally stopped

### Additional Rules

- Universe mode uses `random` only in v1.
- Do not allow multi-strategy plans.
- If the selected strategy is cross-symbol, reject the run with a clear message.
- If multi-timeframe or combo settings are active, reject the run with a clear message.
- Do not bypass the shared backtest executor just because the single-chart Finder hot path uses lower-level backtest helpers internally.

### Acceptance Criteria

- Universe runner evaluates one candidate against many symbols.
- Current-chart runner remains unchanged.
- The UI stays responsive during long runs.
- Unsupported cases fail clearly before expensive work starts.
- Universe mode emits one timing summary per run for later tuning.

### Validation

- `npm run typecheck`
- `npm run test -- finder-universe-runner`

## Phase 4: Survivor Filters And Cross-Chart Sorting

### Purpose

Rank generalization, not one-symbol luck.

### Changes

1. Add universe survivor filters.
2. Add universe sort metrics.
3. Apply filters before ranking.
4. Add scope-aware sort logic in Finder manager logic.

### V1 Survivor Filters

Start with only these:

- `minActiveSymbols`
- `minTotalTrades`
- `minProfitableActiveRatio`

Definitions:

- `active symbol`: `totalTrades > 0`
- `profitable active ratio`: `profitableSymbols / activeSymbols`
- if `activeSymbols === 0`, ratio is `0`

### V1 Sort Metrics

Start with only these:

- `profitableActiveRatio`
- `activeSymbols`
- `medianExpectancy`
- `worstNetProfit`
- `totalTrades`

Recommended default priority:

1. `profitableActiveRatio`
2. `medianExpectancy`
3. `worstNetProfit`
4. `totalTrades`

### Files

- `lib/finder/finder-manager-logic.ts`
- `lib/finder/finder-universe-metrics.ts`
- `lib/types/finder.ts`
- `tests/finder-manager-logic.spec.ts`
- `tests/finder-universe-metrics.spec.ts`

### Implementation Notes

- Do not reuse `netProfit`, `expectancy`, or `totalTrades` labels without clarifying that they are aggregate metrics in universe mode.
- It is acceptable to keep current-chart advanced sorting untouched and give universe mode a smaller metric surface in v1.
- Do not let inactive symbols count as losses.
- Do not use raw summed `netProfit` as a top-level default ranking field in v1.

### Acceptance Criteria

- Universe mode filters candidates before ranking.
- Rare-trade candidates are allowed when they meet total evidence thresholds.
- A candidate with one strong symbol and many bad symbols does not dominate purely on summed profit.

### Validation

- `npm run typecheck`
- `npm run test -- finder-manager-logic`
- `npm run test -- finder-universe-metrics`

## Phase 5: Universe Results UI And Apply Flow

### Purpose

Make cross-chart results readable enough to trust and easy enough to use.

### Changes

1. Add a universe result renderer inside Finder.
2. Each row should show:
   - strategy name
   - params
   - profitable / active / total symbols
   - total trades
   - median expectancy
   - worst net profit
3. Add expandable per-symbol detail for each row.
4. Keep `Apply` behavior simple:
   - apply strategy key
   - apply params
   - merge risk params back if Finder normally does so
   - rerun current-chart backtest only
5. Extend copy/export metadata to include universe summary and symbol breakdown.

### Files

- `lib/finder/finder-ui.ts`
- `lib/finder-manager.ts`
- `lib/types/finder.ts`
- `tests/finder-universe-runner.spec.ts`

### Implementation Notes

- Do not try to switch the chart through every universe symbol on apply.
- The row must show enough aggregated evidence that the user can judge robustness without expanding every item.
- The expanded symbol list must make `no_trades`, `load_failed`, and `run_failed` visible.
- The expanded symbol list must also show each symbol's bar count and visible time span.

### Acceptance Criteria

- Universe results are visually distinct from current-chart rows.
- The user can inspect symbol-level breakdown for any survivor.
- Applying a universe result behaves like a normal Finder apply on the current chart.

### Validation

- `npm run typecheck`
- `npm run test`

## Phase 6: Persistence And Polish

### Purpose

Remove friction from repeated experimentation without bloating the app settings contract.

### Changes

1. Persist Finder universe UI state in a dedicated storage record.
2. Persist only Finder-specific UI state:
   - scope
   - universe symbol list
   - universe survivor filters
   - universe sort selection
   - selected strategy key for universe mode
   - current-chart selected strategy keys separately from universe selected strategy key
3. Restore that state during Finder init.
4. Document the feature in repo docs.

### Files

- `lib/finder-manager.ts`
- `lib/persisted-json.ts`
- `README.md`
- `AGENTS.md`

### Implementation Notes

- Do not expand `AppSettings` unless there is a strong cross-feature reason.
- Use a dedicated persisted JSON key and migration path.
- If persistence is skipped for the first shipping cut, keep the code structure ready for it instead of coupling universe state into unrelated settings code.

### Acceptance Criteria

- Reloading the app restores the last universe symbol list and scope.
- Finder universe state is isolated from generic backtest settings persistence.
- Repo docs explain what universe mode is and what it is not.

### Validation

- `npm run typecheck`
- `npm run test`

## Recommended Test Matrix

Add targeted tests for these cases:

1. Universe mode rejects zero selected strategies.
2. Universe mode rejects more than one selected strategy.
3. Universe mode rejects cross-symbol strategies.
4. Universe mode rejects unsupported search modes.
5. Duplicate universe symbols load once.
6. Switching scope preserves current-chart multi-selection and universe single-selection independently.
7. `no_trades` symbols do not count as losses.
8. `minTotalTrades` can still allow rare-trade strategies to survive.
9. Sorting prefers stronger profitable-active coverage over one-symbol outliers.
10. Applying a universe result reruns the current chart only.
11. Universe scoring uses the shared executor semantics, not an ad hoc backtest path.
12. Current-chart Finder parity remains unchanged when scope is `Current Chart`.

## Rollout Order

Implement in this order:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6

Do not start with ranking polish. The hard part is the universe runner and its contract boundaries.
