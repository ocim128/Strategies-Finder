## Goal

Answer the Phase-2 gate question: **is `TOP_MEAN NOW` stable across simulation start dates?** This is a single UI-driven operation that runs the current-snapshot computation across N user-chosen start dates and shows a stability/diff view of the current winners. It does NOT build incremental checkpoints (that's Phase 2 itself) — it proves whether Phase 2's continuation-parity assumption holds for the user's actual strategy config.

Forward-edge validation is deliberately OUT of scope: the historical replay delta (`+3.45%`) already validates the selection rule forward. This is strictly about start-date stability of the single current snapshot.

## The one missing seam: slicing pair backtests by start date

Currently `sampleFromSec`/`sampleToSec` only filter the phase-3 OPEN_SCORE replay events; the pair backtests always run over full history. To test start-date stability, the worker must actually trim loaded candles to `[startDate, ∞)` BEFORE `executeBacktest`, so the open position reflects "what would the strategy hold if it started on date X."

`loadServerBatchDataset(symbol, interval, signal?)` has no date overload anywhere, so slicing happens in the worker, after load, using the existing `parseTimeToUnixSeconds` helper on each candle's `.time`.

## Architecture

A new **stability mode** in the coordinator (`TopMeanCoordinatorEngine`), triggered by a new request flag. It runs N windows sequentially inside ONE owner-lock acquisition (the existing lock is a single global mutex, so sequential-in-one-op is mandatory). Each window: enumerate → worker backtests (with that window's `sampleFromSec` slice) → snapshot. The N snapshots are accumulated and emitted as a single terminal `stability_done` event carrying the comparison.

No new route, no new database, no new service class. Reuses the existing `/run` endpoint, the existing NDJSON stream, the existing results container, and the existing snapshot reducer.

## Tasks

### 1. Plumb a per-run `sampleFromSec` slice to the worker backtests

- `TopMeanCoordinatorRunRequest` (`sp500-top-mean-coordinator-engine.ts`): the existing `sampleFromSec` field keeps its replay-filter meaning. Add a SEPARATE field `backtestFromSec?: number` — "trim pair candles to `[backtestFromSec, ∞)` before executeBacktest. Distinct from sampleFromSec (which filters replay events) so the two can be set independently." This keeps the existing `sampleFrom` UI date's replay-only contract intact and backward-compatible.
- `WorkerPoolRunOptions` and `TopMeanWorkerTaskData` (`sp500-top-mean-worker-pool.ts`, `sp500-top-mean-worker.ts`): add `backtestFromSec?: number`.
- In the worker's pair loop (`sp500-top-mean-worker.ts:69`, right after `loadServerBatchDataset`): if `data.backtestFromSec` is set, trim `candles` to entries where `parseTimeToUnixSeconds(candle.time) >= data.backtestFromSec`. Keep the existing `< 200` guard so a window that yields too few candles is skipped per-pair (reported as failed, not crashed). `dataEndTime` then naturally reflects the trimmed window's last closed candle.
- The coordinator's existing phase-2 `pool.execute({...})` call threads `backtestFromSec: this._request.backtestFromSec` through.

### 2. Add the stability mode to the coordinator

- New request field `stabilityStartDates?: number[]` (unix seconds). When present and non-empty, the engine runs in stability mode.
- In `run()`: if stability mode, loop over `stabilityStartDates` (plus an implicit "full history" entry when the list doesn't already include no-slice). For each window:
  - set the per-window `backtestFromSec`,
  - use a window-scoped artifact subdir (`<runId>/windows/<i>/shards/...`) so windows don't overwrite each other — extend `sp500-top-mean-artifact-store.ts` with a `windowKey` param on `getShardsDir`/`iterateRunRawCompactArtifacts`/`writeShardArtifacts`/`readShardArtifacts` and the manifest's `completedShards` (one manifest per window),
  - run the worker pool for that window,
  - run `computeCurrentTopMeanSnapshot` over that window's artifacts,
  - accumulate `{ startDateSec, label, snapshot, stats }` into a `StabilityWindowResult[]`.
- Single progress stream: emit `progress` per window (`phase: "stability"`, `window: i/N, text`), `current_snapshot` per window as it completes, and one terminal `stability_done` event with the full `StabilityResult`.
- The historical replay phase is SKIPPED in stability mode (it's irrelevant to the stability question and would multiply cost).
- `getStatus()` gains an optional `stabilityProgress: { currentWindow, totalWindows, partialSnapshots }` so `/status` reattach works mid-run.
- The owner-lock is acquired once at the top of `run()` and released in the existing `finally`.

### 3. New pure comparison helper

- `lib/batch-backtest/sp500-top-mean-stability-compare.ts` (leaf, server-safe, no `lightweight-charts`):
  - `StabilityWindowResult { startDateSec: number | null; label: string; snapshot: CurrentTopMeanSnapshot; stats: CurrentTopMeanStats }`.
  - `StabilityComparison { windows: StabilityWindowResult[]; winnerAssetsByWindow: string[][]; commonWinners: string[]; divergentWindows: boolean; agreementPct: number; maxMeanDrift: number; reportLines: string[] }`.
  - `compareStabilitySnapshots(windows: StabilityWindowResult[]): StabilityComparison` — computes:
    - `commonWinners` = intersection of every window's `winners[].asset` set,
    - `agreementPct` = `|commonWinners| / |union of all winners|`,
    - `divergentWindows` = any window's winner set differs from window[0]'s,
    - `maxMeanDrift` = max |mean(asset, windowA) − mean(asset, windowB)| across windows for assets present in all,
    - `reportLines` = plain-text `STABILITY | ...` lines for the Copy surface.
  - Verdict for the Phase-2 gate: `divergentWindows === false` AND `agreementPct === 100%` → continuation-parity assumption holds for this config; else → blocked, flag it.

### 4. UI controls (reuse existing container, add minimal controls)

In `html-partials/tab-batch-backtest.html` inside the existing `<section aria-label="S&P 500 TOP_MEAN coordinator">`:
- One new text input `batchBacktestSp500TopMeanStabilityDates` (type text, placeholder `2023-01-01, 2024-01-01, 2025-01-01`) + a checkbox `batchBacktestSp500TopMeanStabilityEnabled`. Title explains: "When checked, run the current snapshot across these start dates (plus full history) and show a stability diff. Skips the historical replay."
- One new button `batchBacktestSp500TopMeanStabilityRunBtn` (label "Run Stability Check") — separate from the main Run so the two modes don't collide. Reuses Stop.
- Register all three ids in `lib/batch-backtest/batch-backtest-dom.ts` `BATCH_BACKTEST_REQUIRED_IDS` + `createBatchBacktestDom()` (the three-way match `feature-dom-contracts.spec.ts` enforces automatically).

### 5. Service wiring (`batch-backtest-service.ts`)

- Bind the new Run button → new method `runSp500TopMeanStabilityCheck()`. It parses the comma-separated dates (UTC midnight, same `parseBodyDateSec` convention as the plugin), validates ≥1 date, builds a payload with `stabilityStartDates` + the current strategy/settings/pairList, and POSTs to the SAME `/api/batch-backtest/sp500-top-mean/run` endpoint.
- Add an `onStabilityDone` handler to the NDJSON handlers object (the stream auto-maps `stability_done` → `onStabilityDone`). Stash `this.latestTopMeanStabilityResult`, enable Copy/Download.
- Add an `onCurrentSnapshot` handler (currently missing — the engine emits `current_snapshot` but no handler exists) that renders each window's snapshot into the existing results container as it arrives, so the user sees per-window progress.
- New `renderStabilityResults(comparison)` that mirrors the walk-forward IS/OOS precedent (`tab-walkforward.html:113`): a table with one row per window, columns `Start Date | asOf | Winners | mean | activePairs | openPositions`. A summary header shows `agreementPct`, `commonWinners`, and a PASS/BLOCKED verdict banner for the Phase-2 gate. Uses the established inline-style + CSS-var convention (`var(--surface-2, ...)`, `#26a69a`/`#ef5350`).
- `copySp500TopMeanStabilityResults()` emits `comparison.reportLines.join("\n")` (the same opaque-pattern the OPEN_SCORE USD copy path uses).
- Reattach: extend `reattachToInProgressTopMeanRun()` so a mid-run reload restores stability progress from `getStatus().stabilityProgress`.

### 6. Tests (focused, per the repo's spec conventions)

- `tests/sp500-top-mean-stability-compare.spec.ts` (new): pure unit tests for `compareStabilitySnapshots` — full agreement, full divergence, partial overlap, single window, empty windows, maxMeanDrift math, verdict thresholds.
- Extend `tests/sp500-top-mean-worker.spec.ts`: a focused test that `backtestFromSec` trims the candle array (assert the artifact's `dataEndTime` and trade count change vs no-slice). Uses `prepareClosedCandleData` fixtures.
- Extend `tests/sp500-top-mean-server-plugin.spec.ts`: an integration test driving `run()` in stability mode with 2 windows (resume + pre-seeded shards per window, same pattern as the existing F4 test), asserting the terminal `stability_done` event carries N snapshots and the comparison verdict.
- `tests/feature-dom-contracts.spec.ts` auto-enforces the 3 new ids — no edit needed.
- Validation habit: `tsc --noEmit`, the four sp500 specs above, `feature-dom-contracts.spec.ts`, `batch-backtest-copy.spec.ts` (parity reference).

## What this proves

A `divergentWindows === false` result means the open position at the latest candle is invariant to simulation origin → continuation parity is a sound assumption for this config → Phase 2 (incremental checkpoints) is worth building. A divergent result blocks Phase 2 for this config and tells you to fix the strategy's path-dependence first. Either way the user gets a clear UI verdict, not a guess.

## Rollback

Stability mode is opt-in (checkbox + separate Run button). Unchecking it leaves the existing coordinator + Phase-1 snapshot behavior 100% unchanged. The `backtestFromSec` worker field is optional and inert when unset. No migration, no data deletion.

## Out of scope (explicitly)

- Incremental checkpoints / continuation state (that IS Phase 2, gated on this feature's result).
- Forward-edge validation of TOP_MEAN NOW (already covered by the historical replay delta).
- Parallelizing windows across tabs (blocked by the single owner-lock by design).
- Any change to the existing historical replay or its `sampleFrom`/`sampleTo` semantics.