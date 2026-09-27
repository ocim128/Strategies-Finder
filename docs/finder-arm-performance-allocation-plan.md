# Finder Arm Performance allocation reduction plan

Status: Implemented 2026-09 (see [Measured outcomes](#measured-outcomes-implemented-2026-09-worktree-choresf-alloc-reduction-tmp)). Original code baseline: `da895b84`.

Scope: three additional allocation costs in Finder's shared replay and
worker artifact path. The [aggregation plan](finder-arm-performance-aggregation-plan.md)
is implemented. Preserve its exclusion reuse, bootstrap rank-table reduction,
and event-local tie cache, plus earlier worker/replay optimizations.

These findings identify work that can be removed without changing research
semantics. Their end-to-end benefit is unmeasured and may be smaller than
earlier changes. Benchmark each independently; retain only justified changes.

## Findings and implementation boundaries

1. **A temporary return map is rebuilt for every ordinary event/horizon.**
   In `lib/batch-backtest/batch-open-score-usd-replay-engine.ts`, around
   lines 3364–3398, `retByAsset` copies each positive candidate's return from
   `perAsset`, then a second loop sums that map. `perAsset` already indexes
   the outcome records. This allocates a map and its entries per event per
   horizon, with work proportional to the positive pool size.
2. **Chronological block construction always allocates and sorts indices.**
   `splitIntoBlocks` in the same file, around line 4133, creates
   `times.map(...).sort(...)` for every comparison. Ordinary selector series
   follow chronological views, and their exclusions preserve that order.
   However, profit-only events are appended after ordinary views, so some
   series can be out of order. A checked fast path can avoid the index array
   and sort only when already ordered; unconditional sort removal is unsafe.
   Modern sort already handles ordered runs efficiently, so do not claim an
   automatic O(n log n) to O(n) wall-time improvement.
3. **Serialized shard bytes are copied before transfer.**
   `serializeShardArtifacts` in
   `lib/batch-backtest/sp500-top-mean-worker.ts`, lines 119–124, encodes JSON
   into a fresh `Uint8Array`, allocates another equal-sized `ArrayBuffer`,
   and copies all bytes. `postResult` transfers only the second buffer.
   The encoder already returns owned storage: transfer that backing buffer
   to remove one payload-sized allocation and copy per shard. JSON encoding
   and durable disk writes remain necessary and unchanged.

Data flow remains: sequential Finder candidates -> reused workers -> compact
artifact serialization/transfer -> durable shard files -> coordinator replay
-> target outcomes -> per-horizon comparisons -> compact Finder metrics.
No scheduler, data-cache, API, UI, database/schema, infrastructure, or security
changes. Shared replay and worker helpers also serve standalone TOP_MEAN;
those callers must retain identical behavior.

## Phase 0 — Baseline and correctness fixtures

**Objective:** Establish full-output parity and measure each cost.

**Tasks / deliverables:** Use `scripts/bench-finder-arm-replay.ts` with its
signed-zero-aware full-result fingerprint, normalizing only elapsed-time
report text. Run repeated fixed clean, gapped, missing-target, and tie-heavy
fixtures. Include multiple horizons for shared-engine regression coverage,
although Finder normally requests one. Add a fixture where profit-only
events interleave chronologically with ordinary views. Record replay phase
times, wall time, heap/external memory, and RSS.

Measure `serializeShardArtifacts` separately with representative compact
shards, including empty and large trade lists, then validate through actual
worker transfer. Use existing worker specs and benchmark conventions; do not
add public diagnostic fields or dependencies.

**Exit:** Repeatable outputs covering all 15 comparisons, control means,
medians/CIs, coverage, selections, and reports. Direct numeric assertions
preserve `-0` as well as `+0`. Record baseline timings without promising a
combined speedup.

## Phase 1 — Read ordinary returns from the existing outcome map

**Objective:** Remove the per-event/horizon `retByAsset` allocation.
Depends on Phase 0.

**Tasks:** In the ordinary-arm aggregation block, validate every positive
candidate and accumulate `totalReturn` in that same traversal. Preserve the
current positive-pool iteration order so floating-point addition order does
not change. After successful validation, use `perAsset`'s `long[hIdx]` for
selected returns and `view.positives.length` for the control denominator.
Audit every current `retByAsset` read, including top/bottom RAW_UNIQUE tied
pools and detail emitters. Use a small local accessor only if it makes those
reads clearer; do not introduce a reusable cache or allocate another index.

**Contracts / risks:** Prove that the positive pool contains unique asset
indices and that ordinary picks/tied pools are subsets of it. `perAsset`
also contains profit-only assets; never use its size or sum all its values
as the ordinary control pool. Missing/non-finite returns must still omit the
whole ordinary comparison; no replacement winner or zero-filled return.
Preserve long-side outcome access for both top and bottom arms.

`AGENTS.md` names `retByAsset` in its direction-correct-pool guidance and
mentions `appendPairwise`, which is absent from the current replay engine.
The current tested engine is authoritative: preserve that guidance's long
return and positive-pool semantics. If implemented, update just that stale
implementation reference; do not change the research contract.

**Validation / deliverables:** Extend replay/max-active specs for unequal
returns, multiple horizons, missing/censored winners and non-winners,
profit-only assets outside the ordinary pool, top/bottom ties, and RAW_UNIQUE
controls. Keep exact full-output and sum-order parity. Compare a large
positive-pool fixture's allocation/aggregate time.

**Exit:** No transient ordinary-return map; identical metrics and eligibility,
with measured benefit and no material regression on small pools.

## Phase 2 — Add a checked chronological block fast path

**Objective:** Avoid index-array allocation/sorting on ordered series.
Depends on Phase 0; independently reviewable from Phase 1.

**Tasks:** In `splitIntoBlocks`, check that the relevant timestamps are finite
and nondecreasing. If so, fill blocks directly from the original value
indices. Otherwise use the existing stable index-sort path unchanged. Keep
the same floor-based boundaries, effective block count, empty behavior, and
insertion order among equal timestamps. Do not sort the input arrays in place
or change event append order to force the fast path.

**Risks / testing:** Profit-only appends can break chronology; gaps in time
do not. Missing/non-finite timestamps must select the old path rather than
gain new error or coercion semantics. Compare sorted, reverse, equal-time,
interleaved profit-only, one-event, empty, and insufficient-block cases
against an independent stable-sort reference. Preserve bootstrap draw order,
block contents, CI endpoints, and signed zeros. Exercise the helper through
replay fixtures without exporting internals solely for tests.

**Deliverables / exit:** Local fast path plus reference-based regression
coverage. Ordered cases avoid the order array; unordered cases preserve the
existing result. Benchmark both: the detection scan must not create a
material regression on out-of-order workloads.

## Phase 3 — Transfer the encoder's owned buffer

**Objective:** Remove the extra artifact byte copy. Depends on Phase 0.

**Tasks:** Return the `TextEncoder.encode(JSON.stringify(artifacts))` result's
owned backing buffer from `serializeShardArtifacts`. Preserve its exported
`ArrayBuffer` return type and `artifactsBytes` message field. Verify the
repository's TypeScript typed-array definitions; resolve typing locally,
without introducing a generic conversion helper, unsafe pooled Buffer path,
or another copying slice. Keep `postResult`'s transfer list unchanged and do
not read the detached buffer after posting.

**Validation / risks:** Extend the existing byte-transfer contract in
`tests/sp500-top-mean-worker-pool.spec.ts`: exact UTF-8 JSON bytes, empty
shards, Unicode symbols, large payloads, sender detachment, receiver parsing,
and worker reuse after transfer. Confirm worker errors, durable-write retries,
manifest ordering, and backpressure remain unchanged. The current Node
runtime was checked during planning: an encoder-produced buffer can be
transferred directly with the sender detached; this is not a substitute for
real-worker tests or project typechecking.

**Deliverables / exit:** One UTF-8 payload buffer instead of two during
serialization, unchanged wire/disk content, and transfer tests passing.
Report serialization allocation/timing separately from backtest speed.

## Verification, rollout, and rollback

After each implementation phase run `npm run typecheck`,
`npm run typecheck:tests`, and affected specs via
`..\..\..\node_modules\.bin\esno tests\<name>.spec.ts`:

- Replay: `batch-open-score-usd-replay-engine`,
  `batch-open-score-usd-max-active`, `sp500-top-mean-horizon-summary`.
- Transfer: `sp500-top-mean-worker`, `sp500-top-mean-worker-pool`.
- Integration: `finder-arm-performance-runner`,
  `finder-arm-performance-metrics`, `sp500-top-mean-server-plugin`.

Repeat the full replay fingerprint checks and a fixed multi-candidate Finder
sweep with worker reuse enabled. For large server smokes retain
`NODE_OPTIONS=--max-old-space-size=16384` or higher. Check progress, Stop,
reload reattach, Copy/Apply, coverage, and actual engine mode. Explicitly
report catalog-dependent or optional Rust checks that could not run.

Land phases separately. Roll back the direct return lookup, chronological
fast path, or encoder-buffer return independently if parity or measurements
fail. No migrations or operational changes are needed. Record measured
outcomes in this plan; leave unrelated cleanup and prior optimizations alone.

## Measured outcomes (implemented 2026-09, worktree `chore/sf-alloc-reduction-tmp`)

All three phases landed on top of `da895b84`. Correctness instrument:
`scripts/bench-finder-arm-replay.ts` full-result fingerprint (signed-zero-aware,
`elapsed=` normalized), 3 repetitions per fixture, baseline (stashed impl) vs
implemented in the same session.

Fingerprints are IDENTICAL baseline vs implemented on every fixture — clean
`8aba55c2…`, gaps `565ee054…`, missing-targets `b503eabb…`, ties `d646c5e7…`,
profit-only interleave `9d432190…`, horizons 1,3,7,12 `43840d42…` — and the
end-to-end worker-reuse sweep (6 pairs × 2 candidates) produces the same result
hash `6f4772a31366` with reuse on and off, exercising the real transferred
buffer through worker handoff and durable disk writes.

Median wall times (baseline → implemented): clean 371→351 ms (−5%), horizons
479→439 ms (−8%), ties 433→419 ms (−3%), large pool (150 assets × 5000 events)
1702→1648 ms (−3%), interleave 348→341 ms (−2%), gaps and missing-targets flat
within run noise. Peak RSS and external memory unchanged within noise on every
fixture. Run-to-run noise on this host is ~±5%, so the per-phase attribution
stops at "no regression anywhere, consistent small improvement on
comparison-heavy fixtures"; the `elapsed`-normalized fingerprints carry the
correctness verdict, not the timings.

`serializeShardArtifacts` was validated through the byte-transfer contract
test (exact UTF-8 bytes, empty/Unicode/large payloads, sender detachment,
receiver parsing, real-worker transfer) rather than a standalone timing
benchmark; JSON encoding and disk writes are unchanged, so its win is exactly
one payload-sized allocation and copy per shard.

Validation: `npm run typecheck` clean; `typecheck:tests` shows only the three
pre-existing `sp500-top-mean-worker-pool.spec.ts` errors (verified against the
stashed baseline); replay-engine 80/80, max-active 12/12, horizon-summary,
worker, worker-pool, finder-arm-performance runner/metrics/settings, and the
TOP_MEAN server-plugin spec all pass.
