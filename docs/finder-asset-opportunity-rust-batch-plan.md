# Finder Asset Opportunity Multi-Asset Rust Batch Plan

Status: planned (no implementation yet)  
Date: 2026-08-18  
Scope: server-side Finder Asset Opportunity in-sample candidate simulation for
single runs and batch OOS holdout iterations. The existing TypeScript path,
fresh-entry checks, winner OOS checks, browser Finder, Finder Universe, and
Batch Backtest remain the authority until this plan passes parity validation.

## Current architecture and constraints

The server Asset Opportunity flow is:

```text
POST /api/finder/asset-opportunity(-batch)-run
  -> finder-vite-plugin.ts
  -> asset-opportunity-iteration.ts
  -> finder-asset-opportunity-runner.ts
  -> server-asset-is-search.ts
  -> finder-asset-candidate-execution.ts
  -> executeBacktest() per candidate
```

`runServerAssetIsSearch` currently generates signals in TypeScript, uses the
per-worker signal cache, evaluates candidates one at a time, and feeds results
to `FinderResultRanker`. The latest diagnostic showed 100,983 candidate
evaluations, 100% signal-cache hits, and 107,366 ms of cumulative candidate
backtest time against 8,353 ms wall time. Signal generation is therefore not
the first Rust target; the candidate simulation path is.

The repository contains only the Rust client (`lib/rust-engine-client.ts`),
not the Rust server source or a Cargo workspace. The existing client exposes:

- `POST /api/backtest` for one dataset and one run;
- `POST /api/backtest/batch` for multiple candidates sharing one dataset,
  including `compact` output;
- `/api/data/cache` plus a cached batch endpoint for one cached dataset.

The current Asset Opportunity path does not use the batch endpoint. It calls
the single-run endpoint indirectly through `executeBacktest`, whose Rust path
also does not carry the Asset Opportunity compact, endpoint-selection, or
trade-history options. The external Rust server's exact execution semantics
are an explicit dependency, not an assumption.

No database, persistence schema, public route, UI partial, or browser API
change is planned. The existing loopback Rust server and worker-thread pool
remain the infrastructure boundary. The current Rust worker cap of eight is
kept until measurements prove the external server can safely process more.

## Phase 0 — Freeze the Rust compatibility contract

### Objective

Determine whether the external Rust server can reproduce the actual Asset
Opportunity execution profile before any eligibility gate or result path is
changed.

### Tasks

1. Inspect the external Rust server's health/version and batch implementation,
   using the request shapes already represented in `lib/rust-engine-client.ts`.
2. Build a capability matrix for the settings used by Asset Opportunity:
   `next_open`/`next_close`, slippage, disabled same-bar exits, long/short
   direction, commission, stop/take-profit behavior, one open position, and
   percent/fixed sizing.
3. Confirm how compact results represent endpoint-adjusted selection metrics
   and optional trade history. The batch result must contain enough information
   for the existing `buildSelectionResult`/`BacktestEndpointSelection` contract,
   or the Rust adapter must normalize an equivalent result without changing
   ranking semantics.
4. Resolve the current permanent TypeScript gate in
   `lib/rust-settings-sanitizer.ts` only after the external behavior is proven.
   Do not remove the `allowSameBarExit`, slippage, or execution-model guards
   merely to make Rust calls occur.

### Dependencies

- Access to the external Rust server source or an authoritative API/version
  contract.
- Deterministic TypeScript fixtures covering `next_open`, slippage, long, and
  short trades.

### Risks or blockers

- The Rust implementation is outside this repository, so support cannot be
  inferred from the TypeScript client.
- A Rust result that is numerically close but differs in fill timing, slippage,
  or endpoint adjustment would silently change research conclusions.
- If the external server cannot accept multiple datasets, the full multi-asset
  path cannot be completed without an external extension to the existing Rust
  batch API.

### Deliverables

- A checked-in capability/parity note in this document or its implementation
  follow-up describing the confirmed external request and response contract.
- A go/no-go decision for the multi-asset batch path.

### Validation/testing

- Health/version probe against `127.0.0.1:3030`.
- Rust-versus-TypeScript fixture comparisons for every supported execution
  feature in the matrix.
- Explicit negative cases for unsupported settings.

### Exit criteria

Rust support is either proven for the exact profile or explicitly marked
unsupported. If the external contract is unavailable or parity fails, stop the
implementation at this phase and keep the current TypeScript path unchanged.

## Phase 1 — Add bounded batch transport and compact normalization

### Objective

Use one Rust batch request for many candidate simulations while preventing
per-candidate HTTP overhead, oversized requests, and unbounded result retention.

### Tasks

1. Extend `lib/rust-engine-client.ts` using the existing batch/cache patterns.
   Prefer the existing `/api/backtest/batch` contract when all items share one
   dataset. If full multi-asset support requires a server extension, add only
   the smallest confirmed extension that lets each item identify its dataset;
   do not invent a second Rust service or a browser-facing route.
2. Keep dataset transfer bounded. Do not send all 499 assets in one unbounded
   payload. Partition by measured serialized payload size and available worker
   memory; transfer each dataset once per request or use the existing Rust data
   cache when the external contract supports stable dataset references.
3. Add compact-result validation and normalization. Reject malformed, missing,
   duplicate, or inconsistent candidate IDs rather than silently dropping them.
4. Preserve existing request timeouts and add caller cancellation support if
   the batch request otherwise prevents the Finder Stop path from returning.
5. Add an opt-in server feature gate, such as an environment-controlled batch
   mode, so the Rust bridge is not activated by the existing UI preference until
   parity and performance validation are complete. The UI Rust preference and
   the feature gate must both permit the path.

### Dependencies

Phase 0 and the external Rust batch contract. Existing worker-thread and
loopback conventions in `finder-asset-opportunity-batch-worker-pool.ts` and
`docs/finder-asset-opportunity-batch-parallelization.md` remain in force.

### Risks or blockers

- The Rust server may serialize requests; more worker threads could increase
  queueing instead of reducing wall time.
- The current client keeps only four cached datasets per worker and the current
  single-run request posts full OHLCV data. The new path must not reproduce that
  cache thrashing pattern.
- Compact results must retain all scalars used by `FinderResultRanker`, OOS
  grading, and archive output, while avoiding `trades`/`equityCurve` unless a
  later phase explicitly needs them.

### Deliverables

- A server-safe Rust batch client method or a narrowly extended existing method.
- Request-size, response-shape, timeout, and cancellation handling.
- Feature-gate and debug timing/counter instrumentation.

### Validation/testing

- Mocked-fetch tests for request shape, compact mode, response validation,
  timeout, cancellation, and partial-result failure.
- `npm run typecheck` and `npm run typecheck:tests`.

### Exit criteria

A bounded batch request can be sent and rejected safely without changing any
existing caller or result contract. A failed request returns an explicit
fallback signal, never an empty successful result.

## Phase 2 — Integrate batch scoring into server Asset Opportunity

### Objective

Batch only the expensive in-sample candidate simulations while preserving the
existing TypeScript signal generation, signal-cache reuse, candidate ranking,
freshness logic, and deterministic ordering.

### Tasks

1. In `server-asset-is-search.ts`, retain parameter generation,
   `createPreparedFinderStrategy`, signal-cache lookup, risk-override
   resolution, and candidate ID/order generation.
2. Mirror the existing preparation/dispatch pattern in
   `finder-runner-single.ts` (`prepareRustBatchRuns` and
   `dispatchRustBatchWithFallback`) in a server-safe Asset Opportunity seam.
   Do not import browser-bound Finder modules.
3. Build batch items from already generated signals and the candidate-specific
   Rust-compatible settings. Map results back to the existing candidate
   objects, then run the current `buildSelectionResult` and `FinderResultRanker`
   flow unchanged.
4. Prefer grouping candidates across the active asset chunk so the Rust server
   receives multiple assets and multiple parameter candidates per bounded
   request. The current `server-asset-is-search.ts` owns one asset at a time;
   if grouping requires moving orchestration, make the smallest seam in
   `asset-opportunity-iteration.ts` and keep the existing per-asset result
   reduction intact.
5. Keep these paths TypeScript initially: signal-only fresh-entry rechecks,
   fixed/complementary OOS winner validation, exit-strategy overrides, and any
   cross-symbol case whose resolved data contract is not covered by Phase 0.
   They are either cheap in the current diagnostic or require additional
   trade-path semantics.

### Dependencies

Phase 1. The existing `AssetOpportunityIterationResult` scalar boundary,
`FinderAssetOpportunityDiagnostics.engineUsage`, and ordered batch worker
protocol remain unchanged unless diagnostics need new optional counters.

### Risks or blockers

- `executeBacktest` currently owns the generic Rust decision and does not pass
  Asset Opportunity compact/endpoint options to the single Rust endpoint. The
  new batch path must not quietly bypass those semantics for unrelated callers.
- Candidate-specific exit/risk settings may make a batch item ineligible even
  when its base run is eligible.
- A multi-asset grouping change can accidentally alter prepared-data identity,
  signal-cache keys, random seeds, or ranker insertion order.

### Deliverables

- Server Asset Opportunity in-sample batch dispatch with a TypeScript fallback.
- No change to browser output, archive format, stream events, or final scalar
  candidate shape.
- Engine diagnostics that distinguish Rust batch items, TypeScript items, and
  fallback items; add request counts/latency only if the existing counters
  cannot explain a run.

### Validation/testing

- Add a focused Asset Opportunity Rust-batch spec with a fake Rust client:
  identical candidate IDs and metrics must produce identical ranker output to
  the TypeScript path.
- Cover long, short, `next_open`, slippage, endpoint selection, compact output,
  no-signal candidates, missing Rust IDs, malformed results, and mixed
  Rust/TypeScript fallback.
- Run the existing `finder-asset-candidate-execution.spec.ts`,
  `finder-asset-opportunity-runner.spec.ts`,
  `finder-asset-opportunity-batch-parallel.spec.ts`,
  `finder-server-plugin.spec.ts`, and signal-cache specs.

### Exit criteria

For identical seeded inputs, Rust-enabled and TypeScript-only runs have the
same candidate ordering, selection scalars, grades, OOS inputs, diagnostics
counts, and archived rows. Any failed or unsupported Rust batch returns through
the existing TypeScript candidate path and remains visible in diagnostics.

## Phase 3 — Fallback, cancellation, and rollout safety

### Objective

Make Rust an acceleration layer rather than a correctness dependency.

### Tasks

1. Fall back to TypeScript when health/capability checks fail, a request times
   out, the response is malformed or incomplete, a candidate result fails
   consistency checks, or the payload exceeds the bounded request budget.
2. For an ambiguous whole-batch failure, rerun the whole batch through the
   existing TypeScript path. For an explicitly identified bad item, rerun only
   that item. Never emit a partial candidate set as a successful iteration.
3. Propagate Stop/abort state through the server search and batch client. An
   in-flight Rust request must be bounded by timeout and must not prevent the
   worker pool from terminating.
4. Keep `FINDER_ASSET_BATCH_WORKERS=1` as the complete worker-pool rollback.
   Keep the Rust batch feature gate independently disableable, with the default
   off until rollout validation passes.
5. Preserve existing loopback authorization. No Rust endpoint is exposed to
   the browser or to remote callers; worker threads remain internal to the
   Vite process.

### Dependencies

Phases 1–2 and the existing Stop/worker ownership contracts documented in
`finder-asset-opportunity-batch-parallelization.md` and `AGENTS.md`.

### Risks or blockers

- Fallback work can temporarily duplicate CPU cost after a Rust timeout.
- A Rust server that returns numerically valid but semantically different
  results must be treated as a parity failure, not as a successful fallback.
- Feature flags and diagnostics must not let a stale Rust preference silently
  reduce the TypeScript worker pool again.

### Deliverables

- Explicit fallback reason reporting.
- Stop-safe batch requests and worker cleanup.
- Documented rollout and rollback switches; no database migration.

### Validation/testing

- Force health failure, timeout, malformed response, missing ID, and inconsistent
  result in tests; assert the TypeScript result is still complete and ordered.
- Run a cancelled batch while Rust requests are active and verify terminal
  cancellation plus worker cleanup.
- Verify the Rust feature being disabled restores the current 8.35-second-class
  TypeScript path and does not change worker sizing.

### Exit criteria

Every failure mode produces a complete, deterministic TypeScript result or a
visible fatal state. No failure silently drops candidates, hangs Stop, or
changes the archive contract.

## Phase 4 — Performance qualification and activation

### Objective

Activate the Rust batch path only if it improves the measured workload without
exceeding the existing memory and correctness envelope.

### Tasks

1. Benchmark the same seeded 499-asset, 45-strategy workload with the feature
   off and on, including one warmed holdout and the intended two-holdout run.
2. Record wall time, cumulative candidate time, Rust request count/latency,
   payload size, fallback count, worker count, RSS, cache hits, and result
   parity.
3. Keep the existing Rust worker cap of eight for the first rollout. Change it
   only after an external-server benchmark shows that extra concurrency reduces
   wall time rather than queueing requests.
4. Target the previously estimated 3–5 seconds per warmed holdout. Treat a
   result outside that range as a measurement to investigate, not as permission
   to relax parity or memory safeguards.

### Dependencies

All previous phases, a running compatible Rust server, and the existing local
data/cache setup used for the baseline diagnostic.

### Risks or blockers

- The current TypeScript run is already parallelized; Rust's raw simulation
  speed will not translate directly to end-to-end speed.
- Sending too many assets per request can move the bottleneck from simulation
  to serialization, network transfer, or Rust-server memory.
- A speed win on one asset mix may regress synthetic pairs or short-history
  symbols.

### Deliverables

- A before/after benchmark record for the exact workload.
- Updated Rust/Finder documentation only after the behavior is enabled.
- Feature activation decision: enabled by opt-in, left opt-in, or disabled.

### Validation/testing

- `npm run typecheck`
- `npm run typecheck:tests`
- Focused Rust batch, Asset Opportunity, server plugin, runner, compact parity,
  and diagnostics specs.
- Manual one-holdout and two-holdout runs with identical seeds and archive
  comparison.

### Exit criteria

Enable the feature only when metrics are parity-equivalent, fallback tests are
green, memory remains within the existing worker budget, and the warmed holdout
beats the TypeScript baseline by a meaningful margin. Otherwise keep the gate
off and retain the current TypeScript implementation.

## Rollback

The first rollback is the Rust batch feature gate, which returns all Asset
Opportunity candidate simulations to the current TypeScript path. The existing
`FINDER_ASSET_BATCH_WORKERS=1` switch remains the independent worker-pool
rollback. A code revert must not be required to recover normal operation, and
no archive, localStorage, SQLite, or other persisted schema changes are part of
this plan.
