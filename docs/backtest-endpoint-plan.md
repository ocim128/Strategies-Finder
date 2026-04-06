# Backtest Endpoint Plan

## Goal

Build a local HTTP backtest path that lets external tools such as `Flux.Native` run fast strategy loops while producing the same backtest result as the UI for the same:

- candles
- strategy key
- strategy params
- backtest settings
- capital settings
- block range
- execution-time context

The first version should work for:

- Polymarket-oriented `1m` and `5m` research
- direct-trade research on higher timeframes such as `4h`
- single-run evaluation
- high-volume external orchestration

## Why This Exists

The current Finder loop is accurate, but it is still a browser-driven search flow. That makes large multi-strategy exploration slower than an external bulk runner that can fire many local requests quickly.

`Flux.Native` is already good at:

- sending local requests quickly
- managing variables and bulk jobs
- orchestrating large batches

So the missing piece is not another optimizer UI. The missing piece is a parity-safe local endpoint that turns this repo into a reusable backtest engine.

## Current Repo Facts

These existing seams matter:

- UI startup is orchestrated from `index.ts` and `lib/app-bootstrap.ts`.
- Manual backtests are orchestrated by `lib/backtest-service.ts`.
- Canonical backtest setting resolution lives in `lib/backtest-settings-resolver.ts`.
- Canonical capital setting resolution lives in `lib/backtest-capital-settings.ts`.
- Core engine execution lives in `lib/strategies/backtest/*`.
- Built-in strategy source of truth is `lib/strategies/lib/*`, with `lib/strategies/manifest.ts` and `lib/strategies/library.ts`.
- The repo already exposes local HTTP middleware through `vite.config.ts` for `/api/sqlite/*`.
- The repo already has an external engine client pattern in `lib/rust-engine-client.ts`.

Important constraint:

`lib/backtest-service.ts` is not a pure endpoint-ready module yet. It still reads from DOM and shared state for:

- settings input
- capital input
- symbol and interval
- block slicing
- two-hour parity
- current time used by closed-candle trimming
- optional Polymarket annotation context

That means endpoint work must start by extracting a shared pure execution layer. If we skip that, UI and endpoint results will drift.

## Success Criteria

The endpoint is successful when all of the following are true:

1. UI backtest and endpoint backtest return the same result for the same explicit inputs.
2. External callers can run many tests without resending the full candle array every time.
3. Strategy changes stay consistent because both UI and endpoint use the same strategy registry and shared execution code.
4. The endpoint can be used for both exact single runs and bulk randomized search.
5. The first production workflow does not require a second standalone server unless Vite middleware becomes a bottleneck.

## Non-Goals For The First Cut

- Replacing the current UI Finder immediately
- Adding a remote public API
- Supporting custom strategy code upload over HTTP
- Making Rust mandatory
- Reproducing every research feature before single-run parity is proven

## Architecture Direction

Use one shared execution core and multiple callers:

- UI manual backtest
- UI Finder internals later if desired
- local HTTP endpoint
- scripts and future CLI jobs

Recommended flow:

1. Extract a pure request-to-result executor from `lib/backtest-service.ts`.
2. Make UI backtests call that executor.
3. Expose the same executor through a local HTTP route.
4. Add dataset caching and batch execution for external speed loops.
5. Add randomized search on top of the same executor, not beside it.

## Parity Contract

"Same result as UI" only means something if the request explicitly carries the same execution context.

The endpoint request contract must include or derive:

- `symbol`
- `interval`
- candle payload or cached dataset reference
- `strategyKey`
- `strategyParams`
- raw or resolved `backtestSettings`
- raw or resolved `capitalSettings`
- `blockRange` if chart-block slicing should apply
- `nowSec` so closed-candle trimming is deterministic
- `twoHourCloseParity` when `120m` parity behavior matters
- whether Polymarket annotation is requested
- engine mode preference

Parity-sensitive behaviors that must stay shared:

- `resolveBacktestSettingsFromRaw(...)`
- `resolveCapitalSettingsFromRaw(...)`
- `selectExecutionAwareClosedCandles(...)`
- `sliceOhlcvByBlock(...)`
- strategy `execute(...)`
- `applySignalPolarity(...)`
- entry-only strategy shortcut via `buildEntryBacktestResult(...)`
- Rust eligibility and sanitization
- post-processing in `finalizeBacktestResult(...)`
- optional Polymarket annotation

## Proposed Endpoint Shape

Keep the strategy key in the URL, because that fits your bulk-run idea and keeps routes simple.

### Single backtest

`POST /api/backtest/:strategyKey`

Purpose:

- exact one-run evaluation
- parity testing against the UI
- simplest first integration for `Flux.Native`

Request sketch:

```json
{
  "symbol": "BTCUSDT",
  "interval": "5m",
  "dataset": {
    "candles": []
  },
  "strategyParams": {
    "lookback": 20,
    "threshold": 1.5
  },
  "backtestSettings": {},
  "capitalSettings": {},
  "context": {
    "nowSec": 1775400000,
    "blockRange": null,
    "twoHourCloseParity": "odd",
    "annotatePolymarket": false,
    "engineMode": "auto"
  }
}
```

### Batch backtest

`POST /api/backtest/:strategyKey/batch`

Purpose:

- reduce HTTP overhead
- let `Flux.Native` send many param sets in one request
- reuse one dataset for many runs

Request sketch:

```json
{
  "symbol": "BTCUSDT",
  "interval": "5m",
  "datasetRef": "cache_abc123",
  "items": [
    { "id": "run_1", "strategyParams": { "lookback": 12, "threshold": 1.1 } },
    { "id": "run_2", "strategyParams": { "lookback": 18, "threshold": 1.6 } }
  ],
  "backtestSettings": {},
  "capitalSettings": {},
  "context": {
    "nowSec": 1775400000,
    "engineMode": "auto"
  }
}
```

### Dataset cache

`POST /api/backtest/datasets`

Purpose:

- upload candles once
- reuse them across many calls
- avoid turning request throughput into JSON transfer overhead

Response should return:

- `datasetRef`
- hash or fingerprint
- candle count
- first and last timestamp

### Randomized search

`POST /api/backtest/:strategyKey/search/random`

Purpose:

- move high-volume parameter search out of the browser
- let `Flux.Native` request controlled random sweeps
- keep parameter randomization logic explicit instead of hand-built in the caller

Request sketch:

```json
{
  "symbol": "BTCUSDT",
  "interval": "1m",
  "datasetRef": "cache_abc123",
  "baseParams": {
    "lookback": 20,
    "threshold": 1.5
  },
  "randomization": {
    "rangePercent": 35,
    "count": 5000,
    "seed": 42,
    "freezeKeys": ["stopLossAtr", "takeProfitAtr"]
  },
  "backtestSettings": {},
  "capitalSettings": {},
  "ranking": {
    "topN": 100,
    "sortPriority": ["expectancy", "profitFactor", "netProfitPercent"],
    "minTrades": 40,
    "maxTrades": 100000
  },
  "context": {
    "nowSec": 1775400000,
    "engineMode": "auto"
  }
}
```

## Flux.Native Usage Pattern

Recommended external workflow:

1. Upload or register one dataset and receive `datasetRef`.
2. Call single-run backtest for parity checks and spot validation.
3. Call batch or random-search endpoints for large loops.
4. Pull only compact ranking metrics during search.
5. Re-run only the best candidates with full result output when needed.

This keeps `Flux.Native` fast without forcing the endpoint to return full trade lists for every search candidate.

## Recommended Build Phases

### Phase 0: Lock The Contract

Purpose:

- define exactly what "same result" means
- avoid building an endpoint that accidentally runs a different backtest than the UI

To do:

- define the canonical request shape for single run, batch run, dataset cache, and random search
- decide whether requests accept raw settings, resolved settings, or both
- define engine mode values such as `typescript`, `auto`, and `rust_preferred`
- define whether Polymarket annotation is part of core result or an opt-in add-on
- define the minimal response fields needed by `Flux.Native`
- define a manifest fingerprint or strategy-library version field in health responses

Output:

- frozen endpoint contract document
- explicit parity definition

Exit condition:

- everyone can answer what inputs must match for UI and endpoint parity

### Phase 1: Extract A Pure Shared Backtest Executor

Purpose:

- remove UI-only assumptions from the execution path
- make the endpoint call the same engine as the UI

To do:

- extract a pure executor from `lib/backtest-service.ts`
- move request normalization into a shared module
- pass all execution context explicitly instead of reading from DOM or global state
- keep post-processing shared
- keep Rust fallback rules shared
- keep entry-only strategy handling shared
- keep block slicing and closed-candle trimming shared

Recommended new modules:

- `lib/backtest-endpoint-contract.ts`
- `lib/backtest-executor.ts`
- `lib/backtest-context.ts`

Important details:

- `symbol`, `interval`, `nowSec`, `blockRange`, and parity cannot be implicit anymore
- `finalizeBacktestResult(...)` must stop pulling `state.currentSymbol` and `state.currentInterval`
- optional Polymarket annotation must receive context from the request, not from global UI state

Output:

- UI and non-UI callers both use the same pure executor

Exit condition:

- `backtestService.runCurrentBacktest()` becomes mostly adapter code

### Phase 2: Add Local Single-Run Endpoint

Purpose:

- get an immediately usable local API with minimal moving parts
- allow `Flux.Native` to call a real backtest endpoint quickly

To do:

- add a Vite middleware route in `vite.config.ts`, similar to `/api/sqlite/*`
- implement `POST /api/backtest/:strategyKey`
- validate the request payload and return structured errors
- resolve the strategy from shared registry/manifest
- execute through the shared pure executor
- include result metadata such as strategy key, engine used, bars processed, and execution duration
- add `GET /api/backtest/health`

Important details:

- the first endpoint should prefer correctness over maximum throughput
- if exact parity debugging is needed, allow `engineMode: "typescript"` to bypass Rust
- return a strategy manifest fingerprint in health output so external callers can detect drift

Output:

- first working localhost endpoint for one exact backtest

Exit condition:

- `Flux.Native` can call one endpoint and get the same result as the UI for a known fixture

### Phase 3: Dataset Caching And Batch Runs

Purpose:

- make the endpoint actually fast for large loops
- avoid sending the same candle array thousands of times

To do:

- add dataset upload and cached dataset references
- add dataset hash and reuse logic
- add `POST /api/backtest/:strategyKey/batch`
- support compact responses when only ranking metrics are needed
- add cache eviction rules or session-based cleanup

Important details:

- this phase is more important for speed than raw requests-per-second
- a thousand requests per second is less useful if every request carries full OHLCV payloads
- reuse the same design idea already present in `lib/rust-engine-client.ts` cache methods

Output:

- high-throughput local evaluation path with low transfer overhead

Exit condition:

- one cached dataset can drive large multi-run batches efficiently

### Phase 4: Randomized Search Endpoint

Purpose:

- move the heavy parameter loop outside the browser
- let external tools request large randomized sweeps directly

To do:

- add `POST /api/backtest/:strategyKey/search/random`
- reuse existing parameter-generation logic where possible instead of inventing a second randomizer
- normalize generated params through strategy normalization rules before execution
- support `rangePercent`, `count`, `seed`, and frozen keys
- support ranking and min/max trade filters
- support compact responses for top-N only

Important details:

- keep search separate from single-run backtest so the contracts stay clear
- use the same result-ranking semantics as the current Finder where possible
- never let execution sanitize params differently than the generator exposes

Output:

- endpoint-native randomized sweeps that match repo semantics

Exit condition:

- external caller can request a large random search with deterministic seed and get ranked top results

### Phase 5: UI Reuse And Optional Finder Integration

Purpose:

- prevent the endpoint from becoming a side path that nobody inside the app uses
- optionally let the browser reuse the same local API for some workloads later

To do:

- decide whether Finder should stay browser-local, become endpoint-backed, or support both
- optionally add a developer toggle for endpoint-backed finder execution
- keep current UI apply-result flow unchanged
- keep DOM and settings behavior unchanged for manual backtests

Important details:

- this phase is optional for the first delivery
- the endpoint is valuable even if only external automation uses it at first

Output:

- one shared execution surface for UI and automation

Exit condition:

- endpoint code is no longer an isolated add-on

### Phase 6: Validation And Perf Gates

Purpose:

- prove correctness before optimizing aggressively
- prevent silent drift later

To do:

- add parity fixtures for `1m`, `5m`, and `4h`
- add Polymarket-focused parity fixtures for supported minute workflows
- add tests for `signal_close`, `next_open`, and `next_close`
- add tests for long, short, and both direction modes
- add tests for block-range slicing
- add tests for `120m` odd/even parity if touched
- add smoke tests for dataset cache and batch endpoints
- measure latency for single-run, cached batch, and randomized search

Recommended test files:

- `tests/backtest-endpoint-parity.spec.ts`
- `tests/backtest-endpoint-batch.spec.ts`
- `tests/backtest-endpoint-random-search.spec.ts`

Output:

- automated proof that endpoint and UI stay aligned

Exit condition:

- parity tests pass and performance is acceptable on realistic local datasets

## Risks And Mitigations

### UI and endpoint drift

Mitigation:

- both must call the same pure executor

### Full OHLCV payloads kill throughput

Mitigation:

- add dataset caching before chasing higher request rates

### Strategy normalization drift

Mitigation:

- random search must reuse strategy normalization and shared param generation logic

### Rust vs TypeScript mismatch hides parity bugs

Mitigation:

- keep a `typescript` parity mode for validation and test goldens

### Polymarket annotation slows down bulk search

Mitigation:

- keep annotation opt-in and separate from the fastest ranking path

### Vite middleware becomes the bottleneck

Mitigation:

- ship there first for simplicity, then move the exact same pure executor into a dedicated local service only if needed

## Proposed First Deliverable

The best first deliverable is not the random search endpoint. It is this smaller sequence:

1. Extract pure shared backtest executor.
2. Add `POST /api/backtest/:strategyKey`.
3. Add parity tests against existing UI behavior.
4. Add dataset caching.
5. Add batch endpoint.

That gives a correct base for `Flux.Native` quickly, and it avoids locking the project into a bad search contract before parity is solved.

## Suggested Response Contract

Every successful response should include:

- `ok`
- `strategyKey`
- `engineUsed`
- `result`
- `requestFingerprint`
- `strategyManifestFingerprint`
- `timingMs`

For batch and search responses also include:

- `datasetRef` when applicable
- `processed`
- `returned`
- `topN`

## Decision Summary

Recommended decisions:

- host the first version inside Vite middleware
- keep the strategy key in the URL
- keep settings in the request payload
- keep random search as a separate endpoint, not an overloaded single-run route
- make dataset caching a planned early phase, not an afterthought
- define parity against the shared TypeScript execution path first, then allow Rust through the same executor rules
