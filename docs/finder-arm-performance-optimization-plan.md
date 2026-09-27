# Finder Arm Performance optimization plan

Status: Proposed; implementation has not started.

Scope: the server-owned Finder `arm_performance` path only. Implement the
three reviewed improvements in this order: omit annual replays, omit unused
detail outputs, then reuse workers across candidates. The first two changes
remove unnecessary work before changing resource lifetime.

See [Finder behavior](finder.md#arm-performance),
[server lifecycle](finder-server-side.md#arm-performance), and the
[retired feature delivery plan](finder-arm-performance-plan.md).

## Current architecture and assumptions

- `prepareFinderArmPerformanceRun` in `lib/finder/server/finder-vite-plugin.ts`
  validates the request and enumerates the pair list once. Its handler holds
  Finder and Batch/TOP_MEAN ownership for the entire sweep.
- `runFinderArmPerformance` in `lib/finder/finder-arm-performance-runner.ts`
  executes candidates sequentially. Each creates a `TopMeanCoordinatorEngine`
  with trusted enumeration and a frozen `evaluationNowSec`; resume and archive
  logging are disabled. Workers write compact pair artifacts, the coordinator
  replays them, and Finder retains scalar metrics for all 15 arms before
  removing the child directory.
- `lib/batch-backtest/sp500-top-mean-coordinator-engine.ts` currently computes
  a current-position snapshot, enables replay event details, writes
  `result.json`, and computes annual reports when `sampleFromSec` is supplied.
  Annual passes share target outcomes; identical explicit single-year windows
  already reuse the full-window result. Full-history runs without a From date
  have no annual passes to remove.
- `TopMeanWorkerPool.execute` in
  `lib/batch-backtest/sp500-top-mean-worker-pool.ts` reuses workers across
  shards, then calls `cancel()` on successful completion. A new candidate
  therefore starts new workers. Existing disk caches survive this boundary;
  worker-local loader and parsed-data caches do not.
- This is a source-based performance assessment, not a measured ranking.
  Benefits depend on dates, pair count, candidate count, and engine selection.
  A frozen cutoff does not freeze source files against corrections or syncs.

## Contracts and boundaries

Keep candidate order, all 15 comparisons, ranking/tie behavior, bootstrap
settings, coverage accounting, actual-engine reporting, and closed-candle
semantics unchanged. Preserve missing-data omissions and fatal execution
errors. Pair backtests continue to cover full history; date limits apply to
replay decisions, not pair loading or backtesting.

No UI, HTTP request/response, localStorage, database, or persisted schema
changes are planned. No new service, dependency, deployment step, or user
setting is needed. The local-route authorization, run-id Stop routing,
disconnect recovery, wire-safety caps, and shared owner locks remain intact.
Keep server imports free of browser-bound modules.

Use a single internal execution profile on `TopMeanCoordinatorEngineDeps`
(proposed name: `executionProfile: "finder_arm"`). The default preserves
standalone TOP_MEAN behavior. Only the trusted Finder runner supplies it;
do not expose a collection of browser/request flags. Do not infer the profile
from `saveArchiveLog: false`, which is also valid for standalone runs.

## Phase 0 — Establish parity and cost baselines

**Objective:** Measure the three costs and create a repeatable comparison.

**Tasks / deliverables:** Use fixed ordered pairs, generated plans, source
files, settings, and cutoff. Record full-history, explicit single-year, and
multi-year runs with several candidates. Capture the existing
`TopMeanPerformanceDiagnostic` phase timings, worker startup/load/prepare
timings, cache counters, wall time, aggregate process memory, and artifact
bytes. Capture compact candidate metrics and coverage. Use the existing
coordinator performance output through a test/benchmark harness; do not add
large diagnostic payloads to Finder's wire contract.

**Validation / exit:** Repeat cold- and warm-disk-cache samples and retain
baseline results. Use identical inputs for later comparisons. Include a
small deterministic fixture for exact scalar parity; live-data timing alone
cannot establish correctness. Rust comparisons require the optional Rust
service; record that check as unavailable if it cannot run.

## Phase 1 — Skip unused annual replay passes

**Objective:** Perform only the requested full-window replay for Finder.

**Tasks:** Pass the internal profile from `runFinderArmPerformance`. In
`TopMeanCoordinatorEngine.run`, bypass annual-window construction/execution
for this profile. Keep the full-window `runReplayForWindow` call and
`buildTopMeanHorizonSummaries` unchanged; return no annual reports for Finder.
Keep standalone annual behavior and single-year deduplication intact.

**Dependencies / risks:** Phase 0. Annual results are unused by
`buildCandidateResult`; verify this remains true at implementation time.
Do not change eligibility or date clipping inside the replay engine.

**Deliverables / validation:** Update
`tests/finder-arm-performance-runner.spec.ts` and
`tests/sp500-top-mean-server-plugin.spec.ts` to prove the profile is supplied,
multi-year Finder runs execute one replay, and ordinary TOP_MEAN still emits
annual reports. Compare all compact metrics and coverage against baseline.

**Exit:** Multi-year Finder removes annual work with identical candidate
results; full-history and standalone behavior remain unchanged.

## Phase 2 — Omit discarded detail and snapshot outputs

**Objective:** Reduce per-candidate allocations and output I/O.

**Tasks:** Under the same profile, pass `includeEventDetails: false` to
`runOpenScoreUsdReplay` in
`lib/batch-backtest/batch-open-score-usd-replay-engine.ts`. Its existing
guards already suppress event and ongoing-detail rows. Skip
`computeCurrentTopMeanSnapshot`, its event, and both snapshot/final
`result.json` writes in the coordinator. Keep the shared compact-artifact
corpus: replay target derivation and `noTradePairs` still need it.

Retain the existing `TopMeanResultSummary` contract, horizon comparisons,
warnings, performance counters, target boundaries, coverage, and terminal
status. Optional detail/snapshot fields can be absent. Retain manifests,
compact shard artifacts, durable write ordering, and child-directory cleanup;
these support execution and failure handling. Do not replace the disk-backed
pair pipeline with an unbounded in-memory result store.

Keep replay arm selection, concentration/exclusion diagnostics, bootstrap
calculations, and report generation unchanged in this phase. Archive staging
is already disabled for Finder; disabling it again is not an optimization.

**Dependencies / risks:** Phase 1. Audit coordinator success, failure, status,
and summary paths for assumptions that a snapshot or `result.json` exists.
Finder reattachment uses the parent's retained scalar state, not that file;
standalone persisted results must remain complete.

**Deliverables / validation:** Extend coordinator and runner tests to assert
no Finder snapshot event, detail arrays, or `result.json`, while compact
artifacts remain usable until replay finishes. Test success, replay failure,
Stop, cleanup failure, and parent reattach with earlier completed rows.
Run replay, horizon-summary, current-snapshot, and archive regression specs.
Compare exact scalar outputs and measure allocation/output-size reductions.

**Exit:** Finder retains every required metric and diagnostic without unused
detail persistence; standalone TOP_MEAN output and archive tests still pass.

## Phase 3 — Reuse workers across sequential candidates

**Objective:** Amortize worker startup and retain useful bounded data caches.

**Tasks:** Let the Finder runner own one sweep-scoped `TopMeanWorkerPool` and
lend it to sequential child coordinators through the existing dependency
injection seam. Standalone coordinators continue owning their own pool.
Extend the existing pool narrowly to support sequential executions; do not
add a generic scheduler or run candidate coordinators concurrently.

Separate successful task/write drainage from final worker termination.
`execute` must finish all tasks and durable shard writes before a child can
be cleaned. Reset per-execution manifest, retry, dedupe, failure, progress,
and engine counters; bind worker replies only to the active execution.
Update task/message types in `sp500-top-mean-worker.ts` with an execution
identity if needed to reject late replies when shard indexes are reused.
Keep listeners and queues from retaining previous child state.

The runner owns final termination in `finally`, before returning control to
the plugin's owner-release path. Stop/fatal errors cancel and drain the whole
pool; they never return a failed pool to another candidate. Between children,
including artifact cleanup, parent cancellation must still reach the borrowed
pool. Keep the child Stop id registered through cleanup. Make the distinction
between child drainage and sweep teardown explicit in the runner/coordinator
interfaces and their test doubles; do not silently weaken `waitForTeardown`.

Audit cache lifetime in `server-batch-data-loader.ts`,
`batch-dataset-loader-core.ts`, `synthetic-pair-disk-cache.ts`, and
`server-ibkr-csv-loader.ts` before retaining caches across candidates.
Validate source freshness at the candidate boundary and invalidate affected
entries using the existing fingerprint/loader mechanisms. Refresh any
worker-local memo whose original lifetime assumed one candidate. If safe
selective invalidation is unavailable, clear those caches between candidates
and retain worker-startup savings first. Do not silently freeze mutable data.

Preserve existing worker-count and cache budgets from
`server-batch-cache-budget.ts`; do not retain all pair datasets. Add no new
prepared-candle or signal cache initially. Warm worker reuse does not by
itself eliminate candle preparation or guarantee LRU hits for large sweeps.
Candidate grouping by shard and cross-candidate outcome caches are deferred:
they change scheduling or invalidation contracts beyond this first fix.

**Dependencies / risks:** Phases 0–2. Pool free-list/listener state currently
lives inside `execute`, so its reusable lifetime needs a targeted extraction
within the existing class. Late replies, cancellation between children,
stale source data, and memory retained during replay are the primary risks.
Default-enable reuse only after measurements establish benefit within the
existing memory budget.

**Deliverables / validation:** Extend worker-pool, worker, Finder runner, and
Finder server tests. Prove worker reuse across two candidates, isolated
settings/results/counters, bounded listeners/cache retention, source-change
invalidation, retry dedupe, all-workers-dead settlement, Stop during replay
and cleanup, and complete final termination before owner release. Preserve
standalone resume/shard ordering and durable-write tests. Update
`docs/finder-server-side.md` to explain the new lifetime after implementation.

**Exit:** Identical results on fixed data; fewer spawned workers across a
sweep; measured startup/load benefit without unacceptable peak memory or
Stop/reattach regressions. Record cache hit rates rather than claiming all
dataset loading/preparation has been removed.

## Validation and rollout

After each implementation phase run `npm run typecheck` and the affected
specs via `..\..\..\node_modules\.bin\esno tests\<name>.spec.ts`.
Core suites: `finder-arm-performance-runner`,
`finder-arm-performance-metrics`, `finder-server-plugin`,
`sp500-top-mean-server-plugin`, `sp500-top-mean-worker-pool`,
`sp500-top-mean-worker`, `sp500-top-mean-horizon-summary`,
`batch-open-score-usd-replay-engine`, and `batch-open-score-usd-max-active`.
Phase 2 also runs snapshot/archive specs; Phase 3 runs loader parity and
synthetic-pair disk-cache/IBKR loader specs.

Smoke-test a multi-candidate sweep on 50 pairs, then 1,000 pairs with
`NODE_OPTIONS=--max-old-space-size=16384` or higher. Check progress, Stop,
reload reattach, Copy, Apply, coverage, and actual engine mode. Start Vite to
catch server import/bundle regressions. Repeat the Phase 0 measurements;
report speedup and memory by workload, with skipped checks explicitly noted.

Land each phase separately. Roll back phases 1–2 by removing the Finder
profile opt-in; ordinary coordinator behavior remains the default. Roll back
phase 3 independently to candidate-owned pools, preserving the first two
savings. No data migration is required. Do not resume a partially evaluated
child or reuse artifacts across different candidates as a rollback shortcut.
