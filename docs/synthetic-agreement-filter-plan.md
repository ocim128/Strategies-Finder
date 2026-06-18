# Synthetic Agreement Filter Plan

## Purpose

Plan a research workflow that measures whether synthetic-pair signal agreement predicts a target asset move, and whether that agreement improves a target strategy when used as a trade filter.

Example target workflow:

- Target asset: `NEARUSDT`
- Synthetic universe: `NEAR+APT`, `NEAR+BNB`, `NEAR+BTC`, ...
- Chart interval/window: current UI interval and current Finder data window
- Question 1: when synthetic votes are `6 bullish / 2 bearish`, how often does `NEARUSDT` move up over `1/3/6/12` bars?
- Question 2: when the current target strategy fires, does allowing only signals supported by synthetic agreement improve expectancy after costs?

## Assumptions And Unknowns

### Assumptions

- The first supported target is a single real provider-backed symbol such as `NEARUSDT`.
- Synthetic universe entries use the Portfolio Lab style explicit form: `BASE+QUOTE`.
- A synthetic pair vote is target-linked only when the target asset appears as one leg.
- `BASE+QUOTE` means `base / quote`; rising ratio is base strength and quote weakness.
- The first version should be browser-local and should reuse existing data loaders, strategy execution, and backtest settings.
- The first version should not persist large event-level samples to SQLite.

### Unknowns

- The final UI home is not fixed. Finder is closest to the current workflow; Portfolio Lab already has agreement mechanics but its independence filter conflicts with this use case.
- Target symbol normalization needs a concrete rule for assets with non-USDT quotes.
- The exact live-trade action model is out of scope until the event study and filter backtest show stable lift.
- The initial horizon set and threshold grid should be small enough for UI responsiveness, then expanded only if performance allows.

## Existing Architecture References

- App feature bootstrapping and lazy features: `lib/app-bootstrap.ts`
- Finder UI and Symbol Universe orchestration: `lib/finder-manager.ts`
- Finder universe runner: `lib/finder/finder-runner-universe.ts`
- Finder and Asset Leadership types: `lib/types/finder.ts`
- Asset Leadership aggregation: `lib/finder/asset-leadership.ts`
- Synthetic pair builders: `scripts/lib/synthetic-pair.ts`
- Portfolio Lab synthetic parsing and agreement helpers:
  - `lib/portfolioLab/portfolio-lab-synthetic.ts`
  - `lib/portfolioLab/portfolio-lab-helpers.ts`
  - `lib/portfolioLab/portfolio-lab-sweep.ts`
  - `lib/portfolioLab/portfolio-lab-consensus.ts`
- Shared backtest executor: `lib/backtest-executor.ts`
- Backtest service prepared-signal evaluation: `lib/backtest-service.ts`

## System Architecture

The feature should be a local research analyzer, not a new service.

Recommended MVP shape:

- Add pure analysis module under `lib/finder/`, for example `lib/finder/synthetic-agreement-filter.ts`.
- Add small type module if the contracts grow, for example `lib/types/synthetic-agreement.ts`.
- Wire UI from Finder only after the pure analyzer is tested.
- Reuse existing lazy Finder initialization instead of adding a new app bootstrap feature in v1.

Why Finder first:

- The user workflow already starts from Finder Symbol Universe and synthetic pair lists.
- Finder already has strategy selection, current settings, data window selection, progress/status UI, and synthetic universe loading.
- Asset Leadership stores aggregate universe summaries, but it does not retain event-level signals.
- Portfolio Lab has useful agreement primitives, but its `isIndependentPeer(...)` behavior intentionally discards shared-leg pairs, which would remove the NEAR breadth signal this feature is trying to measure.

## Data Flow

1. Read target symbol, current interval, selected strategy, strategy params, backtest settings, capital settings, and analysis options from existing UI state.
2. Parse synthetic universe symbols.
3. Load target OHLCV data with the same window semantics used by Finder.
4. Load each synthetic pair by reusing existing synthetic generation helpers:
   - parse `BASE+QUOTE`
   - fetch base and quote data
   - build synthetic ratio bars
   - aggregate to target interval when needed
5. Execute the selected strategy on each synthetic pair through the shared execution path and retain returned signals.
6. Map each synthetic signal to a target direction vote:
   - target is base leg: `buy` means bullish, `sell` means bearish
   - target is quote leg: `buy` means bearish, `sell` means bullish
   - target not present: exclude from target-linked vote counts
7. Bucket votes by target candle time using a configurable lag window.
8. Build event-study samples from vote states and forward target returns.
9. Build trade-filter samples by evaluating target strategy signals with agreement conditions.
10. Render threshold matrix and filter-backtest summary.

## API And Contracts

### New Pure Contracts

Proposed input shape:

```ts
interface SyntheticAgreementAnalysisInput {
    targetSymbol: string;
    interval: string;
    targetData: OHLCVData[];
    syntheticRuns: SyntheticAgreementPairRun[];
    targetSignals: Signal[];
    horizons: number[];
    lagBars: number;
    thresholds: SyntheticAgreementThreshold[];
}
```

Proposed pair run shape:

```ts
interface SyntheticAgreementPairRun {
    symbol: string;
    baseSymbol: string;
    quoteSymbol: string;
    data: OHLCVData[];
    signals: Signal[];
}
```

Proposed threshold shape:

```ts
interface SyntheticAgreementThreshold {
    minBullish: number;
    maxBearish: number | null;
    minActive: number;
    minNet: number | null;
}
```

Proposed output categories:

- Event-study matrix by threshold and horizon.
- Trade-filter comparison for baseline, allowed trades, skipped trades, and opposed trades.
- Per-pair contribution summary.
- Diagnostics for skipped symbols and insufficient samples.

### Contract Rules

- Analysis functions must be pure and deterministic for the same input arrays.
- No analysis function should read DOM, global `state`, `dataManager`, or `strategyRegistry`.
- Time alignment must use existing `timeKey(...)` behavior.
- Forward-return calculations must start after the decision bar unless an explicit same-close diagnostic is added and clearly labeled.
- The analyzer must report sample counts for every displayed statistic.

## Module Boundaries

### Pure Analysis Module

Owns:

- Vote mapping.
- Agreement bucket construction.
- Forward-return event study.
- Threshold matrix.
- Target trade filtering logic.
- Sample-count and diagnostics calculations.

Does not own:

- DOM reads/writes.
- Data fetching.
- Strategy loading.
- Persistence.
- Toasts/status text.

### Finder Integration

Owns:

- Reading current Finder/UI settings.
- Loading target and synthetic data.
- Running selected strategy on target and synthetic pairs.
- Passing pure inputs into the analyzer.
- Rendering results and progress.

### Existing Shared Modules

Reuse without changing semantics:

- `scripts/lib/synthetic-pair.ts` for synthetic construction.
- `lib/backtest-executor.ts` or `backtestService` paths for strategy execution.
- `lib/portfolioLab/portfolio-lab-synthetic.ts` parsing logic if compatible.
- `timeKey(...)` for alignment.

## State Management

MVP state should stay in the Finder manager instance and DOM only:

- latest analysis result
- latest analysis diagnostics
- currently selected thresholds/options

Do not add localStorage or SQLite persistence in the MVP unless the first implementation proves the payload is small and useful.

If persistence is added later:

- Store run metadata and compact summaries only.
- Do not store full signal arrays or per-bar samples by default.
- Use existing local SQLite API patterns, not a new persistence mechanism.

## Performance Considerations

- Reuse Finder's existing synthetic dataset cache where possible.
- Cap synthetic universe size in the UI; start with a conservative limit matching current browser responsiveness.
- Avoid storing per-bar objects for every threshold; compute compact counters and keep only limited example samples.
- Run pair backtests with an existing concurrency helper such as `mapWithConcurrencyLimit`.
- Yield during long runs using existing Finder task-yielding patterns.
- Avoid re-running synthetic pair strategy execution for each threshold; execute once, then analyze many thresholds from the retained signal presence.

## Edge Cases

- Target asset appears as quote leg and votes must invert.
- Pair does not include the target asset.
- Pair contains malformed `+` syntax.
- Both buy and sell appear for the same pair/time; mark as ambiguous and exclude from directional vote.
- Synthetic data and target data have incomplete overlap.
- Forward horizon exceeds available target candles.
- Agreement condition has high win rate but very low sample count.
- Strong agreement only works during a target uptrend; report time-split stability before treating it as robust.
- Multiple pairs are highly redundant because they share the target leg; present agreement as breadth across denominators, not independent confirmation.

## Failure Handling

- Loading failures should be reported per symbol and should not fail the entire run unless no target data or no valid synthetic pairs remain.
- Strategy execution failure on one synthetic pair should skip that pair and preserve diagnostics.
- If the target strategy produces no signals, event study can still run, but trade-filter backtest should show a no-target-signals diagnostic.
- If all thresholds have insufficient samples, render that directly instead of showing empty or misleading rates.

## Observability And Logging

Use existing `debugLogger` patterns from Finder:

- analysis start/end with target, interval, universe size, horizons, and thresholds
- symbol load failures
- strategy execution failures
- elapsed time split: data loading, signal generation, analysis, rendering

Do not log full signal arrays or large per-bar samples.

## Security Considerations

No new secrets or network credentials are required.

The feature should not touch Execution Lab live-trade request payloads, local executor boundaries, wallet keys, or Worker alert APIs.

## Rollback Strategy

- Keep analyzer pure and isolated.
- Gate the UI behind a single Finder action/section so it can be hidden or removed without changing normal Finder runs.
- Do not alter existing Symbol Universe ranking semantics in the MVP.
- Do not change existing Portfolio Lab shared-leg independence behavior.
- If a regression appears, revert the UI wiring while leaving pure tests as reference if useful.

## Phase 1: Pure Analyzer Contract

### Objective

Define and test the event-study and trade-filter math without UI, data fetching, or persistence.

### Scope

- New pure analysis module.
- New TypeScript interfaces for inputs/outputs if needed.
- Unit tests with small deterministic candle and signal fixtures.

### Technical Tasks

- Implement target-leg detection and vote direction mapping.
- Build signal presence by target time and lag window.
- Compute bullish, bearish, active, and net vote counts.
- Compute forward returns for configured horizons.
- Build threshold summaries with sample counts, up/down rates, average return, median return, MFE, and MAE if feasible.
- Build trade-filter summaries from target strategy signals:
  - baseline target signals
  - allowed signals
  - skipped signals
  - opposed signals

### Dependencies

- `OHLCVData`, `Signal`, and `Time` types from existing strategy types.
- `timeKey(...)` from existing backtest utilities.

### Risks/Blockers

- Incorrect target asset normalization can invert or exclude valid votes.
- Same-bar return measurement can accidentally leak the decision candle move.
- Too many metrics in v1 can obscure the core result.

### Deliverables

- Pure analyzer module.
- Focused unit tests.
- Documented contract comments for vote direction and forward-return timing.

### Validation/Testing Criteria

- Test `target is base` vote mapping.
- Test `target is quote` vote inversion.
- Test malformed or unrelated pairs are excluded.
- Test ambiguous same-time buy/sell is excluded.
- Test forward returns start after the decision bar.
- Test threshold samples and rates on deterministic fixtures.

### Exit Criteria

- Pure tests pass.
- Analyzer output is stable and small enough to render directly.
- No DOM, state, data-manager, or strategy-registry dependency exists in the pure module.

## Phase 2: Finder Data And Execution Adapter

### Objective

Create the adapter that gathers current target/synthetic data and strategy signals for the pure analyzer.

### Scope

- Finder-side orchestration only.
- No permanent persistence.
- No change to existing Symbol Universe ranking.

### Technical Tasks

- Parse synthetic universe text using existing or shared parsing logic.
- Resolve target asset from current target symbol.
- Load target data with Finder data-window semantics.
- Load synthetic pairs using existing synthetic helpers and cache.
- Execute selected strategy/current params on target and each synthetic pair.
- Retain returned signals and compact diagnostics.
- Pass all data to the Phase 1 analyzer.

### Dependencies

- `lib/finder-manager.ts`
- `scripts/lib/synthetic-pair.ts`
- `lib/backtest-executor.ts` or existing `backtestService` evaluation methods
- `paramManager`, `settingsManager`, and existing Finder selected-strategy state

### Risks/Blockers

- Existing Portfolio Lab signal extraction calls `strategy.execute(...)` directly; this feature should prefer the shared execution path so confirmation filters, polarity, 1s gap isolation, and settings behavior stay aligned.
- Cross-symbol and Polymarket context strategies may not be supportable in v1.
- Large synthetic lists may make browser runs slow.

### Deliverables

- Finder adapter function or methods.
- Diagnostics for loaded/skipped/failed pairs.
- Support fences for unsupported strategy types.

### Validation/Testing Criteria

- Unit-test parsing and target-linked filtering where possible.
- Run focused tests for synthetic-pair transform behavior.
- Manual smoke run with a small `NEAR+BTC`, `NEAR+ETH`, `NEAR+SOL` list.

### Exit Criteria

- Adapter can produce analyzer input for at least one normal strategy and a small synthetic universe.
- Unsupported strategy families fail loud with clear status.
- Existing Finder Symbol Universe behavior is unchanged.

## Phase 3: Result Rendering In Finder

### Objective

Expose the analysis in the UI as a concise threshold matrix and trade-filter comparison.

### Scope

- Finder tab UI.
- DOM contract updates if structural ids are added.
- No new top-level app tab in v1.

### Technical Tasks

- Add a small Finder section for Synthetic Agreement Filter.
- Add controls:
  - target symbol, default current symbol
  - horizons
  - lag bars
  - minimum samples
  - threshold presets or compact grid
- Add run button and status text.
- Render:
  - Event Study table
  - Trade Filter table
  - skipped/failed pair diagnostics
  - best threshold by expectancy lift and sample count
- Keep existing Finder results rendering separate.

### Dependencies

- `html-partials/tab-finder.html`
- `lib/finder-manager-dom.ts`
- `lib/finder-manager.ts`
- `tests/feature-dom-contracts.spec.ts`

### Risks/Blockers

- Finder tab is already dense; UI must stay compact.
- Structural id drift can break feature DOM contract tests.
- Too many result tables can make the output hard to use.

### Deliverables

- Finder UI controls and renderer.
- Updated DOM contract.
- Empty/loading/error states.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- Manual smoke run on a small synthetic list.

### Exit Criteria

- User can run analysis without changing normal Finder flow.
- Tables show sample counts and baseline lift for every displayed rate.
- No UI ids are missing from DOM contract tests.

## Phase 4: Robustness Diagnostics

### Objective

Add enough robustness checks to decide whether a discovered threshold is live-trade candidate material or likely curve fit.

### Scope

- Analysis-layer additions.
- Compact UI summary.
- No live trading integration.

### Technical Tasks

- Time-split summaries:
  - oldest/middle/newest or configurable folds
- Delay tests:
  - decision at `+1`, `+2`, `+3` bars
- Pair dropout tests:
  - remove top-contributing pair
  - remove worst-contributing pair
  - optional deterministic random subset
- Baseline comparison:
  - all-bar forward return baseline
  - target-strategy baseline
  - filtered strategy lift
- Threshold stability:
  - neighboring thresholds should be displayed together.

### Dependencies

- Phase 1 analyzer output shape.
- Phase 3 rendering surface.

### Risks/Blockers

- Robustness checks can multiply runtime if implemented by re-running strategy execution.
- Pair dropout can be misleading with too few pairs.
- Time splits may be under-sampled on short windows.

### Deliverables

- Robustness summary object.
- UI summary with pass/warn diagnostics.
- Tests for time split and delay calculations.

### Validation/Testing Criteria

- Tests prove delay uses later execution bars and does not reuse current-bar returns.
- Tests prove pair-dropout does not re-run strategy execution.
- Manual check that low-sample splits are labeled insufficient.

### Exit Criteria

- A threshold can be classified as promising, fragile, or under-sampled from displayed evidence.
- Robustness diagnostics do not materially slow small universe runs.

## Phase 5: Optional Persistence And Export

### Objective

Persist or export compact summaries only after the run shape is proven useful.

### Scope

- Optional later phase.
- No database schema in MVP.

### Technical Tasks

- Add copy/export JSON for compact analysis output.
- Consider SQLite persistence only for run metadata and threshold summaries.
- Add schema migration only if persisted history is required.

### Dependencies

- Stable analyzer output contract.
- Existing local SQLite API patterns if persistence is approved.

### Risks/Blockers

- Event-level samples can be large and should not be stored blindly.
- Schema churn is likely if persistence is added before the report shape stabilizes.

### Deliverables

- Copy/export action.
- Optional local SQLite run-summary storage.

### Validation/Testing Criteria

- Export JSON excludes full candle arrays and large signal arrays.
- If SQLite is added, migration test or manual migration validation is required.

### Exit Criteria

- Exported or stored summaries are compact and sufficient to compare runs.
- Normal Finder and Asset Leadership persistence remain unchanged.

## Documentation Updates

### Objective

Keep the user-facing contract aligned with implementation.

### Scope

- New or updated docs only after implementation behavior exists.

### Technical Tasks

- Update `docs/synthetic-pairs.md` to list Synthetic Agreement Filter as a supported research surface if implemented.
- Add usage notes for target-linked vote interpretation.
- Document that agreement across `NEAR+X` pairs is not independent confirmation; it is breadth across denominators.
- Document unsupported live-trade behavior until explicitly implemented.

### Dependencies

- Phase 3 UI behavior.
- Phase 4 robustness labels.

### Risks/Blockers

- Documentation can overstate live-trade readiness if robustness checks are not complete.

### Deliverables

- Updated user-facing documentation.

### Validation/Testing Criteria

- Relative links resolve.
- File paths referenced in docs exist.
- Support matrix matches implemented surfaces.

### Exit Criteria

- Docs explain how to read event-study and trade-filter output without implying live execution support.

## Recommended MVP Cut

Build phases 1 through 3 first.

Defer:

- SQLite persistence.
- Worker alerts.
- Execution Lab live-trade integration.
- Multi-strategy ensemble agreement.
- Automatic threshold optimization.

The MVP is complete when the user can answer:

- "When synthetic agreement is this strong, what is the target's forward up/down probability by horizon?"
- "When this agreement is used as a filter on my current target strategy, did expectancy and drawdown improve versus baseline?"

