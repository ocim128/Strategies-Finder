# Server-Side Batch Backtest

The Batch Backtest tab can run its heavy per-symbol workload either in the
browser tab (the original path) or in the Vite dev-server (Node) process. The
server-side path exists because 1000+ IBKR 4H synthetic-pair runs hold
~5–10 GB of per-row artifacts (`data` + `signals` + `result.trades`) for the
Mine Timing step, which OOMs a browser tab. Node can use main RAM directly;
the browser tab keeps only rendered scalars and DOM rows.

## When to use server-side mode

Use **Server-Side** when:

- You run large pair lists (≥200 synthetic pairs, especially IBKR 4H).
- You Mine Timing on those lists (Mine needs the per-row artifacts in memory).
- You reattach to a long run after a tab reload.

Use **Browser-Tab** when:

- You are on `vite preview` (no dev server) or a built bundle.
- You are running small lists and want to skip the dev-server round-trip.

## Starting the dev server with extra heap

A 1000-pair run plus Mine Timing holds several GB of OHLCV / signals / trades
arrays on the dev server. The default V8 heap is too small. Start the dev
server with:

```bash
# macOS / Linux
NODE_OPTIONS=--max-old-space-size=16384 npm run dev

# Windows (cmd)
set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev

# Windows (PowerShell)
$env:NODE_OPTIONS="--max-old-space-size=16384"; npm run dev
```

`run_playground.bat` sets `NODE_OPTIONS=--max-old-space-size=16384`
automatically unless you already supplied a `--max-old-space-size` value. If
you start Vite manually with the default heap, large server-side Batch runs are
rejected before they begin instead of crashing the dev server.

If the dev server crashes with `JavaScript heap out of memory`, raise the
value. `12288` is the floor for a full 1000-pair IBKR 4H run; `16384` leaves
headroom for an IBKR sync running concurrently.

The heap requirement scales with pair count. For 200–400 pair runs,
`--max-old-space-size=8192` is usually enough.

## The settings toggle

`Settings → Backend Engine → Batch Execution Mode` selects `Server-Side` or
`Browser-Tab`. The default is **Server-Side**. The toggle is a UI-only setting
(it is not consumed by Rust or worker surfaces).

If you change the toggle while a server-side run is in flight, the run keeps
running on the server. Use Stop to cancel it.

## Stop vs Cancel vs Reload

- **Stop button**: cancels the in-flight server-side run. The owner-lock is
  force-bumped, in-flight dataset loads are aborted, and the runner bails at
  the next per-iteration check. Already-rendered rows stay on screen.
- **Tab reload mid-run**: the server keeps running. The browser polls
  `GET /api/batch-backtest/status` every 2s on init and reattaches — it
  re-renders the rows accumulated server-side so far and continues updating
  until the run ends. The poll granularity is 2s (not per-symbol), which is
  the same pattern IBKR sync uses for reattach.
- **Closing the tab**: the server keeps running. Reopening the tab triggers
  the same reattach poll. There is no stream-tap from a second connection —
  multi-subscriber writers are over-engineering for a single-user dev server.

## Mine Timing on the server

In server-side mode, the per-row artifacts (`data` / `signals` /
`result.trades`) are written to a temporary server-side artifact directory.
The Mine Timing button is enabled when the run's `done` event reports
`serverHasArtifacts: true` (i.e. at least one completed synthetic-pair row was
stored).

Mine does not load all stored pairs into memory at once. It derives the target
assets from artifact metadata, then for each target loads only the synthetic
pairs linked to that target, computes that target's verdict, and releases the
linked artifact objects before moving to the next target. This keeps 6700-pair
Mine runs bounded by the largest single target's linked pair set rather than
the full pair universe.

Clicking Mine streams verdicts back via `POST /api/batch-backtest/mine`.
Clicking Stability Mine streams randomized subset progress via
`POST /api/batch-backtest/stability-mine`. After either miner completes, the
server releases its artifact copy. Re-mining the same run requires a fresh Run
— the same fingerprint guard the browser path uses.

## Artifact retention and TTL

When artifacts are retained, the server keeps the temporary artifact directory
until one of:

1. Successful Mine or Stability Mine completion (after streaming `done`).
2. A new Run starting (`POST /run` removes the prior artifact directory first).
3. **A bounded TTL of 10 minutes** after the Run's `done` event with no Mine
   click.

The TTL is the defense-in-depth that the browser path got for free via tab
reload. Without it, a user who runs 1000 pairs and walks away would leave
~5 GB pinned on the dev server indefinitely.

The TTL value is `DEFAULT_ARTIFACT_RETENTION_MS = 10 * 60 * 1000` in
`lib/batch-backtest/batch-backtest-vite-plugin.ts`.

## Copy summary parity

In server-side mode, the `symbol` event still strips `data`, `signals`, and
`result.trades`, but it keeps tiny derived scalars for Copy Results:

- `buyHoldPct` preserves the B&H / alpha sections.
- `openTradeAssetScores` preserves the OPEN_SCORE sections.

The browser tab still avoids heavy per-row arrays, while copied summaries match
the browser-side Batch path for these sections.

## Reload persistence

The Batch tab persists the latest completed output through
`playground_batch_backtest_latest_results`, using the same envelope helper as
Finder result snapshots. Persisted rows are scalar-only: `data`, `signals`,
`result.trades`, and `result.equityCurve` are stripped before writing to
localStorage. Reloading restores the rendered rows, Copy Results output, and
the latest Stability Mine output when one exists.

Mine Timing is not restored from localStorage because it needs heavy per-row
artifacts. In server-side mode, the reattach status endpoint can still re-enable
Mine while the server artifact TTL is valid and the fingerprint matches. Before
server-side Stability Mine starts, the browser refreshes artifact status from
the server so a stale local flag cannot call the endpoint after artifacts were
released or expired. Stability Mine does not release artifacts, so it can be
rerun with different subset/rerun/seed values until TTL expiry, a new Batch Run,
or Mine Timing releases them.

## Single in-flight run per dev server

The plugin uses the same owner-lock model as IBKR sync. A second `POST /run`
while a run is in flight returns `409 Conflict`. A second `POST /mine` while
Mine is running also returns `409`. Mine and Run share the lock: a new Run
cannot start while Mine is in flight, and vice versa.

This is the single-user dev server model. Multi-tenant / concurrent runs are
out of scope.

## Rust engine parity

Server-side mode preserves Rust engine parity. The user's `useRustEngine`
toggle is forwarded to the server as `useRustEnginePreference` in the run
request body, and `shouldAttemptRust` consults it when running in Node
(where there is no DOM toggle to read).

Without this fix, server-side mode would silently use the TypeScript engine
even when the user has Rust enabled — a perf regression vs browser mode.

## HTTP API

All endpoints live under `/api/batch-backtest/*`:

- `POST /run` — NDJSON stream. Body: `{ symbols, interval, strategyKey,
  strategyParams, backtestSettings, capitalSettings, useRustEnginePreference }`.
  Streams `start`, `progress`, `symbol`, `symbol_failed`, `done`, `fatal`
  events.
- `POST /stop` — force-bumps the owner lock and aborts in-flight loads. Safe
  to call when no run is active.
- `POST /mine` — NDJSON stream. Body: `{ fingerprint, interval }`. Streams
  `start`, `verdict`, `done`, `fatal` events.
- `GET /status` — JSON snapshot for reattach. Returns `{ running, run, lastRun,
  miner }`.

The `row` sent in `symbol` events contains ONLY scalars — never `data`,
`signals`, or `result.trades`. Those arrays stay server-side. This is the
contract that keeps the browser tab bounded regardless of pair count.

## Mine / Stability Miner Acceleration

Mine Timing and Stability Mine have an accelerated execution path layered on
top of the server-side artifact storage described above. The acceleration has
several layers, tried in order, each with a deterministic fallback:

1. **TypeScript algorithmic improvements** (always on) — top-K analog
   selection replaces full-sort in `selectAnalogs(...)` (O(N log K) vs
   O(N log N)), and an asset→pair index replaces the per-target linear
   `pairs.filter(...)` linked-pair scan. No behavior change; verdicts are
   byte-identical to the pre-acceleration path (locked by
   `tests/batch-synthetic-state-miner.spec.ts`). On a 448-pair / 4H Stability
   run this cut `linkedPairFilterMs` 9.8→1.7 ms (−83%) and
   `analogSelectionMs` 629→155 ms (−75%).
2. **Compact miner artifacts** (DEFAULT OFF — gate
   `BATCH_MINER_COMPACT_ARTIFACTS_ENABLED`) — server-side Mine artifacts CAN
   be stored as a versioned struct-of-arrays shape
   (`lib/batch-backtest/batch-miner-artifact.ts`) instead of raw
   `BatchSyntheticPairArtifact` object literals. OHLCV is held as parallel
   `Float64Array`s; time is held as the exact `timeKey(bar.time)` string so
   lookup parity with freshly-loaded target candles is preserved. The compact
   shape only pays off when a Rust backend reads it via file-manifest handoff;
   on the TS-only path it is a net loss (store-time conversion adds ~89% to
   the Run phase on a 448-pair 4H workload, plus ~1.4s reconversion at Mine
   load). The plan's Phase 2 exit criterion is "artifact preparation time and
   heap usage do not regress" — that is why the gate defaults off.
3. **Rust miner backend** (DEFAULT ON, but only engages when compact storage
   is also ON — gate `BATCH_MINER_RUST_ROUTING_ENABLED`) — when a Rust miner
   backend is reachable, Stability Mine delegates to it. On any failure
   (unavailable, schema mismatch, timeout, transport unsupported), the router
   falls back to the parallel TypeScript path (next) or sequential TS and
   stamps `engine: "rust_fallback"` + the reason on the result. With compact
   storage off (the default), Rust is skipped entirely because file-manifest
   handoff requires the compact on-disk shape.
4. **Parallel Stability workers** (DEFAULT ON — gate
   `BATCH_MINER_PARALLEL_STABILITY_ENABLED`) — partitions the rerun range
   across Node `worker_threads`, each reading artifact files (raw OR compact)
   from disk independently, then merges the partial accumulators in ascending
   rerun-order. Output is byte-identical to the sequential path for a fixed
   seed (locked by `tests/batch-stability-parallel.spec.ts`, including an
   end-to-end spawn test). The worker is bundled to `.js` on first use via
   esbuild (see `resolveWorkerPath()` in `batch-stability-parallel.ts`) so
   Node `worker_threads` can load it under `vite dev` without a TS-aware
   loader. Engages only when `reruns >= 4`; below that, worker startup + merge
   overhead exceeds the parallelism win. Each worker pays its own
   `prepareBatchSyntheticPairArtifacts` cost (ATR/signal/trade indexing), so
   the break-even is when per-rerun `candidateSamplesMs` dominates prepare
   cost — true on the 448-pair / 4H workload where candidateSamples is ~83%
   of Stability. On any worker error, falls back to sequential TS.
5. **Sequential TypeScript** (final fallback) — the original rerun loop.
   Always available. Stamps `engine: "typescript"` on the result.

### Engine reporting

Every Stability Mine result carries two fields for Phase 6 observability:

- `result.engine` — one of `typescript`, `typescript_parallel`, `rust`,
  `rust_fallback`. Surfaces which path actually ran.
- `result.rustFallbackReason` — non-null only when `engine === "rust_fallback"`
  (e.g. `rust_unavailable`, `schema_mismatch`, `timeout`). Null otherwise.

The Copy Benchmark snapshot exposes these in `phases.stability.engine` and
`phases.stability.rustFallbackReason`, plus the artifact load/conversion cost
in `phases.stability.minerProfile.artifactConversionMs` and the Rust timings
in `rustRequestMs` / `rustProcessingMs` / `rustResponseMs`.

**Reading the parallel profile:** when `engine === "typescript_parallel"`, the
`minerProfile` fields are the SUM of per-worker contributions (merged in
ascending rerun-order). `runPreparedMs` can exceed wall-clock `totalMs` because
it sums parallel CPU time across workers. `preparePairsMs`,
`prepareTargetsMs`, and `artifactConversionMs` are each paid once per worker.
Workers precompute the exact sampled pair indexes for their assigned reruns and
load only the union of those artifact files, so the duplicated-work tax is
bounded by sampled pairs rather than the full pair universe. `candidateSamplesMs`
is also summed across workers; it is the field the parallel path divides in
wall-clock terms. `parallelWorkerCount` records the worker count so bottleneck
diagnostics can convert summed worker CPU into a wall-equivalent estimate.

### Rust miner backend contract

The Rust miner backend is OPTIONAL and lives outside this repository. The
TypeScript client (`lib/batch-backtest/batch-rust-miner-client.ts`) is the
single source of truth for the wire contract. The backend MUST implement:

- `GET /api/miner/health` → `{ status: "healthy", minerApiVersion, compactArtifactSchemaVersion, supportsMine, supportsStability, transports, version }`.
  `transports` is an array of `"file_manifest"` and/or `"binary"`.
  `compactArtifactSchemaVersion` MUST match `COMPACT_MINER_ARTIFACT_SCHEMA_VERSION`
  in `lib/batch-backtest/batch-miner-artifact.ts` (currently `1`); a mismatch
  triggers a `schema_mismatch` fallback.
- `POST /api/miner/stability` → body is a `RustStabilityMineRequest`
  (`transport: "file_manifest"`, `manifest.pairArtifactFiles`,
  `manifest.targetArtifactFiles`, `manifest.artifactDirectory`, `targets`,
  `subsetSize`, `reruns`, `seed`).
  Response is a full `BatchStabilityMineResult` (rows + scoring already
  finalized by the backend) plus `processingTimeMs`.
- `POST /api/miner/run` → one-shot Mine request; response is
  `{ verdicts: BatchSyntheticAssetVerdict[], processingTimeMs }`.

The default backend URL is `http://127.0.0.1:3031` — SEPARATE from the
backtest engine at `http://127.0.0.1:3030`. The miner backend must NOT receive
multi-GB JSON artifact payloads; it reads compact artifact files from the
server-controlled temp directory via file-manifest handoff (the only transport
the router uses today). File-manifest handoff is local-only; the plugin passes
server-created temp paths only and never accepts client-supplied paths.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `engine: "typescript"` on a Stability run with `reruns >= 4` | parallel path skipped or fell back (worker spawn failed, or reruns below threshold) | check `BATCH_MINER_PARALLEL_STABILITY_ENABLED` and the server log for `batch.parallel_stability.fallback_to_sequential`; the esbuild worker bundle may have failed |
| `engine: "typescript_parallel"` | expected default for `reruns >= 4` with no Rust backend | nothing to fix; this is the accelerated TS path |
| Run phase much slower than baseline after enabling compact storage | store-time `toCompactPairArtifact` tax (~89% on 448-pair 4H) | keep `BATCH_MINER_COMPACT_ARTIFACTS_ENABLED = false` (default); only enable when a Rust backend reads the compact shape |
| `engine: "rust_fallback"`, reason `rust_unavailable` | Rust routing + compact gates both on, but no backend at `127.0.0.1:3031` | start the backend, or turn the compact gate off (Rust is then skipped, engine returns to `typescript` or `typescript_parallel`) |
| `engine: "rust_fallback"`, reason `schema_mismatch` | backend built against a different `COMPACT_MINER_ARTIFACT_SCHEMA_VERSION` | rebuild the backend against current `batch-miner-artifact.ts` |
| `engine: "rust_fallback"`, reason `timeout` | backend took longer than the client timeout (5 min for Stability) | reduce `reruns`/`subsetSize`, or raise `STABILITY_TIMEOUT_MS` in the client |
| `engine: "rust_fallback"`, reason `transport_unsupported` | backend does not advertise `file_manifest` | the router only uses file-manifest handoff; build the backend with file-manifest support |
| `artifact load/conversion was N% of stability` benchmark note | worker artifact load/deserialization, and optional compact→raw reconstruction, is a large share of Stability | keep compact storage off for TS-only runs; lower worker count if duplicate worker loads dominate |
| Worker-thread memory pressure | each worker independently loads + prepares artifacts from disk | lower `resolveStabilityWorkerCount()` cap (default 8) or split the pair list into chunks |

### Validation habit after miner-acceleration changes

```bash
npm run typecheck
..\..\..\node_modules\.bin\esno tests\batch-synthetic-state-miner.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-miner-artifact.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-stability-mine.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-stability-parallel.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-rust-miner-client.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-runner.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```
