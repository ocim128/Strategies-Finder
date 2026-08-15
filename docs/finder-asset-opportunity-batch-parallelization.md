# Asset Opportunity Batch Holdout Parallelization Plan

Status: Implemented (2026-08-14) · Branch: `chore/complexity-reduction` · Scope: server-side Finder Asset Opportunity **batch OOS holdout** runs only.

## Problem

`POST /api/finder/asset-opportunity-batch-run` executes the validated holdout
sweep **sequentially on the single Vite dev-server thread**:

- `processFinderAssetOpportunityBatchRun` (`lib/finder/server/finder-vite-plugin.ts:1770`) loops holdout values ascending, one at a time (up to `MAX_FINDER_ASSET_OOS_BATCH_VALUES = 100` values).
- Each iteration (`runAssetOpportunityIteration`, same file, line 1032) loops assets sequentially; only dataset *loading* is prefetched (`ASSET_OPPORTUNITY_DATA_LOAD_CONCURRENCY = 12`).
- Each asset × strategy pass runs `runServerAssetIsSearch` (`lib/finder/server/server-asset-is-search.ts`), evaluating up to `maxRuns` candidate backtests one by one.

All CPU work — signal generation plus TypeScript-engine simulation — is
serialized on one thread. The only concurrency today is I/O. On a 24-core /
64 GB host, one core does the work while 23 idle.

## Key Enabling Fact

Holdout iterations are **embarrassingly parallel by design**. The batch loop
clones options per holdout value and deliberately keeps the same random seed
("Keep the same random seed so differences come from the holdout boundary, not
a new sample" — `processFinderAssetOpportunityBatchRun`). Per-asset seeding is
derived from `(runSeed, canonicalSymbol)` (`deriveAssetSeed`), never from
iteration order. The only cross-iteration state is
`assetLoadContext` (`createServerFinderAssetOpportunityLoadContext()`), which
is a pure dataset **cache**. Therefore each holdout value can execute
independently, in any order, and produce identical results.

## Proposed Design

A **bounded worker-thread pool** (modeled on the existing
`lib/batch-backtest/sp500-top-mean-worker-pool.ts` pattern) where each task =
one holdout value's full asset × strategy sweep.

- **Partition by holdout value, not by asset.** Each worker runs the existing
  `runAssetOpportunityIteration` unchanged for its assigned holdouts and keeps
  its own `assetLoadContext` alive across them (the same cache reuse the
  sequential loop gets today, per worker).
- **Main thread stays the single writer** for archives, stream events, the
  `/status` snapshot, and the JSONL run log. Workers return completed
  iteration payloads; the coordinator buffers out-of-order completions and
  releases them **in ascending holdout order**, so archive blocks,
  `asset_batch_iteration_done` events, and the terminal snapshot are identical
  to today's sequence — just produced sooner.
- **Bounded pool, not one worker per value.** Each worker holds its own copy
  of every symbol dataset (~5–10 MB/symbol at the 100k-bar cap). Worker count
  is `min(holdoutCount, cores − 2, memoryCeiling)` with an env override (see
  Worker Count Policy).
- **Fallback/rollback:** `FINDER_ASSET_BATCH_WORKERS=1` keeps the current
  sequential in-process loop verbatim. The sequential path is retained in the
  code, not deleted.

Expected speedup with the TypeScript engine: near-linear in worker count for
the IS candidate sweep (the dominant phase per `timingsMs.inSampleSearch` /
`candidateBacktests` diagnostics) — realistically ~10–15× end-to-end on a
24-core host. With the Rust engine enabled, see
[Rust Engine Caveat](#rust-engine-caveat).

## Architecture and Data Flow

### Current (sequential)

```
Browser POST /api/finder/asset-opportunity-batch-run
  → handleAssetOpportunityBatchRunRequest (finder-vite-plugin.ts:2378)
    → processFinderAssetOpportunityBatchRun
        for holdout in [start..end]:            // ascending, awaited
          runAssetOpportunityIteration(...)     // main thread, one core
          appendAssetOpportunityArchiveBlock(...)  // per sort metric
          writer(asset_batch_iteration_done)
        writer(asset_batch_done)
```

### Proposed (parallel)

```
Browser POST /api/finder/asset-opportunity-batch-run   (unchanged)
  → handleAssetOpportunityBatchRunRequest              (unchanged)
    → processFinderAssetOpportunityBatchRun
        ├─ workerCount ≤ 1 → existing sequential loop (unchanged)
        └─ workerCount > 1 → batch worker pool coordinator
              ├─ spawn W workers (esbuild-bundled script, mtime-cached)
              ├─ dynamic task queue: next free worker takes next holdout value
              ├─ workers post: progress / run_log / iteration_complete / iteration_fatal
              ├─ coordinator buffers completions by iterationIndex
              ├─ emits in ascending order:
              │    appendAssetOpportunityArchiveBlock(...)   (main thread, as today)
              │    writer(asset_batch_iteration_done)        (main thread, as today)
              └─ on Stop/abort → post stop to all workers → snapshot cancelled
```

### Worker task payload (main → worker)

Only structured-clone-safe data crosses the boundary. Strategy **objects do
not cross** (`FinderSelectedStrategy.strategy` carries functions); the worker
resolves them from keys, exactly as the top-mean worker resolves strategies
from `lib/strategies/library`:

```ts
interface AssetOpportunityBatchWorkerTask {
    taskIndex: number;          // iterationIndex into holdoutValues
    holdoutBars: number;
    runId: string;
    interval: string;
    symbols: string[];
    options: FinderOptions;     // pre-cloned with assetOpportunity.oosIgnoreLastBars = holdoutBars
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    strategyKeys: string[];
    exitStrategyKeys: string[];
    useRustEnginePreference: boolean;
    providerBySymbol: Record<string, string>;  // plain object form of the Map
    candidatePoolSize: number;
    minFreshSupport: number;
}
```

### Worker messages (worker → main)

```ts
type AssetOpportunityBatchWorkerMessage =
    | { type: "progress"; taskIndex: number; percent: number; status: string; phase: string }
    | { type: "run_log"; event: string; payload: Record<string, unknown> }  // routed to buildFinderRunLogSink on main
    | { type: "iteration_complete"; taskIndex: number; holdoutBars: number;
        results: FinderAssetOpportunityResult[];     // already scalar (toScalarAssetResult)
        totals: FinderAssetOpportunityTotals;
        assetDiagnostics: FinderAssetOpportunityDiagnostics;
        cancelled: boolean }
    | { type: "iteration_fatal"; taskIndex: number; holdoutBars: number; error: string };
```

The scalar-only rule already enforced by `toScalarAssetResult` +
`assertAssetResultIsScalar` guarantees `iteration_complete` payloads are
structured-clone-safe by construction.

### Worker internals

The worker entry (`lib/finder/server/finder-asset-opportunity-batch-worker.ts`)
is a thin adapter:

1. Resolve strategies by key via `loadBuiltInStrategyByKey` (same call the
   plugin's `resolveSelectedStrategies` uses; registers into the worker's own
   per-isolate `strategyRegistry`, mirroring `sp500-top-mean-worker.ts`).
2. Construct its own `FinderParamSpace` (deterministic — seeded by
   `options.randomSeed`, same as the plugin's module-scope instance).
3. Create one long-lived `createServerFinderAssetOpportunityLoadContext()`
   and reuse it across tasks.
4. For each task, call `runAssetOpportunityIteration` with:
   - `loadDataset: loadServerFinderDataset` (worker isolate gets its own
     `DataFetcher`/loader core — the same leaf `server-finder-data-loader.ts`
     already uses per-process singletons)
   - `generateParamSets` bound to its own `FinderParamSpace`
   - `runLog` that posts `run_log` messages to the parent
   - `isCancelled` observing a local stop flag set by a parent `stop` message
     (the iteration already checks `isCancelled` between assets and the IS
     search checks it between candidates — no new cancellation points needed)
5. Post `iteration_complete` / `iteration_fatal`.

## Affected Files / Modules

| File | Change |
|---|---|
| `lib/finder/server/asset-opportunity-iteration.ts` | **New.** Verbatim move of `runAssetOpportunityIteration`, `FinderAssetOpportunityRunInput`, `AssetOpportunityIterationResult`/`Callbacks` types out of the plugin (the one prerequisite refactor — see Phase 0). |
| `lib/finder/server/finder-asset-opportunity-batch-worker.ts` | **New.** Worker entry (task protocol above). |
| `lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts` | **New.** Coordinator: worker count resolution, worker script path + esbuild bundle cache, dynamic task queue, ordered emission buffer, stop propagation, crash handling. |
| `lib/finder/server/finder-vite-plugin.ts` | **Modified.** Re-export moved symbols (keeps `tests/finder-server-plugin.spec.ts` imports working); `processFinderAssetOpportunityBatchRun` delegates to the pool when resolved worker count > 1. Loop body (archive + `asset_batch_iteration_done` + snapshot bookkeeping) stays in the plugin and is invoked per ordered completion. |
| `tests/finder-asset-opportunity-batch-parallel.spec.ts` | **New.** See Validation. |
| `docs/finder-server-side.md`, `README.md`, `AGENTS.md` | **Modified.** Document the env override, worker-count policy, heap guidance, and the new invariant (workers never write archives/events directly). |

No UI, partial, settings-schema, or browser-side changes. No changes to
`runAssetOpportunityIteration`'s semantics, `runAssetOpportunitySearch`,
`server-asset-is-search.ts`, or the archive module.

## Contracts Preserved (and How)

- **Stream events** (`asset_batch_start`, `asset_batch_progress`,
  `asset_batch_iteration_done`, `asset_batch_fatal`, `asset_batch_done`):
  schema unchanged. `iteration_done` fires in ascending holdout order. With
  several iterations in flight, `asset_batch_progress` events interleave —
  the event already carries `holdoutBars` + `iterationIndex`, and the browser
  renders the latest arrival; no consumer change expected (verify in manual
  smoke).
- **Archive**: `appendAssetOpportunityArchiveBlock` is called only from the
  main thread, in ascending order, one file per holdout value — byte-identical
  blocks to a sequential run (same seeds → same sorted rows).
- **`/status` reattach**: `runState` stays main-thread; the coordinator
  aggregates progress (`progressPercent` = mean of per-iteration percents;
  `batch.currentHoldoutBars` = smallest in-flight holdout) so the existing
  snapshot shape is untouched.
- **Stop (runId-scoped)**: ownership and `pendingStopRunId` stay on the main
  thread. On lost ownership/abort, the coordinator posts `stop` to every
  worker, awaits their exit, and marks the snapshot cancelled — same terminal
  `asset_batch_done` as today.
- **JSONL run log**: workers route `iteration_start` / `asset_complete` /
  `asset_failed` / `iteration_complete` events to the main-thread
  `buildFinderRunLogSink`, preserving the single
  `archive/finder-runs/<runId>.jsonl` file (no concurrent appends).
- **Loopback authorization (audit F1)**: unchanged — routes are already
  gated; workers are process-internal and never expose endpoints.
- **Determinism**: per-iteration inputs are identical to the sequential run;
  only wall-clock timing diagnostics (`timingsMs`, `durationMs`) differ.

## Worker Count Policy

Resolution order (`resolveAssetOpportunityBatchWorkerCount` in the pool
module):

1. `FINDER_ASSET_BATCH_WORKERS` env override (`1` = sequential in-process
   path; `N > 1` = exactly N workers) — also the rollback lever.
2. Otherwise: `max(1, min(holdoutCount, availableParallelism() - 2, memoryCeiling))`
   where `memoryCeiling = floor(48 GB / (symbolCount × 9 MB))` — an estimate
   at ~9 MB/symbol for a 100k-bar dataset plus per-worker cache overhead.

Indicative values: 200 symbols → core-capped (≈22 on a 24-core host);
400 symbols → ≈13; 1000 symbols → ≈5. `--max-old-space-size` applies
per-isolate, so keep the existing `NODE_OPTIONS=--max-old-space-size=16384`
recommendation; the memory ceiling bounds the *sum* of worker footprints.

## Rust Engine Caveat

When `useRustEnginePreference` is on, backtests are simulated by the external
Rust HTTP server (`lib/rust-engine-client.ts`, `127.0.0.1:3030`). Worker
threads still parallelize signal generation and TS fallback, but:

- The Rust server becomes the serialization point if it is itself
  single-threaded.
- Each worker isolate runs its own `rustEngine` client whose dataset cache
  holds only 4 entries (`maxCachedDataEntries`) and posts full OHLCV payloads
  per request — many workers may thrash it.

Mitigation: the worker-count policy now enforces this automatically — when
`useRustEnginePreference` is on, the AUTO worker count is clamped at
`ASSET_OPPORTUNITY_BATCH_RUST_WORKER_CAP` (8) in
`resolveAssetOpportunityBatchWorkerCount`; the `FINDER_ASSET_BATCH_WORKERS`
override remains the operator's judgment call and still wins. Changing the
Rust client itself stays out of scope (measure first).

## Import Hygiene (Vite Config Bundle Trap)

All new server modules must follow the documented leaf-only rule
(AGENTS.md § Server-Side Batch / Finder):

- The worker imports only: the moved iteration leaf,
  `server-finder-data-loader.ts`, `loadBuiltInStrategyByKey` (manifest
  loaders), `FinderParamSpace`, and leaf types. It must NOT import
  `finder-vite-plugin.ts`, `finder-manager.ts`, `data-manager.ts`,
  `settings-manager.ts`, or anything transitively reaching
  `lib/constants.ts` / `lib/chart-manager.ts` (`lightweight-charts`, ESM-only).
- The coordinator is imported by the plugin (already inside the config
  bundle) and must itself import only leaves + `node:worker_threads`.
- `tests/vite-config-bundle.spec.ts` guards this invariant and must stay green.

The worker script is bundled to CJS with esbuild at first use, mtime+size
cached — copy the proven `resolveTopMeanWorkerPath` /
`bundleWorkerWithEsbuild` pattern from `sp500-top-mean-worker-pool.ts:31-116`
(duplicate the ~80 lines locally rather than refactoring the batch-backtest
surface).

## Error Handling

- **Iteration throws** (worker posts `iteration_fatal`): identical to today's
  per-iteration failure — `asset_batch_fatal`, snapshot `phase: "fatal"`,
  previously archived blocks stay intact, remaining workers are stopped.
- **Worker crashes** (non-zero `exit`, `error` event): treated as
  `iteration_fatal` for its in-flight task; buffered completed iterations
  with lower indexes still flush in order first.
- **Archive write fails**: existing semantics — fatal, completed blocks
  intact (the ordered emission keeps this check on the main thread).
- **Message-clone failure** of an `iteration_complete` payload: surfaces as
  `iteration_fatal` (the scalar assertion should make this unreachable; fail
  loud rather than silently dropping an iteration).
- **Stop before all workers spawn**: coordinator checks `isCancelled` between
  spawns; unspawned tasks are simply never started.

## Security

No new routes, ports, or filesystem locations. Workers inherit the dev-server
process identity and only read the existing local data surfaces
(`price-data/`, local `/api/sqlite/...` via `fetchLocalApi` resolution) and
write nothing except through main-thread sinks. F1 loopback gating on the
batch route is unchanged.

## Rollback

`FINDER_ASSET_BATCH_WORKERS=1` (or a machine with 1 core) falls back to the
retained sequential loop with zero behavioral delta. Git revert of the
coordinator wiring restores the pre-change loop; the Phase 0 leaf extraction
is behavior-neutral on its own.

## Implementation Phases

### Phase 0 — Extract the iteration leaf

- **Objective:** Make `runAssetOpportunityIteration` + its input/output types
  importable by a worker without importing the plugin module (which owns
  `runState`/route registration).
- **Tasks:**
  1. Move `runAssetOpportunityIteration`, `FinderAssetOpportunityRunInput`,
     `AssetOpportunityIterationResult`, `AssetOpportunityIterationCallbacks`
     and their private helpers verbatim from `finder-vite-plugin.ts` into the
     new `lib/finder/server/asset-opportunity-iteration.ts`.
  2. Replace the plugin's direct `paramSpace` capture inside the moved code
     with the input's `generateParamSets` (the plugin passes its module-scope
     `paramSpace.generateParamSets` bound at the call site).
  3. Re-export the moved symbols from `finder-vite-plugin.ts` so existing
     spec imports keep working.
- **Dependencies:** none.
- **Risks / blockers:** none known; pure move. The moved code currently
  references only its inputs plus leaf imports (verified during exploration).
- **Deliverables:** `lib/finder/server/asset-opportunity-iteration.ts`;
  slimmed plugin re-exports.
- **Validation / testing:** `npm run typecheck`; `npm run typecheck:tests`;
  `esno tests/finder-server-plugin.spec.ts` (exercises the batch path);
  `esno tests/finder-server-loader-parity.spec.ts`.
- **Exit criteria:** all above green; `git diff` of the moved function is a
  verbatim relocation (modulo the `generateParamSets` thread-through).

### Phase 1 — Worker entry and task protocol

- **Objective:** One holdout iteration can execute correctly inside a
  `worker_threads` Worker.
- **Tasks:**
  1. Create `finder-asset-opportunity-batch-worker.ts` implementing the task
     and message protocol above (strategy resolution, own `FinderParamSpace`,
     long-lived `assetLoadContext`, `loadServerFinderDataset` wiring,
     stop-flag `isCancelled`, `run_log` forwarding, `iteration_complete` /
     `iteration_fatal` posts).
  2. Reuse the esbuild-bundle-with-mtime-cache worker script resolution
     pattern from `sp500-top-mean-worker-pool.ts`.
- **Dependencies:** Phase 0.
- **Risks / blockers:**
  - Unknown: whether any strategy in the eager manifest misbehaves when
    instantiated in a fresh isolate (registry side effects). Mitigation:
    Phase 1 validation runs the real manifest strategies on a small symbol
    set in a spawned worker.
  - `fetchLocalApi` inside workers must resolve `127.0.0.1:5173` — Node
    `fetch` works in workers; verify once in the harness.
- **Deliverables:** worker module; a minimal single-worker harness exercised
  by the new spec (see Phase 2 for the hermetic seam).
- **Validation / testing:** new spec case: run one real holdout task in a
  real Worker with the IBKR/CSV-backed loader on 2–3 symbols; assert the
  returned `results` equal the sequential leaf's for the same inputs.
- **Exit criteria:** worker-produced iteration output is deep-equal to the
  in-process leaf output for identical inputs.

### Phase 2 — Coordinator pool, ordering, stop, crash

- **Objective:** Full parallel batch run with today's external behavior
  (events, archive, snapshot, Stop) preserved exactly.
- **Tasks:**
  1. Create `finder-asset-opportunity-batch-worker-pool.ts`: worker count
     resolution, dynamic task queue, ordered-completion buffer, per-iteration
     progress forwarding (aggregated onto the snapshot), stop broadcast +
     drain, crash → fatal mapping, and a `createTaskRunner` injection seam so
     tests can substitute an in-process fake that calls the Phase 0 leaf
     directly (no real threads / file loads in unit tests).
  2. Rewire `processFinderAssetOpportunityBatchRun`: resolve worker count;
     if > 1, drive the existing per-iteration tail (archive sorts,
     `asset_batch_iteration_done`, snapshot bookkeeping, terminal
     `asset_batch_done`) from the coordinator's ordered completion stream.
     The sequential loop remains for count ≤ 1.
- **Dependencies:** Phases 0–1.
- **Risks / blockers:**
  - Interleaved `asset_batch_progress` text in the browser UI (schema
    unchanged; several in-flight iterations). Acceptable: latest-event
    rendering. Confirm during manual smoke; no code change anticipated.
  - Tail imbalance: holdout iterations have near-uniform cost (the IS sweep
    dominates; the holdout only trims the visible window), so the dynamic
    queue self-balances.
- **Deliverables:** pool module; rewired batch processor.
- **Validation / testing:** `tests/finder-asset-opportunity-batch-parallel.spec.ts`:
  - W=1 (sequential path) vs pool with fake runner → identical ordered
    `iteration_done` sequence, archive append order, and terminal snapshot.
  - fake runner completes tasks out of order → assertions prove ascending
    emission and archive order.
  - mid-run Stop → workers signalled, snapshot `cancelled`, terminal event
    `ok: false` with `completedIterations` reflecting flushed iterations only.
  - fake runner throws / "crashes" one task → `asset_batch_fatal`, earlier
    archived iterations intact.
  - worker count resolution unit tests (env override, holdout/cores/memory
    clamps).
- **Exit criteria:** all new spec cases green; existing
  `finder-server-plugin.spec.ts` batch suites green unchanged.

### Phase 3 — Policy, docs, and performance validation

- **Objective:** Ship sane defaults, documented knobs, and measured speedup.
- **Tasks:**
  1. Implement the env override + `memoryCeiling` formula in the pool.
  2. Update `docs/finder-server-side.md` (batch parallelism section: pool
     semantics, env override, Rust-engine worker-count recommendation),
     `README.md` (heap guidance for parallel batches), and `AGENTS.md`
     (safe-change note: workers never write archives/events directly;
     sequential path must stay as rollback).
  3. Manual smoke on the target host: `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`;
     one small batch (e.g. 10 symbols, holdouts 10–20) then a large one
     (e.g. 200+ symbols, 41 holdouts). Confirm progress scaling, Stop,
     reload-reattach mid-run, ascending archive files, and record wall-clock
     vs a `FINDER_ASSET_BATCH_WORKERS=1` baseline.
- **Dependencies:** Phase 2.
- **Risks / blockers:** none technical; the perf measurement may reveal the
  Rust-server bottleneck (see Rust Engine Caveat) — in that case record the
  recommendation rather than changing the Rust client.
- **Deliverables:** env knob; docs updates; measured before/after numbers in
  this document's Post-implementation notes.
- **Validation / testing:** full validation habit from AGENTS.md
  (Server-Owned Finder section) plus the manual smoke above.
- **Exit criteria:** large batch completes with expected worker-count scaling
  and zero contract drift (archive diff vs sequential baseline is empty for
  identical inputs modulo timing diagnostics).

## Assumptions and Unknowns

- **Assumed:** the user's runs use the TypeScript engine (near-linear
  speedup). If Rust is enabled, gains are bounded by the Rust server's own
  threading — to be measured, not assumed (Phase 3).
- **Assumed:** all strategy libraries are safe to instantiate in a fresh
    isolate (no shared-module singletons beyond the registry). The manifest
  loader pattern is already exercised server-side; Phase 1 validates on real
  strategies.
- **Unknown:** exact per-symbol memory at the user's typical interval — the
  9 MB/symbol ceiling is an estimate from AGENTS.md's 5–10 MB range; the env
  override absorbs mis-estimates.
- **Out of scope:** parallelizing the single (non-batch) Asset Opportunity
  run (candidate follow-up: asset-shard workers), the Symbol Universe runner,
  the Rust engine client's dataset cache, and any prefix-reuse algorithm
  (evaluating each candidate once and deriving per-holdout metrics) — the
  latter would be a larger semantic change and is deliberately rejected for
  this plan.

## Post-implementation Notes

Implemented 2026-08-14. Delivered files match the plan, with these recorded
deviations and results:

- **Delivered**: `lib/finder/server/asset-opportunity-iteration.ts` (Phase 0
  verbatim extraction + optional `generateParamSets` input override; the leaf
  owns its own stateless `FinderParamSpace` so behavior is identical),
  `lib/finder/server/finder-asset-opportunity-batch-worker.ts` (worker entry;
  the task core `runAssetOpportunityBatchWorkerTask` is exported for
  in-process testing),
  `lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts`
  (coordinator + worker-count policy + esbuild-bundled worker script),
  `tests/finder-asset-opportunity-batch-parallel.spec.ts` (6 cases:
  worker-count policy, sequential-vs-parallel parity, ascending ordering
  under out-of-order completion, fatal isolation, Stop flush, sequential
  fallback).
- **Deviation from plan**: instead of the parallel path being the default for
  every caller of `processFinderAssetOpportunityBatchRun`, it activates via
  an optional `batchTaskRunnerFactory` input field wired by the production
  HTTP handler (`createRealWorkerAssetOpportunityBatchRunner`). Direct
  callers without the field (the existing plugin spec's stub-loader tests)
  keep the sequential in-process loop — this made the existing batch suites
  pass unchanged. `FINDER_ASSET_BATCH_WORKERS=1` remains the rollback lever.
- **Verified**: `npm run typecheck` + `npm run typecheck:tests` clean;
  `finder-server-plugin.spec.ts` 65/65 unchanged; new parallel spec 6/6;
  `vite-config-bundle.spec.ts` green (leaf-only import hygiene holds);
  real-worker smoke (`artifacts/smoke-batch-parallel-worker.ts`, gitignored)
  swept AAPL• 30m over holdouts 10/15/20 through 3 real workers with local
  IBKR CSV loads, ordered emission, and run-log routing.
- **Not yet measured**: full-scale before/after wall-clock on the target
  host (manual smoke with a `FINDER_ASSET_BATCH_WORKERS=1` baseline is
  documented in `docs/finder-server-side.md` § Validation).

### Post-audit fixes (2026-08-14, first-run review)

Two audit findings were accepted and fixed after the first production run:

1. **Memory-aware worker budget** (high): the auto path's memory ceiling now
   budgets 75% of ACTUAL system RAM (`os.totalmem()`, injectable via a
   function parameter for deterministic tests) instead of a fixed 48 GB, so
   a 16 GB host auto-selects ~1 worker for a 1,000-symbol run instead of 5.
   The explicit `FINDER_ASSET_BATCH_WORKERS` override still bypasses the
   ceiling by design (rollback/diagnostic lever) — an override that cannot
   override would defeat its purpose — and stays capped at 32.
2. **`/status` snapshot counters** (medium): worker progress messages now
   carry `loadedSymbols`/`failedSymbols`/`strategyIndex`, and the plugin's
   parallel `onProgress` mirrors them onto the snapshot
   (latest-writer-wins across in-flight iterations). Previously `/status`
   reported zeros for those fields during and after a parallel batch while
   `assetDiagnostics` held the correct counts. Locked by a regression
   assertion in the parity test.
