# Rust Engine Complexity Audit

Date: 2026-08-29
Audited commit: `bd1a89ce`
Worktree: `Strategies-Finder-rust-engine-audit-tmp`

## Executive verdict

Keep the generic Rust backtest kernel as an optional accelerator. Delete the
unreachable native optimizer APIs, the staged Asset Opportunity Rust experiment,
the unrelated proxy route, and the dead compatibility/public-library surface.

The generic path has real value: it is used by normal backtests and the current
chart Finder, has TypeScript fallback, and has meaningful parity tests. The
native Rust Finder and Walk-Forward implementation does not: its HTTP handlers
return `501`, its WebSocket only acknowledges a connection, and no in-repository
caller invokes it. The Asset Opportunity Rust path is opt-in and the checked-in
measurements show it slower than TypeScript on the tested workloads.

The recommendations below preserve the current default product behavior and
remove experimental or unreachable paths. The only material risk is an unknown
external consumer of the Rust crate or loopback endpoints; the repository has
no evidence of such a consumer.

## Scope and method

Audited only the Rust engine and its direct integration surface:

- `rust-engine/src`, `rust-engine/Cargo.toml`, and `run_playground.bat`;
- `lib/rust-engine-client.ts`, Rust selection/sanitization/validation, and the
  Rust branches in the Finder/backtest orchestrators;
- Rust-specific tests, benchmarks, and documentation.

The audit used repository call-site search, source inspection, Rust tests and
Clippy, and direct TypeScript compilation. The high-confidence recommendations
were implemented in this same temporary worktree; the implementation is kept
separate from the original checkout for review.

Validation performed:

- `cargo test --manifest-path rust-engine\\Cargo.toml`: 43 library tests, 3
  server tests passed; one ignored doc test was reported by Cargo.
- `cargo clippy --manifest-path rust-engine\\Cargo.toml --all-targets -- -D warnings`:
  passed.
- `..\\..\\..\\node_modules\\.bin\\tsc.cmd --noEmit`: passed.
- `npm run typecheck` could not reach `tsc` because npm detects the original
  checkout and this sibling worktree as duplicate workspace package names.

## Implementation status

The high-confidence, low-risk recommendations were applied in this temporary
worktree:

- deleted the unreachable Rust optimizer/Finder/Walk-Forward modules and
  placeholder routes;
- deleted the unused Rust proxy route and its dependency;
- reduced the Rust service to generic backtest, batch, and data-cache routes;
- removed unused indicators, public compatibility helpers, the `cdylib` target,
  and the one-use market-series wrapper;
- removed the specialized Asset Opportunity Rust routes, client methods,
  coordinator, feature flags, benchmarks, and dedicated tests;
- collapsed the Rust client to status-aware generic calls and removed the dead
  TypeScript fallback-gate contract;
- made Rust startup opt-in with `START_RUST_ENGINE=1` in `run_playground.bat`;
- updated the engine architecture documentation to match the resulting
  server-first generic contract.

After adversarial review, the temporary worktree also:

- forces Asset Opportunity in-sample endpoint-selection candidates through
  TypeScript, where the capital-aware final-bar adjustment is implemented;
- serializes Rust-preferred Asset Opportunity fresh rechecks so a Rust outage
  cannot create a fallback burst;
- propagates current-chart Finder cancellation into generic Rust batch requests
  and prevents TypeScript fallback after cancellation;
- adds regression coverage for final-bar endpoint removal and Finder batch
  cancellation.

The generic Rust kernel, capability fences, fallback behavior, cache contract,
and Asset Opportunity semantics remain in place. The original checkout was not
modified.

## Findings

### 1. Delete the native Rust Finder, Walk-Forward, and optimizer WebSocket

Severity: High
Engineering cost: Low, approximately 0.5-1 day
Maintenance cost: High today; every public type, route, dependency, and test
implies a supported feature that is not supported
User impact: None for current in-repository product flows; both HTTP APIs return
`501` and the WebSocket sends only `Connected`
Recommendation: Delete `rust-engine/src/optimizer/`, the placeholder handlers,
the `/ws/optimizer` route, optimizer-only request/result types, public
re-exports, and their direct dependencies. Keep Finder and Walk-Forward in the
TypeScript application, where the real strategy registry and semantics exist.
Expected code reduction: 1,100-1,300 Rust source lines, approximately 16-18%
of the 7,074-line Rust source tree, plus the `rand` dependency and WebSocket
feature/surface
Confidence: 0.99 for repository usage; 0.80 if external crate consumers exist

Current implementation:

```rust
// rust-engine/src/api/routes.rs
Err((StatusCode::NOT_IMPLEMENTED,
    "Rust finder requires a native strategy registry and is not implemented yet.".to_string()))
```

`rust-engine/src/main.rs` still advertises `/api/walk-forward`, `/api/finder`,
and `/ws/optimizer`. `optimizer/finder.rs` and `optimizer/walk_forward.rs` are
only referenced by their module/re-export and self-tests. The WebSocket handler
does not run an optimizer or publish progress. `lib.rs` nevertheless presents
the crate as a general backtesting, Finder, and Walk-Forward library.

This is the clearest guilty-until-proven-unnecessary code in the repository.
Deleting it removes a false API contract and avoids future engineers debugging
an endpoint that was never wired to a strategy registry.

### 2. Delete the staged Asset Opportunity Rust subsystem

Severity: High
Engineering cost: Medium, approximately 2-4 days including tests and docs
Maintenance cost: High; it duplicates transport, partitioning, eligibility,
response validation, cache coordination, fallback, and fresh-entry orchestration
User impact: Low. The path is disabled by default, and TypeScript remains the
semantic/default route. Removing it disables only explicit
`FINDER_ASSET_OPPORTUNITY_RUST_BATCH=1` users. Based on the checked-in
benchmarks, expected product-value loss is under 5% for current workloads.
Recommendation: Delete the specialized Rust Asset Opportunity and fresh-entry
endpoints and their TypeScript bridge/coordinator. Keep the TypeScript Asset
Opportunity implementation and the generic Rust `/api/backtest` and
`/api/backtest/batch` paths. Do not preserve an experiment merely because it
has a rollback flag; preserve it only after a new production-shaped benchmark
shows a durable win.
Expected code reduction: approximately 3,000-4,000 production source lines
across Rust routes, the client, and Finder integration; this includes the
specialized coordinator and is intentionally the largest deletion candidate
Confidence: 0.93 for in-repository behavior; 0.75 if external callers depend
on the undocumented loopback endpoints

Current implementation includes all of the following layers:

- Rust routes for fresh-entry, Asset Opportunity, cached, and multi-asset
  variants in `rust-engine/src/main.rs` and `rust-engine/src/api/routes.rs`;
- nullable and status-returning client methods in
  `lib/rust-engine-client.ts`;
- request partitioning and complete-response validation in
  `lib/finder/server/finder-asset-opportunity-rust-batch.ts`;
- a timer-based candidate/fresh/cache coordinator in
  `lib/finder/server/finder-asset-opportunity-multi-rust-batch.ts`;
- a separate fresh-entry adapter and multiple feature/configuration gates in
  `asset-opportunity-iteration.ts` and `server-asset-is-search.ts`.

The performance evidence does not justify this surface. The checked-in plan
records approximately 5.9 seconds for TypeScript versus 13.5 seconds for
forced Rust on `128 assets x 45 strategies x 3,589 bars`. Its production-shaped
run records approximately 23.2 seconds for TypeScript and 23.5 seconds for the
Rust-preference run, with zero Rust calls because the adaptive gate selects
TypeScript. The plan itself says the path is staged and disabled by default.

The simplest architecture is one generic optional Rust kernel with one generic
batch contract. Asset Opportunity-specific result reduction and fresh-entry
semantics stay in TypeScript, where they are already authoritative.

### 3. The Rust Asset Opportunity density gate is tautological and contradicts its docs

Severity: Medium
Engineering cost: Low, approximately 0.25-0.5 day
Maintenance cost: Medium; code, tests, and benchmark documentation disagree
User impact: Opt-in users can be sent to the slower Rust path for a two- or
seven-candidate pool even though the docs say capped runs below eight candidates
stay on TypeScript
Recommendation: Delete this with Finding 2. If the experiment is retained,
replace it with one explicit condition at the caller, such as
`candidatePoolSize >= 8` for the fresh-entry phase, and remove `evalLastBars`
from the helper.
Expected code reduction: 30-80 lines, approximately 0.5-1% of the Rust
integration surface
Confidence: 1.00

Current implementation:

```ts
export function shouldUseRustAssetOpportunityBatch(
  candidateCount: number,
  evalLastBars = 0,
): boolean {
  if (!Number.isFinite(evalLastBars) || evalLastBars <= 0) return true;
  return Number.isFinite(candidateCount) && candidateCount > 0;
}
```

For every positive candidate count this returns `true`; it does not implement
the documented eight-candidate threshold. The test suite currently locks in
`true` for 2, 7, and 8 candidates. This is a small example of why the larger
experiment is not earning its complexity.

### 4. Collapse the Rust client to status-aware methods; delete nullable wrappers

Severity: Medium
Engineering cost: Low-medium, approximately 0.5-1 day
Maintenance cost: Medium-high; two result styles make failure handling and
fallback behavior harder to follow
User impact: None if the one generic Finder caller is migrated; status-aware
methods preserve more diagnostics than the nullable wrappers
Recommendation: Make the status-returning methods the only transport API. Delete
unused convenience wrappers such as `runBacktest`, `runBatchBacktest`, and
`runCachedBatchBacktest` after updating the current-chart Finder to inspect the
status result. Delete specialized methods with Finding 2. Keep one client and
one generic transport implementation; splitting it into more adapters would
add ceremony without reducing behavior.
Expected code reduction: 80-150 lines incremental after Finding 2, or about
6-10% of `lib/rust-engine-client.ts`
Confidence: 0.95 for repository call sites

The current client has a nullable wrapper followed by a status method for most
operations. For example, the generic batch wrapper at lines 752-779 only calls
the status method and converts failure to `null`; the cached wrapper repeats the
same pattern at lines 824-851. The current Finder uses those wrappers, while the
newer executor and specialized paths use the richer status API. One explicit
failure-aware API is easier to debug and avoids silently discarding why Rust was
not used.

### 5. Merge duplicate Rust result validation

Severity: Medium
Engineering cost: Low, approximately 0.5 day
Maintenance cost: Medium; reconciliation rules can drift between two copies
User impact: None; retain validation and TypeScript fallback behavior
Recommendation: Have `validateRustBacktestResult` be the single normalization
and consistency boundary. Reuse its validated result in the executor, or add
the remaining consistency checks to that validator and delete
`isResultConsistent`. Do not remove the boundary validation itself.
Expected code reduction: 20-35 lines, approximately 1-2% of Rust glue code
Confidence: 0.98

`RustEngineClient.runBacktestWithStatus` validates the response before returning
it in `lib/rust-engine-client.ts`. `lib/backtest-executor.ts` then calls
`isResultConsistent`, which invokes the validator again and repeats the trade
count, win-rate, and average-trade reconciliation. This is safety logic copied
twice, not independent protection.

### 6. Delete no-op compatibility seams

Severity: Low
Engineering cost: Low, a few hours
Maintenance cost: Medium relative to value; dead seams invite assumptions about
removed features
User impact: None
Recommendation: Delete `usesPercentageWinStreakStopLoss = false` and its branch,
the empty `SNAPSHOT_FILTER_SETTING_KEYS` export, `hasNonZeroSnapshotFilter`,
`hasHeavySnapshotFilters`, and the endpoint-settings spread that consumes the
empty list. Keep the real unsupported-setting list and capability checks.
Expected code reduction: 35-60 lines, less than 1% of the integration surface
Confidence: 1.00

The current code explicitly implements dead behavior with constants and
compatibility functions that always return false. The empty snapshot list is
imported into endpoint settings, and the false snapshot result participates in
Finder dataset classification. Removing it makes the remaining Rust fence
easier to read without changing a branch outcome.

### 7. Make the Rust crate server-first; remove unused public indicator surface

Severity: Medium
Engineering cost: Medium, approximately 1-2 days including an API decision
Maintenance cost: High if left as a second, hypothetical library product
User impact: None for this repository; external Rust consumers are the risk
Recommendation: If this repository is the only consumer, expose only the live
backtest/core API, remove the unused Bollinger, MACD, Stochastic, and Supertrend
indicator exports, remove the unused precomputed-indicator abstraction after
Finding 1, and drop the `cdylib` crate type. Keep `rlib` for the server. If an
external library contract is intentional, document and test that contract
before retaining these APIs.
Expected code reduction: 550-750 Rust lines, plus one unused build artifact and
several public exports
Confidence: 0.90 for internal usage; 0.60 for external usage

The live backtest engine imports only ADX, ATR, EMA, RSI, and SMA. The four
other indicator modules total approximately 558 lines and are referenced only
by their public exports and their own tests. `indicators/mod.rs` even says that
`PrecomputedIndicators` may not be used by the server binary. `lib.rs` presents
all of this as a public library while the application starts the binary from
the same crate. The manifest also requests `cdylib`, but repository search found
no WASM, FFI, or other `cdylib` consumer.

This is an architectural choice, not a request to add a new abstraction: choose
the product that exists, and stop carrying an unowned library platform.

### 8. Remove the unrelated proxy from the Rust engine process

Severity: Medium
Engineering cost: Low, approximately 0.5-1 day
Maintenance cost: Medium-high; it adds an HTTP client, outbound policy, redirect
security, response limits, and state coupling to a backtest service
User impact: None for repository callers; no in-repository caller of
`/api/proxy` was found. External callers remain a risk
Recommendation: Delete `/api/proxy`, `ProxyRequest`, the proxy client from
`AppState`, and `reqwest` if no external consumer exists. If the proxy is still
needed, move it to the application/data boundary rather than keeping it inside
the engine binary.
Expected code reduction: approximately 150-220 Rust lines and the direct
`reqwest` dependency, with a larger transitive build-graph reduction
Confidence: 0.96 for repository usage; 0.65 for external usage

The route is registered in `rust-engine/src/main.rs` and implemented beside the
backtest handlers in `rust-engine/src/api/routes.rs`. Repository search found
only its own implementation and documentation, not a frontend or script call.
It is a separate development proxy, not Rust engine functionality.

### 9. Do not compile and launch Rust on every playground startup

Severity: Medium
Engineering cost: Low, approximately 0.25-0.5 day
Maintenance cost: Medium; every developer pays the process/build/setup cost,
including developers using TypeScript fallback
User impact: Development startup is slower and requires Rust/Cargo even though
the application can operate without the service
Recommendation: Make Rust startup explicit: either a separate
`start-rust-engine` command or one small opt-in environment flag in
`run_playground.bat`. Keep the service itself optional and let health/fallback
work as it does now. Avoid adding a second configuration framework.
Expected code reduction: 15-30 batch-file lines and a meaningful reduction in
default startup/build work
Confidence: 0.99

`run_playground.bat` always starts
`cargo run --release --bin trading-engine-server` after killing anything on
port 3030. The README describes Rust as optional, and the TypeScript client has
an explicit health-unavailable fallback. The launcher behavior contradicts
that optionality.

### 10. Remove the one-use Rust engine wrapper

Severity: Low
Engineering cost: Low, less than 0.25 day
Maintenance cost: Low-medium; one extra internal call layer obscures the real
option defaults
User impact: None
Recommendation: Have `run_backtest` call
`run_backtest_with_market_series_options` directly with the three default false
flags, then delete `run_backtest_with_market_series`. Repository search found
only the single call from `run_backtest`.
Expected code reduction: 12-15 Rust lines
Confidence: 1.00

This is a safe surgical deletion, not a reason to redesign the simulation API.
The options function is shared by the actual HTTP routes; the middle wrapper is
only a convenience for one caller.

### 11. Remove stale performance and architecture promises

Severity: Low
Engineering cost: Low, a few hours
Maintenance cost: Medium; stale claims distort future design decisions and
benchmark interpretation
User impact: Developer velocity and trust, not runtime behavior
Recommendation: Remove the unqualified `100-500x faster`, generic native Finder/
Walk-Forward diagram, and similar aspirational language from `rust-engine/src/lib.rs`.
Keep one measured document that states the actual contract: Rust receives
TypeScript-generated signals, is optional, and currently wins only where a
benchmark proves it. Update the Asset Opportunity plan when the experimental
path is deleted.
Expected code reduction: 60-120 lines of comments and stale plan text
Confidence: 0.98

The crate-level documentation claims parallel Walk-Forward/Finder and
100-500x acceleration. The checked-in Asset Opportunity measurements instead
show TypeScript faster for the tested workloads. Documentation should describe
the supported product, not the original architecture diagram.

## Delete First (implemented)

Highest return, in order:

1. Delete the native optimizer/Finder/Walk-Forward/WebSocket subsystem and its
   placeholder routes.
2. Delete the opt-in Asset Opportunity Rust experiment, including specialized
   Rust routes, client methods, coordinator, feature flags, and dedicated tests/
   benchmarks/docs.
3. Delete the Rust proxy route and `reqwest` if the external-consumer check is
   clean.
4. Remove unused indicator modules/exports and `cdylib` after confirming there
   is no external crate contract.
5. Remove the empty snapshot compatibility path and other no-op branches.

## Simplify First (implemented where high-confidence)

1. Keep one status-aware generic Rust client API; delete nullable wrappers.
2. Make Rust result validation a single normalization/consistency boundary.
3. Remove the tautological density helper, or delete it with the experiment.
4. Make Rust startup opt-in in the playground launcher.
5. Delete the one-use `run_backtest_with_market_series` wrapper.

## Keep As-Is

These are complex for concrete reasons and should not be simplified by adding
new layers or by removing safety checks:

- the generic Rust backtest semantics and parity fixtures, including execution
  timing, exits, sizing, and cancellation-sensitive behavior;
- `MarketSeries` shared indicator caching and the compact idle-bar skip; both
  serve hot loops and have focused tests;
- Tokio blocking-pool dispatch and Rayon batch parallelism; these protect the
  async server and make the generic batch endpoint useful;
- health checks, protocol/capability negotiation, settings sanitization, and
  TypeScript fallback; the two engines do not support identical semantics;
- request/response byte limits, timeouts, cancellation, LRU dataset caching,
  malformed-result validation, and whole-batch fallback; these are operational
  safety boundaries, not needless abstraction;
- the normalized Rust settings representation; it centralizes clamping and
  Rust-specific numeric conversion instead of scattering casts through the
  simulation loop;
- the generic `/api/backtest`, `/api/backtest/batch`, and data-cache contracts.

## Estimated total reduction

The following is the observed reduction in this temporary worktree, with
duplicate work between findings counted once:

| Area | Estimate |
| --- | ---: |
| Production source lines | Approximately 6,600 fewer, about 43% of the 15,368-line Rust-specific audited source surface |
| Additional tests/benchmarks/docs tied only to deleted experiments | Approximately 5,050 fewer non-production lines |
| Named abstractions/types/functions/modules | 25-40 fewer |
| Direct Rust dependencies | 12 to 8; removes `rand`, `reqwest`, `thiserror`, and the WebSocket-only surface |
| Build complexity | Approximately 25-35% lower Rust dependency/build surface; also removes the unused `cdylib` artifact |
| Rust-specific maintenance burden | Approximately 35-50% lower, based on removed paths and contracts; this is an engineering estimate, not a measured KPI |

The result is one optional Rust kernel with a small, explicit transport boundary,
not a second strategy platform. It preserves the generic acceleration path and
the existing TypeScript product behavior while removing the code that currently
creates the most false promises, duplicate semantics, and developer work.
