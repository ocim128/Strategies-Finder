# Server-Owned Finder Jobs

Finder Symbol Universe is a **server-owned job**: the Vite server process owns
the complete lifecycle for every selected entry strategy — IS evaluation,
survivor merge, optional OOS validation, diagnostics combination, and the
authoritative terminal candidate slice. The browser is the control and
rendering layer and can reattach to an in-flight or completed job after a tab
reload. Current-chart Finder remains browser-side.

## Asset Opportunity

Asset Opportunity uses the same server owner, run id, Stop route, and reload
reattach path as Symbol Universe, but evaluates one symbol at a time. The
browser receives only scalar opportunity rows; the terminal slice is bounded
by the existing Finder `topN` control. With no fixed holdout, each asset
reserves its latest closed candle for fresh-entry detection and searches
historical candidates without that candle. With a fixed holdout, the visible
prefix is used for both candidate search and the boundary signal, while the
final N candles remain hidden for validation.

Asset Opportunity can reserve the last N historical bars as a fixed OOS
holdout. In that mode, candidate ranking and the Finder data slice use only
the visible prefix, the signal is generated at its latest visible modeled fill boundary
(the preceding candle for `next_open`/`next_close`), and the hidden bars validate that one boundary prediction. Its signed
close-to-entry forward PnL is reported at three horizons (default `1,3,5`),
with horizon 1 targeting the first hidden candle. The setting is disabled when
N is `0`, which retains the normal latest-closed-candle opportunity behavior.

The server caps a run at 1,000 symbols. It records an estimated candidate-work
count as a diagnostic, but does not reject a run based on that estimate. The
server requires random Finder mode and clamps the candidate pool to
1–50. The symbol and heap guards protect process stability; they do not
change the Current Chart or Symbol Universe limits.

Asset runs emit bounded debug events named
`finder.asset_opportunity.start`, `finder.asset_opportunity.asset.complete`,
`finder.asset_opportunity.run.complete`, `finder.asset_opportunity.run.cancelled`,
and `finder.asset_opportunity.run.failed`. Event payloads contain counts,
grades, symbols, timings, and errors only—never candles, signals, or trades.

## Asset Opportunity Batch

Batch mode sweeps an inclusive holdout range in **one server-owned job** under
a single `runId`. The browser enables it with the `Batch OOS Holdout` toggle
in the Asset Opportunity settings (which hides and disables the single
`OOS Holdout Bars` input) and sends
`POST /api/finder/asset-opportunity-batch-run` with the same fields as the
single route plus `batch: { startHoldoutBars, endHoldoutBars }`. The server
validates the range **before acquiring ownership**: positive integers,
ascending (`start <= end`), each at most 100,000, and at most 1000 values
(`normalizeFinderAssetOosBatchHoldoutRange` in
`lib/finder/finder-asset-opportunity-oos.ts`).

The batch archive always writes the default block plus every Asset Opportunity
Re-Sort metric. For each holdout N, those rankings are appended as separate
delimited blocks in the same `oos-holdout-<N>-bars.txt` file. The `finderResort`
control only changes the displayed Asset Opportunity rows after a run; it does
not affect archive output.

The browser displays and persists one representative row per normalized pair
symbol. Server iteration results and archive blocks remain strategy-level so
the archived evidence can still show which strategy libraries contributed to a
pair.

The batch coordinator (`processFinderAssetOpportunityBatchRun` in
`lib/finder/server/finder-vite-plugin.ts`) drives the range in ascending order
and calls the same per-asset iteration seam as the single route
(`runAssetOpportunityIteration`, extracted unchanged into
`lib/finder/server/asset-opportunity-iteration.ts`), cloning the options
with `oosIgnoreLastBars` set to the current N. The random seed is preserved
across iterations so differences come from the holdout boundary, not a new
sample. After each iteration it appends a compact performance-only top-N
payload (built by `buildAssetOpportunityPerformancePayload` in
`lib/finder/finder-asset-opportunity-metadata.ts`) to
`<server.config.root>/archive/asset opportunity/oos-holdout-<N>-bars.txt`
(`appendAssetOpportunityArchiveBlock` in
`lib/finder/server/finder-asset-opportunity-archive.ts`). Re-running the same
N appends a new delimited block; it never overwrites or deduplicates prior
research. The filename is derived only from the validated integer N — a
request can never supply a filesystem path. Each block records the selected
metric as `Archive sort: <metric>` (`run_default` for the normal run order),
which makes repeated appends with different rankings auditable. The archive
JSON is compact and contains only row identity plus selection/OOS performance
metrics and forward OOS performance. New blocks also include a stable
`candidateFingerprint`, the latest signal-candle hour in UTC and Asia/Jakarta,
and an all-candidate forward-OOS baseline captured before the top-N slice.
Older blocks remain readable but cannot answer fingerprint, baseline, or
signal-hour questions. Manual Copy Top Results remains the full metadata
payload; automatic archives omit params, strategy metadata, support, trades,
equity curves, and exit details.

The archive can be analyzed with
`archive/asset opportunity/analyze-asset-opportunity-holdouts.bat` (or
`scripts/analyze-asset-opportunity-holdouts.ts`). The analyzer reads only
matching files directly inside the selected archive directory, never nested
subfolders. It reports strategy-library contribution, a descriptive
worst-strategy removal counterfactual across forward horizons, and best/worst
signal-candle hours. The removal section excludes archived rows; it does not
rerun Finder or simulate capital, position sizing, or trade overlap.

Only the current iteration's full scalar rows are retained (for re-sort and
the terminal view); prior iterations' rows are never held in memory or sent
again. The terminal status snapshot carries the LAST completed iteration's
rows on `terminalAssets` plus bounded batch counts on `batch`:

```text
batch: {
  startHoldoutBars, endHoldoutBars, currentHoldoutBars,
  currentIteration, totalIterations, completedIterations, failedIterations
}
```

Batch stream events (`FinderAssetOpportunityBatchStreamEvent`):

| Event | Purpose |
| --- | --- |
| `asset_batch_start` | Declares the validated range, iteration/asset totals, strategy names, and the fixed `All Sorts` archive mode (`archiveSort`). |
| `asset_batch_progress` | Overall job percent plus in-iteration asset progress, current holdout, phase, and status text. |
| `asset_batch_iteration_done` | Full scalar rows for THIS holdout only, current diagnostics/totals, and the archive filename (including empty-result blocks). |
| `asset_batch_done` | Completed/failed holdout counts, last successfully archived iteration rows, holdout, totals, diagnostics, and summary. |
| `asset_batch_fatal` | Terminal error, current holdout, completed count — also used for archive write failures. |

Stop aborts the active iteration and prevents the next from starting; a
stopped batch reports partial completion and keeps already-appended blocks
intact. If the archive append fails, the batch stops with a visible fatal
(error prefixed `Archive write failed for holdout N`). Stream disconnect does
not cancel the job; reload reattach polls the same scoped status endpoint and
recovers the batch counts plus the last completed iteration.

### Parallel holdout sweep (worker pool)

The production batch route runs the holdout iterations across a bounded pool
of `worker_threads` (`lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts`).
Large ranges use one holdout value per task because iterations are independent
by design (same seed; only the holdout boundary differs). When a small range
would underfill the pool, each holdout is split into contiguous asset chunks;
the main thread merges those chunks back into one iteration before archiving.
The main thread stays the single writer: completed iterations are buffered and
released in **ascending holdout order**, so archive blocks,
`asset_batch_iteration_done` events, and the terminal snapshot remain
sequential-parity outputs. Workers re-resolve strategies by key — strategy
objects never cross the worker boundary — and iteration payloads are the
already-scalar rows enforced by `toScalarAssetResult`.

Worker count: `min(task count, logical cores − 2, memory ceiling)` where
the ceiling estimates one full dataset copy per worker (~9 MB/symbol) against
75% of **actual system RAM** (`os.totalmem()` — 48 GB on a 64 GB
host, 12 GB on a 16 GB host, so small hosts auto-select proportionally fewer
workers). `FINDER_ASSET_BATCH_WORKERS=<N>` overrides outright — `1`
forces the sequential in-process loop (the rollback lever); the override
intentionally bypasses the memory ceiling (operator judgment) but is capped
at 32. Each worker holds its own copy of every symbol dataset, so large
symbol lists reduce the worker count automatically. For chunked tasks the
memory estimate uses the partition size, allowing the pool to use more CPU
without budgeting a full-universe copy per worker. Chunked tasks carry only
their symbol partition and stay affinity-pinned to one worker across holdouts,
so the total retained dataset budget stays bounded by the same policy while
synthetic leg/pair caches are reused. Large holdout ranges still use one
whole-holdout task per worker. When Rust is actually eligible, the external
Rust server becomes the serialization point and
posts full OHLCV payloads per request — the AUTO worker count is therefore
clamped at 8 (`ASSET_OPPORTUNITY_BATCH_RUST_WORKER_CAP`); a Rust preference
alone does not apply that cap when the settings force TypeScript. Set
`FINDER_ASSET_BATCH_WORKERS` explicitly only when you have measured a
better value.

Dataset reuse: the batch load context carries a run-scoped plain-dataset LRU
(`BatchDatasetLoadContext.datasetCache`) sized by
`resolveAssetOpportunityDatasetCacheCapacity` with the same 75%-RAM/9MB
budget, so every plain symbol loads ONCE per worker (or once for a whole
sequential sweep) instead of once per holdout iteration. Synthetic pairs are
excluded (their `pairCache` already retains them), and failed or empty loads
are never cached — they stay retryable. Iteration `iteration_complete`
run-log lines carry `datasetCacheHits`/`datasetCacheMisses`, and the
`timingsMs.dataLoading` diagnostic shows the corresponding drop after the
first iteration.

The same worker also keeps a bounded full-series signal cache for repeated
holdout prefixes. It is used only when the search uses the complete data slice,
has no `evalLastBars` or exit-strategy override, and has strategy timeframes
disabled; these are the conditions under which indexed signals can be filtered
to a shorter prefix without changing their meaning. The first eligible
candidate pays a signal-only warm pass, while later holdouts reuse the cached
signals and still run their normal trade simulation. The cache is worker-local
and bounded to 8,192 strategy/parameter entries. Asset diagnostics expose
`work.signalCacheHits` and `work.signalCacheMisses` so a run can verify the
reuse rate; a zero hit count is expected for unsupported strategy signal shapes
or ineligible option combinations.

Failure semantics match the sequential loop: a fatal iteration stops the
sweep with `asset_batch_fatal` while iterations before the failed index
complete and archive normally (their runners are allowed to finish);
iterations after it are aborted and never emit. On Stop, in-flight
iterations are discarded and the ones that already completed flush
ascending. A worker crash (non-zero exit or mid-task disappearance) maps to
the same fatal path, and per-asset `run_log` events route through the main
thread so `archive/finder-runs/<runId>.jsonl` stays a single file.

Batch debug events: `finder.asset_opportunity_batch.start`,
`finder.asset_opportunity_batch.iteration.complete`,
`finder.asset_opportunity_batch.iteration_failed`,
`finder.asset_opportunity_batch.archive_failed`,
`finder.asset_opportunity_batch.cancelled`, and
`finder.asset_opportunity_batch.complete` — counts, N, filenames, byte
counts, timings, and errors only.

## Browser-owned Finder modes

Current-chart Finder and Strategy Quality remain in the browser. Genetic and
Polymarket Finder use their dedicated in-tab runners. This document covers
only the server-owned Symbol Universe and Asset Opportunity routes; do not
infer server ownership for another Finder mode from the shared result types.

## Runtime contract

- Start with `npm run dev` for development. `vite preview` also registers the
  Finder Universe endpoint; a static-only deployment does not.
- **One request per run.** The browser submits all selected entry strategy
  keys in a single `POST /api/finder/universe-run` request with a
  browser-generated `runId`. The server sequences strategies, merges scalar
  survivors, runs OOS (when enabled), and publishes one terminal snapshot.
  The browser no longer sequences per-strategy requests or loads OHLCV for
  the OOS pass. Asset Opportunity batch mode uses the analogous
  `POST /api/finder/asset-opportunity-batch-run` route (see above).
- Polymarket scoring remains unsupported in Symbol Universe scope.
- **Stop is scoped by `runId`** — `POST /api/finder/stop` carries the active
  run id so a stale tab cannot cancel a newer run. Stop aborts in-flight
  data loads, makes every strategy + OOS loop observe lost ownership, marks
  the snapshot cancelled, and clears the browser-side active-run record.
- **Tab reload reattach is supported.** The browser persists the active
  `runId` (`playground_finder_active_server_run`, schema
  `finder.active_server_run`, v1) before `fetch`. On Finder init, it polls
  `GET /api/finder/status?runId=...`; if the server still has the job, it
  restores progress + Stop state and polls summary-only status until
  terminal, then adopts the authoritative final candidates once. Reattach
  only survives a browser reload while the same Vite process remains alive
  — a Vite restart loses the in-memory job (the reattach clears its record).

- If the initiating NDJSON stream breaks without a reload, the same tab polls
  the scoped status endpoint to terminal. It never promotes provisional
  streamed candidates to the final result.

## Memory

Large universes require a larger Node heap:

```powershell
$env:NODE_OPTIONS="--max-old-space-size=16384"; npm run dev
```

`run_playground.bat` applies this default unless a heap value is already set.
The server rejects 400-799 symbols below 8192 MB and 800+ below 12288 MB.

Within one server-owned run, successful sliced datasets are cached by
`symbol|interval` and reused by every selected strategy. The cache does not
increase the runner's peak dataset count because one strategy already loads
the full universe; it extends that dataset lifetime until Done, Stop, or Fatal,
when the job cache is cleared. Failed and empty loads are not retained, so a
later strategy can retry them.

## Wire contract

`FinderUniverseCandidate` is scalar-only. `toScalarCandidate(...)` and
`assertCandidateIsScalar(...)` reject `data`, `signals`, `trades`, and
`equityCurve` before streaming and on the terminal status snapshot.

| Event | Purpose |
| --- | --- |
| `start` | Echoes the `runId`, declares symbol/candidate counts, ordered strategy keys + count. |
| `progress` | Updates bounded progress, status, phase (`loading`/`evaluating`/`oos`), and current strategy index/count. |
| `candidate` | Streams a scalar survivor (merged job-level survivors, deduped by identity). |
| `symbol_failed` | Reports one dataset failure. |
| `done` | Authoritative final slice, combined diagnostics, totals (incl. `oosRemoved`), and the matching `runId`. |
| `fatal` | Terminates the run with an error and the matching `runId`. |

The terminal `done.candidates` slice is authoritative. `/status` in-progress
snapshots are summary-only (candidate counts, never the per-symbol payload);
the terminal snapshot is the one place that carries the final candidate slice.

Copied diagnostics report job-cache requests, hits, misses, unique bars,
candidate plans versus symbol evaluations, and actual Rust/TypeScript executor
usage. When Rust was requested but a run remains on TypeScript, diagnostics
include the deterministic eligibility reason. Same-bar exit policy is passed
to the compatible Rust service; unsupported execution settings still fall back
to TypeScript. Timing phases
are marked `overlapping` because yielding and nested
signal/backtest work must not be added together as independent wall time.

## `GET /api/finder/status?runId=...`

Returns a typed `FinderRunStatusSnapshot`: `running`, `terminal`, `phase`,
`progressPercent`, `statusText`, candidate `candidateCount` (count only while
running), loaded/failed totals, and — when terminal — the authoritative
`terminalCandidates` slice + summary + diagnostics. A mismatched `runId`
returns 404 and must never be adopted. A request without `runId` returns the
legacy ad-hoc introspection object for `curl` debugging; the browser reattach
path must pass a `runId`.

## Data flow

The server loader reuses `createBatchDatasetLoaderCore`, preserving Batch
synthetic-pair construction, cache limits, gap filling, and data slicing. The
server evaluates IS candidates, merges survivors across strategies, runs the
OOS pass (loads complementary datasets through the same loader, sliced at the
caller), and releases datasets when the job ends. There is no Mine artifact
directory or TTL. The browser loads **no** Universe OHLCV for IS or OOS.

Diagnostics are combined server-side by the leaf
`buildCombinedUniverseDiagnostics(...)` (the prior `FinderManager` combiners,
extracted verbatim). The OOS pass is the leaf `runUniverseOosPass(...)`
(`lib/finder/finder-universe-oos.ts`), a faithful lift of the prior
`FinderManager.applyUniverseOosValidationIfNeeded` body with all runtime
dependencies injected — it reads no browser DOM, `state`, `backtestService`,
or `dataManager`.

When local data is synchronized, the browser also calls
`POST /api/finder/invalidate-cache` so the server loader does not retain stale
datasets across later Universe runs.

Server-side modules imported by `vite.config.ts` must not import browser-bound
managers or anything that transitively imports `lightweight-charts`. The
server plugin reaches only leaf modules: `finder-runner-universe`,
`finder-universe-metrics`, `finder-universe-diagnostics-combine`,
`finder-universe-oos`, `finder-param-space`, `finder-manager-logic`,
`server-finder-data-loader`, and the synthetic-pair disk cache.

## Stop-before-ownership race

`POST /api/finder/stop` with a `runId` that has not yet acquired ownership is
recorded in a module-scope `pendingStopRunId` (single slot — not an
unbounded set). The matching run request consumes the marker and finishes
cancelled instead of starting heavy work. A newer run with a different
`runId` is unaffected.

## Validation

- `npm run typecheck`
- `npm run typecheck:tests`
- `..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-server-loader-parity.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-metrics.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-oos.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-oos.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-metadata.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-archive.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-batch-parallel.spec.ts`

Manual smoke: run one and multiple strategies over 50 symbols, then 400
symbols with the larger heap. Confirm progress scaling, server-side OOS
filtering, Stop (scoped by run id), diagnostics merging, reload reattach
during IS and OOS phases, and Apply. For batch mode, enable the toggle, enter
a small range such as 2–4 with at least two symbols, and verify one file per
N under `archive/asset opportunity/`, append-on-repeat, empty-result blocks,
Stop partial completion, and reload reattach mid-sweep. For the parallel
sweep, also compare a full run against a `FINDER_ASSET_BATCH_WORKERS=1`
baseline — the per-N archive blocks must be identical for the same inputs,
and Task Manager should show >100% CPU on the dev-server process during the
sweep. A real-worker smoke script lives at
`artifacts/smoke-batch-parallel-worker.ts` (run with esno; it sweeps the
local IBKR data through three real workers).
