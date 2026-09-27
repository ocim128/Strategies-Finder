# TOP_MEAN Coordinator Optimization Plan

Status: PLANNED. Implementation has not started.

## Scope and assumptions

This plan covers all three ideas from the latest performance review:

1. Reuse long outcomes computed during diagnostic traversal for selector evaluation.
2. Share candidate-pool validation and return totals across selector arms.
3. Serialize shard artifacts in workers and transfer their bytes to the coordinator.

Implement them as separate changes after a common baseline. The phase order below starts with the smallest change (#2), followed by #1 and #3; none is omitted.

The intended result is less aggregation work with identical research output. No speedup is claimed yet; the latest coordinator changes need a fresh baseline. The replay engine is also used outside TOP_MEAN, so its existing callers must retain identical behavior.

## Current architecture

- [Coordinator](../lib/batch-backtest/sp500-top-mean-coordinator-engine.ts): `runReplayForWindow` invokes `runOpenScoreUsdReplay` for full-window and annual reports. Existing shared artifact and target-outcome caches remain in place; no orchestration redesign is required.
- [Replay engine](../lib/batch-backtest/batch-open-score-usd-replay-engine.ts): target outcomes populate `returnsByView`; `usableCandidates` and the gap-filtered event views establish the usable pools and picks before horizon aggregation.
- Inside each horizon, `appendProfitArms` and `appendSingleCausalArm` independently validate pool returns, allocate a temporary return map, and sum its values. The same `profitNowPositives` pool is evaluated four times: TOP raw/mean, TOP_Z, BOT raw/mean, and BOT_Z. This occurs for ordinary views and profit-only events.
- Both appenders emit ongoing details before eligibility gates. Completed selections feed series, per-asset samples, comparisons, dominant-asset exclusions, and opaque `reportLines`.
- The diagnostic target loop computes directional outcomes with `computeDiagnosticOutcome`. The subsequent request loop independently resolves the entry bar and constructs a selector outcome record, storing it in `outcomesByEventTimeSec`. This duplicates long-side work for overlapping requests.
- [Worker](../lib/batch-backtest/sp500-top-mean-worker.ts): `processTopMeanShard` returns compact artifact objects; `postResult` sends them in `TopMeanWorkerMessage.shard_complete`. The [worker pool](../lib/batch-backtest/sp500-top-mean-worker-pool.ts) receives a structured clone and calls `writeShardArtifactsAsync`. The [artifact store](../lib/batch-backtest/sp500-top-mean-artifact-store.ts) synchronously stringifies the objects before asynchronous file writing and rename.

## Shared pool evaluation design (idea #2)

Keep the change inside the engine's horizon aggregation and its focused tests. Add a small local pool evaluator shared by the two existing appenders; do not create a service, exported API, or general cache framework.

For each event/horizon, evaluate a specific pool once and retain only its validity, count, and return total. The evaluator checks the existing minimum size, gap guard, and finite-return requirements in candidate order. Pass that evaluation explicitly to the appenders. Read selected returns from the existing `perAssetOutcomes` map and keep the existing candidate lookup for detail rendering. Verify pool uniqueness at its construction sites before using `pool.length` in place of the former map size.

Compute one evaluation for `profitNowPositives` and share it across its four appender calls. Full-window profit and confidence pools remain independent; their single-use evaluations may use the same helper. Construct these small values inside each event iteration, not in a run-wide map. Do not touch ordinary-positive or tie-restricted control calculations.

Preserve these contracts exactly:

- Evaluation identity includes event, horizon, and the actual filtered candidate pool. Never reuse a result across years, horizons, or different pool membership.
- Keep existing gap filtering and pick re-resolution. Missing or nonfinite returns in the remaining pool omit the completed event; never zero-fill or choose a substitute winner.
- Keep raw/mean paired-pick gates and single-pick gates in their respective appenders.
- Emit ongoing rows before returning for an invalid completed-event pool.
- Preserve the control formula `(poolTotal - selectedReturn) / (poolCount - 1)` and accumulation order, avoiding floating-point changes.
- Preserve selection ordering, ties, long-side returns, per-asset breakdowns, dominant exclusions, archive details, and `reportLines` verbatim.

## Phase 1: Lock behavior and measure the baseline

**Objective:** establish output parity cases and measure costs for all three changes.

**Tasks and deliverables:** extend [the replay spec](../tests/batch-open-score-usd-replay-engine.spec.ts) only where existing coverage is insufficient. Use deterministic fixtures for the four callers sharing a causal pool, both ordinary and profit-only events, multiple horizons, and independent profit/confidence pools. Capture expected comparisons, selected assets, completed/ongoing details, and report lines from the current implementation.

Include missing returns, right censoring, single-member pools, unusable picks, ties, and gap-filtered pools. A candidate censored at a longer horizon must not invalidate a shorter horizon. An ongoing selected trade must remain visible even when its completed comparison is omitted.

Also capture diagnostic records with diagnostics enabled and disabled, cache reuse across annual windows, and the persisted JSON shape of worker artifacts. Preserve representative fixtures with optional fields, Unicode symbols, and nonfinite numbers so byte serialization keeps existing `JSON.stringify` semantics.

**Dependencies and risks:** use existing Chai and `node:test` patterns. Baselines must come from fixed artifacts, datasets, settings, and cutoff time; changing market data makes timing and parity comparisons unreliable.

**Validation and exit criteria:** fixtures pass before implementation; a representative unchanged run records `aggregateMs`, `outcomesMs`, backtesting/replay wall time, and, when available, allocation/GC and event-loop-delay observations. Measure serialization/transfer/write separately in a focused benchmark: current `artifactMs` does not isolate all those costs. Confirm candidate asset indexes are unique within each evaluated pool. Do not add a flaky wall-time assertion to unit tests.

## Phase 2: Share evaluation within each event/horizon

**Objective:** remove repeated pool scans and temporary return maps.

**Tasks:** implement the local evaluator; thread its result through `appendProfitArms`, `appendSingleCausalArm`, and the confidence wrapper. Update both the ordinary-view loop and `gapFilteredProfitOnlyEvents` loop. Share only evaluations for the same pool. Remove only maps and variables made unused by this change.

**Dependencies:** Phase 1 fixtures and the uniqueness check. If uniqueness does not hold, preserve the existing map's deduplication semantics rather than changing counts or totals.

**Risks:** early returns can accidentally suppress ongoing rows; sharing across unequal pools changes controls; altered summation order can change bootstrap results. Keep these behaviors explicit instead of unifying the appenders themselves.

**Deliverables and exit criteria:** engine-only implementation plus focused regression tests; all Phase 1 expected outputs remain exact. No selector registration, result shape, coordinator cache, or persistence changes.

## Phase 3: Reuse diagnostic long outcomes (idea #1)

**Objective:** avoid repeating entry lookup and long-side return calculations for events that diagnostics and selectors both consume.

**Tasks:** in the replay engine's per-target diagnostic loop, identify requested event timestamps from the existing request indexes. For those timestamps, construct the existing selector outcome record from the resolved entry bar and diagnostic long results, and place it in the existing `outcomesByEventTimeSec` cache. The subsequent request loop consumes that record normally. Retain its current calculation path when diagnostics are disabled or no matching record exists. Keep short diagnostic computation and archive emission unchanged.

Use only a per-target timestamp lookup if needed; do not add a global cache. Cache only selector-requested events, not every diagnostic row. Inspect `computeDiagnosticOutcome` against the current record builder before sharing arithmetic: archive nulls, selector NaNs, exit timestamps, and status precedence must retain their respective representations. Compute censored mark-to-market fields using the existing formula; diagnostic realized returns cannot supply them. A missing entry remains the existing null cache entry, distinct from an absent cache key.

**Dependencies:** Phase 1 baselines and the existing shared outcome-cache contract. No dependency on Phase 2's appender changes beyond integrating and testing both.

**Risks:** conflating no-entry with invalid-price or censored outcomes; caching results for a target excluded by a window-specific gap; accidentally retaining diagnostic-only records. Preserve the current gap checks, fallback loads, cache keys, costs, horizon ordering, cancellation/yield behavior, and bounded per-target lifetime.

**Deliverables:** localized replay-engine changes and focused replay-spec coverage. No coordinator option, archive schema, or public replay API change is needed.

**Validation and exit criteria:** diagnostics-on and diagnostics-off runs produce identical selector output; archive rows retain their exact values/order; full-window and annual cached/uncached results match for no-entry, invalid-price, censoring, gaps, and multiple horizons. A focused profile confirms that overlapping requests no longer repeat long-return computation and entry lookup.

## Phase 4: Transfer serialized shard bytes (idea #3)

**Objective:** remove artifact object cloning and JSON serialization from the coordinator's shard-completion path.

**Tasks and data flow:**

1. Keep `processTopMeanShard` returning objects for direct callers. In worker `postResult`, serialize its artifact array once with `JSON.stringify`, encode UTF-8 into a dedicated owned `ArrayBuffer`, and include that buffer in `postMessage`'s transfer list. Do not transfer a pooled Node Buffer's backing slab or reuse the detached buffer afterward.
2. Change the internal `TopMeanWorkerMessage.shard_complete` payload from artifact objects to serialized bytes; leave progress, engine usage, and performance fields intact. Ensure serialization/encoding/posting exceptions reach `postError`: a throw in the fulfillment handler of the current `.then(success, failure)` is not caught by its sibling failure handler.
3. Add a narrow byte-writing entry point in the artifact store. Reuse the existing asynchronous atomic-write implementation by extracting only its shared write/rename core as needed. Keep the same path construction, temporary-file placement, Windows retry policy, cleanup, and original-error propagation. Existing JSON writers remain wrappers with unchanged semantics.
4. Have the pool await that byte write without decoding or parsing it. Update the injected write seam and fixture workers together. Derive destination paths from coordinator-owned run/shard identifiers, not from a path supplied in the payload.

**Affected tests:** [worker spec](../tests/sp500-top-mean-worker.spec.ts), [pool spec](../tests/sp500-top-mean-worker-pool.spec.ts), and the helper workers under `tests/helpers/top-mean-*.cjs` that emit `shard_complete`. Inspect all message producers and writer-seam callers before changing the internal contract. Avoid a permanent dual payload protocol solely to preserve test fixtures.

**Dependencies:** Phase 1 persistence baseline; worker, pool, store, and fixture changes must land together. This phase is independent of the replay optimizations.

**Risks and error handling:** moving serialization to workers may increase worker CPU/temporary memory; measure the net effect. Keep a worker occupied until persistence succeeds, preserving bounded in-flight writes. A shard enters `completedShards` only after a successful atomic rename; write failures retain the existing retry and deduplication path. Stop, worker death, queued-task drain, final manifest flushing, and resume must remain valid. Serialized bytes are internal trusted-worker data; no new external endpoint or path authority is introduced.

**Deliverables and validation:** transferable-byte protocol and byte writer; tests for equivalent parsed shard JSON, optional/nonfinite value semantics, empty shards, worker serialization failure, disk-write failure/retry, worker exit, Stop, and resume. Include an actual worker-message test so structured cloning of an ordinary object cannot accidentally replace transfer unnoticed.

**Exit criteria:** persistence/retry tests pass; existing shard readers consume the output without changes or migration; a focused profile shows no coordinator-side artifact stringify/object clone. Record serialization, transfer, persistence time, and peak memory before claiming a whole-run improvement.

## Phase 5: Verify integration and performance

**Objective:** confirm equivalent output and a useful reduction in aggregation work.

Run from the repository directory:

```powershell
npm run typecheck
..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-replay-engine.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-max-active.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-horizon-summary.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-worker.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-worker-pool.spec.ts
```

Repeat the fixed baseline workload after each change and after integration under matching runtime conditions, separating warm-up from measured runs. Compare full-window and annual outputs excluding timing metadata, diagnostic archive rows, and parsed shard artifacts. Inspect aggregate/outcome time, backtesting wall time, event-loop delay, and allocation/GC evidence. The expected reductions are four causal-pool evaluations to one, no repeated long-outcome calculation for overlapping requests, and no coordinator artifact stringify/object clone; none guarantees a particular whole-run speedup. Smoke-test Stop and resume with a multi-shard run.

**Deliverables and exit criteria:** passing checks, exact research-output and persistence parity, and recorded before/after measurements for all three changes. Investigate reproducible timing or memory regressions before shipping. If a representative dataset is unavailable, report performance as unverified rather than claiming an improvement.

## Operational impact and rollback

No database, persisted schema, network API, UI, infrastructure, or security-policy changes are needed. The worker's internal message payload changes, so worker producer and pool consumer must be deployed together through the existing worker bundle flow. Existing archive and wire-safety contracts remain unchanged. Invalid outcome handling remains omission under existing rules, not a new exception or fallback path.

Keep the three ideas in separate changes for independent rollback. Revert replay changes locally; revert worker producer, pool consumer, byte writer, and fixtures together for the transport change. No saved-data migration or artifact invalidation is required because the persisted JSON format stays the same.
