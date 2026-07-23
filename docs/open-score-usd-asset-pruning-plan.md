# OPEN_SCORE USD TOP_MEAN Asset Pruning — ABANDONED (negative result)

> **Status: ABANDONED.** This plan was implemented and tested on 2026-07-24 and
> **did not improve the TOP_MEAN delta** — it made it worse at every horizon.
> The implementation has been reverted. This document is kept as a record of
> the negative result so the approach is not re-attempted blind.
>
> **Why it failed (the mechanism):** `delta = topMean - randomMean`. The pruning
> cohort was chosen from `topMeanByAsset` (assets that underperform *when picked
> as top*). Those same weak assets were also sitting in the uniform-random
> candidate pool, dragging `randomMean` *down* — which was *helping* delta.
> Removing them raised the random floor faster than it improved the top pick, so
> `delta` compressed. The rule was structurally blind to the random-pool side of
> the equation, so no threshold tweak could fix it.
>
> **Measured (full S&P 500 4H, horizons 12/24/48, before -> after pruning):**
>
> | Horizon | delta before [CI95] | delta after [CI95] |
> |---|---|---|
> | 12 | +0.38% [+0.17, +0.59] 8/10 | +0.33% [+0.07, +0.58] 8/10 |
> | 24 | +0.68% [+0.27, +1.12] 8/10 | +0.61% [+0.11, +1.15] 6/10 |
> | 48 | +1.81% [+0.80, +2.85] 7/10 | +1.47% [+0.42, +2.61] 6/10 |
>
> **Lesson:** selector `delta` is the wrong objective for pruning. Any in-sample
> delta improvement would be overfitting anyway. To judge universe pruning,
> derive the cohort on a train window and evaluate on real backtest PnL/Sharpe
> out-of-sample, not the per-event selector delta.
>
> The original implementation plan follows for reference only.

---

# OPEN_SCORE USD TOP_MEAN Asset Pruning — Implementation Plan

## Goal

After a full S&P 500 TOP_MEAN run, identify a group of weak
TOP_MEAN-selected assets and produce a narrowed pair list with every pair
touching those assets removed. The user can apply the narrowed list and run the
existing coordinator again.

The feature does not run one backtest per asset, automatically iterate through
removal groups, change strategy execution, or add a database. The per-asset
delta is a screening signal, not a causal guarantee that an asset is solely
responsible for the full-universe result.

## Existing architecture

```text
POST /api/batch-backtest/sp500-top-mean/run
  -> batch-backtest-vite-plugin.ts
  -> TopMeanCoordinatorEngine.run()
  -> compact pair artifacts
  -> runOpenScoreUsdReplay()
  -> TopMeanResultSummary + result.json + Batch UI
```

Relevant files:

- `lib/batch-backtest/batch-open-score-usd-replay-engine.ts`
  - returns the complete `topMeanByAsset` ledger in each horizon;
  - `AssetSelectionSummary.delta` is the selected asset's return minus the
    random positive-candidate return for its selected events.
- `lib/batch-backtest/sp500-top-mean-coordinator-engine.ts`
  - owns pair enumeration, replay, result persistence, and the canonical pair
    list available for filtering.
- `lib/batch-backtest/sp500-pair-enumerator.ts`
  - creates the ordered canonical pair list.
- `lib/batch-backtest/sp500-top-mean-artifact-store.ts`
  - provides run-directory paths and atomic writes.
- `lib/batch-backtest/batch-backtest-vite-plugin.ts`
  - owns local-only coordinator routes.
- `lib/batch-backtest/batch-backtest-service.ts`
  - starts the coordinator, renders results, and manages the Batch symbols
    textarea.
- `lib/batch-backtest/batch-backtest-dom.ts` and
  `html-partials/tab-batch-backtest.html`
  - own the relevant UI controls and DOM contracts.

The implementation must reuse the existing replay result and canonical pair
list. It must not modify the backtest engine, synthetic-pair construction,
artifact trade semantics, or ordinary Batch limits.

## Selection and filter contract

Pruning is enabled with:

```text
horizon   selected replay horizon used to screen assets
minEvents minimum selected events required for screening
```

An asset is included in the removal cohort when, at the selected horizon:

```text
AssetSelectionSummary.delta < 0
and AssetSelectionSummary.events >= minEvents
```

All qualifying assets are removed together. A pair is removed when either
canonical leg is in the cohort. Remaining pairs keep their original order,
orientation, and tokens.

The recommendation contains asset names, per-asset metrics, source and
remaining pair counts, removed-pair count, source and remaining pair hashes,
the selected rule, and warnings. The large pair-list text is stored separately
from the normal streamed result.

## Data flow

```text
baseline replay result
  -> topMeanByAsset at selected horizon
  -> select all qualifying assets as one cohort
  -> filter enumRes.canonicalPairs
  -> persist recommendation metadata and recommended-pairs.txt
  -> render/copy/apply recommendation
  -> user reruns existing coordinator with narrowed list
```

# Phase 1 — Pure cohort selection and pair filtering

## Objective

Implement deterministic group selection and pair filtering without DOM, Vite,
filesystem, or backtest dependencies.

## Scope

Add one server-safe leaf module. Do not add replay loops or new runtime state.

## Technical tasks

1. Add `lib/batch-backtest/batch-open-score-usd-asset-pruning.ts`.
2. Define types for pruning options, candidate assets, and the recommendation
   summary.
3. Select candidates from
   `OpenScoreUsdReplayResult.horizons[].topMeanByAsset`.
4. Normalize assets using existing marked-IBKR helpers.
5. Filter canonical pairs using the existing synthetic-pair token parser.
6. Preserve pair order and orientation and calculate source/remaining hashes
   with the existing deterministic hash convention.
7. Reject an empty cohort result that leaves fewer than two assets or zero
   pairs.

## Dependencies

- `OpenScoreUsdReplayResult` and `AssetSelectionSummary`.
- Existing synthetic-pair parsing and marked-symbol helpers.
- Existing deterministic hash helper.

## Risks or blockers

- A negative per-asset delta is a screening rule, not proof of individual
  causality.
- The selected horizon and minimum-event default must be fixed in the request
  contract before implementation.
- Custom pair lists may be incomplete graphs; filtering must use actual lines.

## Deliverables

- Pure cohort-selection function.
- Pure canonical-pair filtering function.
- Versioned recommendation type.

## Validation and testing criteria

- Identical inputs produce identical cohort, pair order, counts, and hashes.
- Multiple qualifying assets are selected in one cohort.
- Pairs touching any selected asset are removed.
- Unrelated pairs, reversed orientations, marked symbols, duplicates, and
  malformed lines follow existing parser behavior.
- Empty and too-small remaining universes fail explicitly.

## Exit criteria

The module can produce one deterministic removal cohort and narrowed pair list
from an existing replay ledger and canonical pair list without loading market
data or invoking a backtest.

# Phase 2 — Coordinator recommendation and persistence

## Objective

Create the recommendation after the existing full replay and persist the
narrowed pair list without adding another per-asset computation.

## Scope

Extend the existing S&P 500 coordinator result and run directory. The normal
coordinator replay remains the baseline and runs exactly once.

## Technical tasks

1. Extend `TopMeanCoordinatorRunRequest` with optional pruning enablement,
   horizon, and minimum-event settings.
2. Validate the settings in `handleSp500TopMeanRunRequest`.
3. After the existing replay completes, pass the selected horizon's
   `topMeanByAsset` and `enumRes.canonicalPairs` to the phase-1 module.
4. Add optional pruning metadata to `TopMeanResultSummary` and `result.json`:
   - selected rule;
   - removed assets and their metrics;
   - source, removed, and remaining pair/asset counts;
   - pair hashes;
   - status and warnings.
5. Write `recommended-pairs.txt` under the run directory with the existing
   atomic artifact-store helper.
6. Add a run-id-scoped local-only GET route in
   `batch-backtest-vite-plugin.ts` to retrieve the recommended pair list on
   explicit user action.
7. Apply existing loopback authorization, safe run-id validation, and bounded
   response handling to the new route.
8. Emit only bounded progress and diagnostic counters: cohort size, pair
   counts, and completion status.

## Dependencies

- Phase 1 module.
- `TopMeanCoordinatorEngine.run()` and `enumRes.canonicalPairs`.
- Existing artifact-store atomic writes.
- Existing local-route authorization and run-id contracts.

## Risks or blockers

- A full S&P 500 run with no qualifying assets must remain a valid completed
  run with an explicit `no_candidates` recommendation status.
- A large pair list must not be embedded in the normal NDJSON result.
- A failed recommendation write must not invalidate the baseline replay result.
- A stopped run must not expose a partial recommended pair list as complete.

## Deliverables

- Additive coordinator pruning metadata.
- Persisted recommended pair list.
- Run-id-scoped pair-list retrieval route.

## Validation and testing criteria

- Pruning-disabled runs produce the existing result and no recommendation.
- Enabled runs select all qualifying assets in one operation.
- Pair counts and hashes match the pure filter output.
- Result files with and without pruning metadata round-trip correctly.
- Route authorization, run-id validation, stop handling, and missing-list errors
  are covered.

## Exit criteria

The coordinator can complete its normal full run and produce one valid,
retrievable narrowed pair list without starting additional backtest workers or
per-asset replay jobs.

# Phase 3 — UI inspection and pair-list application

## Objective

Let the user inspect the group recommendation and use the narrowed list in the
existing Batch workflow.

## Scope

Extend the existing S&P 500 TOP_MEAN controls and results container. Do not add
a new tab or a second state store.

## Technical tasks

1. Add pruning enablement, horizon, and minimum-event controls to
   `html-partials/tab-batch-backtest.html`.
2. Register new structural ids in `batch-backtest-dom.ts`.
3. Thread options through `batch-backtest-service.ts`.
4. Render the selected rule, removed assets, asset metrics, source/remaining
   pair counts, and warnings in `batchBacktestSp500TopMeanResults`.
5. Add copy and apply actions for `recommended-pairs.txt`.
6. Applying the list must update the existing Batch symbols textarea, dispatch
   its normal invalidation event, and clear old run/provenance state.
7. Keep the full structured recommendation in the existing result download;
   keep the human-readable report compact.

## Dependencies

- Phase 2 result metadata and pair-list route.
- Existing Batch symbols textarea and invalidation path.
- Existing DOM contract and result rendering patterns.

## Risks or blockers

- Applying a recommendation changes the next run input and must not preserve a
  stale fingerprint or Balanced Generator provenance.
- Large pair lists must be copied/applied without rendering them into the
  results DOM.
- The UI must label the output as a screening recommendation and show the
  exact rule used.

## Deliverables

- Visible cohort recommendation.
- Copy recommended pair-list action.
- Apply recommended pair-list action.

## Validation and testing criteria

- DOM contract tests pass for all new ids.
- Request options serialize only when pruning is enabled.
- Empty, successful, interrupted, and failed recommendations render clearly.
- Apply invalidates old run state and manual textarea edits invalidate the
  recommendation action.
- Copy output includes the rule, asset cohort, and pair counts.

## Exit criteria

The user can run the full universe, inspect one group recommendation, apply or
copy the narrowed pair list, and start the existing coordinator again.

# Phase 4 — Regression, performance, and rollback

## Objective

Verify that the feature is deterministic, bounded, and additive to the current
TOP_MEAN workflow.

## Scope

Run focused tests and the existing server-side Batch validation commands.

## Technical tasks

1. Add pure-module tests for cohort selection and pair filtering.
2. Add coordinator/server tests for additive persistence, pair-list retrieval,
   authorization, stop handling, and partial-write failures.
3. Add UI copy/apply and DOM contract tests.
4. Run typecheck and the existing Batch replay, server-plugin, copy, loader
   parity, and DOM contract suites from `AGENTS.md`.
5. Use small deterministic fixtures for tests and one representative large
   retained-artifact smoke run. Confirm that pruning starts no pair workers.

## Dependencies

- Phases 1–3.
- Existing test fixtures and local Vite server.

## Risks or blockers

- A 124,000-pair run is not suitable for every test invocation; large-list
  behavior must be covered by bounded fixtures and a targeted smoke run.
- Direct `tsc`/`esno` invocation may be required when sibling workspace names
  conflict, as documented in `AGENTS.md`.

## Deliverables

- Focused regression tests.
- Performance and bounded-memory evidence.

## Validation and testing criteria

- `tsc --noEmit` passes.
- Focused pruning, coordinator, server route, copy, and DOM tests pass.
- Pruning-disabled behavior is unchanged.
- Repeated identical inputs produce identical cohort and pair hashes.
- No partial recommendation is available after stop or failed persistence.

## Exit criteria

The group recommendation and narrowed pair list are deterministic, usable, and
backward-compatible with existing coordinator runs.

## Rollback strategy

Disable pruning in the UI or remove the additive pruning field and route. The
existing full replay, manifests, compact artifacts, result files, and Batch
pair-list workflow remain usable without migration.
