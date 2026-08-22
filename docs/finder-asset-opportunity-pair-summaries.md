# Asset Opportunity Per-Pair Summary Recording + Analyzer — Implementation Plan

Status: PLANNING (no implementation yet)
Date drafted: 2026-08-22
Scope: batch Asset Opportunity runs only (single-run path does not archive today and is out of scope).

## The question this answers

> Is there information in how a pair treats ALL strategies/parameter sets — not
> just the top-ranked candidate — that predicts the pair's forward move, and
> does it add anything beyond the current top-1-by-sort selection rule?

Sub-questions: (1) pair "in gear" (breadth/level), (2) top-1 real vs lucky
(dispersion), (3) increment over rank (gated vs ungated top-1), (4) regime
monitor (breadth collapse as early warning). Predictors are in-search
aggregates over the FULL evaluated pool; the target is the pair-level mean
forward price-only PnL. This is exploratory research tooling — no deployment
claims without a fresh untouched window (see Exit criteria).

## Why new recording is required

The automatic archive stores only the top-N rows per sort (~120–140 unique
candidates per holdout) plus a pool-level baseline. The full pool
(`eligibleCandidateCount` ≈ 5,800–8,600 per window) is discarded after
slicing. True per-pair breadth/median/dispersion/candidate counts are
therefore not computable from existing archives. The full row set is, however,
still in memory at archive time (`iteration.results`), so the summary is
computed there and appended next to the existing archive outputs.

## Architecture (current, to be reused)

- `lib/finder/server/finder-vite-plugin.ts` → `processFinderAssetOpportunityBatchRun`
  → `completeOrderedIteration(index, holdoutBars, iteration)` — the single
  shared tail for sequential and parallel sweeps; already archives one block
  per (holdout × sort) and appends `config.txt` once per run.
- `lib/finder/server/finder-asset-opportunity-archive.ts` — archive leaf:
  `resolveAssetOpportunityArchiveDir(root)` → `<root>/archive/asset opportunity`;
  injectable `AssetOpportunityArchiveAppend` for tests; filename derived only
  from a validated integer holdout.
- `lib/finder/finder-asset-opportunity-metadata.ts` — pure helpers over
  `FinderAssetOpportunityResult[]` (e.g. `buildAssetOpportunityForwardOosBaseline`,
  `buildAssetOpportunityPerformancePayload`). Already imports only leaf-safe deps.
- Analyzers: `scripts/analyze-asset-opportunity-*.ts` (esno, `--archive-dir`,
  stride filter, seeded, write `.txt`+`.json` via `--output-prefix`) with
  `.bat` launchers in `archive/asset opportunity/`.

No new services, routes, schemas, storage, or infra. No changes to the worker
boundary, wire/stream types, UI, or settings.

## Data contract

New archive file per holdout value: `oos-pair-summary-<N>-bars.txt` (same
directory, same append-only semantics, same validated-integer filename rule).

Block format mirrors the holdout blocks exactly:

```
================================================================================
Timestamp: <ISO>
Batch run id: <id>
OOS holdout: <N> bars
Pair summaries: JSON
================================================================================
[<row>, <row>, ...]
```

Row shape (scalars only; sorted by symbol; one row per symbol present in
`iteration.results`):

```ts
interface AssetOpportunityPairSummaryRow {
    symbol: string;
    candidateCount: number;        // retained result rows for this symbol
    profitableShare: number;       // share with in-search netProfit > 0      [PREDICTOR]
    medianNetProfitPercent: number;                                          [PREDICTOR]
    netProfitP75MinusP25: number;  // robust spread of netProfitPercent      [PREDICTOR]
    medianExpectancy: number;      // median avgTrade                        [PREDICTOR]
    topNetProfit: number;          // best in-search netProfit (absolute $)  [PREDICTOR]
    forwardPnlPercentByHorizon: Record<number, number | null>; // mean fwd   [TARGET ONLY]
}
```

Analyzer rule: fields under `forwardPnlPercentByHorizon` are targets; they must
never be used as predictors. `null` when no candidate of the pair produced a
forward observation at that horizon.

## Phases

### Phase 1 — summary builder + archive writer (leaf modules)

Objective: compute per-pair aggregates from a full result set and append them
to the archive.

Tasks:
1. `buildAssetOpportunityPairSummaries(results: FinderAssetOpportunityResult[])`
   in `lib/finder/finder-asset-opportunity-metadata.ts`, next to
   `buildAssetOpportunityForwardOosBaseline`. Pure; group by `symbol`; median /
   P75 / P25 via sorting each per-symbol metric array; skip non-finite values;
   forward means reuse the same horizon fields the baseline reads.
2. `appendAssetOpportunityArchivePairSummary(...)` +
   `buildAssetOpportunityPairSummaryFilename(holdoutBars)` in
   `lib/finder/server/finder-asset-opportunity-archive.ts`, modeled line-for-line
   on `appendAssetOpportunityArchiveBlock` (validated integer N, injectable
   append, shared `defaultAppend`).

Dependencies: none (pure additions).

Risks: none at runtime until Phase 2 wires them.

Deliverables: the two functions + unit specs in
`tests/finder-asset-opportunity-archive.spec.ts` (filename validation, block
format, round-trip JSON, injectable append) and a builder spec (empty results,
single symbol, ties/non-finite handling, target-field presence).

Validation: `npm run typecheck`; new specs green via esno.

Exit criteria: builder + writer functions merged with specs; no plugin wiring yet.

### Phase 2 — wire into the batch archive tail

Objective: every batch holdout iteration appends one pair-summary block.

Tasks:
1. In `completeOrderedIteration` (finder-vite-plugin.ts), BEFORE the per-sort
   loop: compute `buildAssetOpportunityPairSummaries(iteration.results)` once
   and `await appendAssetOpportunityArchivePairSummary(...)` with the same
   `root: archiveRoot`, `batchRunId: input.runId`, `holdoutBars`, and injected
   `archiveAppend` passthrough used by the sort blocks.
2. Failure semantics: FATAL, identical to the sort-block archive failure path
   (increments failedIterations, emits `asset_batch_fatal`). Rationale: this is
   primary research data; silent loss invalidates later analysis. `config.txt`
   stays best-effort. Computation cost is negligible vs the backtests.

Dependencies: Phase 1.

Risks: existing plugin specs assert exact append sequences — they must be
updated (see Validation). Memory: no new retention (summary is built from
already-live `iteration.results` and serialized immediately).

Deliverables: wired append; updated specs.

Validation: `npm run typecheck`; `tests/finder-server-plugin.spec.ts`,
`tests/finder-asset-opportunity-batch-parallel.spec.ts`,
`tests/finder-asset-opportunity-archive.spec.ts` all green. Expected spec
edits: prepend `"oos-pair-summary-<N>-bars.txt"` per holdout to the exact-array
assertions (batch-order, empty-results, single-value, stop-mid-batch,
archive-fail) and +1 to contents-length assertions; the all-sorts tests'
`Archive sort:` filters are unaffected.

Exit criteria: one real smoke batch (small holdout range) writes
`oos-pair-summary-*.txt` alongside `config.txt` and `oos-holdout-*.txt`; blocks
parse as valid JSON.

### Phase 3 — offline analyzer

Objective: answer the four research questions from recorded data.

Tasks:
1. `scripts/analyze-asset-opportunity-pair-summaries.ts` following the existing
   analyzer conventions (CLI `--archive-dir`, `--stride-bars 12`,
   `--horizon 12`, `--output-prefix`; deterministic, no sampling).
2. Loads pair-summary files (latest batch, newest block per holdout — reuse the
   load/dedup pattern from `analyze-asset-opportunity-stability.ts`), applies
   the stride filter, and per disjoint window computes Spearman(predictor,
   pair-forward-mean) across symbols for each predictor field; reports mean,
   se, t, % windows positive — the stability-tool framing.
3. Time-blocked check: split the disjoint windows chronographically in half;
   the sign must hold in both halves to count as stable.
4. Increment test: reads the existing `oos-holdout-<N>-bars.txt` blocks to get
   the top-1 pick of a frozen reference sort (default `profitFactor`), then
   compares ungated top-1 mean forward vs top-1 gated by each predictor's
   median split — same windows, price-only units.
5. Regime monitor view: pool-level breadth (mean of `profitableShare`) per
   window over time, printed as a simple series.
6. `.bat` launcher in `archive/asset opportunity/` mirroring the stability bat.

Dependencies: Phase 2 data (at least a handful of recorded runs).

Risks: exploratory multiple testing — mitigated by the fixed predictor set
(five fields, defined above) and pre-stated reading: per-window sign stability
+ both time-blocks positive = hypothesis; anything else = dead.

Deliverables: analyzer + bat.

Validation: run on the first recorded batch; verify stride/dedup behavior
against a hand-checked window; `npm run typecheck` (scripts are in the main
tsconfig include).

Exit criteria: analyzer produces the four outputs (IC table, time-block split,
increment table, breadth series) from a real run folder without manual steps.

### Phase 4 — decision point (no code)

Objective: keep the research discipline explicit.

Tasks: accumulate recorded runs (including the already-planned window-shift
confirmation runs); run the analyzer; record findings in the Decision Rule
Research journal.

Exit criteria: each of the four questions answered PROMOTE / KILL / INSUFFICIENT
DATA with the pre-stated bars. Deployment consideration requires a fresh
untouched window regardless of retro results.

## Cross-cutting technical notes

- **Files touched**: `lib/finder/finder-asset-opportunity-metadata.ts`,
  `lib/finder/server/finder-asset-opportunity-archive.ts`,
  `lib/finder/server/finder-vite-plugin.ts` (one call site in
  `completeOrderedIteration`), `scripts/analyze-asset-opportunity-pair-summaries.ts`
  (new), the archive-folder `.bat` (new), three spec files.
- **Data flow**: workers/sequential loop → `AssetOpportunityIterationResult.results`
  (already on the main thread at archive time) → pure builder → JSON block →
  append-only file in `archive/asset opportunity/`. Nothing crosses the worker
  boundary that doesn't already; no stream/wire changes; `/status` and reattach
  unaffected.
- **Performance**: builder is O(R log R) with R = retained rows (~8k) per
  holdout — negligible next to the IS search. File growth ≈ 150–250 KB per
  holdout (≈ 50–70 MB per 289-holdout batch), comparable to the existing
  holdout archives.
- **Security**: filename derives only from the validated integer holdout
  (existing `buildAssetOpportunityArchiveFilename` pattern); symbols originate
  from the local dataset and are JSON-serialized, never path components.
- **Error handling**: append/compute failures follow the existing fatal archive
  path (visible `asset_batch_fatal`, prior files intact); no partial-block
  writes (single `appendFile` per block).
- **Rollback**: revert the wiring commit — new files are additive; no migration,
  no persisted state, no localStorage. Old runs simply lack pair-summary files
  and the analyzer reports INSUFFICIENT DATA for them.
- **Import hygiene**: metadata + archive modules are existing leaves already
  imported by the plugin; no browser-bound module is touched, so the
  `vite.config.ts` cjs bundle constraint is respected.

## Assumptions / unknowns (verify before or during Phase 1)

1. `iteration.results` contains ALL retained candidates per holdout (supported
   by `eligibleCandidateCount` matching `results.length` in the baseline
   builder); `FinderAssetOpportunityResult.totalCandidatesEvaluated` may count
   something broader (including discarded searches) — do NOT use it as
   `candidateCount`; use the observed retained rows per symbol.
2. Pair-level forward mean over the pair's candidates is the agreed target
   (price-only, per-horizon). Execution-unit (TP/SL-censored) targets are out
   of scope and need a separate forward-outcome field.
3. Symbols in these runs are pair tokens (`MU•+GILD•`); one row per token is
   the intended "pair" unit.
4. The parallel sweep returns full `AssetOpportunityIterationResult` to the
   main thread before `completeOrderedIteration` (single-writer contract) —
   confirmed by the existing all-sorts archiving working identically on both
   paths.
