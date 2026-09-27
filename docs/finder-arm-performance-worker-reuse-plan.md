# Finder Arm Performance worker reuse plan

Status: Phases 1-2 implemented; Phase 3 deferred (reuse already removes the measured cold-load cost that Phase 3 targeted).

Scope: finish finding 2, repeated worker initialization and lost data-cache
reuse between Finder Arm Performance candidates. This updates the remaining
worker-reuse work in [the optimization plan](finder-arm-performance-optimization-plan.md).
That document's pre-implementation architecture is historical: the Finder
profile already skips annual replays, snapshots, event details, and result
JSON writes. Do not redo those changes.

## Current architecture

- `lib/finder/server/finder-vite-plugin.ts` calls `runFinderArmPerformance`
  without `enableWorkerReuse`; production still creates candidate-owned pools.
- `lib/finder/finder-arm-performance-runner.ts` already supports one borrowed
  `TopMeanWorkerPool` for sequential candidates when that flag is true. Its
  abort listener and `finally` own cancellation and `dispose()` before the
  plugin releases ownership. Candidate cleanup retains the child Stop id.
- `lib/batch-backtest/sp500-top-mean-coordinator-engine.ts` accepts the pool
  through `TopMeanCoordinatorEngineDeps.pool`. Standalone coordinators own
  their pools; Finder children must not terminate a borrowed pool on success.
- `TopMeanWorkerPool.execute` rebinds per-execution handlers and awaits
  `clear_caches` / `caches_cleared` before dispatching a reused worker. These
  messages are handled in `sp500-top-mean-worker.ts`.
- `clearServerBatchDatasetCaches` in `server-batch-data-loader.ts` clears
  loader caches, the seed fingerprint memo, and shared `DataCache`. It does
  **not** clear `server-ibkr-csv-loader.ts`'s bounded columnar parsed-seed
  caches, which validate file mtime on lookup. Existing worker reuse therefore
  preserves more than startup alone: unchanged IBKR seeds can avoid reparsing.
- Higher-level leg/pair hits in `batch-dataset-loader-core.ts` precede disk
  fingerprint validation. Removing the reset would permit stale datasets.
  `createSeedFingerprintMemo` also needs refresh across candidate boundaries.

Data flow remains: server handler -> sequential Finder runner -> borrowed
coordinator pool -> worker dataset load/backtest -> durable compact shards ->
coordinator replay -> scalar candidate result -> child cleanup. Workers live
through replay and cleanup until the sweep ends; no concurrent candidates.

## Constraints and unknowns

Keep all 15 arm metrics, settings, candidate ordering, frozen evaluation
cutoff, retries, coverage, Stop, reattach, and standalone TOP_MEAN behavior.
Do not cache signals, trades, prepared candles, or replay outcomes across
candidates. A frozen cutoff does not freeze source data against corrections.

Use existing worker-count and memory policies. `resolveServerBatchCacheBudget`
currently allows 24/16 leg/pair entries, or 128/32 on machines with at least
48 GiB RAM. Do not increase these limits. Retained workers overlap with the
coordinator's replay memory, so peak memory must be measured across phases.

Unknowns: actual startup versus load cost, LRU effectiveness on large sweeps,
and the benefit of retaining higher-level arrays beyond parsed IBKR seeds.
CSV mtime and SQLite series metadata are existing freshness signals, not a
transactional snapshot or a guarantee against same-mtime external rewrites.
Preserve existing freshness semantics; do not claim snapshot isolation.

No public HTTP, UI, localStorage, database/schema, or infrastructure changes.
Keep loopback authorization, owner locks, and server-only import hygiene.

## Phase 1 — Measure the existing safe reuse path

**Objective:** Establish whether enabling the implemented pool is sufficient.

**Tasks / deliverables:** Add a focused benchmark harness using the runner's
existing `enableWorkerReuse` input and coordinator dependency seam. Compare
false/true with identical plans, ordered pairs, source data, cutoff, settings,
and worker count. Exercise several candidates on 50 and 1,000 pairs, cold
and warm disk caches, TypeScript and Rust where available. Preserve the cache
reset handshake. Capture existing coordinator/worker performance diagnostics,
spawn counts, load times, cache counters, wall time, and peak process RSS /
external memory. Do not expand Finder's wire payload for benchmarking.

**Validation:** Exact scalar-result and coverage parity on deterministic
fixtures; source changes between candidates must be visible. Exercise Stop
during backtesting, replay, cache reset, and cleanup; fatal worker exits,
retry drainage, listener growth, and final worker termination. Extend existing
runner/pool specs rather than replacing their lifecycle implementation.

**Risks / exit:** Reuse may reduce startup yet increase peak memory or show
little benefit on backtest-heavy workloads. Record repeatable results and
unavailable checks. Proceed to enabling only if parity holds and timing
improves beyond run-to-run variation within the existing memory budget.

## Phase 2 — Enable measured worker reuse in the server caller

**Objective:** Deliver the existing startup and parsed-seed savings safely.

**Tasks / deliverables:** After Phase 1 passes, supply
`enableWorkerReuse: true` in the Arm Performance handler's runner input in
`finder-vite-plugin.ts`. Keep the runner's opt-in default for other callers
and tests. Keep the existing reset/ack protocol, ownership, and disposal.
Update `docs/finder-server-side.md` with the enabled lifetime and measurements.
Correct comments that imply all loader caches survive candidate transitions.

**Validation / exit:** Extend `tests/finder-server-plugin.spec.ts` to verify
the production opt-in and owner release after teardown. Run multi-candidate
smokes with progress, scoped Stop, reload reattach, Copy, Apply, and subsequent
runs. Results must match Phase 1; no worker may survive sweep termination.
Start Vite to catch transitive Node bundle/import regressions.

**Rollback:** Remove the caller opt-in to restore candidate-owned pools.
The Finder execution profile savings remain enabled; no migration is needed.

## Phase 3 — Retain higher-level caches only if load cost still warrants it

**Objective:** Avoid repeated dataset materialization without serving stale
leg/pair arrays. Depends on Phases 1–2 showing material remaining load cost.

**Tasks:** Extend the existing worker boundary handshake to ask the server
loader to validate its previously used source identities before dispatch.
Keep unconditional reset as the fallback. Reuse fingerprint primitives from
`synthetic-pair-disk-cache.ts`; expose a narrow server-only helper if needed,
without changing the persisted disk-cache format.

Track actual resolved source symbol/interval identities from the loader,
including the 30m seeds used for IBKR 4H ratios. Obtain a fresh source-version
map each boundary, without the previous candidate's fingerprint memo. Compare
CSV-backed versions or SQLite `lastTime`, `barsCount`, and `updatedAt` using
the current source-selection rules. Establish versions before first use so
a change during the prior candidate cannot be mistaken for unchanged data.
Include direct-symbol loads; do not assume every input is a synthetic pair.

Start conservatively: retain the existing bounded loader LRUs only when all
tracked sources are verifiably unchanged. If any source changes, disappears,
cannot be versioned, or metadata lookup fails, clear all higher-level caches
and shared DataCache using the current reset. Refresh fingerprint memo state
even when arrays are retained. Bound/reset source bookkeeping per candidate;
do not accumulate an unbounded sweep history or add selective dependency
eviction. Keep general DataFetcher fallback caching cleared unless its source
identity and freshness can be established. If this cannot be isolated safely,
retain Phase 2's unconditional reset instead of weakening freshness.

**Affected modules / contract:** `server-batch-data-loader.ts` owns boundary
validation; `batch-dataset-loader-core.ts` may need a narrow optional hook to
report actual source identities, with unchanged defaults for browser/Batch
callers. Worker and pool message types carry the boundary request/ack. The
ack means validation/reset completed, not merely that a message was received.
Worker death or Stop must settle pending acknowledgements before teardown;
late replies must not release another candidate's work.

**Validation:** Add unchanged-source cache-hit parity, CSV update/deletion,
SQLite same-count correction, unavailable metadata, direct symbols, mixed
sources, and fallback-path tests. Update worker-pool reset expectations to
distinguish validation from clearing. Preserve synthetic construction order
(ratio at seed interval, then aggregate), stale-fragment thresholds, and
browser/server loader parity. Repeat Phase 1 timings including validation
overhead; do not assume a small LRU retains an entire universe.

**Exit / rollback:** Enable retention only with identical fixed-data results,
fresh results after source changes, bounded memory, and a measured net gain.
Restore unconditional `clear_caches` behavior independently of pool reuse if
validation or performance fails. No new service, sync lock, or source-snapshot
system is part of this work.

## Required checks during implementation

Run `npm run typecheck`, `npm run typecheck:tests`, and affected specs with
`..\..\..\node_modules\.bin\esno tests\<name>.spec.ts`:

- Lifecycle: `finder-arm-performance-runner`, `finder-server-plugin`,
  `sp500-top-mean-worker-pool`, `sp500-top-mean-worker`,
  `sp500-top-mean-server-plugin`.
- Results: `finder-arm-performance-metrics`, `sp500-top-mean-horizon-summary`,
  `batch-open-score-usd-replay-engine`.
- Cache changes: `synthetic-pair-disk-cache`,
  `batch-backtest-server-loader-parity`, plus the existing IBKR/crypto loader
  specs for any touched freshness paths.

Use `NODE_OPTIONS=--max-old-space-size=16384` or higher for large server
smokes; this does not replace measuring aggregate worker and replay memory.
Report skipped tests explicitly, especially catalog-dependent integration
tests and optional Rust checks. Land enabling and additional cache retention
separately so either can be rolled back without losing the other improvements.


## Outcome (2026-09)

Phase 1 harness: `scripts/bench-finder-arm-worker-reuse.ts`
(`npm run bench:arm-worker-reuse`). Real `runFinderArmPerformance`, real
enumeration over IBKR 30m seeds, fixed evaluation cutoff, seeded random mode,
pinned worker count. Parity = deterministic fields only (`events`, `topMean`,
coverage, params): `randomMean`/`delta` are the stochastic uniform-random
control and drift by float epsilon per invocation on BOTH sides of the flag,
so they are excluded rather than smoothed.

Measurements (TS engine, 4 workers):

| Scenario | reuse=false | reuse=true | Delta |
|---|---|---|---|
| 2 pairs x 2 candidates | 762 ms | 613 ms | -20% |
| 50 pairs cold x 3 candidates | 4,803 ms | 3,803 ms | -21% |
| 50 pairs warm x 3 candidates | 4,145 ms | 3,738 ms | -10% |
| 1,000 pairs cold x 3 candidates | 93,893 ms | 80,060 ms | -15% |

Reuse runs spawn 0 additional workers after the first candidate; 1,000-pair
candidate-0 data load drops 42.7 s -> 1.9 s (retained mtime-validated
parsed-seed caches). Peak RSS comparable (0.9-1.2 GB both modes). Rust-engine
runs were not measured (no Rust binary available in the benchmark
environment) — the one unavailable check from the matrix above.

Phase 2: `enableWorkerReuse: true` at the production call site in
`lib/finder/server/finder-vite-plugin.ts`, locked by
`tests/finder-server-plugin.spec.ts` (production opt-in + runner default
stays off). Rollback = remove the single caller flag.
