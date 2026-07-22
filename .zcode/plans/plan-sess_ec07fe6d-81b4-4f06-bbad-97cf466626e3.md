## Goal

Completely remove Mine Timing and Stability Mine from the Batch Backtest menu. The dirty worktree is the **first half** of an in-progress refactor (HTML partial + DOM contract stripped), but `batch-backtest-service.ts` is left in a broken intermediate state and the entire backend (dedicated modules, server endpoints, stream types, tests, docs) is untouched. Finish the job.

## Verified constraints (must preserve)

- **OPEN_SCORE USD Replay stays** and co-owns: `minerOwner`/`minerAbortController`/`minerOwnerGen`/`minerState` plugin state, `ArtifactStore`/`storeMineArtifact`/`releaseLastResults` TTL machinery, the `.batch-miner-status`/`.batch-stability-controls` CSS classes, `toScalarRow`, and the `signals`/`data` retention in the runner.
- **S&P 500 TOP_MEAN stays** and uses `.batch-miner-status`, `.batch-stability-controls`.
- **Balanced Generator stays** and uses `.batch-miner-status`.
- **Spread-quality / validate-spread-quality stay** and import the shared artifact types.
- **`docs/mine-timing-validation-findings.md` is kept** as a historical record (user decision).

## Decisions (per user answers + best-engineering-judgment)

- **Delete** `scripts/diagnose-mine-prediction.ts` and its `npm run diagnose:mine-prediction` script (user: delete). Also remove the AGENTS.md retention note and the README/docs links that say it's retained.
- **Extract** `BatchSyntheticPairArtifact`, `BatchSyntheticTargetArtifact`, `BatchSyntheticPairContribution`, and `prepareBatchSynthetic{Pair,Target}Artifacts` into a new leaf `lib/batch-backtest/batch-synthetic-artifact.ts` before deleting the miner engine, then repoint all KEEP-side importers (OPEN_SCORE USD engine, sp500-top-mean-coordinator-engine, spread-quality-engine, scripts/validate-spread-quality, compact-pair-artifact adapter if needed). Cleaner than keeping a "miner" file for non-miner data.
- **No rename** of shared infrastructure (`.batch-miner-status` containers, `minerOwner` plugin var). Per AGENTS.md "Surgical Changes" #3 — cosmetic rename would blast OPEN_SCORE USD/CSS/tests for no functional value. Only mine/stability-specific code/state/routes/CSS-row-styles go.

## Plan

### Step 1 — Fix the broken intermediate state first (compile barrier)

`batch-backtest-service.ts` currently references DOM IDs and helpers already removed from the DOM contract. Reconcile before touching anything else.
- Remove all `dom.batchBacktestMineBtn/StabilityMineBtn/CopyMinerBtn/CopyStabilityBtn/AutoRunStability/StabilitySubsetSize/StabilityReruns/StabilitySeed/MinerSummary/MinerResults` references (lines ~379-382, ~447-451, ~2254-2280, ~2398-2412).
- Delete orphaned `clearMinerResults` (the renamed-tail calls a now-deleted helper). Inline the surviving `clearStaleResults` body so it no longer delegates to `clearMinerResults`.
- Verify: `npm run typecheck` should still show only the *remaining* (not-yet-removed) mine/stability errors, not new DOM-contract ones.

### Step 2 — Extract shared artifact leaf

- Create `lib/batch-backtest/batch-synthetic-artifact.ts` containing: `BatchSyntheticPairArtifact`, `BatchSyntheticTargetArtifact`, `BatchSyntheticPairContribution` types, and the `prepareBatchSynthetic{Pair,Target}Artifacts` helpers (moved verbatim from `batch-synthetic-state-miner.ts`).
- Repoint importers: `batch-open-score-usd-replay-engine.ts`, `sp500-top-mean-coordinator-engine.ts`, `lib/spread-quality/spread-quality-engine.ts`, `scripts/validate-spread-quality.ts`. The plugin imports come back empty in Step 5 when the engine is gone.
- Verify: `npm run typecheck` (these are type-only imports).

### Step 3 — Strip `batch-backtest-service.ts` mine/stability surface

Remove methods, state, and module-level format helpers (all mine/stability-specific):
- State: `lastMinerResult`, `lastStabilityResult`, `minerVerdictQueue`, `minerVerdictRafId`.
- Methods: `runMiner`, `runMinerServer`, `runStabilityMine`, `runStabilityMineServer`, `copyMinerResults`, `copyStabilityResults`, `persistMineTimingResult`, `renderStabilityResult`, `createMinerRow`, `createStabilityRow`, `createMinerMetric`, `queueMinerVerdictRender`, `flushMinerVerdictRenderNow`, `cancelMinerVerdictRaf`, `recordMineBenchmark`, `recordStabilityBenchmark`, `mergePhase` (if mine/stability-only).
- Event bindings in `bindEvents` for the removed buttons.
- Module-level format helpers: `formatStabilitySummary/Copy`, `formatMinerSummary/Copy`, `formatStabilityTopPickLine`, `formatMinerRowPipe`, `computeMinerMfeMaeRatio`, `computeMinerInvalidationPrice`, `getMinerVerdictClass`, `getStabilityActionClass`, `StabilityFormatContext`.
- Imports: all mine/stability module imports, `storeMineTimingRun`/`loadMineTimingRunsResult`, `readBatchAutoRunStability`/`writeBatchAutoRunStability`/`shouldAutoRunBatchStability`, benchmark mine/stability phase types, stream event types.
- The persisted-snapshot field `stabilityResult` on the snapshot type and its write/read sites (Step 4 covers the type; service covers its own read/write).
- `updateArtifactActionButtons` keeps the OPEN_SCORE USD gating (`serverHasArtifacts && lastRunFingerprint`) but drops the two mine/stability lines.
- Restore path: drop the `lastStabilityResult` re-render block.

### Step 4 — Stream types + benchmark snapshot + persisted snapshot

- `batch-backtest-stream-types.ts`: delete `BatchMinerStreamEvent`, `BatchStabilityMineStreamEvent`, and the two imports that feed them (lines 107-143). Update doc comments on `serverHasArtifacts`/`fingerprint`/`artifactStats` to say "OPEN_SCORE USD" instead of "Mine". Keep `toScalarRow` (OPEN_SCORE USD consumes artifacts too — but it reads them server-side via the engine's own loader, not via the wire row; keep the strip behavior and the "stay server-side for OPEN_SCORE USD" comment).
- `batch-benchmark-snapshot.ts`: delete `BatchBenchmarkMinePhase`, `BatchBenchmarkStabilityPhase`, the `mine`/`stability` keys on `phases`, `largestMinerSubphase`, `parallelWallEquivalent`, and the stability bottleneck rules. Drop the import from `batch-synthetic-state-miner`. Update schema doc (the `schema` tag stays `batch.benchmark.v2` — a removed optional field does not warrant a bump).
- `batch-backtest-snapshot.ts` (the persisted-results type): drop `stabilityResult?`, `compactStabilityResult`, `compactMinerProfile`, `normalizeStabilityResult`, and the miner/stability type imports.
- `batch-backtest-runner.ts`: drop the comment about Mine Timing being the sole `signals` consumer (line 397) but **keep** `signals` retention and `pruneResultArtifacts` — OPEN_SCORE USD reads `signals`/`data` server-side via the engine. Rewrite the comment to say "retained for server-side analysis consumers (OPEN_SCORE USD Replay)".

### Step 5 — Server plugin (`batch-backtest-vite-plugin.ts`)

Delete mine/stability engine paths only; leave shared OPEN_SCORE USD infrastructure.
- Delete functions: `handleMineRequest`, `handleStabilityMineRequest`, `processMine`, `processStabilityMine`, `loadMinerTargets`, `buildStabilityManifest`, and any mine/stability-only helpers they call.
- Delete HTTP route registrations: `/api/batch-backtest/mine` and `/api/batch-backtest/stability-mine` (lines 2451-2483).
- `handleStopRequest`: remove the `minerWasActive` mine-specific abort branch; **keep** the `minerOwner`/`minerAbortController` reset because OPEN_SCORE USD owns them now (rename the comment to "analysis owner").
- Status handler: drop the `miner: minerState && minerOwner !== NONE` block exposing mine verdicts. Keep `hasArtifacts: hasStoredMineArtifacts()` (the capability flag OPEN_SCORE USD and the Mine-button gate — but the Mine button is gone, so rename to `hasArtifacts` is purely the OPEN_SCORE USD gate now).
- Concurrency guard (line 2630): change "A batch, mine, or TOP_MEAN operation is already running" to drop "mine" (keep the OPEN_SCORE USD/TOP_MEAN/batch owners).
- `processRunBatch.onSymbolComplete`: **keep** `storeMineArtifact(index, result, store)` — OPEN_SCORE USD consumes the same retained artifacts. Update the comment from "Mine artifact" to "server-side analysis artifact".
- `releaseLastResults`, `ArtifactStore`, `sweepOrphanedMineArtifactDirs`, the 10-min TTL: **keep** (OPEN_SCORE USD relies on the retained-artifact capability; per AGENTS.md audit findings F2/F3/F7, removing them regresses the OPEN_SCORE USD path).
- `__testInternals` block: remove mine/stability exports (`setMinerOwnerForTests`, `setMinerAbortControllerForTests`, `setMinerGatesForTests`, `resetMinerGatesForTests`, mine-only hooks); keep OPEN_SCORE USD exports.
- Import line: remove the mine/stability engine + worker imports (39-71); keep `runOpenScoreUsdReplay`.
- Constants `BATCH_MINER_PARALLEL_STABILITY_ENABLED*`, `PARALLEL_STABILITY_MIN_RERUNS`: delete. `MINE_ARTIFACT_DIR_PREFIX`: keep (OPEN_SCORE USD).

### Step 6 — Delete dedicated modules

Delete entirely:
- `lib/batch-backtest/batch-synthetic-state-miner.ts` (engine; artifact types moved out in Step 2)
- `lib/batch-backtest/batch-stability-mine.ts`
- `lib/batch-backtest/batch-stability-worker.ts`
- `lib/batch-backtest/batch-stability-parallel.ts`
- `lib/batch-backtest/batch-miner-index.ts`
- `lib/batch-backtest/mine-timing-persistence.ts`
- `lib/batch-backtest/miner-verdict-format-helpers.ts`
- `lib/batch-backtest/stability-top-pick.ts`
- `lib/batch-backtest/batch-auto-stability-preference.ts`
- `lib/local-sqlite-mine-timing-api.ts`
- `lib/finder/timing-edge-report.ts` (verified: zero external consumers; only its own spec imports it)

### Step 7 — SQLite plugin (`local-sqlite-vite-plugin.ts`)

- Delete the `mine_timing_runs`/`mine_timing_verdicts` CREATE TABLE + indexes (427-477).
- Delete HTTP routes `/store-mine-timing`, `/load-mine-timing`, `/clear-mine-timing` (1130-1167).
- Delete `storeMineTimingRunInDb`, `loadMineTimingRunsFromDb`, `pruneMineTimingRuns`, `normalizeMineTimingVerdictRow`, `TimingEdgePersistedRunShape`, `MINE_TIMING_RUN_RETENTION_COUNT`.
- `__testInternals` block: drop the four mine-timing exports.

### Step 8 — Delete dedicated test files

Delete entirely:
- `tests/batch-synthetic-state-miner.spec.ts`
- `tests/batch-stability-mine.spec.ts`
- `tests/batch-stability-parallel.spec.ts`
- `tests/mine-timing-persistence-contract.spec.ts`
- `tests/miner-verdict-format-helpers.spec.ts`
- `tests/stability-top-pick.spec.ts`
- `tests/timing-edge-report.spec.ts`

### Step 9 — Edit affected tests

- `tests/batch-backtest-service-lifecycle.browser.spec.ts`: the dirty worktree already started this. Finish removing the Stability/Mine `describe` blocks and fake-DOM fields; keep the new OPEN_SCORE USD-after-clear test.
- `tests/batch-backtest-server-plugin.spec.ts`: remove `processMine`/`processStabilityMine`/`processMinePrediction`/`processMineAb` imports + `describe` blocks. If `processMinePrediction`/`processMineAb` are already stale per the inventory, confirm and delete cleanly.
- `tests/local-sqlite-vite-plugin.spec.ts`: remove the `mine_timing_verdicts SQL parity` and `mine_timing retention pruning (Finding 4)` describe blocks.
- `tests/batch-benchmark-snapshot.spec.ts`: remove mine/stability phase assertions.
- `tests/batch-open-score-usd-*.spec.ts`: if they only transitively type-reference the shared artifact types (now from the new leaf), update the import path. No behavior change expected.

### Step 10 — Scripts + package.json

- Delete `scripts/diagnose-mine-prediction.ts`.
- `package.json`: remove the `"diagnose:mine-prediction"` script line. **Do NOT** touch the `mine:1s*` scripts (unrelated second-market miner).

### Step 11 — CSS

`styles/batch-backtest.css`: remove lines 546-663 (`.batch-miner-row`, `.batch-miner-primary`, `.batch-miner-asset`, `.batch-miner-direction`, `.batch-miner-metrics`, `.batch-miner-metric*`, `.batch-miner-reason`, `.batch-miner-row.is-stale`, `.batch-miner-top-pick*`). **Keep** `.batch-miner-status`, `.batch-miner-status--multiline`, `.batch-stability-controls` (shared).

### Step 12 — Docs

- `README.md`: remove Mine Timing/Stability Mine from the Batch description (line 24), the Node artifact write mention (line 170), the docs/batch-backtest-server-side.md Mine-acceleration subnote (line 397), and the link to mine-timing-validation-findings.md (line 404) — the doc stays, but the README link from the feature list goes.
- `docs/README.md`: drop the Mine/Stability and "synthetic-pairs state miner notes" references (lines 14, 17, 22). Keep the mine-timing-validation-findings.md entry since the doc is retained.
- `docs/batch-backtest-server-side.md`: remove the Mine Timing/Stability Mine endpoint table rows, the "Mine Timing on the server" section, and the "Mine / Stability Miner Acceleration" section (lines 7, 12, 18, 64-92, 127-143, 169-178, 184-252). Keep OPEN_SCORE USD docs.
- `AGENTS.md`: heavy edit — remove the "Server-Side Batch Backtest" Mine-button-gating nuance, "Mine Prediction diagnostic", "Portfolio Fit" (already removed note), the Audit Findings that are mine/stability-specific (F2 artifact-write backpressure STAYS because OPEN_SCORE USD needs it — rewrite to remove mine mention; F3 generation-safe cleanup STAYS — OPEN_SCORE USD; F4 disconnect-safe STAYS; F8 worker bundle hash was mine-specific — remove; the "Mine / Stability Miner Acceleration" entire section goes; the Mine/Stability validation habit lines go). Preserve F1/F5/F6/F7/F9 (still relevant to OPEN_SCORE USD / batch / finder).

### Step 13 — Verification

- `npm run typecheck`
- `npm run typecheck:tests`
- `npm run strategies:sync-manifest` (no strategy change — just to confirm manifest is clean)
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-loader-parity.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-replay-engine.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-max-active.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\local-sqlite-vite-plugin.spec.ts`
- `npm run test` (full compact run)

### Out of scope (explicitly NOT touched)

- OPEN_SCORE USD Replay engine, UI, HTTP route, tests.
- S&P 500 TOP_MEAN coordinator (UI, CSS class shares, engine).
- Balanced Generator.
- Spread-quality engine + validate-spread-quality script (only their import path for the extracted artifact types changes).
- Audit findings F1, F5, F6, F7, F9 and the OPEN_SCORE-USD-relevant parts of F2/F3/F4.
- The `mine:1s*` npm scripts (second-market miner, unrelated).
- `docs/mine-timing-validation-findings.md` itself (historical, retained per user).