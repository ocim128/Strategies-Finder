# Finder Asset Opportunity Rust `next_open` + Max-Hold Parity Plan

Status: Proposed; implementation has not started  
Date: 2026-08-28  
Scope: server-owned Finder Asset Opportunity for the current `next_open`,
single-position, fixed-sizing, `riskMaxHoldBars: 2`, `next_exit` configuration.

This is a temporary implementation plan. After the work ships, fold the final
behavior into [backtest-engines-typescript-rust.md](backtest-engines-typescript-rust.md)
and delete this plan, following the maintenance rule in [README.md](README.md).

## Decision summary

TypeScript remains the semantic reference. Rust support is enabled only after
the Rust kernel, wire protocol, client eligibility, and every Asset Opportunity
execution path can represent the active settings without dropping fields.

The smallest correct change is:

1. Add max-hold and authoritative exit reasons to the existing Rust engine.
2. Correct the known `next_open`, fee-percentage, and end-of-data parity gaps.
3. Advertise those semantics through the existing Rust health endpoint.
4. Make the generic and Asset Opportunity Rust gates capability-aware.
5. Reuse the current candidate, fresh-entry, and generic backtest endpoints;
   do not add another service or public Finder route.
6. Keep TypeScript fallback concurrency at one until all selected strategies,
   active settings, and required IS/fresh/OOS paths pass the same Rust fence.

No UI, localStorage, database, Worker, browser route, strategy-registration, or
market-data schema change is required. Signal generation, parameter generation,
ranking, freshness grading, `next_exit` metric calculation, and OOS verdicts
remain TypeScript-owned.

## Assumptions and unknowns

- The supplied configuration is authoritative. Unlisted resolved values such
  as commission and ATR risk settings still participate if enabled at runtime.
- `maxOpenTrades: 1` is required. Rust's current one-position state is not
  extended to overlapping-position or unlimited group-anchor semantics.
- Finder-normalized max-hold values are integer bars. The generic TypeScript
  engine can compare a fractional threshold, but the current value `2` is exact.
- The selected 45 strategies are built-in entry strategies without cross-symbol
  execution or behavior-bearing signal extensions. This must be verified; a
  signal carrying `triggerPrice`, `sizeFraction`, or `exitOnly` is not eligible
  until Rust implements that field.
- The observed counters are the baseline: 35,100 `risk_control_unsupported`,
  42,401 `execution model is not signal_close`, and 560 no-signal shortcuts.
- The existing Rust service is the in-repository crate under `rust-engine/` and
  remains a loopback-only process on `127.0.0.1:3030`.

## Current architecture and semantic contract

### Data flow

```text
runAssetOpportunityIteration
  -> runAssetOpportunitySearch
     -> runServerAssetIsSearch
        -> TypeScript strategy/parameter signal generation
        -> Asset Opportunity Rust scalar batch OR TypeScript fallback
        -> unchanged FinderResultRanker flow
     -> fresh-entry recheck
        -> Rust fresh summary when eligible OR executeAssetCandidate
     -> runCandidateNextExitOnAsset / runCandidateOosOnAsset
        -> executeAssetCandidate -> runAssetCandidateBacktest -> executeBacktest
        -> TypeScript next_exit metrics / OOS verdict
  -> scalar-only Finder stream and terminal snapshot
```

Relevant ownership seams:

- `lib/finder/server/asset-opportunity-iteration.ts` owns settings-wide Rust
  eligibility and the 16-wide evaluation fan-out.
- `lib/finder/server/server-asset-is-search.ts` owns TypeScript signal
  generation, candidate settings, Rust scalar dispatch, ranker insertion, and
  whole-batch fallback.
- `lib/finder/server/finder-asset-opportunity-rust-batch.ts` owns the specialized
  capability fence, bounded transport, response validation, and normalization.
- `lib/finder/finder-asset-opportunity-runner.ts` owns bounded freshness replay,
  `next_exit` winner replay, and OOS candidate execution.
- `lib/finder/finder-asset-candidate-execution.ts` owns the shared candidate
  execution settings and compact/trade-history option matrix.
- `lib/backtest-executor.ts` and `lib/rust-settings-sanitizer.ts` own generic
  engine selection and TypeScript fallback.
- `lib/strategies/backtest/*` remains the authoritative execution behavior.

### TypeScript behavior that Rust must reproduce

`barsInTrade` starts at zero. The entry candle is not a held bar.

| Model | Signal at bar `i` | Fill | Max hold 1 | Max hold 2 |
| --- | --- | --- | --- | --- |
| `signal_close` | close `i` | close `i` | close `i+1` | close `i+2` |
| `next_open` | close `i` signal | open `i+1` | close `i+2` | close `i+3` |
| `next_close` | close `i` signal | close `i+1` | close `i+2` | close `i+3` |

The max-hold check in `processPositionExits(...)` runs after stop loss, take
profit, partial take profit, and path exits, and before the legacy losing-only
time stop. It closes the full remaining position at the candle close with
direction-correct exit slippage and reason `time_stop`.

For `next_open`, open-only exits and shifted signals run before the boundary
max-hold check. A shifted opposite signal on the boundary bar therefore exits
at the open before max-hold can exit at the close. For `signal_close` and
`next_close`, existing-position exits run before signals, so max-hold wins the
same-bar boundary tie.

Normal execution disables same-bar signal exits. A new `next_open` position may
take its entry-bar stop loss but not entry-bar take profit, path exit, or
max-hold exit. With `maxOpenTrades: 1`, same-direction signals while occupied
are discarded, not queued. Cooldown arms after a full close when enabled; it is
disabled in the current configuration.

Any remaining position closes at the final candle close with reason
`end_of_data`, commission, and no exit slippage. If max-hold is reached on the
final bar, the regular `time_stop` happens first. Long and short trades use the
same age and precedence rules with opposite fill/slippage sides.

### Current Rust gaps

| Area | Current state | Required change |
| --- | --- | --- |
| Max hold | No Rust request fields or kernel exit | Add settings and close logic |
| `next_open` | Shift/open fill exists | Correct ATR source and expose capability |
| Trade exit reason | Generic Rust `Trade` has none | Serialize authoritative `exitReason` |
| Fresh summary | Reason is synthesized as signal/EOD | Use the actual last trade reason |
| PNL percent | Based on raw PNL | Use fee-aware total PNL like TypeScript |
| End of data | Applies configured slippage | Use the unadjusted final close |
| Generic gate | Rejects every non-`signal_close` request | Relax only for advertised capability |
| Asset gate | Rejects any enabled max hold | Relax only for advertised capability |
| Fresh batch | Runner invokes it only for `signal_close` | Permit execution-aware replay after parity |
| `next_exit`/OOS | Generic execution falls back to TypeScript | Reuse Rust trade history after exit-reason parity |

## API and contract changes

The existing routes remain the transport boundary:

- `GET /api/health`
- `POST /api/backtest`
- `POST /api/backtest/asset-opportunity/batch` and cached/multi variants
- `POST /api/backtest/fresh-entry/batch` and cached/multi variants

Required wire additions:

- `BacktestSettings.riskMaxHoldEnabled: boolean`
- `BacktestSettings.riskMaxHoldBars: number`
- `Trade.exitReason: string`
- Health response `protocolVersion` plus explicit versioned capabilities, at
  minimum `backtest.next_open.v1`, `backtest.risk_max_hold.v1`, and
  `backtest.exit_reason.v1`.

The new settings use serde defaults so old requests remain valid. A protocol-v2
Rust response requires `exitReason`; an older healthy binary without the
capabilities is treated as incompatible and stays on TypeScript. Do not infer
support from the crate version.

The specialized IS route continues returning scalar summaries. Fresh routes
continue returning only total trades, latest-trade entry data, actual exit
reason, and open state. Generic `next_exit` replay retains trades inside the
server process because `calculateFinderAssetOosNextExitMetrics(...)` needs them;
those arrays must not cross the scalar Finder stream boundary.

## Cross-cutting constraints

### Persistence, infrastructure, and security

- No database, migration, localStorage, archive, or cache-key schema change.
- Rebuild/restart the local Rust binary; no cloud deployment is involved.
- Keep loopback binding, current CORS allowlist, body limits, request-size
  limits, response-size limits, and cache budgets unchanged.
- Do not add a browser-callable proxy or expose Rust directly beyond the
  existing local service.

### Error handling and rollback

- Missing capabilities, unavailable health, malformed output, missing or
  duplicate result IDs, request/response limit failures, timeout, or network
  failure take the existing whole-dispatch TypeScript fallback with the full
  resolved settings.
- Cancellation stops work and must not start a TypeScript fallback.
- Capability skips do not increment `rustAttemptedRuns`; actual failed requests
  do increment existing Rust attempt/fallback diagnostics.
- Keep `FINDER_ASSET_OPPORTUNITY_RUST_BATCH=0`,
  `FINDER_ASSET_OPPORTUNITY_RUST_FRESH_BATCH=0`, and the UI Rust preference as
  rollback controls. Removing a capability from Rust health also forces a safe
  TypeScript fallback.

### Performance and concurrency

- Do not change cache keys, dataset slicing, candidate IDs, random seeds,
  ranker insertion order, or multi-batch size limits.
- Keep `evaluationConcurrency = 1` whenever any selected strategy, active
  setting, required follow-up path, or behavior-bearing signal shape can fall
  back to TypeScript. This preserves the protection against a 16-by-16
  TypeScript oversubscription wave.
- `candidatePoolSize: 3` remains below the existing fresh-batch density gate of
  eight. Do not lower that threshold in this work; generic Rust execution may
  accelerate current fresh/OOS replays without enabling the specialized fresh
  batch.
- Treat the 35,100 IS calls as the first coverage target. Full coverage can
  include the remaining simulation-bearing fresh/OOS calls, while the 560
  no-signal shortcuts intentionally remain TypeScript. Actual wall-time gain is
  a benchmark decision because signal generation and loopback transport can
  dominate low-density workloads.

## Phase 0 - Freeze parity fixtures and the capability contract

### Objective

Capture the current TypeScript behavior before changing Rust or eligibility.

### Tasks

1. Add focused TypeScript goldens for `next_open` max-hold values one and two,
   including exact bars, prices, reasons, fees, and final-open behavior.
2. Cover boundary precedence, occupied capacity, same-bar suppression, long,
   short, nonzero fees/slippage, and end-of-data.
3. Add current Asset Opportunity `next_exit` fixtures for the bounded replay
   window, 26-bar holdout, boundary entry matching, and EOD censoring.
4. Freeze the health capability names and protocol version used by the client.
5. Record the current diagnostics and a production-shaped timing baseline for
   the supplied 45-strategy workload.

Affected tests:

- `tests/backtesting-engine.spec.ts`
- `tests/finder-asset-opportunity-runner.spec.ts`
- `tests/finder-asset-opportunity-oos.spec.ts`
- `tests/rust-settings-parity.spec.ts`
- `tests/rust-engine-client.spec.ts`

### Dependencies

None. TypeScript remains forced through `engineMode: "typescript"` for goldens.

### Risks or blockers

- Existing broad engine tests do not directly lock every `next_open` max-hold
  boundary.
- Floating-point comparison without a documented tolerance can hide or create
  false parity failures.

### Deliverables

- Deterministic TypeScript fixtures and a versioned capability contract.
- Baseline engine counters and wall-clock timings.

### Validation/testing

- Run the focused TypeScript specs twice and verify identical ordering/output.
- Require exact discrete fields and a small documented tolerance for floating
  metrics; do not use rounded display values as the golden source.

### Exit criteria

Every requested edge case has an authoritative TypeScript expectation, and the
Rust capability names cannot change without a client test failure.

## Phase 1 - Implement Rust kernel and response parity

### Objective

Make the Rust engine reproduce the frozen single-position max-hold and
`next_open` behavior before any TypeScript eligibility gate is relaxed.

### Tasks

1. In `rust-engine/src/types.rs`, add max-hold fields to `BacktestSettings` and
   `exitReason` to `Trade` using the existing camel-case serde conventions.
2. In `rust-engine/src/backtest/engine.rs`, normalize max hold and add its full
   exit after partial/price exits and before the legacy time stop. Do not add it
   to `OpenOnly` or entry-bar `StopLossOnly` processing.
3. Pass explicit exit reasons through every `exit_position(...)` call.
4. Seed `next_open` ATR/risk calculations from the previous closed bar, matching
   `position-builder.ts`.
5. Make EOD use the raw final close without slippage.
6. Calculate `pnlPercent` from fee-aware total PNL and reconcile any consumed
   scalar metric that differs from TypeScript.
7. In `rust-engine/src/api/routes.rs`, build fresh summaries from the actual
   latest trade reason instead of synthesizing `signal`/`end_of_data`.
8. In `rust-engine/src/main.rs`, advertise the protocol version and proven
   capabilities from `/api/health`.

### Dependencies

Phase 0 goldens and the existing one-position Rust execution loop.

### Risks or blockers

- Changing PNL percentage can affect Sharpe or summaries beyond max-hold; all
  consumers must be compared, not only trade lists.
- Exit precedence can drift if max-hold is inserted into the open-only branch.
- Rust currently supports only one position; extending overlap here would
  expand the task and is explicitly out of scope.

### Deliverables

- Rust max-hold settings, authoritative trade reasons, corrected EOD/fee/ATR
  behavior, and versioned health capabilities.
- Rust unit tests for every Phase 0 execution fixture.

### Validation/testing

- `cargo fmt --check`
- `cargo test`
- `cargo clippy --all-targets -- -D warnings`
- Live health and single-backtest probes against the rebuilt loopback service.

### Exit criteria

Rust matches all discrete golden fields and agreed numerical tolerances for
long and short trades. No TypeScript eligibility has been relaxed yet.

## Phase 2 - Make the Rust client and generic executor capability-aware

### Objective

Allow generic `next_open` plus max-hold execution only against a Rust service
that explicitly advertises the required semantics.

### Tasks

1. Extend `RustHealthResponse` and `RustEngineClient.checkHealth(...)` in
   `lib/rust-engine-client.ts` to cache and expose the capability set while
   preserving current positive/negative health caching.
2. Make `getTypescriptEngineRequirementReasons(...)` and
   `sanitizeBacktestSettingsForRust(...)` in `lib/rust-settings-sanitizer.ts`
   accept optional capabilities. Their default behavior remains conservative.
3. Preserve `executionModel` and max-hold fields only when the required
   capabilities exist; keep all unrelated TypeScript fences unchanged.
4. Thread capabilities through `BacktestExecutionContext` and
   `executeBacktest(...)`. Keep the complete resolved settings for fallback.
5. Add a stable `rust_capability_missing` diagnostic and preserve the no-signal
   shortcut.
6. Ensure caller cancellation reaches the single-run Rust request; cancellation
   must not be reported as an ordinary Rust failure followed by fallback.
7. Reject behavior-bearing optional signal fields before Rust instead of
   silently dropping them. A diagnostic-only signal `reason` may be compacted.

Affected files:

- `lib/rust-engine-client.ts`
- `lib/rust-settings-sanitizer.ts`
- `lib/backtest-executor.ts`
- `lib/backtest-endpoint-contract.ts`
- `lib/finder/finder-asset-candidate-execution.ts`

### Dependencies

Phase 1 protocol and Rust response parity.

### Risks or blockers

- A healthy old binary must not be mistaken for a compatible binary.
- Sanitizing for Rust and then reusing that object for TypeScript fallback
  would silently remove max-hold.
- Unknown serde fields are otherwise accepted and ignored.

### Deliverables

- Capability-aware client, sanitizer, executor context, diagnostics, and
  cancellation behavior.
- Generic Rust support for the exact current execution settings.

### Validation/testing

- `tests/rust-engine-client.spec.ts`: old/new health, caching, abort, and
  malformed capability cases.
- `tests/rust-settings-parity.spec.ts`: conservative default, capability
  success, and unsupported-setting failures.
- Focused `lib/backtest-executor.ts` tests for full-settings fallback and
  no-signal accounting.
- `npm run typecheck` and `npm run typecheck:tests`.

### Exit criteria

The generic executor attempts Rust only with the required capabilities, returns
the frozen result on success, and returns the unchanged TypeScript result for
every missing-capability or transport-failure case.

## Phase 3 - Enable Asset Opportunity IS batching

### Objective

Move the 35,100 in-sample simulations to the existing Rust scalar batch seam
without changing signal generation, ranking, or fallback behavior.

### Tasks

1. Extend `resolveAssetOpportunityRustBatchEligibility(...)` to require the
   capability set and allow enabled max hold only with
   `backtest.risk_max_hold.v1`; retain all existing unrelated fences.
2. In `runServerAssetIsSearchWithRustBatch(...)`, include candidate-resolved
   `riskMaxHoldEnabled` and `riskMaxHoldBars` alongside execution model,
   slippage, and cooldown in `rustSettingsFor(...)`.
3. Verify Finder candidate overrides from `resolveFinderRiskOverrides(...)`
   reach every Rust item. Change the Rust mirror only if an Asset Opportunity
   call site actually consumes it.
4. Validate supported signal shape before dispatch. Any unsupported item makes
   the dispatch take the existing whole-batch TypeScript fallback.
5. Preserve candidate IDs, input order, cache IDs/windows, scalar summaries,
   endpoint adjustment, result validation, and ranker insertion.
6. Keep `evaluationConcurrency` at one until every selected strategy and the
   full required setting/path capability matrix is certified. Enable the
   existing 16-wide coordinator only after that all-selected check passes.

Affected files:

- `lib/finder/server/finder-asset-opportunity-rust-batch.ts`
- `lib/finder/server/server-asset-is-search.ts`
- `lib/finder/server/asset-opportunity-iteration.ts`
- `lib/finder/server/finder-asset-opportunity-multi-rust-batch.ts` only if its
  existing request types need the new settings/capabilities threaded through.

### Dependencies

Phase 2 capability-aware executor and the existing bounded multi-asset/cache
contracts.

### Risks or blockers

- Enabling 16-wide evaluation while any candidate falls back recreates the
  recent TypeScript oversubscription regression.
- Candidate-specific max-hold overrides can differ from base settings.
- Partial Rust/TypeScript result mixing would change deterministic reduction.

### Deliverables

- Capability-gated IS Rust batches with full max-hold settings.
- Whole-batch fallback and engine-usage diagnostics for every failure mode.

### Validation/testing

- Extend `tests/finder-asset-opportunity-rust-batch.spec.ts` for eligibility,
  request fields, candidate overrides, result order, unsupported signals, and
  whole-batch fallback.
- Extend `tests/finder-asset-opportunity-batch-parallel.spec.ts` to prove that
  one incompatible selected strategy or setting forces concurrency one.
- Verify scalar-only streaming with
  `tests/finder-asset-opportunity-stream.spec.ts` and
  `tests/finder-server-plugin.spec.ts`.

### Exit criteria

The current IS workload has no `risk_control_unsupported` skips when the new
capabilities are present, produces identical ranked candidates, and never uses
Rust-sized fan-out for a dispatch that can fall back to TypeScript.

## Phase 4 - Cover fresh-entry and OOS/`next_exit` execution

### Objective

Move execution-aware follow-ups to Rust while leaving TypeScript freshness and
OOS policy unchanged.

### Tasks

1. Let `runCandidateNextExitOnAsset(...)` and `runCandidateOosOnAsset(...)`
   reuse the generic capability-aware Rust path through
   `executeAssetCandidate(...)`; retain trade history where `next_exit` needs
   exit reasons.
2. Preserve `resolveBoundedNextExitReplayBars(...)`. For the current max hold
   of two and disabled cooldown, the bounded execution replay is five bars;
   strategy warmup remains separate and conservative.
3. Update `runServerAssetOpportunityFreshRustBatch(...)` to carry max-hold
   settings and materialize the actual summary `exitReason`.
4. Relax the runner's `executionModel === "signal_close"` fresh-batch condition
   only when the fresh endpoint advertises the required execution, max-hold,
   and exit-reason capabilities.
5. Keep the existing candidate-pool threshold of eight. With the current pool
   of three, use generic Rust rechecks rather than forcing a fresh multi-batch.
6. Keep `calculateFinderAssetOosNextExitMetrics(...)` and
   `computeFinderOosVerdict(...)` unchanged. `end_of_data` stays censored with a
   null realized PNL; `time_stop` is an exited observation.

Affected files:

- `lib/finder/finder-asset-opportunity-runner.ts`
- `lib/finder/server/finder-asset-opportunity-fresh-rust-batch.ts`
- `lib/finder/finder-asset-candidate-execution.ts`
- `lib/finder/finder-asset-opportunity-oos.ts` tests only unless a contract
  mismatch is discovered.

### Dependencies

Phase 3 and authoritative Rust trade reasons.

### Risks or blockers

- A suffix-only replay is wrong when execution state is not bounded. If
  `resolveBoundedNextExitReplayBars(...)` returns null, use the existing full
  timeline.
- A synthetic fresh summary that labels every closed trade `signal` breaks
  `next_exit` censoring and freshness detection.
- Full trade arrays must remain server-internal and must not enter streamed
  candidates or terminal snapshots.

### Deliverables

- Rust-backed generic fresh/OOS executions for the current configuration.
- Correct dense-pool fresh summaries for future eligible calls without changing
  the current density threshold.

### Validation/testing

- Extend `tests/finder-asset-opportunity-runner.spec.ts` for identical-signal
  candidates, bounded replay, occupied capacity, boundary exits, and stable
  result ordering.
- Extend `tests/finder-asset-opportunity-oos.spec.ts` for `time_stop` realized
  PNL, `end_of_data` censoring, 26-bar holdout boundaries, long, and short.
- Add Rust-available and Rust-unavailable versions of each scenario.

### Exit criteria

Fresh grade, boundary entry, `next_exit` status/value, and OOS verdict match the
TypeScript goldens. No array-valued field crosses the Finder scalar contract.

## Phase 5 - Qualify performance and roll out

### Objective

Enable Rust by measured coverage while preserving deterministic behavior and a
one-switch rollback.

### Tasks

1. Run the production-shaped Asset Opportunity benchmark with the supplied
   45-strategy, approximately 780-asset, 1,000-bar evaluation profile.
2. Measure separately: TypeScript signal generation, serialization/cache work,
   client latency, Rust processing time, IS simulation, fresh replay, and OOS.
3. First enable IS support with the specialized batch flag while keeping
   follow-up execution and fan-out conservative.
4. Enable generic fresh/OOS Rust execution after Phase 4 parity.
5. Enable 16-wide multi-asset/strategy fan-out only when the run-level preflight
   proves every selected strategy, setting, and required path compatible.
6. Compare diagnostics with the baseline. The target is Rust coverage for the
   77,501 simulation-bearing executions when all signals are supported; the
   560 no-signal shortcuts remain TypeScript by design.
7. Update the durable Rust-engine guide and remove this plan after rollout.

### Dependencies

Phases 0-4 and a rebuilt local Rust service.

### Risks or blockers

- Rust can be slower for low-density workloads when transport and signal
  generation dominate; coverage alone is not a performance result.
- Warm cache and cold cache measurements are not interchangeable.
- Raising concurrency before capability certification can turn a Rust failure
  into hundreds of simultaneous TypeScript backtests.

### Deliverables

- Before/after benchmark output, final engine counters, rollout decision, and
  updated durable documentation.

### Validation/testing

- Full TypeScript and test typechecks.
- All focused specs from Phases 0-4.
- Rust formatting, tests, and strict clippy.
- Live runs with Rust available, Rust stopped, the batch flag disabled, Stop
  during execution, warm cache, and cold cache.
- Compare deterministic candidate ordering and scalar terminal output across
  forced TypeScript, Rust-preferred, and Rust-unavailable fallback runs.

### Exit criteria

- No rank, trade, freshness, OOS, ordering, cache, cancellation, diagnostics,
  or scalar-contract parity failure.
- Rust-sized fan-out is impossible unless the entire selected workload is
  Rust-compatible.
- Rust-unavailable and flag-disabled runs retain the existing TypeScript
  behavior.
- Measured wall time justifies enabling the path; otherwise keep the capability
  implemented but leave the relevant Rust flag disabled.

## Final acceptance matrix

| Scenario | Required result |
| --- | --- |
| Signal at `i`, `next_open` | Entry at open `i+1` |
| Max hold 1 / 2 | Exit at close `i+2` / `i+3` |
| Shifted signal on max-hold boundary | `next_open` signal exit wins at open |
| Close-model signal on boundary | Max-hold wins before signal processing |
| Entry-bar adverse move | Stop loss may exit; TP/path/max-hold may not |
| Position open at final bar | Raw final close, `end_of_data`, no slippage |
| Max hold reached at final bar | `time_stop`, normal exit slippage |
| Occupied `maxOpenTrades: 1` | New same-direction signal is discarded |
| Long / short | Direction-correct PNL, fees, and slippage |
| Duplicate signal sets | Separate IDs, identical metrics, stable order |
| `next_exit` max-hold exit | Exited observation with realized fee-aware PNL |
| `next_exit` EOD close | Censored observation with null realized PNL |
| Rust missing capability | No Rust attempt; unchanged TypeScript result |
| Rust transport failure | Whole-dispatch TypeScript fallback |
| Cancellation | Abort without fallback work |
| Any selected incompatibility | Evaluation concurrency remains one |

