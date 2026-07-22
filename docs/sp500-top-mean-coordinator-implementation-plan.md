# S&P 500 TOP_MEAN UI Coordinator - Implementation Plan

The feature is launched and controlled from the Batch Backtest UI. The Vite
server owns the long-running job and uses Node worker threads. There is no CLI
workflow.

## Research contract

### Universe

Build the asset universe from the intersection of:

1. `price-data/sp500_comprehensive_dataset/sp500_comprehensive/sp500_company_info.csv`;
2. `price-data/ibkr/catalog.json`; and
3. local files that contain usable data for the requested interval.

For synthetic 4H pairs, require 30m seed data. Build the ratio from 30m bars,
then aggregate to 4H. Never build a ratio from pre-aggregated 4H legs.

Show these counts in the UI before starting:

- S&P 500 assets;
- S&P 500 assets present in the IBKR catalog;
- assets with usable 30m seeds;
- assets with usable target-interval data;
- canonical pair count;
- excluded assets and pairs.

The current local data set may contain far fewer than 500 IBKR assets. The UI
must show the actual count and label a partial run incomplete.

### Pair orientation

Sort stripped tickers and emit one relationship per pair:

```text
<base>•+<quote>•    where base < quote
```

This is `N * (N - 1) / 2` pairs. Reverse orientations are not included in v1.

### TOP_MEAN result

Use the existing `runOpenScoreUsdReplay` engine unchanged. For each horizon,
the primary ranking is `topMeanByAsset`, sorted by TOP_MEAN selection count
descending, then asset name ascending. Display:

- asset;
- selected event count;
- selection share;
- selected return mean;
- random-candidate mean;
- delta.

The UI may sort diagnostic columns, but “top asset” means the first row by
selection count.

## UI

Add a TOP_MEAN section to `html-partials/tab-batch-backtest.html` and the Batch
DOM contract.

Controls:

- Run;
- Stop;
- horizons, default `12,24,48`;
- worker count, server-clamped;
- optional pair limit for smoke tests;
- Copy/Download result.

The section uses the current built-in strategy, parameters, backtest settings,
capital settings, interval, and Rust preference at Run click. Custom/browser-
only strategies are rejected with a visible message because workers load
built-in strategies through the manifest.

Do not populate the normal Batch pair textarea and do not send 124k symbols to
the browser.

Persist the coordinator `runId` with `readPersistedJson`/`writePersistedJson`.
After reload, poll status and reattach only to the matching run id.

## Server API

Add these local-only routes to the Batch server plugin. Each route must use
`isAllowedLocalRequest`.

### Start

`POST /api/batch-backtest/sp500-top-mean/run`

```ts
{
  runId: string;
  strategyKey: string;
  strategyParams: StrategyParams;
  backtestSettings: BacktestSettings;
  capitalSettings: CapitalSettings;
  interval: string;
  horizons: number[];
  workerCount?: number;
  maxPairs?: number;
  resume?: boolean;
  useRustEnginePreference?: boolean;
}
```

The server validates the body, computes coverage, and rejects the request
before workers start when the run cannot meet the configured coverage gate.
`resume: true` requires the same run fingerprint and skips completed shards.

The response is disconnect-safe NDJSON:

```ts
{ type: "preflight"; counts: CoverageCounts }
{ type: "progress"; phase: CoordinatorPhase; completed: number; total: number; text: string }
{ type: "done"; runId: string; result: ResultSummary }
{ type: "fatal"; runId: string; error: string }
```

The browser receives no OHLCV, signals, trades, or per-pair result rows.

### Stop

`POST /api/batch-backtest/sp500-top-mean/stop` with `{ runId }`.

Stop must be run-id scoped. It aborts loads, terminates workers, stops replay,
and records a cancelled terminal snapshot.

### Status and result

`GET /api/batch-backtest/sp500-top-mean/status?runId=...` returns scalar:

- run phase and terminal state;
- run id and fingerprint;
- coverage counts;
- pair totals, completed, failed, and skipped;
- current phase/progress;
- worker count and actual engine mode;
- artifact/manifest state;
- final result summary when available.

`GET /api/batch-backtest/sp500-top-mean/result?runId=...` returns the scalar
ranking JSON after replay. Both routes are local-only.

## Ownership and lifecycle

Use one small shared Batch operation lock for normal Batch, Mine, Stability
Mine, OPEN_SCORE replay, and TOP_MEAN. A TOP_MEAN run cannot overlap another
CPU-heavy Batch operation. Keep TOP_MEAN state separate from the normal Batch
row state and artifact store.

Coordinator artifacts are retained until replay finishes, until a new
coordinator run starts, or for a bounded retention period such as 24 hours.
Cleanup must be generation-safe. A Vite restart must mark a manifest left in
`running` state as interrupted and allow UI resume.

## Execution

### Worker pool

Reuse the worker-bundle extraction from
`lib/batch-backtest/batch-stability-parallel.ts`.

Default worker count:

```ts
Math.max(1, Math.min(24, availableParallelism() - 4))
```

The server clamps the UI value. Do not promise a runtime before measuring it.

Each worker:

1. loads a built-in strategy through the manifest;
2. pre-resolves executor settings and capital once;
3. loads pairs through `createBatchDatasetLoaderCore`;
4. calls `executeBacktest`, not `runBacktestCompact` directly;
5. uses the same backtest options as `batch-backtest-runner.ts`;
6. reduces trades to `{ type, entryTime, exitTime, exitReason }`;
7. reports pair progress and compact pair results.

The worker must pass the UI Rust preference. If Rust cannot load safely inside a
worker, reject the Rust-requested run or show an explicit TypeScript fallback in
status and result metadata. Never silently force TypeScript.

The worker parity test must compare worker output with the existing server-shaped
`executeBacktest` path for IBKR synthetic fixtures containing long, short, and
no-trade cases.

### Cache

Keep normal Batch cache defaults unchanged.

Add optional capacities to `createBatchDatasetLoaderCore` for the coordinator's
leg and pair LRUs. Add a coordinator-specific synthetic-pair disk-cache
instance with its own directory and `{ maxBytes, maxFiles }` policy. The policy
must apply to startup and every automatic prune; one-off prune arguments are
not sufficient.

Use benchmarked coordinator defaults. Do not assume the existing 24-entry leg
LRU is adequate for a 500-leg universe.

## Artifacts and resume

Write shard artifacts, not one file per pair:

```text
artifacts/sp500-top-mean/<runId>/
  manifest.json
  shards/000000.bin
  shards/000001.bin
  result.json
```

Each shard file contains an array of compact pair artifacts and is written
atomically after the entire shard succeeds. A failed shard is discarded and
retried from the beginning. This avoids duplicate-pair bookkeeping and keeps
the file count small.

```ts
interface CompactPairArtifact {
  schema: "compact_pair_artifact.v1";
  pairIndex: number;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  baseSymbol: string;
  quoteSymbol: string;
  trades: Array<{
    type: "long" | "short";
    entryTime: Time;
    exitTime: Time;
    exitReason?: string;
  }>;
}
```

The manifest contains:

- schema version;
- run id;
- run fingerprint;
- universe/data fingerprint;
- strategy key and interval;
- canonical orientation;
- pair count and shard size;
- shard ranges and statuses;
- completed and failed counts.

The fingerprint includes strategy key/params, backtest settings, capital
settings, interval, Rust preference, canonical asset list, and source-data
fingerprints. Horizons are replay-only settings and do not invalidate completed
backtests.

The replay artifact loader reads shard files and yields compact artifacts as
`BatchSyntheticPairArtifact` adapters with empty `data` and `signals`.

## Replay

After all non-failed shards complete:

1. Load compact pair artifacts through an async generator.
2. Load each target asset's IBKR USD series one at a time.
3. Call `runOpenScoreUsdReplay` with horizons, interval, slippage, commission,
   `submittedDegreeByAsset`, and a cancellation callback.
4. Write `result.json`.
5. Stream only replay progress and the final scalar summary to the UI.

If pair failures, missing targets, or omitted pairs make the result incomplete,
show that state prominently and do not present the ranking as a full-universe
result.

## Implementation steps

### 1. Enumerator and coverage

Add:

- `lib/batch-backtest/sp500-pair-enumerator.ts`;
- `tests/sp500-pair-enumerator.spec.ts`.

Test catalog intersection, interval completeness, missing files, deterministic
ordering, pair count, and reverse-orientation exclusion.

### 2. Compact shard artifacts

Add:

- `lib/batch-backtest/compact-pair-artifact.ts`;
- manifest/shard persistence module;
- focused round-trip, atomic-write, resume, and schema tests.

### 3. Worker bundle, worker, and pool

Add:

- shared worker-bundle leaf;
- `lib/batch-backtest/sp500-top-mean-worker.ts`;
- `lib/batch-backtest/sp500-top-mean-worker-pool.ts`.

Test worker parity, worker failure, shard retry, cancellation, and bounded
memory/backpressure.

### 4. Server job and routes

Add coordinator state, manifest resume, cache instance, replay, and the four
routes to the Batch server plugin. Add route authorization, run-id scoping,
operation conflicts, disconnect handling, terminal snapshots, and restart
reconciliation tests.

### 5. UI

Modify:

- `html-partials/tab-batch-backtest.html`;
- `lib/batch-backtest/batch-backtest-dom.ts`;
- `lib/batch-backtest/batch-backtest-service.ts`;
- Batch styles.

Add the controls, coverage summary, progress, Stop, reload reattachment,
ranking tables, and Copy/Download result actions. Update
`tests/feature-dom-contracts.spec.ts`.

### 6. Benchmark and documentation

Run 200-pair and 2,000-pair UI benchmarks at 1, 4, 8, 16, and the default worker
count. Record throughput, heap, leg-cache hit rate, artifact writes, replay
time, Stop latency, and reload behavior. Only then run the full available
universe.

After implementation, update `docs/batch-backtest-server-side.md` and
`docs/synthetic-pairs.md`, then delete this plan.

## Acceptance checks

```text
npm run typecheck
npm run typecheck:tests
esno tests/sp500-pair-enumerator.spec.ts
esno tests/compact-pair-artifact.spec.ts
esno tests/batch-stability-parallel.spec.ts
esno tests/sp500-top-mean-worker.spec.ts
esno tests/sp500-top-mean-worker-pool.spec.ts
esno tests/sp500-top-mean-server-plugin.spec.ts
esno tests/feature-dom-contracts.spec.ts
```

UI smoke:

1. Run a 200-pair bounded job.
2. Confirm coverage, progress, Stop, result ranking, Copy/Download, and reload
   reattachment.
3. Resume an interrupted job.
4. Run a 2,000-pair benchmark.
5. Run the full available universe only after the benchmark is acceptable.
