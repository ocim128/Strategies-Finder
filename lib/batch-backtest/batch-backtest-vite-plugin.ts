/**
 * Vite dev-server plugin that hosts Batch Backtest execution in Node.
 *
 * Mirrors the IBKR sync plugin's structure (`lib/ibkr-data/ibkr-data-vite-plugin.ts`)
 * 1:1: an owner-generation lock, a factored `processRunBatch` core that takes
 * a `writer` callback (so it is testable without an HTTP response), a Stop
 * endpoint that force-bumps the lock, and a status endpoint that snapshots
 * in-progress state for browser reattach after a tab reload.
 *
 * Why server-side at all: 1000+ IBKR 4H synthetic pairs hold ~5–10 GB of
 * per-row artifacts (`data` + `signals` + `result.trades`) for the Mine
 * Timing step. That workload OOMs a browser tab; Node can use main RAM
 * directly. The browser tab keeps only rendered scalars and DOM rows.
 *
 * Memory contract: the plugin writes per-row Mine artifacts to a temp
 * directory until one of three release triggers fires:
 *   1. Successful Mine completion (after streaming `done`).
 *   2. A new Run starting (`POST /run` removes the prior artifact directory).
 *   3. A bounded TTL (default 10 minutes after the Run's `done` event with no
 *      Mine click) so a user who walks away doesn't leave ~5 GB pinned.
 *
 * The browser path got release (3) for free via tab reload; the server path
 * needs it explicitly.
 */

import type { Plugin } from "vite";
import { getHeapStatistics, deserialize, serialize } from "node:v8";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLogger } from "../debug-logger";
import { beginNdjsonStream, HttpStatusError, readJsonBody, sendCaughtErrorJson, sendJson, type ViteHttpResponse } from "../vite-http-utils";
import { mapWithConcurrencyLimit } from "../async-pool";
import { runBatchBacktest, type BatchBacktestRunInput, type BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { clearServerBatchDatasetCaches, getServerBatchDatasetCacheStats, loadServerBatchDataset } from "./server-batch-data-loader";
import {
    addStabilityVerdicts,
    clampInt,
    createStabilityAggregate,
    finalizeStabilityAggregate,
    sampleItems,
} from "./batch-stability-mine";
import {
    createBatchSyntheticMinerProfile,
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    runPreparedBatchSyntheticStateMiner,
    runBatchSyntheticStateMiner,
    resolveBatchSyntheticTargetSymbol,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "./batch-synthetic-state-miner";
import { parsePortfolioSyntheticPairSymbol } from "../portfolioLab/portfolio-lab-synthetic";
import { loadBuiltInStrategyByKey } from "../../strategyRegistry";
import type { BacktestSettings, Strategy, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import { toScalarRow, type BatchStreamEvent } from "./batch-backtest-stream-types";
import { setRuntimeLocalApiOrigin } from "../local-api-transport";
import { buildBatchRunFingerprint, normalizeBatchSymbols } from "./batch-run-contract";
import {
    fromCompactPairArtifact,
    isCompactPairArtifact,
    toCompactTargetArtifact,
    toCompactPairArtifact,
    type CompactPairArtifact,
} from "./batch-miner-artifact";
import {
    buildFileManifestStabilityRequest,
    RustMinerClient,
    rustMiner,
    type RustMinerFallbackReason,
    type RustMinerFileManifest,
    type RustStabilityMineResponse,
} from "./batch-rust-miner-client";
import {
    mergeStabilityAccumulators,
    runParallelStability,
    type ParallelStabilityOutcome,
} from "./batch-stability-parallel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Artifact retention after a Run's `done` event with no Mine click. */
const DEFAULT_ARTIFACT_RETENTION_MS = 10 * 60 * 1000;
const HEAP_MB = 1024 * 1024;
const LARGE_RUN_SYMBOL_THRESHOLD = 400;
const VERY_LARGE_RUN_SYMBOL_THRESHOLD = 800;
const LARGE_RUN_MIN_HEAP_MB = 8192;
const VERY_LARGE_RUN_MIN_HEAP_MB = 12288;

/**
 * Pagination cap for `GET /api/batch-backtest/status` row payloads. A tab that
 * reloads late into a 1000+ pair run would otherwise receive every accumulated
 * row in one JSON response (one large parse + DOM append burst). The browser
 * reattach loop drains pages via `nextOffset` until it sees `null`, so catch-up
 * latency is unchanged; each response stays bounded. Clamped to `[1, 1000]` so
 * a malformed `?limit=` cannot request an unbounded or empty page.
 */
const DEFAULT_STATUS_ROW_LIMIT = 250;
const MAX_STATUS_ROW_LIMIT = 1000;

/**
 * Phase 2 compact-artifact storage gate. When true, `storeMineArtifact`
 * converts the raw `BatchSyntheticPairArtifact` to the compact SoA shape
 * (`toCompactPairArtifact`) before writing to disk.
 *
 * DEFAULT IS FALSE. A real 448-pair / 4H benchmark (2026-07-08) showed that
 * converting at store time adds ~29M `localTimeKey` string allocations during
 * the Run phase (Run went 15.3s → 29.0s, +89%), and the compact→raw
 * reconversion at Mine load adds another ~1.4s (`artifactConversionMs`). On
 * the TS-only path (the only path that exists today — no Rust backend) that is
 * a net ~13s regression for zero benefit: the compact shape only pays off when
 * a Rust backend reads it via file-manifest handoff. The plan's own Phase 2
 * exit criterion is "artifact preparation time and heap usage do not regress";
 * this gate defaulted to true violated it.
 *
 * Toggle to true ONLY when a Rust miner backend is actually deployed and the
 * file-manifest handoff's lower transfer cost outweighs the store-time tax.
 * `loadStoredMineArtifact` handles both shapes transparently, so mixed
 * artifacts (e.g. across a toggle) still load correctly.
 */
const BATCH_MINER_COMPACT_ARTIFACTS_ENABLED_DEFAULT = false;
let BATCH_MINER_COMPACT_ARTIFACTS_ENABLED = BATCH_MINER_COMPACT_ARTIFACTS_ENABLED_DEFAULT;

/**
 * Phase 4 Rust miner routing gate. When true, `processStabilityMine` first
 * probes the Rust miner backend and routes to it when healthy + schema-
 * compatible + file-manifest-capable. On any fallback reason (unavailable,
 * schema mismatch, timeout, transport unsupported) it runs the TypeScript
 * sequential path and stamps `engine: "rust_fallback"` + the reason on the
 * result so the Phase 6 benchmark surfaces it.
 *
 * The gate is independent of `BATCH_MINER_COMPACT_ARTIFACTS_ENABLED` but
 * depends on it at runtime: Rust file-manifest handoff only works when the
 * stored artifacts are compact (the backend reads the compact shape). If
 * compact storage is off, the router skips Rust and falls straight through.
 */
const BATCH_MINER_RUST_ROUTING_ENABLED_DEFAULT = true;
let BATCH_MINER_RUST_ROUTING_ENABLED = BATCH_MINER_RUST_ROUTING_ENABLED_DEFAULT;

/**
 * Phase 3 parallel-Stability gate. When true AND Rust fell back, the server
 * plugin partitions the rerun range across Node worker_threads before falling
 * through to the sequential TypeScript loop. The worker path reads artifacts
 * (compact OR raw) from disk independently, so the structured-clone cost at
 * worker startup stays bounded regardless of pair count (plan §"Risks/Blockers").
 *
 * DEFAULT IS TRUE. The worker is bundled to `.js` on first use via esbuild
 * (see `resolveWorkerPath()` in `batch-stability-parallel.ts`), so Node
 * `worker_threads` can load it under `vite dev` without a TS-aware loader.
 * On any worker error (spawn failure, crash, timeout), the orchestrator
 * returns `ok: false` and the plugin falls back to the sequential TypeScript
 * loop, so a parallel-path bug never breaks Stability.
 *
 * Only engages when `reruns >= PARALLEL_STABILITY_MIN_RERUNS` (below that,
 * worker startup + merge overhead exceeds the parallelism win) and only on the
 * server-side path. The deterministic merge is parity-locked by
 * `tests/batch-stability-parallel.spec.ts`.
 */
const BATCH_MINER_PARALLEL_STABILITY_ENABLED_DEFAULT = true;
let BATCH_MINER_PARALLEL_STABILITY_ENABLED = BATCH_MINER_PARALLEL_STABILITY_ENABLED_DEFAULT;
const PARALLEL_STABILITY_MIN_RERUNS = 4;

// ---------------------------------------------------------------------------
// Module-scope state — single in-flight run per dev server (single-owner model)
// ---------------------------------------------------------------------------

/**
 * Rust miner client holder. Defaults to the singleton; tests swap it via
 * `__testInternals.setRustMinerClientForTests(...)` to inject a mock without
 * touching the real network. Production code never mutates this.
 */
let rustMinerClient: RustMinerClient = rustMiner;

const RUN_OWNER_NONE = 0;
let runOwner = RUN_OWNER_NONE;
let runOwnerGen = 0;
let minerOwner = RUN_OWNER_NONE;
let minerOwnerGen = 0;

let runState: BatchRunSnapshot | null = null;
let lastMineArtifacts: StoredMineArtifactMeta[] = [];
// In-memory cache of parsed artifacts keyed by file path. Stability Mine
// re-reads the same artifacts once per rerun (subsetSize * reruns reads for
// the same N artifacts); without this cache a 1000-pair / 50-rerun run does
// ~10,000 disk reads + JSON parses of multi-MB files. The cache is bounded
// by the artifact count and cleared in `releaseLastResults`, so steady-state
// heap footprint is unchanged.
//
// Phase 2: when `BATCH_MINER_COMPACT_ARTIFACTS_ENABLED`, the cache stores the
// on-disk compact shape (`CompactPairArtifact`), and `loadStoredMineArtifact`
// adapts compact -> raw on read. This keeps the compact shape (the smaller,
// GC-friendly one) resident across reruns and only pays the raw-reconstruction
// cost when the TypeScript miner actually runs.
const parsedArtifactCache = new Map<string, CompactPairArtifact | BatchSyntheticPairArtifact>();
let mineArtifactDir: string | null = null;
let lastRunFingerprint: string | null = null;
let lastRunInterval: string | null = null;
let lastRunStrategyKey: string | null = null;
let lastRunCacheStats: BatchDatasetCacheStats | null = null;
let abortController: AbortController | null = null;
// Abort controller for in-flight Mine / Stability Mine target dataset loads.
// Mirrors `abortController` (Run path): created when a Mine starts, aborted in
// `handleStopRequest`, nulled in the handlers' `finally`. The server-side
// `loadMinerTargets` forwards this signal to `loadServerBatchDataset`, which
// already accepts an optional AbortSignal — so Stop now cancels up to
// `TARGET_LOAD_CONCURRENCY` (=8) target loads that would otherwise keep
// running after the user clicks Stop.
let minerAbortController: AbortController | null = null;
let artifactReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let minerState: { running: boolean; startedAt: number; assets: number; pairs: number; verdicts: number; cancelled: boolean } | null = null;

export type BatchRunSnapshot = {
    startedAt: number;
    interval: string;
    strategyKey: string;
    total: number;
    completed: number;
    failed: number;
    currentSymbol: string | null;
    cancelled: boolean;
    rows: BatchBacktestSymbolResult[];
};

interface StoredMineArtifactMeta {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    baseSymbol?: string;
    quoteSymbol?: string;
    filePath: string;
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

function ensureMineArtifactDir(): string {
    if (!mineArtifactDir) {
        mineArtifactDir = mkdtempSync(join(tmpdir(), "strategies-finder-batch-mine-"));
    }
    return mineArtifactDir;
}

function storeMineArtifact(index: number, row: BatchBacktestSymbolResult): void {
    if (!row.result || !row.data || !row.signals) return;
    const parsed = parsePortfolioSyntheticPairSymbol(row.symbol);
    if (!parsed) return;

    const dir = ensureMineArtifactDir();
    // .bin extension reflects the v8-serialized format (see loadStoredMineArtifact).
    // The on-disk artifact is internal-only; no external reader consumes it.
    const filePath = join(dir, `${String(index).padStart(6, "0")}.bin`);
    const artifact: BatchSyntheticPairArtifact = {
        symbol: row.symbol,
        baseAsset: parsed.baseAsset,
        quoteAsset: parsed.quoteAsset,
        baseSymbol: parsed.baseSymbol,
        quoteSymbol: parsed.quoteSymbol,
        data: row.data,
        signals: row.signals,
        result: row.result,
    };
    // Phase 2: convert to the compact SoA shape before serializing when the
    // gate is on. v8.serialize preserves Float64Array / Uint8Array typed
    // arrays natively, so the compact artifact survives disk round-trip
    // without per-element bookkeeping. The raw shape remains available by
    // toggling BATCH_MINER_COMPACT_ARTIFACTS_ENABLED off.
    const stored: CompactPairArtifact | BatchSyntheticPairArtifact =
        BATCH_MINER_COMPACT_ARTIFACTS_ENABLED ? toCompactPairArtifact(artifact) : artifact;
    // v8 serialize is ~2-4x faster than JSON.stringify on numeric-heavy
    // OHLCV/trade payloads and produces smaller files. Paired with the parse
    // cache in loadStoredMineArtifact, Stability Mine no longer blocks on
    // (de)serialization for rerun subsets.
    writeFileSync(filePath, serialize(stored));
    parsedArtifactCache.set(filePath, stored);
    lastMineArtifacts[index] = {
        symbol: row.symbol,
        baseAsset: parsed.baseAsset,
        quoteAsset: parsed.quoteAsset,
        baseSymbol: parsed.baseSymbol,
        quoteSymbol: parsed.quoteSymbol,
        filePath,
    };
}

function loadStoredMineArtifact(meta: StoredMineArtifactMeta): BatchSyntheticPairArtifact {
    const cached = parsedArtifactCache.get(meta.filePath);
    if (cached) {
        // Cache may hold either shape; adapt compact -> raw on the fly.
        return isCompactPairArtifact(cached) ? fromCompactPairArtifact(cached) : cached;
    }
    const deserialized = deserialize(readFileSync(meta.filePath)) as CompactPairArtifact | BatchSyntheticPairArtifact;
    parsedArtifactCache.set(meta.filePath, deserialized);
    if (isCompactPairArtifact(deserialized)) {
        return fromCompactPairArtifact(deserialized);
    }
    // Legacy raw artifact (written before compact storage shipped, or when the
    // gate is toggled off). Return as-is.
    return deserialized;
}

function collectStoredMineArtifactMetas(): StoredMineArtifactMeta[] {
    return lastMineArtifacts.filter((meta): meta is StoredMineArtifactMeta => Boolean(meta));
}

function hasStoredMineArtifacts(): boolean {
    return collectStoredMineArtifactMetas().length > 0;
}

function clearArtifactReleaseTimer(): void {
    if (artifactReleaseTimer) {
        clearTimeout(artifactReleaseTimer);
        artifactReleaseTimer = null;
    }
}

/**
 * Release the per-row artifacts retained for Mine Timing. Mirrors the
 * browser-side post-Mine prune (commit 6401a53) plus the TTL defense-in-depth
 * the browser got for free via tab reload.
 *
 * Idempotent: safe to call when no artifacts are retained.
 */
function releaseLastResults(reason: string): void {
    clearArtifactReleaseTimer();
    const rows = lastMineArtifacts.length;
    if (rows === 0 && !mineArtifactDir) return;
    debugLogger.info("batch.server.artifacts_released", {
        reason,
        rows,
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
    lastMineArtifacts = [];
    parsedArtifactCache.clear();
    if (mineArtifactDir) {
        rmSync(mineArtifactDir, { recursive: true, force: true });
        mineArtifactDir = null;
    }
    lastRunFingerprint = null;
    lastRunInterval = null;
    lastRunStrategyKey = null;
    lastRunCacheStats = null;
    clearServerBatchDatasetCaches();
}

function scheduleArtifactTtl(): void {
    clearArtifactReleaseTimer();
    artifactReleaseTimer = setTimeout(() => {
        releaseLastResults("ttl_expired");
    }, DEFAULT_ARTIFACT_RETENTION_MS);
}

/**
 * Sweep orphaned Mine artifact directories left behind by a prior dev-server
 * process that crashed or was killed mid-Run (Ctrl-C, OOM, laptop reboot)
 * before `releaseLastResults` could fire. Each dir can hold up to ~5 GB of
 * artifacts on a 1000-pair IBKR 4H run, so without this sweep they
 * accumulate across crashes.
 *
 * Idempotent and safe to call at plugin registration. Only matches the
 * exact `mkdtempSync` prefix in `ensureMineArtifactDir`.
 */
function sweepOrphanedMineArtifactDirs(): void {
    let tmp: string;
    try {
        tmp = tmpdir();
    } catch {
        return;
    }
    let entries: string[];
    try {
        entries = readdirSync(tmp);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.startsWith("strategies-finder-batch-mine-")) continue;
        try {
            rmSync(join(tmp, entry), { recursive: true, force: true });
        } catch (error) {
            debugLogger.warn("batch.server.orphan_sweep_failed", {
                entry,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

function getV8HeapLimitMb(): number {
    return Math.floor(getHeapStatistics().heap_size_limit / HEAP_MB);
}

export function resolveServerBatchHeapWarning(symbolCount: number, heapLimitMb = getV8HeapLimitMb()): string | null {
    const normalizedCount = Math.max(0, Math.floor(Number.isFinite(symbolCount) ? symbolCount : 0));
    const normalizedHeap = Math.max(0, Math.floor(Number.isFinite(heapLimitMb) ? heapLimitMb : 0));
    const requiredHeapMb = normalizedCount >= VERY_LARGE_RUN_SYMBOL_THRESHOLD
        ? VERY_LARGE_RUN_MIN_HEAP_MB
        : normalizedCount >= LARGE_RUN_SYMBOL_THRESHOLD
            ? LARGE_RUN_MIN_HEAP_MB
            : 0;

    if (requiredHeapMb === 0 || normalizedHeap >= requiredHeapMb) {
        return null;
    }

    return [
        `Server-side Batch needs more Node heap for ${normalizedCount} symbols.`,
        `Current V8 heap limit is ~${normalizedHeap} MB; this run needs at least ${requiredHeapMb} MB.`,
        "Restart the app with run_playground.bat, or run: set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev",
    ].join(" ");
}

// ---------------------------------------------------------------------------
// Run + Miner core (factored out of the HTTP handlers for testability)
// ---------------------------------------------------------------------------

type StreamWriter = (event: BatchStreamEvent) => void;

/**
 * Core batch loop, factored out of the HTTP handler so it can be tested with a
 * stubbed loader and writer without spinning up Vite. Mirrors
 * `processSyncBatch` in the IBKR plugin.
 *
 * `owner` keys cancellation: the loop bails as soon as `runOwner !== owner`
 * (Stop force-bumped the lock or a newer run took it). The shared
 * `abortController` cancels in-flight dataset loads.
 */
export async function processRunBatch(
    input: BatchBacktestRunInput,
    writer: StreamWriter,
    owner: number,
): Promise<void> {
    const total = Math.max(1, input.symbols.length);

    runState = {
        startedAt: Date.now(),
        interval: input.interval,
        strategyKey: input.strategyKey,
        total,
        completed: 0,
        failed: 0,
        currentSymbol: null,
        cancelled: false,
        rows: [],
    };
    const snapshot = runState;
    const fingerprint = buildBatchRunFingerprint({
        symbols: input.symbols,
        strategyKey: input.strategyKey,
        strategyParams: input.strategyParams,
        backtestSettings: input.backtestSettings,
        capitalSettings: input.capitalSettings,
        interval: input.interval,
    });

    writer({ type: "start", total, interval: input.interval, strategyKey: input.strategyKey });

    const lostOwnership = () => runOwner !== owner;
    let cancelled = false;
    // Remember the last real percent emitted by `setProgress` so `setStatus`
    // (which the runner calls per-symbol with symbol-specific text like
    // `Backtesting ${symbol}...`) can preserve the bar instead of resetting it
    // to 0. Without this, every symbol visually snaps the bar back to 0 on the
    // server path because the runner calls setProgress then setStatus in the
    // same tick. The browser path's setStatus is label-only, so this asymmetry
    // only existed server-side.
    let lastPercent = 0;

    try {
        const output = await runBatchBacktest({ ...input, pruneResultArtifacts: true }, {
            setProgress: (percent, text) => {
                if (lostOwnership()) return;
                lastPercent = percent;
                writer({ type: "progress", percent, text, status: text });
            },
            setStatus: (text) => {
                if (lostOwnership()) return;
                writer({ type: "progress", percent: lastPercent, text, status: text });
            },
            onSymbolStart: (_index, symbol) => {
                if (lostOwnership()) return;
                if (runState === snapshot) {
                    snapshot.currentSymbol = symbol;
                }
            },
            onSymbolComplete: (index, result) => {
                if (lostOwnership()) return;
                const scalarRow = toScalarRow(result);
                if (runState === snapshot) {
                    snapshot.completed = index + 1;
                    snapshot.rows.push(scalarRow);
                }
                storeMineArtifact(index, result);
                writer({ type: "symbol", index, total, row: scalarRow });
            },
            isCancelled: () => {
                if (lostOwnership()) {
                    cancelled = true;
                    return true;
                }
                return false;
            },
        });

        if (lostOwnership()) {
            cancelled = true;
            if (runState === snapshot) snapshot.cancelled = true;
        }

        // Fill any rows the runner back-filled (cancelled tail); push them on
        // the wire so the browser sees the full row list.
        for (let i = 0; i < output.results.length; i += 1) {
            const row = output.results[i]!;
            if (runState === snapshot && snapshot.rows[i] === undefined) {
                snapshot.rows.push(toScalarRow(row));
            }
        }

        if (runState === snapshot) {
            snapshot.completed = output.results.length;
            snapshot.failed = output.failedSymbols.length;
            snapshot.currentSymbol = null;
            snapshot.cancelled = cancelled;
        }

        lastRunFingerprint = fingerprint;
        lastRunInterval = input.interval;
        lastRunStrategyKey = input.strategyKey;

        const artifactsAvailable = hasStoredMineArtifacts();
        const cacheStats = getServerBatchDatasetCacheStats();
        lastRunCacheStats = cacheStats;
        writer({
            type: "done",
            ok: output.failedSymbols.length === 0 && !cancelled,
            cancelled,
            interval: input.interval,
            totals: { loadedSymbols: output.loadedSymbols, failedSymbols: output.failedSymbols.length },
            summary: `Done — ${output.results.length} pairs${output.failedSymbols.length > 0 ? `, ${output.failedSymbols.length} failed` : ""}${cancelled ? ", cancelled" : ""}`,
            serverHasArtifacts: artifactsAvailable,
            fingerprint,
            cacheStats,
        });

        // Schedule the TTL release only if the run produced mineable
        // artifacts. Empty / fully-failed runs release immediately so the
        // server heap doesn't retain a placeholder.
        if (artifactsAvailable) {
            scheduleArtifactTtl();
        } else {
            releaseLastResults("run_no_artifacts");
        }
        debugLogger.event("batch.server.run.complete", {
            symbols: input.symbols.length,
            loadedSymbols: output.loadedSymbols,
            failedSymbols: output.failedSymbols.length,
            cancelled,
            artifacts: collectStoredMineArtifactMetas().length,
            durationMs: Date.now() - snapshot.startedAt,
            heapUsedMb: Math.round(process.memoryUsage().heapUsed / HEAP_MB),
            heapLimitMb: getV8HeapLimitMb(),
            interval: input.interval,
            strategyKey: input.strategyKey,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.run.fatal", { error: message });
        writer({ type: "fatal", error: message });
        releaseLastResults("run_fatal");
    } finally {
        abortController = null;
    }
}

function hasMineableArtifacts(rows: readonly BatchBacktestSymbolResult[]): boolean {
    return rows.some((row) => Boolean(row.result && row.data && row.signals && parsePortfolioSyntheticPairSymbol(row.symbol)));
}

// ---------------------------------------------------------------------------
// Miner core
// ---------------------------------------------------------------------------

export type MinerStreamWriter = (event: unknown) => void;

export async function processMine(
    fingerprint: string | null,
    interval: string | null,
    writer: MinerStreamWriter,
    owner: number,
): Promise<void> {
    const artifactMetas = collectStoredMineArtifactMetas();
    if (artifactMetas.length === 0) {
        writer({ type: "done", ok: true, cancelled: false, summary: "No completed synthetic pair artifacts to mine.", totals: { verdicts: 0 } });
        return;
    }
    if (!fingerprint || fingerprint !== lastRunFingerprint || !interval) {
        writer({ type: "fatal", error: "Rerun Batch before mining; settings or symbols changed." });
        return;
    }

    minerState = { running: true, startedAt: Date.now(), assets: 0, pairs: artifactMetas.length, verdicts: 0, cancelled: false };
    const snapshot = minerState;
    const lostOwnership = () => minerOwner !== owner;
    clearArtifactReleaseTimer();

    try {
        const targets = await loadMinerTargets(artifactMetas, interval, minerAbortController?.signal);
        snapshot.assets = targets.length;
        writer({ type: "start", assets: targets.length, pairs: artifactMetas.length });
        if (lostOwnership()) {
            snapshot.cancelled = true;
            snapshot.running = false;
            writer({ type: "done", ok: false, cancelled: true, summary: "Mining cancelled.", totals: { verdicts: 0 } });
            return;
        }
        if (targets.length === 0) {
            snapshot.running = false;
            writer({ type: "done", ok: true, cancelled: false, summary: "No target asset candles loaded.", totals: { verdicts: 0 } });
            return;
        }
        let verdictCount = 0;
        // Build a per-asset index once so the per-target link lookup is O(1)
        // instead of O(artifactMetas.length). On a 1000-pair / 80-asset run
        // this collapses ~80k string comparisons into ~2k during index build.
        const metasByAsset = new Map<string, StoredMineArtifactMeta[]>();
        for (const meta of artifactMetas) {
            for (const asset of [meta.baseAsset, meta.quoteAsset]) {
                const list = metasByAsset.get(asset);
                if (list) list.push(meta);
                else metasByAsset.set(asset, [meta]);
            }
        }
        for (const target of targets) {
            if (lostOwnership()) {
                snapshot.cancelled = true;
                writer({ type: "done", ok: false, cancelled: true, summary: "Mining cancelled.", totals: { verdicts: verdictCount } });
                return;
            }
            const linkedMetas = metasByAsset.get(target.asset) ?? [];
            const linkedArtifacts = linkedMetas.map(loadStoredMineArtifact);
            const result = runBatchSyntheticStateMiner({ interval, targets: [target], artifacts: linkedArtifacts });
            for (const verdict of result.verdicts) {
                if (lostOwnership()) {
                    snapshot.cancelled = true;
                    writer({ type: "done", ok: false, cancelled: true, summary: "Mining cancelled.", totals: { verdicts: verdictCount } });
                    return;
                }
                verdictCount += 1;
                snapshot.verdicts = verdictCount;
                writer({ type: "verdict", verdict });
            }
        }
        snapshot.running = false;
        writer({
            type: "done",
            ok: true,
            cancelled: false,
            summary: `Miner | Assets ${verdictCount}`,
            totals: { verdicts: verdictCount },
        });
        // Mine was the last consumer of the per-row artifacts. Release them.
        releaseLastResults("mine_completed");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.mine.fatal", { error: message });
        snapshot.running = false;
        writer({ type: "fatal", error: message });
    } finally {
        if (minerState === snapshot) {
            snapshot.running = false;
        }
        if (hasStoredMineArtifacts()) {
            scheduleArtifactTtl();
        }
    }
}

export async function processStabilityMine(
    fingerprint: string | null,
    interval: string | null,
    subsetSizeRaw: number,
    rerunsRaw: number,
    seedRaw: number,
    writer: MinerStreamWriter,
    owner: number,
    loadTargets: (pairArtifacts: readonly StoredMineArtifactMeta[], interval: string, signal?: AbortSignal) => Promise<BatchSyntheticTargetArtifact[]> = loadMinerTargets,
): Promise<void> {
    const artifactMetas = collectStoredMineArtifactMetas();
    if (artifactMetas.length === 0) {
        writer({ type: "fatal", error: "Run Batch before stability mining; no artifacts on server." });
        return;
    }
    if (!fingerprint || fingerprint !== lastRunFingerprint || !interval) {
        writer({ type: "fatal", error: "Rerun Batch before stability mining; settings or symbols changed." });
        return;
    }

    const subsetSize = clampInt(subsetSizeRaw, 200, 10, artifactMetas.length);
    const reruns = clampInt(rerunsRaw, 50, 1, 200);
    const seed = clampInt(seedRaw, 1, 1, Number.MAX_SAFE_INTEGER);
    minerState = { running: true, startedAt: Date.now(), assets: 0, pairs: artifactMetas.length, verdicts: 0, cancelled: false };
    const snapshot = minerState;
    const lostOwnership = () => minerOwner !== owner;
    clearArtifactReleaseTimer();

    const writeCancelled = () => {
        snapshot.cancelled = true;
        snapshot.running = false;
        writer({ type: "done", ok: false, cancelled: true, summary: "Stability mining cancelled." });
    };

    try {
        const targets = await loadTargets(artifactMetas, interval, minerAbortController?.signal);
        snapshot.assets = targets.length;
        if (lostOwnership()) {
            writeCancelled();
            return;
        }
        if (targets.length === 0) {
            writer({ type: "fatal", error: "No target asset candles loaded." });
            return;
        }

        // Phase 4: attempt the Rust miner backend first when both gates are on.
        // On success, the backend returns a finalized result (rows already
        // scored); stream a single progress + done and skip the TypeScript
        // rerun loop. On any fallback reason, fall through to TypeScript and
        // stamp the reason on the result so the benchmark can explain it.
        // Cancellation is preserved by checking ownership after the await.
        let rustFallback: { reason: RustMinerFallbackReason; message: string } | null = null;
        if (BATCH_MINER_RUST_ROUTING_ENABLED && BATCH_MINER_COMPACT_ARTIFACTS_ENABLED && !lostOwnership()) {
            const route = await tryRustStabilityMine({
                interval,
                targets,
                subsetSize,
                reruns,
                seed,
            });
            if (lostOwnership()) {
                writeCancelled();
                return;
            }
            if (route.ok) {
                const rustResult = route.result;
                // The backend returns the full BatchStabilityMineResult shape.
                // Surface engine + timings so the benchmark distinguishes Rust
                // from TypeScript end-to-end.
                rustResult.engine = "rust";
                rustResult.rustFallbackReason = null;
                // Surface Rust timings on the miner profile so the benchmark
                // can compare TS vs Rust end-to-end. The backend is expected to
                // populate `processingTimeMs`; if it omitted a minerProfile
                // entirely, attach a fresh one so the engine + timings are
                // always visible to the Phase 6 benchmark builder.
                if (!rustResult.minerProfile) {
                    rustResult.minerProfile = createBatchSyntheticMinerProfile();
                }
                rustResult.minerProfile.rustRequestMs = route.requestMs;
                rustResult.minerProfile.rustProcessingMs = rustResult.processingTimeMs;
                snapshot.verdicts = rustResult.hitEvents;
                writer({ type: "progress", run: reruns, reruns, hits: rustResult.hitEvents });
                snapshot.running = false;
                writer({ type: "done", ok: true, result: rustResult });
                // Rust was the last consumer of the per-row artifacts.
                releaseLastResults("mine_completed");
                return;
            }
            rustFallback = { reason: route.reason, message: route.message };
            debugLogger.info("batch.rust_miner.fallback_to_typescript", rustFallback);
        }

        // Phase 3: when Rust was unavailable AND the rerun count justifies it,
        // partition the rerun range across Node worker_threads. This is the
        // fallback acceleration path (plan §"Phase 3"). Each worker reads
        // artifact files (compact OR raw) from disk independently, so worker
        // startup cost stays bounded regardless of pair count. On any worker
        // failure, fall through to the sequential TypeScript loop (single
        // retry, per plan §"Failure Handling": "Worker crash: retry sequential
        // TS once"). NOTE: parallel is decoupled from the compact-storage
        // gate because workers handle both on-disk shapes; but it IS gated by
        // `BATCH_MINER_PARALLEL_STABILITY_ENABLED`, which defaults true after
        // the worker bundling/parity tests locked the loading story.
        if (
            BATCH_MINER_PARALLEL_STABILITY_ENABLED
            && reruns >= PARALLEL_STABILITY_MIN_RERUNS
            && !lostOwnership()
        ) {
            const parallelStartedAt = performance.now();
            const manifest = buildStabilityManifest();
            const parallelOutcome: ParallelStabilityOutcome = await runParallelStability({
                artifactFiles: manifest?.pairArtifactFiles ?? [],
                targets,
                interval,
                subsetSize,
                reruns,
                seed,
                isCancelled: () => lostOwnership(),
                onProgress: (completedReruns, totalReruns) => {
                    if (lostOwnership()) return;
                    // Hits are not aggregated until merge completes (each worker
                    // holds its own partial accumulator); emit 0 for in-flight
                    // progress and the real total on the final `done`.
                    writer({ type: "progress", run: completedReruns, reruns: totalReruns, hits: 0 });
                },
            });
            if (lostOwnership()) {
                writeCancelled();
                return;
            }
            if (parallelOutcome.ok) {
                const merged = mergeStabilityAccumulators(
                    parallelOutcome.result,
                    reruns,
                    subsetSize,
                    seed,
                    artifactMetas.length,
                    targets.length,
                );
                const parallelProfile = merged.profile;
                parallelProfile.parallelWorkerCount = parallelOutcome.workerCount;
                // Stamp the parallel-orchestration wall-clock onto the merged
                // profile so the benchmark can see worker startup + merge cost
                // separately from per-worker compute.
                parallelProfile.runPreparedMs += performance.now() - parallelStartedAt;
                const parallelResult = finalizeStabilityAggregate(merged.accumulator);
                parallelResult.minerProfile = parallelProfile;
                parallelResult.engine = "typescript_parallel";
                parallelResult.rustFallbackReason = rustFallback ? rustFallback.reason : null;
                snapshot.verdicts = parallelResult.hitEvents;
                writer({ type: "progress", run: reruns, reruns, hits: parallelResult.hitEvents });
                snapshot.running = false;
                writer({ type: "done", ok: true, result: parallelResult });
                releaseLastResults("mine_completed");
                return;
            }
            debugLogger.info("batch.parallel_stability.fallback_to_sequential", {
                reason: parallelOutcome.reason,
                message: parallelOutcome.message,
            });
        }

        const aggregate = createStabilityAggregate(reruns, subsetSize, seed, artifactMetas.length, targets.length);
        const minerProfile = createBatchSyntheticMinerProfile();
        let profileStartedAt = performance.now();
        const preparedTargets = prepareBatchSyntheticTargetArtifacts(targets);
        minerProfile.prepareTargetsMs += performance.now() - profileStartedAt;
        // Split the artifact load (compact->raw reconstruction when the gate
        // is on) from the prepare step (ATR/trade/signal index building) so
        // `artifactConversionMs` reports disk artifact load separately from
        // preparation. On raw artifacts this is v8 deserialize/cache time; on
        // compact artifacts it also includes compact->raw reconstruction.
        profileStartedAt = performance.now();
        const loadedPairs = artifactMetas.map(loadStoredMineArtifact);
        minerProfile.artifactConversionMs += performance.now() - profileStartedAt;
        profileStartedAt = performance.now();
        const preparedPairs = prepareBatchSyntheticPairArtifacts(loadedPairs);
        minerProfile.preparePairsMs += performance.now() - profileStartedAt;
        for (let runIndex = 0; runIndex < reruns; runIndex += 1) {
            if (lostOwnership()) {
                writeCancelled();
                return;
            }
            const subsetArtifacts = sampleItems(preparedPairs, subsetSize, seed + runIndex);
            const subsetAssets = new Set(subsetArtifacts.flatMap((artifact) => [artifact.baseAsset, artifact.quoteAsset]));
            profileStartedAt = performance.now();
            const subsetTargets = preparedTargets.filter((target) => subsetAssets.has(target.asset));
            minerProfile.subsetTargetFilterMs += performance.now() - profileStartedAt;
            const result = runPreparedBatchSyntheticStateMiner({
                interval,
                targets: subsetTargets,
                artifacts: subsetArtifacts,
                profile: minerProfile,
            });
            addStabilityVerdicts(aggregate, result.verdicts);
            snapshot.verdicts = aggregate.hitEvents;
            writer({ type: "progress", run: runIndex + 1, reruns, hits: aggregate.hitEvents });
        }

        const finalResult = finalizeStabilityAggregate(aggregate);
        finalResult.minerProfile = minerProfile;
        // Phase 6 engine reporting. If Rust was attempted and fell back, stamp
        // `rust_fallback` + the reason so the benchmark surfaces it; otherwise
        // this is a clean TypeScript run (Rust never attempted — gate off).
        finalResult.engine = rustFallback ? "rust_fallback" : "typescript";
        finalResult.rustFallbackReason = rustFallback ? rustFallback.reason : null;
        snapshot.running = false;
        writer({ type: "done", ok: true, result: finalResult });
    } catch (error) {
        if (lostOwnership()) {
            writeCancelled();
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.stability_mine.fatal", { error: message });
        snapshot.running = false;
        writer({ type: "fatal", error: message });
    } finally {
        if (minerState === snapshot) {
            snapshot.running = false;
        }
        if (hasStoredMineArtifacts()) {
            scheduleArtifactTtl();
        }
    }
}

async function loadMinerTargets(
    pairArtifacts: readonly StoredMineArtifactMeta[],
    interval: string,
    signal?: AbortSignal,
): Promise<BatchSyntheticTargetArtifact[]> {
    const assets = Array.from(new Set(
        pairArtifacts.flatMap((artifact) => [artifact.baseAsset, artifact.quoteAsset])
            .map((asset) => asset.trim().toUpperCase())
            .filter(Boolean)
    )).sort();
    const markedSymbolByAsset = new Map<string, string>();
    for (const artifact of pairArtifacts) {
        for (const [asset, symbol] of [
            [artifact.baseAsset, artifact.baseSymbol],
            [artifact.quoteAsset, artifact.quoteSymbol],
        ] as const) {
            const key = asset?.trim().toUpperCase();
            if (key && symbol && !markedSymbolByAsset.has(key)) {
                markedSymbolByAsset.set(key, symbol);
            }
        }
    }
    // Load target datasets with bounded concurrency, mirroring the browser
    // path (batch-backtest-service.ts loadMinerTargets). The previous serial
    // for...await serialized ~N asset loads; on 4H IBKR runs with ~80 unique
    // assets that was the dominant wall-clock cost of Mine. Capped at 8 in
    // flight so an 80-asset batch doesn't pin ~80 full datasets in memory at
    // the same instant. loadServerBatchDataset goes through the shared
    // legCache / pairCache LRU, which is concurrency-safe (promises are
    // deduped). Per-target errors are isolated so one failed asset does not
    // reject the batch. Results preserve input (asset-sorted) order.
    const TARGET_LOAD_CONCURRENCY = 8;
    const loaded = await mapWithConcurrencyLimit(
        assets,
        TARGET_LOAD_CONCURRENCY,
        async (asset): Promise<BatchSyntheticTargetArtifact | null> => {
            if (minerOwner === RUN_OWNER_NONE) return null;
            const symbol = markedSymbolByAsset.get(asset) ?? resolveBatchSyntheticTargetSymbol(asset);
            try {
                const data = await loadServerBatchDataset(symbol, interval, signal);
                if (Array.isArray(data) && data.length > 0) {
                    return { asset, symbol, data };
                }
                return null;
            } catch (error) {
                if (signal?.aborted || minerOwner === RUN_OWNER_NONE) {
                    return null;
                }
                debugLogger.warn("batch.server.mine.target_load_failed", {
                    asset, symbol,
                    error: error instanceof Error ? error.message : String(error),
                });
                return null;
            }
        },
    );
    return loaded.filter((entry): entry is BatchSyntheticTargetArtifact => entry !== null);
}

// ---------------------------------------------------------------------------
// Rust miner routing (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Outcome of a Rust Stability attempt. The router returns either the backend's
 * finalized result + timing, or a fallback reason the caller stamps onto the
 * TypeScript result so the Phase 6 benchmark can explain why Rust was not used.
 */
type RustStabilityRouteOutcome =
    | { ok: true; result: RustStabilityMineResponse; requestMs: number }
    | { ok: false; reason: RustMinerFallbackReason; message: string };

/**
 * Build the file-manifest envelope from the current stored artifacts + loaded
 * targets. Rust reads compact pair + target files directly from the server temp
 * directory (plan §"API And Contracts": preferred transport is file-manifest
 * handoff; only enable when the backend is local and trusted).
 */
function buildStabilityManifest(targets?: readonly BatchSyntheticTargetArtifact[]): RustMinerFileManifest | null {
    if (!mineArtifactDir) return null;
    const metas = collectStoredMineArtifactMetas();
    if (metas.length === 0) return null;
    const targetArtifactFiles = (targets ?? []).map((target, index) => {
        const filePath = join(mineArtifactDir!, `target-${String(index).padStart(4, "0")}.bin`);
        writeFileSync(filePath, serialize(toCompactTargetArtifact(target)));
        return filePath;
    });
    return {
        pairArtifactFiles: metas.map((meta) => meta.filePath),
        targetArtifactFiles,
        artifactDirectory: mineArtifactDir,
    };
}

/**
 * Attempt a Rust Stability Mine. Returns the backend result on success or a
 * structured fallback reason on any failure. Never throws — the caller routes
 * to TypeScript on `ok: false`.
 *
 * Pre-conditions (checked by the caller, not here):
 *   - `BATCH_MINER_RUST_ROUTING_ENABLED` is true
 *   - `BATCH_MINER_COMPACT_ARTIFACTS_ENABLED` is true (file-manifest handoff
 *     requires the compact on-disk shape)
 *   - artifacts are still retained (not TTL-released)
 */
async function tryRustStabilityMine(args: {
    interval: string;
    targets: BatchSyntheticTargetArtifact[];
    subsetSize: number;
    reruns: number;
    seed: number;
}): Promise<RustStabilityRouteOutcome> {
    const manifest = buildStabilityManifest(args.targets);
    if (!manifest) {
        return { ok: false, reason: "rust_unavailable", message: "no compact artifacts available for file-manifest handoff" };
    }
    const request = buildFileManifestStabilityRequest({
        interval: args.interval,
        // The Rust backend must reproduce TypeScript miner behavior, so pass
        // the default options (no partial overrides) — the backend applies the
        // same DEFAULT_OPTIONS the TypeScript miner resolves.
        options: {},
        manifest,
        targets: args.targets.map((target) => ({ asset: target.asset, symbol: target.symbol })),
        subsetSize: args.subsetSize,
        reruns: args.reruns,
        seed: args.seed,
    });
    const requestStartedAt = performance.now();
    const outcome = await rustMinerClient.runStabilityMine(request);
    const requestMs = performance.now() - requestStartedAt;
    if (!outcome.ok) {
        return { ok: false, reason: outcome.reason, message: outcome.message };
    }
    debugLogger.info("batch.rust_miner.stability_ok", {
        processingTimeMs: outcome.value.processingTimeMs,
        requestMs,
        rows: outcome.value.rows.length,
    });
    return { ok: true, result: outcome.value, requestMs };
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async function handleRunRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is already running. Use Stop first.");
    }
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "Mine Timing is currently running. Wait for it to finish before starting a new batch.");
    }

    const symbolsRaw = body.symbols;
    const symbols = normalizeBatchSymbols(symbolsRaw);
    if (symbols.length === 0) {
        throw new HttpStatusError(400, "At least one symbol is required.");
    }
    const heapWarning = resolveServerBatchHeapWarning(symbols.length);
    if (heapWarning) {
        throw new HttpStatusError(507, heapWarning);
    }
    const interval = String(body.interval ?? "").trim().toLowerCase();
    if (!interval) {
        throw new HttpStatusError(400, "interval is required.");
    }
    const strategyKey = String(body.strategyKey ?? "").trim();
    if (!strategyKey) {
        throw new HttpStatusError(400, "strategyKey is required.");
    }

    const strategy = await resolveStrategy(strategyKey);
    const strategyParams = (body.strategyParams ?? {}) as StrategyParams;
    const backtestSettings = (body.backtestSettings ?? {}) as BacktestSettings;
    const capitalSettings = (body.capitalSettings ?? {}) as CapitalSettings;
    const useRustEnginePreference = body.useRustEnginePreference === true;

    const owner = ++runOwnerGen;
    runOwner = owner;
    releaseLastResults("new_run");
    lastRunFingerprint = null;
    lastRunInterval = null;
    lastRunStrategyKey = null;
    lastRunCacheStats = null;
    abortController = new AbortController();

    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processRunBatch(
            {
                interval,
                strategyKey,
                strategy,
                strategyParams,
                backtestSettings,
                capitalSettings,
                symbols,
                useRustEnginePreference,
                loadDataset: (sym, intv, signal) => loadServerBatchDataset(sym, intv, signal),
            },
            (event) => stream!.write(event),
            owner,
        );
        stream.end();
    } catch (error) {
        if (!stream) throw error;
        const message = error instanceof Error ? error.message : String(error);
        try {
            stream.end({ type: "fatal", error: message });
        } catch {
            /* best-effort */
        }
    } finally {
        if (runOwner === owner) {
            runOwner = RUN_OWNER_NONE;
        }
        abortController = null;
    }
}

function rememberLocalApiOriginFromRequest(req: { headers?: Record<string, unknown> }): void {
    const hostHeader = req.headers?.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (typeof host !== "string" || !host.trim()) return;

    const protoHeader = req.headers?.["x-forwarded-proto"];
    const protoValue = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const proto = typeof protoValue === "string" && protoValue.split(",")[0]?.trim().toLowerCase() === "https"
        ? "https"
        : "http";
    setRuntimeLocalApiOrigin(`${proto}://${host.trim()}`);
}

async function handleStopRequest(): Promise<{ ok: boolean; stopped: boolean }> {
    // Force-reset both run and miner locks so a stuck/hung run can always be
    // recovered without a server restart. Mirrors IBKR sync's Stop semantics.
    if (abortController) {
        try {
            abortController.abort();
        } catch {
            /* best-effort */
        }
    }
    // Abort in-flight Mine / Stability Mine target loads so Stop is responsive
    // on large asset universes (up to TARGET_LOAD_CONCURRENCY=8 loads survive
    // Stop otherwise). Loads swallow AbortError via the per-target try/catch.
    if (minerAbortController) {
        try {
            minerAbortController.abort();
        } catch {
            /* best-effort */
        }
    }
    const runWasActive = runOwner !== RUN_OWNER_NONE;
    const minerWasActive = minerOwner !== RUN_OWNER_NONE;
    runOwner = RUN_OWNER_NONE;
    minerOwner = RUN_OWNER_NONE;
    return { ok: true, stopped: runWasActive || minerWasActive };
}

async function handleMineRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "Mine Timing is already running.");
    }
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is running. Use Stop first.");
    }
    if (!hasStoredMineArtifacts()) {
        throw new HttpStatusError(400, "Run Batch before mining; no artifacts on server.");
    }
    const owner = ++minerOwnerGen;
    minerOwner = owner;
    minerAbortController = new AbortController();

    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processMine(
            typeof body.fingerprint === "string" ? body.fingerprint : null,
            typeof body.interval === "string" ? body.interval : lastRunInterval,
            (event) => stream!.write(event),
            owner,
        );
        stream.end();
    } catch (error) {
        if (!stream) throw error;
        const message = error instanceof Error ? error.message : String(error);
        try {
            stream.end({ type: "fatal", error: message });
        } catch {
            /* best-effort */
        }
    } finally {
        if (minerOwner === owner) {
            minerOwner = RUN_OWNER_NONE;
        }
        if (minerState && minerOwner === RUN_OWNER_NONE) {
            minerState.running = false;
        }
        minerAbortController = null;
    }
}

async function handleStabilityMineRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "Mine Timing is already running.");
    }
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is running. Use Stop first.");
    }
    if (!hasStoredMineArtifacts()) {
        throw new HttpStatusError(400, "Run Batch before stability mining; no artifacts on server.");
    }
    const owner = ++minerOwnerGen;
    minerOwner = owner;
    minerAbortController = new AbortController();

    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processStabilityMine(
            typeof body.fingerprint === "string" ? body.fingerprint : null,
            typeof body.interval === "string" ? body.interval : lastRunInterval,
            Number(body.subsetSize),
            Number(body.reruns),
            Number(body.seed),
            (event) => stream!.write(event),
            owner,
        );
        stream.end();
    } catch (error) {
        if (!stream) throw error;
        const message = error instanceof Error ? error.message : String(error);
        try {
            stream.end({ type: "fatal", error: message });
        } catch {
            /* best-effort */
        }
    } finally {
        if (minerOwner === owner) {
            minerOwner = RUN_OWNER_NONE;
        }
        if (minerState && minerOwner === RUN_OWNER_NONE) {
            minerState.running = false;
        }
        minerAbortController = null;
    }
}

function handleStatusRequest(afterRow = 0, limitRaw?: number): unknown {
    const rowOffset = Math.max(0, Math.floor(Number.isFinite(afterRow) ? afterRow : 0));
    // Bound the page so a late-reattach tab never receives every accumulated
    // row in one response. Default to DEFAULT_STATUS_ROW_LIMIT; clamp a
    // caller-supplied limit to [1, MAX]. `rowCount` stays the TOTAL server row
    // count (not the slice length) so the browser can reconcile absolute index.
    const requestedLimit = Math.floor(Number.isFinite(limitRaw as number) ? (limitRaw as number) : DEFAULT_STATUS_ROW_LIMIT);
    const limit = Math.max(1, Math.min(MAX_STATUS_ROW_LIMIT, requestedLimit));
    const rowCount = runState?.rows.length ?? 0;
    const sliceEnd = Math.min(rowOffset + limit, rowCount);
    const rows = runState?.rows.slice(rowOffset, sliceEnd) ?? [];
    const nextOffset = sliceEnd < rowCount ? sliceEnd : null;
    return {
        ok: true,
        running: runState !== null && runOwner !== RUN_OWNER_NONE,
        run: runState && runOwner !== RUN_OWNER_NONE
            ? {
                startedAt: runState.startedAt,
                interval: runState.interval,
                strategyKey: runState.strategyKey,
                total: runState.total,
                completed: runState.completed,
                failed: runState.failed,
                currentSymbol: runState.currentSymbol,
                cancelled: runState.cancelled,
                rows,
                rowOffset,
                rowCount,
                nextOffset,
            }
            : null,
        lastRun: hasStoredMineArtifacts()
            ? {
                interval: lastRunInterval,
                strategyKey: lastRunStrategyKey,
                fingerprint: lastRunFingerprint,
                rowCount: collectStoredMineArtifactMetas().length,
                hasArtifacts: hasStoredMineArtifacts(),
                cacheStats: lastRunCacheStats,
            }
            : null,
        miner: minerState && minerOwner !== RUN_OWNER_NONE
            ? {
                running: true,
                startedAt: minerState.startedAt,
                assets: minerState.assets,
                pairs: minerState.pairs,
                verdicts: minerState.verdicts,
            }
            : null,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveStrategy(strategyKey: string): Promise<Strategy> {
    // Use `loadBuiltInStrategyByKey` (not `ensureBuiltInStrategyLoaded`) so the
    // strategy is registered into `strategyRegistry`, not just the catalog's
    // internal Map. The browser-side batch path gets this for free because the
    // strategy panel UI registers strategies into the registry on tab open;
    // the server-side path runs cold and the registry is empty, so we must
    // take the path that registers.
    const strategy = await loadBuiltInStrategyByKey(strategyKey);
    if (!strategy) {
        throw new HttpStatusError(400, `Strategy not loaded: ${strategyKey}`);
    }
    return strategy;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function batchBacktestVitePlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use("/api/batch-backtest/run", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleRunRequest(res as ViteHttpResponse, await readJsonBody(req));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/stop", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                const result = await handleStopRequest();
                sendJson(res, 200, result);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/mine", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleMineRequest(res as ViteHttpResponse, await readJsonBody(req));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/stability-mine", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleStabilityMineRequest(res as ViteHttpResponse, await readJsonBody(req));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/status", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            const parsedUrl = new URL(req.url ?? "/api/batch-backtest/status", "http://localhost");
            const after = Number(parsedUrl.searchParams.get("after") ?? 0);
            const limitParam = parsedUrl.searchParams.get("limit");
            const limit = limitParam === null ? undefined : Number(limitParam);
            sendJson(res, 200, handleStatusRequest(after, limit));
        });
    };

    return {
        name: "batch-backtest",
        configureServer(server) {
            sweepOrphanedMineArtifactDirs();
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            sweepOrphanedMineArtifactDirs();
            register(server.middlewares);
        },
    };
}

// Exported for tests only. `processRunBatch`, `processMine`, and
// `processStabilityMine` consult
// module-scope `runOwner` / `minerOwner` for cancellation, mirroring the IBKR
// sync pattern. The HTTP handlers set those before invoking the factored
// functions; tests need a way to do the same without spinning up Vite.
export const __testInternals = {
    releaseLastResults,
    hasMineableArtifacts,
    hasStoredMineArtifacts,
    DEFAULT_ARTIFACT_RETENTION_MS,
    handleStatusRequest,
    handleStopRequest,
    setRunOwnerForTests(owner: number): void {
        runOwner = owner;
        if (owner === RUN_OWNER_NONE) {
            runState = null;
        }
    },
    setMinerOwnerForTests(owner: number): void {
        minerOwner = owner;
    },
    /**
     * Set the Mine abort controller during tests. The HTTP handlers create it
     * (`minerAbortController = new AbortController()`), but tests that call
     * `processMine` / `processStabilityMine` directly bypass the handlers, so
     * they must install one to exercise the Stop-aborts-target-loads path.
     * Pass null to clear.
     */
    setMinerAbortControllerForTests(controller: AbortController | null): void {
        minerAbortController = controller;
    },
    getRunStateForTests(): BatchRunSnapshot | null {
        return runState;
    },
    /**
     * Swap the Rust miner client for a mock during tests. Pass the singleton
     * `rustMiner` (or call `resetRustMinerClientForTests()`) to restore. Used
     * by the Phase 4 mocked-routing tests to avoid touching the network.
     */
    setRustMinerClientForTests(client: RustMinerClient): void {
        rustMinerClient = client;
    },
    resetRustMinerClientForTests(): void {
        rustMinerClient = rustMiner;
    },
    /**
     * Toggle the miner-acceleration gates during tests. The Rust and compact
     * paths default OFF in production (no Rust backend; compact store-time
     * tax is a net loss on the TS-only path), but the tests that lock those
     * paths must opt them ON. Always restore via resetMinerGatesForTests() in
     * finally so a toggled gate cannot leak into unrelated tests.
     */
    setMinerGatesForTests(args: {
        compactArtifacts?: boolean;
        rustRouting?: boolean;
        parallelStability?: boolean;
    }): void {
        if (args.compactArtifacts !== undefined) BATCH_MINER_COMPACT_ARTIFACTS_ENABLED = args.compactArtifacts;
        if (args.rustRouting !== undefined) BATCH_MINER_RUST_ROUTING_ENABLED = args.rustRouting;
        if (args.parallelStability !== undefined) BATCH_MINER_PARALLEL_STABILITY_ENABLED = args.parallelStability;
    },
    resetMinerGatesForTests(): void {
        BATCH_MINER_COMPACT_ARTIFACTS_ENABLED = BATCH_MINER_COMPACT_ARTIFACTS_ENABLED_DEFAULT;
        BATCH_MINER_RUST_ROUTING_ENABLED = BATCH_MINER_RUST_ROUTING_ENABLED_DEFAULT;
        BATCH_MINER_PARALLEL_STABILITY_ENABLED = BATCH_MINER_PARALLEL_STABILITY_ENABLED_DEFAULT;
    },
};
