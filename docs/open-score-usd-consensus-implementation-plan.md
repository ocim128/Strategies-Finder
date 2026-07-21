# OPEN_SCORE USD Consensus — Implementation Plan
 
> Status: **PRE-IMPLEMENTATION**. This document is a plan, not shipped behavior. Once the feature ships, fold the operational parts into `docs/batch-backtest-server-side.md` and `docs/synthetic-pairs.md`, then delete this file (per `docs/README.md` maintenance rule).
>
> Note: this file is added to `docs/` at the user's explicit request despite the maintenance rule ("Do not add implementation plans to `docs/`"). Delete it once the work ships.
 
## Problem
 
The OPEN_SCORE USD replay answers: "at each historical decision event, did picking the TOP_MEAN asset beat a random positive candidate?" But on **balanced-pair-list runs**, different orientation seeds produce different TOP_MEAN winners — same asset universe, different base/quote orientation per pair, different picked asset.
 
Concrete examples from balanced-generator runs (seed → TOP_MEAN top asset):
 
| Seed | TOP_MEAN top asset | Share |
|---|---|---|
| 2 | TSLA | 9.6% |
| 5 | AMZN | 10.1% |
| 6 | WFC | 21.9% |
| 7 | AMAT | 19.4% |
 
The variance has two causes:
1. **Orientation flips** change which assets have positive scores (pair `A+B` long with A as base → A gets +1; same pair flipped → B gets +1).
2. **Tie-break hash digest** picks different winners when scores are tied (which is frequent on balanced lists where every asset has the same `activePairs` count).
 
Neither cause is real economic signal. A trader who picks "the TOP_MEAN asset" gets a different answer depending on which orientation seed the analysis happened to use — that is untradeable.
 
## Goal
 
Add a new analysis on the Batch menu — **OPEN_SCORE USD Consensus** — that runs the existing replay across N orientation seeds in one click, aggregates per-event results into a **consensus pick per event** with an explicit abstain rule, and reports agreement diagnostics (top-1 agreement, top-3 overlap, rank correlation) across seeds.
 
The output answers a different question than the single-run replay:
- Single-run replay: "did the pick beat random, on this orientation?"
- Consensus: "did the pick beat random, **averaged over orientations**, and how stable is it?"
 
## Design decisions (with rationale)
 
### D1. Pair list source = production textarea, orientation-only seeding
 
Each seed only flips `baseAsset`↔`quoteAsset` on the existing retained Batch artifacts — the **pair set does not change** between seeds. This isolates "orientation sensitivity" (what we want to measure) from "pair list sensitivity" (a separate question).
 
Rejected alternative: reuse the balanced pair-list generator's full seed (which changes both pair subset and orientation). That conflates two forms of variance and the consensus result is harder to interpret.
 
### D2. Re-orientation is a loader wrapper, not an engine change
 
The engine takes `() => AsyncIterable<BatchSyntheticPairArtifact>` (`lib/batch-backtest/batch-open-score-usd-replay-engine.ts:339`). The consensus engine wraps the existing artifact loader with a small async generator that yields shallow clones with `baseAsset`/`quoteAsset` swapped (per-pair deterministic coin flip keyed on `(seed, pairSymbol)`).
 
**Verified structural facts** (from read-only exploration of the engine):
- The engine reads `baseAsset`/`quoteAsset` exactly once, at `batch-open-score-usd-replay-engine.ts:413-434`, to assign `bi`/`qi` asset indexes and update the static degree map.
- Sign assignment at `:436-451`: long trade → `bi += +1, qi += -1` at entry; inverse at exit. Swapping `baseAsset`↔`quoteAsset` (with `result.trades` unchanged) negates the per-trade score delta on both legs.
- Forward returns use a **separate** `OpenScoreUsdTarget` keyed on asset name (engine `:698-744`), NOT the artifact's own `data`. So swapping pair orientation does not affect forward returns.
- The engine does not parse the artifact's `symbol` string; identity comes only from `baseAsset`/`quoteAsset`.
- Static degree counts (which feed `MAX_RETAINED`/`MAX_SUBMITTED`) are invariant under the swap (both legs are still counted).
 
Implication: the consensus engine requires **no modification to `runOpenScoreUsdReplay`**. It calls the engine N times with N wrapped loaders.
 
### D3. Default seed count = 10, configurable 5–20
 
The original proposal suggested 20–50 seeds. That range is too expensive interactively: per-seed runtime is ~10–60s on real pair counts (you've seen 16–58s on 400–2000 pairs), so 50 seeds is 8–50 minutes per click.
 
10 seeds is sufficient for a binary trade/skip decision. With 10 seeds and a 60% threshold, the binomial 95% CI on "asset X wins 70%" is roughly ±28 percentage points — wide in absolute terms, but the decision is binary (trade / abstain), and 10 seeds reliably separates "won 9/10" (high confidence) from "won 4/10" (no consensus).
 
### D4. Aggregation rule: average raw TOP_MEAN score across seeds per asset per event
 
The original proposal offered "median rank OR average standardized score" without committing. Committing to **average raw score** because:
- OPEN_SCORE scores are already on the same scale (signed vote / activePairs), so standardization is unnecessary.
- Median rank throws away magnitude information that is meaningful (a +5 score asset is genuinely more crowded than a +1 score asset on the same seed).
 
The report will ALSO surface median rank as a secondary diagnostic for transparency, but the winner decision uses average raw score.
 
### D5. Abstain threshold = 60% by default, configurable 50–80%
 
If no asset has ≥ threshold% seed support as the #1 pick at an event, the event is marked `NO_CONSENSUS` and counted toward the abstain rate. The original proposal's "60–70%" range is reasonable; 60% default because at seed=10 that means a winner needs ≥6/10, keeping abstain rates interpretable.
 
### D6. Per-pair orientation flip is a deterministic hash, not `Math.random`
 
Each pair's flip decision is `hash(seed, pairSymbol) % 2 === 1`. This makes a given seed reproducible across runs (important: the existing OPEN_SCORE USD engine uses deterministic block bootstrap and FNV-1a tie-break for exactly this reason — research must be reproducible).
 
## What this feature will NOT do
 
- **Walk-forward / OOS evaluation inside the consensus run.** The original proposal suggested "positive out-of-sample performance across most seeds." That conflates consensus (agreement) with OOS (edge). Consensus measures whether the pick is stable; OOS measures whether it's profitable. Different questions, different features. Ship consensus first; OOS is a separate feature.
- **Top-2/3 consensus basket.** The original proposal suggested "trade top 2–3 if top is unstable." That's a portfolio decision layered on a selector decision — adds complexity (sizing? correlation?) without clear value yet. Single-pick-or-abstain is the right first cut.
- **Engine changes.** None. The whole feature is built on top of the existing engine via the loader-wrapper pattern.
- **Modify artifacts on disk.** The re-orientation is purely in-memory via shallow clones.
 
## Architecture
 
```
┌─ UI (tab-batch-backtest.html + batch-backtest-dom.ts) ─────────────┐
│  New: "OPEN_SCORE USD Consensus" button, seed-count input,         │
│       threshold input, summary div, "Copy Consensus" button        │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ POST /api/batch-backtest/open-score-usd-consensus
                              ▼
┌─ Service (batch-backtest-service.ts) ──────────────────────────────┐
│  New: runConsensus(), copyConsensusResults(), lastConsensusResult  │
│  Reuses: postBatchNdjson (unchanged)                               │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ NDJSON stream
                              ▼
┌─ Server plugin (batch-backtest-vite-plugin.ts) ────────────────────┐
│  New: handleConsensusRequest, processConsensus, route registration │
│  Reuses: existing artifact store, disconnect-safe stream           │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ invokes N times
                              ▼
┌─ Consensus engine (NEW: batch-open-score-usd-consensus-engine.ts) ─┐
│  Pure leaf. Wraps artifact loader per seed, runs the existing      │
│  engine N times, aggregates per-event, builds report.             │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ uses (no modifications)
                              ▼
┌─ Existing engine (batch-open-score-usd-replay-engine.ts) ──────────┐
│  runOpenScoreUsdReplay — UNCHANGED. Called once per seed.          │
└────────────────────────────────────────────────────────────────────┘
```
 
## Steps
 
Each step ends with a verification check.
 
### Step 1. Stream types — `lib/batch-backtest/batch-open-score-usd-consensus-stream-types.ts` (new file)
 
Mirror `lib/batch-backtest/batch-open-score-usd-replay-stream-types.ts` shape:
- `start` carries `{ pairs, assets, horizons, seedCount, threshold }`
- `phase` / `progress` carry per-seed progress: `{ seedIndex, seedCount, phase, detail, completed, total, elapsedMs }`
- `done` carries `OpenScoreUsdConsensusResult` (defined in step 2)
- `fatal` carries `{ error }`
 
*Verify:* `tsc --noEmit`.
 
### Step 2. Consensus engine — `lib/batch-backtest/batch-open-score-usd-consensus-engine.ts` (new file, pure leaf)
 
Imports (type-only where possible):
- `runOpenScoreUsdReplay`, `OpenScoreUsdReplayResult`, `OpenScoreUsdTarget` from `./batch-open-score-usd-replay-engine`
- `BatchSyntheticPairArtifact` from `./batch-synthetic-state-miner`
- `OHLCVData` type-only from `../types/strategies`
 
Public types:
 
```ts
export interface ConsensusCandidateSummary {
    asset: string;
    seedSupportCount: number;       // # of seeds where this asset was the #1 pick
    seedSupportPct: number;         // seedSupportCount / seedCount
    avgScore: number;               // mean raw score across seeds (the winner key)
    medianRank: number;             // median rank across seeds (1 = always top)
}
 
export interface ConsensusPerHorizonResult {
    bars: number;
    topMeanConsensus: ConsensusCandidateSummary[];
    topRawConsensus: ConsensusCandidateSummary[];
    /** Fraction of events where all seeds picked the same #1 asset. */
    top1Agreement: number;
    /** Average pairwise Jaccard of top-3 sets across seeds. */
    top3Overlap: number;
    /** Average pairwise Kendall tau of per-seed rank vectors across seeds. */
    rankCorrelation: number;
    /** Events where no asset cleared the threshold — skipped by the rule. */
    abstainRate: number;            // abstainedEvents / totalEvents
    abstainedEvents: number;
    totalEvents: number;
    /** Mean per-event delta (consensus-pick return − random-positive return) averaged across seeds. */
    deltaVsRandom: number | null;
    ciLower: number | null;
    ciUpper: number | null;
    positiveBlocks: number;
    totalBlocks: number;
}
 
export interface OpenScoreUsdConsensusResult {
    seedCount: number;
    threshold: number;              // 0..1
    pairs: number;
    assets: number;
    horizons: number[];
    perHorizon: ConsensusPerHorizonResult[];
    reportLines: string[];
    warnings: string[];
}
```
 
Public function:
 
```ts
export async function runOpenScoreUsdConsensus(
    artifactLoader: () => AsyncIterable<BatchSyntheticPairArtifact>,
    targetLoader: () => AsyncIterable<OpenScoreUsdTarget>,
    options: {
        seeds: number;              // 5..20
        threshold: number;          // 0.5..0.8
        horizons: number[];
        interval?: string;
        sampleFromSec?: number;
        sampleToSec?: number;
        slippageRate?: number;
        commissionRate?: number;
        onPhase?: (phase, detail, completed, total) => void;
        onSeedProgress?: (seedIndex, seedCount, phase, detail, completed, total) => void;
        shouldStop?: () => boolean;
    },
): Promise<OpenScoreUsdConsensusResult>
```
 
Internals:
 
1. **`reorientArtifacts(loader, seed)`:** returns a wrapped `() => AsyncIterable<BatchSyntheticPairArtifact>`. For each artifact, decide flip via `fnv1a32Hash(seed + ":" + artifact.symbol) & 1`. If flip: yield `{ ...artifact, baseAsset: artifact.quoteAsset, quoteAsset: artifact.baseAsset, baseSymbol: artifact.quoteSymbol, quoteSymbol: artifact.baseSymbol }` (shallow clone; `data`, `signals`, `result` passed by reference). If no flip: yield the original artifact. The `symbol` string is NOT modified (engine doesn't parse it; consumer audit done in design).
 
2. **Per-seed loop:** for each seed in `0..seeds-1`:
   - Wrap loader: `const wrappedLoader = reorientArtifacts(artifactLoader, seed);`
   - Call `runOpenScoreUsdReplay(wrappedLoader, targetLoader, { horizons, interval, sampleFromSec, sampleToSec, slippageRate, commissionRate, onPhase, shouldStop })`.
   - Capture the per-seed result. Per-event data needed for aggregation: per horizon, the per-event series of (timeSec, topMean winner asset, topMean score-by-asset map, topRaw winner, topRaw score-by-asset map).
 
3. **Per-event series exposure (additive engine change):** the existing engine already accumulates parallel arrays per series (deltas, returns, times, assets). To get per-event score-by-asset maps, extend the engine result with two new optional fields:
   - `topMeanEvents?: PerSeedEventRecord[]`
   - `topRawEvents?: PerSeedEventRecord[]`
   where `PerSeedEventRecord = { timeSec: number; winner: string; scoreByAsset: Record<string, number> }`.
 
   These are additive — existing tests that don't read them keep passing. The engine populates them by recording per-event winners + the score snapshot at decision time.
 
4. **Aggregation (per horizon, per event):**
   - Inner-join events across seeds by `timeSec` (only events present in ALL seeds contribute — the production pair list is fixed, so this should be ~all events; if a seed produced a slightly different event set due to orientation flipping the positive/negative pool, that event is dropped from consensus for that horizon).
   - For each joined event, for each asset appearing as a positive candidate in any seed: average the raw TOP_MEAN score across seeds (0 if absent in a seed), compute `seedSupportCount` (# of seeds where this asset was the per-seed #1), `medianRank` (median of per-seed ranks).
   - Pick the asset with the highest `avgScore`. Check `seedSupportPct >= threshold`. If yes → consensus winner. If no → abstain.
 
5. **Agreement diagnostics (per horizon):**
   - `top1Agreement`: fraction of joined events where all seeds picked the same #1 asset.
   - `top3Overlap`: for each pair of seeds, Jaccard of their top-3 sets over all joined events; average across pairs.
   - `rankCorrelation`: for each pair of seeds, Kendall tau over the union of assets using per-seed average rank; average across pairs.
 
6. **Delta vs random:** for each joined event, the per-seed `topMean.deltas[i]` is already the (selected − randomMean) delta for that seed's winner. Average across seeds for the consensus winner; bootstrap CI from chronological block means (reuse the same deterministic block bootstrap as the engine — seed it identically so the result is reproducible).
 
7. **Report builder:** build `reportLines` per the format in step 6.
 
*Verify:* `tsc --noEmit`; engine unit tests in step 7.
 
### Step 3. Additive engine extension — `lib/batch-backtest/batch-open-score-usd-replay-engine.ts`
 
Add `topMeanEvents?: PerSeedEventRecord[]` and `topRawEvents?: PerSeedEventRecord[]` to `OpenScoreUsdReplayResult.horizons[number]`. Populate them in the existing per-view loop (where `appendSelection(topMean, view.topMean)` is called today, ~line 818). This is purely additive — no behavior change for callers that don't read these fields.
 
Type definition (new file or in engine):
```ts
export interface PerSeedEventRecord {
    timeSec: number;
    winner: string;
    scoreByAsset: Record<string, number>;
}
```
 
*Verify:* `tsc --noEmit`; existing engine tests still pass (additive fields).
 
### Step 4. Server plugin — `lib/batch-backtest/batch-backtest-vite-plugin.ts`
 
- New exported function `processConsensus(fingerprint, interval, writer, owner, seedCount, threshold, horizons, sampleFromSec, sampleToSec, loadTargetDataset?)` — mirrors `processOpenScoreUsdReplay` signature plus `seedCount` and `threshold`.
  - Internally: same artifact store reads (`collectStoredMineArtifactMetas`, `loadStoredMineArtifact`), same target dataset loader pattern as OPEN_SCORE USD.
  - Calls `runOpenScoreUsdConsensus` with the artifact loader, target loader, and the consensus options.
  - Streams `start` → per-seed `phase`/`progress` → `done`/`fatal` through the writer.
  - Same pre-flight fatal checks as OPEN_SCORE USD (no artifacts, stale fingerprint, etc.) plus consensus-specific validation (seedCount in 5–20, threshold in 0.5–0.8).
  - Read-only on the artifact store (no `releaseLastResults`), exactly like the existing OPEN_SCORE USD processor.
- New `handleConsensusRequest(res, body)` — parses body for `{ fingerprint, seedCount?, threshold?, horizons, sampleFrom?, sampleTo? }`, validates, streams through `createDisconnectSafeStream`.
- New route registration in `registerBatchRoutes`: `middlewares.use("/api/batch-backtest/open-score-usd-consensus", ...)` with same 405 (non-POST) and 401 (non-loopback) guards as the OPEN_SCORE USD route.
- Export `processConsensus` and `handleConsensusRequest` via `__testInternals`.
 
*Verify:* `tsc --noEmit`; server-plugin tests in step 7.
 
### Step 5. Service — `lib/batch-backtest/batch-backtest-service.ts`
 
- New field: `private lastConsensusResult: OpenScoreUsdConsensusResult | null = null;`
- New method `runConsensus()` — mirrors `runOpenScoreUsdReplay()`:
  - Pre-flight: `serverHasArtifacts`, `lastRunFingerprint`, parse horizons from existing `dom.batchBacktestOpenScoreUsdHorizons.value` (reuse the same input — no separate horizons input for consensus), parse `seedCount` from `dom.batchBacktestConsensusSeeds.value` (default 10), parse `threshold` from `dom.batchBacktestConsensusThreshold.value` (default 60, normalized to 0..1).
  - POST to `/api/batch-backtest/open-score-usd-consensus` with `{ fingerprint, interval, horizons, seedCount, threshold, ...sampleFrom/To }`.
  - Handlers update `dom.batchBacktestConsensusSummary.textContent` with phase/progress/done/fatal text. On `done`, store `lastConsensusResult` and render `reportLines.join("\n")`.
  - Same `analysisInFlight` / `analysisCancelRequested` gating as OPEN_SCORE USD.
- New method `copyConsensusResults()` — mirrors `copyOpenScoreUsdResults()`.
- Update `updateArtifactActionButtons` to gate the new button on `serverHasArtifacts && lastRunFingerprint`.
- Update `clearMinerResults` to clear `lastConsensusResult`, disable Copy, clear the summary.
- Update `copyResults` (the main Copy button handler) to embed `lastConsensusResult.reportLines` when present, mirroring the OPEN_SCORE USD embedding at `batch-backtest-service.ts:1056-1070`.
- Wire click handlers in the constructor: `dom.batchBacktestConsensusBtn` → `runConsensus`, `dom.batchBacktestCopyConsensusBtn` → `copyConsensusResults`.
 
*Verify:* `tsc --noEmit`.
 
### Step 6. UI — `html-partials/tab-batch-backtest.html` + `lib/batch-backtest/batch-backtest-dom.ts`
 
HTML additions in three locations:
 
1. In `.batch-action-group--analysis` after the OPEN_SCORE USD button (`tab-batch-backtest.html:89-92`):
   ```html
   <button class="btn btn-secondary btn-compact" id="batchBacktestConsensusBtn" type="button" disabled
       title="Run OPEN_SCORE USD across multiple orientation seeds; aggregate per-event into a consensus pick with abstain rule.">
       OPEN_SCORE USD Consensus
   </button>
   ```
 
2. After the OPEN_SCORE USD config block (`:108`), add a new sibling:
   ```html
   <div class="batch-mine-prediction-config" aria-label="OPEN_SCORE USD Consensus configuration">
       <span class="batch-mine-prediction-config-label">Consensus:</span>
       <div class="batch-field batch-field--inline" title="Number of orientation seeds (5-20).">
           <label class="batch-field-label" for="batchBacktestConsensusSeeds">Seeds</label>
           <input class="batch-field-input batch-field-input--date" id="batchBacktestConsensusSeeds" type="number" value="10" min="5" max="20" step="1">
       </div>
       <div class="batch-field batch-field--inline" title="Minimum seed support as #1 pick to declare consensus (50-80%).">
           <label class="batch-field-label" for="batchBacktestConsensusThreshold">Threshold %</label>
           <input class="batch-field-input batch-field-input--date" id="batchBacktestConsensusThreshold" type="number" value="60" min="50" max="80" step="5">
       </div>
   </div>
   ```
 
3. In exports group after the OPEN_SCORE USD Copy button (`:124-127`):
   ```html
   <button class="btn btn-secondary btn-compact" id="batchBacktestCopyConsensusBtn" type="button" disabled
       title="Copy the OPEN_SCORE USD consensus report">
       Copy Consensus
   </button>
   ```
 
4. After the OPEN_SCORE USD summary div (`:175`):
   ```html
   <div class="batch-miner-status batch-miner-status--multiline" id="batchBacktestConsensusSummary"></div>
   ```
 
DOM contract additions in `lib/batch-backtest/batch-backtest-dom.ts`:
- Add to `BATCH_BACKTEST_REQUIRED_IDS`:
  - `batchBacktestConsensusBtn`
  - `batchBacktestCopyConsensusBtn`
  - `batchBacktestConsensusSeeds`
  - `batchBacktestConsensusThreshold`
  - `batchBacktestConsensusSummary`
- Add to factory in `createBatchBacktestDom()`:
  - `batchBacktestConsensusBtn: getRequiredElement<HTMLButtonElement>("batchBacktestConsensusBtn")`
  - `batchBacktestCopyConsensusBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyConsensusBtn")`
  - `batchBacktestConsensusSeeds: getRequiredElement<HTMLInputElement>("batchBacktestConsensusSeeds")`
  - `batchBacktestConsensusThreshold: getRequiredElement<HTMLInputElement>("batchBacktestConsensusThreshold")`
  - `batchBacktestConsensusSummary: getRequiredElement<HTMLDivElement>("batchBacktestConsensusSummary")`
 
*Verify:* `tests/feature-dom-contracts.spec.ts` (auto-iterates the array; just ensure IDs are unique + present in HTML).
 
### Step 7. Report format — `buildReportLines` in consensus engine
 
```
OPEN_SCORE USD CONSENSUS | seeds=10 threshold=60% pairs=918 assets=70 events=5684
config | interval=4h horizons=[12,24,48] source=production-orientation-seeded
aggregator | winner=avg-raw-score abstain=when-top1-support<60%
 
--- horizon 12 bar(s) ---
TOP_MEAN CONSENSUS  | NVDA wins 9/10 seeds (90%) avg=+2.34 median-rank=1.2 | ABSTAIN 4% (23/568)
TOP_RAW CONSENSUS   | NVDA wins 10/10 (100%) avg=+5.18 median-rank=1.0    | ABSTAIN 0% (0/568)
AGREEMENT           | top1=0.82 top3-overlap=0.71 rank-correlation=0.74
CONSENSUS DELTA     | NVDA delta=+0.46% CI95=[+0.10,+0.85] +blocks=8/10 (vs random-positive baseline, averaged across seeds)
 
--- horizon 24 bar(s) ---
[same shape]
 
WARN: [same standard OPEN_SCORE warnings — split-adjustment, event-level, etc.]
elapsed=NNs
```
 
### Step 8. Tests
 
New file `tests/batch-open-score-usd-consensus-engine.spec.ts`:
- 2-seed fixture with known orientation flips → assert per-event consensus winner matches hand-computed value
- Threshold edge case: asset wins exactly threshold% → trade; below → abstain
- All-seeds-disagree → 100% abstain
- Agreement metrics on known fixture → assert top1 / top3 / Kendall values
- Reproducibility: same seed twice → identical result
 
Extend `tests/batch-backtest-server-plugin.spec.ts`:
- Route auth: 405 on GET, 401 on non-loopback (mirror the OPEN_SCORE USD route-auth tests at `:2025-2057`)
- Processor: `processConsensus` happy path emits `start` → per-seed `phase`/`progress` → `done`
- Fatal paths: no artifacts, stale fingerprint, invalid seedCount/threshold
- Read-only on artifacts: run consensus → confirm artifacts still present → run normal OPEN_SCORE USD after
 
Extend `tests/batch-backtest-copy.spec.ts`:
- Assert `lastConsensusResult.reportLines` is embedded in the main Copy Results text when present
 
`tests/feature-dom-contracts.spec.ts`: no edit needed (auto-iterates the required-ids array).
 
*Verify:* all of the above pass.
 
### Step 9. Documentation
 
- `docs/batch-backtest-server-side.md`: add a "OPEN_SCORE USD Consensus" subsection near the existing OPEN_SCORE USD paragraph, explaining the new endpoint, the abstain rule, and the agreement diagnostics. This is the durable doc.
- `AGENTS.md`: new bullet under "Server-Side Batch Backtest" → "OPEN_SCORE USD Consensus" with the four load-bearing contracts:
  1. Orientation-only seeding (pair set is fixed; only base/quote flips per seed).
  2. Re-orientation is a loader wrapper (no engine change, no on-disk artifact mutation).
  3. Abstain rule (no consensus → skip, never force a pick).
  4. Read-only on the artifact store (no `releaseLastResults`).
- This plan file (`docs/open-score-usd-consensus-implementation-plan.md`): **delete after the feature ships** (per the maintenance rule).
 
## Verification (final)
 
Run after all changes:
- `tsc --noEmit` (0 errors)
- `tsc -p tsconfig.tests.json` (0 errors)
- `esno tests/batch-open-score-usd-consensus-engine.spec.ts`
- `esno tests/batch-open-score-usd-replay-engine.spec.ts`
- `esno tests/batch-open-score-usd-max-active.spec.ts`
- `esno tests/batch-backtest-server-plugin.spec.ts`
- `esno tests/batch-backtest-copy.spec.ts`
- `esno tests/feature-dom-contracts.spec.ts`
- `esno tests/batch-backtest-runner.spec.ts`
- `esno tests/batch-backtest-server-loader-parity.spec.ts`
- Manual smoke: start `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`, run a 5-seed consensus on a 50-pair batch, confirm the report renders, the abstain rule fires when expected, and Stop cancels cleanly.
 
## Files touched
 
| File | Type of change |
|---|---|
| `lib/batch-backtest/batch-open-score-usd-consensus-stream-types.ts` | NEW — NDJSON stream union |
| `lib/batch-backtest/batch-open-score-usd-consensus-engine.ts` | NEW — pure-leaf consensus engine (~250 lines) |
| `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` | Extend result interface with `topMeanEvents` + `topRawEvents` (additive) |
| `lib/batch-backtest/batch-backtest-vite-plugin.ts` | New `processConsensus`, `handleConsensusRequest`, route registration, `__testInternals` export |
| `lib/batch-backtest/batch-backtest-service.ts` | New `runConsensus`, `copyConsensusResults`, field, gating, Copy embedding |
| `lib/batch-backtest/batch-backtest-dom.ts` | 5 new IDs + factory entries |
| `html-partials/tab-batch-backtest.html` | New button + config block + copy button + summary div |
| `tests/batch-open-score-usd-consensus-engine.spec.ts` | NEW — 5+ unit tests |
| `tests/batch-backtest-server-plugin.spec.ts` | Extend with route-auth + processor tests for consensus |
| `tests/batch-backtest-copy.spec.ts` | Extend copy-embed test |
| `docs/batch-backtest-server-side.md` | New subsection |
| `AGENTS.md` | New bullet under Server-Side Batch Backtest |
| `docs/open-score-usd-consensus-implementation-plan.md` | **Delete after ship** |
 
## Complexity budget
 
- ~250 lines for the consensus engine (aggregation math + report builder)
- ~80 lines for the server plugin (handler + processor)
- ~80 lines for the service method
- ~50 lines for the engine interface extension (additive fields)
- ~50 lines of HTML
- ~250 lines of tests
- ~150 lines of docs
- **Total ~900 lines** — meaningful feature, similar scope to the original OPEN_SCORE USD replay.
 
No changes to the engine's selector logic, no changes to the artifact store, no changes to the existing OPEN_SCORE USD endpoint. The whole feature is additive and the engine is reused as-is via the loader-wrapper pattern.
 
## Open questions for the auditor
 
These are design decisions I made unilaterally; a thorough audit should challenge them:
 
1. **Is "average raw score across seeds" the right aggregator?** I rejected median rank and standardized score. Median rank is more robust to outliers but discards magnitude; standardized score is unnecessary because the scores share a scale. Average raw score uses the most information.
 
2. **Is the inner-join-by-timeSec aggregation correct?** If orientation flipping causes one seed to see event X and another not to, I drop X from consensus. Alternative: union-join and treat absent seeds as zero-score for that asset.
 
3. **Is 10 seeds enough?** I argued yes for a binary trade/skip decision. The original proposal suggested 20–50. The runtime cost pushes toward fewer; statistical comfort pushes toward more.
 
4. **Is "production pair list, orientation-seeded" the right pair-list policy?** I rejected the full balanced-generator seeding (which would change the pair subset too) on the grounds that it conflates two forms of variance. But it's the broader notion of stability.
 
5. **Should the abstain threshold be per-event or per-asset?** Current design: per-event (the threshold gates each event independently). Alternative: per-asset (require the asset to clear threshold across all events it appears in).
 
6. **Does the additive engine interface change (`topMeanEvents`/`topRawEvents`) risk leaking per-event data into other consumers?** The fields are optional. Existing tests should not break. But the engine's design currently favors compact arrays; adding per-event score maps is a memory-cost decision at very large event counts.
 