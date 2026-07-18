# Spread Quality Report — Implementation Plan

## Overview

A server-side diagnostic that analyzes each synthetic pair's **ratio (spread) series** for statistical tradeability — cointegration, half-life of mean reversion, Hurst exponent, and cross-pair overlap — then ranks pairs by spread quality. Unlike Mine Timing (which tried to predict *direction*) and Portfolio Fit (which allocates off an ungrounded `oosLiftPct`), this report uses proven statistical-arbitrage metrics computed directly from the ratio OHLCV that each pair's backtest already produced.

**Goal:** help the user answer "which of my 276 pairs are genuinely tradeable spreads, and which are redundant?" with measured statistics instead of in-sample P&L.

## Problem Context

Batch runs show 275/276 pairs profitable (99.6%). The edge lives in the strategy + exit overlay, not in pair selection. But not all pairs are equal as *spreads*:

- Some ratios are cointegrated (revert to a stable long-run relationship) → tradeable as stat-arb.
- Some ratios are trending (one leg structurally outgrows the other) → the strategy profits from momentum, not mean reversion, and will break when the trend ends.
- Many pairs share underlying assets → 276 pairs may be only ~40–60 effective independent exposures (CONCENTRATION line shows EffN=112).

The existing Rank Pairs classifier (`lib/rank-pairs/pair-regime-classifier.ts`) computes drift/slope/volatility/path-efficiency/reversal-rate but explicitly does NOT compute cointegration, half-life, or Hurst exponent — the standard stat-arb quality metrics. This report fills that gap.

---

## Affected Modules and Files

### New files

| File | Purpose |
|---|---|
| `lib/spread-quality/spread-quality-engine.ts` | Pure compute leaf: cointegration, half-life, Hurst exponent, cross-pair correlation matrix. Mirrors `lib/rank-pairs/pair-regime-classifier.ts` pattern (pure, scalar-only output, no DOM). |
| `lib/spread-quality/spread-quality-stream-types.ts` | NDJSON stream contract (`SpreadQualityStreamEvent`). |
| `tests/spread-quality-engine.spec.ts` | Focused spec: known-answer tests for ADF/half-life/Hurst on synthetic series. |

### Modified files

| File | Change |
|---|---|
| `lib/batch-backtest/batch-backtest-vite-plugin.ts` | New endpoint `POST /api/batch-backtest/spread-quality` + handler, mirroring Mine Prediction pattern. Read-only on artifacts. |
| `html-partials/tab-batch-backtest.html` | New button "Spread Quality" in analysis group + multi-line report panel. |
| `lib/batch-backtest/batch-backtest-dom.ts` | 2 new ids: `batchBacktestSpreadQualityBtn`, `batchBacktestSpreadQualitySummary`. |
| `lib/batch-backtest/batch-backtest-service.ts` | Wire button → endpoint → renderer. Add to `beginAnalysisBusy`/`finishAnalysisBusy`/`clearMinerResults`/`updateArtifactActionButtons`. |
| `tests/batch-backtest-service-lifecycle.browser.spec.ts` | fakeDom update for 2 new elements. |
| `tests/batch-backtest-server-plugin.spec.ts` | Route authorization tests (405/401 parity). |

### Referenced (not modified)

| File | Why |
|---|---|
| `lib/rank-pairs/pair-regime-classifier.ts` | Pattern template: pure classifier, calendar-anchored, scalar output. |
| `lib/batch-backtest/batch-synthetic-state-miner.ts:25-41` | `BatchSyntheticPairArtifact` — the data source (`.data` = ratio OHLCV, `.result` = BacktestResult). |
| `lib/strategies/lib/price-action-statistics-core.ts` | Existing rolling stats (stddev, z-score, autocorrelation) — reusable primitives. |
| `lib/statistics-utils.ts` | `mean`, `median`, `sampleStdDev`, `percentile` — building blocks. |
| `lib/portfolioLab/portfolio-lab-statistics.ts` | `buildCloseReturnSeries`, `computeCorrelation` — correlation matrix building blocks. |

---

## Architecture and Module Boundaries

### Data flow

```
Batch Run → ArtifactStore (disk) → loadStoredMineArtifact → BatchSyntheticPairArtifact
                                                                ↓
                                                    spread-quality-engine.ts
                                                    (pure compute on .data + .result)
                                                                ↓
                                                    SpreadQualityResult (scalars only)
                                                                ↓
                                                    NDJSON stream → browser panel
```

The engine consumes `BatchSyntheticPairArtifact.data` (ratio OHLCV) and `BatchSyntheticPairArtifact.result` (BacktestResult scalars). It does NOT need the pair's trades, signals, or the underlying leg OHLCV — only the ratio series and the aggregate P&L metrics.

### Server-side constraint

Per `docs/batch-backtest-server-side.md:1-8`, ratio OHLCV arrays must NOT cross the wire to the browser. The engine runs server-side on stored artifacts, computes scalar metrics, and streams only the ranked report. Same pattern as Mine Prediction and Mine A/B Test.

### Engine boundary

`lib/spread-quality/spread-quality-engine.ts` is a **pure leaf** — imports only:
- `lib/types/strategies` (OHLCVData type)
- `lib/statistics-utils.ts` (mean, stdDev, percentile)
- Its own internal statistical functions (ADF, half-life, Hurst — new, self-contained)

No `lightweight-charts`, no DOM, no Vite plugin imports. Safe for the `vite.config.ts` bundle trap.

---

## Implementation Phases

### Phase 1: Statistical core (the engine)

**Objective:** Build the pure statistical functions that compute spread quality metrics from a ratio OHLCV array.

**Scope:** `lib/spread-quality/spread-quality-engine.ts` only. No UI, no endpoint.

**Technical tasks:**

1. **ADF (Augmented Dickey-Fuller) test** on log-ratio series.
   - Tests whether the ratio series is stationary (mean-reverting) or has a unit root (random walk). This is an Engle-Granger two-step test where step 1 (estimating the equilibrium relationship) is already done: the ratio IS the spread at a fixed 1:1 hedge ratio. The ADF regression tests whether deviations from this equilibrium are temporary (stationary) or permanent (unit root).
   - Implementation: OLS regression of Δy_t on y_{t-1}, optionally with lagged differences and constant. Compare t-stat to critical values.
   - Critical values: use the standard MacKinnon (1994) asymptotic critical values for the constant-only case (−2.86 at 5%, −3.43 at 1%, −1.95 at 10%). These are approximations sufficient for *ranking* pairs relative to each other; for publication-grade p-values a response-surface lookup table would be needed.
   - Output: `{ adfTStat: number, adfPValue: number, isStationary: boolean }` (stationary if t-stat < −2.86 at 5% level).

2. **Half-life of mean reversion** (Ornstein-Uhlenbeck fit).
   - Regress Δy_t on y_{t-1}: Δy_t = α + β·y_{t-1} + ε_t.
   - Half-life = −ln(2) / ln(1 + β) ≈ −ln(2) / β for small β.
   - Output: `{ halfLife: number }` in bars. Shorter = faster reversion = more trade entries per year.

3. **Hurst exponent** (rescaled-range method).
   - Divide the series into non-overlapping windows of varying sizes.
   - For each window size, compute the mean rescaled range R/S.
   - Regress log(R/S) on log(window size); the slope is the Hurst exponent.
   - Output: `{ hurstExponent: number }`. H < 0.5 = mean-reverting; H ≈ 0.5 = random walk; H > 0.5 = trending.

4. **Cross-pair correlation matrix** on close-to-close ratio returns.
   - Build an N×T return matrix (N pairs × T common-timeline bars) as a single `Float64Array` (row-major). Center each row by subtracting its mean. Then compute the N×N correlation matrix as `C = (R · R') / (T-1)`, dividing element-wise by outer product of row std devs. This is a single matrix multiply — O(N²·T) but with dense array access, not Map lookups.
   - On 600 pairs × 4000 bars: the return matrix is 600×4000 × 8 bytes = ~19 MB. The multiply is 600×600×4000 ≈ 1.4B multiply-adds — ~1-2 seconds in a tight loop. Acceptable for a server-side diagnostic.
   - For larger universes (>1000 pairs), chunk the multiply by computing correlations only between pairs sharing a common asset (the overlap-analysis use case only needs those).
   - Output: `Float64Array` of size N² (row-major), plus a `string[]` index mapping pair symbols to row/column.

5. **Composite quality score (Phase 4, deferred from initial report).**
   - The report must present raw metrics first. A composite score is a *ranking convenience*, not a measurement — and the Mine Timing investigation proved that weighting statistics into a single number can mask what the individual metrics say. The initial report shows all five raw metrics per pair. A composite score is added only after the user has reviewed the raw metrics and confirmed which weighting makes sense for their use case.
   - When added, the composite uses normalized z-scores (not fixed thresholds), computed across the pair universe in the current run — so the score is relative to the other pairs, not absolute.
   - Output (when added): `{ qualityScore: number, components: { stationarity, halfLife, hurst, sharpe, frequency } }`.

6. **Engine entry point.**
   ```ts
   export function computeSpreadQuality(
     ratioData: OHLCVData[],
     result: BacktestResult
   ): SpreadQualityResult
   ```
   And the batch aggregator:
   ```ts
   export function runSpreadQualityReport(
     artifacts: BatchSyntheticPairArtifact[],
     onPairProgress?: (symbol: string, done: number, total: number) => void,
     shouldStop?: () => boolean,
   ): SpreadQualityReportResult
   ```

**Dependencies:** None (pure compute on existing data shapes).

**Risks:**
- ADF critical values are approximate (MacKinnon response surface). For production use, a lookup table is more accurate. The initial implementation uses the standard asymptotic critical values (−2.86 at 5%), which is sufficient for a *ranking* tool (relative comparison between pairs matters more than absolute p-value precision).
- Hurst exponent via R/S is computationally O(n log n) per pair. On 600 pairs × ~4000 bars this is manageable but should be benchmarked.

**Deliverables:**
- `lib/spread-quality/spread-quality-engine.ts` with all 5 metrics + composite score + entry points.
- Types exported for downstream consumption.

**Validation:**
- `tests/spread-quality-engine.spec.ts` with known-answer tests:
  - A stationary AR(1) series → ADF rejects unit root (p < 0.05), half-life matches the generating parameter.
  - A random walk → ADF fails to reject (p > 0.1), Hurst ≈ 0.5.
  - A trending series → Hurst > 0.6.
  - Composite score on a cointegrated pair > score on a random-walk pair.

**Exit criteria:** Engine spec passes. Typecheck clean. Engine produces a ranked report from a fixture of synthetic pair artifacts.

---

### Phase 2: Server endpoint + streaming

**Objective:** Expose the engine as a server-side endpoint that consumes batch artifacts.

**Scope:** `lib/batch-backtest/batch-backtest-vite-plugin.ts` + `lib/spread-quality/spread-quality-stream-types.ts`.

**Technical tasks:**

1. **Stream types** — `SpreadQualityStreamEvent`:
   ```ts
   | { type: "start"; pairs: number }
   | { type: "progress"; symbol: string; donePairs: number; totalPairs: number }
   | { type: "done"; ok: true; result: SpreadQualityReportResult }
   | { type: "done"; ok: false; cancelled: true; summary: string }
   | { type: "fatal"; error: string }
   ```

2. **`processSpreadQuality` function** in the plugin — mirrors `processMinePrediction`:
   - `collectStoredMineArtifactMetas()` → fingerprint gate → load artifacts → run engine → stream progress → emit done.
   - Read-only on artifacts (no `releaseLastResults`).
   - `shouldStop` polls ownership between pairs.

3. **`handleSpreadQualityRequest`** — mirrors `handleMinePredictionRequest`:
   - Ownership gate (409), artifact gate (400), disconnect-safe stream.

4. **Route registration** — `POST /api/batch-backtest/spread-quality` with POST + `isAllowedLocalRequest` gates (audit F1 parity).

5. **Add `processSpreadQuality` to `__testInternals`** for direct test invocation.

**Dependencies:** Phase 1 engine complete.

**Risks:**
- Cross-pair correlation matrix is O(N²) in pair count. On 600 pairs that's 360K correlations, each on ~4000 bars. Must use `mapWithConcurrencyLimit` or chunk. Alternatively, compute the matrix lazily and stream per-pair correlations only to the top-K neighbors.

**Deliverables:**
- Endpoint registered and functional.
- Stream types exported.

**Validation:**
- `tests/batch-backtest-server-plugin.spec.ts`: route rejects non-POST (405), rejects non-local (401), returns populated report when artifacts exist, does NOT release artifacts.
- `npm run typecheck` clean.

**Exit criteria:** Endpoint spec passes. A test with stored artifacts produces a streamed report with per-pair progress.

---

### Phase 3: UI integration

**Objective:** Add the "Spread Quality" button and report panel to the Batch tab.

**Scope:** HTML partial, DOM contract, service wiring, lifecycle fakeDom, CSS.

**Technical tasks:**

1. **HTML** — in `batch-action-group--analysis`:
   ```html
   <button id="batchBacktestSpreadQualityBtn" type="button" disabled
       title="Analyze each pair's ratio series for cointegration, half-life, Hurst exponent, and cross-pair overlap">
       Spread Quality
   </button>
   ```
   In `.batch-run-state`:
   ```html
   <div class="batch-miner-status batch-miner-status--multiline"
        id="batchBacktestSpreadQualitySummary"></div>
   ```

2. **DOM contract** — register `batchBacktestSpreadQualityBtn` + `batchBacktestSpreadQualitySummary` in `BATCH_BACKTEST_REQUIRED_IDS` and `createBatchBacktestDom()`.

3. **Service wiring** — mirror Mine Prediction:
   - `runSpreadQuality()` → guard `analysisInFlight` → `beginAnalysisBusy` → POST `/api/batch-backtest/spread-quality` → consume NDJSON → render → `finishAnalysisBusy`.
   - Add to `beginAnalysisBusy`, `finishAnalysisBusy`, `clearMinerResults`, `updateArtifactActionButtons`.
   - Add all re-enable sites (grep for `batchBacktestMinePredictionBtn` and add `batchBacktestSpreadQualityBtn` alongside).

4. **Lifecycle fakeDom** — add 2 new mock elements.

5. **Copy button** (optional, defer if low priority) — `Copy Spread Quality` in exports group.

**Dependencies:** Phase 2 endpoint complete.

**Risks:**
- The re-enable-site bug from Mine Prediction iteration. Mitigate by grepping ALL `batchBacktestMinePredictionBtn.disabled` sites first and adding the new button at each in one pass.

**Deliverables:**
- Button + panel functional in the UI.
- All re-enable sites covered.

**Validation:**
- `tests/feature-dom-contracts.spec.ts` passes with 2 new ids.
- `tests/batch-backtest-service-lifecycle.browser.spec.ts` passes with updated fakeDom.
- `npm run test -- --runInBand` full suite passes.

**Exit criteria:** Manual smoke: run a batch → click Spread Quality → report renders → Copy works.

---

### Phase 4: Report format and report polishing

**Objective:** Define the pipe-delimited report format with raw metrics as primary output, composite score as optional convenience.

**Scope:** Engine report builder + Copy button wiring.

**Report format (raw metrics primary):**
```
SPREAD_QUALITY | strategy=<key> interval=<int> pairs=<P> assets=<A>
SPREAD_QUALITY | NOTE: metrics from the ratio series. Stationary (ADF p<0.05) + fast-reverting (hl<50) + mean-reverting (H<0.5) = best.
METRICS   | #1 ORCL+NFLX: adf_p=0.02(stat) hl=18.2b hurst=0.31(MR) sharpe=1.2 trades=45
          | #2 ANET+NFLX: adf_p=0.06(bord) hl=22.5b hurst=0.35(MR) sharpe=0.9 trades=38
          | ...
          | #N-1 BTC+XRP: adf_p=0.42(rw) hl=inf hurst=0.71(trend) sharpe=0.1 trades=3
OVERLAP   | Highest-correlation pairs: ORCL+NFLX ↔ ANET+NFLX = 0.82 | AVGO+JPM ↔ AVGO+WFC = 0.71
EXPOSURE  | NFLX in 12 pairs (8 stat) | ORCL in 8 pairs (5 stat) | ANET in 6 pairs (4 stat)
SUMMARY   | <N> stationary (p<0.05) | <M> mean-reverting (H<0.5) | <K> trending (H>0.6) | median hl = <X>b
VERDICT   | <N> pairs tradeable (stationary + MR + hl<50) | <M> marginal | <K> avoid
```

Labels in parentheses: `(stat)` = stationary, `(bord)` = borderline, `(rw)` = random walk, `(MR)` = mean-reverting, `(trend)` = trending.

**Technical tasks:**

1. Build the ranked report lines in `runSpreadQualityReport` sorted by ADF p-value ascending (most stationary first), with all raw metrics visible.
2. Compute asset-exposure overlap: for each underlying asset, count how many pairs contain it and how many of those are stationary.
3. Compute top-K highest cross-pair correlations from the correlation matrix (most redundant pairs).
4. Add `Copy Spread Quality` button if not done in Phase 3.
5. The composite score (if added per Phase 1 task 5) appears as a trailing column, not the primary sort key.

**Dependencies:** Phases 1-3 complete.

**Validation:** Report renders legibly in the multi-line panel. Copy produces pipe-delimited text. Raw metrics are the primary sort; composite score is supplementary.

**Exit criteria:** Report is readable, copyable, and answers "which pairs have the best spread properties?"

---

## APIs and Contracts

### New endpoint

```
POST /api/batch-backtest/spread-quality
Body: { fingerprint: string, interval: string }
Response: NDJSON stream (SpreadQualityStreamEvent)
```

- **POST gate** (405 on non-POST)
- **isAllowedLocalRequest gate** (401 on non-local, audit F1 parity)
- **Artifact gate** (400 when no artifacts stored)
- **Read-only** on artifacts (no `releaseLastResults`)
- **Disconnect-safe** via `createDisconnectSafeStream`

### Stream contract

`SpreadQualityStreamEvent` — `start` → `progress`* → `done`/`fatal`. No per-bar streaming (spread quality computation is fast per pair — only the correlation matrix is O(N²)).

---

## Performance

- Per-pair metrics (ADF, half-life, Hurst): O(n) to O(n log n) per pair on the ratio series. On 600 pairs × ~4000 bars, total is ~seconds.
- Cross-pair correlation matrix: O(N²·T) via dense matrix multiply (see Phase 1 task 4). On 600 pairs × 4000 bars: ~19 MB return matrix, ~1-2 seconds compute. For >1000 pairs, switch to asset-shared-pair-only mode (compute correlations only between pairs that share a common leg, which is the only overlap the user cares about).
- Memory: each pair's ratio OHLCV is ~5-10 MB (at 100k-bar cap). The engine processes one pair at a time and releases the array before moving to the next. The correlation matrix requires all N return series in memory simultaneously (~19 MB for 600 pairs), which is bounded.

---

## Failure Handling and Edge Cases

| Case | Handling |
|---|---|
| Pair has < 50 bars | Skip, report as "insufficient data" |
| ADF regression singular (zero variance) | Report `adfTStat = NaN`, exclude from stationarity scoring |
| Half-life negative (β > 0, series is trending) | Report `halfLife = Infinity`, score = 0 for that component |
| Hurst undefined (all windows same R/S) | Report `hurst = 0.5` (random walk fallback) |
| Correlation undefined (zero variance in returns) | Report `correlation = NaN` |
| Pair has no trades (result.totalTrades = 0) | Include in report but frequency component = 0 |
| Server OOM on 1000+ pairs | Engine processes sequentially, one pair at a time. Peak memory bounded by 1 pair's OHLCV + the accumulated scalar results |

---

## Rollback Strategy

- All new code is in new files (`lib/spread-quality/`) + new endpoint + new UI elements. Removing the button, endpoint, and files reverts cleanly with no impact on existing features.
- No changes to `BatchSyntheticPairArtifact`, `BatchBacktestRunInput`, or the batch runner. The report is a pure consumer of existing artifact data.
- No migrations, no settings changes, no localStorage changes.

---

## Assumptions and Unknowns

1. **MacKinnon critical values:** The initial ADF implementation uses asymptotic critical values (−2.86 at 5%, −3.43 at 1%). For a *ranking* tool this is sufficient. For p-value precision, a response-surface lookup table would be needed. Defer if the ranking use case is the only one.

2. **Hurst method:** R/S (rescaled range) is the simplest Hurst estimator. DFA (detrended fluctuation analysis) is more robust but more complex. Start with R/S; upgrade to DFA if the R/S results are unstable across window sizes.

3. **Composite score weights:** Deferred to Phase 4. The initial report sorts by raw ADF p-value (most stationary first). A composite score using cross-run z-score normalization is added only after the user reviews the raw metrics.

4. **Cross-pair correlation scope:** The full N×N matrix may be too large to display. The report should show only the top-K highest-correlation pairs (most redundant) and the asset-exposure overlap summary.

5. **Leg OHLCV not on artifact:** The engine only has the ratio OHLCV (`artifact.data`), not the individual leg series. This is sufficient for all planned metrics (cointegration/half-life/Hurst operate on the ratio). If leg-level analysis is needed later, the legs can be loaded via `loadMinerTargets` (same as Mine Prediction).

---

## Validation Summary

| Check | Command |
|---|---|
| Typecheck | `npm run typecheck` |
| Typecheck tests | `npm run typecheck:tests` |
| Engine spec | `..\..\..\node_modules\.bin\esno tests\spread-quality-engine.spec.ts` |
| Feature-dom contracts | `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts` |
| Server-plugin spec | `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts` |
| Lifecycle spec | `..\..\..\node_modules\.bin\esno tests\batch-backtest-service-lifecycle.browser.spec.ts` |
| Full suite | `npm run test -- --runInBand` |
| Manual smoke | Run batch → click Spread Quality → report renders → Copy works → click Mine Timing after (confirms no-release contract) |
