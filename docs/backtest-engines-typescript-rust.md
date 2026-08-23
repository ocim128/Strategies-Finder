# TypeScript and Rust Backtest Engines

Status: current architecture reference  
Date: 2026-08-19

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

The isolated Rust simulation kernel can still be faster. The complete Finder
workload also includes TypeScript signal generation, request packing,
serialization, cache coordination, HTTP transport, response validation, and
fallback handling.

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
| `next_open` / `next_close` fresh-entry check | Signal-only path for the retained in-sample signals |
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

- non-`signal_close` execution models in the generic executor (the specialized
  Asset Opportunity batch also supports `next_open`/`next_close`);
- non-zero slippage in the generic executor (the specialized Asset Opportunity
  batch carries and applies slippage during its parity-tested simulation);
- combined/both-direction execution;
- multiple open positions;
- enabled minimum/maximum hold controls (the specialized Asset Opportunity
  batch also carries a parity-tested entry cooldown);
- adaptive percentage take profit;
- same-event Polymarket exits and Polymarket protection;
- disabled signal exits;
- active path exits.

The Rust sanitizer removes Rust-unsupported settings before serialization. The
sanitizer is a wire-safety measure, not proof that an ignored setting is
semantically supported. A new setting must be added to both the capability
fence and the sanitizer only after parity is established.

## Asset Opportunity Rust path

### Eligibility

The specialized gate in
[`lib/finder/server/finder-asset-opportunity-rust-batch.ts`](../lib/finder/server/finder-asset-opportunity-rust-batch.ts)
rechecks the Finder-specific contract. Rust Asset Opportunity simulation is
eligible only when all of the following hold:

- the feature is enabled and the server caller has Rust preference enabled;
- the strategy is not cross-symbol;
- no exit-strategy override is active;
- execution is `signal_close`, `next_open`, or `next_close`; the selected
  execution price and non-negative slippage are carried through the specialized
  Rust batch;
- direction is `long` or `short`;
- `maxOpenTrades` is one;
- minimum/maximum hold, win-streak, path-exit, strategy-timeframe, same-event,
  and Polymarket protection controls are inactive; entry cooldown is carried
  through the specialized Rust kernel;
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
- object-form signals when fields such as `triggerPrice`, `sizeFraction`, or
  `exitOnly` cannot be represented losslessly;
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
returns those fields instead of full histories.

### Bounded Asset Opportunity batching

Rust is enabled for every positive candidate count that passes the existing
capability fence, including capped evaluations with only two candidates per
asset. Candidate work is still grouped into bounded multi-asset requests. Fresh
entry batching has a separate dense-pool gate because its extra signal
generation phase and loopback request can cost more than it saves for sparse
capped searches. A failed, oversized, unsupported, or unavailable batch falls
back to TypeScript. This keeps the benchmark honest for sparse runs instead of
silently turning the Rust-preference arm into a TypeScript control.

For single-run server jobs with at least 32 assets, the Rust-preference path
uses up to four persistent Node worker threads. Each worker owns a disjoint
asset chunk, generates the same TypeScript strategy signals, and sends its
eligible scalar simulations to Rust. The TypeScript-preference path remains
single-process, so the production-shaped benchmark measures the actual route
behavior rather than comparing a Rust-only kernel against a different input.

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
- set `FINDER_ASSET_OPPORTUNITY_RUST_BATCH=0` to disable the specialized Finder
  batch seam;
- set `FINDER_ASSET_OPPORTUNITY_RUST_FRESH_BATCH=0` to disable only specialized
  fresh-entry Rust batching;
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
- `scripts/finder-asset-opportunity-benchmark.ts` for production-shaped Finder
  measurements. Use `--real-strategies` for the production-loadable strategy
  set (required for the worker-pool arm), `--workers=N` to choose the Rust
  asset-worker count, and `--warm-rust-cache` when measuring the steady-state
  simulation path; its output reports cache warmup separately.

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
