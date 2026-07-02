# Batch Synthetic State Analog Miner Plan

## Purpose

Plan a local research workflow that turns Batch Backtest synthetic-pair runs into robust current asset verdicts based on historical state analogs and real target-asset forward outcomes.

The miner answers:

- When the current strategy configuration creates a synthetic-pair state like the current one, what happened next historically?
- Is the current setup early, late, exhausted, recovering, or inconclusive?
- Which linked synthetic pairs are useful, neutral, or harmful to the verdict?
- Does the verdict survive out-of-sample windows and leave-one-pair-out checks?

Output is a verdict such as `LONG`, `SHORT`, `WATCH`, `SKIP`, or `INCONCLUSIVE` with sample counts, OOS evidence, MFE/MAE, and failure reasons.

## Assumptions And Unknowns

### Assumptions

- The first implementation uses the existing Batch Backtest surface because it replays the current strategy, current params, backtest settings, and capital settings across a pasted symbol list.
- Synthetic pair symbols use explicit `BASE+QUOTE` syntax.
- `BASE+QUOTE` means `base / quote`; rising ratio means base strength and quote weakness.
- Current strategy configuration means the same strategy key, normalized strategy params, backtest settings, capital settings, interval, and execution model used by Batch Backtest.
- The first version is browser-local and adds no service, endpoint, worker, or deployment step.
- The first version keeps full event samples in memory only and copies/exports compact summaries.
- Each asset verdict requires real target-asset OHLCV loaded on the same interval. Synthetic-pair states are predictors; target-asset forward returns are labels.
- Robustness uses the repo's existing data-window pattern: older windows for discovery/selection and newest window as final OOS evidence.

### Unknowns

- Target asset list normalization needs a concrete rule for non-USDT assets and assets that appear only as compressed symbols.
- Current Batch Backtest does not expose raw signals/trades in the copied output; the miner must retain artifacts before Batch compresses them.
- Threshold defaults and distance weights need fixture-driven validation before they are used for OOS verdicts.

## Existing Architecture References

- Batch UI service: `lib/batch-backtest/batch-backtest-service.ts`
- Batch pure runner: `lib/batch-backtest/batch-backtest-runner.ts`
- Batch detached dataset loader: `lib/batch-backtest/batch-backtest-loader.ts`
- Data manager detached fetch path: `lib/data-manager.ts`
- Shared backtest executor: `lib/backtest-executor.ts`
- Backtest result/trade contracts: `lib/types/strategies.ts`
- Trade timing diagnostics: `lib/trade-timing-quality.ts`
- Post-entry/open-trade path analysis: `lib/backtest-result-analysis.ts`
- Portfolio Lab analog forecast primitives: `lib/portfolioLab/portfolio-lab-forecast.ts`
- Portfolio Lab synthetic parsing helpers: `lib/portfolioLab/portfolio-lab-synthetic.ts`
- Portfolio Lab peer-independence helper to avoid reusing directly for this feature: `lib/portfolioLab/portfolio-lab-helpers.ts`
- Finder data-window types: `lib/types/finder.ts`
- Synthetic pair builder and source-bar logic: `scripts/lib/synthetic-pair.ts`

## Non-Goals

- No live trading automation.
- No new API, Worker, microservice, or deployment flow.
- No strategy-generation or strategy-optimization changes.
- No change to backtest fill semantics.
- No Rust engine implementation for the miner in v1.
- No persistence of full per-bar samples in SQLite/localStorage in v1.
- No blind pair weighting trained and tested on the same window.
- No replacement of Finder, Batch, Portfolio Lab, or Signal Committee.

## System Architecture

The miner is a local analyzer layered on top of Batch Backtest artifacts.

MVP shape:

- Add pure analyzer module under `lib/batch-backtest/`: `lib/batch-backtest/batch-synthetic-state-miner.ts`.
- Add type module only if contracts become large: `lib/types/batch-synthetic-miner.ts`.
- Extend Batch runner or service to retain artifact payloads needed by the miner:
  - symbol
  - synthetic base/quote assets
  - candle data reference
  - raw `BacktestResult.trades`
  - raw strategy signals returned by `executeBacktest(...)`
  - time index / time keys
- Load real target-asset datasets separately from synthetic pair datasets.
- Add UI wiring after the pure analyzer is tested.

Do not place core logic in DOM rendering code. The analyzer must be callable from tests with plain arrays and result objects.

## Module Boundaries

### Pure Analyzer

Owns:

- Parsing synthetic pair participation by asset.
- Mapping pair trade/signal direction into asset direction.
- Building historical state snapshots.
- Building current state snapshots.
- Nearest-neighbor / bucket matching.
- Train/selection/OOS window split calculations.
- Leave-one-pair-out and pair-contribution diagnostics.
- Verdict classification and reasons.

Does not own:

- DOM reads/writes.
- Strategy loading.
- Data fetching.
- Toasts/status text.
- LocalStorage/SQLite persistence.

### Batch Integration

Owns:

- Reading current Batch symbol list.
- Reading current strategy/params/settings once.
- Loading detached datasets via existing Batch loader.
- Running `executeBacktest(...)`.
- Passing per-symbol artifacts to the analyzer.
- Loading target-asset OHLCV for assets present in parsed synthetic pairs.
- Rendering/copying compact verdict output.

### Portfolio Lab Reuse Boundary

Reusable ideas:

- Forecast snapshots.
- Nearest analog matching.
- MFE/MAE and remaining-PnL style outcomes.
- Confidence shrinkage toward baseline.

Do not directly reuse independent-peer filtering for synthetic shared-leg mining. `isIndependentPeer(...)` intentionally excludes shared-leg pairs, while this miner needs shared-leg pairs.

## Data Flow

1. User pastes synthetic pair list into Batch Backtest.
2. User selects interval, strategy, params, backtest settings, and capital settings as usual.
3. Batch loads each symbol using `loadBatchDataset(...)`.
4. Batch runs `executeBacktest(...)` for each pair and retains artifacts before formatting rows.
5. Miner parses `BASE+QUOTE` for every successful synthetic pair.
6. Miner derives the target asset universe from parsed base/quote legs.
7. Miner loads real target-asset OHLCV for each target asset on the active interval.
8. Miner aligns target data and linked synthetic pair data by `timeKey(...)`.
9. Miner groups artifacts by asset leg.
10. For each asset and each historical decision time, miner builds state snapshots from linked pairs:
   - open pair trades by asset direction
   - latest pair signals by asset direction within a lag window
   - signal/trade age
   - agreement/opposition level
   - agreement/opposition transition over fixed lookbacks
   - agreement and opposition counts
   - median bars held
   - median move since entry in percent and ATR units
   - adverse excursion
   - breadth persistence
   - pair contribution identifiers
11. Miner labels each historical snapshot with target-asset future outcomes:
   - target forward return over configured horizons
   - future MFE
   - future MAE
   - synthetic open-trade continuation context as a diagnostic, not the primary label
12. Miner builds the current snapshot for each asset from the latest aligned target bar.
13. Miner compares current snapshot against historical analogs and windows.
14. Miner emits compact verdicts and diagnostics.

## API And Contracts

### Proposed Inputs

```ts
interface BatchSyntheticMinerInput {
    interval: string;
    targets: BatchSyntheticTargetArtifact[];
    artifacts: BatchSyntheticPairArtifact[];
    options: BatchSyntheticMinerOptions;
}

interface BatchSyntheticTargetArtifact {
    asset: string;
    symbol: string;
    data: OHLCVData[];
}

interface BatchSyntheticPairArtifact {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    data: OHLCVData[];
    signals: Signal[];
    result: BacktestResult;
}

interface BatchSyntheticMinerOptions {
    lagBars: number;
    horizons: number[];
    targetQuoteSuffix: "USDT";
    minSamples: number;
    minOosSamples: number;
    neighborCountMin: number;
    neighborCountMax: number;
    maxEntryDistance: number;
    minEntryReturnPct: number;
    minEntryLiftPct: number;
    minMfeMaeRatio: number;
}
```

### Proposed Outputs

```ts
interface BatchSyntheticAssetVerdict {
    asset: string;
    verdict: "LONG" | "SHORT" | "WATCH" | "SKIP" | "INCONCLUSIVE";
    direction: "long" | "short" | null;
    confidence: "high" | "medium" | "low" | "none";
    currentSnapshot: BatchSyntheticStateSnapshot | null;
    evidence: BatchSyntheticVerdictEvidence;
    reasons: string[];
    pairContributions: BatchSyntheticPairContribution[];
    diagnostics: string[];
}
```

### Contract Rules

- Analyzer inputs must be detached from global `state`.
- Time alignment must use existing `timeKey(...)` behavior.
- V1 target symbol resolution is `<ASSET>USDT`. Missing target data produces an asset-level diagnostic and `INCONCLUSIVE`.
- Direction must be asset-relative:
  - pair `A+B` long means bullish `A`, bearish `B`
  - pair `A+B` short means bearish `A`, bullish `B`
- Forward outcomes must be measured on real target-asset OHLCV and must start after the decision bar unless explicitly labeled otherwise.
- The output must always include sample counts.
- High agreement is not sufficient for `LONG` or `SHORT`; the verdict must depend on historical analog outcomes.
- If current state is outside the historical distribution, verdict must be `INCONCLUSIVE`.
- Distance fields and weights are fixed before OOS evaluation. Tuning them on the newest window invalidates the verdict.

## Verdict Model

The miner classifies state quality, not just direction.

Minimum verdict gates:

- enough historical analogs
- enough OOS analogs
- OOS expectancy better than baseline
- future MFE/MAE acceptable for the intended horizon
- current analog distance below max distance
- leave-one-pair-out remains stable
- no single pair dominates evidence
- newest window does not contradict older selected windows

Verdict meanings:

- `LONG`: current state has robust positive long-side OOS evidence.
- `SHORT`: current state has robust positive short-side OOS evidence.
- `WATCH`: direction is favorable but timing is not entry-grade yet, usually because extension, opposition, or analog distance is borderline.
- `SKIP`: current state has enough evidence and historically poor remaining expectancy or late/exhausted behavior.
- `INCONCLUSIVE`: insufficient samples, missing data, unstable OOS, or state outside historical analog coverage.

## Robustness Design

### Window Split

Use existing fifth-window semantics:

- discovery: `1/5`, `2/5`, `3/5`
- selection: `4/5`
- final OOS: `5/5 newest`

Backtest artifacts and labels must not leak across window boundaries:

- Synthetic pair strategy execution for window validation must use window-local candle arrays or samples whose trade entry, current decision time, exit/outcome horizon, and target label are fully inside the same window.
- A trade opened before a window cannot create a training sample inside that window unless the window explicitly supports carry-in state and labels it as such.
- The newest `5/5` window is evaluation-only. Do not tune thresholds, feature weights, or pair inclusion from it.
- Analyzer-local slicing must not reinterpret a full-window trade as if it were generated inside a shorter window.

### Leave-One-Pair-Out

For each accepted verdict:

- recompute evidence while excluding each linked pair
- report whether verdict remains, degrades, flips, or becomes inconclusive
- label pairs as useful, neutral, harmful, or dominating

Do not train pair weights on the same window used to report performance.

### Baselines

Compare analog outcomes against:

- all asset-linked samples for the same direction
- same timeframe/window baseline

A verdict must show lift over baseline, not only positive raw returns.

## State Management

MVP state remains in `BatchBacktestService` instance memory:

- latest raw Batch artifacts for the active run
- latest miner result
- latest copy/export text

Do not persist event-level snapshots in v1.

Persistence is out of scope for v1. Future persistence stores:

- compact verdicts, run metadata, and robustness summaries
- no full signal arrays or per-bar analog samples
- existing local persistence patterns only

## UI Scope

MVP UI is Batch-local:

- Add a `Mine Timing` button after a successful Batch run.
- Add a compact verdict panel below Batch results.
- Add a copy button for miner output only if the result exists.
- Keep existing Batch copy output unchanged.

Displayed fields:

- asset
- verdict
- direction
- confidence
- sample count / OOS sample count
- expected forward return
- expected MFE / MAE
- baseline comparison
- late/exhaustion reason when applicable
- top agreeing/opposing pairs
- leave-one-out warnings

Avoid large tables in v1. Use compact rows and expandable diagnostics only if needed.

## Performance Considerations

- Do not rerun backtests for each condition threshold.
- Build pair artifacts once from the Batch run.
- Reuse per-symbol time indexes.
- Avoid allocating full snapshot objects for every bar if compact numeric rows are enough.
- Cap retained nearest analog examples.
- Yield during long analysis when processing exceeds a short UI-safe batch.
- Keep analyzer pure so performance tests can run without DOM.
- Respect Batch's detached dataset loading and cache behavior.

Bottlenecks:

- 110 pairs * 50k bars can produce millions of pair-bar states.
- Building all asset snapshots naively for every bar and every asset can exceed browser memory/time budgets.
- Leave-one-pair-out can multiply work unless computed from reusable aggregate counters.

Preferred implementation approach:

- first build per-pair event streams
- aggregate by asset/time only for active signal/trade windows
- compute current state and historical candidate samples from event windows
- add dense per-bar scoring only if event-window sampling is insufficient

## Failure Handling

- Symbol load failure produces a per-pair diagnostic and does not fail the entire miner.
- Malformed pair symbols are skipped with diagnostics.
- Pairs that do not parse as synthetic `BASE+QUOTE` are excluded.
- Pairs with too few bars are excluded.
- Analyzer returns `INCONCLUSIVE` when no asset has enough linked evidence.
- If all current states are outside historical analog coverage, report that directly.
- If current Batch results are stale relative to current strategy/settings/symbol list, disable or invalidate miner output.

## Observability And Logging

Use `debugLogger` only for compact operational events:

- miner start/end
- pair artifact counts
- skipped pair counts by reason
- analysis timing
- verdict count summary
- major failure reason

Do not log full trade arrays, signal arrays, or per-bar samples.

## Security Considerations

No new external network surface is planned. The miner operates on already-loaded market data and local Batch artifacts.

Do not send strategy settings, trades, or synthetic-pair samples to external services.

## Rollback Strategy

- Keep the feature behind a new Batch-local action.
- Do not change existing Batch run behavior or copy output in the first implementation.
- Add the analyzer as a pure module first; if UI wiring causes issues, remove the button/panel while leaving tests and pure logic intact.
- Avoid schema changes in v1, so rollback does not require data migration.

## Edge Cases

- Agreement/opposition improves while target price has already moved.
- Agreement/opposition worsens while target price has not moved yet.
- Many pairs agree, but all agreement comes from one asset cluster.
- One pair dominates analog selection.
- Current state is new and has no close historical analog.
- Synthetic pair is base-linked for one asset and quote-linked for another; direction must invert correctly.
- Open `end_of_data` trades are usable for current state but excluded from closed-trade outcome labels.
- Future horizon exceeds available candles.
- Strategy emits buy and sell on the same bar for a pair; mark ambiguous.
- Different pairs have incomplete time overlap.
- Timeframe is high enough that latest open trade began long ago.

## Phase 1: Artifact Capture And Contracts

### Objective

Expose the Batch and target-asset artifacts required for mining without changing Batch backtest behavior.

### Scope

- Batch Backtest only.
- Current strategy configuration only.
- Successful synthetic pair rows and successfully loaded target-asset datasets only.
- In-memory artifacts only.

### Technical Tasks

- Define miner artifact types.
- Parse Batch symbols into synthetic pair components.
- Derive target assets from parsed synthetic pair legs.
- Resolve target-asset symbols for detached OHLCV loading.
- Extend Batch runner/service path to retain:
  - candles
  - `BacktestResult`
  - signals returned by `executeBacktest(...)`
  - parsed base/quote asset names
- Capture a run fingerprint from strategy key, params, settings, interval, symbol list, and target symbol mapping.
- Keep existing Batch row rendering and copy output unchanged.
- Add stale-result invalidation when the Batch symbol list or current run context changes.

### Dependencies

- `runBatchBacktest(...)`
- `loadBatchDataset(...)`
- `executeBacktest(...)`
- `BacktestResult`
- `Signal`
- `OHLCVData`
- synthetic pair parser/helper availability
- detached target data load path

### Risks/Blockers

- Retaining all candle arrays for large batches increases memory use.
- `executeBacktest(...)` signals are currently returned but Batch result shape does not expose them.
- Real-symbol Batch rows are skipped in v1.
- Target symbol mapping can be ambiguous for assets that are not available as `<ASSET>USDT`.

### Deliverables

- Type definitions for Batch miner artifacts.
- Type definitions for target artifacts.
- Batch run artifact capture path.
- Target data load and diagnostic path.
- Run fingerprint for stale-output invalidation.
- Unit tests for synthetic symbol parsing and artifact filtering.

### Validation/Testing Criteria

- Existing Batch tests still pass.
- Existing Batch copy output is unchanged.
- Artifact capture includes signals and trades for successful synthetic rows.
- Target artifacts are present for assets that can be loaded.
- Malformed/non-synthetic rows are skipped with diagnostics.

### Exit Criteria

- A pure test can construct miner input from Batch-style artifacts and target artifacts without DOM or global state.

## Phase 2: State Snapshot Builder

### Objective

Build asset-relative historical and current state snapshots from synthetic pair artifacts aligned to target-asset candles.

### Scope

- Shared-leg synthetic mode.
- Asset-relative direction mapping.
- Event-window sampling from trades/signals.
- Target-time alignment.
- No UI.

### Technical Tasks

- Build per-pair time index using `timeKey(...)`.
- Build per-target time index using `timeKey(...)`.
- Convert pair signals/trades into asset-relative direction.
- Track state features:
  - latest signal direction and age
  - open trade direction and bars held
  - current move from entry in percent
  - ATR-normalized distance from entry
  - adverse excursion
  - agreement/opposition counts
  - active linked pair count
  - breadth persistence
  - recent agreement/opposition transition
- Build current snapshot from latest aligned bar.
- Build historical candidate snapshots from prior trade/signal states.

### Dependencies

- `timeKey(...)`
- `parseTimeToUnixSeconds(...)` when duration is needed
- trade range logic from `backtest-result-analysis.ts` or `portfolio-lab-forecast.ts`
- ATR/directional movement helper logic from Portfolio Lab statistics if reusable
- target artifacts from Phase 1

### Risks/Blockers

- Dense per-bar snapshots can be too large.
- Sparse-signal strategies and long open trades require event sampling that still detects late/exhausted states.
- ATR helper reuse requires moving shared logic out of Portfolio Lab or duplicating a small pure helper.
- Target and synthetic pair calendars can have incomplete overlap.

### Deliverables

- Pure snapshot builder.
- Snapshot diagnostics for skipped/missing alignment.
- Unit tests for base/quote inversion and bars-held/move calculations.

### Validation/Testing Criteria

- `A+B` long maps to bullish `A` and bearish `B`.
- `A+B` short maps to bearish `A` and bullish `B`.
- Current state from an open trade reflects bars held and current move.
- Latest signal state respects lag window.
- Ambiguous same-bar buy/sell is excluded.
- Snapshots are created only when target and linked synthetic pair times align.

### Exit Criteria

- Given synthetic pair artifacts, tests can produce deterministic current and historical snapshots per asset.

## Phase 3: Historical Outcome Labeling

### Objective

Attach real target-asset future outcome labels to historical snapshots so current states can be judged by what happened next.

### Scope

- Forward returns over fixed horizons.
- Target-asset future MFE/MAE from snapshot time.
- Synthetic open-trade continuation diagnostics.
- No execution changes.

### Technical Tasks

- Compute direction-adjusted target-asset forward returns from the snapshot bar.
- Compute target-asset future MFE/MAE from OHLCV highs/lows after the snapshot bar.
- For open-trade-style historical samples, compute synthetic remaining PnL to exit as a diagnostic only.
- Exclude samples whose horizon exceeds available candles.
- Keep sample counts for every horizon and outcome type.

### Dependencies

- `OHLCVData`
- `Trade`
- time index from Phase 2
- target artifacts from Phase 1
- trade timing logic concepts from `lib/trade-timing-quality.ts`
- post-entry path concepts from `lib/backtest-result-analysis.ts`

### Risks/Blockers

- Same-candle OHLC ordering ambiguity if outcomes include the decision candle.
- High timeframe samples can be few after horizon filtering.
- End-of-data synthetic trades can bias diagnostics if treated as normal closed outcomes.
- Missing target candles reduce label coverage.

### Deliverables

- Outcome-labeling helper.
- Tests for long/short MFE/MAE direction.
- Tests that future horizons start after the decision bar.

### Validation/Testing Criteria

- Long and short forward returns are direction-adjusted correctly.
- MFE and MAE use future bars only.
- Primary labels use target OHLCV, not synthetic pair PnL.
- End-of-data current states are allowed, but closed historical diagnostics exclude incomplete trades where required.

### Exit Criteria

- Historical snapshots can be converted into target-labeled candidate samples with deterministic metrics.

## Phase 4: Analog Matching And Verdict Engine

### Objective

Convert current snapshots into robust verdicts using nearest historical analogs and windowed OOS checks.

### Scope

- Nearest-neighbor or compact bucket matching.
- Baseline comparison.
- Conservative verdict classification.
- No UI beyond test fixtures.

### Technical Tasks

- Define a versioned snapshot feature set and distance weights.
- Freeze distance weights before selection/OOS evaluation.
- Select analogs using bounded nearest-neighbor count.
- Compute baseline outcomes for same asset/direction.
- Shrink analog performance toward baseline based on sample count.
- Select pre-OOS and newest-window OOS analogs separately.
- Split samples by data window:
  - discovery
  - selection
  - newest OOS
- Classify verdicts using explicit gates.
- Emit reasons for `WATCH`, `SKIP`, and `INCONCLUSIVE`.

### Dependencies

- Phase 2 snapshots.
- Phase 3 labels.
- Existing Finder data-window semantics.
- Statistical helpers such as average/median if already available.

### Risks/Blockers

- Distance weights can become a hidden overfit surface.
- Too many fields can make nearest-neighbor matching unstable.
- Rare current states produce noisy analog results.
- A broad nearest-neighbor model can hide that the current state is late/exhausted unless distance includes trade age and move-from-entry.

### Deliverables

- Pure verdict engine.
- Verdict evidence shape.
- Unit tests for `LONG`, `SHORT`, `WATCH`, `SKIP`, and `INCONCLUSIVE` cases.

### Validation/Testing Criteria

- High raw agreement cannot pass without OOS lift.
- Positive raw drift cannot pass without lift over baseline.
- OOS-only nearest matches cannot pass without pre-OOS confirmation.
- High analog distance produces `INCONCLUSIVE`.
- A moved-too-far state can produce `SKIP` even if agreement improved.
- A state with insufficient analogs returns `INCONCLUSIVE`.
- Selection-window success with newest-window failure does not produce `LONG`/`SHORT`.
- Changing distance weights after seeing newest-window results changes the model version and invalidates prior OOS claims.

### Exit Criteria

- Current asset verdicts are reproducible from fixture artifacts and include reasons/sample counts.

## Phase 5: Pair Contribution And Robustness Diagnostics

### Objective

Detect whether verdicts depend on one noisy pair or remain stable when pairs are removed.

### Scope

- Leave-one-pair-out analysis.
- Pair contribution summary.
- No learned weights in v1.

### Technical Tasks

- Recompute verdict evidence excluding each linked pair.
- Measure changes in expectancy, MFE/MAE, analog count, and verdict.
- Label pairs:
  - useful
  - neutral
  - harmful
  - dominating
- Add diagnostics when a verdict is pair-dominated.

### Dependencies

- Phase 4 verdict engine.
- Pair IDs retained in snapshots/candidate samples.

### Risks/Blockers

- Naive recomputation can be expensive for 110 pairs.
- Pair contribution is unstable with low sample counts.
- Weighting pairs from contribution results must not be added in v1.

### Deliverables

- Leave-one-pair-out evidence table.
- Pair contribution labels.
- Tests for pair-dominated verdict downgrade.

### Validation/Testing Criteria

- Removing a critical pair downgrades confidence or verdict.
- Removing a harmful pair improves evidence and is reported, not silently optimized.
- Verdict does not pass if one pair dominates sample selection.

### Exit Criteria

- Every accepted `LONG`/`SHORT` verdict includes pair robustness diagnostics.

## Phase 6: Batch UI Integration

### Objective

Expose the miner in Batch Backtest without disrupting existing Batch behavior.

### Scope

- Batch tab only.
- Button and compact verdict panel.
- Copy miner output.
- No persistence.

### Technical Tasks

- Add structural DOM ids to `html-partials/tab-batch-backtest.html`.
- Add matching ids to `lib/batch-backtest/batch-backtest-dom.ts`.
- Add `Mine Timing` action in `BatchBacktestService`.
- Disable miner button until a completed Batch run has artifacts.
- Render compact asset verdict rows.
- Add copy text formatter for miner verdicts.
- Clear miner output when Batch inputs change.

### Dependencies

- Phase 1 artifact capture.
- Phase 4 verdict engine.
- Phase 5 robustness diagnostics.
- Batch DOM contract.

### Risks/Blockers

- UI can become too dense if full diagnostics are rendered by default.
- DOM contract updates require partial and contract changes together.
- Existing Batch result rendering remains visually stable.

### Deliverables

- Batch tab miner controls.
- Compact verdict renderer.
- Copy formatter.
- DOM contract tests updated if new structural ids are added.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- Batch existing tests still pass.
- Manual UI check that Batch run -> Mine Timing -> verdict rows works.
- Changing symbol list clears stale miner output.

### Exit Criteria

- User can run Batch, click Mine Timing, and copy robust verdict output.

## Phase 7: Documentation And Operator Guidance

### Objective

Document what the miner verdict means and what it does not mean.

### Scope

- Repo docs only.
- No strategy-specific lore.

### Technical Tasks

- Add a short usage section to a relevant doc if behavior is implemented.
- Explain verdict meanings.
- Explain why `INCONCLUSIVE` is a valid result.
- Document that this is research output, not live execution.
- Document data-window/OOS assumptions.

### Dependencies

- Final UI location and output labels from Phase 6.

### Risks/Blockers

- Docs can overstate robustness if implementation details are still changing.
- Imprecise `WATCH` wording can be treated as an entry signal.

### Deliverables

- Updated docs after implementation.
- Copy/export wording aligned with UI labels.

### Validation/Testing Criteria

- Referenced file paths exist.
- Support matrix matches implemented behavior.
- No claims about persistence/API/live trading unless implemented.

### Exit Criteria

- Documentation accurately explains how to run and interpret the miner.

## Implementation Order

1. Phase 1: artifact capture and contracts.
2. Phase 2: snapshot builder.
3. Phase 3: outcome labeling.
4. Phase 4: verdict engine.
5. Phase 5: pair contribution diagnostics.
6. Phase 6: Batch UI integration.
7. Phase 7: documentation.

Do not start UI work before the pure analyzer and verdict engine have focused tests.

## Implementation Deviations From The Original Plan

The shipped implementation diverges from the original design above in five
places. Each deviation was driven by a correctness or measurement failure
observed on real 4H runs and is captured here so the plan stays consistent
with the code.

1. **Carry-in trades are allowed historically.** The plan (Phase 2, "carry-in
   state" guard) restricted carry-in trades to the current snapshot. In
   practice that made the matcher search under a stricter rule than the state
   it was trying to match, suppressing analogs on the higher timeframes where
   the edge lives. The `allowCarryInTrades` parameter was removed; trade age
   is still exposed as a distance feature so old samples are not conflated
   with fresh ones.

2. **Auto-horizons derive from CLOSED trade holds, not open trades.** Open /
   `end_of_data` trades over-represent long holds (survivor bias) and inflated
   horizons 3-5x on higher timeframes, starving the candidate span. The
   `PreparedPairArtifact.closedTradeRanges` field feeds an unbiased median
   hold; horizons are roughly `[0.5x, 1x, 2x]` of that.

3. **The window split is over the candidate span, not the full history.** With
   a large longest horizon, splitting over full history placed the OOS band
   past the last possible candidate bar, starving OOS ("Pre 24, OOS 0"). The
   split now uses `length - longestHorizon`, and the longest horizon is
   clamped so at least 25% of bars remain reachable for OOS.

4. **Multi-horizon outcomes are computed in a single forward pass** and the
   longest horizon gates LONG/SHORT: a short-horizon edge that does not
   survive to the longest horizon downgrades to WATCH. The plan listed
   multiple horizons but only the shortest was originally wired through.

5. **Distance scales are calibrated per target** from the discovery+selection
   IQR (frozen before analog selection) rather than fixed constants. Fixed
   scales let one feature dominate the distance on 4H and pushed every analog
   past `maxEntryDistance`.
