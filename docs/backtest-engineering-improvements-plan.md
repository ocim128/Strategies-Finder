# Backtest engineering improvements plan

Status: Accepted scope; planning only; implementation has not started.
Date: 2026-10-06.

Scope: deliver the seven backtest improvements accepted after the code review.
This temporary document is in `docs/` at the user's explicit request,
overriding the documentation index's normal exclusion of implementation plans.
After delivery, fold current behavior into the owning guides and remove it.

## Architecture and boundaries

The existing flow is `BacktestService` or endpoint/Finder caller ->
`executeBacktest()` -> TypeScript simulation or capability-gated Rust HTTP
simulation -> result finalization. `executeBacktestFromSignals()` is the
equivalent boundary for prepared-signal callers. Finder also calls the kernels
directly and enriches original and endpoint-adjusted results.

Keep these boundaries, execution models, sizing, fills, commission, drawdown,
confirmation, exit tagging, endpoint selection, and cancellation behavior.
Preserve compact execution without allocating trades/equity just to produce
optional diagnostics. No database, persisted-settings, strategy-manifest,
Rust wire-protocol, infrastructure, dependency, or deployment change is planned.
Keep server-plugin imports out of browser modules. Extend existing functions
and local cache helpers; no general cache or optimization framework is needed.

Read [the agent guide](../AGENTS.md), [engine contracts](backtest-engines-typescript-rust.md),
[Finder](finder.md), [server Finder](finder-server-side.md), and
[testing](testing.md) before the affected implementation phase. Recheck the
worktree and callers before each patch; preserve concurrent work.

## Evidence, assumptions, and sequencing

The review passed eight focused specs: engine, compact parity, executor
timings/cancellation, Rust client, trade timing, advanced performance, and
server exit-parameter cache. Existing passing tests do not cover the newly
reproduced defects. Live Rust behavior and production performance were not
verified.

Ad hoc Node 22 probes used 50,000 synthetic candles/1,000 trades or 50,000
return samples. Three percentile sorts took 21.95 ms versus 7.75 ms for one;
duplicate analytics took 28.5 ms; candle-only movement floors took 30.5 ms
within 35.9 ms total timing-quality calculation. These are local hotspot
measurements, not release thresholds; savings overlap. Reproduce baselines
with fixed inputs before implementation and measure daily and intraday data.

The review also reproduced stale exit-cache signals, ignored single-Rust byte
limits, disabled analytics being restored by finalization, and underlying ATR
retention after bundle eviction.

| Phase | Deliverable | Dependency |
| --- | --- | --- |
| 1 | One percentile sort per advanced analysis | Independent |
| 2 | Explicit analytics ownership and output-option compliance | Phase 1 for final performance comparison |
| 3 | Exit-cache dataset content identity | Independent |
| 4 | Reusable candle-only trade-timing preparation | Establish immutable-window ownership; phase 3 informs identity rules |
| 5 | Sampled executor timings and fallback reasons | Phase 2 finalization boundary |
| 6 | Single-Rust byte limits and timeout overrides | Independent; phase 5 observes failures |
| 7 | Bounded ATR/EMA/ADX period caches | Independent; measure together with other performance changes |

Unknowns to resolve within implementation: which prepared windows are guaranteed
immutable for their cache lifetime, representative large-request sizes, and the
indicator capacity that avoids material sweep-throughput regressions. Do not
assume that array identity, length, or endpoint timestamps imply immutability.

## Phase 1 - Sort performance returns once

**Objective:** Remove duplicate sorts without changing percentile results.

**Tasks:** In [performance-metrics.ts](../lib/strategies/performance-metrics.ts),
sort a copy of `prepared.returns` once inside
`calculateAdvancedPerformanceAnalyticsFromEquityCurve()`. Use the existing
`percentileSorted()` from [statistics-utils.ts](../lib/statistics-utils.ts) for
the upper/lower percentiles. Pass those values to the private tail-ratio
calculation and reuse the lower value for VaR and CVaR selection. Preserve
confidence-level handling, interpolation, empty input, and denominator guards.
Leave unrelated moments and annualization calculations alone.

**Deliverables / validation:** Extend
[advanced-performance-metrics.spec.ts](../tests/advanced-performance-metrics.spec.ts)
with repeated values, zero tails, and non-default confidence levels; retain the
existing daily/intraday fixtures. Run it and
[statistics-utils.spec.ts](../tests/statistics-utils.spec.ts). Compare the isolated
three-sort/one-sort benchmark using identical returns.

**Risk / exit:** Low. One returns-array sort replaces three; numerical output
and input-array ordering remain unchanged.

## Phase 2 - Calculate requested analytics once

**Objective:** Preserve authoritative metrics and honor disabled calculations.

**Tasks:** Give `finalizeResult()` in
[backtest-executor.ts](../lib/backtest-executor.ts) explicit engine/output context
through a small private argument. Apply it at all finalization sites, including
`executeBacktestFromSignals()`. Preserve TypeScript-calculated Sharpe; zero is
a valid result. Preserve populated advanced analytics and calculate missing,
requested analytics only when a usable equity curve exists. Keep TypeScript
normalization of Rust Sharpe/analytics at the executor boundary.

Honor `includeSharpeRatio: false` as zero and
`includeAdvancedAnalytics: false` as omitted. Preserve the current
`calculateBacktestStats()` rule that advanced analytics also require enabled
Sharpe. Keep market context, trade timing, edge-analysis registration, and
`skipResultPostProcessing` independent of this ownership decision.

**Risk:** Low with explicit execution-path tests. The
[engine](../lib/strategies/backtest/backtest-engine.ts)'s single-position fast
path and compact wrapper can omit advanced analytics; blindly trusting every
TypeScript result would lose requested output. Preserve compact equity-derived
Sharpe even when the returned equity curve is omitted. Do not materialize
missing history or change endpoint-adjusted selection metrics.

**Deliverables / validation:** Extend
[backtest-executor-timings.spec.ts](../tests/backtest-executor-timings.spec.ts)
for enabled/disabled options with post-processing enabled; cover full,
compact, fast/fallback, empty, entry-only, and prepared-signal execution.
Run engine/compact parity and
[backtest-endpoint-parity.spec.ts](../tests/backtest-endpoint-parity.spec.ts);
compare supported mocked/live Rust results and unavailable-Rust fallback.
Cover long/short and affected execution models. Measure kernel and executor
separately so removed finalization work is visible.

**Exit:** Requested analytics remain present, disabled analytics remain
disabled, and already-computed metrics are not recalculated. Default full
results retain parity; compact Sharpe follows its authoritative kernel.

## Phase 3 - Make exit-cache identity describe the data

**Objective:** Revised candles cannot reuse another window's exit signals.

**Tasks:** Replace the count/first/last key in `buildExitSignalDataCacheKey()`
in [backtest-executor.ts](../lib/backtest-executor.ts) with a full-window content
digest covering ordered time/open/high/low/close/volume values. Use existing
time-key helpers and lossless numeric serialization. Keep the helper local to
execution; preserve the existing nested `BacktestExitSignalCache` and exit
parameter key, plus confirmation/block/timeframe/context reuse fences.

Compute identity once at immutable-window preparation and thread an optional
internal identity through `resolveExitStrategyOverrideSignals()` and the
existing candidate request path in
[finder-asset-candidate-execution.ts](../lib/finder/finder-asset-candidate-execution.ts),
[server-asset-is-search.ts](../lib/finder/server/server-asset-is-search.ts), and
their window-owning Asset Opportunity callers. Generic mutable callers must
rehash or bypass reuse; reference-only memoization is unsafe. Content-identical
slices must still share signals. Keep the identity out of persisted/wire data.

**Risks / blockers:** Establish source-window ownership before memoizing.
`RustEngineClient.getDataCacheKey()` hashes every bar but quantizes numeric
values; `computeBacktestEndpointDatasetFingerprint()` samples bars. Neither
should be copied unchanged as an exact exit-cache identity. Leave those
unrelated cache contracts alone. Avoid an O(bars) digest for every candidate.

**Deliverables / validation:** Extend
[server-asset-is-search-exit-param-cache.spec.ts](../tests/server-asset-is-search-exit-param-cache.spec.ts)
to compare cached and uncached exits/trades after an interior OHLCV change,
including changes below 1e-6 and supported time shapes. Preserve the identical
slice reuse fixture and test distinct datasets sharing timestamps. Run
[finder-asset-opportunity-runner.spec.ts](../tests/finder-asset-opportunity-runner.spec.ts)
and measure digest count/candidate throughput on a fixed window.

**Exit:** Changed data produces authoritative fresh signals; identical slices
retain reuse; each immutable prepared window is fingerprinted once per owner.

## Phase 4 - Prepare trade-timing movement floors once

**Objective:** Reuse candle-only work while recalculating trade-dependent scores.

**Tasks:** In [trade-timing-quality.ts](../lib/trade-timing-quality.ts), prepare
the three existing movement floors once. Add an optional internal prepared
context to `computeTradeTimingQuality()`/`attachTradeTimingQuality()`; retain a
fresh-calculation default for callers without a known immutable window.
Use a window-owned WeakMap for immutable data, or revision invalidation for
mutable data, after auditing the callers. Release cache ownership with the
window; do not retain datasets in a global strong map.

Reuse preparation for original and endpoint-adjusted results in
`enrichFinderCandidate()` and the candidate-data owners in
[finder-runner-single.ts](../lib/finder/finder-runner-single.ts). Pass prepared
context through executor finalization only where the caller already owns a
reusable immutable window. Keep entry/exit horizons, capture scores, weights,
and trade-dependent calculations unchanged; compute lazily when trades exist.

**Deliverables / validation:** Extend
[trade-timing-quality.spec.ts](../tests/trade-timing-quality.spec.ts) with fresh
versus reused preparation, changed datasets/revisions, empty/entry-only
results, and endpoint-adjusted trades. Run Finder engine coverage for timing
sorts. Measure cold preparation and repeated analyses separately.

**Risk / exit:** Low once ownership is explicit. Both result variants retain
the same scores; repeated analyses of one immutable window compute its floors
once. Array mutations cannot return stale floors.

## Phase 5 - Surface sampled execution phases

**Objective:** Attribute slow runs and explain actual engine selection.

**Tasks:** In [backtest-service.ts](../lib/backtest-service.ts), pass
`collectExecutorTimings: captureTiming` from `runBacktestForData()`. Add existing
executor timings and `engineDiagnostics` to `backtest.timing_breakdown` using
the existing `debugLogger.event()`; preserve DEV/every-32nd-run sampling and
the current kernel diagnostic collection. Add `postProcessingMs` to
`BacktestExecutorTimings`, initialized to zero, and time every applicable
finalization call only when collection is enabled. Preserve exit subphase
accounting and keep engine time separate from finalization.

**Deliverables / validation:** Extend executor timing tests for post-processing
enabled/skipped, early returns, successful Rust, and Rust-to-TS fallback.
Extend [backtest-service-lifecycle.browser.spec.ts](../tests/backtest-service-lifecycle.browser.spec.ts)
to verify the sampled event includes timings/reasons without changing
publication ownership. Assert finite/nonnegative durations and unchanged
results rather than exact milliseconds or full wall-clock equality.

**Risk / exit:** Low. The new field is an internal diagnostic addition; log
only scalar metadata, never candle/signal arrays or credentials. Selected
samples distinguish signal/exit/engine/finalization work and expose fallback
reasons without an additional telemetry service or UI.

## Phase 6 - Honor single-Rust transport budgets

**Objective:** Single runs enforce the options already supported by batch runs.

**Tasks:** In [rust-engine-client.ts](../lib/rust-engine-client.ts), reuse
`prepareRustRequest()` and `readResponseTextWithinLimit()` inside
`runBacktestWithStatus()`. Check serialized request bytes before POST; enforce
declared and streamed response bytes before JSON parsing; honor `timeoutMs`
with the current 30-second single-run default. Preserve capability checks,
protocol-v2 exit-reason validation, output options, and abort propagation.
Add request/response size failures to `RustBacktestFailureReason`; malformed
JSON returns `malformed_response`, and cancellation never initiates fallback.

**Contract / risk:** Low. Follow batch optional-limit semantics when limits
are absent; choose production defaults only after measuring supported large
requests and update the executor's `tryRustBacktest()` options accordingly.
Do not import the Vite endpoint plugin's body-limit constant into browser
code or treat an inbound endpoint limit as a Rust response budget. Rejected
size/timeout/parse attempts use the existing TS fallback. Serialization still
allocates the request string, so this change does not bound all request-side
memory. Cancel unread oversized response bodies, including early header
rejection, to release the transport resource.

**Deliverables / validation:** Extend
[rust-engine-client.spec.ts](../tests/rust-engine-client.spec.ts) for exact and
exceeded byte limits, multibyte text, missing/misleading content length,
chunked bodies, reader disposal, timeout overrides, and malformed JSON. Extend
[backtest-executor-cancellation.spec.ts](../tests/backtest-executor-cancellation.spec.ts)
for fallback on size failures and no fallback on cancellation. Probe one
Rust-available and one Rust-unavailable execution.

**Exit:** Supplied budgets are enforced with actionable reasons; normal
single-run requests retain wire/result compatibility and fallback behavior.

## Phase 7 - Bound retained indicator periods

**Objective:** Limit period-cache growth while a dataset remains reachable.

**Tasks:** Add an optional capacity to the existing `getOrCompute()` and
`getOrComputeOHLC()` helpers in [indicators.ts](../lib/strategies/indicators.ts).
Apply it only to `calculateEMA()`, `calculateATR()`, and `calculateADX()`.
Refresh recency on a hit and evict oldest period entries on insertion using
Map delete/set, matching existing cache patterns. Keep numerical kernels and
other indicator families unchanged. Make the capacity a named internal
policy, adjustable for measurement without a saved setting or UI control.

Account for retained references in
[indicator-precompute.ts](../lib/strategies/backtest/indicator-precompute.ts):
its 24 bundles can keep evicted series alive. Preserve that independent bound
and measure the union of references, including indicator consumers such as
Keltner/Supertrend; do not claim the lower cache limit bounds total heap.
Start capacity experiments at 32 periods, then select the shipped value from
representative sweeps. Caller-held series remain valid after eviction.

**Deliverables / validation:** Add a focused proposed
`tests/backtest-indicator-cache.spec.ts` for retained hits, recency, eviction,
and value-equivalent recomputation on fresh immutable data. Run engine/compact
parity and [new-strategy-lib-smoke.spec.ts](../tests/new-strategy-lib-smoke.spec.ts)
because these indicator functions are shared. Measure sweeps beyond capacity,
repeated hot periods, and separate-process retained heap/peak RSS where
available. Use [bench-backtest-fallback.ts](../scripts/bench-backtest-fallback.ts)
for kernel regression checks; its post-run deltas are not allocation peaks.

**Risk / exit:** Low for numerical behavior; insufficient capacity can increase
CPU through churn. Period maps remain within their selected bound, evicted
calculations reproduce values, and representative throughput has no material
regression. The review's roughly 18 MiB-per-family saving is illustrative
array-slot arithmetic, not a measured total-heap guarantee.

## Integration, documentation, and rollback

After each implementation phase, preview `npm run validate:changes`, inspect
focused selection with `npm run test -- <filters> --list --json`, and run the
phase's semantic tests. Run application/test typechecks for code/spec changes.
At integration, run the selected validation plan and full CI (`npm run ci`)
required for shared backtest/indicator changes. Preserve repository Rust
format/test/strict-clippy and live-probe policy for engine-boundary work; JS
tests alone do not prove Rust compatibility. Use E2E when UI lifecycle impact
warrants it. Run test commands sequentially so their latest logs do not race.

Compare fixed inputs before/after for trades, fees, scalar metrics, timing
scores, endpoint adjustments, cancellation, and fallback. Record measurements
per phase and together; numerical correctness is the release gate, and
performance claims require representative evidence. Update the engine guide
and affected Finder guide with delivered behavior and budget/cache policy.

Keep phases as separate reviewable patches. Roll back individual performance
or logging changes by reverting their patch; cache entries are transient and
can be discarded on restart. For cache-identity regressions, bypass reuse
rather than restoring a known stale key. For Rust transport regressions, use
the existing TypeScript engine selection while fixing the client. No schema
migration or external infrastructure rollback is required.
