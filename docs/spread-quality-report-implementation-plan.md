# Exposure & Redundancy Report + Fixed-Ratio Diagnostics — Implementation Plan

## Overview

A server-side diagnostic that helps the user understand the concentration and overlap structure of a batch run. Two deliverables:

1. **Exposure & Redundancy Report** (Phase 1-3, defensible now): asset incidence counts, shared-leg clusters, and realized strategy-equity-return correlations between pairs. Descriptive only — no quality labels.
2. **Fixed-Ratio Diagnostics** (Phase 0 mandatory, then Phase 4 if validated): ADF stationarity and half-life on the ratio series. Built as a CLI walk-forward validation FIRST. Only promoted to UI if the metrics demonstrate consistent OOS predictive value.

### What this plan is NOT

- Not a "pair quality score" or "tradeable / avoid" classifier. The Mine Timing investigation proved that theoretically-plausible metrics can have zero OOS value and that labeling pairs as "good/bad" without validated thresholds is misleading.
- Not a cointegration test between the two legs. The artifact only carries the ratio OHLCV (base/quote at fixed 1:1 hedge), not the individual leg series. Testing this ratio for stationarity is a unit-root test of a pre-specified spread, not an Engle-Granger estimate of the cointegrating vector.

---

## Phase 0: Walk-forward validation (CLI only, mandatory before any UI for diagnostics)

**Objective:** Determine whether fixed-ratio stationarity metrics (ADF, half-life) predict OOS strategy performance. If they don't, the diagnostic metrics are not built into the UI.

**Scope:** `scripts/validate-spread-quality.ts` — a standalone CLI script. No production endpoint, no UI.

**Technical tasks:**

1. **Calendar walk-forward folds.** Split each pair's ratio history into consecutive windows (e.g., 6-month train / 3-month test, repeated). Compute ADF and half-life on each train window only.

2. **OOS measurement.** For each test window, measure: net P&L per unit capital, Sharpe, max drawdown, profit factor. Use the pair's existing BacktestResult trades, sliced by test-window timestamps.

3. **Predictive correlation.** For each metric × each OOS outcome:
   - Spearman rank correlation between train-window metric and test-window outcome across all pairs.
   - Top-minus-bottom quantile spread: average OOS P&L of top-quartile pairs (by train metric) vs bottom-quartile.

4. **Portfolio A/B.** Equal-gross-capital portfolio of "selected" pairs (top quartile by train metric) vs all pairs. Compare OOS portfolio Sharpe, drawdown, and net P&L.

5. **Simpler-selector comparison.** Compare against just using train-period Sharpe or net P&L as the selector. If a simple selector does as well or better, the spread metrics add no incremental value.

6. **Strategy-specific evaluation.** Run separately for each strategy type (mean-reversion vs momentum). Do NOT pool strategies — a metric that predicts for mean-reversion may anti-predict for momentum.

7. **Regime stability.** Repeat across different market regimes. A metric that works in bull markets but fails in bear markets is not reliable.

**Pass criterion (predefined before running):**
- Consistent direction of Spearman correlation across ≥60% of folds.
- Top-minus-bottom quantile spread is positive in ≥60% of folds.
- Portfolio A/B: selected portfolio Sharpe ≥ all-pairs portfolio Sharpe in ≥60% of folds.
- Does not worsen max drawdown materially (≤20% increase).

**If Phase 0 fails:** Document the negative finding. Keep the CLI script for future research. Do NOT build the diagnostic metrics into the UI. Build only the Exposure & Redundancy Report (Phase 1-3).

**If Phase 0 passes:** Proceed to Phase 4 (Fixed-Ratio Diagnostics in the UI, using the validated metrics and thresholds).

**Dependencies:** None (CLI script reads existing batch artifacts from disk).

**Deliverables:** `scripts/validate-spread-quality.ts` + a findings section in this document.

**Validation:** Script runs on a real batch. Results documented.

**Exit criteria:** Go/no-go decision documented with evidence.

---

## Phase 1: Exposure & Redundancy engine (defensible now)

**Objective:** Build the pure compute module that analyzes asset concentration, shared-leg clusters, and cross-pair correlations from batch artifacts.

**Scope:** `lib/spread-quality/spread-quality-engine.ts` — pure leaf, no DOM, no lightweight-charts.

**Technical tasks:**

### 1.1 Asset incidence analysis

For each underlying asset, count:
- Total pair appearances (how many pairs contain this asset as base or quote)
- Gross concentration: appearances / total pair slots (2 × pair count)
- Connected clusters: group pairs by shared assets (two pairs are connected if they share at least one leg). Report the size of each cluster.

This uses only artifact metadata (`baseAsset`, `quoteAsset` from `BatchSyntheticPairArtifact`). No OHLCV needed.

Output: `AssetIncidenceResult` — per-asset counts + cluster groupings.

### 1.2 Realized strategy-equity-return correlation

For each pair of pairs, compute Pearson correlation of their **strategy equity returns** (not ratio returns). Equity returns come from the per-pair `BacktestResult.equityCurve` — but the batch runner sets `omitEquityCurve: true`, so equity curves are NOT on the artifact.

**Alternative:** compute correlation from per-pair `result.trades` pnl time series. Each trade's `pnl` at its `exitTime` is a cash-flow event. Align two pairs' cash-flow series by `timeKey(exitTime)` and compute correlation on the overlapping timestamps.

This requires `result.trades` from the artifact — which IS available server-side on `BatchSyntheticPairArtifact.result.trades`.

Output: top-K highest-correlation pair pairs (most redundant), plus per-asset average correlation (how correlated are the pairs containing this asset?).

**Implementation note:** trades are sparse (a pair may have 20-80 trades over thousands of bars). Aligning two sparse trade-pnl series by exit time is a join, not a matrix multiply. The cost is O(N² × avg_trades_per_pair) — manageable.

### 1.3 Ratio-return correlation (secondary view)

For each pair, compute close-to-close ratio returns from `artifact.data` (the ratio OHLCV). Build a dense N×T return matrix aligned on the common timeline. Compute the N×N correlation matrix via single matrix multiply.

**Memory constraint:** load artifacts one at a time. Extract the ratio return series (a Float64Array per pair), store it in a compact array, then release the artifact reference before loading the next. Peak memory = 1 artifact + N return series (N × T × 8 bytes ≈ 19 MB for 600 pairs × 4000 bars).

**Pair alignment:** pairs may have different timelines (different start dates, dropped bars). Align on the intersection of all timestamps. Require a minimum overlap count (e.g., 100 bars) — pairs with insufficient overlap are excluded from correlation.

Output: top-K highest ratio-return-correlation pair pairs.

### 1.4 Engine entry point

```ts
export interface ExposureRedundancyResult {
  assetIncidence: Map<string, { totalPairs: number; pairs: string[] }>;
  clusters: Array<{ assets: string[]; pairs: string[] }>;
  topEquityCorrelations: Array<{ pairA: string; pairB: string; correlation: number }>;
  topRatioCorrelations: Array<{ pairA: string; pairB: string; correlation: number }>;
  reportLines: string[];
}

export async function runExposureRedundancyReport(
  artifactLoader: () => AsyncIterable<BatchSyntheticPairArtifact>,
  onPairProgress?: (symbol: string, done: number, total: number) => void,
  shouldStop?: () => boolean,
): Promise<ExposureRedundancyResult>
```

**Critical: artifact loading.** The engine accepts an async iterator/loader callback, NOT a `BatchSyntheticPairArtifact[]` array. This prevents loading all artifacts simultaneously. The plugin's caller iterates metadata, loads one artifact at a time via `loadStoredMineArtifact`, passes it to the engine, and the engine extracts what it needs (metadata for incidence, trades for equity correlation, ratio closes for ratio correlation) before the caller loads the next.

**Dependencies:** None (pure compute).

**Risks:**
- Trade-pnl alignment may produce low overlap for pairs with very different trading frequencies. Report overlap count alongside each correlation.
- Ratio-return alignment requires intersecting timelines. For 600 pairs, this intersection may be small if pairs started at different times. Report the overlap bar count.

**Deliverables:** `lib/spread-quality/spread-quality-engine.ts` with incidence + correlation functions + entry point.

**Validation:**
- `tests/spread-quality-engine.spec.ts`:
  - Two pairs sharing an asset → incidence shows shared asset, clusters group them.
  - Two pairs with perfectly correlated trades → correlation = 1.0.
  - Two pairs with no trade-time overlap → correlation = null, overlap = 0.

**Exit criteria:** Engine spec passes. Typecheck clean.

---

## Phase 2: Server endpoint + streaming

**Objective:** Expose the Exposure & Redundancy Report as a server-side endpoint.

**Scope:** `lib/batch-backtest/batch-backtest-vite-plugin.ts` + `lib/spread-quality/spread-quality-stream-types.ts`.

**Technical tasks:**

1. **Stream types:**
   ```ts
   export type ExposureRedundancyStreamEvent =
     | { type: "start"; pairs: number }
     | { type: "progress"; symbol: string; donePairs: number; totalPairs: number }
     | { type: "done"; ok: true; result: ExposureRedundancyResult }
     | { type: "done"; ok: false; cancelled: true; summary: string }
     | { type: "fatal"; error: string };
   ```

2. **`processExposureRedundancy` function** in the plugin:
   - `collectStoredMineArtifactMetas()` → fingerprint gate → iterate metadata one at a time → load artifact via `loadStoredMineArtifact` → pass to engine → release → next.
   - Read-only on artifacts (no `releaseLastResults`).
   - Clear artifact TTL timer at start, reschedule in `finally` (including cancellation and fatal paths).
   - Stream only per-pair scalars + top-K correlations + asset incidence. Do NOT stream the full N×N matrix.

3. **`handleExposureRedundancyRequest`** — ownership gate, artifact gate, disconnect-safe stream.

4. **Route:** `POST /api/batch-backtest/exposure-redundancy` with POST + `isAllowedLocalRequest` gates.

5. **Serialization:** NaN and Infinity serialize as `null` in JSON. Use `number | null` plus explicit status fields for all metrics.

**Dependencies:** Phase 1 complete.

**Deliverables:** Endpoint registered and functional.

**Validation:**
- Route rejects non-POST (405), rejects non-local (401).
- Does NOT release artifacts (`hasStoredMineArtifacts()` stays true).
- `npm run typecheck` clean.

**Exit criteria:** Endpoint spec passes.

---

## Phase 3: UI integration

**Objective:** Add "Exposure & Redundancy" button and report panel to the Batch tab.

**Scope:** HTML partial, DOM contract, service wiring, lifecycle fakeDom.

**Technical tasks:**

1. **HTML** — button in analysis group + multi-line panel in `.batch-run-state`.
2. **DOM contract** — register 2 new ids.
3. **Service wiring** — mirror Mine Prediction pattern: `runExposureRedundancy()` → POST → consume NDJSON → render → `finishAnalysisBusy`.
4. **Add to** `beginAnalysisBusy`, `finishAnalysisBusy`, `clearMinerResults`, `updateArtifactActionButtons`, and ALL re-enable sites (grep for `batchBacktestMineAbBtn` and add alongside).
5. **Lifecycle fakeDom** — 2 new mock elements.
6. **Copy button** — `Copy Exposure` in exports group.

**Dependencies:** Phase 2 complete.

**Report format (descriptive, no quality labels):**
```
EXPOSURE   | strategy=<key> interval=<int> pairs=<P> assets=<A>
EXPOSURE   | NOTE: descriptive analysis of pair concentration and overlap. No quality labels.
ASSETS     | NFLX in 12 pairs | ORCL in 8 pairs | ANET in 6 pairs | AMD in 5 pairs | ...
CLUSTERS   | Largest: {NFLX,ORCL,ANET,AMD} connected via 23 pairs | Next: {AVGO,JPM,WFC} via 8 pairs
EQUITY_CORR| Top correlations: ORCL+NFLX ↔ ANET+NFLX = 0.82 (overlap=45 trades) | AVGO+JPM ↔ AVGO+WFC = 0.71 (overlap=38)
RATIO_CORR | Top correlations: ORCL+NFLX ↔ ANET+NFLX = 0.76 (overlap=3800 bars) | BTC+ETH ↔ BTC+SOL = 0.89 (overlap=4100 bars)
REDUNDANCY | <N> pairs have equity correlation > 0.7 with at least one other pair — consider dropping one of each
```

**Validation:**
- `tests/feature-dom-contracts.spec.ts` passes with new ids.
- `tests/batch-backtest-service-lifecycle.browser.spec.ts` passes.
- Full suite passes.

**Exit criteria:** Manual smoke: run batch → click Exposure & Redundancy → report renders.

---

## Phase 4: Fixed-Ratio Diagnostics (ONLY if Phase 0 passes)

**Objective:** Add validated spread-property metrics (ADF, half-life) to the UI, using the thresholds and approach validated in Phase 0.

**Scope:** Extend the engine + report format. No new endpoint (reuse Phase 2's endpoint with an optional `includeDiagnostics: true` flag).

**Technical tasks:**

1. **ADF test** (Augmented Dickey-Fuller) on log-ratio series.
   - Tests whether the ratio series is stationary at a fixed 1:1 hedge ratio. This is a unit-root test of a pre-specified spread, NOT an Engle-Granger cointegration test.
   - Lag selection: deterministic (e.g., Schwert criterion: `lag = floor(12 * (n/100)^(1/4)`). Report the selected lag count.
   - Do NOT synthesize p-values from 3 critical values. Expose the test statistic and report `reject_unit_root` or `not_rejected` at the 5% level.
   - Multiple-testing correction: report Benjamini-Hochberg q-values alongside raw p-values.

2. **Half-life** via OLS regression of Δy_t on y_{t-1}.
   - Report as `null` + status when the AR(1) coefficient falls outside the mean-reverting range (0 < ρ < 1).
   - Status values: `mean_reverting` (0 < ρ < 1, finite half-life), `unit_root` (ρ ≈ 1), `explosive` (ρ > 1), `oscillatory` (−1 < ρ < 0), `invalid` (ρ ≤ −1).
   - Report rolling-window median + IQR for stability, not a single point estimate.

3. **Report extension:** Add per-pair diagnostic line with ADF result + half-life + status. No composite score. No "best/avoid" labels. Sort by asset (same as Exposure section), not by ADF p-value.

4. **Hurst exponent:** Research-only. Do NOT include in v1. R/S is unreliable for finite samples and the metric measures long-range scaling, not stationarity. If added later, must be calibrated against synthetic processes first.

**Dependencies:** Phase 0 MUST pass. Phase 1-3 complete.

**Validation:** Phase 0 pass criteria documented. Engine spec includes known-answer tests on synthetic AR(1) series.

**Exit criteria:** Only if Phase 0 demonstrates consistent OOS value.

---

## Affected Modules and Files

### New files

| File | Phase | Purpose |
|---|---|---|
| `scripts/validate-spread-quality.ts` | 0 | CLI walk-forward validation script |
| `lib/spread-quality/spread-quality-engine.ts` | 1 | Pure compute: incidence, correlations, (Phase 4: ADF, half-life) |
| `lib/spread-quality/spread-quality-stream-types.ts` | 2 | NDJSON stream contract |
| `tests/spread-quality-engine.spec.ts` | 1 | Engine spec |

### Modified files

| File | Phase | Change |
|---|---|---|
| `lib/batch-backtest/batch-backtest-vite-plugin.ts` | 2 | Endpoint + handler (artifact iterator, not Promise.all) |
| `html-partials/tab-batch-backtest.html` | 3 | Button + panel |
| `lib/batch-backtest/batch-backtest-dom.ts` | 3 | 2 new ids |
| `lib/batch-backtest/batch-backtest-service.ts` | 3 | Service wiring |
| `tests/batch-backtest-service-lifecycle.browser.spec.ts` | 3 | fakeDom |
| `tests/batch-backtest-server-plugin.spec.ts` | 2 | Route tests |

---

## Architecture: Artifact Loading

The endpoint MUST NOT use `Promise.all(artifactMetas.map(loadStoredMineArtifact))`. That loads every artifact simultaneously, defeating the disk-backed parsed-artifact LRU (`parsedCache` at `batch-backtest-vite-plugin.ts:255`, capped at 32 entries).

Instead, iterate metadata sequentially:
```ts
for (const meta of artifactMetas) {
  if (shouldStop()) break;
  const artifact = await loadStoredMineArtifact(meta);
  engine.ingest(artifact);  // extract + store scalars, release reference
}
```

The engine accumulates only scalars (per-pair metadata, trade-pnl arrays, ratio-close arrays) and releases the full artifact after extraction. Peak memory = 1 artifact + accumulated scalar arrays.

---

## Data Flow

```
Batch Run → ArtifactStore (disk) → iterate metadata
                                    ↓ for each
                            loadStoredMineArtifact (1 at a time)
                                    ↓
                            extract: baseAsset, quoteAsset (metadata)
                                      result.trades[].pnl + exitTime (equity correlation)
                                      data[].close (ratio correlation, Phase 4: ADF/half-life)
                                    ↓ release artifact
                            accumulate scalars
                                    ↓ after all pairs
                            compute correlations + clusters
                                    ↓
                            ExposureRedundancyResult (scalars only)
                                    ↓
                            NDJSON stream → browser panel
```

---

## Performance

- **Asset incidence:** O(N) metadata scan. Negligible.
- **Trade-pnl correlation:** O(N² × avg_trades²) where avg_trades ≈ 20-80. On 600 pairs: 360K pair-pairs × ~50 trades each = manageable.
- **Ratio-return correlation:** O(N²·T) via dense matrix multiply on aligned returns. On 600 pairs × 4000 bars: ~19 MB return matrix, ~1-2 seconds. For >1000 pairs, compute only asset-shared-pair correlations.
- **Memory:** peak = 1 artifact (5-10 MB) + accumulated scalar arrays (N × T × 8 bytes for ratio returns ≈ 19 MB). Total peak ~30 MB — well within Node heap.

---

## Failure Handling

| Case | Handling |
|---|---|
| Pair has < 50 bars | Exclude from ratio correlation, include in incidence |
| No trade-time overlap between two pairs | correlation = null, overlap = 0 |
| Pair has no trades | Include in incidence, exclude from equity correlation |
| ADF regression singular (zero variance) | adfStatistic = null, status = "invalid" |
| Half-life with ρ outside (0,1) | halfLife = null, status = "unit_root"/"explosive"/"oscillatory" |
| NaN or Infinity in any metric | Report as null + status field. Never serialize NaN/Infinity. |
| Server cancellation mid-pair | Stop iterating, emit cancelled done |

---

## Rollback Strategy

- All new code in new files + new endpoint + new UI elements. Removing them reverts cleanly.
- No changes to `BatchSyntheticPairArtifact`, `BatchBacktestRunInput`, or the batch runner.
- No migrations, no settings changes, no localStorage changes.
- Phase 0 CLI script can be deleted without affecting anything.

---

## Assumptions and Unknowns

1. **Trade-pnl as equity proxy:** Using trade exit-time pnl as a sparse equity-return proxy assumes trades are the primary P&L events. If a pair has very few trades, the correlation estimate is noisy. Minimum trade-overlap threshold (e.g., 10 trades) should be required before reporting a correlation.

2. **Phase 0 outcome:** Most likely negative (given Mine Timing precedent). The plan is structured so a Phase 0 failure still delivers the Exposure & Redundancy Report (Phases 1-3), which is useful regardless.

3. **ADF lag selection:** The Schwert criterion is a reasonable default. If the validation script shows sensitivity to lag choice, switch to AIC-based selection.

4. **Cluster algorithm:** Connected-component labeling on the asset-pair bipartite graph. Standard algorithm, O(N) in pair count.
