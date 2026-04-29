# Trade Timing Quality Implementation Plan

## Goal

Add two strategy diagnostics:

- `Entry Score`
- `Exit Score`

Use them to find entry-specialist and exit-specialist strategies without changing strategy execution.

## Purpose

Answer these questions:

- did entries produce favorable movement after entry?
- did exits avoid later adverse movement?
- did exits capture a useful part of the trade's available move?
- which Finder candidates are strong on entry timing only, exit timing only, or both?

## Audit Outcome

The first draft had these weaknesses:

1. Finder timing sorts were not fenced from compact/funnel/genetic paths.
2. Finder metric lookup did not state whether raw `result` or endpoint-adjusted `selectionResult` wins.
3. Entry and exit horizons did not define how to avoid same-candle OHLC ambiguity.
4. Exit giveback was listed for rendering but not defined.
5. Polymarket and Symbol Universe exclusions were stated but not tied to UI behavior.
6. Tiny favorable moves could score too highly because the first formula had no noise floor.

This plan fixes them by:

- requiring full trade-bearing backtests when timing scores are used for Finder sorting
- using selection-adjusted results for Finder timing metric values
- starting entry and exit horizon checks on the candle after the mapped entry/exit candle
- defining capture and giveback explicitly
- disabling incompatible timing sort options in unsupported Finder modes
- shrinking tiny-movement samples back toward neutral using a data-derived movement confidence term

## Locked V1 Scope

1. Add scores to normal backtest results.
2. Show detailed breakdown only in the `Results` tab.
3. Add only `Entry Score` and `Exit Score` to Finder sorting/display.
4. Do not add sample-size penalties. Finder already has minimum trade filters.
5. Do not change strategy signals, fills, risk settings, or ranking defaults unless a user selects the new metrics.
6. Do not add settings in v1.
7. Do not add worker or alert behavior.
8. Keep Polymarket rank modes unchanged.
9. Keep Symbol Universe ranking unchanged in v1.
10. Support Finder timing-score sorting only for current-chart `grid` and `random` modes in v1.

## Non-Goals

- isolated exit-rule testing across a shared entry set
- optimization objectives beyond Finder sorting
- per-strategy custom horizons
- ATR-based tuning
- new chart overlays
- Rust engine metric implementation
- new persistence or localStorage schema
- Genetic Finder timing-score fitness
- Polymarket timing-score ranking
- Symbol Universe timing-score ranking

## Score Contract

Scores are `0..100`.

- `80..100`: excellent
- `60..79`: useful
- `40..59`: mixed
- `0..39`: poor
- unavailable: `null`, rendered as `--`

Use fixed horizons:

- `3` bars
- `10` bars
- `25` bars

Use weights:

- `3` bars: `0.50`
- `10` bars: `0.35`
- `25` bars: `0.15`

If a horizon has no valid samples, exclude it and renormalize remaining weights.

For each horizon, compute a data-derived movement floor:

- `movementFloorPct = median(abs(close[index + horizon] - close[index]) / close[index] * 100)` across the same candle array
- ignore invalid or non-positive closes
- if no valid floor exists, use `0`

Use movement confidence to avoid over-scoring tiny noise:

- `movementTotalPct = favorableMetric + adverseMetric`
- `movementConfidence = movementFloorPct > 0 ? clamp(movementTotalPct / movementFloorPct, 0, 1) : 1`
- `confidenceAdjustedScore = 50 + (rawScore - 50) * movementConfidence`

This is not sample-size awareness. It only prevents a near-flat horizon from producing an extreme score.

## Direction Rules

All trade movement is direction-adjusted.

For long trades:

- favorable movement: price rises
- adverse movement: price falls

For short trades:

- favorable movement: price falls
- adverse movement: price rises

Use existing time helpers:

- `timeKey`
- `getTimeIndex`
- existing parse/normalize helpers when needed

Do not add a new ad hoc time conversion path.

Use the exact candle array used by the backtest candidate:

- normal current-chart run: closed chart data
- cross-symbol strategy: aligned primary data from the cross-symbol resolver
- multi-timeframe run: each timeframe dataset independently

Do not compute timing quality against `state.ohlcvData` if the candidate used a sliced, aligned, or detached dataset.

## Entry Score Formula

Entry Score measures post-entry path quality, independent of actual exit.

Valid entry sample:

- trade has finite positive `entryPrice`
- `entryTime` maps to a candle index
- the horizon fits inside the dataset

Include `end_of_data` trades if the requested post-entry horizon exists.

The post-entry window starts at `entryIndex + 1`.

Do not include the mapped entry candle in MFE, MAE, or forward-close checks. This avoids same-candle OHLC ordering assumptions.

For each horizon:

1. For every valid trade, compute:
   - `mfePct`: max favorable excursion from entry to horizon
   - `maePct`: max adverse excursion from entry to horizon
   - `forwardClosePct`: direction-adjusted close return at horizon
2. Aggregate:
   - `avgMfePct`
   - `avgMaePct`
   - `positiveForwardRatePct`
3. Convert to score:
   - `rawPathScore = 100 * avgMfePct / (avgMfePct + avgMaePct)`
   - if both excursions are zero, use `50`
   - `pathScore = confidenceAdjustedScore(rawPathScore)` using `avgMfePct + avgMaePct`
   - `forwardRateScore = confidenceAdjustedScore(positiveForwardRatePct)` using `avgMfePct + avgMaePct`
   - `horizonScore = 0.70 * pathScore + 0.30 * forwardRateScore`

Final:

- `entryScore = weighted average of horizonScore`

Results tab details:

- horizon score
- average MFE %
- average MAE %
- positive forward rate %
- movement floor %
- movement confidence %
- sample count

## Exit Score Formula

Exit Score measures whether the exit avoided bad future movement and captured available in-trade movement.

Valid post-exit sample:

- trade is not `end_of_data`
- trade has finite positive `exitPrice`
- `exitTime` maps to a candle index
- the horizon fits inside the dataset

The post-exit window starts at `exitIndex + 1`.

Do not include the mapped exit candle in avoided-loss or missed-continuation checks. This avoids treating unknown intrabar movement after the exit as known.

For each horizon:

1. Compute post-exit movement from `exitPrice`:
   - `avoidedAdversePct`: max adverse movement that would have happened if the trade stayed open
   - `missedContinuationPct`: max favorable movement missed after exit
   - `postExitClosePct`: direction-adjusted close return at horizon from the old trade direction
2. Aggregate:
   - `avgAvoidedAdversePct`
   - `avgMissedContinuationPct`
   - `adverseAfterExitRatePct`: percent where the horizon close moved against the old trade
3. Convert to score:
   - `rawProtectionScore = 100 * avgAvoidedAdversePct / (avgAvoidedAdversePct + avgMissedContinuationPct)`
   - if both values are zero, use `50`
   - `protectionScore = confidenceAdjustedScore(rawProtectionScore)` using `avgAvoidedAdversePct + avgMissedContinuationPct`
   - `adverseRateScore = confidenceAdjustedScore(adverseAfterExitRatePct)` using `avgAvoidedAdversePct + avgMissedContinuationPct`
   - `horizonScore = 0.70 * protectionScore + 0.30 * adverseRateScore`

Capture component:

1. For each closed trade with positive in-trade MFE:
   - `realizedMovePct`: direction-adjusted entry-to-exit return
   - `capturePct = clamp(realizedMovePct / mfeDuringTrade, 0, 1) * 100`
2. `captureScore = average capturePct`

In-trade MFE window:

- starts at `entryIndex + 1`
- ends at `exitIndex - 1`
- if `exitIndex <= entryIndex + 1`, MFE is `max(realizedMovePct, 0)`

Giveback:

- `givebackPct = max(0, mfeDuringTrade - max(realizedMovePct, 0))`
- `averageGivebackPct = average givebackPct across capture samples`

Final:

- if capture samples exist:
  - `exitScore = 0.75 * postExitCompositeScore + 0.25 * captureScore`
- otherwise:
  - `exitScore = postExitCompositeScore`

Results tab details:

- horizon score
- average avoided adverse %
- average missed continuation %
- adverse-after-exit rate %
- movement floor %
- movement confidence %
- capture score
- average giveback %
- sample count

## Data Model

Add a result-level optional field:

```ts
interface BacktestResult {
    tradeTimingQuality?: TradeTimingQuality;
}
```

Recommended type shape:

```ts
interface TradeTimingQuality {
    entryScore: number | null;
    exitScore: number | null;
    entry: {
        horizons: TradeTimingEntryHorizon[];
    };
    exit: {
        horizons: TradeTimingExitHorizon[];
        captureScore: number | null;
        averageGivebackPct: number | null;
        captureSampleSize: number;
    };
}
```

Recommended horizon fields:

```ts
interface TradeTimingEntryHorizon {
    bars: number;
    score: number | null;
    avgMfePct: number | null;
    avgMaePct: number | null;
    positiveForwardRatePct: number | null;
    movementFloorPct: number | null;
    movementConfidencePct: number | null;
    sampleSize: number;
}

interface TradeTimingExitHorizon {
    bars: number;
    score: number | null;
    avgAvoidedAdversePct: number | null;
    avgMissedContinuationPct: number | null;
    adverseAfterExitRatePct: number | null;
    movementFloorPct: number | null;
    movementConfidencePct: number | null;
    sampleSize: number;
}
```

Keep raw breakdown data under `tradeTimingQuality`.

Do not store this in localStorage.

## Current Files And Seams

Primary seams:

- `lib/types/strategies.ts`
- `lib/backtest-service.ts`
- `lib/backtest-executor.ts`
- `lib/finder/finder-runner.ts`
- `lib/finder/finder-runner-single.ts`
- `lib/finder/finder-runner-genetic.ts`
- `lib/finder/finder-runner-shared.ts`
- `lib/finder/finder-runner-core.ts`
- `lib/finder/finder-runner-multi.ts`
- `lib/finder/finder-runner-polymarket.ts`
- `lib/finder/finder-engine.ts`
- `lib/finder/constants.ts`
- `lib/finder/finder-manager-logic.ts`
- `lib/finder/finder-ui.ts`
- `lib/renderers/resultsRenderer.ts`
- `lib/renderers/results-renderer-dom.ts`
- `html-partials/tab-results.html`

Likely new file:

- `lib/trade-timing-quality.ts`

Likely tests:

- `tests/trade-timing-quality.spec.ts`
- `tests/finder-engine.spec.ts`
- `tests/finder-manager-logic.spec.ts`
- `tests/feature-dom-contracts.spec.ts`

## Phase 1: Core Metric Helper

### Purpose

Create deterministic score computation independent of UI and Finder.

### Changes

1. Add `TradeTimingQuality` types.
2. Add `computeTradeTimingQuality(result, ohlcvData)`.
3. Implement direction-adjusted entry and exit helpers.
4. Use `timeKey` and `getTimeIndex`.
5. Return `null` scores when there are no valid samples.

### Acceptance Criteria

- long and short trades score in the correct direction
- insufficient horizon data returns `null`, not fake zero
- `end_of_data` trades can contribute to entry score but not exit score
- same-bar or zero-MFE trades do not divide by zero
- tiny movement shrinks toward neutral through `movementConfidencePct`
- exit capture and giveback are deterministic for same-bar and one-bar trades

### Validation

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\trade-timing-quality.spec.ts`

## Phase 2: Backtest Result Enrichment

### Purpose

Attach timing scores to every normal backtest result after execution.

### Changes

1. Compute `tradeTimingQuality` after Rust or TypeScript backtest completion.
2. Add it in:
   - `BacktestService.finalizeBacktestResult(...)`
   - shared executor `finalizeResult(...)`
3. Preserve the metric through Polymarket annotation by recomputing or transferring it after annotation.
4. Do not compute scores for synthetic entry-evaluation results with no trades.
5. Do not add timing quality to compact endpoint metrics unless a separate endpoint contract change is requested.

### Acceptance Criteria

- manual backtest result contains `tradeTimingQuality`
- Rust-backed result receives the same JS post-processing
- endpoint/shared executor result receives the field when candle data is available
- compact endpoint responses remain unchanged
- no strategy behavior changes

### Validation

- `npm run typecheck`
- `npm run test -- backtest`

## Phase 3: Results Tab Presentation

### Purpose

Show verbose score diagnostics where detailed inspection belongs.

### Changes

1. Add a `Trade Timing Quality` section to `html-partials/tab-results.html`.
2. Add required structural IDs to `lib/renderers/results-renderer-dom.ts`.
3. Render:
   - `Entry Score`
   - `Exit Score`
   - entry horizon table
   - exit horizon table
   - capture score
   - average giveback
4. Hide the section when both scores are unavailable.
5. Keep rendering presentation-only. Do not compute metrics in the renderer.
6. Leave existing `Edge Analysis` intact. `Trade Timing Quality` is the simple 0-100 headline; `Edge Analysis` remains the optional statistical breakdown.

### Acceptance Criteria

- Results tab shows the two headline scores
- details appear only in Results
- empty or unavailable scores render as `--`
- no layout shift in existing result cards

### Validation

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`

## Phase 4: Finder Sorting And Rows

### Purpose

Let Finder rank candidates by timing quality without exposing raw sub-metrics.

### Changes

1. Add Finder metrics:
   - `entryScore`
   - `exitScore`
2. Add labels:
   - `Entry Score`
   - `Exit Score`
3. Add them to simple and advanced current-chart Finder sort options.
4. Do not add raw horizon metrics to Finder sorting.
5. `getFinderMetricValue(...)` returns:
   - `getFinderSelectionResult(item).tradeTimingQuality?.entryScore ?? 0`
   - `getFinderSelectionResult(item).tradeTimingQuality?.exitScore ?? 0`
6. Compute trade timing quality for raw results and endpoint-adjusted `selectionResult` when sorting requires either score.
7. Disable compact result paths when sorting requires either timing score:
   - `runBacktestCompact`
   - Rust compact Finder batches
   - random funnel quick-score sorting
8. For random mode with timing-score sorting, run direct full candidate evaluation instead of the quick funnel.
9. For multi-timeframe Finder, average available scores across timeframe results and attach the averaged score to the aggregated `selectionResult`.
10. Render only two chips in Finder rows when available:
   - `Entry 82`
   - `Exit 74`
11. Keep Polymarket rank mode priority unchanged when Polymarket scoring is enabled.
12. Keep Symbol Universe ranking unchanged.
13. Do not expose Entry Score or Exit Score in Symbol Universe sort controls.
14. When Polymarket scoring is enabled, disable Entry Score and Exit Score sort options because Polymarket rank mode owns sort priority.
15. When `genetic` mode is selected with Entry Score or Exit Score sorting, fail fast with a clear status message. Do not silently run genetic fitness on profit metrics and label the output timing-ranked.
16. Native Rust Finder candidate extraction must not be used for timing-score sorting unless the returned payload includes full trades. If it does not, use the TypeScript full backtest path for timing-score runs.

### Acceptance Criteria

- sorting by Entry Score ranks higher scores first
- sorting by Exit Score ranks higher scores first
- Finder rows do not show verbose breakdown
- existing Finder sort behavior is unchanged when the new metrics are not selected
- Polymarket Finder still uses Polymarket rank priorities
- timing-score Finder sorting never ranks compact results that lack trades
- endpoint-adjusted Finder rows sort by timing quality after endpoint-bias trades are removed
- genetic mode does not pretend to optimize timing scores
- tiny post-entry or post-exit movement shrinks toward a neutral score instead of producing an extreme score

### Validation

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\trade-timing-quality.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\finder-engine.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\finder-manager-logic.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\finder-cache-decision.spec.ts`

## Phase 5: Final Validation And Documentation

### Purpose

Confirm the feature is stable across the main user surfaces.

### Changes

1. Add concise documentation to `README.md` only if the feature is implemented.
2. Mention the limitation:
   - Exit Score is measured on the strategy's own trades.
   - It is not an isolated exit-rule benchmark.
3. Verify manual backtest and Finder behavior.

### Acceptance Criteria

- Backtest Results shows detailed timing quality
- Finder can sort by Entry Score and Exit Score
- Finder still respects min/max trade filters
- timing-score sorting works in current-chart grid and random modes
- timing-score sorting is blocked in genetic mode
- timing-score sorting is not offered for Polymarket ranking or Symbol Universe ranking
- no unrelated UI or strategy behavior changes

### Validation

- `npm run typecheck`
- `npm run test`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`

## Implementation Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5

Do not start Finder UI work before the core metric helper has unit tests.

## Known Limitation

V1 scores exits only inside the strategy's own trade set. A true exit-only benchmark requires a later mode that holds entries constant and compares multiple exit rules against the same entries.
