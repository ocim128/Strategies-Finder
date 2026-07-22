# S&P 500 TOP_MEAN Coordinator — Implementation Plan

> Status: **PRE-IMPLEMENTATION**. This document is a plan, not shipped behavior.
> Once the feature ships, fold the operational parts into `docs/batch-backtest-server-side.md` and `docs/synthetic-pairs.md`, then delete this file (per `docs/README.md` maintenance rule: "Do not add implementation plans to `docs/`").
> Precedent: this file follows the same convention as `docs/open-score-usd-consensus-implementation-plan.md` (a planning doc added at the user's explicit request with a self-deleting maintenance note).

## Problem

The user needs to know **which S&P 500 asset has the highest TOP_MEAN rank** across all ~124,750 IBKR synthetic pairs (500 × 499 / 2). The pair count is 62× the server's hard cap, per-pair backtest runs on one core, and the existing artifact path stores 5–10 MB per pair — a shape that cannot reach this scale.

This is a **recurring** research question (weekly re-runs on fresh data), not a one-shot, on a high-end workstation (Intel i7-14700K, 28 threads, 64 GB RAM).

## Goal

A Node CLI coordinator that:

1. Enumerates all ~124,750 IBKR synthetic pairs (`BASE+QUOTE`, `•`-suffixed legs) from the S&P 500 catalog.
2. Backtests every pair against the currently UI-selected strategy / params / settings.
3. Stores **compact trades-only artifacts** (~2 KB each) on disk — the only trade fields OPEN_SCORE reads are `{ type, entryTime, exitTime, exitReason }`.
4. Feeds them to the **unchanged** `runOpenScoreUsdReplay` engine and prints the TOP_MEAN ranking + writes a ranking JSON.
5. Resumes from the last completed shard on crash / re-run.

**Target runtime** on the stated hardware: ~30–60 min cold (synthetic-pair disk cache empty), <10 min warm (disk cache populated from a prior run).

## Why a new path instead of driving the existing server `/run`

The server `/run` endpoint is the wrong contract for this job. Each load-bearing limit below is correct for the browser/server path but blocks the 124k-pair research use case:

| Server `/run` contract | File:line | Why it blocks 124k pairs |
|---|---|---|
| `BATCH_MAX_SYMBOLS = 2_000` hard cap | `lib/batch-backtest/batch-run-contract.ts:24` (enforced again `batch-backtest-vite-plugin.ts:1675`) | 124,750 pairs = 63 sequential requests |
| `runOwner` single-owner mutex | `lib/batch-backtest/batch-backtest-vite-plugin.ts:557` | Cannot parallelize across the 63 requests |
| `DEFAULT_ARTIFACT_RETENTION_MS = 10 min` TTL | `lib/batch-backtest/batch-backtest-vite-plugin.ts:128` | Wipes artifacts before the replay can run across shards |
| Per-pair backtest is one-core serial JS | `lib/batch-backtest/batch-backtest-runner.ts:297` (plain `await executeBacktest` in a `for` loop, only `PREFETCH_AHEAD = 4` I/O overlap) | No path to 24× throughput without server surgery |
| `LEG_CACHE = 24`, `PAIR_CACHE = 16` | `lib/batch-backtest/batch-dataset-loader-core.ts:67-68` | Thrashes on a 500-leg universe |
| Per-pair artifact ~5–10 MB (full v8-serialized `data` + `signals` + `result`) | `lib/batch-backtest/batch-backtest-vite-plugin.ts:10-13` | 124k × ~7 MB ≈ 870 GB on disk |

The CLI goes **around** these contracts (correct for the browser/server path) by calling `lib/` leaves directly, matching the established research-script pattern (`scripts/validate-spread-quality.ts`, `scripts/diagnose-mine-prediction.ts`, `scripts/polymarket-sync-outcomes.ts`).

## Node-worker safety of the backtest engine (load-bearing)

A static audit of the transitive import graph of `runBacktestCompact` (`lib/strategies/backtest/backtest-engine.ts:1333`) confirms it is Node-clean:

- The engine file itself imports no `lightweight-charts`, no `document`, no `window`, no `lib/chart-manager.ts`.
- Its only suspicious import is `from '../../types/index'` (`lib/types/index.ts`), which does runtime `export *` from `./strategies`, `./backtest`, `./finder`, `./scanner`, `./data-providers`. Auditing each of those: every `export *` target is either type-only or pure-const (e.g. `TRADE_SIZING_MODES` in `lib/types/backtest.ts`, `DEFAULT_SCANNER_CONFIG` in `lib/types/scanner.ts`). None reach `lib/finder-manager.ts`, `lib/data-manager.ts`, `lib/chart-manager.ts`, `lib/ui-manager.ts`, `lib/settings-manager.ts`, or `lib/constants.ts`. The `lightweight-charts` reference inside `lib/types/index.ts` is `import type` and erased.
- `executeBacktest` (`lib/backtest-executor.ts`) transitively reaches `resolveExecutorBacktestSettings`, `resolveCapitalSettingsFromRaw`, `selectClosedCandleData`, signal merge, and the compact engine — all pure-computation leaves.

**Note on what the existing `batch-stability-worker.ts` does and does NOT prove.** The stability worker (`lib/batch-backtest/batch-stability-worker.ts:30-45`) imports `runPreparedBatchSyntheticStateMiner` from `batch-synthetic-state-miner.ts` — a state-miner over pre-existing artifacts. It does NOT call `runBacktestCompact`, `executeBacktest`, or any full backtest. So the stability worker proves the import graph is Node-loadable, but it does NOT prove that running a full backtest in a worker produces identical trades to a server `/run` call. **The Phase 4 parity test is the load-bearing proof of that claim** — it runs the same pair through both paths and asserts byte-identical compact trades. If the static audit missed a transitive browser-bound import, the parity test fails at first run, before any production data is touched.

## Key reframe: the research goal is much smaller than the artifact path produces

The OPEN_SCORE replay engine reads exactly **four** fields per trade, verified at `lib/batch-backtest/batch-open-score-usd-replay-engine.ts:436-450`:

- `trade.entryTime` (line 437)
- `trade.exitTime` (line 438)
- `trade.type` — values `"long" | "short"` (line 440) — **NOT** `side`
- `trade.exitReason` — only compared `!== "end_of_data"` (line 447)

It does **not** read `entryPrice`, `exitPrice`, `pnl`, `pnlPercent`, `size`, `fees`, `stopLossPrice`, `takeProfitPrice`, or `polymarketOutcome`. It also does not read `artifact.data` or `artifact.signals` (the `data`/`signals` fields on the `BatchSyntheticPairArtifact` are unused inside the engine — confirmed at `tests/batch-open-score-usd-replay-engine.spec.ts:37`).

Per-pair artifact size drops from ~5–10 MB to **~2 KB**. Total: 124,750 × ~2 KB ≈ **~250 MB per run**, three orders of magnitude smaller than the 870 GB the existing artifact path would produce.

## Design decisions (with rationale)

### D1. CLI coordinator, not a server endpoint or browser feature

The browser tab is the wrong process for a 30–60 min CPU job (tab reload kills it; the existing server path requires a single-owner lock). A Node CLI driven by `esno` matches `scripts/validate-spread-quality.ts` (also reads `.bin` artifacts) and `scripts/diagnose-mine-prediction.ts` (also calls strategy/backtest leaves directly). The CLI imports `lib/` directly — no HTTP, no Vite dependency at runtime except for IBKR CSV serving (see D6).

### D2. Worker-thread pool extracted from existing stability scaffolding

`lib/batch-backtest/batch-stability-parallel.ts` already contains a complete `worker_threads` orchestrator: esbuild-bundle-once, content-addressed cache, `{ ok: false, reason }` typed fallback (`:222`, `:502`), 5-min timeout per worker (`:619`), cancellation via 250ms poll (`:562`). Today its helpers (`bundleWorkerWithEsbuild`, `resolveWorkerPath`, `computeDependencyHash`, `sweepStaleWorkerBundles`) are module-private.

This plan extracts them to a shared leaf (`lib/batch-backtest/worker-bundle.ts`) so both the stability pool and the new runner pool use the same bundling/cache logic. Stability parallel's behavior is locked by `tests/batch-stability-parallel.spec.ts`, which is the regression gate for the extraction.

The new pool partitions by **pair** (each pair is independent), where stability partitions by **rerun**. The pool body is heavier per unit (load dataset + run backtest), but the orchestration shape (spawn N workers, hand each a slice, merge results, fall back to sequential on any failure) is identical.

### D3. Worker count = `min(24, availableParallelism() - 4)`

`resolveStabilityWorkerCount` (`batch-stability-parallel.ts:45`) caps at `min(8, cores - 1)`. That cap is right for reruns (low per-unit work, OS file cache contention cited in its comments), but wrong here: per-unit work is heavy (backtest), so contention is dominated by CPU, not file cache. Bump to 24 on the target 28-thread machine, leaving 4 threads for main-thread coordination + OS file cache. Configurable via `--workers N`. Documented as a separate cap from stability's; do not change stability's cap.

### D4. Compact artifact format (new leaf, v8-serialize)

New `lib/batch-backtest/compact-pair-artifact.ts`:

```ts
export interface CompactPairArtifact {
  symbol: string;          // e.g. "•AAPL+•MSFT"
  baseAsset: string;       // e.g. "AAPL"  (stripped)
  quoteAsset: string;      // e.g. "MSFT"
  baseSymbol?: string;     // e.g. "•AAPL" (marked leg, forwarded for target loader)
  quoteSymbol?: string;
  trades: Array<{
    type: "long" | "short";
    entryTime: Time;
    exitTime: Time;
    exitReason?: string;
  }>;
}
```

v8-serialized to disk via `node:v8` (consistent with the existing artifact store at `batch-backtest-vite-plugin.ts:408`). The replay adapter reconstructs a `BatchSyntheticPairArtifact` with empty `data: []`, `signals: []`, and `result: { trades: expandedTrades }` using `createEmptyBacktestResult()` from `lib/strategies/backtest/position-stats.ts`. The engine consumes this without modification.

### D5. Resume manifest — shard-level, fingerprint-gated

`./artifacts/sp500-top-mean/<run-id>/manifest.json`:

```ts
{
  schema: "sp500_top_mean.manifest.v1",
  runId: string;                       // ISO timestamp, also the directory name
  configFingerprint: string;           // hash of {strategyKey, params, settings, capital, interval, assetList}
  interval: string;
  strategyKey: string;
  shardSize: number;
  shards: Array<{
    index: number;
    pairRange: [start, end];           // indices into the canonical pair list
    status: "pending" | "running" | "done" | "failed";
    startedAt?: number;
    completedAt?: number;
    pairsWritten: number;
    pairsFailed: number;
  }>;
}
```

Re-run with `--run-id <id>` skips `done` shards. A mismatched `configFingerprint` is a hard error — forces a fresh `run-id` so trades from different strategies/settings cannot be mixed under one run. Failed shards retry on re-run; per-pair failures inside a shard are logged and the shard still completes.

### D6. Data loading reuses the server-side loader path

Workers build datasets through `createBatchDatasetLoaderCore` (`lib/batch-backtest/batch-dataset-loader-core.ts:67`) with the same `server-batch-data-loader.ts` shape, so the synthetic-pair pipeline, `SyntheticLegCache`, and offline-first gap-fill are identical by construction (loader parity, per AGENTS.md audit F8 / loader-parity spec).

IBKR CSVs are served through `/price-data/ibkr/csv/30m/*.csv`. The loader uses `fetchLocalApi(...)` (`lib/local-api-transport.ts:60`), which in Node resolves relative URLs against `http://127.0.0.1:5173` (overridable via `VITE_DEV_SERVER_ORIGIN`) — this fix exists specifically because Node's `fetch` does not resolve relative URLs. **Consequence: the dev server (`npm run dev`) must be running while the coordinator executes.** This is documented as an explicit prerequisite in the script's `--help` and startup banner.

### D7. Pair cache cap override, not a default change

Existing `synthetic-pair-disk-cache.ts` caps: `MAX_CACHE_BYTES = 2 GiB` (`:72`), `MAX_CACHE_FILES = 2_000` (`:73`). These defaults are right for the browser/server path; do NOT change them.

For 124k pairs we need roughly 60 GB / 124k files. The CLI accepts `--pair-cache-max-bytes` and `--pair-cache-max-files` that override the caps via the existing `options.maxBytes` / `options.maxFiles` parameter on `pruneSyntheticPairDiskCache` (`synthetic-pair-disk-cache.ts:520-521`). Override only applies for the duration of the CLI process; defaults stay bounded for all other consumers. This matches AGENTS.md cache-cap guidance: "raise only after checking steady-state footprint."

### D8. Replay targets = each asset's own IBKR 4H series

The replay engine needs one `OpenScoreUsdTarget` per asset (`batch-open-score-usd-replay-engine.ts:212-216`: `{ asset, symbol, data: OHLCVData[] }`). For "which S&P 500 asset ranks highest," the natural target is each asset's own IBKR 4H OHLCV (the asset vs USD), matching the existing MAX_ACTIVE research framing. The target loader yields targets one at a time and releases each after Phase 4 consumes it (engine `:749`: "target OHLCV reference released here").

### D9. UI config bridge via "Export CLI Config" button

The coordinator needs the current strategy/params/settings/interval. The cleanest bridge is a small button on the Batch UI tab that downloads a JSON config file the coordinator reads. This reuses the existing `batchService` request shape that already goes to `/run` — no new contract. ~25 lines of service code + one `<button>` in `html-partials/tab-batch-backtest.html` + one id in the Batch DOM contract + a `feature-dom-contracts.spec.ts` row.

Hand-editing the JSON is also valid; the button is a convenience, not a requirement.

## What this feature will NOT do

- **Not parallelizing the existing server `/run` path.** That touches load-bearing contracts (`runOwner`, the 10-min TTL, the 2000-symbol cap) for a different use case.
- **Not changing `BATCH_MAX_SYMBOLS`.** The cap is correct for the browser/server path; this feature goes around it.
- **Not adding the Rust engine.** The dormant `archive/rust-migration.txt` plan would give 50–100× throughput but costs weeks — not worth it for a recurring-but-not-constant job. Workers give ~24× which is sufficient.
- **Not building a no-disk streaming variant.** The compact artifact format makes the disk path cheap (~250 MB total); a streaming variant would force the replay engine to handle 124k-pair event volume in one shot, which is bigger surgery.
- **Not changing the OPEN_SCORE engine.** The engine is correct; we adapt to its input contract via the loader wrapper.
- **Not handling Polymarket pairs.** Out of scope; this is IBKR S&P 500 only.
- **Not introducing Mine Timing or Stability Mine.** Those are separate research surfaces with their own (mostly negative) findings — see `docs/mine-timing-validation-findings.md`.

## Architecture

```
┌─ UI (tab-batch-backtest.html + batch-backtest-dom.ts) ─────────────┐
│  New: "Export CLI Config" button → downloads JSON config            │
│  (reuses existing batchService request shape; no new contract)      │
└─────────────────────────────────────────────────────────────────────┘
                              │ downloaded sp500-top-mean-config.json
                              ▼
┌─ Coordinator (NEW: scripts/sp500-top-mean.ts, esno CLI) ────────────┐
│  Reads config + S&P 500 catalog, enumerates pairs, shards, resumes, │
│  dispatches to worker pool, writes compact artifacts, drives replay │
└────────────┬────────────────────────────────────┬───────────────────┘
             │ worker_threads (24)                │ direct call
             ▼                                    ▼
┌─ Worker pool (NEW) ───────────────┐  ┌─ Replay (UNCHANGED) ──────────┐
│  batch-runner-worker-pool.ts      │  │  runOpenScoreUsdReplay         │
│   └ batch-runner-worker.ts        │  │  fed by async-generator        │
│      ├ manifest-loaders (dynamic) │  │  adapter that wraps compact    │
│      │  + resolveExecutorBacktest │  │  artifacts into the engine's   │
│      │    Settings + resolveCapi  │  │  BatchSyntheticPairArtifact    │
│      │    talSettingsFromRaw      │  │  shape (empty data/signals)    │
│      ├ createBatchDatasetLoader   │  └────────────────────────────────┘
│      │  Core (UNCHANGED)          │
│      └ executeBacktest            │
│         (UNCHANGED)               │
│      emits CompactPairArtifact    │
└───────────────────────────────────┘
             │
             ▼
┌─ Disk ──────────────────────────────────────────────────────────────┐
│  ./artifacts/sp500-top-mean/<run-id>/                               │
│    manifest.json       (resume state)                               │
│    000000.bin … NNNNNN.bin   (compact artifacts, v8-serialized)     │
│    sp500-top-mean-<run-id>.json   (ranking output, after replay)    │
│  ./price-data/synthetic-cache/*.bin  (existing pair disk cache,     │
│    caps overridden via --pair-cache-max-{bytes,files})              │
└─────────────────────────────────────────────────────────────────────┘
```

## Affected modules and files

### New files

| File | Purpose | Approx LoC |
|---|---|---|
| `lib/batch-backtest/worker-bundle.ts` | Extracted esbuild-bundle-once + content-addressed-cache helpers. Exports `bundleWorker`, `computeDependencyHash`, `sweepStaleWorkerBundles`. Currently module-private in `batch-stability-parallel.ts` at `:276`, `:324`, `:348`, `:433`. | ~120 |
| `lib/batch-backtest/compact-pair-artifact.ts` | Leaf. `writeCompactPairArtifact(path, art)`, `readCompactPairArtifact(path)`, `CompactPairArtifact` type. v8-serialize. | ~80 |
| `lib/batch-backtest/batch-runner-worker.ts` | Worker body. Pre-resolves settings/capital via `resolveExecutorBacktestSettings` + `resolveCapitalSettingsFromRaw` (mirrors `batch-backtest-runner.ts:184-189`), loads strategy via `manifest-loaders.builtInStrategyLoaders[key]()`, processes its shard's pairs sequentially via `executeBacktest(...)` (mirrors `:297-321`), posts `{ symbol, ok, trades \| error }` per pair. Stays Node-only (mirrors `batch-stability-worker.ts:20-24` leaf-only-diet discipline). | ~160 |
| `lib/batch-backtest/batch-runner-worker-pool.ts` | Pool orchestrator. `runBatchOverWorkers({ shards, workerCount, interval, strategyKey, ..., onPairResult, isCancelled })`. Reuses `bundleWorker` from `worker-bundle.ts`. Returns `{ ok: false, reason }` typed fallback (mirrors `batch-stability-parallel.ts:502`). | ~180 |
| `lib/batch-backtest/sp500-pair-enumerator.ts` | Leaf. Reads the S&P 500 catalog, returns the 500 IBKR-marked asset symbols, generates all `BASE+QUOTE` combinations deterministically. | ~70 |
| `scripts/sp500-top-mean.ts` | CLI coordinator. Arg parsing, config loading, sharding, resume manifest, dispatch pool, write compact artifacts, drive replay, print report + write JSON. | ~350 |

### Modified files

| File | Change |
|---|---|
| `lib/batch-backtest/batch-stability-parallel.ts` | Replace module-private `bundleWorkerWithEsbuild` / `resolveWorkerPath` / `computeDependencyHash` / `sweepStaleWorkerBundles` with imports from `./worker-bundle`. Behavior identical. |
| `lib/batch-backtest/batch-backtest-dom.ts` | Add `batchBacktestExportCliConfigBtn` to the Batch DOM contract. |
| `html-partials/tab-batch-backtest.html` | Add the "Export CLI Config" `<button>` with the new id. |
| `lib/batch-backtest/batch-backtest-service.ts` | Add `exportCliConfig()` handler (~25 lines). Builds the same request shape already built for `/run` and triggers a `Blob` download. |
| `package.json` | Add `"sp500:top-mean": "esno scripts/sp500-top-mean.ts"`. |

### Unchanged (load-bearing contracts preserved)

- `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` — called unchanged via async-generator adapter.
- `lib/batch-backtest/batch-backtest-runner.ts` — server `/run` path untouched.
- `lib/batch-backtest/batch-backtest-vite-plugin.ts` — server `/run`, `/status`, `/open-score-usd` untouched.
- `lib/strategies/backtest/backtest-engine.ts` — `runBacktestCompact` called unchanged, but indirectly via `executeBacktest` (mirroring the batch runner). The worker does NOT call `runBacktestCompact` directly — that would skip settings resolution, capital resolution, signal preparation, and `normalizeParams`.
- `lib/batch-backtest/batch-run-contract.ts` — `BATCH_MAX_SYMBOLS = 2_000` untouched.
- `lib/batch-backtest/synthetic-pair-disk-cache.ts` — default caps untouched.

## Data flow

```
1. UI: user picks strategy + params + settings + interval in Batch tab, clicks "Export CLI Config"
   → sp500-top-mean-config.json downloaded

2. CLI: npm run sp500:top-mean -- --config ./sp500-top-mean-config.json --run-id <iso> [--resume]
   a. Read config JSON + S&P 500 catalog
   b. enumeratePairs(sp500Assets) → 124,750 BASE+QUOTE tokens (deterministic sort)
   c. Hash config → configFingerprint
   d. Open or create manifest.json under ./artifacts/sp500-top-mean/<run-id>/
      - If --resume and fingerprint matches: skip shards with status "done"
      - If fingerprint mismatch: error out (forces fresh run-id)
   e. For each pending shard: dispatch to worker pool
   f. Each worker (mirrors batch-backtest-runner.ts:184-189, 297-321):
      - At worker start (once): resolveExecutorBacktestSettings(rawSettings, interval)
        + ensureConfirmationStrategiesLoaded(resolved)
        + resolveCapitalSettingsFromRaw(rawCapital)
      - loadStrategy(strategyKey) via manifest-loaders (dynamic import, Node-safe)
      - for each pair in shard:
        - loadDataset(pair, interval) via createBatchDatasetLoaderCore
        - executeBacktest({ohlcvData, interval, strategy, strategyParams,
            backtestSettings: raw, capitalSettings: raw,
            preResolvedSettings, preResolvedCapital,
            context: { engineMode: "auto", useRustEnginePreference: false, ... },
            backtestRunOptions: { omitEquityCurve: true, skipResultPostProcessing: true, ... }})
        - reduce output.result.trades to the 4-field compact subset
        - postMessage({ symbol, ok: true, trades: compactTrades }) per pair
   g. Parent writes each result to <run-id>/NNNNNN.bin as compact artifact
   h. Parent marks shard "done" in manifest (atomic rewrite)
   i. After all shards done:
      - build targetLoader from same catalog (per-asset IBKR 4H OHLCV)
      - build artifactLoader (async generator over NNNNNN.bin files)
      - runOpenScoreUsdReplay(artifactLoader, targetLoader, { horizons, ... })
      - print reportLines to stdout
      - write sp500-top-mean-<run-id>.json with per-asset { events, share, topMean, randomMean, delta, CI } for all arms
```

## APIs and contracts

### New runtime contracts

**Compact artifact on-disk format** (v8-serialized):
- Schema is implicitly versioned by the `CompactPairArtifact` TypeScript type.
- No migration needed in v1; if the shape changes later, embed a `schema: "compact_pair_artifact.v1"` discriminator field on read.

**Resume manifest schema**: `"sp500_top_mean.manifest.v1"` (explicit `schema` field). Future-breaking changes bump the schema string and refuse to load older manifests.

**CLI args** (subject to refinement; documented in `--help`):

```
--config <path>            default: ./sp500-top-mean-config.json
--run-id <id>              default: ISO timestamp at start
--resume                   skip shards marked "done" (requires matching fingerprint)
--workers <n>              default: min(24, availableParallelism() - 4)
--shard-size <n>           default: 2000 (matches BATCH_MAX_SYMBOLS semantics)
--pair-cache-max-bytes <n> default: 80 GB (override only for this process)
--pair-cache-max-files <n> default: 200_000
--max-pairs <n>            optional cap for subset smoke runs (e.g. 200)
--min-disk-coverage <pct>  default: 50 — refuse to start if disk-available pairs
                           are below this share of total (surfaces the 70-CSV
                           gotcha before wasting worker startup)
--force                    bypass the --min-disk-coverage gate (you know)
--horizons <n,n,...>       default: "12,24,48" (forward-return bars)
--vite-origin <url>        default: http://127.0.0.1:5173 (for IBKR CSV serving)
```

### Unchanged contracts (called, not modified)

- `runOpenScoreUsdReplay(artifactLoader, targetLoader, options)` — signature unchanged.
- `BatchSyntheticPairArtifact` — adapter produces this shape; the type itself is untouched.
- `createBatchDatasetLoaderCore(options)` — called with the same shape the server loader uses.
- `executeBacktest(...)` — called with the same request shape the batch runner uses today (per `batch-backtest-runner.ts:297-321`), including `preResolvedSettings`/`preResolvedCapital` (resolved once per worker per `:184-189`) and `backtestRunOptions: { omitEquityCurve: true, skipDrawdown: false, skipResultPostProcessing: true, includeAdvancedAnalytics: false }`. The worker does NOT call `runBacktestCompact` directly — `executeBacktest` is the seam that handles settings/capital resolution, signal preparation, `normalizeParams`, and the compact-path selector.

## State management

- **No localStorage, no UI state.** The coordinator is a stateless Node process; all state lives in `manifest.json` on disk.
- **No interaction with the server's `currentArtifactStore` / `lastRunFingerprint` / `lastRunInterval` module state.** The coordinator drives the replay engine directly; the server's module state is irrelevant.
- **Worker state is per-worker and ephemeral.** Each worker holds its shard + a `SyntheticLegCache` instance; both are GC'd when the worker terminates.

## Infrastructure and deployment

- **Dev server (`npm run dev`) must be running** while the coordinator executes, because IBKR CSVs are served via `/price-data/...` and resolved through `fetchLocalApi` → `http://127.0.0.1:5173`. The CLI prints a clear error if `GET <vite-origin>/price-data/ibkr/csv/30m/AAPL.csv` returns non-200.
- **`NODE_OPTIONS=--max-old-space-size=32768` recommended.** The coordinator itself stays small (~1 GB), but the replay engine retains `streams: ScoreDelta[][]` (Phase 1, bounded by total deltas ~120 MB at 124k pairs) and `events: DecisionEvent[]` with per-event asset snapshots (Phase 2, the dominant consumer — could reach single-digit GB at 124k pairs). 32 GB heap is comfortable headroom on the 64 GB machine.
- **Disk footprint**: ~250 MB compact artifacts + up to 60 GB synthetic-pair disk cache (configurable). Both live under the project tree (`./artifacts/`, `./price-data/synthetic-cache/`).
- **No new env vars required.** `VITE_DEV_SERVER_ORIGIN` is the only relevant one and is already supported by `lib/local-api-transport.ts`.

## Logging and observability

- **Per-shard progress to stdout**: `[shard 3/63] 1200/2000 pairs (60%) — 4 failed`. Flush after each pair batch so a tail follows live progress.
- **Per-pair failures logged once** with reason (`load_failed` / `run_failed`), summarized at shard end: `shard 3 done: 1996 ok, 4 failed (reasons: load_failed=3, run_failed=1)`.
- **Replay phase progress** uses the engine's existing `onPhase` callback (`batch-open-score-usd-replay-engine.ts:245-247`): `scan`, `merge`, `candidates`, `outcomes`, `aggregate`.
- **Engine warnings** (right-censored events, missing assets, reversion-empty universe) come through `reportLines` verbatim — already implemented.
- **No structured logging file** — stdout + the JSON ranking output are sufficient for a CLI. Matches `scripts/diagnose-mine-prediction.ts` convention.

## Security

- **Loopback-only by construction.** The CLI talks to `http://127.0.0.1:5173` for static CSV serving only; it does not expose any new HTTP route. No remote attack surface added.
- **No secrets in artifacts.** Compact artifacts contain only trade timing + asset names — no API keys, no wallet material. Safe to keep on disk and commit the ranking JSON (after review).
- **No `eval` / `Function` constructor.** Strategy params come from a JSON config file validated against `normalizeParams` (per AGENTS.md strategy-lib contract).

## Performance

| Phase | Cold run | Warm run (cache populated) |
|---|---|---|
| Enumerate pairs | <1 s | <1 s |
| Worker backtest (124,750 pairs, 24 workers) | ~30–60 min | <5 min (synthetic-pair cache hits) |
| Write compact artifacts | ~30 s (250 MB, sequential writes) | ~30 s |
| Replay engine | ~30–120 s (event-volume dependent) | same |
| **Total** | **~30–60 min** | **<10 min** |

**Bottlenecks**:
1. **Vite dev-server HTTP bottleneck (biggest threat).** 24 workers each fetching thousands of CSVs through `fetchLocalApi` → `http://127.0.0.1:5173/price-data/ibkr/csv/30m/*.csv` queue on Vite's single main thread. The auditor flagged this correctly as the dominant risk to the 30–60 min estimate. **Phase 6 smoke MUST measure per-CSV fetch latency under 24-worker contention** before deciding whether to optimize.
2. Cold synthetic-pair builds (each pair parses two 30m legs + ratio + aggregate to 4H). Mitigated by persistent disk cache after first run.
3. Replay engine Phase 2 (`events: DecisionEvent[]` with per-event snapshots). Acceptable on 64 GB; flagged via startup heap check.
4. Per-worker leg-cache thrash (24 workers each parse 500 legs once). OS file cache absorbs the raw CSV bytes (~12 GB fits in 64 GB RAM); parsed in-memory representation is duplicated per worker but bounded by `SyntheticLegCache` LRU.

**If the HTTP bottleneck dominates (decision tree, Phase 6 smoke)**:
- **Option A (default, v1)**: accept it. The synthetic-pair disk cache absorbs most of the cost on warm runs, and HTTP serves only the raw 30m legs (~70 unique files for the current 70-asset universe, ~4 MB each). On cold runs the contention is real but bounded.
- **Option B (only if smoke shows HTTP-dominated wallclock)**: add an **env-gated disk-fast-path inside `lib/candle-cache.ts` `loadLocalDailyDatasetCandles`** (around `:435-443`) that, when `process.env.SF_LOCAL_DATA_DISK_FASTPATH === "1"`, resolves the `/price-data/...` URL to a project-relative path and uses `fs.readFileSync` instead of `fetchLocalApi`. This keeps a single code path for all consumers (preserves loader parity — AGENTS.md F8) and is opt-in via env so existing paths are unaffected. **Rejected alternative: workers call `fs.readFileSync` directly.** That forks the synthetic-pair pipeline and recreates exactly the parity drift AGENTS.md warns against.

**Explicit non-optimizations** (deferred unless profiling proves them necessary):
- Shared leg preload across workers (would need `SharedArrayBuffer` or a feeder process).
- Pre-aggregated 4H legs (forbidden by AGENTS.md: ratio must be computed at 30m seed interval, then aggregated — never the other way around).
- Parallel replay engine (would require engine surgery; out of scope).
- Workers reading CSVs from disk via a forked pipeline (rejected above — loader-parity violation).

## Failure handling and edge cases

| Failure | Handling |
|---|---|
| Dev server not running | Startup probe `GET <vite-origin>/price-data/ibkr/csv/30m/AAPL.csv`; exit with clear message |
| Asset catalog unreadable / missing | Exit with the catalog path that was tried |
| Worker crashes mid-shard | Pool returns `{ ok: false, reason }`, shard marked `failed` in manifest, coordinator continues with next shard; re-run retries `failed` shards |
| Per-pair load fails (`load_failed`) | Logged, pair counted as failed, shard continues; replay engine handles missing pairs gracefully (it omits them, see `:424-427`) |
| Per-pair backtest throws (`run_failed`) | Same as load fail |
| Compact artifact write fails (disk full) | Shard marked `failed`; coordinator aborts that shard but continues others |
| Resume fingerprint mismatch | Hard exit; user must pick a fresh `--run-id` |
| Replay engine `OMITTED_PAIRS` > 50% | Surface as a warning in stdout + JSON; let the user decide whether to trust the result |
| Process killed (Ctrl-C) | SIGINT handler sets shutdown flag, calls `worker.terminate()` on every active worker, `unlink`s the in-flight partial artifact file, flushes the current shard's manifest entry to `failed`/`pending` via atomic temp-+-rename; existing `done` shards preserved for resume. Exit non-zero. |
| Strategy key not in manifest | Worker logs and exits; coordinator catches and marks shard `failed` |
| Config JSON malformed | Exit with parse error + line number |

### Edge case: zero-trade pairs

A pair with no trades produces a compact artifact with `trades: []`. The replay engine already handles this (`batch-open-score-usd-replay-engine.ts:431-434`: empty-trades pairs are counted in `omittedPairs` and skipped). No special handling needed.

### Edge case: `end_of_data` exit reason

Trades still open at the dataset end have `exitReason: "end_of_data"`. The replay engine treats these as still-open positions (no exit delta emitted, `:447`). The compact artifact must preserve `exitReason` exactly — verified in the round-trip test.

## Rollback strategy

**Feature-flagged by file presence.** The CLI is invoked only when the user runs `npm run sp500:top-mean`. Deleting the new files + removing the `package.json` script + removing the UI button is a complete rollback. No migrations to undo, no server state to clear.

**Extraction rollback** (D2): if extracting `worker-bundle.ts` destabilizes the stability pool, revert `batch-stability-parallel.ts` to its pre-extraction state. The extraction is a pure move; reverting is mechanical. The regression gate is `tests/batch-stability-parallel.spec.ts`.

**Disk cleanup**: `rm -rf ./artifacts/sp500-top-mean/<run-id>/` removes a run entirely. The synthetic-pair disk cache under `./price-data/synthetic-cache/` can be cleared independently (existing eviction logic in `synthetic-pair-disk-cache.ts:519` handles it).

## Implementation phases

Each phase ends with explicit validation. No phase depends on a later phase.

---

### Phase 1 — Compact artifact format (leaf, no dependencies)

**Objective**: Stand up the on-disk format and prove the replay engine consumes it.

**Scope**:
- New: `lib/batch-backtest/compact-pair-artifact.ts`
- New: `tests/compact-pair-artifact.spec.ts`

**Technical tasks**:
1. Define `CompactPairArtifact` interface (4 trade fields + asset metadata).
2. `writeCompactPairArtifact(path, art)` — v8-serialize + `writeFile`.
3. `readCompactPairArtifact(path)` — `readFile` + v8-deserialize.
4. Round-trip test: write a fixture with long + short trades, mixed `exitReason`s, read back, assert all fields preserved.
5. Adapter test: feed compact artifacts (wrapped in empty `data`/`signals` + `result.trades`) into `runOpenScoreUsdReplay` and confirm it produces the same reportLines as feeding full artifacts.

**Dependencies**: none.

**Risks / blockers**: none identified — v8 serialize is already used for this exact purpose in `batch-backtest-vite-plugin.ts:408`.

**Deliverables**: leaf module + passing spec.

**Validation**: `..\..\..\node_modules\.bin\esno tests\compact-pair-artifact.spec.ts` passes; `npm run typecheck` clean.

**Exit criteria**: adapter test confirms the engine produces identical output regardless of whether it's fed full or compact artifacts.

---

### Phase 2 — S&P 500 pair enumerator (leaf, no dependencies)

**Objective**: Deterministically produce the canonical 124,750-pair list from the catalog.

**Scope**:
- New: `lib/batch-backtest/sp500-pair-enumerator.ts`
- New: `tests/sp500-pair-enumerator.spec.ts`

**Technical tasks**:
1. Read the S&P 500 catalog CSV at `price-data/sp500_comprehensive_dataset/sp500_comprehensive/sp500_company_info.csv` (catalog URL configured at `lib/local-daily-datasets.ts:112-118`).
2. Extract asset symbols, apply the IBKR `•` bullet suffix (`IBKR_SYMBOL_SUFFIX = "\u2022"`, `lib/local-daily-datasets.ts:18`).
3. Sort canonical asset list deterministically (lexicographic on stripped symbol).
4. Generate all `BASE+QUOTE` combinations where `BASE < QUOTE` lexicographically — emit each unordered pair once, in `BASE+QUOTE` orientation. Total = `N*(N-1)/2`.
5. Use `parseSyntheticPairToken` (`lib/synthetic-pair-token.ts:48`) to validate each emitted token round-trips to the expected `(baseAsset, quoteAsset)`.

**Dependencies**: Phase 1 not strictly required, but order helps.

**Risks / blockers**:
- Catalog CSV may have header changes or stale symbols — read it defensively.
- Some S&P 500 symbols may not have IBKR CSVs on disk; this is fine (those pairs become `load_failed` at backtest time), but the enumerator should not filter them out (the catalog is the source of truth).

**Deliverables**: leaf module + passing spec.

**Validation**: spec asserts `count === N*(N-1)/2`, no duplicates, both orientations of any pair do not both appear, deterministic across runs.

**Exit criteria**: with the real catalog, count is exactly 124,750 (or whatever the current catalog size implies — log it).

---

### Phase 3 — Extract worker-bundle scaffolding (refactor, must not regress stability)

**Objective**: Make the esbuild-bundle-once / content-addressed-cache helpers reusable.

**Scope**:
- New: `lib/batch-backtest/worker-bundle.ts`
- Modified: `lib/batch-backtest/batch-stability-parallel.ts` (imports from the new leaf)
- New: `tests/worker-bundle-extract.spec.ts`

**Technical tasks**:
1. Move `bundleWorkerWithEsbuild` (`:348`), `computeDependencyHash` (`:433`), `sweepStaleWorkerBundles` (`:324`), `workerBundleRoot` (`:314`) verbatim to `worker-bundle.ts`. Rename to non-stability-specific (`bundleWorker`, etc.).
2. Keep `resolveWorkerPath` (`:276`) and `locateWorkerSource` (`:296`) in `batch-stability-parallel.ts` — these are stability-specific (they point at `batch-stability-worker.ts`).
3. Update `batch-stability-parallel.ts` to import from `./worker-bundle`.
4. Regression test: hash a fixed worker input with both old (inlined) and new (extracted) code paths and assert identical hashes.

**Dependencies**: none.

**Risks / blockers**:
- esbuild import is dynamic (`await import("esbuild")`) inside the current code — preserve that, do not make it static (would break consumers that don't have esbuild installed at module load).
- `MODULE_BUNDLE_HASH_VERSION = "v1"` (`:265` equivalent) must move with `computeDependencyHash` — same version or hashes drift.

**Deliverables**: extracted leaf + spec + stability-parallel still passing unchanged.

**Validation**: `..\..\..\node_modules\.bin\esno tests\batch-stability-parallel.spec.ts` passes (the load-bearing regression gate). `npm run typecheck` clean.

**Exit criteria**: stability-parallel behavior is byte-identical before and after extraction.

---

### Phase 4 — Worker body (Node-only, depends on Phase 1)

**Objective**: Per-shard worker that backtests its pairs and emits compact results. Must produce trades **byte-identical to the server `/run` path** so the OPEN_SCORE results are directly comparable.

**Scope**:
- New: `lib/batch-backtest/batch-runner-worker.ts`
- New: `tests/batch-runner-worker.spec.ts` (parity test — load-bearing)

**Critical: the per-pair execution pipeline must mirror `batch-backtest-runner.ts:184-189, 297-321` exactly.** Calling `runBacktestCompact` directly with raw settings is WRONG — it skips `resolveExecutorBacktestSettings`, `resolveCapitalSettingsFromRaw`, `normalizeParams` (via `executeBacktest`), `selectClosedCandleData`, signal merge, and the compact-path selector. The worker MUST call `executeBacktest` with pre-resolved settings/capital, the same way the batch runner does.

**Technical tasks**:
1. workerData: `{ shardPairs: string[], interval, strategyKey, strategyParams, backtestSettings, capitalSettings, viteOrigin, seed, contextFlags }`. `contextFlags` carries `{ engineMode: "auto", useRustEnginePreference: false }` (workers always use the TypeScript engine — Rust is a separate HTTP server, not worker-safe; setting `useRustEnginePreference: false` matches the default).
2. At worker start: `process.env.VITE_DEV_SERVER_ORIGIN = viteOrigin` (read by `lib/local-api-transport.ts`).
3. **Pre-resolve once per worker** (matches `batch-backtest-runner.ts:184-189`):
   ```ts
   const preResolvedSettings = resolveExecutorBacktestSettings(
     { ...(backtestSettings as Record<string, unknown>), interval } as BacktestSettings,
     interval,
   );
   await ensureConfirmationStrategiesLoaded(preResolvedSettings);
   const preResolvedCapital = resolveCapitalSettingsFromRaw(capitalSettings as Record<string, unknown>);
   ```
4. `loadStrategy(strategyKey)` via `manifest-loaders.builtInStrategyLoaders[key]()` — dynamic import (Node-safe; `manifest-loaders.ts:1` is type-only). Call `strategy.normalizeParams?.(strategyParams)` defensively before passing into `executeBacktest` (executeBacktest also normalizes, but doing it once per shard rather than per pair is consistent with how Finder universe threads normalized params; note the server runner relies on executeBacktest's internal normalization).
5. Construct `createBatchDatasetLoaderCore(...)` with the same options the server loader uses (`server-batch-data-loader.ts`). This satisfies loader parity (AGENTS.md F8/§"Loader parity").
6. **Per pair** (mirror `batch-backtest-runner.ts:297-321`):
   ```ts
   const data = await loadDataset(pairSymbol, interval, abortSignal);
   const output = await executeBacktest({
     ohlcvData: data,
     interval,
     primarySymbol: pairSymbol,
     strategyKey,
     strategy,
     strategyParams,
     backtestSettings,
     capitalSettings,
     preResolvedSettings,
     preResolvedCapital,
     context: {
       blockRange: null,
       annotatePolymarket: false,
       engineMode: "auto",
       useRustEnginePreference: false,   // workers run TS engine
       nowSec: <same definition as runner>,
     },
     backtestRunOptions: {
       includeAdvancedAnalytics: false,
       omitEquityCurve: true,
       skipDrawdown: false,
       skipResultPostProcessing: true,
     },
   });
   ```
7. Reduce each `Trade` in `output.result.trades` to the 4-field compact subset (`type, entryTime, exitTime, exitReason`).
8. `parentPort.postMessage({ symbol, ok: true, baseAsset, quoteAsset, baseSymbol, quoteSymbol, trades })` per pair, streamed (not buffered) so the parent can write with backpressure.
9. On any per-pair failure: `postMessage({ symbol, ok: false, status: "load_failed" | "run_failed", error })`.
10. Stay on the leaf-only import diet (per `batch-stability-worker.ts:20-24`); avoid `lib/finder-manager.ts`, `lib/data-manager.ts`, `lib/chart-manager.ts`, `lib/ui-manager.ts`, `lib/settings-manager.ts`, and `lib/constants.ts` (the main root).
11. **Honour `workerData` SIGINT/terminate semantics**: the worker should periodically (e.g. every 25 pairs, matching `batch-open-score-usd-replay-engine.ts:457`) check a cancellation flag from `parentPort` listeners and exit cleanly. Pair-level atomicity is the parent's responsibility (see Phase 5/6 SIGINT handling).

**Dependencies**: Phase 1 (compact type), uses `executeBacktest` + `resolveExecutorBacktestSettings` + `resolveCapitalSettingsFromRaw` from `lib/backtest-executor.ts` + `lib/backtest-capital-settings.ts`.

**Risks / blockers**:
- Node-safety of `executeBacktest`/`runBacktestCompact`: verified by static audit of the transitive import graph (no `lightweight-charts` runtime, no DOM, no manager modules reached). The existing `batch-stability-worker.ts` only proves the import graph is Node-loadable — it does NOT prove that executing a full backtest in a worker matches a server `/run` call. **The Phase 4 parity test is the load-bearing gate** — it runs the same pair through both the worker path and an inline server-shape call and asserts byte-identical compact trades.
- Strategy lib files must not have grown new browser-bound imports since the audit; the parity test will catch this at first run.
- `ensureConfirmationStrategiesLoaded` may load additional strategies — confirm this path stays Node-safe (it uses `manifest-loaders`, which is dynamic). The parity test exercises it.

**Deliverables**: worker module + parity spec.

**Validation — the parity test is load-bearing**:
1. Pick a 10-pair fixture (use a known IBKR-backed pair subset; do NOT use Binance test data — IBKR synthetic-pair path must be exercised).
2. Run each pair through TWO paths in the same test process:
   - **Reference path**: inline `executeBacktest(...)` call with the same args the worker uses (i.e. a direct in-process replay of the server `/run` per-pair call).
   - **Worker path**: `workerData` with the same 10 pairs → real `worker_threads` worker → collect `parentPort` messages.
3. Assert: for each pair, the compact trades from both paths are DEEP EQUAL (same count, same `{type, entryTime, exitTime, exitReason}` per trade, same order). Any mismatch blocks Phase 5.
4. Also assert: a pair that has no trades in the reference path has no trades in the worker path.
5. `npm run typecheck` clean.

**Exit criteria**: worker produces trades byte-identical to the inline `executeBacktest` path on the 10-pair fixture, for at least one long-short-neutral strategy. Document which strategy the parity test locks, and re-run with a second strategy if time permits.

---

### Phase 5 — Worker pool orchestrator (depends on Phases 3 + 4)

**Objective**: Spawn N workers, hand each a shard, merge results, fall back gracefully.

**Scope**:
- New: `lib/batch-backtest/batch-runner-worker-pool.ts`
- New: `tests/batch-runner-worker-pool.spec.ts`

**Technical tasks**:
1. `runBatchOverWorkers({ shards, workerCount, interval, strategyKey, strategyParams, backtestSettings, capitalSettings, viteOrigin, onPairResult, isCancelled })`.
2. Resolve worker path via `bundleWorker(...)` (from Phase 3) — content-addressed bundle of `batch-runner-worker.ts`.
3. Spawn `workerCount` workers, each consuming shards from a shared queue.
4. Each `worker.on("message")` calls `onPairResult(result)` for streaming to disk with backpressure.
5. Per-worker 5-min timeout, cancellation via 250ms poll (mirror `batch-stability-parallel.ts:562, 619`).
6. On worker error: return `{ ok: false, reason }` typed outcome (mirror `:502`).
7. Pool-level retry: a failed worker's remaining pairs are re-queued to a surviving worker (bounded retry count).

**Dependencies**: Phase 3 (`bundleWorker`), Phase 4 (worker entry point).

**Risks / blockers**:
- worker_threads structured-clone cost for `workerData` is bounded (shard pair list is ~50 KB of strings) — fine.
- Pool must not lose pairs on worker failure. The retry queue + per-pair `postMessage` semantics make this verifiable in the spec.

**Deliverables**: pool module + spec covering happy path, single-worker failure, all-workers failure, and cancellation.

**Validation**: spec asserts: (a) all pairs emitted in happy path; (b) failed worker's pairs eventually emitted by survivors; (c) `{ ok: false }` returned when all workers fail; (d) cancellation stops the pool within ~500 ms.

**Exit criteria**: pool handles every failure mode in the spec without losing or duplicating pairs.

---

### Phase 6 — CLI coordinator skeleton (depends on Phases 1, 2, 5)

**Objective**: Working end-to-end backtest pipeline writing compact artifacts, without replay wiring yet.

**Scope**:
- New: `scripts/sp500-top-mean.ts` (initial version: enumerate → shard → dispatch → write artifacts → manifest)
- Modified: `package.json` (add `sp500:top-mean` script)

**Technical tasks**:
1. Parse CLI args (`--config`, `--run-id`, `--resume`, `--workers`, `--shard-size`, `--pair-cache-max-bytes`, `--pair-cache-max-files`, `--max-pairs`, `--vite-origin`).
2. Read config JSON, compute `configFingerprint` (FNV-1a-64 hash, matching `batch-run-contract.ts:55-65` style).
3. Probe dev server (`GET <vite-origin>/price-data/ibkr/csv/30m/AAPL.csv`); exit clear if unreachable.
4. Enumerate pairs, apply `--max-pairs` cap if given.
5. **Pre-flight disk-availability check (load-bearing, do not skip)**: cross-reference the catalog's asset symbols against the IBKR CSVs actually on disk under `price-data/ibkr/csv/30m/`. Compute `diskAvailableAssets` and `diskAvailablePairs` (= `diskAvailableAssets × (diskAvailableAssets − 1) / 2`). Print both counts and the coverage percentage at startup BEFORE spawning workers. If `diskAvailablePairs / totalPairs < 0.5` (configurable via `--min-disk-coverage`), REFUSE to start unless `--force` is passed. Today, with only 70 CSVs on disk, `diskAvailablePairs ≈ 2,415` and the run will refuse by default — surfacing the data-sync gap before wasting worker startup. This check exists because the catalog (500 assets) is the source of truth for what *should* exist, but the CSVs on disk are the source of truth for what *can* be backtested.
6. Shard into `--shard-size` chunks.
6. Open or create `./artifacts/sp500-top-mean/<run-id>/manifest.json`. If `--resume`, load existing manifest, validate fingerprint match, skip `done` shards.
7. For each pending shard: dispatch to pool, stream per-pair results to `<run-id>/NNNNNN.bin`, mark shard `done` in manifest (atomic rewrite via temp + rename).
8. SIGINT / `uncaughtException` handler (mirror pattern from `batch-stability-parallel.ts:562` cancellation poll, but synchronous on signal):
   - Set a global `shuttingDown = true` flag so the worker pool stops dispatching new shards.
   - Call `worker.terminate()` on every active worker (workers cannot catch SIGINT themselves reliably; terminate prevents orphaned backtests from continuing in the background after the parent exits).
   - `unlink` any partial compact-artifact file the parent was mid-write (track the current in-flight `writeCompactPairArtifact` path; if the write didn't complete, remove it).
   - Flush the current shard's manifest entry to `failed` (or `pending` if no pairs were emitted yet) via the same atomic temp-+-rename pattern used for normal writes.
   - Exit with non-zero code so an outer scheduler can detect the interrupt.
   - Partial output from already-`done` shards is preserved (resume handles re-runs).
9. Heap check: warn if `pairCount > 50_000` and `--max-old-space-size` < 32 GB.

**Dependencies**: Phases 1, 2, 5.

**Risks / blockers**:
- Atomic manifest rewrite must survive crash mid-write — temp file + `rename` is the standard pattern, already used for worker bundles in Phase 3.
- File-handle exhaustion: 124k sequential writes are fine; do NOT open all handles at once.

**Deliverables**: working CLI that takes a config + catalog and writes compact artifacts + manifest.

**Validation**: manual smoke — `npm run dev` in one terminal; `NODE_OPTIONS=--max-old-space-size=32768 npm run sp500:top-mean -- --max-pairs 200` in another. Verify artifacts + manifest on disk. Re-run with same `--run-id --resume` → all shards skipped.

**Exit criteria**: 200-pair subset produces 200 compact artifacts + a `done` manifest, resumable on re-run.

---

### Phase 7 — Replay wiring + ranking JSON (depends on Phase 6)

**Objective**: Drive the existing replay engine over the compact artifacts and emit the ranking.

**Scope**:
- Modified: `scripts/sp500-top-mean.ts` (append replay phase)

**Technical tasks**:
1. Build `artifactLoader()` async generator: yield each `<run-id>/NNNNNN.bin` via `readCompactPairArtifact`, wrapped into `BatchSyntheticPairArtifact` shape (empty `data`/`signals`, `result.trades` populated).
2. Build `targetLoader()` async generator: for each of 500 assets, load `•<SYMBOL>` IBKR 4H OHLCV via the same loader; yield `{ asset, symbol, data }` one at a time, release after consume.
3. Call `runOpenScoreUsdReplay(artifactLoader, targetLoader, { horizons, interval, slippageRate, commissionRate, blockCount, onPhase, shouldStop })`.
4. Print `reportLines.join("\n")` to stdout.
5. Write `sp500-top-mean-<run-id>.json` with `{ runId, configFingerprint, horizons, generatedAt, perAssetByArm: { TOP_MEAN: [...], TOP_RAW: [...], MAX_ACTIVE: [...], ... } }`. Mirror the per-asset breakdown the engine already produces (`AssetSelectionSummary`, `batch-open-score-usd-replay-engine.ts:90-97`).

**Dependencies**: Phase 6.

**Risks / blockers**:
- Engine memory at 124k pairs: `events: DecisionEvent[]` with per-event asset snapshots is the dominant consumer. Acceptable on 64 GB; startup heap check (Phase 6) warns early.
- `OMITTED_PAIRS` could be high if many pairs fail to load; surface as a warning so the user can decide.

**Deliverables**: full end-to-end pipeline producing the TOP_MEAN ranking.

**Validation**: 200-pair subset produces a report with at least one TOP_MEAN line + a parseable JSON. Spot-check a known pair's contribution by hand if feasible.

**Exit criteria**: report prints, JSON is valid, re-running with different `--horizons` consumes the existing artifacts (no re-backtest).

---

### Phase 8 — UI config bridge (independent of Phases 6–7; can ship without)

**Objective**: Let the user export the current Batch UI state as a coordinator config.

**Scope**:
- Modified: `lib/batch-backtest/batch-backtest-dom.ts` (new id)
- Modified: `html-partials/tab-batch-backtest.html` (new button)
- Modified: `lib/batch-backtest/batch-backtest-service.ts` (new `exportCliConfig()`)

**Technical tasks**:
1. Add `<button id="batch-backtest-export-cli-config-btn">Export CLI Config</button>` to the Batch tab partial.
2. Add the id to `batch-backtest-dom.ts` contract.
3. In `batch-backtest-service.ts`: bind click → build the same request shape already built for `/run` (strategy key, params, settings, capital, interval) → wrap as `sp500-top-mean-config.json` schema → trigger `Blob` + `URL.createObjectURL` + click download.

**Dependencies**: none at the code level; semantically depends on the coordinator's config schema being stable (Phase 6).

**Risks / blockers**:
- DOM contract drift — `feature-dom-contracts.spec.ts` is the gate.

**Deliverables**: one new button + handler + DOM contract row.

**Validation**: `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts` passes; manual click produces a JSON file the coordinator accepts.

**Exit criteria**: button downloads a config that `npm run sp500:top-mean -- --config <downloaded>` consumes without error.

---

### Phase 9 — Docs + package.json script (depends on all above)

**Objective**: Hook the feature into the existing docs maintenance flow.

**Scope**:
- Modified: `package.json` (script added in Phase 6; verify)
- Modified (after ship): `docs/batch-backtest-server-side.md` — add a "S&P 500 TOP_MEAN coordinator" section, or a pointer if it grows.
- Modified (after ship): `docs/synthetic-pairs.md` — note the `--pair-cache-max-{bytes,files}` override if relevant.
- Delete: this planning document (per the maintenance rule, once shipped).

**Technical tasks**:
1. Add `"sp500:top-mean": "esno scripts/sp500-top-mean.ts"` to `package.json` scripts.
2. Update `README.md` architecture map if a new top-level subsystem is introduced.
3. Update `AGENTS.md` "Validation habit" section with the new spec files if any contract here becomes load-bearing for future changes.

**Dependencies**: Phases 1–8.

**Risks / blockers**: none.

**Deliverables**: docs + script wired.

**Validation**: `npm run typecheck`; `npm run test`; manual `npm run sp500:top-mean -- --help` works.

**Exit criteria**: a new contributor can run the coordinator end-to-end using only repo docs.

---

## Assumptions, unknowns, and missing information

### Assumptions (verified during planning)

- The dev server (`npm run dev`) serves `/price-data/ibkr/csv/30m/*.csv` — verified by the existence of 70 files in that directory and the loader's use of `fetchLocalApi`.
- `lib/types/index.ts`'s runtime re-exports (`./finder`, `./scanner`, `./data-providers`) are all type-only or pure-const — verified; no DOM, no manager imports.
- `runBacktestCompact` is Node-worker-safe — verified transitively via the existing `batch-stability-worker.ts`, which loads `lib/strategies/index.ts` (which re-exports the engine).
- `manifest-loaders.ts` uses dynamic per-key imports — verified; it does NOT eager-load the strategy graph (unlike `library.ts`).

### Unknowns (to resolve during implementation)

- **Exact per-pair backtest time** on IBKR 4H data with the user's chosen strategy. The 30–60 min cold estimate assumes ~50–200 ms/pair × 124,750 / 24 workers. Phase 6's 200-pair smoke will give a real number to extrapolate from. If it's much higher, the runtime estimate needs revision and Layer 5 (Rust) re-enters the conversation.
- **Replay engine memory at 124k pairs.** The `events: DecisionEvent[]` growth is hard to predict without measurement. Phase 7 will measure on the 200-pair subset, then extrapolate. If it exceeds ~16 GB at 124k pairs, a streaming variant of the engine becomes necessary (out of scope for v1; would require engine surgery).
- **Synthetic-pair disk cache steady-state size.** ~60 GB is an estimate based on 5–10 MB per pair × 124k. Phase 6's smoke run will measure actual bytes-per-pair and refine the `--pair-cache-max-bytes` default.
- **How many of the 500 S&P 500 symbols actually have IBKR 30m CSVs on disk.** Only 70 files exist in `price-data/ibkr/csv/30m/` today. If only 70 assets are represented, the real pair count is 70 × 69 / 2 = 2,415 (not 124,750) — well under `BATCH_MAX_SYMBOLS`-shard count and a much smaller run. **Handled by the Phase 6 pre-flight disk-availability gate**: the coordinator refuses to start if disk-available pairs are < 50% of catalog pairs (overridable with `--force`). The user must sync more IBKR data (the gap is out of scope for this plan) before a full 124k run is meaningful. This is the single biggest reason a "full" run today would not actually be full.

### Missing information (to confirm with the user before Phase 6 smoke)

- Default `--horizons` value: assumed `12, 24, 48` (4H bars → 2-day, 4-day, 8-day forward windows). User may prefer different windows.
- Whether the S&P 500 catalog at `price-data/sp500_comprehensive_dataset/...` is the right asset universe, or if the `•`-marked IBKR set from `lib/local-daily-datasets.ts:131-140` is preferred.
- Acceptable wall-clock budget. If the cold-run estimate of 30–60 min is too long, the plan needs to revisit worker count or pre-aggregation strategies (without violating the 30m-seed rule).

## Validation summary

After all phases:

- `npm run typecheck` — clean
- `npm run typecheck:tests` — clean
- `npm run test` — all green, including new specs
- `..\..\..\node_modules\.bin\esno tests\batch-stability-parallel.spec.ts` — extraction (Phase 3) did not regress stability
- `..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-replay-engine.spec.ts` — engine works with compact-artifact adapter
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts` — UI button (Phase 8) contract holds
- Manual smoke (subset): `npm run dev` + `NODE_OPTIONS=--max-old-space-size=32768 npm run sp500:top-mean -- --max-pairs 200` → artifacts + manifest + replay report + JSON
- Manual smoke (resume): re-run with `--resume` → all shards skipped, replay re-runs off existing artifacts in seconds
- Manual smoke (full): on a weekend, full 124k run; capture wall-clock + peak heap; refine the estimates in this doc

## Appendix: audit findings and applied revisions

This plan was adversarially audited before shipping. The audit returned **SHIP-BLOCKED** with 11 of 12 falsifiable claims CONFIRMED, 1 FALSE, and 3 substantive hidden-dependency findings. Every finding was verified against the code independently (not by trusting the auditor's citations) and applied. Record kept so the next reader can trace why each section reads the way it does.

### Falsifiable claim results

| # | Claim | Audit | Verified independently | Revision |
|---|---|---|---|---|
| 1 | `BATCH_MAX_SYMBOLS = 2_000` enforced both sides | CONFIRMED | — | None needed |
| 2 | `runBatchBacktest` serial, one core, prefetch=4 | CONFIRMED | — | None needed |
| 3 | Replay reads exactly 4 trade fields | CONFIRMED | — | None needed (foundational to the compact format) |
| 4 | Field is `type` not `side`, values `"long"\|"short"` | CONFIRMED | — | None needed |
| 5 | `runBacktestCompact` exported and called by runner | CONFIRMED | — | None needed |
| 6 | Worker-safety argued via `batch-stability-worker.ts` | **FALSE** | Verified at `batch-stability-worker.ts:30-45` — worker imports `runPreparedBatchSyntheticStateMiner`, never calls any backtest | **Replaced** the safety argument in §"Node-worker safety" and Phase 4 risks: static audit + the Phase 4 parity test are the load-bearing proof, not the stability worker |
| 7 | `manifest-loaders.ts` dynamic vs `library.ts` eager | CONFIRMED | — | None needed |
| 8 | 4 stability helpers are module-private | CONFIRMED | — | None needed (Phase 3 extraction stands) |
| 9 | `tests/batch-stability-parallel.spec.ts` is the regression gate | CONFIRMED | — | None needed |
| 10 | Dev server required for IBKR CSV serving | CONFIRMED | — | None needed |
| 11 | Disk cache caps overridable via options | CONFIRMED | — | None needed |
| 12 | `runOpenScoreUsdReplay` is a pure function | CONFIRMED | — | None needed |

### Hidden-dependency findings — all applied

1. **Phase 4 was calling `runBacktestCompact` directly with raw settings** — this skips `resolveExecutorBacktestSettings`, `resolveCapitalSettingsFromRaw`, `normalizeParams`, `selectClosedCandleData`, and signal merge. Workers would produce different trades than `/run`. Verified the correct pipeline at `batch-backtest-runner.ts:184-189, 297-321`. **Applied**: Phase 4 now specifies `executeBacktest({...})` with `preResolvedSettings`/`preResolvedCapital` resolved once per worker, mirroring the batch runner exactly. Parity test made the load-bearing Phase 4 exit gate.

2. **HTTP bottleneck flagged as the biggest runtime threat.** Verified: `lib/candle-cache.ts:435-443` does read via `fetchLocalApi` → `http://127.0.0.1:5173`. 24 workers would queue on Vite's main thread. **Applied**: documented in Performance with a decision tree (Option A accept / Option B env-gated fast-path inside the existing loader). **Rejected the auditor's recommendation** to have workers `fs.readFileSync` directly — that forks the loader and violates parity (AGENTS.md F8 / §"Loader parity").

3. **SIGINT handler was hand-waved.** Workers cannot catch SIGINT reliably; without explicit `terminate()` they keep running after the parent exits. **Applied**: Phase 6 SIGINT section now specifies `worker.terminate()` on all active workers + `unlink` of the in-flight partial artifact + atomic manifest flush + non-zero exit.

### Promoted from "unknowns" to a load-bearing gate

- The 70-CSV-on-disk reality (catalog says 500 assets; only 70 CSVs exist today → real pair count is ~2,415, not 124,750) is now a **Phase 6 pre-flight disk-availability check** with `--min-disk-coverage` (default 50%) and `--force` override. The coordinator refuses to start a 24-worker run when 98% of pairs would fail to load, rather than burning worker startup on guaranteed failures.

### Optional improvements acknowledged, deferred

- **Compact-artifact schema version byte** (auditor optional). v8-serialize already preserves the TypeScript shape; if the format changes later, embed a `schema: "compact_pair_artifact.v1"` discriminator field on read. Not needed for v1; the round-trip test catches drift.
- **Enumerator pre-flight asset summary** (auditor optional). Folded into the Phase 6 pre-flight gate rather than the enumerator itself, since the gate needs both the catalog count AND the disk count to compute coverage.

### What was preserved (auditor's "strongest part")

The core reframe — OPEN_SCORE reads only `{type, entryTime, exitTime, exitReason}` per trade (verified at `batch-open-score-usd-replay-engine.ts:437-447`), so compact artifacts drop per-pair storage from ~7 MB to ~2 KB and total from ~870 GB to ~250 MB, while the unchanged engine consumes them via async-generator adapter — is the load-bearing insight of the plan and was not modified by any revision.
