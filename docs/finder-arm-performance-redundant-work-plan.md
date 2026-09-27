# Finder Arm Performance redundant-work plan

Status: Phases 0, 1, and 3 implemented in the temporary worktree; Phase 2
measured and rejected. Not merged. Baseline: `081abece`.

Scope: three remaining costs in the shared replay engine used by Finder Arm
Performance. The [allocation plan](finder-arm-performance-allocation-plan.md)
is implemented; preserve those changes and all prior worker/replay savings.

These are source-confirmed opportunities, not measured bottleneck rankings.
The last allocation measurements report approximately +/-5% host noise.
Do not label a change a speedup without repeated measurements, and do not
expand a small optimization into an engine redesign to justify keeping it.

## Findings

All runtime locations below are in
`lib/batch-backtest/batch-open-score-usd-replay-engine.ts`.

1. **Candidate construction precedes eligibility.** Around lines 1838–1852,
   the event/asset loop constructs the ordinary `Candidate`, including
   adjusted/mean arithmetic, before checking `raw > 0`. Non-positive assets
   immediately discard that object. Only the ordinary construction should
   move into the positive branch: the profit pools and TOP_Z history still
   need independent processing for every asset. Benefit depends on pool
   sparsity and whether V8 already eliminates nonescaping allocations.
2. **Bucket placement repeats timestamp lookups within runs.** Around lines
   1577–1588, the placement pass calls `timeIndex.get` and reads/writes
   `placementCursor` for every delta. Streams are already sorted by
   `compareDeltas`; the preceding count pass already traverses equal-time
   runs. Placement can resolve the bucket and starting slot once per run,
   copy deltas in their existing order, and commit the cursor once. Synthetic
   base/quote deltas commonly share a timestamp, with further repetition at
   simultaneous exits/entries. No benefit is assumed for all-singleton runs.
3. **Bootstrap setup repeats a whole-sample delta sort.** `buildComparison`,
   around lines 3718–3723, sorts `deltasArr` for its median. It partitions
   those same values into chronological blocks and calls
   `blockBootstrapMedianCi`, which concatenates the sorted blocks and sorts
   that whole sample again to build `unionValues` (around lines 1052–1061).
   Reusing the already-sorted sample can remove that temporary array and
   global sort. Per-block sorting and weighted-rank bootstrap calculations
   remain necessary; do not change the statistical method.

## Architecture and contracts

Finder's runner supplies the existing `finder_arm` profile to the coordinator.
Workers backtest pairs and persist compact shards; replay scans trades,
places score deltas into time buckets, builds candidate views, loads target
outcomes, and aggregates horizon comparisons. Finder stores 15 scalar arm
comparisons. The same replay leaf serves standalone TOP_MEAN and Batch.

Preserve exact within-bucket addition order, same-timestamp semantics,
candidate ordering, independent profit/causal pools, zero-score TOP_Z history,
gap/missing/censored-data handling, seeded ties, bootstrap draw order, signed
zeros, confidence intervals, and every concentration/exclusion report line.
Keep cancellation/yield points, wire contracts, cache budgets, and durable
artifact behavior. No UI, public HTTP API, schema, database, infrastructure,
dependency, or authorization changes are needed.

## Phase 0 — Establish targeted baselines

**Objective:** Measure the three costs while locking full-output parity.

**Tasks / deliverables:** Reuse `scripts/bench-finder-arm-replay.ts` and its
signed-zero-aware full-result fingerprint. Retain clean, gap, missing-target,
tie-heavy, interleaved profit-only, and multi-horizon fixtures. Add narrowly
targeted fixtures only where current ones do not cover sparse positive
pools, many equal-time deltas within one stream, all-singleton timestamps,
and large distinct delta samples. Record repeated phase/wall times and
heap/external memory/RSS on identical ordered artifacts and candles.

For small changes, pair baseline and changed runs on the same host with the
same warmup/Node configuration. Report distributions and noise, not a single
best run. Use isolated bucket/bootstrap measurements if end-to-end timings
cannot resolve the cost. No new production telemetry fields are needed.

**Exit:** Stable fingerprints for all result fields except elapsed report
text; direct `Object.is` assertions cover zero sign. Identify whether each
cost is material enough to pursue. Record inconclusive performance honestly.

## Phase 1 — Construct ordinary candidates only when positive

**Objective:** Avoid work for assets excluded from the ordinary pool.
Depends on Phase 0.

**Tasks:** Move the ordinary candidate literal and its adjusted/mean
calculations inside `if (raw > 0)`. Preserve positive-candidate field values,
push order, and `maxActivePairs` updates. Do not remove fields as unrelated
dead-code cleanup. In particular, do not `continue` the outer asset loop
for non-positive raw scores: profitable-pair subsets can still be positive,
and TOP_Z's subsequent history update must observe every asset.

**Validation / risks:** Extend existing replay fixtures for zero/negative
ordinary scores with eligible profit and causal pools, later TOP_Z events
following zero-score history, empty ordinary pools, and full-positive pools.
Compare all arms, coverage, ties, and report lines. Benchmark sparse versus
dense pools; JIT escape analysis may already remove some allocation cost.

**Deliverables / exit:** A local branch adjustment with unchanged outputs.
Retain it only with a defensible reduction in executed work and no measured
regression; do not claim GC savings if the runtime measurements show none.

## Phase 2 — Place equal-time delta runs together

**Objective:** Reduce repeated map and cursor operations during bucket fill.
Depends on Phase 0; independent of Phase 1.

**Tasks:** Mirror the count pass's run traversal in the placement pass.
For each stream's consecutive equal-time run, look up its bucket once,
read the starting slot once, write `flatDeltas` and `flatStreamIdx` in exactly
the current sequence, then update the bucket cursor by the run length.
Keep array sizes, bucket boundaries, stream order, stream sorting, and
post-placement releases unchanged. Do not regroup by asset or combine deltas.

**Validation / risks:** Compare placement against the current per-delta
reference on generated sorted streams and end-to-end fixtures. Cover empty
streams, singleton runs, multiple pairs sharing timestamps, direct symbols,
same-time exits/entries, simultaneous base/quote deltas, and fractional
cap-tilt/confidence weights. Addition is not associative in floating point;
preserve order even if the old comment describes updates as additive.
Confirm cancellation/progress behavior and no buffer overrun or cursor drift.

**Deliverables / exit:** Run-based placement with exact flat-array order and
full replay parity. Repeated-time fixtures reduce lookup/cursor operations;
singleton-heavy fixtures must not regress materially. Avoid a generalized
bucket utility or changes to the event-sweep algorithm.

## Phase 3 — Reuse the sorted comparison sample in bootstrap setup

**Objective:** Remove the redundant whole-sample sort and concatenation.
Depends on Phase 0; independently reviewable from Phases 1–2.

**Tasks:** Pass `buildComparison`'s existing `sortedDeltas` to
`blockBootstrapMedianCi` through a narrowly documented optional third
argument. Existing two-argument callers retain the current self-contained
path. The argument is a read-only, sorted view of exactly the multiset in
the blocks, not a cache key or a global memo. Build the distinct-value union
by scanning that view; keep sorted block arrays for rank selection and
equal-value draw-position traversal. Do not mutate or re-sort the supplied
array and do not add a public execution-profile flag for this optimization.

**Contracts / risks:** First verify that `splitIntoBlocks` partitions every
input value exactly once, including its chronological fallback. Keep the
two-argument path for direct callers and reference tests. Both paths must
retain existing behavior for supported inputs; do not add value filtering
or silently repair mismatched inputs. Audit finite-value assumptions and
mixed `-0`/`+0`: changing the union's representative zero must not change
which stored block value supplies a ranked median or fallback result.
If exact parity cannot be established, keep the existing construction.

**Validation / deliverables:** Compare optional-input and default paths to
the existing pooled-sort oracle across duplicates, distinct values, negative
returns, mixed signed zeros, uneven/empty blocks, odd/even pooled sizes,
insufficient blocks, exclusions, and out-of-order profit-only appends.
Preserve LCG state, resample count, median arithmetic, and CI indices.
Measure both isolated bootstrap setup and complete replay results.

**Exit:** One whole-sample sort in the comparison path rather than two,
unchanged reference results, and measurable allocation/work reduction without
regressing standalone callers. No broader bootstrap refactor.

## Verification, rollout, and rollback

After each phase run `npm run typecheck`, `npm run typecheck:tests`, and
affected specs using `..\..\..\node_modules\.bin\esno tests\<name>.spec.ts`:

- `batch-open-score-usd-replay-engine`, `batch-open-score-usd-max-active`.
- `sp500-top-mean-horizon-summary`, `sp500-top-mean-server-plugin`.
- `finder-arm-performance-runner`, `finder-arm-performance-metrics`.

The preceding plan recorded three pre-existing worker-pool test type errors.
Recheck the baseline: report any current failures rather than assuming they
remain or treating the check as passing. Record skipped catalog/Rust checks.

Repeat the full-result replay benchmark and a fixed multi-candidate Finder
sweep with worker reuse on. Keep `NODE_OPTIONS=--max-old-space-size=16384`
or higher for large server smokes. Confirm Stop/progress, reload reattach,
Copy results, coverage, and actual engine mode.

Land phases separately. Each local change can be reverted without disabling
prior optimizations or migrating data. Record measured outcomes in this plan;
do not add microbenchmark percentages to predict cumulative speedup.

## Implemented outcomes — temporary worktree

Worktree: `C:/wt/sf-redundant`, branch `chore/sf-redundant-tmp`. Commits are
`122f8381` (sparse fixture), `55feb468` (ordinary candidate construction),
and `b318bf63` (sorted-sample reuse and its parity tests). These commits are
not merged.

- **Phase 0:** Added `--sparse` to `scripts/bench-finder-arm-replay.ts`.
  Per-pair direction flips produce ordinary pools of about 10 of 60 assets
  over 1,000 eligible events. Existing fixed fixtures cover clean, sparse,
  interleaved profit-only, tie-heavy, multi-horizon, gaps, missing targets,
  and a large asset/event workload.
- **Phase 1:** The ordinary candidate literal and adjusted/mean calculations
  now run inside `raw > 0`. The asset loop still processes every asset so
  profitable subsets and TOP_Z history remain correct. Added two specs for
  positive ordinary candidates coexisting with independently eligible profit
  pools and subsequent TOP_Z history. Full output fingerprints remained
  identical. Wall-time benefit was within host noise; the change removes
  executed work, but V8 may already elide some discarded allocations.
- **Phase 2:** Rejected. An output-identical isolated probe measured the
  proposed equal-time run placement at 2.8 -> 3.3 ms on run-heavy streams and
  13.0 -> 13.3 ms on singleton-heavy streams. The run-walk overhead exceeded
  the saved map lookups. No implementation was committed; keep the current
  per-delta bucket placement.
- **Phase 3:** `buildComparison` passes its existing sorted delta sample to
  `blockBootstrapMedianCi` through an optional third argument. Two-argument
  callers retain the self-contained path. This removes the extra sample-sized
  union input and global sort per comparison. The oracle tests cover signed
  zeros, duplicates, uneven/insufficient blocks, 30 randomized duplicate-heavy
  inputs, and prove the supplied view is not mutated. Isolated union setup on
  duplicate-heavy 16k samples improved 2.28 -> 1.55 ms (~32%); end-to-end
  timings overlapped, so no sweep speedup is attributed to this phase alone.

Full-result fingerprints matched before and after the implemented phases:
clean `8aba55c2…`, sparse `5adb7a75…`, interleaved `9d432190…`, ties
`d646c5e7…`, horizons `43840d42…`, and large `1af04e78…`. End-to-end worker
reuse sweep hash remained `6f4772a31366`. A/A interleaved timings (baseline
367/372/386 ms; changed 360/376/401 ms) overlap; an apparent roughly 13%
slowdown during the run battery tracked host drift.

Validation recorded in the worktree: replay engine 84/84, max-active 12/12,
horizon summary, Finder Arm runner/metrics/settings, and TOP_MEAN server tests
pass; `npm run typecheck` is clean. `npm run typecheck:tests` reports three
pre-existing worker-pool spec errors, verified against the stashed baseline.
An initial TS18047 in the new endpoint assertion was corrected to compare
nullable endpoints with `Object.is` for numbers; that corrected assertion is
included in `b318bf63` and its spec passed. No implementation tests were
rerun during this documentation update.

The temporary branch/worktree remain in place and unmerged. Phase 2 stays
rejected unless a different design has new evidence; do not merge or cherry-
pick it as a group without preserving that decision and the recorded
verification limits.
