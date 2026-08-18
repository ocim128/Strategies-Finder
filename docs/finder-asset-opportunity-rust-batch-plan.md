# Finder Asset Opportunity Multi-Asset Rust Batch Plan

Status: Implemented and enabled by default when Rust is selected; set
`FINDER_ASSET_OPPORTUNITY_RUST_BATCH=0` to roll back to TypeScript batching
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

`runServerAssetIsSearch` still generates signals in TypeScript and feeds results
to `FinderResultRanker`. Rust-eligible candidate and fresh-entry simulations are
coalesced into bounded multi-asset requests; signal generation, ranking, OOS,
and unsupported settings remain TypeScript-authoritative. The original
diagnostic showed 100,983 candidate evaluations, 100% signal-cache hits, and
107,366 ms of cumulative candidate backtest time against 8,353 ms wall time.
That gap justified batching, but it does not imply that every workload benefits
from crossing the Rust process boundary.

The Rust client lives in `lib/rust-engine-client.ts`; the loopback server source
is maintained in the adjacent `trading-engine` workspace. The existing client
and the new multi-asset extension expose:

- `POST /api/backtest` for one dataset and one run;
- `POST /api/backtest/batch` for multiple candidates sharing one dataset,
  including `compact` output;
- `/api/data/cache` plus cached batch endpoints for one cached dataset;
- `/api/backtest/asset-opportunity/multi-batch` and
  `/api/backtest/fresh-entry/multi-batch`, with one dataset boundary per
  workload;
- packed row-major OHLCV transport for multi-asset requests.

The generic `/api/backtest/batch` endpoint remains available to callers that
need full histories. Asset Opportunity uses dedicated scalar and fresh-entry
batch contracts so endpoint selection and trade summaries do not require
sending full `trades` or `equityCurve` arrays. The external Rust server's exact
execution semantics remain an explicit dependency, not an assumption.

No database, persistence schema, public route, UI partial, or browser API
change is planned. The existing loopback Rust server and worker-thread pool
remain the infrastructure boundary. Holdout worker limits are unchanged; the
single iteration uses a bounded Rust evaluation wave and a 512-entry/2-million
bar Rust data-cache budget to avoid 499-asset eviction thrashing.

## Phase 0 result and implementation decision (2026-08-18)

The live loopback service was reachable at `127.0.0.1:3030/api/health` during
implementation and reported `trading-engine-rust` version `0.1.0`. Its source
was inspected in the adjacent external `trading-engine` workspace; the
same-bar policy extension is now maintained there alongside this client.

The confirmed `/api/backtest/batch` contract is:

- one `data` array per request;
- an `items` array containing `{ id, signals, settings? }`;
- shared `initialCapital`, `positionSizePercent`, `commissionPercent`,
  `baseSettings`, `sizing`, and `compact` fields;
- a complete `{ results, processingTimeMs }` response, with one result per
  submitted item when the request succeeds;
- `compact: true` omits `trades` and `equityCurve`, but the service does not
  return endpoint-adjusted Finder selection metrics.

The capability matrix is therefore:

| Asset Opportunity setting | Rust batch decision | Reason |
| --- | --- | --- |
| `signal_close` | supported by the new seam | Rust consumes signals at their candle time |
| `next_open`, `next_close` | TypeScript fallback | not represented by the Rust settings model |
| zero slippage | supported by the new seam | the Rust settings model has no slippage field |
| non-zero slippage | TypeScript fallback | silently ignoring slippage would change fills |
| `allowSameBarExit: true` | supported by the new seam | passed through to Rust signal processing |
| `allowSameBarExit: false` | supported by the new seam | passed through to Rust signal processing |
| long / short | supported by the new seam | both are implemented by Rust |
| combined / both directions | TypeScript fallback | Rust normalizes `Both` to long |
| one open position | supported by the new seam | Rust runs one position |
| multiple positions / hold / path controls | TypeScript fallback | not represented by Rust |
| percent / fixed sizing | supported by the new seam | both are accepted by the batch API |
| `kelly_criterion` sizing | supported by the new seam | Rust mirrors the rolling 100-trade Kelly state, caps, fraction, and fixed/percent fallback |
| other smart sizing | TypeScript fallback | volatility, parity, martingale, and optimal/secure-f sizing still depend on TypeScript-only rolling state |
| endpoint selection | normalized locally from transient full results | the Rust API has no endpoint-selection option |

The implementation uses `compact: false` at the transport boundary only when
endpoint selection needs the Rust trade path. It applies the existing
`buildSelectionResult` function locally, then drops `trades` and `equityCurve`
before the candidate reaches the ranker. This preserves the current Finder
selection contract without retaining full trade histories. Requests are
partitioned by serialized body size, and malformed, incomplete, duplicate,
unknown, or inconsistent results trigger a whole-batch TypeScript fallback.
Eligible server passes upload each asset/window once through `/api/data/cache`
and reuse the returned cache ID with `/api/backtest/batch/cached` for later
strategy batches. If the cache contract is unavailable, the raw-data batch
endpoint remains available as the bounded fallback. Because the external cache
is bounded and can evict an asset during a large multi-asset run, an HTTP error
from the cached endpoint is retried through the raw Rust batch endpoint before
the TypeScript fallback is considered. Cache IDs must identify the full OHLCV
content, not only a time range and bar count, so two assets cannot share a
reference accidentally. Both request and response byte budgets are enforced
before a full result is parsed.

The same bounded batch seam is used for `signal_close` fresh-entry rechecks.
TypeScript still prepares each candidate's signals and resolved settings, but
the dedicated Rust fresh-entry endpoints return only `totalTrades`, the latest
trade's entry fields, and `isOpen`. This is the complete contract required by
the existing detector; full `trades` and `equityCurve` arrays are not sent over
the wire. If that batch cannot be used, the prior per-candidate replay remains
the fallback.

The candidate-scoring path uses a separate `/api/backtest/asset-opportunity/batch`
contract (and its cached equivalent). Rust performs the full simulation
internally, then returns only raw and endpoint-adjusted scalar metrics plus the
removed-trade count. The generic `/api/backtest/batch` contract remains
unchanged for callers that require full histories.

The checked-in benchmark harnesses measure both the isolated engine and the
production-shaped Finder path. The isolated harness shows that Rust's scalar
summary kernel can be faster, while the full Finder result also includes
TypeScript signal generation, batching, serialization, and cache transport.

| Workload | TypeScript | Forced Rust | Result |
| --- | ---: | ---: | --- |
| 128 assets x 45 real strategies, 3,589 bars | ~5.9 s | ~13.5 s | TypeScript faster |
| 499 assets x 45 real strategies, 2 candidates, 500-bar eval window | ~23.2 s | not used by the adaptive gate | TypeScript selected |

The first workload demonstrates why forcing Rust is counterproductive for the
current low-density Finder shape: signal generation and transport dominate the
Rust kernel. The adaptive gate therefore keeps capped runs with fewer than
eight candidates per asset on TypeScript and retains Rust for dense or
uncapped workloads. The benchmark also verifies the compact and fresh-entry
contracts separately.

The server gate is enabled unless `FINDER_ASSET_OPPORTUNITY_RUST_BATCH=0`; the
request budget can be adjusted with `FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES` (default
16 MiB, bounded to 1-128 MiB). The response budget can be adjusted with
`FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES` (default 128 MiB,
bounded to 4-512 MiB). The UI Rust preference must also be enabled.
The bounded Rust path is now the default for Rust-eligible runs. The existing
TypeScript path remains the authority for unsupported settings and whole-batch
fallbacks, and setting `FINDER_ASSET_OPPORTUNITY_RUST_BATCH=0` or disabling the
UI Rust preference provides an independent rollback.

The Phase 0 go/no-go decision is **go** for bounded cross-asset candidate and
fresh-entry batching. The adjacent Rust service now accepts one dataset
boundary per multi-asset workload, compact packed OHLCV payloads, and stable
cache references. Numerical full-workload parity and performance qualification
remain rollout criteria; unsupported or failed batches still fall back to
TypeScript.

## Implemented multi-asset follow-up (2026-08-18)

The implementation is in `asset-opportunity-iteration.ts`,
`finder-asset-opportunity-multi-rust-batch.ts`, `server-asset-is-search.ts`,
and `rust-engine-client.ts`. Rust-eligible Finder work runs in bounded waves
of up to 256 assets. Candidate and fresh queues send groups of up to 256
workloads, while cache bootstrap requests are limited to 32 datasets. Content-
keyed cache promises ensure each dataset/window is uploaded once and reused
across strategies and fresh-entry replay. OHLCV and ordinary signals use packed
row-major transport; unsupported signal fields keep the lossless object form.
The adjacent Rust service resolves raw or cached workloads, slices
`dataEndIndex` for candidate prefixes, and parallelizes workloads with Rayon.

The cache is bounded by both 512 entries and 2,000,000 retained bars. This
covers the observed 499-asset/3,589-bar run without evictions while preventing
unbounded retention for larger datasets. HTTP errors, malformed responses,
cache eviction, cancellation, timeouts, and size-limit failures retain the
existing whole-batch TypeScript fallback.

The production-shaped benchmark is
`scripts/finder-asset-opportunity-benchmark.ts`. Its low-density default is
deliberate: it reproduces the observed two-candidate-per-asset shape rather
than presenting a dense synthetic workload as representative.

| Workload | TypeScript | Rust preference | Result |
| --- | ---: | ---: | --- |
| 499 assets x 45 real strategies, 2 candidates, 500-bar eval window | ~23.2 s | ~23.5 s, 0 Rust calls | adaptive gate selects TypeScript |

The benchmark intentionally includes TypeScript signal generation and Finder
orchestration; `scripts/engine-benchmark.ts` remains the isolated
kernel/transport benchmark. The Rust-preference run is expected to report a
low-density skip, not a misleading forced-Rust comparison.

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
    percent/fixed/Kelly sizing and the remaining TypeScript-only smart-sizing modes.
3. Confirm how compact results represent endpoint-adjusted selection metrics
   and optional trade history. The batch result must contain enough information
   for the existing `buildSelectionResult`/`BacktestEndpointSelection` contract,
   or the Rust adapter must normalize an equivalent result without changing
   ranking semantics.
4. Resolve the current permanent TypeScript gate in
   `lib/rust-settings-sanitizer.ts` only after the external behavior is proven.
   Keep slippage and execution-model guards because those fields are still not
   represented by the Rust settings model.

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
   memory; transfer each dataset once per asset/window or use the existing Rust
   data cache when the external contract supports stable dataset references.
3. Add compact-result validation and normalization. Reject malformed, missing,
   duplicate, or inconsistent candidate IDs rather than silently dropping them.
4. Preserve existing request timeouts and add caller cancellation support if
   the batch request otherwise prevents the Finder Stop path from returning.
   Bound both request and response bodies; a response over the configured limit
   must take the complete TypeScript fallback before JSON parsing.
5. Keep an environment-controlled batch gate so the Rust bridge can be
   disabled independently of the UI preference. The UI Rust preference and the
   feature gate must both permit the path.

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
5. Keep these paths TypeScript initially: fixed/complementary OOS winner
   validation, exit-strategy overrides, and any cross-symbol case whose
   resolved data contract is not covered by Phase 0. Fresh-entry rechecks use
   the dedicated compact summary endpoint described above; the prior
   per-candidate replay remains their fallback.

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
   Keep the Rust batch feature gate independently disableable; it is enabled by
   default after the compatibility validation documented above.
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
3. Keep the existing worker and request bounds. Change them only after an
   external-server benchmark shows that extra concurrency reduces wall time
   rather than queueing requests.
4. Treat the adaptive low-density gate as part of the performance result:
   Rust must not be forced onto a workload where its process and transport
   overhead exceeds the TypeScript path.

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
- Feature activation decision: enabled by default with an environment rollback.

### Validation/testing

- `npm run typecheck`
- `npm run typecheck:tests`
- Focused Rust batch, Asset Opportunity, server plugin, runner, compact parity,
  and diagnostics specs.
- Manual one-holdout and two-holdout runs with identical seeds and archive
  comparison.

### Exit criteria

The feature remains enabled as an adaptive acceleration layer when parity and
fallback tests are green and memory remains within the existing worker budget.
Low-density capped runs intentionally select TypeScript. If a dense Rust path
regresses or parity fails, set `FINDER_ASSET_OPPORTUNITY_RUST_BATCH=0` and
retain the TypeScript implementation while investigating.

## Rollback

The first rollback is the Rust batch feature gate, which returns all Asset
Opportunity candidate simulations to the current TypeScript path. The existing
`FINDER_ASSET_BATCH_WORKERS=1` switch remains the independent worker-pool
rollback. A code revert must not be required to recover normal operation, and
no archive, localStorage, SQLite, or other persisted schema changes are part of
this plan.
