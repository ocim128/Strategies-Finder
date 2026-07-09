# Batch Mine Performance Acceleration

## Status And Performance Results (2026-07-09)

Implemented and measured against a real 448-pair / 4H / 5-rerun / 200-subset
workload. Four benchmark samples were captured end-to-end through the Copy
Benchmark button (Run + Stability). Numbers below are wall-clock from
`phases.*.totalMs`.

| Phase | Layer | Status | Gate default | Measured impact |
|---|---|---|---|---|
| 1 | Top-K analog + asset index | **SHIPPED, always on** | — | `linkedPairFilterMs` 9.8→1.7 ms (−83%), `analogSelectionMs` 629→175 ms (−75%). Against **<2% of Stability**; `candidateSamplesMs` (~83% of Stability) is untouched. |
| 2 | Compact artifacts | **SHIPPED, default OFF** | `BATCH_MINER_COMPACT_ARTIFACTS_ENABLED=false` | Store-time conversion made Run **+89% slower** (15.3→29.0s) for zero benefit on the TS-only path. Net loss; only pays off when a Rust backend reads the compact shape. |
| 3 | Parallel Stability workers | **SHIPPED, default ON** | `BATCH_MINER_PARALLEL_STABILITY_ENABLED=true` | Stability **74.2s → 31.8s (−57%)**. The one layer that moves the needle — divides `candidateSamplesMs` across cores. |
| 4 | Rust miner client + routing | **SHIPPED, inert** (no backend exists) | `BATCH_MINER_RUST_ROUTING_ENABLED=true` (precondition: compact on) | Never engaged in measurement (no Rust backend). Falls back cleanly to parallel/sequential TS. |
| 5 | Rust/Rayon miner | **NOT DONE** (no crate in repo) | — | Out of scope for this TS codebase. |
| 6 | Docs + observability | **SHIPPED** | — | Engine label, fallback reason, conversion/rust timings in benchmark + troubleshooting table. |

### Headline result

Stability Mine wall-clock on the target workload: **74.2s → 31.8s**, with
byte-identical output (19 hitEvents / 15 verdicts across all four benchmarks).
The win comes entirely from Phase 3 (parallel workers). Phases 1 and 2 are
correct and parity-locked but do not move the dominant `candidateSamplesMs`
cost on their own.

### Key lessons (see "Lessons Learned" below for detail)

1. **Store-time artifact conversion is paid on every Run**, not just Mine. On
   the TS-only path it is a net loss. Compact storage must stay off until a
   Rust backend reads the compact shape.
2. **A TypeScript worker cannot load under `vite dev` without bundling** —
   Node `worker_threads` reject `.ts`. esbuild-on-first-use bundling is the
   prerequisite that makes Phase 3 actually engage.
3. **The fundamental bottleneck (`candidateSamplesMs`, ~83% of Stability) is
   not reducible in TypeScript.** Only Rust/Rayon reduces the work; TS
   parallelism only divides wall-clock.

## Scope

Batch Backtest post-run analysis: Mine Timing and Stability Mine on large synthetic-pair lists. Run Batch itself stays unchanged except for the artifact it retains for Mine/Stability.

Included work:

- top-K analog selection instead of full nearest-neighbor sorting
- pre-indexed asset-to-pair lookup
- compact miner-ready artifacts
- parallel Stability Mine execution
- Rust/Rayon miner integration

Excluded work:

- new Fast Stability defaults or presets; subset size, reruns, and seed remain user-configurable
- Batch dataset loader changes unless benchmarks show artifact generation regresses Run Batch
- browser wire payload expansion; heavy arrays must stay server-side

## Known Facts And Unknowns

- The current repository contains the TypeScript app and a Rust HTTP client in `lib/rust-engine-client.ts`, but no Rust crate or Cargo workspace. Rust miner implementation location, build command, and deployment process are unknown.
- Server-side Batch is the primary target. Browser-side Mine/Stability remains supported as a fallback unless explicitly removed later.
- Existing Rust backtest endpoints use JSON over HTTP. The miner must not send multi-GB artifact payloads as JSON.
- Target candle loading currently belongs to the TypeScript app/server-side plugin. Rust mines supplied target artifacts and does not duplicate local SQLite, provider, or synthetic-pair loader logic.

## Current Architecture

- Browser UI service: `lib/batch-backtest/batch-backtest-service.ts`
- Server-side Batch Vite plugin: `lib/batch-backtest/batch-backtest-vite-plugin.ts`
- Miner implementation: `lib/batch-backtest/batch-synthetic-state-miner.ts`
- Stability aggregation: `lib/batch-backtest/batch-stability-mine.ts`
- Server stream contracts: `lib/batch-backtest/batch-backtest-stream-types.ts`
- Benchmark diagnostics: `lib/batch-backtest/batch-benchmark-snapshot.ts`
- Existing Rust client: `lib/rust-engine-client.ts`
- Existing server-side artifact storage:
  - `storeMineArtifact(...)` serializes `BatchSyntheticPairArtifact` with Node `v8.serialize(...)`
  - artifacts live in a temp directory until Mine completion, new Run, or TTL expiry
  - browser receives scalar-only rows; heavy arrays stay server-side

## Target Architecture

Keep the existing Batch run contract intact:

1. Batch run loads datasets, runs strategy/backtest, streams scalar rows.
2. Server stores miner artifacts for synthetic pairs.
3. Mine/Stability consumes server artifacts.
4. Browser receives only verdict/progress/done events.

Add acceleration in layers (actual order, post-implementation — see Status
table for which shipped and which are gated):

1. TypeScript algorithmic improvements with no contract change. **Shipped, always on.**
2. Compact miner artifact contract inside the server-side Batch path. **Shipped, default OFF** — store-time conversion regressed Run +89% on the TS-only path (see Lessons Learned #1).
3. Parallel Stability execution in Node worker_threads. **Shipped, default ON** — the headline win (Stability −57%). Decoupled from layer 2 after benchmarking proved compact storage was a net loss; workers read raw OR compact files.
4. Optional Rust miner backend through a narrow client, falling back to the TypeScript miner when unavailable or unsupported. **Shipped, inert** (no backend exists). Precondition: layer 2 enabled (file-manifest handoff requires the compact shape).

The original plan sequenced parallelism "only after the compact artifact path
avoids large structured-clone copies." Benchmarking reversed this: compact
storage at store time is a net loss, and parallelism does not need it (workers
read artifact FILES from disk, not structured-cloned objects). Parallelism is
now the primary acceleration and compact storage is reserved for the Rust
file-manifest handoff.

## Module Boundaries

- `batch-backtest-service.ts`
  - UI state, button enablement, NDJSON consumption, benchmark capture.
  - Must not contain miner algorithms.
- `batch-backtest-vite-plugin.ts`
  - Server API ownership, artifact lifecycle, Mine/Stability routing, streaming.
  - Selects TypeScript vs Rust miner path.
- `batch-synthetic-state-miner.ts`
  - TypeScript reference implementation and parity baseline.
  - Remains pure/testable.
- `batch-miner-artifact.ts` (new)
  - Compact artifact types and conversion from `BatchSyntheticPairArtifact`.
- `batch-miner-index.ts` (new)
  - Asset-to-pair and subset indexes shared by TypeScript/Rust request builders.
- `batch-rust-miner-client.ts` (new)
  - HTTP client for Rust Mine/Stability endpoints, separate from backtest-specific `rust-engine-client.ts` unless the existing Rust backend contract is intentionally extended.
- `batch-stability-worker.ts` (new, Phase 3)
  - Worker-thread entrypoint: runs a rerun range `[start, end)` against artifact FILES read from disk (raw OR compact), returns a partial `BatchStabilityAccumulator` + per-worker profile. Bundled to `.cjs` via esbuild on first use (see Lessons Learned #2).
- `batch-stability-parallel.ts` (new, Phase 3)
  - Orchestrator: partitions reruns across workers, spawns them, merges partial accumulators deterministically in ascending rerun-order. Owns `resolveWorkerPath()` (esbuild bundling) and `mergeStabilityAccumulators()`.
- Rust backend changes
  - Location unknown. Must be documented once identified. **(2026-07-09: still no crate in this repo; Phase 5 blocked.)**

## Data Flow

Current server-side flow:

`BatchBacktestSymbolResult` -> `BatchSyntheticPairArtifact` -> V8 temp artifact -> `loadStoredMineArtifact(...)` -> TypeScript miner -> NDJSON verdict/result.

Target flow:

`BatchBacktestSymbolResult` -> compact miner artifact -> temp artifact/cache -> TypeScript or Rust miner -> NDJSON verdict/result.

Compact artifacts preserve enough information to reproduce:

- target-aligned pair state by base/quote side
- open/carry-in trade state
- signal-lag fallback state
- ATR/adverse-excursion features
- closed trade ranges for auto-horizon calibration
- current agreeing/opposing pair lists needed by result display and Stability diversity scoring

The server-side plugin remains responsible for loading target candles through the existing loader path. Rust receives target artifacts and pair artifacts; it does not call local SQLite, `DataFetcher`, or app data-provider modules.

## API And Contracts

Existing APIs to preserve:

- `POST /api/batch-backtest/mine`
- `POST /api/batch-backtest/stability-mine`
- `GET /api/batch-backtest/status`
- `BatchMinerStreamEvent`
- `BatchStabilityMineResult`
- scalar-only `BatchStreamEvent` row contract
- artifact TTL and release behavior
- fingerprint guard before mining

New contracts to define:

- compact artifact schema version
- TypeScript conversion parity from raw artifact to compact artifact
- compact target artifact schema version
- transport strategy:
  - preferred: local file-manifest handoff for server-side Rust, where Rust reads compact artifacts from the server temp artifact directory
  - fallback: binary request body for smaller runs or environments where file-manifest handoff is unavailable
  - avoid: JSON arrays for full OHLCV/state payloads on large runs
- Rust request/response schema for:
  - one-shot Mine
  - Stability Mine
  - backend health/capability check
- fallback behavior when Rust miner is unavailable, times out, or returns schema mismatch

## Phase 0: Baseline And Profiling

### Objective

Establish current bottlenecks and create a reproducible performance baseline before changing algorithms.

### Scope

Server-side Mine and Stability Mine on synthetic pairs. Browser-side path is observed but not optimized in this phase.

### Technical Tasks

- Run representative workloads:
  - crypto synthetic list around 200 pairs
  - IBKR synthetic list around 200 pairs
  - one larger list if available
- Capture Copy Benchmark output after Run + Stability.
- Record `phases.stability.minerProfile` subphase totals.
- Add or extend benchmark fields only if current fields are insufficient:
  - candidate sample count per rerun
  - analog candidates scored
  - top-K selected count
  - artifact conversion time
  - Rust request/processing/response time once Rust exists

### Dependencies

- Existing Copy Benchmark button and `BatchSyntheticMinerProfile`.
- Representative local data and symbol lists.

### Risks/Blockers

- No stable benchmark fixture in repo for 200+ synthetic pairs.
- Browser timing and Node heap can vary across runs.

### Deliverables

- Baseline benchmark JSON samples saved under `artifacts/batch-mine-benchmarks/`.
- List of top 1-3 hot subphases for the user's real workload.

### Status (2026-07-09)

**Done.** Four benchmark samples were captured end-to-end through the Copy
Benchmark button on a 448-pair / 4H / 5-rerun / 200-subset workload (strategy
`directional_body_acceptance`, `rust_preferred` engine mode). They are not
checked into `artifacts/batch-mine-benchmarks/` (that path is gitignored);
they live in this plan's Status table as the authoritative record.

Primary bottleneck identified: **`candidateSamplesMs`** — ~60-62 s, ~83% of
Stability. Every other sub-phase is <2% of Stability combined. This single
finding drove the rest of the plan: TS algorithmic work (Phase 1) cannot move
it; only parallelism (Phase 3) or Rust (Phase 5) can.

The benchmark schema was extended with the fields this phase called for
(`analogCandidatesScored`, `topKSelected`, `assetIndexHits/Misses`,
`artifactConversionMs`, `rustRequestMs/ProcessingMs/ResponseMs`) plus
`phases.stability.engine` and `rustFallbackReason` for Phase 6 observability.

### Validation/Testing Criteria

- Benchmark capture works for server-side Stability.
- Baseline contains enough detail to compare before/after changes.

### Exit Criteria

- At least one crypto and one IBKR synthetic benchmark captured.
- Primary bottleneck phase identified.

## Phase 1: TypeScript Algorithmic Hot-Path Fixes

### Objective

Reduce miner CPU work without changing public behavior or API contracts.

### Scope

`lib/batch-backtest/batch-synthetic-state-miner.ts` and focused tests.

### Technical Tasks

- Replace full sort in `selectAnalogs(...)` with bounded top-K selection:
  - compute `count` from candidate size before selection
  - keep only nearest `count` finite-distance analogs
  - sort the final top-K slice by distance for deterministic output
  - preserve full-sort tie semantics with original sample index as final tie-breaker
- Add parity tests proving top-K returns the same nearest analogs as full sort.
- Avoid repeated linked-pair filtering:
  - introduce an internal `pairsByAsset` index for prepared pairs
  - route `buildAssetVerdict(...)` through linked pairs directly where possible
  - preserve current public `runPreparedBatchSyntheticStateMiner(...)` behavior
- Reduce avoidable array allocations in summaries where benchmark shows impact:
  - avoid repeated `.map(...)` arrays in evidence summaries where practical
  - keep code readable; do not rewrite the whole miner.

### Dependencies

- Existing pure miner tests.
- Current `BatchSyntheticMinerProfile` for measuring hot-path changes.

### Risks/Blockers

- Top-K must preserve deterministic tie handling.
- Refactoring `buildAssetVerdict(...)` can accidentally change diagnostics or ordering.

### Deliverables

- TypeScript miner with top-K analog selection.
- Prepared pair asset index used by Stability/Mine paths.
- Focused tests for analog selection parity and linked-pair index behavior.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\batch-synthetic-state-miner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-stability-mine.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
- Benchmark comparison against Phase 0.

### Exit Criteria

- Verdicts are unchanged on existing miner fixtures.
- Stability benchmark improves or bottleneck clearly moves to a later phase.

### Status (2026-07-09)

**Done and shipped (always on).** Top-K max-heap + asset index are in
`batch-synthetic-state-miner.ts` / `batch-miner-index.ts`, parity-locked by
`tests/batch-synthetic-state-miner.spec.ts`. Measured on the 448-pair / 4H
workload:

- `linkedPairFilterMs`: 9.79 → 1.69 ms (−83%) — asset index
- `analogSelectionMs`: 629 → 175 ms (−75%) — top-K heap
- `currentSnapshotMs`: 892 → 600 ms (−33%) — downstream of the asset index

**Honest scope check:** these sub-phases total **<2% of Stability wall-clock**.
The exit criterion "Stability benchmark improves" is technically met but the
improvement is <1 s out of ~74 s — invisible in the total. The bottleneck
(`candidateSamplesMs`, ~83%) is not in this phase's scope; it moved to Phase 3
(parallelism) rather than to "a later algorithmic phase." This phase is
correct and worth keeping, but it is not the source of the headline speedup.

## Phase 2: Compact Miner Artifact Contract

### Objective

Create a compact, miner-ready artifact shape that avoids repeated object-heavy reconstruction and prepares the boundary for worker threads and Rust.

### Scope

Server-side artifact creation/loading and TypeScript miner input preparation. No database schema changes. No Rust endpoint changes in this phase.

### Technical Tasks

- Add `lib/batch-backtest/batch-miner-artifact.ts`.
- Define versioned compact artifact types:
  - artifact schema version
  - symbol/base/quote metadata
  - time representation
  - OHLC/close fields needed for outcomes
  - source arrays required to compute state for a miner option set
  - derived state arrays cached by `lagBars`, because signal-lag state depends on miner options
  - closed trade ranges for auto-horizons
  - optional debug metadata for parity checks
- Define compact target artifact types:
  - asset/symbol metadata
  - normalized time keys or numeric time ids
  - OHLC arrays needed for forward outcomes
  - target index lookup strategy compatible with `timeKey(...)`
- Convert `BatchSyntheticPairArtifact` to compact artifact once when storing server-side Mine artifacts.
- Preserve raw artifact path behind a feature flag or internal fallback until parity is proven.
- Add compact-to-reference adapter if the TypeScript miner initially still expects existing prepared objects.
- Update artifact release and TTL logic without changing lifecycle.
- Add a schema guard that rejects stale compact artifacts and falls back to raw artifacts when available.

### Dependencies

- Phase 1 identifies exact fields required by the miner.
- Existing server artifact temp directory and V8 serialization lifecycle.

### Risks/Blockers

- Compact artifact may omit a field needed for current verdict text or pair contribution output.
- Time alignment must match `timeKey(...)` semantics exactly.
- Derived state cannot be fully fixed at Batch time if miner options change; cache derived arrays by normalized option values such as `lagBars`.
- Typed arrays are not JSON-friendly; V8 serialization is acceptable for Node-only artifacts, but Rust needs file-manifest or binary handoff.

### Deliverables

- Versioned compact artifact module.
- Server-side artifact writer/loader for compact artifacts.
- Parity tests comparing raw-artifact miner output vs compact-artifact miner output.
- Artifact schema migration/fallback behavior for stale or missing compact artifacts.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
- New compact artifact parity spec.
- Manual benchmark confirms artifact preparation time and heap usage do not regress.

### Exit Criteria

- Server-side Mine/Stability can consume compact artifacts.
- Output matches raw artifact path on fixtures.
- Browser wire contract remains scalar-only.

### Status (2026-07-09)

**Done, shipped, and DEFAULT OFF.** The compact artifact module
(`batch-miner-artifact.ts`), schema guard, round-trip conversion, and parity
spec (`tests/batch-miner-artifact.spec.ts`) all landed and are correct. The
server plugin stores/loads compact artifacts when the gate is on, with raw
fallback when it's off (both shapes handled transparently).

**Critical deviation from the original plan:** the gate defaults OFF, not ON.
Benchmarking disproved the plan's assumption that compact artifacts "avoid
repeated object-heavy reconstruction." Converting at `storeMineArtifact(...)`
time is paid on every Run (not just Mine), and on the 448-pair / 4H workload
it made the Run phase **+89% slower** (15.3 s → 29.0 s) — violating this
phase's own validation criterion ("artifact preparation time and heap usage do
not regress"). See Lessons Learned #1.

The compact shape only pays off when a Rust backend reads it via file-manifest
handoff. With no Rust backend (Phase 5 blocked), enabling it is a net loss.
Re-enable only alongside a Phase 5 backend and a benchmark proving net win
end-to-end. The `artifactConversionMs` profile field makes the cost visible
either way.

A secondary note on the design: the compact format stores time as the exact
`timeKey(bar.time)` string, NOT normalized to unix seconds. The plan floated
"normalized time keys or numeric time ids," but the miner's `timeIndex` is
keyed by `timeKey(...)`, which returns the RAW time shape (ms stays ms).
Normalizing time in the compact artifact would break lookup parity with the
freshly-loaded raw target candles. This is locked by
`tests/batch-miner-artifact.spec.ts` ("preserves every candle's timeKey
exactly").

## Phase 3: Parallel Stability In Node

### Objective

Use CPU parallelism for Stability reruns while keeping server memory bounded.

### Scope

Server-side Stability Mine only. Browser-side Stability remains sequential unless later justified. This is a fallback acceleration path for Rust-unavailable runs, not a prerequisite for Rust. Implement only after Phase 2 proves artifact copy/parse cost is bounded.

### Technical Tasks

- Add worker-thread execution path for Stability rerun ranges.
- Partition reruns, not pairs:
  - each worker receives compact artifact file references or shared compact buffers, not raw `BatchSyntheticPairArtifact` objects
  - each worker returns partial `BatchStabilityAccumulator`-compatible rows
- Add deterministic merge of partial Stability accumulators.
- Limit concurrency based on CPU count and heap:
  - default `min(physical/logical cores - 1, configured cap)`
  - cap memory by avoiding full artifact clone per worker where possible
- Preserve cancellation through owner generation and worker termination.
- Stream progress from completed worker chunks back to existing `progress` events.

### Dependencies

- Phase 2 compact artifact format.
- Existing `createStabilityAggregate`, `addStabilityVerdicts`, and `finalizeStabilityAggregate` semantics.
- Benchmark proof that artifact transfer into workers is cheaper than sequential rerun execution.

### Risks/Blockers

- Worker structured clone can erase gains if large artifacts are copied to every worker.
- Loading all artifacts independently in every worker can erase gains; prefer file references plus per-worker subset loading, or shared buffers only after measuring.
- SharedArrayBuffer may require additional constraints; avoid unless file-reference loading is too slow.
- Progress granularity changes can affect UI expectations.
- Debugging worker failures is harder than sequential code.

### Deliverables

- Server-side parallel Stability path.
- Sequential fallback path.
- Tests for deterministic equality between sequential and parallel Stability results.
- Worker failure fallback policy.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
- New parallel Stability parity spec.
- Manual Stop test during parallel Stability.
- Benchmark comparison with same seed/subset/reruns.

### Exit Criteria

- Parallel and sequential outputs match for fixed seed.
- Stop/cancel works.
- CPU utilization improves wall-clock time without exceeding heap target.

### Status (2026-07-09)

**Done, shipped, DEFAULT ON, and the headline win.** Stability Mine on the
target workload: **74.2 s → 31.8 s (−57%)**, with byte-identical output (19
hitEvents / 15 verdicts match every prior benchmark). `engine:
"typescript_parallel"` confirms the workers actually engaged.

The plan noted a prerequisite — "implement only after Phase 2 proves artifact
copy/parse cost is bounded." Phase 2's store-time conversion proved *unbounded
on the Run phase*, so Phase 3 was decoupled from the compact gate entirely:
workers read whatever shape is on disk (raw V8 OR compact) via
`isCompactPairArtifact(...)`, and `BATCH_MINER_PARALLEL_STABILITY_ENABLED` is
independent of `BATCH_MINER_COMPACT_ARTIFACTS_ENABLED`. This was the right
call — Phase 3 is the only layer that delivered a measurable speedup, and
gating it behind the net-loss compact storage would have blocked the only win.

**Critical prerequisite the plan missed:** Node `worker_threads` cannot load
`.ts` files, and `vite dev` runs the plugin in plain Node with no TS-aware
loader propagated to workers. The first parallel benchmark sample showed
`engine: "typescript"` — the spawn silently failed and fell back to sequential
every time, making the parallel path dead code. Fix: `resolveWorkerPath()` in
`batch-stability-parallel.ts` bundles the worker to a self-contained `.cjs`
via esbuild (transitive dep through Vite) on first use, mtime-keyed for source
changes. The end-to-end spawn test in
`tests/batch-stability-parallel.spec.ts` (against raw artifacts, the
production default) locks this and would fail if the worker couldn't load. See
Lessons Learned #2.

**Profile honesty fix:** the first parallel sample showed
`prepareTargetsMs: 0` / `preparePairsMs: 0` because workers didn't time their
own prepare/load steps — per-worker prepare cost (each worker independently
builds ATR/signal/trade indexes) was hidden inside `runPreparedMs`. Workers
now time those fields. This matters because each worker pays prepare
independently; on smaller-rerun workloads where the parallel speedup may not
beat the duplicated prepare, the profile must show that honestly. See Lessons
Learned #4.

**Honest limit:** parallelism divides wall-clock, it does not reduce the work.
`candidateSamplesMs` summed across workers is still ~62 s; the win is that it
runs on N cores instead of 1. Only the Rust/Rayon port (Phase 5) reduces the
work itself.

## Phase 4: Rust Miner Client And Fallback Contract

### Objective

Add a narrow TypeScript integration layer for a Rust miner backend without making the UI or plugin depend on Rust availability.

### Scope

TypeScript client and server plugin routing. Rust backend implementation is not in this repository unless a crate is later added.

### Technical Tasks

- Add `lib/batch-backtest/batch-rust-miner-client.ts`.
- Define health/capability response:
  - backend available
  - miner API version
  - supported compact artifact schema version
  - supports Mine
  - supports Stability
  - supported transport: `file_manifest` and/or `binary`
- Define request/response contracts for:
  - one-shot Mine
  - Stability Mine
  - processing profile timings
- Use TypeScript to load target artifacts and pass them to Rust.
- Prefer file-manifest handoff:
  - request includes artifact directory or explicit artifact file list
  - request includes compact target artifact files or binary target payload
  - Rust reads local files and returns compact verdict/result payloads
  - only enable when Rust backend is local and trusted
- Add plugin selection logic:
  - try Rust only for server-side Mine/Stability
  - fallback to TypeScript on unavailable backend, unsupported schema, timeout, or non-OK response
  - emit debug logs identifying selected miner engine
- Keep existing NDJSON stream shape to browser.
- Add benchmark fields for miner engine and Rust processing time.

### Dependencies

- Phase 2 artifact schema.
- Existing `debugLogger`.
- Existing Rust server address convention from `lib/rust-engine-client.ts` or an explicitly configured miner URL.

### Risks/Blockers

- Existing Rust server may not be owned by this repo.
- Endpoint paths and deployment process are unknown.
- Large request payloads can shift bottleneck to HTTP serialization; JSON payloads are unacceptable for the large-run path.
- File-manifest handoff requires the Rust backend to run on the same machine and have permission to read the temp artifact directory.
- A non-local Rust backend must use binary transfer and may be slower than local file handoff.

### Deliverables

- TypeScript Rust miner client.
- Server plugin fallback routing.
- Contract tests with mocked Rust responses.
- Documentation of required Rust endpoints and transport.

### Validation/Testing Criteria

- `npm run typecheck`
- Mocked success/fallback tests.
- Existing server plugin tests still pass with Rust unavailable.
- Benchmark shows whether Rust was used or fallback occurred.

### Exit Criteria

- App behavior is unchanged when Rust miner is unavailable.
- Mock Rust miner path produces accepted `BatchStabilityMineResult` and `BatchSyntheticAssetVerdict` payloads.

### Status (2026-07-09)

**Done, shipped, and INERT (no backend exists to engage it).** The client
(`batch-rust-miner-client.ts`), plugin routing, fallback contract, mocked
contract tests (`tests/batch-rust-miner-client.spec.ts` +
`tests/batch-backtest-server-plugin.spec.ts` Phase 4 test), and endpoint
documentation are all complete and correct. Every fallback path is exercised
by mocked tests: unavailable, schema_mismatch, transport_unsupported,
timeout, decode_error, and the success path.

The router was never engaged in measurement because (a) no Rust backend is
running and (b) its precondition (`BATCH_MINER_COMPACT_ARTIFACTS_ENABLED`)
defaults off. This is the correct production state — the router cleanly skips
to the parallel/sequential TS path and stamps nothing misleading on the
result. When a Phase 5 backend is deployed alongside compact-storage-on, the
router will engage with no further TS-side changes needed.

The wire contract is documented in `docs/batch-backtest-server-side.md`
"Rust miner backend contract": separate URL (`127.0.0.1:3031`), file-manifest
transport only, health/capability + Mine + Stability endpoints, and the
`{ ok: false, reason }` envelope every method returns instead of throwing.

## Phase 5: Rust/Rayon Miner Implementation

### Objective

Implement the compact-artifact miner in Rust with parallel Stability execution.

### Scope

Rust backend codebase. Exact repository/location is currently unknown.

### Technical Tasks

- Identify or create the Rust backend workspace.
- Add miner API endpoints matching Phase 4 contracts.
- Implement compact artifact decoding.
- Implement one-shot Mine parity with TypeScript reference:
  - target loading or supplied target arrays
  - horizon resolution
  - candidate state construction
  - distance scale calibration
  - top-K analog selection
  - evidence summaries
  - pair contributions
  - verdict/confidence classification
- Implement Stability using Rayon:
  - parallelize reruns or target/rerun work units
  - deterministic seeded sampling
  - deterministic aggregation order
- Use integer indexes for assets, pairs, target bars, and sample windows; avoid string maps inside hot loops.
- Use top-K selection in Rust; do not port the old full-sort path.
- Return profile timings comparable to `BatchSyntheticMinerProfile`.
- Add Rust unit tests for top-K, windowing, sampling, scoring, and aggregation.

### Dependencies

- Phase 2 compact artifact schema.
- Phase 4 HTTP contract.
- Access to the Rust backend source.

### Risks/Blockers

- No Rust source is present in this repository.
- Floating-point differences can alter borderline verdicts.
- Time normalization must match TypeScript `timeKey(...)`.
- Rayon parallelism can make ordering nondeterministic unless explicitly controlled.
- File path access and binary artifact transfer may require additional protocol work.

### Deliverables

- Rust miner endpoints.
- Rust tests.
- Versioned miner API documentation.
- Parity report against TypeScript fixtures.

### Validation/Testing Criteria

- Rust test suite passes.
- TypeScript integration tests pass against local Rust backend.
- Fixture outputs match TypeScript reference within documented numeric tolerance.
- Benchmark shows wall-clock improvement on representative crypto and IBKR workloads.

### Exit Criteria

- Rust miner is faster than optimized TypeScript on representative Stability workload after including transfer/read time.
- Fallback path remains functional.
- Parity differences are either zero or documented and accepted.

### Status (2026-07-09)

**Not done — blocked, and out of scope for this TypeScript repository.** No
Rust crate or Cargo workspace exists in this repo (confirmed at the start of
implementation). Phase 5 requires creating or identifying a Rust backend,
which is a separate codebase and deployment effort.

Everything the Rust backend needs to integrate is already in place on the
TS side: the Phase 4 wire contract (health/capability, file-manifest Mine +
Stability endpoints, `{ ok: false, reason }` fallback envelope), the compact
artifact schema it must decode (`COMPACT_MINER_ARTIFACT_SCHEMA_VERSION` +
`batch-miner-artifact.ts`), and the parity fixtures in
`tests/batch-miner-artifact.spec.ts` + `tests/batch-synthetic-state-miner.spec.ts`
that define the exact output the Rust port must reproduce. When a backend is
created, Phase 5 is unblocked with no further TS-side changes required beyond
flipping the compact-storage and Rust-routing gates on.

The performance case for Phase 5 is now concrete: the dominant
`candidateSamplesMs` (~83% of Stability) is not reducible in TypeScript. Phase
3 parallelism already cut Stability 74.2 s → 31.8 s by dividing that cost
across cores, but the per-core work is unchanged. A Rust/Rayon port that
reduces the per-sample cost (typed numeric primitives, no per-iteration
allocation) is the path to go below ~30 s. The bar to clear is "faster than
the Phase 3 parallel path end-to-end, including file-manifest read time."

## Phase 6: Rollout, Observability, And Documentation

### Objective

Make the accelerated miner usable, diagnosable, and reversible.

### Scope

Settings only if necessary, benchmark output, docs, and manual validation.

### Technical Tasks

- Add visible or diagnostic-only miner engine reporting:
  - `typescript`
  - `typescript_parallel`
  - `rust`
  - `rust_fallback`
- Extend Copy Benchmark bottlenecks to include:
  - artifact conversion cost
  - Rust transfer cost
  - Rust processing time
  - fallback reason
- Update `docs/batch-backtest-server-side.md`.
- Add troubleshooting notes:
  - Rust backend unavailable
  - schema mismatch
  - timeout fallback
  - high transfer time
  - worker memory pressure
- Keep user-facing controls minimal; do not add new tuning knobs unless benchmark shows the need.

### Dependencies

- Phases 1-5.

### Risks/Blockers

- Too much UI surface can make Batch harder to operate.
- Diagnostics can become misleading if Rust and TypeScript profiles use different phase names.

### Deliverables

- Updated docs.
- Benchmark schema update if needed.
- Manual smoke checklist.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-loader-parity.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- Manual server-side smoke:
  - start with adequate `NODE_OPTIONS`
  - run 200-pair crypto synthetic Batch
  - run Stability
  - copy benchmark
  - run Mine Timing
  - Stop during Stability
  - repeat with IBKR synthetic pairs
  - repeat once with Rust unavailable to verify TypeScript fallback
  - repeat once with Rust available if backend exists

### Exit Criteria

- Docs match implemented behavior.
- Benchmarks identify engine path and bottlenecks.
- User can revert to TypeScript fallback without losing Mine/Stability functionality.

### Status (2026-07-09)

**Done.** Engine reporting ships: every Stability result carries `engine`
(`typescript` | `typescript_parallel` | `rust` | `rust_fallback`) +
`rustFallbackReason`, surfaced in `phases.stability.engine` on the Copy
Benchmark. The benchmark schema gained `artifactConversionMs`,
`rustRequestMs/ProcessingMs/ResponseMs`, `analogCandidatesScored`,
`topKSelected`, and `assetIndexHits/Misses`. The bottlenecks builder surfaces
the Rust-fallback reason and the compact-conversion cost share.

Docs updated:
- `docs/batch-backtest-server-side.md` — full "Mine / Stability Miner
  Acceleration" section with the layer order, gate defaults + reasons, the
  Rust backend contract, and a troubleshooting table keyed on the `engine`
  field.
- `AGENTS.md` — "Mine / Stability Miner Acceleration" safe-change subsection
  with the gate-default rationale, the `timeKey` parity invariant, the
  esbuild worker-bundling note, and the validation habit command list.

Reversibility holds by construction: every accelerated layer has a
deterministic fallback (Rust → parallel TS → sequential TS), and the gates
(`setMinerGatesForTests` in tests; the `BATCH_MINER_*` constants in prod) let
any layer be disabled without losing Mine/Stability functionality. The
sequential TS path is always the final fallback and is parity-locked against
the parallel path.

## Failure Handling

- Rust unavailable: use TypeScript path and log fallback reason.
- Rust schema mismatch: use TypeScript path; include expected/actual schema in diagnostics.
- Rust timeout: cancel request, use TypeScript path only if artifacts are still available.
- Worker crash: cancel parallel run and retry sequential TypeScript once, or return fatal if retry risks duplicate long work.
- File-manifest Rust read failure: fall back to TypeScript and keep artifacts until fallback completes or TTL expires.
- Compact artifact schema mismatch: reject accelerated path before mining starts.
- Artifact TTL expiry: preserve existing "rerun Batch" behavior.
- Fingerprint mismatch: preserve existing fatal response.
- Stop during Mine/Stability: preserve owner-generation cancellation semantics.

## Performance Considerations

- Prioritize algorithmic reductions before runtime migration. **(Measured: algorithmic reductions (Phase 1) are real but <2% of Stability. The dominant cost (`candidateSamplesMs`, ~83%) is not reducible algorithmically in TS — only by parallelism (Phase 3) or Rust (Phase 5).)**
- Do not clone multi-GB artifacts into every worker. **(In place: workers read artifact FILES from disk, not structured-cloned objects. The OS file cache absorbs repeated reads across workers.)**
- Keep browser memory bounded; never send `data`, `signals`, or `result.trades` in Batch row streams. **(Unchanged — the scalar-only wire contract is preserved across all accelerated paths.)**
- Top-K selection targets O(N log K) or O(N) quickselect instead of O(N log N) analog sorting. **(Shipped: bounded max-heap, O(N log K), with original sample index as the explicit tie-breaker for V8-stable-sort parity.)**
- Asset/pair indexes remove repeated target-wide pair scans. **(Shipped: `buildPairsByAssetIndex` collapses O(targets × pairs) scans to O(1) lookups.)**
- Compact artifacts reduce GC pressure and Rust transfer size. **(Shipped but DEFAULT OFF — on the TS-only path the store-time conversion tax outweighs the GC/transfer benefit. Only pays off when a Rust backend reads the compact shape.)**
- Rust/Rayon parallelizes deterministic work units and returns compact results only. **(Not implemented — Phase 5 blocked, no Rust crate in repo.)**
- Worker-thread speedup must beat sequential TypeScript after worker startup, artifact load, and merge costs. **(Measured: 74.2 s → 31.8 s end-to-end including worker startup + per-worker artifact load + per-worker prepare + merge. The per-worker `preparePairsMs` is duplicated across workers but parallelized, and the `candidateSamplesMs` reduction dominates.)**
- Rust speedup is not accepted unless measured end-to-end from request start through response decode. **(Deferred to Phase 5; the bar to clear is the Phase 3 parallel path (~32 s), not the old sequential path (~74 s).)**

## Security Considerations

- Existing Batch server API is local Vite dev-server functionality.
- Execution Lab live trade is out of scope; do not expose wallet secrets or unrelated local data.
- Rust miner requests contain only Batch miner artifacts and target candles required for analysis.
- File-manifest handoff must be local-only. Do not allow arbitrary client-supplied paths; the plugin passes server-created temp paths only.
- Avoid adding remote network dependencies.

## Rollback Strategy

- Keep TypeScript miner as the reference path. **(In place: the sequential TS loop is the final fallback for every accelerated layer.)**
- Gate compact artifact consumption behind an internal fallback until parity is proven. **(Parity IS proven — `tests/batch-miner-artifact.spec.ts` round-trip passes. The gate is now off for a PERFORMANCE reason: store-time conversion regressed Run +89%. Re-enable alongside Phase 5.)**
- Gate worker/Rust execution behind capability checks. **(In place: `BATCH_MINER_PARALLEL_STABILITY_ENABLED` + the Rust router's capability probe + schema/transport gates. Tests toggle via `setMinerGatesForTests`.)**
- If accelerated path fails, fall back to sequential TypeScript without changing UI contracts. **(In place: Rust → parallel TS → sequential TS, each step deterministic. Output is byte-identical across all paths for a fixed seed.)**
- Revert documentation and benchmark schema only after code rollback if schema changes are shipped.

## Open Unknowns

- Location and ownership of the Rust backend source. **Status:** unresolved.
  No Rust crate or Cargo workspace exists in this repository; Phase 5 cannot
  proceed without one.
- Whether the Rust backend shares `http://127.0.0.1:3030` with the existing backtest engine or uses a separate endpoint namespace. **Resolved:** separate. The
  miner client defaults to `http://127.0.0.1:3031` (see
  `lib/batch-backtest/batch-rust-miner-client.ts`) and is intentionally
  decoupled from `lib/rust-engine-client.ts` (the backtest engine) because the
  transports differ (file-manifest vs inline JSON) and the miner must never
  receive multi-GB JSON payloads.
- Preferred Rust transport after benchmarking: local file manifest or binary request body. **Resolved (for TS-side contract):** file-manifest only.
  `buildFileManifestStabilityRequest(...)` passes server-controlled temp
  artifact paths; the router never sends artifact bytes inline. The Rust
  backend must advertise `transports: ["file_manifest"]` in its health
  response. Binary transport remains a contract option but is not exercised
  by the router today.
- Representative benchmark fixtures that can run in CI without huge local datasets. **Partially resolved:** the parity specs
  (`tests/batch-synthetic-state-miner.spec.ts`, `tests/batch-miner-artifact.spec.ts`,
  `tests/batch-stability-parallel.spec.ts`) use synthetic OHLCV fixtures to
  lock correctness, but the *performance* numbers in the Status table above
  came from the user's real 448-pair dataset, not a CI fixture. A CI-runnable
  perf fixture would still need to be added for regression detection.
- Acceptable numeric tolerance for Rust/TypeScript parity on borderline verdicts. **Unresolved** — deferred to Phase 5 once a Rust backend exists. The
  TS-only path is exact (parallel output is byte-identical to sequential).

## Lessons Learned (2026-07-09)

These are the implementation findings that changed the plan's assumptions.
Each is backed by a benchmark sample.

### 1. Store-time artifact conversion is paid on every Run

The plan assumed compact artifacts (Phase 2) would "avoid repeated object-heavy
reconstruction." In practice, converting at `storeMineArtifact(...)` time runs
`toCompactPairArtifact(...)` on every per-row result *during the Run phase*,
before Mine is ever clicked. On the 448-pair / 4H workload that is ~29M
`localTimeKey` string allocations + typed-array fills, and it made the Run
phase **+89% slower** (15,319 ms → 29,080 ms — benchmark sample #2). The
compact→raw reconversion at Mine load added another ~1.4 s
(`artifactConversionMs`).

Because no Rust backend exists, the compact shape is never read by anything
that benefits from it on the TS-only path. Net: ~13 s regression for zero
benefit. **The plan's own Phase 2 exit criterion — "artifact preparation time
and heap usage do not regress" — was violated.** Compact storage now defaults
OFF (`BATCH_MINER_COMPACT_ARTIFACTS_ENABLED=false`) and should only be enabled
when a Rust backend reads the compact shape via file-manifest handoff.

### 2. A TypeScript worker cannot load under `vite dev`

Phase 3 specified worker_threads but did not address that Node `worker_threads`
cannot evaluate `.ts` files. Under `vite dev` the server plugin runs in plain
Node with no TS-aware loader propagated to workers, so `new Worker("...ts")`
throws "Unknown file extension .ts" and the orchestrator silently falls back
to sequential every time — making the parallel path dead code. (The first
parallel benchmark sample showed `engine: "typescript"`, not
`typescript_parallel`, confirming it never engaged.)

**Fix:** `resolveWorkerPath()` in `batch-stability-parallel.ts` bundles the
worker to a self-contained `.cjs` via esbuild (already a transitive dep through
Vite) on first use, mtime-keyed so source changes re-bundle. The end-to-end
spawn test in `tests/batch-stability-parallel.spec.ts` locks this — it spawns
real workers via the bundled `.js` and would fail if the worker couldn't load.

### 3. The bottleneck is not reducible in TypeScript

The dominant cost is `candidateSamplesMs` (~60-62 s, ~83% of Stability on the
target workload). It scales with `candidateSamples` (1,503,544 on this
workload) × per-sample snapshot/outcome computation. Phases 1 (top-K, asset
index) and 2 (compact artifacts) do not touch it — they optimize sub-phases
totaling <2% of Stability. **Only parallelism (Phase 3, divides wall-clock) or
a Rust/Rayon port (Phase 5, reduces the work) can move it.** Since Phase 5 is
blocked on a Rust crate that doesn't exist, Phase 3 is the only available
intervention, and it delivered (74.2 s → 31.8 s).

### 4. Profile fields must be timed honestly on the parallel path

The first parallel benchmark showed `prepareTargetsMs: 0` and
`preparePairsMs: 0` because workers did not time their own prepare/load steps
— the per-worker prepare cost (each worker independently builds ATR/signal/
trade indexes for the full pair set) was hidden inside `runPreparedMs`.
Workers now time `prepareTargetsMs`, `preparePairsMs`, and
`artifactConversionMs` so the merged profile shows real per-worker cost. This
matters for diagnosing whether prepare dominates on smaller-rerun workloads
where the parallel speedup may not beat the duplicated prepare.

Current worker behavior precomputes the exact sampled pair indexes for each
assigned rerun and loads/prepares only the union of those sampled artifacts, not
the full pair set. This preserves seeded `sampleItems(...)` semantics while
avoiding full-universe artifact load in every worker.

`parallelWorkerCount` is recorded on the merged miner profile. Benchmark
diagnostics use it to convert summed worker CPU fields into wall-equivalent
estimates before comparing them with `phases.stability.totalMs`.
