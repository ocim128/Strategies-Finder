# Hunt / Finder Performance Implementation Plan

## Goal

Improve Hunt and Finder performance in a way that is measurably faster, operationally safer, and semantically correct.

This plan is intentionally execution-focused. A later AI agent should be able to implement it phase by phase without needing to rediscover the architecture decisions or re-audit the original performance report.

## Purpose of This Plan

Hunt is currently paying for interactive chart-side behavior during a batch workload. The biggest win is not micro-optimizing Finder math first. The biggest win is to stop treating Hunt as if it were repeatedly driving the live chart UI.

This document exists to:

- rank the verified performance work in the right order
- prevent later implementation from chasing incorrect shortcuts
- keep Finder and backtest semantics stable while reducing avoidable work
- define acceptance criteria and validation per phase

## Verified Priority Decisions

These decisions are based on the verified code audit, not on the original report's estimates.

| Item | Decision | Why |
| --- | --- | --- |
| Detach Hunt data loading from live UI/state | Do first | Biggest architectural waste; Hunt currently uses the live chart load path |
| Add run-local dataset reuse across same symbol/interval | Do first | High value once detached loading exists |
| Remove JSON OHLCV deep clone in Hunt | Do first | Real hot-path waste with low semantic risk |
| Replace Hunt `setTimeout(0)` yielding | Do first | Low-risk win after detached path lands |
| Optimize random-funnel shortlist sorting | Do second | Real allocation churn, but narrower scope than Hunt data path |
| Reuse existing caches during reconciliation | Do second | Real recompute waste without changing ranking semantics |
| Rework Rust payload encoding / extreme batch size | Do only after profiling | Likely useful, but current settings may be memory-safety driven |
| Cache regex-based param classification | Do late | Real but lower-priority than Hunt data-path work |
| Throttle Hunt progress DOM writes | Defer unless profiling proves it matters | Current Finder progress callbacks are already throttled enough that this is unlikely to be first-order |
| Force Rust by stripping unsupported settings | Reject | Would change correctness, not just performance |

## Non-Negotiable Invariants

Every phase must preserve these rules:

- Hunt must not change Finder result semantics just to run faster.
- Rust eligibility remains correctness-first. Do not bypass `requiresTypescriptEngine(...)`.
- Hunt profile schema stays unchanged in this performance plan.
- Sequential profile execution remains the default. Do not introduce multi-profile parallelism in the first pass.
- Detached Hunt execution must not mutate the live chart context:
  - `state.currentSymbol`
  - `state.currentInterval`
  - `state.blockRange`
  - `state.ohlcvData`
  - active streaming session
  - rendered chart UI
- Do not duplicate DataManager provider logic in a Hunt-only loader if the same behavior can be refactored into a shared detached path.

## Important Shortcuts to Avoid

These are specifically not the right implementation path:

- Do not replace `loadData(...)` with `fetchData(...)` blindly.
  - `fetchData(...)` still triggers source-status UI updates in provider paths.
- Do not replace Hunt loading with `fetchDataForScan(...)` as-is.
  - It defaults to a scan-oriented capped dataset and is not equivalent to full Finder/backtest input.
- Do not use raw `loadCachedCandles(...)` as the only Hunt data path.
  - That skips provider fallback, SQLite, seed-file behavior, and other existing DataManager logic.
- Do not cache signals for every candidate across the full Finder run.
  - That risks blowing up memory and defeats large-dataset safeguards.
- Do not tune DOM progress updates before removing live UI churn and dataset cloning.

## Current Files and Seams That Matter

Primary implementation surfaces:

- `lib/hunt/hunt-runner.ts`
- `lib/hunt/hunt-service.ts`
- `lib/data-manager.ts`
- `lib/finder/finder-runner.ts`
- `lib/finder/finder-runner-single.ts`
- `lib/finder/finder-runner-core.ts`
- `lib/finder/finder-runner-shared.ts`
- `lib/finder-manager.ts`

Likely new shared helper:

- `lib/task-yield.ts`

Likely new tests:

- `tests/hunt-runner.spec.ts`

Existing tests to keep green:

- `tests/hunt-model.spec.ts`
- `tests/hunt-results.spec.ts`
- `npm run typecheck`
- `npm run test`

## Phase 0: Baseline and Guardrails

### Purpose

Create enough measurement and regression coverage that later phases can move aggressively without guessing.

### Changes

1. Add structured timing around Hunt's major buckets:
   - detached data load
   - block slice
   - Finder execution
   - total per-profile time
   - total Hunt run time
2. Emit a structured debug event instead of ad hoc console output.
3. Add a dedicated Hunt runner spec instead of relying only on service-level tests.

### Files

- `lib/hunt/hunt-runner.ts`
- `tests/hunt-runner.spec.ts`

### Implementation Notes

- Use `performance.now()` timing only.
- Keep timing behind existing debug logging patterns.
- Do not block later phases on pixel-perfect benchmarking infrastructure.
- The point is relative before/after visibility, not a production telemetry system.

### Acceptance Criteria

- Hunt emits one structured timing summary per run.
- A new test file exists for Hunt runner behavior.
- No functional Hunt behavior changes yet.

### Validation

- `npm run typecheck`
- `npm run test`

## Phase 1: Detach Hunt Execution From Live Chart State

### Purpose

Stop paying interactive chart costs for a batch workflow.

This is the highest-value phase. Hunt should load profile data and run Finder without driving the live chart UI and without mutating shared runtime state.

### Changes

1. Add a detached DataManager fetch surface.
2. Route Hunt to that detached surface.
3. Remove per-profile UI context application from Hunt.
4. Stop clearing/restoring live backtest/chart state unless a remaining code path still requires it.

### Files

- `lib/data-manager.ts`
- `lib/hunt/hunt-runner.ts`
- `tests/hunt-runner.spec.ts`

### Recommended Design

Refactor `DataManager` so the live chart path and the Hunt path share the same provider/caching logic but differ in side effects.

Recommended shape:

```ts
type DataLoadReporter = {
  updateSymbolDataSource?: (label: string, tone: string, title: string) => void;
  showToast?: (message: string, tone: string) => void;
};
```

Then:

- live chart loading uses the real `uiManager`
- detached Hunt loading uses a no-op reporter

Add a new public method with a name like:

- `fetchDataDetached(symbol, interval, signal?)`
- or `fetchDataSnapshot(symbol, interval, signal?)`

The detached path must reuse the same provider resolution and caches as the live path, but it must not call:

- `setMarketSelection(...)`
- `uiManager.clearUI()`
- `uiManager.updateTimeframeUI(...)`
- `commitOhlcvData(...)`
- `stopStreaming()`
- `startStreaming(...)`
- `clearImportedData()`

### Hunt Runner Changes

Replace the current pattern of:

- applying UI settings
- calling `dataManager.loadData(...)`
- reading from `state.ohlcvData`
- slicing with `state.blockRange`

with a local-only pattern:

1. Resolve `backtestSettings` directly from `profile.backtestSettings`.
2. Load raw candles through detached DataManager fetch.
3. Slice using `profile.blockRange` directly.
4. Pass the sliced candles into `runFinderExecution(...)`.

### Additional Rules

- If any downstream Hunt or Finder helper still reads live chart state instead of the provided inputs, fix that callsite.
- Do not keep `applyUiContext(...)` around for profile iteration just because it already exists. The whole point of this phase is to stop using it in the run loop.
- If original-context capture/restore becomes unused after this refactor, remove it instead of keeping dead compatibility code.

### Acceptance Criteria

- Running Hunt does not change the visible chart symbol or interval.
- Running Hunt does not clear indicators, trades, or results from the live chart.
- Running Hunt does not stop or restart chart streaming.
- Hunt no longer depends on `state.ohlcvData` as the profile data source.
- Hunt no longer needs per-profile `applyUiContext(...)`.

### Validation

Automated:

- Add a Hunt runner test that asserts no live chart state mutation during a run.
- Add a Hunt runner test that asserts detached loading does not call chart-only side effects.

Manual:

1. Load a chart with indicators and an existing backtest result.
2. Start Hunt with multiple profiles.
3. Confirm the live chart does not change during the run.

## Phase 2: Add Run-Local Dataset Reuse

### Purpose

Avoid redundant detached loads when multiple profiles share the same market context.

### Changes

1. Add a run-local dataset cache inside `createHuntRunController(...).run()`.
2. Cache the full raw detached dataset, not the block-sliced subset.
3. Reuse the same cached dataset for any profile with the same symbol and interval.

### Files

- `lib/hunt/hunt-runner.ts`
- `tests/hunt-runner.spec.ts`

### Recommended Cache Key

Use a normalized key based on the actual data source context, not only the profile label.

Required inputs:

- normalized symbol
- normalized interval
- resolved provider

If the resolved provider is Binance-derived, include enough market context to distinguish spot vs futures behavior.

Important note:

- Hunt profiles do not currently store Binance market type.
- This performance plan must not change that schema.
- The run-local cache should preserve current behavior by keying off the provider resolution used during the run.

### Implementation Notes

- Store `Promise<OHLCVData[]>`, not only resolved arrays.
  - This prevents accidental duplicate in-flight fetches if the implementation later adds controlled overlap.
- Cache only the full raw dataset.
- Apply `sliceOhlcvByBlock(...)` after the raw dataset is fetched.
- Never mutate the cached raw dataset.

### Acceptance Criteria

- Two profiles with the same symbol and interval fetch raw data only once per Hunt run.
- Different block ranges still produce different sliced arrays from the same cached raw dataset.
- Result semantics remain unchanged.

### Validation

- Add a test with duplicate profiles that proves the detached fetch path is called once.
- Run `npm run test`.

## Phase 3: Remove Hunt Hot-Path Waste

### Purpose

Once Hunt is detached and reusing datasets, remove the remaining avoidable allocations and yield overhead in its own loop.

### Changes

1. Remove JSON deep cloning of OHLCV profile data.
2. Replace Hunt's `setTimeout(0)` yield with the same low-overhead visible-tab strategy Finder already uses.

### Files

- `lib/hunt/hunt-runner.ts`
- `lib/finder-manager.ts`
- `lib/task-yield.ts` (new)
- `tests/hunt-runner.spec.ts`

### JSON Clone Removal

Current anti-pattern:

```ts
const ohlcvData = cloneJson(sliceOhlcvByBlock(...));
```

Replace with:

- direct use of the sliced array if Finder treats input as read-only
- or a narrow clone only if a specific callsite proves mutation

Implementation rule:

- Do not keep JSON round-trip cloning in the Hunt data path.
- Do not replace it with `structuredClone(...)` by default unless a real mutation problem exists.
- The preferred outcome is no deep clone at all for OHLCV in the hot path.

### Shared Yield Helper

Extract FinderManager's yield strategy into a shared utility.

Recommended behavior:

- visible tab: `MessageChannel`
- hidden tab: mostly skip yields, but occasionally use a real timer so visibility can recover correctly

This shared helper should then be used by:

- Finder interactive runs
- Hunt runs

### Acceptance Criteria

- Hunt no longer uses JSON deep clone for OHLCV input.
- Hunt no longer uses plain `setTimeout(0)` as its normal visible-tab yield mechanism.
- FinderManager and Hunt use the same shared yield helper.

### Validation

- `npm run typecheck`
- `npm run test`
- Manual Hunt run with enough work to confirm UI remains responsive

## Phase 4: Fix Low-Risk Finder Pipeline Waste

### Purpose

Reduce avoidable work inside Finder without changing ranking or backtest correctness.

This phase comes after Hunt is fixed, because Finder micro-optimizations are less valuable if Hunt still drives the live chart path.

## Phase 4A: Random Funnel Shortlist Ranking Cleanup

### Purpose

Stop creating temporary comparable result objects inside the `sort(...)` comparator on the random funnel path.

### Files

- `lib/finder/finder-runner-single.ts`
- `lib/finder/finder-runner-core.ts`
- new or updated Finder runner tests as needed

### Changes

Current issue:

- the random funnel prescreen sorts `quickCandidates`
- the comparator calls `buildComparableFinderResult(...)` on both sides for every comparison

Recommended fix:

- build the comparable `FinderResult` once when the candidate is created
- or feed the candidates through `FinderResultRanker` directly

Preferred direction:

- keep the change narrow to the random funnel prescreen path
- do not rewrite the main standard ranking path, because it already uses `FinderResultRanker`

### Acceptance Criteria

- No comparator-time `buildComparableFinderResult(...)` calls remain in the random funnel shortlist sort path.
- Random funnel ordering remains identical for the same inputs.

## Phase 4B: Reconciliation Cache Reuse

### Purpose

Avoid rebuilding identical expensive derived state when reconciling final top results.

### Files

- `lib/finder/finder-runner-single.ts`
- `lib/finder/finder-runner-core.ts`
- `lib/finder/finder-runner-shared.ts`

### Changes

Current issue:

- reconciliation creates a new `precomputeIndicators(...)` result
- reconciliation creates a new `FinderPreparedDataCache`
- both are for the same `closedData` and the same effective settings already used in the main run

Recommended fix:

- pass the existing `singleTfPrecomputed`
- pass the existing `preparedDataCache`
- reuse both inside `reconcileSingleTimeframeTopResults(...)`

Important constraint:

- Do not cache every candidate's signal array across the whole run.
- If signal reuse is ever added later, keep it limited to shortlisted candidates and memory-budgeted.

### Acceptance Criteria

- Reconciliation reuses the main-run indicator precompute and prepared-data cache when settings match.
- Result ranking and final shown output remain identical.

### Validation for Phase 4

- Add or update Finder tests to cover:
  - random funnel ordering parity
  - reconciliation output parity
- Run `npm run test`

## Phase 5: Advanced Rust Path Work, Only After Profiling

### Purpose

Address Rust-batch serialization overhead only after higher-value architectural waste is removed.

### Files

- `lib/finder/finder-runner-core.ts`
- `lib/finder/finder-runner-single.ts`
- `lib/rust-engine-client.ts`
- Rust-side batch contract files if required

### Phase 5A: Compact Signal Payload Redesign

Possible direction:

- replace per-signal object payloads with a compact transferable representation

Rules:

- do this only with profiler evidence
- keep the Rust/TS contract explicit and versioned
- keep fallback behavior intact

### Phase 5B: Revisit Extreme Dataset Batch Size

Possible direction:

- retune the `isExtremeDataset ? 1` batch rule only after measuring memory and serialization behavior with the new payload and cached mode

Rules:

- do not raise extreme-dataset batch size blindly
- current batch sizing may be a deliberate memory guard

### Acceptance Criteria

- Any Rust payload change comes with parity tests and memory-safety validation.
- Extreme-dataset tuning is backed by measurement, not guesswork.

## Phase 6: Low-Priority Parameter Normalization Cache

### Purpose

Reduce repeated regex classification cost in Finder parameter generation after higher-value work is complete.

### Files

- `lib/finder/finder-param-math.ts`
- `lib/finder/finder-param-space.ts`
- `lib/finder/genetic-optimizer.ts`

### Changes

- Add a key-classification cache for repeated checks like:
  - RSI threshold
  - RSI period
  - period-like
  - percent-like
  - non-negative

Rules:

- keep normalization output exactly identical
- do not mix this phase into earlier architectural refactors

### Acceptance Criteria

- Representative keys normalize to identical values before and after the refactor.
- No behavior changes in Finder parameter generation tests.

## Work Explicitly Deferred

These are not part of the first correct implementation pass:

- profile-level parallel execution
- worker-farm Hunt execution
- UI-level progress DOM throttling
- Hunt profile schema changes
- Rust-forced execution when TS-only settings are present

## Suggested Delivery Order

Land this work in this order:

1. Phase 0 baseline and new Hunt runner tests
2. Phase 1 detached Hunt execution
3. Phase 2 run-local dataset reuse
4. Phase 3 hot-path cleanup in Hunt
5. Phase 4 Finder pipeline cleanup
6. Re-profile
7. Phase 5 only if still justified
8. Phase 6 only if still justified

Do not skip from the audit directly to Rust payload redesign. That is not the highest-confidence first move.

## Definition of Done

This plan is complete only when all of the following are true:

- Hunt runs no longer drive the live chart load pipeline per profile.
- Duplicate profile datasets are reused within a Hunt run.
- Hunt no longer deep-clones OHLCV via JSON round-trip.
- Hunt no longer uses visible-tab `setTimeout(0)` yielding.
- Random funnel shortlist sorting and reconciliation avoid the verified avoidable work.
- All existing tests pass.
- New Hunt runner regression coverage exists.
- Manual validation confirms the chart stays visually stable during Hunt execution.
