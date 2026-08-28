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
| Best workload | Unsupported settings, signal generation, and latency-sensitive small runs | Eligible Asset Opportunity simulation batches, including sparse capped runs after bounded batching |

Rust is not a replacement for the TypeScript engine. It is a compatible
simulation backend for a deliberately fenced subset. The benchmark separates
the complete Finder wall clock from the eligible simulation stage because
strategy signal generation remains TypeScript-owned:

- Cold end-to-end Finder runs can still favor TypeScript when the Rust service
  must upload a large dataset and the candidate pool is sparse.
- The checked-in engine benchmark uses identical signals, settings, and candles
  for both kernels; its scalar Asset Opportunity replay is the meaningful Rust
  speed target, while the complete Finder wall clock remains a separate measure.

The complete Finder workload also includes TypeScript signal generation,
request packing, serialization, cache coordination, HTTP transport, response
validation, and fallback handling. The current end-to-end measurements show
the Rust-preferred Finder path is slower, so this repository makes no speedup
claim and keeps the specialized path staged/off by default.

## Architecture and data flow

### Normal backtest flow

```text
UI / endpoint / Finder caller
  -> lib/backtest-executor.ts: executeBacktest()
     -> resolve settings, closed candles, cross-symbol context
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
`backtest.risk_max_hold.v1`, and `backtest.exit_reason.v1`. The client caches
that handshake and preserves execution-model/max-hold fields only when the
required capabilities are present; a healthy older binary therefore remains a
safe TypeScript fallback rather than being inferred compatible from its crate
version.

### Server-side Asset Opportunity flow

```text
POST /api/finder/asset-opportunity(-batch)-run
  -> lib/finder/server/finder-vite-plugin.ts
  -> lib/finder/server/asset-opportunity-iteration.ts
  -> lib/finder/server/server-asset-is-search.ts
  -> lib/finder/finder-asset-candidate-execution.ts
  -> execute TypeScript strategy signals
  -> rank candidates and preserve Finder semantics
  -> Rust-eligible candidate/fresh-entry simulations are coalesced
     -> packed multi-asset request
     -> Rust multi-asset endpoint
     -> scalar summary validation and local endpoint normalization
  -> TypeScript fallback for the whole failed batch or unsupported item
```

The server job remains responsible for selected strategies, parameter
generation, ranking, OOS validation, diagnostics, progress, cancellation, and
the authoritative result slice. Rust only replaces selected per-candidate
simulation calls.

## TypeScript engine

### Core modules

- [`lib/backtest-executor.ts`](../lib/backtest-executor.ts) is the orchestration
  boundary. It resolves settings and capital, chooses the data window, handles
  cross-symbol and Polymarket context, generates signals, invokes an engine,
  validates Rust output, and performs shared result finalization.
- [`lib/strategies/backtest/backtest-engine.ts`](../lib/strategies/backtest/backtest-engine.ts)
  contains `runBacktest()` for the standard full result and
  `runBacktestCompact()` for Finder-oriented execution.
- [`lib/strategies/backtest/indicator-precompute.ts`](../lib/strategies/backtest/indicator-precompute.ts)
  resolves and reuses indicator series where the caller has a compatible
  precomputed bundle.
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
timing, slippage, multiple positions, hold/cooldown controls, path exits,
adaptive take profit, confirmation logic, and TypeScript smart sizing.

The executor also performs work around the simulation that is not part of the
Rust contract:

- closed-candle selection and block-range filtering;
- strategy execution and confirmation strategies;
- exit-strategy override signal generation;
- cross-symbol data resolution and alignment;
- optional Polymarket annotation;
- final market context, Sharpe, performance analytics, and trade timing
  attachment.

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

## Rust engine

### Service and implementation

The Rust crate in this repository is `rust-engine` version `0.1.0`. Its server
binary is configured in `rust-engine/src/main.rs` and
binds to `127.0.0.1:3030`. Release compilation uses optimization level 3, LTO,
and one codegen unit (`rust-engine/Cargo.toml`). Rayon parallelizes eligible
batch items and independent multi-asset workloads.

CPU-heavy generic backtests are dispatched through Tokio's blocking pool. The
service's browser CORS policy permits the two default local Vite origins and an
optional `VITE_DEV_SERVER_ORIGIN`; it does not use a wildcard origin policy.

The main Rust modules are:

- `rust-engine/src/types.rs`: wire-compatible OHLCV, Signal, Trade,
  BacktestResult, BacktestSettings, sizing, and batch request types.
- `rust-engine/src/backtest/engine.rs`: indicator resolution, signal
  preparation, position simulation, compact result handling, and statistics.
- `rust-engine/src/api/routes.rs`: HTTP handlers, packed-data decoding,
  dataset cache resolution, multi-asset workload slicing, and batch dispatch.
- `rust-engine/src/indicators/*`: Rust indicator implementations used by
  the supported settings.

Rust receives signal objects or compact packed signals. The strategy source,
strategy parameters, confirmation-strategy registry, and Finder parameter
generation stay in TypeScript.

Rust trades include the authoritative camel-case `exitReason`. Protocol-v2
generic responses are rejected when a returned trade omits that field. Signals
with behavior-bearing `triggerPrice`, `sizeFraction`, or `exitOnly` fields are
not sent to Rust until the wire contract implements them; a diagnostic-only
`reason` remains safe to compact.

### Simulation behavior

The Rust engine normalizes settings, resolves only the indicators needed by the
settings, prepares the supplied signals, and scans each candle. It maintains
capital, one active position in the supported execution profile, optional
Kelly state, trades, drawdown, and metrics. Its compact mode clears the equity
curve and can clear trades unless the caller requests retained trades.

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

[`lib/rust-engine-client.ts`](../lib/rust-engine-client.ts) provides:

- health checks with a 30-second positive cache and a short negative backoff;
- single-run and shared-data batch endpoints;
- Asset Opportunity scalar and fresh-entry endpoints;
- multi-asset candidate and fresh-entry endpoints;
- content-keyed local cache-ID reuse;
- packed OHLCV and packed ordinary-signal transport;
- request and response byte limits;
- timeout and caller-cancellation propagation;
- transport diagnostics including request size, response size, elapsed time,
  and Rust-reported processing time.

The normal batch timeout is 120 seconds. The single-run timeout is 30 seconds,
and cache uploads use a longer 180-second budget. These are transport budgets,
not guarantees that Rust is faster than TypeScript.

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
- enabled entry cooldown in the generic executor (the specialized Asset
  Opportunity batch carries the cooldown in its parity-tested profile);
- behavior-bearing optional signal fields;
- adaptive percentage take profit;
- same-event Polymarket exits and Polymarket protection;
- disabled signal exits;
- active path exits.

The current Rust kernel has parity coverage for non-zero slippage: it applies
slippage to entries and ordinary exits with direction-correct sides, leaves the
final end-of-data close raw, and calculates trade `pnlPercent` from fee-aware
total PNL. The generic executor nevertheless keeps non-zero slippage behind
the existing TypeScript compatibility fence because the health protocol has no
versioned capability proving that the connected service implements this full
contract. The specialized Asset Opportunity path may use the parity-tested
slippage fields only when its other Rust eligibility checks pass.

The Rust sanitizer removes Rust-unsupported settings before serialization. The
sanitizer is a wire-safety measure, not proof that an ignored setting is
semantically supported. A new setting must be added to both the capability
fence and the sanitizer only after parity is established.

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

## Asset Opportunity Rust path

### Eligibility

The specialized gate in
[`lib/finder/server/finder-asset-opportunity-rust-batch.ts`](../lib/finder/server/finder-asset-opportunity-rust-batch.ts)
rechecks the Finder-specific contract. Rust Asset Opportunity simulation is
eligible only when all of the following hold:

- the feature is enabled and the server caller has Rust preference enabled;
- the strategy is not cross-symbol;
- no exit-strategy override is active;
- execution is `signal_close` or capability-gated `next_open`; the selected
  execution price and non-negative slippage are carried through the
  specialized Rust batch;
- direction is `long` or `short`;
- `maxOpenTrades` is one;
- minimum hold, win-streak, path-exit, strategy-timeframe, same-event, and
  Polymarket protection controls are inactive; capability-gated max hold and
  entry cooldown are carried through the specialized Rust kernel;
- percentage take profit is fixed when percentage take profit is enabled;
- sizing is `percent`, `fixed`, or `kelly_criterion`.

Unsupported settings remain TypeScript-authoritative. This prevents the Rust
adapter from silently dropping a setting and changing the research result.

### Candidate and fresh-entry endpoints

The in-repository Rust server exposes these relevant routes:

| Route | Purpose | Returned payload |
| --- | --- | --- |
| `POST /api/backtest/asset-opportunity/batch` | One dataset, many candidate signal sets | Scalar raw and endpoint-adjusted metrics |
| `POST /api/backtest/asset-opportunity/batch/cached` | Same, using a cache ID | Scalar raw and endpoint-adjusted metrics |
| `POST /api/backtest/asset-opportunity/multi-batch` | Many independent datasets and candidate groups | Scalar results plus cache IDs for uploaded workloads |
| `POST /api/backtest/fresh-entry/batch` | Fresh-entry checks for one dataset | Trade count, latest trade summary, open state |
| `POST /api/backtest/fresh-entry/multi-batch` | Fresh-entry checks for many datasets | The same compact fresh-entry summaries |

The generic `/api/backtest/batch` endpoint remains available when callers need
full result objects. Asset Opportunity uses the specialized endpoints because
ranking does not need to transmit full `trades` and `equityCurve` arrays.

### Multi-asset transport

[`lib/finder/server/finder-asset-opportunity-multi-rust-batch.ts`](../lib/finder/server/finder-asset-opportunity-multi-rust-batch.ts)
coalesces independent asset dispatches while preserving one logical result per
asset. It uses:

- up to 1,024 workload entries per multi-asset request;
- up to 32 datasets per cache-bootstrap request;
- a 12 ms batching window;
- packed row-major OHLCV values in the order
  `[time, open, high, low, close, volume]`;
- packed ordinary signals in the order
  `[time, direction, price, barIndex]`, where direction `0` is buy, `1` is
  sell, and `-1` means no bar index;
- diagnostic-only object-form signals may retain `reason`; behavior-bearing
  `triggerPrice`, `sizeFraction`, and `exitOnly` fields are rejected before
  dispatch until their wire semantics are implemented;
- `dataStartIndex` and `dataEndIndex` to evaluate a contiguous window from a
  cached full dataset without sending a second sliced dataset;
- shared content-keyed cache promises so an asset/window is uploaded once and
  reused across strategy batches and holdout iterations.

The Rust server keeps each dataset as a workload boundary, builds a separate
market series for it, validates the data window bounds, and parallelizes the
workloads with Rayon. It does not combine candles from different assets.

### Endpoint selection and summaries

Rust does not implement the Finder endpoint-selection contract directly. For
Asset Opportunity, the Rust scalar route returns both the raw result summary
and the endpoint-adjusted summary needed by the ranker. The adapter normalizes
those summaries into the existing TypeScript result shape. Endpoint selection
must therefore be treated as part of the response contract, not inferred from
the raw result after the fact.

Fresh-entry detection needs only total trades, the latest trade's entry fields,
exit reason, and whether a position remains open. The fresh-entry endpoint
returns those fields instead of full histories. Sparse `next_exit` runs do not
use the specialized fresh-entry batch: they regenerate and replay each
candidate through the generic capability-aware executor, which preserves the
actual Rust trade history needed for exit-reason matching and OOS censoring.

The server-side Finder keeps `next_exit` trade history internal for its
TypeScript metrics and uses the same capability-aware generic execution path
for fresh/OOS replays. The bounded replay window remains unchanged, as do
`end_of_data` censoring and OOS verdict rules. No trade arrays cross the scalar
Finder stream or terminal snapshot boundary.

### Bounded Asset Opportunity batching

The specialized Rust path is enabled only when
`FINDER_ASSET_OPPORTUNITY_RUST_BATCH=1`; unset or any other value leaves it
off. TypeScript remains the default semantic and rollout path. When explicitly
enabled, Rust is used for every positive candidate count that passes the existing
capability fence, including capped evaluations with only three candidates per
asset. Fresh-entry batching has a separate dense-pool gate because its extra
signal-generation phase and loopback request can cost more than it saves for
sparse capped searches. For the current sparse `candidatePoolSize: 3`, the
in-sample scalar batch, fresh execution-aware replay, winner replay, and OOS
`next_exit` pass all remain Rust-preferred when the protocol capabilities are
present. A missing capability, unsupported signal shape, failed, oversized, or
unavailable batch falls back to TypeScript for the whole dispatch. Capability
skips do not inflate Rust-attempt counters, while actual failed requests retain
the existing fallback diagnostics.

The production Asset Opportunity iteration performs a full run-level static
preflight across every selected strategy, active setting, capital profile,
exit-override/follow-up path, and advertised Rust capability. Only a fully
eligible run enables bounded four-asset and four-strategy waves. TypeScript
simulation fallback is protected by a shared concurrency-one gate, so a
runtime behavior-bearing signal, malformed response, cache failure, timeout,
or transport failure cannot create a Rust-sized TypeScript burst. Signal
generation, ranker insertion, and final asset-row emission remain ordered and
deterministic. TypeScript preference or any incomplete preflight keeps the
original single-evaluation path. Fresh `next_exit` replay remains serial
within each asset, while signal-only preparation and the specialized dense
fresh batch retain their existing bounded paths.

For single-run server jobs with at least 32 assets, the Rust-preference path
may use up to four persistent Node worker threads when the outer capability
preflight permits Rust execution. Each worker owns a disjoint asset chunk,
generates the same TypeScript strategy signals, and sends its eligible scalar
simulations to Rust. If capability information is not available before worker
selection, the server uses the conservative single-worker path; inside an
Asset Opportunity iteration, up to four assets and four strategies per asset
are evaluated concurrently when the shared preflight succeeds. The shared
TypeScript fallback gate still serializes fallback simulations, and public
results are emitted in input order. The TypeScript-preference path remains
single-process, so the production-shaped benchmark measures the actual route
behavior rather than comparing a Rust-only kernel against a different input.

### Corrected Finder benchmark protocol

Build and launch the optimized Rust service before measuring performance. Run
the build from the `rust-engine` directory and keep the service terminal open:

```powershell
cargo build --release --bin trading-engine-server
$env:RUST_ENGINE_PORT = "3031"
.\target\release\trading-engine-server.exe
```

The benchmark requires the health response to advertise
`buildProfile="release"`. Debug binaries are valid for semantic parity tests,
but are invalid for performance conclusions and are rejected before a
benchmark measurement starts.

Run the checked-in harness from the repository directory with one identical
worker for both engines:

```powershell
$env:RUST_ENGINE_URL = "http://127.0.0.1:3031"
..\..\..\node_modules\.bin\esno.cmd scripts/finder-asset-opportunity-benchmark.ts `
  --arm=real-built-ins --cache=both --oos=both `
  --bars=3600 --assets=64 `
  --routing=all-ts,all-path-rust `
  --workers=1 --repetitions=3 --iterations=1
```

Use `--arm=coverage-synthetic` for the small deterministic coverage fixture,
or `--arm=real-built-ins` for the 45 production-loadable strategy
implementations. The generated candles are a deterministic workload fixture,
not historical market data. `--cache=cold` clears the Rust client and service
dataset caches immediately before each measured run and includes no warmup;
`--cache=warm` explicitly uploads the service cache first, reports warmup
separately, and excludes it from `wallMs`. The TypeScript process and module
cache are reused between repetitions. Warm-cache measurements are capped at
the service's 512-entry cache limit.

The harness alternates routing order between repetitions, reports each raw
measurement plus median/min/max/p95 summaries, and compares ordering, scalar
result fields, and phase diagnostics for each identical repetition. Iteration
determinism is checked only when `--iterations` is at least 2; with the default
one iteration it is reported as `not checked`, while a mismatch is reported as
`fail` and makes the process exit nonzero. Route-specific Rust/TypeScript
execution requirements, phase coverage, fallback absence, and monotonic
progress are also enforced. The `rust-per-asset` route is a transport
comparison, not a production recommendation. No speedup claim is valid unless
repeated parity-safe measurements improve the complete Finder wall clock; the
default rollout remains staged/off because current measurements do not.

The current default `--candidate-pool-size=3` is intentionally below the
density gate for grouped fresh-entry batching. Reports must show grouped fresh
entry as `not_applicable` in that case; this is not a zero-cost or a measured
grouped-fresh result. Increase the pool explicitly when measuring that route.
`--workers=1` describes the benchmark's identical single-worker comparison;
it does not claim that the production server is sequential. Production worker
count is governed by `FINDER_ASSET_BATCH_WORKERS` and its memory/CPU policy.

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
response contains `results` keyed by item ID and `processingTimeMs`.

### Multi-asset request

Each workload has its own identity and dataset:

```json
{
  "workloads": [{
    "id": "asset-1",
    "cacheId": "...",
    "dataStartIndex": 7500,
    "dataEndIndex": 8000,
    "items": [{"id": "asset-1:candidate-1", "signals": []}],
    "lastDataTime": 123
  }],
  "initialCapital": 10000,
  "positionSizePercent": 100,
  "commissionPercent": 0,
  "baseSettings": {},
  "sizing": {"mode": "percent", "fixedTradeAmount": 1000}
}
```

The client may replace `data` with packed data or `cacheId`. A cache ID is
content-derived and includes the full OHLCV content on the Rust server; it is
not merely a time-range/count key. The Rust working cache is bounded by entry
and retained-bar limits. Cache eviction is expected and causes a retry through
the raw-data route before TypeScript fallback.

### Safety and failure handling

The client bounds serialized request and response sizes, applies timeouts,
propagates cancellation, and checks both the health status and engine identity
before a batch. Generic results and Finder results pass structural and metric
validation before they reach the UI; malformed output preserves an actionable
fallback reason. These failures produce a whole-batch fallback; partial Rust
output is never mixed with TypeScript output for the same dispatch.

The optional `/api/proxy` route uses a shared 15-second HTTPS client, exact-host
allowlisting, redirect revalidation, and an 8 MiB response cap. It is a local
development convenience, not a general outbound fetch service.

Rollback controls are intentionally independent:

- uncheck the UI Rust engine toggle to select TypeScript;
- unset `FINDER_ASSET_OPPORTUNITY_RUST_BATCH` or set it to any value other than
  `1` to disable the specialized Finder batch seam;
- set `FINDER_ASSET_OPPORTUNITY_RUST_FRESH_BATCH=0` to disable only specialized
  fresh-entry Rust batching;
- set `FINDER_ASSET_OPPORTUNITY_RUST_MULTI_BATCH=0` to disable the grouped
  multi-asset/strategy coordinator and return to serialized dispatch;
- set `FINDER_ASSET_BATCH_WORKERS=1` to reduce the separate holdout worker
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
`processingTimeMs`. A small Rust processing time with a large client elapsed
time indicates transport or queueing overhead, not a slow Rust simulation.
Similarly, a Finder run can remain TypeScript-heavy even with Rust enabled
because signal generation, unsupported settings, fresh/OOS requirements, or
fallback decisions occur before or around Rust simulation.

The UI engine indicator reflects the selected preference, not proof that every
candidate used Rust. Per-run diagnostics and engine usage counters are the
authoritative evidence for actual Rust attempts, completions, skips, and
fallbacks.

## Validation and maintenance

Relevant focused checks include:

- `tests/finder-asset-opportunity-rust-batch.spec.ts` for eligibility,
  transport, validation, fallback, packing, and summary normalization;
- `tests/finder-asset-opportunity-runner.spec.ts` for Finder candidate behavior;
- `tests/finder-server-plugin.spec.ts` for server routing, progress, and
  terminal behavior;
- `tests/finder-universe-runner.spec.ts` for neighboring Finder regression
  behavior;
- `tests/settings-compat.spec.ts` for settings compatibility;
- `scripts/engine-benchmark.ts` for isolated TypeScript/Rust engine comparison;
- `scripts/finder-asset-opportunity-benchmark.ts` for corrected, production-
  shaped Finder measurements. Use `--arm=coverage-synthetic` or
  `--arm=real-built-ins`, `--cache=cold|warm|both`, `--oos=next_exit|complementary|both`,
  and the explicit `--routing` variants shown above. Keep `--workers=1` for
  comparable TS/Rust measurements. Set
  `RUST_ENGINE_URL=http://127.0.0.1:<port>` when the default loopback port is
  occupied; the Rust binary accepts the matching `RUST_ENGINE_PORT` override.
  Warm-cache mode is intentionally capped at the service's 512-entry dataset
  cache limit so it cannot benchmark stale cache IDs after eviction.

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
  cross-symbol strategies, or exit overrides.
- Crossing a process boundary can make Rust slower for small or low-density
  workloads even when the Rust simulation loop is faster.
- The specialized Asset Opportunity Rust path is server-side. Browser Finder,
  Finder Universe orchestration, OOS policy, and ranking remain TypeScript
  owned.
- Numerical parity is a contract requirement for each supported setting, not an
  assumption derived from language or benchmark speed.
- The UI preference indicates opt-in/opt-out policy; it does not mean every
  individual backtest was executed by Rust.
