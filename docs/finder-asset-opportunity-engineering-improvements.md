# Finder Asset Opportunity Engineering Improvements Plan

Status: Implemented (2026-08-15) · Branch: `feat/asset-opportunity-improvements` (temp worktree off `chore/complexity-reduction` @ `c7fd902`) · Scope: server-side Finder Asset
Opportunity **single + batch** runs (iteration leaf, server IS search, dataset loader, worker pool, Vite
plugin) plus the browser Asset Opportunity stream consumer.

Companion to [finder-asset-opportunity-batch-parallelization.md](finder-asset-opportunity-batch-parallelization.md)
(shipped 2026-08-14). This plan covers seven follow-up improvements identified by reading that shipped
code. Per `docs/README.md` maintenance rules: this document is a plan, not a durable guide — the
durable contracts have been folded into `finder-server-side.md` / `AGENTS.md`; delete this file once
the branch is reviewed and merged.

## Problem

Seven defects/inefficiencies in the Asset Opportunity pipeline, listed by ROI. All evidence is from the
current code at branch `chore/complexity-reduction`.

1. **Quadratic exit-param regeneration (server IS search).** With Exit Strategy Override active,
   `runServerAssetIsSearch` (`lib/finder/server/server-asset-is-search.ts:191-209`) regenerates and
   normalizes the FULL exit param space **inside the per-candidate loop**: one `generateParamSets`
   call per candidate, each building up to `maxRuns` param objects → O(maxRuns²) allocations per
   asset-strategy pass. Both sibling paths already cache this per exit lib: the browser runner
   (`lib/finder/finder-runner.ts:130-143`, `exitParamSetsByKey`) and the Universe server runner
   (`lib/finder/finder-runner-universe.ts:441-453`, comment: "Cache each exit lib's normalized param
   space so we don't regenerate it per entry set"). The Asset leaf never got the cache. The cost is
   also invisible to diagnostics: the exit-sampling block sits before `const candidateStartedAt`
   (line 210), so it lands in neither `parameterGeneration` nor `backtest` timings.

2. **No dataset cache across batch holdout iterations.** Each holdout iteration re-loads every symbol
   (`scheduleAssetLoad`, `lib/finder/server/asset-opportunity-iteration.ts:379-396`). Cross-iteration
   reuse exists only for synthetic legs/pairs (`assetLoadContext`), and the shared `DataCache`
   (`lib/data/data-cache.ts`) is capped at `MAX_CACHE_ENTRIES = 64` — sequentially scanned universes
   > 64 symbols thrash that LRU at ~100% miss rate. Meanwhile the worker-count policy already
   budgets ~9 MB/symbol per worker for "one full dataset copy" that no cache actually materializes.

3. **Rust-engine worker-count clamp documented but not implemented.** AGENTS.md: "Rust-engine runs
   should use fewer workers (4–8) — the external Rust HTTP server serializes."
   `resolveAssetOpportunityBatchWorkerCount` (`lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts:81-123`)
   considers only env override, holdout count, cores − 2, and the memory ceiling;
   `processFinderAssetOpportunityBatchRun` (`lib/finder/server/finder-vite-plugin.ts:1336-1338`) does
   not thread `useRustEnginePreference` into it.

4. **Unthrottled progress stream events.** ~4 `asset_progress` / `asset_batch_progress` events per
   (asset × strategy) pass are written to the NDJSON stream and mirrored onto the snapshot
   (`finder-vite-plugin.ts:1000-1017`, `1379-1406`, `1461-1480`). A 20-holdout × 1,000-symbol ×
   5-strategy batch emits ~400k events (~100 MB) for a UI that shows one aggregate percentage.

5. **JSONL run-log: two syscalls per event.** `appendFinderRunLogEvent`
   (`lib/finder/server/finder-run-log.ts:74-90`) does `mkdir(recursive)` + `appendFile` per event;
   the sink (`buildFinderRunLogSink`, plugin line 2374) fires per `asset_complete`/`asset_failed`.
   Large batches emit ~100k events → ~200k syscalls, half of them redundant mkdirs.

6. **Browser re-sorts + fully re-renders per streamed row.** Single-run `onAssetComplete`
   (`lib/finder-manager.ts:2563-2581`) sorts the accumulated provisional set and calls
   `renderLatestResults()` per streamed opportunity → O(n² log n) cumulative comparisons plus n full
   DOM rebuilds. Terminal correctness is already protected by `onAssetDone` (re-sorts + persists the
   authoritative set), so provisional rendering is coalescable.

7. **Archive-loop redundancy + diagnostics accuracy.**
   `completeOrderedIteration` (plugin lines 1248-1277) calls
   `buildAssetOpportunityForwardOosBaseline(iteration.results)` once per sort metric (14×/iteration)
   though it is a pure function of the unchanged results array. `diagnostics.oosEvaluations = 1`
   (`lib/finder/finder-asset-opportunity-runner.ts:911`) overwrites the `+= 1` from the fixed-holdout
   branch (line 886) when both OOS modes are active. Asset Opportunity routes reuse
   `resolveFinderUniverseHeapWarning` whose 507 message says "Finder Universe" on asset runs
   (`lib/finder/server/finder-server-heap-guard.ts:51-55`, plugin line 1610).

## Scope and Non-goals

- **In scope:** the seven items above, implemented as seven independently shippable phases.
- **Non-goals:** no changes to search semantics, grading, archive formats, stream event schemas,
  route authorization, the sequential-batch rollback path, or the Rust engine client. No new
  abstractions beyond one cache field, one helper export, one buffered sink, and one throttle helper.

## Implementation Phases

Phases are ordered by ROI and are independent unless noted. Each can land as its own commit.

### Phase 1 — Hoist and cache exit-param-space generation (server IS search)

- **Objective:** make exit-override Asset Opportunity runs linear instead of quadratic in `maxRuns`,
  matching the browser and Universe runners.
- **Tasks:**
  1. In `lib/finder/server/server-asset-is-search.ts`, add a lazy per-run cache above the candidate
     loop, mirroring `finder-runner.ts:130-143`:
     ```ts
     const exitParamSetsByKey = new Map<string, StrategyParams[]>();
     const getExitParamSets = (selection: FinderSelectedStrategy): StrategyParams[] => {
         const cached = exitParamSetsByKey.get(selection.key);
         if (cached) return cached;
         const exitDefaults = getFinderStrategyParamDefaults(selection.strategy);
         const normalized = normalizeFinderCandidateParamSets(
             selection.strategy, input.generateParamSets(exitDefaults, options));
         const paramSets = normalized.length > 0
             ? normalized : [{ ...selection.strategy.defaultParams }];
         exitParamSetsByKey.set(selection.key, paramSets);
         return paramSets;
     };
     ```
  2. Replace the in-loop generation (lines 199-204) with `getExitParamSets(exitStrategy)` and keep
     the `index % length` deterministic selection unchanged (documented server-side sampling rule).
  3. Do not touch timing instrumentation — after the hoist the residual cost is one generation per
     exit lib and no longer needs attribution.
- **Dependencies:** none.
- **Risks / blockers:** caching is result-identical ONLY because generation is deterministic here:
  the Asset path requires `mode === "random"` (plugin line 1636) and the runner always sets a finite
  `randomSeed` (`assetOptions.randomSeed = assetSeed`, `finder-asset-opportunity-runner.ts:688-698`;
  `runSeed` falls back to `1`), so `FinderParamSpace.resolveRandom(options)` is seeded per asset and
  loop-invariant. No guard needed; the invariant is why the sibling paths cache unconditionally.
- **Deliverables:** patched `server-asset-is-search.ts`.
- **Validation / testing:** `npm run typecheck`; `npm run typecheck:tests`; new focused spec
  `tests/server-asset-is-search-exit-param-cache.spec.ts`: run `runServerAssetIsSearch` with a
  counting `generateParamSets` + 2 exit candidates + ~10 entry sets; assert the exit-lib generator
  is invoked exactly once per exit key, and that returned `results` are deep-equal to a pre-change
  golden captured with the same seeded inputs. Run `esno tests/finder-server-plugin.spec.ts` and
  `esno tests/finder-asset-opportunity-batch-parallel.spec.ts` unchanged.
- **Exit criteria:** counting assertion green; candidate output byte-identical for identical seeded
  inputs; no exit-candidates-omitted regression (run once with `exitStrategyCandidates: undefined`
  to confirm the non-override path is untouched).

### Phase 2 — Run-scoped dataset LRU across batch holdout iterations

- **Objective:** load each plain symbol dataset once per worker (or once per sequential batch)
  instead of once per holdout iteration.
- **Tasks:**
  1. Add an optional `datasetCache?: SyntheticLegCache<OHLCVData[]>` field to
     `BatchDatasetLoadContext` in `lib/batch-backtest/batch-dataset-loader-core.ts` (type-only;
     Batch paths never set it, so `tests/batch-backtest-server-loader-parity.spec.ts` invariants are
     unaffected).
  2. Export a pure capacity helper from the worker-pool module (single source of truth for the
     9 MB/symbol budget; the module is Node-builtins-only so importing it from the loader adds no
     bundle-trap risk):
     ```ts
     export function resolveAssetOpportunityDatasetCacheCapacity(
         symbolCount: number,
         systemMemoryBytes: number = totalmem(),
     ): number  // min(symbolCount, floor(0.75·RAM / 9MB), ASSET_OPPORTUNITY_MAX_SYMBOLS-ish cap)
     ```
  3. Extend `createServerFinderAssetOpportunityLoadContext(symbolCount?: number)` in
     `lib/finder/server/server-finder-data-loader.ts:114-121`: when `symbolCount` is provided,
     attach a `datasetCache` sized by the helper; when omitted (single-run default), attach none —
     single-run loads each symbol exactly once, so a cache would only add run-length retention.
  4. Populate the cache only where it is reused:
     - sequential batch: `processFinderAssetOpportunityBatchRun` sequential branch (plugin line
       1431) passes `totalAssets`;
     - worker entry: `assetLoadContext ??= createServerFinderAssetOpportunityLoadContext(...)`
       (worker line 229) passes `task.symbols.length`.
  5. In `runAssetOpportunityIteration.scheduleAssetLoad` (lines 379-396), consult/populate
     `assetLoadContext.datasetCache` keyed `` `${symbol}|${interval}` ``, mirroring the existing
     `secondaryDataCache` semantics (lines 303-327): cache only successful non-empty loads; never
     cache failures/empties (they must stay retryable). Skip caching for synthetic-pair symbols via
     `parseSyntheticPairToken` (`lib/synthetic-pair-token.ts` leaf) — those arrays are already
     retained by `pairCache` under their own keys and double retention buys nothing.
  6. Observability: emit `debugLogger.event("finder.server.dataset_cache_hit" | ..._miss")` from the
     wrapper (same pattern as the loader core's cache events). `timingsMs.dataLoading` is the
     before/after signal.
- **Dependencies:** none (lands cleaner after Phase 1 so perf attribution isn't confounded, but not
  required).
- **Risks / blockers:**
  - Worker/main-thread RSS rises toward the level the worker-count policy already budgets
    (9 MB/symbol). Mitigations: the capacity helper applies the same 75%-RAM ceiling; the heap guard
    (8 GB ≥ 400 symbols / 12 GB ≥ 800) already models full-dataset retention, so it becomes accurate
    rather than conservative for sequential batches.
  - Raw datasets are treated as immutable downstream (`prepareClosedCandleData`,
    `sliceFinderDataWindow`, and backtests only read) — proven by `secondaryDataCache` holding the
    same arrays. No mutation risk identified.
- **Deliverables:** context field + capacity helper + populated cache in the two batch paths.
- **Validation / testing:** `npm run typecheck`; `npm run typecheck:tests`;
  `esno tests/batch-backtest-server-loader-parity.spec.ts`;
  `esno tests/finder-server-loader-parity.spec.ts`;
  `esno tests/finder-asset-opportunity-batch-parallel.spec.ts` (add a case: fake in-process runner
  with a counting `loadDataset` proves iteration 2+ of a 3-holdout batch issues zero plain-symbol
  loads while results stay identical); new failure-path case (a load that rejects once then
  succeeds is not served a cached failure).
- **Exit criteria:** counting spec green; parity specs green unchanged; manual smoke (below) shows
  `timingsMs.dataLoading` collapsing after iteration 1 on a ≥100-symbol batch.
- **Manual smoke:** `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`; one batch of ~100
  symbols × 5 holdouts with before/after `dataLoading` diagnostics; watch worker RSS stays within
  the budgeted envelope.

### Phase 3 — Automatic Rust-engine worker-count clamp

- **Objective:** encode the documented "fewer workers (4–8) when Rust is enabled" contract instead
  of relying on operator memory.
- **Tasks:**
  1. Export `ASSET_OPPORTUNITY_BATCH_RUST_WORKER_CAP = 8` from
     `finder-asset-opportunity-batch-worker-pool.ts`.
  2. Add an optional trailing `options?: { rustEngine?: boolean }` parameter to
     `resolveAssetOpportunityBatchWorkerCount`; after the env-override early return, clamp the auto
     value (`Math.min(auto, CAP)`) when `rustEngine === true`. The env override stays supreme
     (operator judgment, same as the memory-ceiling bypass).
  3. Thread it from the plugin call site (lines 1336-1338):
     `resolveAssetOpportunityBatchWorkerCount(totalIterations, totalAssets, process.env, totalmem(), { rustEngine: input.useRustEnginePreference === true })`.
  4. Update the Rust Engine Caveat section of
     `docs/finder-asset-opportunity-batch-parallelization.md` and the AGENTS.md worker-pool bullet
     to say the clamp is automatic (override still available).
- **Dependencies:** none.
- **Risks / blockers:** none — it only ever lowers the auto-selected count.
- **Deliverables:** clamp + threading + doc notes.
- **Validation / testing:** extend the worker-count suite in
  `tests/finder-asset-opportunity-batch-parallel.spec.ts`: rustEngine=true caps at 8; env override
  > 8 still wins when rustEngine=true; rustEngine=false unchanged.
- **Exit criteria:** new cases green; existing worker-count cases green unchanged.

### Phase 4 — Throttle progress stream events (server side)

- **Objective:** cut ~400k redundant NDJSON events on large batches to ~5–10k without touching
  `/status` freshness or event schemas.
- **Tasks:**
  1. Add a tiny throttle helper in `finder-vite-plugin.ts` (module-local; no new file): emit when
     `now - lastEmitMs >= 250` OR `aggregatePercent - lastEmittedPercent >= 1` OR the phase string
     changed. First event always emits.
  2. Apply it to the `writer({type: "asset_progress" ...})` call in `processFinderAssetOpportunityRun`
     (lines 1000-1017) and to both `asset_batch_progress` writer calls (parallel lines 1395-1405,
     sequential lines 1469-1479 — the parallel path uses ONE throttle state for the whole run since
     worker events interleave).
  3. Keep every `snapshot.*` assignment and the parallel path's latest-writer-wins counter mirroring
     UNCONDITIONAL — AGENTS.md contract: dropping `loadedSymbols`/`failedSymbols`/`strategyIndex`
     mirroring "regresses `/status` to zeros mid- and post-run". Only the stream write throttles.
  4. Never gate terminal/iteration events (`asset_done`, `asset_batch_iteration_done`,
     `asset_batch_fatal`, `*_start`) — they are separate event types and stay exact.
- **Dependencies:** none.
- **Risks / blockers:** browser currently renders per event; fewer events only reduces DOM churn.
  Reattach via `GET /status` reads the snapshot, not the stream — unaffected.
- **Deliverables:** throttle helper + three gated writer calls.
- **Validation / testing:** extend `tests/finder-server-plugin.spec.ts` (or the parallel spec's fake
  runner): a fake iteration emitting 200 rapid progress callbacks yields bounded `asset_progress`
  writes (≤ ~3) with the snapshot still updated on every callback; phase transitions always emit.
- **Exit criteria:** spec green; manual smoke shows smooth progress with sparse stream traffic
  (inspect the NDJSON lines in devtools network tab).

### Phase 5 — Buffered JSONL run-log sink

- **Objective:** collapse ~200k per-event syscalls into ~2k batched appends without losing the
  crash-post-mortem purpose.
- **Tasks:**
  1. Add `createBufferedFinderRunLogSink(root: string, runId: string): FinderRunLogSink` to
     `lib/finder/server/finder-run-log.ts`: serialize lines on arrival into a buffer; flush (a)
     ≥ 256 lines, (b) 250 ms after the first buffered line, or (c) immediately for boundary events
     (`iteration_start`, `iteration_complete`). One `mkdir` (memoized) + one `appendFile` of the
     joined chunk per flush; serialize flushes through a promise chain so appends never interleave.
     Keep the injectable `append` seam for tests.
  2. Swap `buildFinderRunLogSink` (plugin line 2374) to return the buffered sink. Leave
     `appendFinderRunLogEvent` unchanged for direct/test callers.
  3. Errors stay fire-and-forget with the existing `debugLogger.warn("finder.run_log.append_failed")`
     mapping; a failed flush clears the buffer (never retry into unbounded growth).
- **Dependencies:** none.
- **Risks / blockers:** a hard crash can lose at most the current buffer tail (< 250 ms of events;
  today's appends are not fsynced anyway, so the durability window barely changes). Boundary-event
  flushes guarantee every completed iteration is fully durable before the next archive append.
  Workers keep posting `run_log` messages to the main thread — the single-writer contract is
  untouched.
- **Deliverables:** buffered sink + plugin swap.
- **Validation / testing:** new focused spec (e.g. `tests/finder-run-log-buffered-sink.spec.ts`)
  with a capture `append`: 1,000 `asset_complete` events + one `iteration_complete` → few appends,
  lines in order, all content present, boundary flush immediate; existing run-log cases in
  `tests/finder-server-plugin.spec.ts` green.
- **Exit criteria:** spec green; a real batch's JSONL file remains line-complete and ordered.

### Phase 6 — Coalesce browser provisional re-renders

- **Objective:** remove O(n² log n) sort work and n full DOM rebuilds from single-run streaming.
- **Tasks:**
  1. In `lib/finder-manager.ts` `runAssetOpportunityFinderServer` (lines 2547-2600), replace the
     per-event sort+render in `onAssetComplete` with a trailing-edge scheduler: update
     `provisionalAssetResults` per event (event-accurate state), mark dirty, and schedule one flush
     on a ~150 ms trailing timer. Flush = single
     `sortAssetOpportunityResults([...provisionalAssetResults.values()])` +
     `setAssetOpportunityLatestResults(...)` + `renderLatestResults()`.
  2. In `onAssetDone` (lines 2582-2596), cancel any pending provisional flush before the terminal
     render+persist (terminal supersedes provisional). The error/recovery path
     (`recoverActiveServerRun`) renders synchronously and is untouched.
  3. Batch mode needs no change — it renders once per `asset_batch_iteration_done`.
- **Dependencies:** none (pairs well with Phase 4 but independent).
- **Risks / blockers:** provisional rows may appear up to 150 ms later than today — cosmetic only;
  persistence semantics unchanged (already "no persistence until terminal `asset_done` adoption").
- **Deliverables:** coalesced handler in `finder-manager.ts`.
- **Validation / testing:** `npm run typecheck`; `npm run test -- finder`; manual smoke: run a
  500+ symbol single Asset Opportunity run, confirm rows stream in smoothly and the terminal list
  matches the pre-change run for the same inputs.
- **Exit criteria:** no UI jank during large single runs; terminal results identical.

### Phase 7 — Archive-loop and diagnostics micro-fixes

- **Objective:** remove redundant archive computation and fix two diagnostics accuracy defects.
- **Tasks:**
  1. Hoist `const baseline = buildAssetOpportunityForwardOosBaseline(iteration.results)` above the
     sort-metric loop in `completeOrderedIteration` (plugin lines 1248-1277; currently recomputed
     per metric at line 1262) and pass it to each append.
  2. Change `diagnostics.oosEvaluations = 1` to `+= 1` at
     `lib/finder/finder-asset-opportunity-runner.ts:911` so coexisting fixed-holdout and legacy
     OOS-window evaluations both count.
  3. Parameterize the heap-guard message: `resolveFinderUniverseHeapWarning(symbolCount, heapLimitMb,
     scopeLabel = "Finder Universe")` in `finder-server-heap-guard.ts`; the Asset Opportunity call
     site (plugin line 1610) passes `"Asset Opportunity"`. (Loosening the guard itself is
     deliberately out of scope.)
- **Dependencies:** none.
- **Risks / blockers:** none — pure computation hoists, a counter increment, and message text.
  Archive output is byte-identical (same baseline JSON per block).
- **Deliverables:** three small patches.
- **Validation / testing:** `npm run typecheck`; `esno tests/finder-server-plugin.spec.ts`
  (archive block suites); the heap-guard spec (wherever `resolveFinderUniverseHeapWarning` is unit
  tested — extend for the label param, default unchanged); a focused assertion that a
  fixed-holdout + `oosValidationEnabled` run reports `oosEvaluations: 2`.
- **Exit criteria:** archive text diff vs pre-change run is empty; counter and message fixes green.

## Affected Files / Modules

| File | Phases |
|------|--------|
| `lib/finder/server/server-asset-is-search.ts` | 1 |
| `lib/batch-backtest/batch-dataset-loader-core.ts` (type-only field) | 2 |
| `lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts` (capacity helper export, Rust cap) | 2, 3 |
| `lib/finder/server/server-finder-data-loader.ts` | 2 |
| `lib/finder/server/asset-opportunity-iteration.ts` (scheduleAssetLoad wrapper) | 2 |
| `lib/finder/server/finder-asset-opportunity-batch-worker.ts` (context sizing) | 2 |
| `lib/finder/server/finder-vite-plugin.ts` (worker-count threading, throttled writers, baseline hoist, heap label, buffered sink swap, sequential context sizing) | 2, 3, 4, 5, 7 |
| `lib/finder/server/finder-run-log.ts` (buffered sink) | 5 |
| `lib/finder/server/finder-server-heap-guard.ts` (scope label) | 7 |
| `lib/finder/finder-asset-opportunity-runner.ts` (counter fix) | 7 |
| `lib/finder-manager.ts` (provisional render coalescing) | 6 |
| Docs: `docs/finder-server-side.md`, `docs/finder-asset-opportunity-batch-parallelization.md`, `AGENTS.md` | 2, 3 (behavior notes); all phases fold here at ship time |

## Contracts Preserved (and How)

- **Scalar-only wire contract:** no stream event schema changes anywhere; Phase 4 only reduces event
  frequency. `toScalarAssetResult` / `assertAssetResultIsScalar` untouched.
- **Ascending-order single-writer batch semantics:** workers still never write archives/events/run
  log; Phase 2 caches inside workers only, Phase 5 buffers on the main thread only.
- **`/status` reattach freshness:** snapshot mirroring stays per-event (Phase 4 gates only the
  stream write); terminal snapshots still carry the authoritative slice once.
- **Determinism:** Phase 1 is result-identical (seeded, loop-invariant generation); Phase 2 caches
  immutable inputs and never caches failed/empty loads; `FINDER_ASSET_BATCH_WORKERS=1` sequential
  rollback path keeps working (and now benefits from the shared dataset context).
- **Loader parity:** the new context field is optional and unset on Batch paths; parity specs must
  stay green without modification.
- **Run-log JSONL format:** line schema unchanged (`ts`, `runId`, `event`, payload); only write
  granularity changes, with order preserved.

## Error Handling

- Phase 2: load failures/empty datasets are never cached (retryable, mirroring `secondaryDataCache`);
  abort mid-load rejects and is not cached.
- Phase 5: flush failures warn via the existing `finder.run_log.append_failed` event and clear the
  buffer; the sink can never throw into a run.
- Phases 1/3/4/6/7 degrade to today's behavior on any internal miss (cache miss → generate; no
  throttle state → emit).

## Security

No new routes, no payload changes, no new filesystem write locations. The dataset cache is
process-memory only. The run-log sink keeps writing the same sanitized filename
(`buildFinderRunLogFilename`) under the same resolved directory. Loopback authorization
(`isAllowedLocalRequest` via `registerLocalJsonRoute`) is untouched.

## Performance

- Phase 1: O(maxRuns²) → O(maxRuns) param constructions per asset-strategy pass with exit override
  (expected: seconds per pass removed at `maxRuns=1000`; hours across 1,000-symbol × 5-strategy
  runs, ÷ worker count in batch mode).
- Phase 2: ~19,000 avoided dataset loads on a 20-holdout × 1,000-symbol batch; expected ~15–35%
  total batch time reduction proportional to the measured `dataLoading` share.
- Phase 3: prevents 14-worker stampedes against the serialized Rust server (documented 4–8 target).
- Phase 4: ~50–100× fewer stream events + browser DOM updates on large batches.
- Phase 5: ~100× fewer run-log syscalls.
- Phase 6: eliminates quadratic sort + per-row DOM rebuilds in the browser.
- Phase 7: removes 13 redundant baseline computations per iteration on the ordered-emission path.

## Rollback

Every phase is a small isolated commit; `git revert` per phase restores prior behavior. No schema,
archive-format, or persisted-settings migrations exist in this plan, so there is nothing to
un-migrate. Phase 2's dataset cache can also be neutralized at runtime by omitting `symbolCount`
from the context factory call sites (single-run behavior), and worker count via
`FINDER_ASSET_BATCH_WORKERS=1` (existing rollback lever).

## Assumptions and Unknowns

- **Assumed (Phase 1):** `generateParamSets` is deterministic per `(defaults, options)` in the Asset
  path because `options.randomSeed` is always a finite per-asset seed there. Verified by reading
  `finder-asset-opportunity-runner.ts:688-698` and the plugin's random-mode requirement; the golden
  comparison in the spec makes this assumption testable rather than trusted.
- **Assumed (Phase 2):** ~9 MB/symbol retention matches the existing worker-count budget; actual
  per-worker RSS at the user's intervals is unknown — measure in the manual smoke and shrink the
  capacity cap if the budget is exceeded (legCache/pairCache retention stacks on top for
  synthetic-heavy universes).
- **Unknown:** real-world `dataLoading` share of batch wall time (Phase 2's headline number) — the
  diagnostics already measure it; record before/after in this document when the phase lands.
- **Unknown:** whether the Rust server's practical sweet spot is 4 or 8 workers — 8 is chosen as
  the documented upper bound; the env override absorbs operator tuning.
- **Out of scope:** parallelizing the single (non-batch) run, prefix-reuse algorithms for holdout
  sweeps, sharing datasets ACROSS workers (shared-memory arrays), and any loosening of the heap
  guard for asset runs.

## Post-implementation Notes

Implemented 2026-08-15 on `feat/asset-opportunity-improvements` (one commit per phase, in plan
order). All specs green; `tsc --noEmit` clean. Deviations from the plan letter, in spirit:

- **Phase 2 observability**: instead of per-load `debugLogger` cache events (plan) — which would
  re-flood the ring buffer on large sweeps — the iteration emits ONE
  `finder.server.dataset_cache_stats` event and adds `datasetCacheHits`/`datasetCacheMisses` to
  each `iteration_complete` run-log line. The cache stores load PROMISES via the existing
  `SyntheticLegCache` (concurrent symbol loads share one fetch; rejections auto-evict), so the
  wrapper never needs an explicit failure-eviction path.
- **Phase 5 seam**: an injected `append` now owns ALL filesystem effects (the buffered sink skips
  its lazy `mkdir` when `append` is injected), matching `appendFinderRunLogEvent`'s existing
  injectable-default contract. `flushAfterMs: Infinity` disables the timer (used by the spec for
  deterministic flush points).
- **Phase 6**: added a final provisional flush when the stream ends without terminal rows (e.g.
  `asset_done` with a mismatched `runId`), so the UI never freezes mid-batch state; a flush after
  terminal adoption is a no-op guard.
- **Phase 7 fingerprint memoization** (optional stretch in the plan) was not implemented — the
  archive loop spends its time in per-metric sorts and JSON serialization, not fingerprint hashing
  (topN rows x 14 metrics x FNV over small param objects). Revisit only if profiling says otherwise.
- New/extended specs: `tests/server-asset-is-search-exit-param-cache.spec.ts` (3 cases),
  `tests/finder-run-log-buffered-sink.spec.ts` (4 cases), 4 new cases in
  `tests/finder-asset-opportunity-batch-parallel.spec.ts` (dataset LRU, retry semantics, capacity,
  Rust clamp), throttle suite + heap-guard label case in `tests/finder-server-plugin.spec.ts`,
  combined-OOS-modes case in `tests/finder-asset-opportunity-runner.spec.ts`.
- Not yet done (needs a real host): the Phase 2/3 manual smoke
  (`NODE_OPTIONS=--max-old-space-size=16384 npm run dev`, ~100-symbol batch before/after
  `dataLoading` diagnostics, worker RSS check). The hermetic specs cover the semantics; record the
  wall-clock numbers here when run.
