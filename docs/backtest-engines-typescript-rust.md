# TypeScript and Rust Backtest Engines

Status: current architecture reference  
Date: 2026-08-28

This document describes the two backtest engines used by Strategies-Finder,
how the application chooses between them, and how the server-side Finder Asset
Opportunity path uses Rust without changing the TypeScript strategy and ranking
contracts.

The Rust service is maintained in this repository under `rust-engine/`. The
TypeScript side owns the client, engine-selection rules, Finder orchestration,
result normalization, and fallback behavior.

## Executive summary

| Area | TypeScript engine | Rust engine |
| --- | --- | --- |
| Strategy signal generation | Authoritative for built-in strategies and Finder | Does not receive a strategy key or generate the strategy signal set |
| Trade simulation | Full compatibility surface | Supported subset of signal-driven simulation |
| Results | Full result, compact result, trades, equity curve, diagnostics | Full result or compact/scalar summaries depending on endpoint |
| Main implementation | `lib/strategies/backtest/backtest-engine.ts` | `rust-engine/src/backtest/engine.rs` |
| Application boundary | In-process function calls | HTTP over loopback, normally `127.0.0.1:3030` |
| Failure behavior | Primary implementation and fallback | Optional acceleration; unavailable or invalid Rust results fall back to TypeScript |
| Best workload | Unsupported settings, signal generation, and latency-sensitive small runs | Generic batch workloads and eligible follow-up replays with enough work to amortize transport |

Rust is not a replacement for the TypeScript engine. It is a compatible
simulation backend for a deliberately fenced subset. The benchmark separates
the complete Finder wall clock from the eligible simulation stage because
strategy signal generation remains TypeScript-owned:

- Cold end-to-end Finder runs can still favor TypeScript when the Rust service
  must upload a large dataset and the candidate pool is sparse.
- Generic engine comparisons should use identical signals, settings, and candles
  for both kernels; the complete Finder wall clock remains the product-level
  performance measure.

The complete Finder workload also includes TypeScript signal generation,
request packing, serialization, cache coordination, HTTP transport, response
validation, and fallback handling. The current end-to-end measurements show
the Rust-preferred Finder path is slower, so this repository makes no speedup
claim and removes the measured-slower specialized path.

## Architecture and data flow

### Normal backtest flow

```text
UI / endpoint / Finder caller
  -> lib/backtest-executor.ts: executeBacktest()
     -> resolve settings, closed candles
     -> generate or accept TypeScript signals
     -> merge exit-strategy signals and build diagnostics
     -> engine-selection fence
        -> TypeScript: runBacktest() or runBacktestCompact()
        -> Rust: RustEngineClient -> POST 127.0.0.1:3030/api/backtest
           -> validate result
           -> fallback to TypeScript when unavailable or inconsistent
  -> shared result post-processing and caller-specific presentation
```

The Rust request contains candles, already-generated signals, capital/sizing,
commission, and the sanitized Rust-compatible settings. It does not contain a
strategy implementation. This is why enabling Rust does not make the UI
strategy execution itself Rust-native.

The Rust service advertises protocol version 2 and explicit health
capabilities. The current binary reports `backtest.next_open.v1`,
`backtest.risk_max_hold.v1`, `backtest.risk_cooldown.v1`, and
`backtest.exit_reason.v1`. The client caches that handshake and preserves
execution-model/max-hold/cooldown fields only when the required capabilities
are present; a healthy older binary therefore remains a safe TypeScript
fallback rather than being inferred compatible from its crate version.

### Server-side Asset Opportunity flow

The server job remains responsible for selected strategies, parameter
generation, ranking, OOS validation, diagnostics, progress, cancellation, and
the authoritative result slice. Candidate simulations use the same generic
`executeBacktest()` boundary as other callers. In-sample candidates stay on
TypeScript because endpoint selection requires the TypeScript result adjustment
and the generic Rust response may omit trades; follow-up replays that retain
trades may use the generic Rust single endpoint. Unsupported settings and
transport failures use TypeScript. Asset Opportunity-specific Rust endpoints
and cross-asset transport were removed because they added substantial code
without improving the measured end-to-end workload.

## TypeScript engine

### Core modules

- [`lib/backtest-executor.ts`](../lib/backtest-executor.ts) is the orchestration
  boundary. It resolves settings and capital, chooses the data window, generates signals, invokes an engine,
  validates Rust output, and performs shared result finalization.
- [`lib/strategies/backtest/backtest-engine.ts`](../lib/strategies/backtest/backtest-engine.ts)
  contains `runBacktest()` for the standard full result and
  `runBacktestCompact()` for Finder-oriented execution.
- [`lib/strategies/backtest/indicator-precompute.ts`](../lib/strategies/backtest/indicator-precompute.ts)
  resolves and reuses indicator series where the caller has a compatible
  precomputed bundle.
- [`lib/strategies/indicators.ts`](../lib/strategies/indicators.ts) bounds the
  EMA/ATR/ADX period maps with a retained-byte budget
  (`INDICATOR_PERIOD_CACHE_BUDGET_BYTES`, 16 MiB per dataset+family, capped at
  128 periods). The effective capacity adapts to series length
  (`max(1, budget / (8 * seriesLength))`), so short datasets retain every
  sweep period (zero churn; a 33-period cycle over 20k bars stays fully
  cached at ~5 MB) while long datasets keep the hottest periods. Hits refresh
  recency and insertion evicts the least-recently used period; evicted series
  stay valid for callers that hold them, and indicator-precompute's
  per-dataset bundle bound remains the independent retained-reference limit.
  Measure the policy with `npm run bench:indicator-cache` before changing the
  budget; sweeps whose cycle exceeds the derived capacity trade warm-pass
  recomputation for bounded memory.
- [`lib/strategies/backtest/signal-preparation.ts`](../lib/strategies/backtest/signal-preparation.ts)
  prepares and indexes signals for execution.
- [`lib/strategies/backtest/position-builder.ts`](../lib/strategies/backtest/position-builder.ts)
  creates positions and applies sizing inputs.
- [`lib/strategies/backtest/exit-handlers.ts`](../lib/strategies/backtest/exit-handlers.ts)
  handles position exits and position-state updates.
- [`lib/strategies/backtest/position-stats.ts`](../lib/strategies/backtest/position-stats.ts)
  builds trade statistics and result metrics.
- `lib/strategies/sizing/*` contains the TypeScript-only rolling sizing state
  used by smart sizing modes.

### Standard execution

`runBacktest()` cleans the input data, resolves indicators, prepares signals,
scans candles, manages positions, builds trade history and an equity curve, and
calculates metrics. It supports the broad settings model, including execution
timing, slippage, multiple positions, hold/cooldown controls,
adaptive take profit, confirmation logic, and TypeScript smart sizing.

The executor also performs work around the simulation that is not part of the
Rust contract:

- closed-candle selection and block-range filtering;
- strategy execution and confirmation strategies;
- exit-strategy override signal generation;
- final market context, Sharpe, performance analytics, and trade timing
  attachment.

Finalization ownership is explicit: TypeScript engine output keeps its own
Sharpe (zero included) and populated analytics; `includeSharpeRatio: false`
is honored as zero and `includeAdvancedAnalytics: false` stays omitted
(advanced analytics also require enabled Sharpe, matching
`calculateBacktestStats`). Populated analytics are preserved, and missing
requested analytics are derived only from a usable returned equity curve.
Rust results keep their TypeScript normalization at this boundary: the Rust
scalar Sharpe is not trusted, and Sharpe is recomputed from the returned
history/trade returns when Sharpe is enabled.

Trade-timing attachment accepts an optional prepared movement-floor context
(see `lib/trade-timing-quality.ts`): callers that own a reusable immutable
window prepare the three candle-only floors once per window through the
window-owned WeakMap accessor and thread them through finalization; callers
without a known-immutable window compute floors fresh, and analyses without
trades never pay for floor preparation.

### Compact execution

`runBacktestCompact()` is optimized for Finder loops. Its options can omit the
equity curve, skip drawdown, omit trade history, include or skip Sharpe, and
produce endpoint-selection metrics. It uses a single-position Finder fast path
when the settings allow it and can use indexed signals instead of allocating
prepared signal objects.

The Finder candidate execution matrix is centralized in
[`lib/finder/finder-asset-candidate-execution.ts`](../lib/finder/finder-asset-candidate-execution.ts):

| Caller need | TypeScript execution shape |
| --- | --- |
| In-sample candidate ranking | Compact, normally no retained trades, optional endpoint selection |
| `signal_close` fresh-entry check | Full simulation with trade history so the latest trade can be inspected |
| `next_open` / `next_close` fresh-entry check | Signal-only for fixed-horizon freshness; capability-gated execution replay for `next_exit` and dense fresh batches |
| OOS validation | Full simulation with trade history |
| Winner analytics | Compact simulation with trade history, Sharpe, and drawdown |

This matrix is important for performance and parity: a Rust batch that returns
only scalar metrics cannot replace a TypeScript call that needs a latest trade
or an OOS trade history.

### TypeScript fallback simulations

The single-position Finder fast path only engages when the caller opts out of
the RETURNED equity curve (`options.omitEquityCurve === true`) and passes
every per-feature blocker (`maxOpenTrades === 1`, no trailing ATR, no adaptive
percentage take profit, and the remaining eligibility
fences). Scalar Sharpe remains supported on the fast path: when
`includeSharpeRatio` is not disabled, the fast path fills its typed equity
buffer and computes Sharpe from it, even though no object equity curve is
returned. The narrower signal-only scan (`canUseSignalOnlyFinderFastPath`)
additionally requires drawdown skipping (`skipDrawdown`) and Sharpe disabled.
Daily entry-time filters work on both fast-path scans: only opening a position
checks the actual execution bar with the shared `isEntryBarAllowed` helper.
Signal exits and exit-only override signals remain available on other bars.
The sparse scan updates the current bar for cooldowns and counts minimum-hold
bars before the current bar increment for `next_open`, matching the fallback.
Every configuration outside these fences executes ONE shared fallback
simulation, `runFallbackPositionSimulation()` in `backtest-engine.ts`, used
by both `runBacktest()` and `runBacktestCompact()`.
It is the single implementation of the trading-state transitions — pending
adaptive exits at the open, `next_open` open-only exits + signal scan,
backward position iteration with close-based exits, signal entries/exits with
re-entry and cooldown rules, end-of-bar adaptive-history flushing, and
end-of-data liquidation — with exit causality preserved by the shared
exit handler. Combined-book orchestration, input preprocessing (full runs
still call `ensureCleanData`; compact keeps its caller-provides-clean-data
contract), signal preparation, and the fast path stay with the wrappers.

The wrappers pass explicit output choices and keep metrics/analytics finishing
to themselves (`calculateBacktestStats` / `finalizeBacktestMetrics`), so the
retained wrapper differences are exactly these choices:

| Output choice | Full wrapper | Compact wrapper |
| --- | --- | --- |
| Trade objects | Always retained | Only under `options.requireTradeHistory`; when retained the array is deep-equal to the full run's |
| Equity output | Object `equityCurve` (unless `omitEquityCurve`); fast-forwarded bars are absent | `Float64Array` (options-slot `equityOut`); caller-provided buffers are filled across skipped ranges |
| Drawdown tracking | Always (the full fallback ignores `options.skipDrawdown`) | When equity is tracked; `skipDrawdown` zeroes the drawdown metrics |
| Sharpe | `calculateBacktestStats` from the object curve | `calculateSharpeRatioFromEquitySamples` from the typed array; `0` when `includeSharpeRatio === false` |
| Endpoint exclusion | Not in-engine; callers post-process with `buildSelectionResult` | In-engine via `options.endpointSelectionLastDataTime` accumulator |
| End-of-data liquidation | Shared `recordExit` at the final close; no finalize hooks (no adaptive-history queue, win-streak/sizing update) | Same shared path |

Two intentional normalizations from the pre-extraction loops, both invisible
for positive-capital runs: the drawdown-percent divide is guarded by
`peakEquity > 0` on both paths (compact previously divided unguarded), and the
forced-close no-progress guard plus the unified loop-bound phase labels
("fallback bar scan" / "fallback signal scan" / "fallback forced-close") apply
to both wrappers. Cancellation behavior is unchanged: both wrappers throw
`Backtest cancelled during TypeScript simulation.` from the shared loop.

#### Maximum drawdown semantics

Dollar and percentage drawdowns are maximized independently across every
producing path (TypeScript fast path, shared fallback, combined books, the
Rust streaming closure and `calculate_max_drawdown`, Monte Carlo chart paths,
the path-dependency analyzer, and Finder synthetic pair-neutral metrics). The
worst relative loss may therefore come from a different peak than the worst
dollar loss: the equity path 10000 -> 5000 -> 100000 -> 90000 reports
`maxDrawdown = 10000` and `maxDrawdownPercent = 50` (the 50% loss from the
10000 peak), not the 10% loss from the 100000 peak. The percentage divide
stays guarded by a nonpositive-peak check (0% while the running peak is zero
or negative). Regression results computed before this correction underreported
percentage drawdown whenever a larger dollar loss occurred from a higher peak;
persisted Finder/Batch snapshots and archives retain those historical scalars
and cannot be repaired without the original execution data, so corrected
metrics require reruns.

#### Walk Forward exit-override parity

Walk Forward analysis (`lib/strategies/walk-forward.ts`) executes every window
through the same exit-override resolution as the shared executor:
`prepareWindowBacktest` awaits `resolveExitStrategyOverrideSignals` on buffered
history ending at the window boundary, merges the tagged exit-only series via
`mergeExitStrategySignals`, and filters the merged stream to the window. The
chart interval travels through the optional `chartInterval` config field on
`WalkForwardConfig` / `FixedParamWalkForwardConfig` (and `quickWalkForward`'s
trailing parameter); an active override without it fails clearly instead of
guessing an interval for irregular data. The configured exit strategy is
preloaded and validated before candidate scoring so a load failure surfaces as
an analysis error rather than an empty override inside the optimizer's
catch/continue, and the resolved exit series is cached on the per-window
context so it is resolved once per window and released with it. The
autosuggest trade-frequency estimator uses the same preparation.

The fallback loops are the hottest TypeScript simulation path for Finder
configurations that block the fast path (overlap, trailing exits, adaptive
take profit). Baseline wall-clock/heap measurements for a
20,000-bar seeded dataset with ~4,000 signals and overlapping positions
(`npm run bench:backtest-fallback`, October 2026, idle machine, medians of
three invocations), with the shared-simulation medians from the same machine
shown against them:

| Entrypoint | Baseline median ms | Shared-loop median ms | Max post-run heapUsed Δ MB |
| --- | --- | --- | --- |
| `runBacktest` (full fallback, default analytics) | ~12.2 | ~12.0–12.3 | ~1–10 |
| `runBacktestCompact` (finder fallback) | ~6.7 | ~6.6–6.8 | ~1–3 |
| compact + endpoint exclusion | ~7.3 | ~7.3–7.4 | ~2 |
| compact + `equityOut` Float64Array | ~6.9 | ~6.6–7.1 | ~1–3 |
| compact, unlimited overlap | ~6.9 | ~7.3 | ~3 |

Run-to-run median jitter was ≤5%. The shared loop meets the recorded
acceptance threshold: every entrypoint's median stayed within ~10% of its
pre-change baseline and the deterministic trade counts (1699 capped / 1862
unlimited) are unchanged.

Memory measurement caveat: the heap column is the MAXIMUM POST-RUN delta of
`process.memoryUsage().heapUsed` (after − before each measured run), not an
allocation peak. It misses temporary allocation spikes between the two
samples, depends on GC timing, and excludes the backing storage of typed
arrays, which lives in external memory — the benchmark reports the
arrayBuffers delta next to it for that reason. These columns are diagnostic
context only and carry no acceptance threshold; establishing peak-memory
parity between two implementations requires comparing them in isolated
processes via peak RSS, which this script does not do. The recorded
acceptance threshold is timing plus the deterministic trade counts.

## Rust engine

### Service and implementation

The Rust crate in this repository is a small local HTTP server. Its binary is
configured in `rust-engine/src/main.rs` and binds to `127.0.0.1:3030`.
Release compilation uses optimization level 3, LTO, and one codegen unit
(`rust-engine/Cargo.toml`). Rayon parallelizes items in the generic batch
endpoint.

CPU-heavy backtests and cache uploads are dispatched through Tokio's blocking
pool. The service's browser CORS policy permits the two default local Vite
origins and an optional `VITE_DEV_SERVER_ORIGIN`; it does not use a wildcard
origin policy.

Admission to the CPU-heavy routes (`/api/backtest`, `/api/backtest/batch`,
`/api/backtest/batch/cached`, `/api/data/cache`) is bounded by a shared
semaphore configured by `RUST_ENGINE_MAX_IN_FLIGHT`, a positive integer read
once at startup with a conservative default of 2; invalid values fail startup
with a clear error and the effective limit is logged. Excess requests are
rejected with 503 before their JSON body is parsed. `/api/health` and
`/api/data/clear` stay outside the gate, and the CORS layer wraps it so
rejected browser requests keep their CORS headers. An accepted request keeps
its admission slot until its blocking computation settles, so a disconnected
client does not free capacity while CPU work continues; completion, validation
errors, cache misses, and panics all release the slot. The bound is a request
count, not a byte or process-memory budget, and it does not cancel work that
already started.

The main Rust modules are:

- `rust-engine/src/types.rs`: wire-compatible OHLCV, Signal, Trade,
  BacktestResult, BacktestSettings, sizing, and batch request types.
- `rust-engine/src/backtest/engine.rs`: indicator resolution, signal
  preparation, position simulation, compact result handling, and statistics.
- `rust-engine/src/api/routes.rs`: generic HTTP handlers, packed-data
  decoding, dataset cache resolution, and batch dispatch.
- `rust-engine/src/indicators/*`: indicator implementations used by the
  supported settings.

Rust receives signals generated by TypeScript. It does not contain a strategy
registry, Finder parameter generator, or optimizer API.

Rust trades include the authoritative camel-case `exitReason`. Protocol-v2
generic responses are rejected when a returned trade omits that field. Signals
with behavior-bearing `triggerPrice`, `sizeFraction`, or `exitOnly` fields
are not sent to Rust until the wire contract implements them; a diagnostic-only
`reason` remains safe to compact.

### Simulation behavior

The Rust engine normalizes settings, resolves only the indicators needed by the
settings, prepares the supplied signals, and scans each candle. It maintains
capital, one active position in the supported execution profile, optional
Kelly state, trades, drawdown, and metrics. Its compact mode clears the equity
curve and releases the trade storage entirely unless the caller requests
retained trades.

Market columns (highs/lows/closes/volumes) materialize lazily from the borrowed
candles on first indicator use, so requests that need no indicator avoid the
four `4 * N * 8`-byte column copies (~30.5 MiB per million bars). The view is
request-scoped: it lives inside one blocking call and is never stored in shared
state. Indicator series are cached per `(kind, period)` key in cells whose
computation runs outside the map lock, so unrelated cold indicators initialize
concurrently while same-key callers share one computation. `skipDrawdown` and
`skipSharpeRatio` skip their metric work instead of discarding results after
the fact.

The Rust result model includes:

- net profit and percent;
- win rate, expectancy, average trade, profit factor;
- drawdown and drawdown percent;
- trade counts and average win/loss;
- Sharpe ratio;
- optional trades and equity curve;
- an internal open-position flag used by the fresh-entry summary path.

Rust's result is not accepted blindly. The TypeScript client and Finder adapters
check transport limits, response shape, result IDs, duplicate/missing/unknown
items, finite metrics, and consistency between trade counts and win/loss
counts. A failed validation falls back to TypeScript rather than returning a
partial batch.

### Rust client boundary

[`lib/rust-engine-client.ts`](../lib/rust-engine-client.ts) provides one
transport boundary for:

- health checks and capability negotiation;
- single-run and shared-data generic batch endpoints;
- content-keyed local cache-ID reuse;
- packed OHLCV and compact ordinary-signal object transport;
- request/response byte limits, timeout, and cancellation handling;
- transport diagnostics and Rust-result validation.

The normal batch timeout is 120 seconds. The single-run timeout is 30 seconds,
and cache uploads use a longer 180-second budget. These are transport budgets,
not guarantees that Rust is faster than TypeScript.

Single runs enforce the same optional transport budgets as batch runs:
callers may pass `maxRequestBytes` (checked against the serialized request
before the POST), `maxResponseBytes` (checked against the declared
content-length and the streamed body before JSON parsing; an oversized body
is cancelled so the transport resource is released), `timeoutMs` (overriding
the 30-second single-run default), and `preparedRequest` for callers that
already serialized the request. Limits are optional — batch parity: when a
caller supplies none, nothing is enforced, and production defaults stay
deferred until supported large requests are measured. Rejected size, timeout,
and malformed-JSON outcomes return `request_too_large`, `response_too_large`,
`timeout`, or `malformed_response` and use the existing TypeScript fallback;
caller cancellation never initiates fallback.

## Engine selection rules

The selection logic is in `lib/backtest-executor.ts`,
`lib/rust-settings-sanitizer.ts`, and `lib/engine-preferences.ts`.

The decision order is:

1. If the request explicitly selects TypeScript, use TypeScript.
2. If the settings require TypeScript, use TypeScript.
3. If the sizing mode is not implemented by Rust, use TypeScript.
4. Otherwise, use Rust when the browser toggle is enabled, when the caller
   explicitly uses `engineMode: "rust_preferred"`, or when a Node/server caller
   passes `useRustEnginePreference: true`.
5. If Rust cannot run or returns an invalid result, run the same request in
   TypeScript.

In a browser, the DOM toggle is authoritative. In Node there is no DOM, so the
server must forward the browser preference explicitly. This avoids silently
using TypeScript when the UI selected Rust for a server-owned run.

The default preference is Rust when the toggle exists, but a persisted or
explicitly unchecked UI toggle still selects TypeScript. Rust preference does
not override compatibility fences.

### Generic Rust-compatible sizing

[`lib/types/backtest.ts`](../lib/types/backtest.ts) currently marks these modes
as Rust-compatible:

- `percent`;
- `fixed`;
- `kelly_criterion`.

Volatility targeting, risk parity, martingale/anti-martingale, optimal-f,
secure-f, and other smart modes retain TypeScript because their rolling state or
semantics are not represented by the Rust contract.

### Generic TypeScript fences

`getTypescriptEngineRequirementReasons()` keeps TypeScript for settings whose
semantics Rust does not represent, including:

- `next_open` without the matching health capabilities, and execution models
  not implemented by the Rust kernel;
- combined/both-direction execution;
- multiple open positions;
- enabled max hold without `backtest.risk_max_hold.v1` and
  `backtest.exit_reason.v1`, or enabled minimum hold;
- enabled entry cooldown without `backtest.risk_cooldown.v1`;
- behavior-bearing optional signal fields;
- adaptive percentage take profit;
- disabled signal exits.

The current Rust kernel has parity coverage for non-zero slippage: it applies
slippage to entries and ordinary exits with direction-correct sides, leaves the
final end-of-data close raw, and calculates trade `pnlPercent` from fee-aware
total PNL. The generic executor nevertheless keeps non-zero slippage behind
the existing TypeScript compatibility fence because the health protocol has no
versioned capability proving that the connected service implements this full
contract. Asset Opportunity follows the same generic compatibility fence.

The Rust sanitizer removes Rust-unsupported settings before serialization. The
sanitizer is a wire-safety measure, not proof that an ignored setting is
semantically supported. A new setting must be added to both the capability
fence and the sanitizer only after parity is established.

Finder batch requests carry one sanitized run-level settings object plus one
settings object per batch item. The per-item objects are a compatibility
projection, not mirrors of the candidates' full resolved settings: built at
submission packing by `projectRustBatchItemSettings`, they copy exactly the
eligible ATR-period and enabled percentage SL/TP candidate overrides onto the
run base and omit candidate max-hold and adaptive-TP differences
(those keys are either capability-gated away or TypeScript-only). Candidate
signal generation and TypeScript replay always use the candidates' full
resolved settings.

### Protocol-v2 execution semantics

For the capability-gated single-position profile, `barsInTrade` starts at zero
and the entry candle is not held. A `next_open` signal at bar `i` fills at the
open of bar `i + 1`; max hold 1 and 2 therefore close at the close of bars
`i + 2` and `i + 3`. Stop loss, take profit, and partial price exits run before
max hold, which uses the existing `time_stop` reason. On a `next_open` boundary
bar, shifted signals and open-only exits run before the close-based max-hold
check. A new position cannot take an entry-bar take-profit or max-hold exit.
Same-direction signals while the single supported position is occupied are
discarded.

Every remaining position closes at the raw final close with reason
`end_of_data` and commission but no exit slippage. The same exit reasons and
ordering are used for long and short trades. Cancellation is distinct from a
Rust transport failure: it stops the operation and never starts a TypeScript
fallback.

## Asset Opportunity integration

Asset Opportunity uses the shared execution boundary. TypeScript owns signal
generation, in-sample candidate ranking and endpoint adjustment, fresh-entry
checks, OOS policy, and result reduction. In-sample candidate simulations use
TypeScript because the endpoint-adjusted ranking contract requires retained
trades; follow-up replays may use the generic Rust single endpoint when the
capability fence allows it. The specialized Asset Opportunity batch,
fresh-entry, multi-asset endpoints, coordinators, and feature flags were
removed after production-shaped measurements showed no end-to-end benefit.

The generic batch endpoint returns one result per item ID. Callers that need
trade history or other full result fields keep the existing TypeScript/Rust
fallback and validation behavior rather than introducing a second scalar
protocol.

## Wire and cache contracts

### Single/shared-data batch request

The basic batch contract is conceptually:

```json
{
  "data": [{"time": 0, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}],
  "items": [{"id": "candidate-1", "signals": [], "settings": {}}],
  "initialCapital": 10000,
  "positionSizePercent": 100,
  "commissionPercent": 0,
  "baseSettings": {},
  "sizing": {"mode": "percent", "fixedTradeAmount": 1000}
}
```

Each item can override `settings`; otherwise `baseSettings` applies. The
legacy `packedSignals` item field remains deserializable but is unsupported:
any batch request carrying it (including empty packed rows, with or without
regular signals) is rejected with 400 before cache lookup or dispatch — the
engine never implemented packed execution, and silently running such items
produced plausible zero-trade results. An explicit JSON `null` keeps the
historical absent semantics.

The response contains `results` — an array of `{ id, result }` items, each
correlating to its request item's id — plus `processingTimeMs`.

### Cached dataset request

Large datasets can be uploaded once through `POST /api/data/cache` and then
referenced by `cacheId` in `POST /api/backtest/batch/cached`. Upload decoding
and content hashing run on the blocking pool, so large payloads do not occupy
async workers; no dataset-cache lock is held during decode/hash. Cache IDs
include the complete OHLCV content, not only a time range or bar count. The
Rust working cache is bounded by entry and retained-bar limits; eviction is
expected and causes callers to retry with raw data or fall back to TypeScript.

### Safety and failure handling

The client bounds serialized request and response sizes, applies timeouts,
propagates cancellation, and checks both the health status and engine identity
before a batch. Generic results and Finder results pass structural and metric
validation before they reach the UI; malformed output preserves an actionable
fallback reason. These failures produce a whole-batch fallback; partial Rust
output is never mixed with TypeScript output for the same dispatch.


Rollback controls are intentionally independent:

- uncheck the UI Rust engine toggle to select TypeScript;
- set the UI Rust preference to TypeScript to disable Rust attempts;
- set `FINDER_ASSET_BATCH_WORKERS=1` to reduce separate holdout worker
  concurrency when diagnosing resource pressure;
- stop the optional loopback Rust service to exercise health-unavailable
  fallback.

There is no database migration or persistent schema change associated with the
Rust engine. The service is local-only in the current configuration and is not
the public Finder HTTP boundary.

## Diagnostics and performance interpretation

When investigating a slow run, separate these timings:

1. TypeScript signal generation and strategy preparation.
2. TypeScript or Rust simulation time.
3. request JSON serialization and packed-data conversion.
4. HTTP and process scheduling latency.
5. Rust-reported processing time versus client wall time.
6. cache upload/hit/miss and fallback time.

The Rust client logs both client elapsed time and the server's
`processingTimeMs`. `processingTimeMs` measures handler time: it starts
immediately after the request JSON is extracted and stops at result assembly
after the blocking worker completes. For the batch endpoints it therefore
includes the cache lookup and the blocking-pool wait; request extraction,
middleware, response serialization, and network time are excluded from all
three simulation endpoints, so their durations are directly comparable. A
small Rust processing time with a large client elapsed time indicates
transport or queueing overhead, not a slow Rust simulation.

The server also emits one structured completion log per accepted request
(`backtest_single`, `backtest_batch`, `backtest_batch_cached`, `cache_upload`)
with the route, bar/item counts, compact/skip options, and `poolWaitMs`,
`marketPrepMs`, `simulateMs`, and `totalMs` stages. `marketPrepMs` covers only
the market-series constructor; lazy column materialization intentionally
lands under `simulateMs`.
Similarly, a Finder run can remain TypeScript-heavy even with Rust enabled
because signal generation, unsupported settings, fresh/OOS requirements, or
fallback decisions occur before or around Rust simulation.

The UI engine indicator reflects the selected preference, not proof that every
candidate used Rust. Per-run diagnostics and engine usage counters are the
authoritative evidence for actual Rust attempts, completions, skips, and
fallbacks.

## Validation and maintenance

Relevant focused checks include:

- `tests/rust-engine-client.spec.ts` for transport limits, cancellation,
  packing, caching, and result validation;
- `tests/finder-asset-opportunity-runner.spec.ts` for Finder candidate
  behavior;
- `tests/finder-server-plugin.spec.ts` for server routing, progress, and
  terminal behavior;
- `tests/settings-compat.spec.ts` for settings compatibility.

For changes to either engine boundary, validate both a Rust-available run and a
Rust-unavailable run. For settings changes, add a positive parity case and an
explicit unsupported-settings fallback case. For transport changes, validate
request limits, response limits, cancellation, timeout, cache eviction, and
missing/duplicate/unknown result IDs.

The in-repository Rust crate must be tested separately with `cargo fmt --check`,
`cargo test`, and strict `cargo clippy --all-targets -- -D warnings`, plus a
live health/API probe. TypeScript typechecking cannot prove Rust source parity
on its own.

## Known limitations

- Rust does not execute arbitrary TypeScript strategy code; signal generation
  remains TypeScript.
- Rust does not cover all execution models, risk controls, smart sizing modes,
  or exit overrides.
- Crossing a process boundary can make Rust slower for small or low-density
  workloads even when the Rust simulation loop is faster.
- Asset Opportunity signal generation, ranking, OOS policy, and result
  reduction remain TypeScript-owned even when generic candidate simulation uses
  Rust.
- Numerical parity is a contract requirement for each supported setting, not an
  assumption derived from language or benchmark speed.
- The UI preference indicates opt-in/opt-out policy; it does not mean every
  individual backtest was executed by Rust.
