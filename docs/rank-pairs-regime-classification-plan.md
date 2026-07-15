# Rank Pairs Regime Classification Plan

## Objective

Replace Rank Pairs' first-to-last return verdict with a calendar-aware
classification of synthetic-pair direction and structure.

The classifier describes the ratio path only. It does not select strategies,
predict trades, or modify Finder, Batch Backtest, Stability Mine, or saved Batch
templates.

## Current system

```text
html-partials/tab-rank-pairs.html
  -> lib/rank-pairs/rank-pairs-dom.ts
  -> lib/rank-pairs/rank-pairs-service.ts
  -> lib/batch-backtest/batch-backtest-loader.ts
  -> lib/rank-pairs/relative-strength-score.ts
```

- Rank Pairs is a browser-only lazy feature registered in
  `lib/app-bootstrap.ts`.
- `rank-pairs-service.ts` reads `state.currentInterval`, parses the submitted
  symbols, and loads each dataset through `loadBatchDataset(...)`.
- The Batch loader is the source of truth for synthetic-pair construction,
  aligned candles, interval aggregation, and caches.
- `relative-strength-score.ts` classifies from first close, last close, interval,
  and bar count. `FLAT` means only that the directional thresholds did not pass;
  it does not establish chop.
- Annualization assumes continuous-market bars per year, which is incorrect for
  stock sessions.
- Full-window classification has lookahead when the resulting list is used to
  evaluate strategies over the same period.
- No focused Rank Pairs scorer test exists.

## Scope

### Included

- A pure, deterministic pair-regime classifier.
- Fixed 30-calendar-day observations from existing OHLCV candles.
- Separate direction and structure labels.
- Updated Rank Pairs rows, summary, clipboard output, hints, and tests.
- Crypto and IBKR stock-ratio validation.

### Excluded

- Synthetic candle or Batch loader changes.
- Finder, Batch, Stability, strategy, or backtest changes.
- Automatic updates to `batch-symbol-templates.ts`.
- New server routes, databases, workers, persistence, or infrastructure.
- Claims that a classified regime will persist.

## Module boundaries

### `lib/rank-pairs/pair-regime-classifier.ts`

Replace `relative-strength-score.ts` with one pure module that owns:

- candle-time normalization;
- fixed-calendar observation extraction;
- metric calculation;
- direction and structure classification;
- deterministic comparison and formatting helpers that do not require DOM
  state.

The current scorer has one production caller, so no compatibility wrapper is
required. Remove it when the service switches to the new module.

### `lib/rank-pairs/rank-pairs-service.ts`

Retain responsibility for:

- reading symbols and the current interval once per run;
- sequential loading through `loadBatchDataset(...)`;
- cancellation, progress, per-pair failure isolation, sorting, rendering, and
  clipboard output;
- aggregated completion logging.

Metric and classification logic must not be duplicated in the service.

### UI contract

`html-partials/tab-rank-pairs.html` remains the markup source and
`rank-pairs-dom.ts` remains the structural DOM contract. No new input or
persisted setting is required.

## Data flow

1. Parse and deduplicate pairs with the existing Batch parser.
2. Capture `state.currentInterval` once.
3. Load each pair through the existing Batch dataset loader.
4. Convert valid positive-close candle times with `timeToNumber(...)`.
5. Sort by time and apply deterministic last-write-wins deduplication.
6. Anchor the latest close, then select the latest candle at or before each
   preceding 30-calendar-day anchor.
7. Build 37 observations spanning up to 36 intervals; require at least 33 valid
   anchors and at least 960 elapsed calendar days.
8. Calculate scalar metrics, classify, and release the candle array.
9. Sort and render scalar results; Copy Results uses the same result objects.

No OHLCV arrays cross a network boundary or remain in Rank Pairs results.

## Classification contract

### Time basis

- Full window: the latest observation plus 36 anchors spaced 30 calendar days
  apart, spanning approximately three years.
- For each anchor, select the latest candle at or before it. Reject an anchor
  when that candle is more than seven calendar days old.
- Minimum coverage: 33 valid anchors and at least 960 elapsed calendar days.
- Recent window: the latest seven consecutive valid anchors, producing six
  returns. Missing recent anchors disable transition/reversal classification.
- Output includes the latest candle's `asOf` timestamp.

Anchoring from the latest candle avoids a partial-calendar-month return while
making `30m`, `4h`, and `1d` results comparable across continuous and stock
sessions.

### Metrics

Calculate from anchored log closes:

- simple ratio return;
- log return;
- elapsed calendar days;
- annualized OLS log-price slope;
- annualized realized volatility;
- normalized drift: annualized log slope divided by annualized volatility;
- path efficiency:
  `abs(lastLog - firstLog) / sum(abs(periodicLogChange))`;
- 30-day reversal rate: sign changes between consecutive nonzero periodic
  returns divided by eligible return transitions;
- recent six-period normalized drift and path efficiency;
- endpoint-band status using the reciprocal bounds `[1 / 1.30, 1.30]`.

Undefined values remain `null`; they are never converted to zero.

### Labels

Direction and structure are independent:

- Direction: `BASE`, `NEUTRAL`, `QUOTE`, `THIN`.
- Structure: `TREND`, `OSCILLATING`, `TRANSITION`, `REVERSAL`, `MIXED`, `THIN`.

The displayed label combines them, for example `BASE / TREND` or
`NEUTRAL / OSCILLATING`. Annualized volatility remains a numeric field; there
is no universe-relative volatility label whose meaning changes with the input
list.

### Initial rules

Classification precedence:

1. `THIN`: anchor coverage or required-metric checks fail.
2. `REVERSAL`: full absolute normalized drift is at least `0.50`; recent drift
   is at least `0.75` in the opposite direction; recent efficiency is at least
   `0.40`.
3. `TRANSITION`: full structure is not trending; recent absolute normalized
   drift is at least `0.75`; recent efficiency is at least `0.40`.
4. `TREND`: full absolute normalized drift is at least `0.50` and full
   efficiency is at least `0.25`.
5. `OSCILLATING`: endpoint is inside the reciprocal 30% band, full efficiency is
   at most `0.20`, and 30-day reversal rate is at least `0.50`.
6. `MIXED`: valid history that meets none of the preceding definitions.

Direction is `BASE` at normalized drift `>= +0.50`, `QUOTE` at `<= -0.50`, and
`NEUTRAL` otherwise. For `TRANSITION` and `REVERSAL`, displayed direction uses
the recent drift because the label describes the current regime.

Thresholds must be named constants in the pure classifier. Changing a threshold
is a behavior change requiring fixture and boundary-test updates.

### Sorting

Group results in this fixed order:

1. `TRANSITION`
2. `REVERSAL`
3. `TREND`
4. `OSCILLATING`
5. `MIXED`
6. `THIN`
7. failed/no-data rows

Within transition, reversal, and trend, sort by absolute current normalized
drift descending. Within oscillating, sort by reversal rate descending and then
efficiency ascending. Symbol is the final tie-breaker. This is display ordering,
not a trade-quality score.

## Assumptions and unknowns

### Assumptions

- `BASE+QUOTE` means base close divided by quote close.
- Thirty-calendar-day observations are the intended multiyear classification
  scale; shorter behavior remains visible on the chart but does not determine
  the regime label.
- Approximately three years balances multiyear evidence with current relevance.
- Raw volatility is more stable than a percentile label derived from the
  submitted universe.
- Current cancellation and per-pair failure behavior remains unchanged.

### Unknowns

- The initial thresholds require calibration against user-labeled real charts.
- Assets failing the 33-anchor/960-day requirement remain `THIN`; no shorter-term
  fallback is planned.
- The latest candle anchors the window, so labels can change between runs. The
  exact source time must be shown through `asOf`.
- No repository consumer of the current clipboard header was found. The changed
  header is still versioned to avoid silent contract reuse.

## Phase 1: Pure metrics and fixtures

### Objective

Build a calendar-aware scalar metric engine with deterministic test fixtures.

### Scope

Pure code and focused tests; no UI behavior change.

### Technical tasks

- Add `tests/rank-pairs-regime-classifier.spec.ts`.
- Create generated fixtures for smooth trends, oscillation, quiet constant data,
  a large round trip, a recent breakout, a recent reversal, irregular stock
  sessions, invalid data, and insufficient history.
- Add reciprocal-pair fixtures: inversion must flip directional metrics while
  preserving efficiency, reversal rate, volatility, and structure.
- Implement `pair-regime-classifier.ts` types and anchored observation
  extraction.
- Reuse `timeToNumber(...)`; do not create another time parser.
- Implement metrics with bounded passes and explicit null/reason behavior.
- Return reason codes including `INSUFFICIENT_ANCHORS`, `INVALID_TIME`,
  `NO_VALID_CLOSES`, and `ZERO_VARIANCE`.

### Dependencies

- Existing `OHLCVData` and `timeToNumber(...)` contracts.
- Existing test runner.

### Risks/blockers

- Long gaps or suspensions can leave an anchor without a candle inside the
  seven-day tolerance; do not fill that anchor.
- Very small positive ratios can expose floating-point issues before log
  conversion.
- Generated fixtures do not settle thresholds for real market charts.

### Deliverables

- Pure metric module and typed result contract.
- Focused tests for anchor extraction, actual calendar duration, reciprocal
  behavior, null handling, and all raw metrics.

### Validation/testing criteria

- Equivalent crypto and stock anchored paths produce equivalent metrics despite
  different intra-period bar counts.
- Reciprocal fixtures preserve structure within numerical tolerance and reverse
  direction.
- The module contains no DOM, fetch, shared state, provider, or `Date.now()`
  dependency.
- A 50,000-bar fixture completes in linear time without retaining duplicate
  candle arrays.

### Exit criteria

- Every metric has a defined unit and null condition.
- Metric tests and typechecks pass.
- No production caller has switched yet.

## Phase 2: Classification policy

### Objective

Implement explainable direction and structure labels from the anchored metrics.

### Scope

Pure classification, reasons, boundary behavior, and deterministic sorting.

### Technical tasks

- Centralize the initial thresholds as named constants.
- Implement classification precedence exactly once.
- Implement recent-direction handling for transition/reversal labels.
- Implement reciprocal endpoint-band calculation.
- Implement the fixed group and within-group comparators.
- Add tests for every label, exact threshold boundary, precedence conflict,
  missing recent data, zero variance, and reciprocal inversion.
- Calibrate against a small documented set of known pair charts without
  embedding large or private market datasets in tests.

### Dependencies

- Phase 1 metrics and fixtures.
- User-agreed labels for representative real charts.

### Risks/blockers

- Threshold tuning can overfit a small labeled sample.
- A violent round trip and recurrent oscillation can share low efficiency; the
  reversal-rate and endpoint-band conditions must distinguish them.
- Recent reversal and transition conditions overlap; precedence must remain
  explicit.

### Deliverables

- Classification and sorting functions.
- Boundary and label tests.
- Recorded calibration examples with interval, date range, expected label, and
  observed result.

### Validation/testing criteria

- Ending inside the 30% band alone never produces `OSCILLATING`.
- Smooth base/quote reciprocal trends receive opposite directions and the same
  structure.
- Constant and invalid series never receive a directional or oscillating label.
- Threshold changes cause focused boundary tests to fail.

### Exit criteria

- Generated fixtures classify as specified.
- Real calibration disagreements are resolved by a documented rule or remain
  `MIXED`; thresholds are not blended silently.
- Pure-module tests and typechecks pass.

## Phase 3: Rank Pairs integration

### Objective

Expose the classifier through the current Rank Pairs workflow without changing
the loader or other research features.

### Scope

Rank Pairs service, markup text, rendering, summary, copy contract, and logging.

### Technical tasks

- Replace `scoreRelativeStrength(...)` in `rank-pairs-service.ts` with the new
  pure classifier.
- Preserve sequential loading, AbortController behavior, run-token stale-write
  protection, progress, cache use, and pair-level failure isolation.
- Retain only scalar classification results after each pair is processed.
- Render combined label plus concise evidence: annualized slope, volatility,
  efficiency, reversal rate, recent direction, anchor count, and `asOf`.
- Replace the current summary with direction/structure/thin/failed counts.
- Version clipboard output with `RANK_PAIRS_V2` and include all scalar metrics,
  labels, and reason codes.
- Update UI hints to define 30-calendar-day classification and retain the lookahead
  warning.
- Emit one `rank_pairs.run_complete` debug event with interval, counts by label,
  failures, cancellation state, and elapsed milliseconds. Do not log candles or
  one event per valid pair.
- Remove `relative-strength-score.ts` and obsolete imports.

### Dependencies

- Phases 1 and 2.
- Existing Rank Pairs service and shared Batch loader.

### Risks/blockers

- Displaying every metric will make rows unreadable; complete evidence belongs
  in Copy Results.
- External clipboard parsers, if any, must opt into the explicit V2 header.
- A new latest candle moves every anchor and can change the current label.

### Deliverables

- Updated Rank Pairs service, rows, summary, copy output, hints, and diagnostics.
- Removal of the obsolete scorer.

### Validation/testing criteria

- Stop and immediate rerun cannot produce stale DOM writes.
- One failed pair does not prevent remaining classifications.
- Rendered and copied labels come from the same result object.
- No changes occur in Finder, Batch, Stability, strategies, settings,
  persistence, server routes, or data-loader behavior.
- `tests/feature-dom-contracts.spec.ts` remains green; no new structural id is
  expected.

### Exit criteria

- Crypto and stock synthetic pairs complete through the existing loader.
- Summary, rendered rows, and copied evidence agree.
- The V1 `FLAT` fallback no longer exists in production Rank Pairs output.

## Phase 4: Validation and documentation

### Objective

Verify correctness, runtime cost, research limitations, and rollback safety.

### Scope

Automated checks, manual smoke runs, documentation, and final diff review.

### Technical tasks

- Document label definitions, anchored sampling, ratio direction, thresholds,
  recent-window behavior, and clipboard fields.
- State that classifying and evaluating strategies on the same historical period
  is lookahead-biased.
- Document that V1 `STRONG/SOLID/FLAT/WEAK` labels are not equivalent to V2
  regimes.
- Profile warm-cache 100-, 400-, and 1,000-pair runs; separate loader time from
  classifier time.
- Confirm candle arrays are not retained in result state.
- Review the diff for unrelated changes.

### Dependencies

- Phase 3 integration.
- Local crypto and IBKR data for manual smoke tests.

### Risks/blockers

- Cold data loading can hide classifier cost; record cold and warm observations
  separately.
- Provider history differences can produce `THIN` on one market and a valid
  label on another.
- Existing lists remain lookahead-selected until rebuilt at an earlier cutoff or
  evaluated on later untouched data.

### Deliverables

- Updated Rank Pairs documentation.
- Automated and manual validation record.
- Runtime baseline and known limitations.

### Validation/testing criteria

Run:

```text
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno tests\rank-pairs-regime-classifier.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
npm test
npm run build:check
```

Manual matrix:

- crypto ratios at `30m`, `4h`, and `1d`;
- IBKR stock ratios at `4h` and `1d`;
- a pair and its reciprocal in the same run;
- known trend, oscillation, round trip, transition, and reversal examples;
- Stop, immediate rerun, one missing pair, and Copy Results.

No skipped check may be reported as passing.

### Exit criteria

- Automated checks and the manual matrix pass, or failures remain explicit
  blockers.
- Classifier CPU and memory are not the dominant phase of a warm 1,000-pair run.
- Documentation exposes lookahead and non-stationarity limitations.
- Only Rank Pairs, its tests, and its documentation changed.

## Edge cases and failure handling

- Invalid/non-positive closes: discard; return `THIN` if anchored history becomes
  insufficient.
- Invalid time: normalize with `timeToNumber(...)`; return `INVALID_TIME` when a
  usable anchored series cannot be formed.
- Duplicate timestamps: deterministic last-write-wins.
- Missing anchors: do not fill; fail the coverage requirement when needed.
- Constant ratio: return `THIN` with `ZERO_VARIANCE`, never `OSCILLATING`.
- Missing seven-anchor recent window: allow full-history `TREND`, `OSCILLATING`, or
  `MIXED`; disallow `TRANSITION` and `REVERSAL`.
- Reciprocal pair: direction flips; structure and scale-free path metrics remain
  equal within tolerance.
- Pair load failure: preserve the failure row and continue.
- Cancellation/new run: preserve the existing AbortController and run-token
  behavior.

## Performance constraints

- O(total loaded bars) calculation and O(anchors) retained data per pair.
- No rolling sorts, O(n squared) estimators, or duplicate OHLCV retention.
- Reuse existing Batch loader caches without changing their limits.
- Keep only scalar results after each pair is classified.

## Rollback

- No data, schema, API, or persisted-setting migration exists.
- Commit in green units: pure engine and tests; classification and tests; UI and
  documentation.
- Revert the Rank Pairs integration and pure-classifier commits together to
  restore the V1 scorer and clipboard output.
- Do not retain selectable V1/V2 production modes.
