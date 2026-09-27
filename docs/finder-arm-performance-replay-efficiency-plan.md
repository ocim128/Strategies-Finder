# Finder Arm Performance replay efficiency plan

Status: Phases 0-3 implemented on `52a80921`; full-output parity verified; see Outcome.

Scope: three remaining replay inefficiencies in Finder Arm Performance.
Worker reuse is now enabled by the server caller. Keep that implementation
and its cache reset handshake, plus the existing `finder_arm` profile's
annual/detail/snapshot suppression. This continues the
[worker reuse plan](finder-arm-performance-worker-reuse-plan.md) without
reopening its deferred higher-level worker cache retention.

## Findings and evidence

All three are verified from source; their relative wall-time impact has not
been profiled. The two retention findings primarily target peak memory and
GC pressure, not a guaranteed speedup.

1. **Dense event snapshots outlive their Finder consumers.** In
   `lib/batch-backtest/batch-open-score-usd-replay-engine.ts`, the event sweep
   copies eight asset-sized `Float64Array`s per decision event (around line
   1724). Phase 3 converts them to candidate pools, but `events = []` occurs
   only after target outcome evaluation and diagnostic loops (around line
   2603). Finder disables pool snapshots and candidate outcome diagnostics,
   so it retains those arrays unnecessarily while outcome maps are built.
   The raw array payload is approximately `64 * events * assets` bytes,
   excluding object overhead. For 10,000 events and 500 assets this is about
   305 MiB. Early release reduces overlap; it does not eliminate construction.
2. **Gap filtering recomputes unchanged selector winners.** Phase 3 builds
   `EventView` winners and tie information (around lines 1900–2000). The
   `gapFilteredViews` loop (around line 2680) then allocates filtered pools
   and recalculates the same top selectors even when `dataGapAssets` is empty.
   Repeated scans and FNV tie digests scale with events and pool sizes.
3. **Single-pass Finder replay retains cross-window caches.** In
   `lib/batch-backtest/sp500-top-mean-coordinator-engine.ts`, each child creates
   a 512-entry `replayTargetCache` and `sharedTargetOutcomeCache` (around
   lines 1149–1169) and supplies the latter to replay. Finder runs no annual
   passes, and neither cache is shared with the next candidate. Consumed
   OHLCV arrays therefore remain retained unnecessarily; outcome records are
   also indexed by both asset/time and view/asset. These indexes share record
   objects, so this is extra map storage, not duplicated outcome arrays.

## Architecture and contracts

`runFinderArmPerformance` runs candidates sequentially through
`TopMeanCoordinatorEngine`, borrowing the sweep's worker pool. Compact shard
artifacts feed `runOpenScoreUsdReplay`: event sweep -> candidate views ->
per-asset target outcomes -> gap-filtered selection -> horizon aggregation.
Finder stores the 15 compact arm comparisons and deletes child artifacts.

Keep selector eligibility, missing/censored-data handling, strict-past TOP_Z
updates (including zero scores), tie digests, control pools, bootstrap seed
and sample count, concentration/exclusion diagnostics, and report text.
Do not remove statistical computations just because Finder copies scalars.
Preserve standalone annual replay and archive behavior, cancellation,
target-boundary diagnostics, coverage, and parent reattach.

Use existing flags and `finderArmProfile`; no new user settings, public API,
schema, database, service, or deployment changes. Keep local-route security,
server-only imports, worker budgets, and durable shard writes unchanged.

## Phase 0 — Establish complete parity and replay measurements

**Objective:** Obtain a trustworthy baseline before changing replay lifetimes.

**Tasks / deliverables:** Extend the existing measurement approach in
`scripts/bench-finder-arm-worker-reuse.ts` with a deterministic replay fixture
or focused replay benchmark under `scripts/`. Keep immutable ordered
artifacts, target candles, settings, costs, cutoff, and horizons fixed.
Record scan/targets/outcomes/aggregate times, wall time, process RSS, heap and
external memory, retained target-cache entries, and load counts. Include
tie-heavy, many-event, missing-target, and gapped-target fixtures.

**Validation / risk:** The existing benchmark hash retains only `events`
and `topMean`, excluding other arm metrics. Its comment labels the control
stochastic, but the replay derives control means from the pool and uses a
fixed bootstrap seed. Do not use that partial hash to certify these changes.
Compare all 15 comparisons, including `randomMean`, `delta`, medians, CIs,
block counts, coverage, and relevant report/selection outputs on ordered
fixtures. Investigate any baseline nondeterminism; do not silently drop
fields. End-to-end worker artifact ordering may need separate diagnosis.

**Exit:** Repeatable full-output baseline and recorded replay costs. No
numerical change is an intended tradeoff of these optimizations.

## Phase 1 — Release unused event snapshots before target evaluation

**Objective:** Reduce dense-array lifetime with a small ownership change.

**Tasks:** In the replay engine, once candidate pools and TOP_Z history are
fully built and `totalEvents` is captured, clear `events` when both
`includePoolSnapshots` and `includeCandidateOutcomes` are false. Position the
release before target loads/outcome allocation. Audit every later `events`
consumer: diagnostic counts/loops must remain guarded; progress and normal
event counts use saved scalars/views. Preserve the later release for
diagnostic runs. Do not introduce sparse snapshots or move the event sweep.

**Dependencies / risks:** Phase 0. `includeEventDetails` is not the correct
guard: per-selector details use views, whereas archive diagnostics need the
original snapshots. Garbage collection is not immediate; making arrays
unreachable is the guarantee, not an immediate drop in RSS.

**Validation / deliverables:** Extend replay specs with equivalent runs with
diagnostics enabled/disabled; compare arm metrics, event counts, TOP_Z,
ongoing/completed details, and pool/candidate diagnostics where requested.
Measure heap/external-memory overlap during outcome evaluation on the large
fixture. Avoid brittle unit tests asserting a particular GC schedule.

**Exit:** Unchanged outputs and demonstrably shorter snapshot retention;
diagnostic/archive consumers retain their original inputs.

## Phase 2 — Skip reranking when there are no target gaps

**Objective:** Eliminate duplicate selection work on the common clean-data path.

**Tasks:** Add a fast path in construction of `gapFilteredViews`: when
`dataGapAssets.size === 0`, reuse existing `EventView` objects in the output
array. Preserve indexing and the existing reranking path whenever any gap
exists. Do not merge selector helpers or redesign candidate types. Keep
bottom-side selection, profit-only events, and `latestSelections` behavior;
the latter intentionally starts from the original latest view.

**Dependencies / risks:** Phase 0. Verify downstream code treats views and
candidate pools as immutable before sharing references. Missing targets and
censored returns are distinct from gaps and still flow through the original
outcome eligibility checks. Do not substitute a remaining winner or zero-fill.

**Validation / deliverables:** Extend replay and max-active specs for no gaps,
irrelevant gaps, winner removed by an overlapping gap, fewer than two usable
candidates, ordinary/profit-only pools, and tied RAW/MEAN/RAW_UNIQUE/Z arms.
Compare full reports and all metrics. Benchmark tie-heavy clean data to
confirm fewer repeated scans/hashes. Keep the slow path exercised explicitly.

**Exit:** Clean-data runs reuse existing rankings; gap cases preserve exact
reranking and omissions. No additional retained per-event cache is introduced.

## Phase 3 — Bound Finder's caches to one replay pass

**Objective:** Retain only useful prefetch data instead of annual-pass state.

**Tasks:** In the coordinator's existing Finder profile, size the target LRU
to the existing `TOP_MEAN_REPLAY_TARGET_PREFETCH_CONCURRENCY` rather than 512.
Keep `inFlightTargetDatasets`, its promise deduplication, and the prefetch
window unchanged initially. Omit `sharedTargetCache` from Finder's replay
options so the engine's per-target local cache entry dies after that target;
`returnsByView` continues retaining the records required for aggregation.
Keep standalone cache capacity and shared annual outcome cache unchanged.

Audit the existing no-shared-cache path before relying on it: diagnostics
must still be disabled for Finder, and deduplicated `requestsByAsset` must
not require repeated dataset loads. Retain fallback correctness if a target
is requested again; memory savings must not become missing outcomes. Do not
clear module-level loader caches or change their freshness policy. Some
underlying loaders retain their own bounded data, so measure actual savings
rather than assuming all target memory is freed.

**Dependencies / risks:** Phase 0. Smaller LRU capacity can lose symbol-alias
hits; record actual load counts. Keep Stop aborting prefetched requests and
observing abandoned rejection handlers. Do not reset diagnostics counters
mid-pass or change target load failure classification/boundary timestamps.

**Validation / deliverables:** Extend coordinator tests for the Finder
capacity/absence of shared annual state, a target universe exceeding the
prefetch window, duplicate requests, load failures, and Stop during prefetch.
Compare shared-cache versus no-shared-cache replay outputs. Preserve existing
annual-cache reuse and narrower-window fallback tests for standalone runs.

**Exit:** Finder target retention is bounded by the small prefetch working
set at this layer, with unchanged results and no material load amplification;
standalone annual cache behavior remains intact.

## Validation, rollout, and rollback

After each phase run `npm run typecheck`, `npm run typecheck:tests`, and the
affected specs using `..\..\..\node_modules\.bin\esno tests\<name>.spec.ts`:

- `batch-open-score-usd-replay-engine`, `batch-open-score-usd-max-active`.
- `sp500-top-mean-server-plugin`, `sp500-top-mean-horizon-summary`,
  `sp500-top-mean-archive-log`, `sp500-top-mean-research-archive-writers`.
- `finder-arm-performance-runner`, `finder-arm-performance-metrics`,
  `finder-server-plugin`.

Repeat fixed-input 50-pair and 1,000-pair multi-candidate sweeps with worker
reuse enabled. Use `NODE_OPTIONS=--max-old-space-size=16384` or higher for
large server runs. Verify progress, Stop, reload reattach, Copy/Apply,
coverage, and actual engine mode; report unavailable Rust/catalog checks.

Land phases independently. Revert early release, the no-gap fast path, or
Finder cache sizing/options separately if parity or measurements regress.
Keep the already-enabled worker reuse and earlier Finder profile savings.
Update `docs/finder-server-side.md` with measured behavior only when these
changes are implemented. No migrations or new operational dependencies.


## Outcome (2026-09)

Phase 0: `scripts/bench-finder-arm-replay.ts` — deterministic replay
benchmark over ordered fixtures; the fingerprint covers the FULL result (all
15 comparisons, control means, medians, CIs, counts, latestSelections).
The engine proved byte-deterministic run-to-run in every fixture mode (clean,
gapped, missing-target, tie-heavy); the sweep-level float-epsilon drift noted
in the worker-reuse plan traces to upstream worker artifact ordering, not the
replay. The only non-deterministic output is the `elapsed=` wall-clock line
in reportLines (instrumentation).

Measurements (300 assets x 4,000 events, horizon 5, TS engine): clean replay
7.81 s -> 4.66 s; gapped 6.53 s -> 4.50 s; peak RSS 1,641 -> 1,623 MB,
external ~175 MB (phase 1 shortens the events/outcomes overlap; construction
cost is unchanged, as planned). End-to-end Finder Arm Performance sweep with
worker reuse: 1,000 pairs x 3 candidates 80.1 s -> 59.4 s, 50 pairs x 3
candidates 3.7 s -> 3.2 s; later candidates still spawn 0 workers and the
retained parsed-seed cache loads stay intact.

Phase 1: early `events` release when both diagnostic sinks are off; audit
confirmed every later consumer is candidateOutcomes/poolSnapshots-guarded.
Phase 2: empty-gap fast path reuses the original EventView references; the
re-rank loop remains authoritative for any real gap (locked by the
irrelevant-gap spec). Phase 3: finder_arm target LRU sized to the prefetch
window via `resolveTopMeanReplayTargetCacheCapacity`, and the cross-window
`sharedTargetCache` is omitted for finder_arm; standalone capacity and annual
shared-cache behavior unchanged.
