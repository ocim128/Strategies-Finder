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
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLogger } from "../debug-logger";
import { createDisconnectSafeStream, HttpStatusError, readJsonBody, sendCaughtErrorJson, sendJson, type ViteHttpResponse } from "../vite-http-utils";
import { FINDER_BATCH_MAX_BODY_BYTES } from "../server-request-limits";
import { mapWithConcurrencyLimit } from "../async-pool";
import { runBatchBacktest, type BatchBacktestRunInput, type BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { clearServerBatchDatasetCaches, getServerBatchDatasetCacheStats, loadServerBatchDataset } from "./server-batch-data-loader";
import {
    addStabilityVerdicts,
    clampInt,
    createStabilityAggregate,
    finalizeStabilityAggregate,
    sampleItems,
    type BatchStabilityMineResult,
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
import { rememberLoopbackOriginFromRequest } from "../local-api-transport";
import { isAllowedLocalRequest } from "../local-route-authorization";
import { buildBatchRunFingerprint, normalizeBatchSymbols, BATCH_MAX_SYMBOLS, verifyPairListProvenance, type BatchRunPairListProvenanceMeta, type BatchUniverseCounts } from "./batch-run-contract";
import { fnv1a64Hex, type MaxActiveResearchRegistrationV1 } from "./max-active-research-contract";
import { canonicalizeLegIdentity } from "../synthetic-leg-identity";
import type { PairListProvenanceV1 } from "./balanced-pair-list-generator";
import {
    mergeStabilityAccumulators,
    runParallelStability,
    type ParallelStabilityOutcome,
} from "./batch-stability-parallel";
import { runMinePredictionDiagnostic } from "./batch-mine-prediction-engine";
import { runMineAbTest } from "./batch-mine-prediction-ab-engine";
import { runOpenScoreUsdReplay, type OpenScoreUsdTarget } from "./batch-open-score-usd-replay-engine";
import { runExposureRedundancyReport } from "../spread-quality/spread-quality-engine";
import { createEmptyBacktestResult } from "../strategies/backtest/position-stats";

/**
 * Phase 3 MAX_ACTIVE: compute canonical universe counts from the submitted
 * symbol list. Uses the shared leg-identity leaf so `BTC+ETH` and `ETH+BTC`
 * (and `BTC+BTCUSDT` aliases within the market provider) collapse to one
 * canonical relationship. The count is invariant to orientation in the
 * submitted list — what matters is the SET of canonical relationships.
 *
 * The `submittedDegreeByAsset` map counts BOTH legs of every canonical
 * relationship (so a `BTC+ETH` pair contributes 1 to BTC and 1 to ETH).
 * This is the "submitted degree" the OPEN_SCORE USD engine distinguishes
 * from the "retained degree" (computed from successfully loaded artifacts).
 */
function computeUniverseCountsFromSymbols(symbols: readonly string[]): BatchUniverseCounts {
    const normalized = normalizeBatchSymbols(symbols.join("\n"));
    const canonicalKeys = new Set<string>();
    const submittedDegreeByAsset: Record<string, number> = {};
    for (const token of normalized) {
        const plusIdx = token.indexOf("+");
        if (plusIdx < 1 || plusIdx === token.length - 1) continue;
        const baseRaw = token.slice(0, plusIdx);
        const quoteRaw = token.slice(plusIdx + 1);
        const baseId = canonicalizeLegIdentity(baseRaw);
        const quoteId = canonicalizeLegIdentity(quoteRaw);
        if (!baseId || !quoteId) continue;
        if (baseId.scoringAsset === quoteId.scoringAsset && baseId.provider === quoteId.provider) continue;
        // Canonical relationship key: provider-scoped, sorted.
        const [a, b] = [
            `${baseId.provider}:${baseId.scoringAsset}`,
            `${quoteId.provider}:${quoteId.scoringAsset}`,
        ].sort();
        const relKey = `${a}+${b}`;
        if (canonicalKeys.has(relKey)) continue;
        canonicalKeys.add(relKey);
        submittedDegreeByAsset[baseId.scoringAsset] = (submittedDegreeByAsset[baseId.scoringAsset] ?? 0) + 1;
        submittedDegreeByAsset[quoteId.scoringAsset] = (submittedDegreeByAsset[quoteId.scoringAsset] ?? 0) + 1;
    }
    return {
        submittedSymbols: normalized.length,
        canonicalRelationships: canonicalKeys.size,
        // artifactEligible / artifactsStored / artifactWriteFailures are filled
        // in as the run progresses; the request-time snapshot starts them at 0.
        artifactEligible: 0,
        artifactsStored: 0,
        artifactWriteFailures: 0,
        submittedDegreeByAsset,
    };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Artifact retention after a Run's `done` event with no Mine click. */
const DEFAULT_ARTIFACT_RETENTION_MS = 10 * 60 * 1000;
/**
 * Stale threshold for the orphan-dir sweep (audit Finding 7). A directory
 * older than `DEFAULT_ARTIFACT_RETENTION_MS + 1 hour` is reclaimed even if its
 * owning PID marker can't be checked — defense-in-depth for cross-platform PID
 * liveness (Windows `process.kill(pid, 0)` semantics are imperfect) and for
 * PID reuse. Generations younger than this are only removed when their PID is
 * provably dead, so a concurrent live Vite process keeps its active artifacts.
 */
const ORPHAN_SWEEP_STALE_MS = DEFAULT_ARTIFACT_RETENTION_MS + 60 * 60 * 1000;
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
 * Phase 3 parallel-Stability gate. When true, the server plugin partitions the
 * Stability rerun range across Node worker_threads before falling through to
 * the sequential TypeScript loop. The worker path reads artifact files from
 * disk independently, so the structured-clone cost at worker startup stays
 * bounded regardless of pair count.
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

/**
 * Max concurrent `writeFile` calls for Mine artifact persistence. Each artifact
 * is a v8-serialized multi-MB payload; unbounded concurrency would let a
 * 1000-pair run dispatch 1000 writes at once and exhaust file descriptors / RAM
 * before the event loop could drain them. 4 is enough to keep disk throughput
 * saturated without blocking the Vite event loop (audit Finding 4).
 */
const ARTIFACT_WRITE_CONCURRENCY = 4;

/**
 * Cap on the number of artifact closures captured-but-not-yet-serialized at
 * once (audit Finding 2). Each captured closure retains the full row (`data`,
 * `signals`, `result`) until `v8.serialize` runs inside the write IIFE; an
 * unbounded queue could retain hundreds of multi-MB artifacts on a 1000-pair
 * run. Pairing this gate with the awaited `onSymbolComplete` (the runner no
 * longer fires the next symbol until this returns) bounds peak heap to
 * roughly CAP × artifact size instead of O(symbols × artifact size).
 *
 * Kept >= ARTIFACT_WRITE_CONCURRENCY so the serialization pool stays saturated
 * without starving under backpressure.
 */
const ARTIFACT_SUBMISSION_CAPACITY = 8;

/**
 * Cap on the in-memory parsed-artifact cache (audit parse-cache finding). The
 * disk-backed Mine design intentionally moves multi-MB artifacts out of heap,
 * but `loadStored` previously cached EVERY deserialized artifact for the
 * lifetime of the run. On a 1000-pair Mine that pulled nearly every artifact
 * back into heap, defeating the disk-backed design and risking OOM. A 32-entry
 * LRU keeps the working set (the linked pairs of the currently-mined target +
 * near-term reuse) hot while bounding peak heap to ~32 × artifact size.
 *
 * A pair links two assets, so an evicted pair may be re-read from disk at most
 * once more per Mine — acceptable disk overhead in exchange for the heap bound.
 */
const PARSED_ARTIFACT_CACHE_MAX = 32;

/**
 * Minimal counting semaphore capping concurrent async artifact writes across
 * `storeMineArtifact` submissions. `acquire` blocks (returns a waiting promise)
 * once `ARTIFACT_WRITE_CONCURRENCY` writes are in flight; `release` drains the
 * queue in FIFO order. `ArtifactStore.flush()` awaits every submitted promise,
 * so even a queued-but-not-yet-acquired write is tracked.
 */
class ArtifactWriteSemaphore {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    async acquire(): Promise<void> {
        if (this.active < ARTIFACT_WRITE_CONCURRENCY) {
            this.active += 1;
            return;
        }
        // Wait for a slot. The resolver does nothing beyond waking this waiter;
        // the releasing task's slot is TRANSFERRED (active stays constant on
        // handoff). `active` is only decremented when a release finds no waiter.
        await new Promise<void>((resolve) => {
            this.waiters.push(resolve);
        });
    }

    release(): void {
        const next = this.waiters.shift();
        if (next) {
            // Transfer this slot to the next waiter — do NOT decrement; the
            // waiter resumes without re-incrementing so the count stays exact.
            next();
        } else {
            this.active -= 1;
        }
    }
}

/**
 * Bounded FIFO of in-flight artifact submissions (audit Finding 2). Each entry
 * is a promise that resolves when the matching submission has finished
 * serializing its captured artifact closure (the point at which the multi-MB
 * `data`/`signals`/`result` arrays are released). `awaitSlot()` blocks while
 * `inflight.length >= ARTIFACT_SUBMISSION_CAPACITY`, awaiting the oldest entry
 * — so at most CAP artifacts are captured-but-not-yet-serialized at once.
 *
 * Owned per {@link ArtifactStore} (audit follow-up R-F1): a stale run's writer
 * awaiting a slot is waiting on ITS store's gate, not the new generation's.
 */
class ArtifactSubmissionGate {
    private inflight: Promise<void>[] = [];

    async awaitSlot(): Promise<void> {
        while (this.inflight.length >= ARTIFACT_SUBMISSION_CAPACITY) {
            // Await a snapshot of the oldest in-flight submission. A waiting
            // submitter re-checks the bound after each resolve so concurrent
            // wakes still respect the cap.
            const oldest = this.inflight[0]!;
            await oldest.catch(() => { /* a failed serialize still frees its slot */ });
            // Drop resolved heads; the matching `enter` already shifted them or
            // will shift on its own resolve — re-scan here to make progress.
            this.inflight = this.inflight.filter((p) => p !== oldest);
        }
    }

    enter(serialized: Promise<void>): void {
        this.inflight.push(serialized);
        // Self-prune as entries resolve so the array doesn't grow unbounded
        // across a long run (the cap check in `awaitSlot` only needs the
        // unresolved prefix).
        serialized.finally(() => {
            this.inflight = this.inflight.filter((p) => p !== serialized);
        }).catch(() => { /* already handled by the awaiter */ });
    }
}

/**
 * Per-run artifact store (audit follow-up R-F1). Encapsulates the directory,
 * submission gate, write semaphore, metadata, parsed cache, and pending writes
 * for ONE run generation. `storeMineArtifact` captures the store instance, so
 * after {@link detach} an old run's in-flight writer resumes against its own
 * (now-detached) store and bails instead of mutating the new generation's
 * globals. Pre-fix the write path shared module globals and an old writer
 * could clobber a new run's `lastMineArtifacts` / `pendingArtifactWrites` /
 * `mineArtifactDir` after Stop + new Run reset them.
 *
 * `detached` is the ownership flag: set synchronously by `detach()` before the
 * async cleanup, and rechecked after every `await` in the write path.
 */
export class ArtifactStore {
    dir: string | null = null;
    metas: StoredMineArtifactMeta[] = [];
    readonly parsedCache = new Map<string, BatchSyntheticPairArtifact>();
    pendingWrites: Promise<void>[] = [];
    private detached = false;
    private readonly gate = new ArtifactSubmissionGate();
    private readonly semaphore = new ArtifactWriteSemaphore();
    // Audit parse-cache finding: LRU bookkeeping. `parsedCacheHits`/`Misses`
    // count `loadStored` outcomes; `parsedCacheEvictions` counts LRU victims;
    // `parsedCachePeak` is the high-water mark of `parsedCache.size`. Used by
    // the benchmark surface and the run-complete debug event to make the
    // heap-bound behavior observable.
    private parsedCacheHits = 0;
    private parsedCacheMisses = 0;
    private parsedCacheEvictions = 0;
    private parsedCachePeak = 0;
    // Audit artifact-stats finding: track partial-write outcomes so a run that
    // lost N artifacts to disk pressure can surface it in the `done` event
    // instead of presenting "artifacts available" while Mine silently analyzes
    // only the survivors.
    private artifactEligible = 0;
    private artifactStored = 0;
    private artifactFailed = 0;
    private artifactBytesWritten = 0;

    constructor(
        private readonly writeArtifactFile: (path: string, data: Uint8Array) => Promise<void> = writeFile,
    ) {}

    ensureDir(): string {
        if (!this.dir) {
            const stamp = `${process.pid}-${Date.now()}-`;
            this.dir = mkdtempSync(join(tmpdir(), MINE_ARTIFACT_DIR_PREFIX + stamp));
        }
        return this.dir;
    }

    isDetached(): boolean {
        return this.detached;
    }

    /**
     * Store one row's Mine artifact under backpressure. The submission gate
     * bounds captured-but-not-yet-serialized closures; after every await the
     * store is rechecked for detachment so a stale writer cannot contaminate a
     * newer generation.
     */
    async store(index: number, row: BatchBacktestSymbolResult): Promise<void> {
        if (this.detached) return;
        if (!row.result || !row.data || !row.signals) return;
        const parsed = parsePortfolioSyntheticPairSymbol(row.symbol);
        if (!parsed) return;

        // Backpressure: don't capture the (multi-MB) artifact closure until a
        // submission slot is free. See ArtifactSubmissionGate.
        await this.gate.awaitSlot();
        // R-F1: recheck after the await. If Stop + new Run detached this store
        // while we were waiting for a slot, bail BEFORE capturing the artifact
        // or touching this store's state.
        if (this.detached) return;

        const dir = this.ensureDir();
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
        this.metas[index] = {
            symbol: row.symbol,
            baseAsset: parsed.baseAsset,
            quoteAsset: parsed.quoteAsset,
            baseSymbol: parsed.baseSymbol,
            quoteSymbol: parsed.quoteSymbol,
            filePath,
        };
        // Audit artifact-stats finding: this row passed the synthetic-pair
        // gate, so it is eligible for Mine. Increment BEFORE the write so a
        // failed write records `failed++` against the right denominator.
        this.artifactEligible += 1;
        let markSerialized: () => void;
        const serialized = new Promise<void>((resolve) => { markSerialized = resolve; });
        this.gate.enter(serialized);
        this.pendingWrites.push(
            (async () => {
                try {
                    await this.semaphore.acquire();
                    try {
                        const bytes = serialize(artifact);
                        await mkdir(dir, { recursive: true });
                        await this.writeArtifactFile(filePath, bytes);
                        // Audit artifact-stats finding: success — record the
                        // outcome and the byte count (the wire-size of the
                        // artifact, useful for heap-budget math).
                        this.artifactStored += 1;
                        this.artifactBytesWritten += bytes.byteLength;
                    } catch (error) {
                        // Never advertise a file that failed to reach disk.
                        if (this.metas[index]?.filePath === filePath) {
                            delete this.metas[index];
                        }
                        this.artifactFailed += 1;
                        debugLogger.warn("batch.server.artifact_store_failed", {
                            filePath,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    } finally {
                        this.semaphore.release();
                    }
                } finally {
                    markSerialized!();
                }
            })(),
        );
    }

    async loadStored(meta: StoredMineArtifactMeta): Promise<BatchSyntheticPairArtifact> {
        const cached = this.parsedCache.get(meta.filePath);
        if (cached) {
            // Audit parse-cache finding: refresh recency so the LRU eviction
            // order reflects actual reuse, not insertion order. `delete` +
            // `set` moves the entry to the end of Map iteration order.
            this.parsedCache.delete(meta.filePath);
            this.parsedCache.set(meta.filePath, cached);
            this.parsedCacheHits += 1;
            return cached;
        }
        const deserialized = deserialize(await readFile(meta.filePath)) as BatchSyntheticPairArtifact;
        this.parsedCache.set(meta.filePath, deserialized);
        this.evictParsedCacheIfOverLimit();
        this.parsedCacheMisses += 1;
        return deserialized;
    }

    /**
     * Enforce the LRU cap. Map iteration order is insertion order, so the
     * oldest entry is the LRU victim. Updates `parsedCachePeak` even when no
     * eviction is needed so the high-water mark stays accurate.
     */
    private evictParsedCacheIfOverLimit(): void {
        if (this.parsedCache.size > this.parsedCachePeak) {
            this.parsedCachePeak = this.parsedCache.size;
        }
        while (this.parsedCache.size > PARSED_ARTIFACT_CACHE_MAX) {
            const oldest = this.parsedCache.keys().next().value;
            if (oldest === undefined) break;
            this.parsedCache.delete(oldest);
            this.parsedCacheEvictions += 1;
        }
    }

    /** Snapshot the LRU counters for diagnostics (audit parse-cache finding). */
    parsedCacheStats(): {
        size: number;
        max: number;
        hits: number;
        misses: number;
        evictions: number;
        peak: number;
    } {
        return {
            size: this.parsedCache.size,
            max: PARSED_ARTIFACT_CACHE_MAX,
            hits: this.parsedCacheHits,
            misses: this.parsedCacheMisses,
            evictions: this.parsedCacheEvictions,
            peak: this.parsedCachePeak,
        };
    }

    /**
     * Snapshot of the artifact-write counters (audit artifact-stats finding).
     * `eligible` is the synthetic-pair count seen by `store`; `stored`/`failed`
     * are the write outcomes; `bytesWritten` is the wire size of stored
     * artifacts. Used by the `done` event and `/status.lastRun` so a partial
     * failure is observable instead of silent.
     */
    artifactStats(): { eligible: number; stored: number; failed: number; bytesWritten: number } {
        return {
            eligible: this.artifactEligible,
            stored: this.artifactStored,
            failed: this.artifactFailed,
            bytesWritten: this.artifactBytesWritten,
        };
    }

    collectMetas(): StoredMineArtifactMeta[] {
        return this.metas.filter((meta): meta is StoredMineArtifactMeta => Boolean(meta));
    }

    hasStored(): boolean {
        return this.collectMetas().length > 0;
    }

    async flush(): Promise<void> {
        const writes = this.pendingWrites;
        this.pendingWrites = [];
        if (writes.length > 0) {
            await Promise.all(writes);
        }
    }

    /**
     * Mark this generation detached and snapshot what cleanup needs. Sets
     * `detached = true` SYNCHRONOUSLY so any in-flight writer that resumes
     * after this point bails. Returns the dir + pending writes for the async
     * cleanup; the caller owns the rm.
     */
    detach(): { dir: string | null; writes: Promise<void>[]; metasCount: number } {
        this.detached = true;
        const snapshot = {
            dir: this.dir,
            writes: this.pendingWrites,
            metasCount: this.metas.length,
        };
        this.pendingWrites = [];
        this.metas = [];
        this.parsedCache.clear();
        // Reset all diagnostics counters so a reused ArtifactStore (test seam)
        // starts from zero. Production always allocates a fresh store per run.
        this.parsedCacheHits = 0;
        this.parsedCacheMisses = 0;
        this.parsedCacheEvictions = 0;
        this.parsedCachePeak = 0;
        this.artifactEligible = 0;
        this.artifactStored = 0;
        this.artifactFailed = 0;
        this.artifactBytesWritten = 0;
        this.dir = null;
        return snapshot;
    }
}

// ---------------------------------------------------------------------------
// Module-scope state — single in-flight run per dev server (single-owner model)
// ---------------------------------------------------------------------------

const RUN_OWNER_NONE = 0;
let runOwner = RUN_OWNER_NONE;
let runOwnerGen = 0;
// Run id reserved by the request that currently owns `runOwner`. This is set
// before the first awaited preflight step, while `runState` may still describe
// the previous run (or be null). Stop must consult this reservation instead of
// relying only on `runState.runId`, otherwise a Stop in that window can be
// rejected as stale or clear the lock without preventing the run from starting.
let runOwnerRunId: string | null = null;
let minerOwner = RUN_OWNER_NONE;
let minerOwnerGen = 0;

let runState: BatchRunSnapshot | null = null;
/**
 * The current run's artifact store (audit follow-up R-F1). Owns the per-run
 * directory, submission gate, write semaphore, metadata, parsed cache, and
 * pending writes. Closures in `storeMineArtifact` capture THIS instance, so
 * when `releaseLastResults` detaches it (sets `currentArtifactStore = null`
 * and `store.detached = true`), an old run's in-flight writer resumes against
 * its OWN (now-detached) store and bails instead of contaminating the new
 * generation's globals. Pre-fix the write path awaited the shared module
 * gate/semaphore and then mutated shared `lastMineArtifacts` /
 * `pendingArtifactWrites` / `mineArtifactDir` without rechecking generation,
 * letting a stale writer clobber a new run's state.
 */
let currentArtifactStore: ArtifactStore | null = null;
let lastRunFingerprint: string | null = null;
let lastRunInterval: string | null = null;
let lastRunStrategyKey: string | null = null;
let lastRunBacktestSettings: BacktestSettings | null = null;
let lastRunCapitalSettings: CapitalSettings | null = null;
let lastRunUseRustEnginePreference = false;
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
// Retain the successful Stability result so Portfolio Fit uses server-owned
// context instead of trusting browser-supplied rows.
let retainedStabilityResult: BatchStabilityMineResult | null = null;

/**
 * Stop-before-ownership race closer (audit Finding 5). When Stop arrives BEFORE
 * the matching run acquires ownership (the request is still parsing / loading),
 * the run id is recorded here. The matching run request consumes the marker and
 * finishes cancelled instead of starting heavy work. Single slot — only the
 * latest pending stop run id is retained, mirroring the Finder plugin.
 */
let pendingStopRunId: string | null = null;

/** Bound on run id length (defensive; browser-generated ids are short). */
const BATCH_MAX_RUN_ID_LENGTH = 128;

/**
 * Parse and validate an optional browser-supplied run id. Missing means a
 * legacy caller; malformed PRESENT values are rejected instead of silently
 * degrading to an unscoped Stop.
 */
function parseBatchRunId(raw: unknown): string {
    if (raw === undefined || raw === null) return "";
    if (typeof raw !== "string") {
        throw new HttpStatusError(400, "runId must be a string.");
    }
    const trimmed = raw.trim();
    if (!trimmed) throw new HttpStatusError(400, "runId must be a non-empty string.");
    if (trimmed.length > BATCH_MAX_RUN_ID_LENGTH) {
        throw new HttpStatusError(400, `runId must be at most ${BATCH_MAX_RUN_ID_LENGTH} characters.`);
    }
    return trimmed;
}

function consumePendingBatchStopForRun(runId: string): boolean {
    if (!runId || pendingStopRunId !== runId) return false;
    pendingStopRunId = null;
    return true;
}

/**
 * Terminal phase for a Batch run (audit Finding 6). Surfaces
 * `done`/`cancelled`/`fatal` independently of artifact availability so a
 * reloaded tab can recover a terminal failure that produced no Mine artifacts
 * (previously the failure "vanished" from /status because `lastRun` was gated
 * on `hasStoredMineArtifacts()`).
 *
 * `running` is represented by `phase === "running"` AND `runOwner !== NONE`;
 * a terminal snapshot stays in `runState` until the next run starts.
 */
export type BatchRunPhase = "running" | "done" | "cancelled" | "fatal";

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
    /** Terminal phase. Set when the run loop exits. Defaults to "running". */
    phase: BatchRunPhase;
    /** Wall-clock ms when the run reached a terminal phase; null while running. */
    finishedAt: number | null;
    /** One-line terminal summary surfaced to the reattach UI; null while running. */
    summary: string | null;
    /** Fatal error message (only set when `phase === "fatal"`). */
    error: string | null;
    /**
     * Browser-generated run id (audit Finding 5). Empty string for runs
     * started by a stale browser bundle that predates the runId contract;
     * the server still accepts legacy unscoped Stop in that case.
     */
    runId: string;
    /**
     * Audit artifact-stats finding: snapshot of partial-write outcomes
     * (`eligible`/`stored`/`failed`/`bytesWritten`). Present on terminal
     * snapshots; null while running or when no run has completed.
     */
    artifactStats?: { eligible: number; stored: number; failed: number; bytesWritten: number } | null;
    /**
     * Audit parse-cache finding: snapshot of the parsed-artifact LRU counters
     * at run completion. Surfaces hits/misses/evictions/peak so the heap-bound
     * behavior is observable from `/status.lastRun`.
     */
    parsedCacheStats?: { size: number; max: number; hits: number; misses: number; evictions: number; peak: number } | null;
    /**
     * Optional pair-list provenance metadata retained from the request. The
     * `status` field is "verified" only when the recomputed pair-list hash
     * matches; otherwise "manual/unverified". Bounded scalars only — no
     * OHLCV arrays cross this wire.
     */
    pairListProvenanceMeta?: BatchRunPairListProvenanceMeta | null;
    /**
     * Universe counts for the MAX_ACTIVE research. Surfaces submitted /
     * canonical / artifact-eligible / stored / failed counts at run
     * completion so the OPEN_SCORE USD report can name every failed gate.
     * Null while running or when no run has completed.
     */
    universeCounts?: BatchUniverseCounts | null;
    /**
     * Optional MAX_ACTIVE research registration metadata retained from the
     * request. `status` is "verified" only when the registration exactly
     * matches the committed server-side constant; otherwise
     * "manual/unverified".
     */
    researchRegistrationMeta?: { registration: MaxActiveResearchRegistrationV1 | null; status: "verified" | "manual/unverified"; reason?: string } | null;
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

/**
 * Prefix for Mine artifact directories. Includes the owning PID and creation
 * time so {@link sweepOrphanedMineArtifactDirs} can distinguish this process's
 * active generation from a concurrently-running second Vite instance
 * (audit Finding 7). Pre-fix the prefix was `strategies-finder-batch-mine-`
 * with only `mkdtemp`'s random suffix; the sweep deleted EVERY matching dir on
 * startup, clobbering a live sibling process's artifacts.
 */
const MINE_ARTIFACT_DIR_PREFIX = "strategies-finder-batch-mine-";

/**
 * Persist a per-row Mine artifact via the captured {@link ArtifactStore}
 * (audit follow-up R-F1). The store is captured at run start in
 * {@link processRunBatch} and passed through `onSymbolComplete`, so a stale
 * writer that resumes after `releaseLastResults` operates on its OWN
 * (detached) store and bails instead of contaminating the new generation.
 */
async function storeMineArtifact(index: number, row: BatchBacktestSymbolResult, store: ArtifactStore): Promise<void> {
    await store.store(index, row);
}

async function loadStoredMineArtifact(meta: StoredMineArtifactMeta): Promise<BatchSyntheticPairArtifact> {
    if (!currentArtifactStore) {
        throw new Error("loadStoredMineArtifact called with no active artifact store");
    }
    return currentArtifactStore.loadStored(meta);
}

const MINE_AB_ARTIFACT_LOAD_TIMEOUT_MS = 15_000;

async function loadStoredMineArtifactBounded(meta: StoredMineArtifactMeta): Promise<BatchSyntheticPairArtifact | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            loadStoredMineArtifact(meta),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), MINE_AB_ARTIFACT_LOAD_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

/**
 * Persist the active store's post-analysis LRU counters on the retained run
 * snapshot. Run completion captures the pre-Mine zero state; analysis paths
 * call this after loading artifacts so `/status.lastRun.parsedCacheStats`
 * reflects real cache usage even after Mine releases the store.
 */
function captureCurrentParsedCacheStats(): void {
    if (!currentArtifactStore || !runState) return;
    runState.parsedCacheStats = currentArtifactStore.parsedCacheStats();
}

function collectStoredMineArtifactMetas(): StoredMineArtifactMeta[] {
    return currentArtifactStore ? currentArtifactStore.collectMetas() : [];
}

function hasStoredMineArtifacts(): boolean {
    return Boolean(currentArtifactStore?.hasStored());
}

/**
 * Get the active store's dir for the orphan-sweep active-generation skip and
 * test seams. Returns null when no store is active.
 */
function currentMineArtifactDir(): string | null {
    return currentArtifactStore?.dir ?? null;
}

/** Ensure the active store has a dir, creating one if needed. Test seam. */
function ensureCurrentArtifactStoreDir(): string {
    if (!currentArtifactStore) {
        currentArtifactStore = new ArtifactStore();
    }
    return currentArtifactStore.ensureDir();
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
 * Async because artifact writes (`storeMineArtifact`) and the recursive temp
 * dir removal (`rm`) are offloaded to `fs/promises` so a multi-GB cleanup does
 * not block the Vite event loop (audit Finding 4). Awaits any pending writes
 * first so a slow write isn't left referencing a deleted path.
 *
 * Re-entrancy: the module state (`mineArtifactDir`, `lastMineArtifacts`,
 * `parsedArtifactCache`) is cleared SYNCHRONOUSLY before the async `rm`, so a
 * concurrent release (TTL timer racing a new Run's `new_run` release) takes
 * the early-return path instead of issuing a second `rm` that could clobber a
 * dir a new run already created.
 *
 * Idempotent: safe to call when no artifacts are retained.
 */
async function releaseLastResults(reason: string): Promise<void> {
    clearArtifactReleaseTimer();
    // Audit Finding 3 + follow-up R-F1: detach THIS generation's store
    // SYNCHRONOUSLY, before any await. `detach()` flips `store.detached = true`
    // so any in-flight `storeMineArtifact` writer that resumes after this point
    // against its OWN (captured) store bails instead of contaminating the new
    // generation's globals. Pre-fix the writer captured module globals and
    // could clobber a new run's `lastMineArtifacts` / `pendingArtifactWrites` /
    // `mineArtifactDir` after Stop + new Run reset them.
    const store = currentArtifactStore;
    const detached = store ? store.detach() : { dir: null, writes: [], metasCount: 0 };
    currentArtifactStore = null;
    lastRunFingerprint = null;
    lastRunInterval = null;
    lastRunStrategyKey = null;
    lastRunBacktestSettings = null;
    lastRunCapitalSettings = null;
    lastRunUseRustEnginePreference = false;
    lastRunCacheStats = null;
    // Clear retained Stability state whenever its matching artifacts expire.
    retainedStabilityResult = null;

    // Now safe to await: this only touches the DETACHED snapshot.
    if (detached.writes.length > 0) {
        await Promise.all(detached.writes);
    }
    if (detached.metasCount === 0 && !detached.dir) {
        // `new_run` also comes through here. Cache invalidation must not depend
        // on Mine artifacts existing: IBKR CSVs may have changed since a prior
        // non-mineable/expired run while the server-side parsed CSV cache lived.
        clearServerBatchDatasetCaches();
        return;
    }
    debugLogger.info("batch.server.artifacts_released", {
        reason,
        rows: detached.metasCount,
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
    clearServerBatchDatasetCaches();
    if (detached.dir) {
        // `force: true` suppresses ENOENT but NOT EBUSY/EPERM (e.g. an AV
        // scanner holding a file on Windows). Swallowing is correct: the
        // sweepOrphanedMineArtifactDirs startup sweep reclaims what's left,
        // and a rejection here must NOT crash the dev server via the TTL
        // timer's `void` caller or fail an in-flight Run/Mine.
        try {
            await rm(detached.dir, { recursive: true, force: true });
        } catch (error) {
            debugLogger.warn("batch.server.artifact_release_rm_failed", {
                dir: detached.dir,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

function scheduleArtifactTtl(): void {
    clearArtifactReleaseTimer();
    artifactReleaseTimer = setTimeout(() => {
        void releaseLastResults("ttl_expired");
    }, DEFAULT_ARTIFACT_RETENTION_MS);
}

/**
 * Sweep orphaned Mine artifact directories left behind by a prior dev-server
 * process that crashed or was killed mid-Run (Ctrl-C, OOM, laptop reboot)
 * before `releaseLastResults` could fire. Each dir can hold up to ~5 GB of
 * artifacts on a 1000-pair IBKR 4H run, so without this sweep they
 * accumulate across crashes.
 *
 * Audit Finding 7: the sweep is PID- and age-aware so a SECOND concurrently
 * running Vite process (worktree, automatic port 5174/5175) does NOT have its
 * active artifacts deleted. A stamped directory is reclaimed when its owning
 * PID is provably dead. A live PID always wins over age; age is only the
 * fallback for legacy directories or indeterminate liveness errors.
 * The current process's active generation is always
 * skipped. Pre-fix the sweep deleted every matching dir unconditionally.
 *
 * Idempotent and safe to call at plugin registration.
 */
async function sweepOrphanedMineArtifactDirs(): Promise<void> {
    let tmp: string;
    try {
        tmp = tmpdir();
    } catch {
        return;
    }
    let entries: string[];
    try {
        entries = await readdir(tmp);
    } catch {
        return;
    }
    const activeDir = currentMineArtifactDir();
    const now = Date.now();
    for (const entry of entries) {
        // Pre-fix legacy dirs use the bare prefix with no PID stamp. Their
        // filesystem age is checked below because a live sibling may still be
        // running an older bundle.
        if (!entry.startsWith(MINE_ARTIFACT_DIR_PREFIX)) continue;
        const fullPath = join(tmp, entry);
        if (activeDir === fullPath) continue;
        let shouldSweep = shouldSweepOrphanEntry(entry, now);
        if (!shouldSweep && !entry.slice(MINE_ARTIFACT_DIR_PREFIX.length).match(/^(\d+)-(\d+)-/)) {
            // Legacy directories have no embedded owner. Use directory mtime
            // as the conservative age signal instead of deleting them merely
            // because a sibling happens to run older code.
            try {
                const info = await stat(fullPath);
                shouldSweep = now - info.mtimeMs > ORPHAN_SWEEP_STALE_MS;
            } catch {
                shouldSweep = false;
            }
        }
        if (!shouldSweep) continue;
        try {
            await rm(fullPath, { recursive: true, force: true });
        } catch (error) {
            debugLogger.warn("batch.server.orphan_sweep_failed", {
                entry,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

/**
 * Decide whether a temp-dir entry matches the artifact-dir shape AND is safe to
 * reclaim. The shape is `<prefix><pid>-<createdAtMs>-<random>`. A dir is safe
 * to delete when the owning PID is no longer alive. A live PID is retained
 * regardless of age. Legacy entries are handled by filesystem mtime in the
 * caller because this pure classifier has no age evidence for them.
 */
function shouldSweepOrphanEntry(entry: string, now: number): boolean {
    const tail = entry.slice(MINE_ARTIFACT_DIR_PREFIX.length);
    // Legacy entries cannot prove ownership. Only age-stamped generations can
    // be reclaimed here; an unparseable recent/live sibling must be preserved.
    const stampMatch = tail.match(/^(\d+)-(\d+)-/);
    if (!stampMatch) return false;
    const pid = Number(stampMatch[1]!);
    const createdAtMs = Number(stampMatch[2]!);
    if (!Number.isFinite(pid) || pid <= 0) return true;
    // A provably live PID always wins over age. Long server jobs can exceed
    // the stale threshold, especially in a sibling worktree.
    if (pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ESRCH") return true;
        // EPERM/unknown means liveness is indeterminate. Reclaim only after
        // the conservative age threshold; never interpret permission failure
        // as proof that the process is dead.
        return Number.isFinite(createdAtMs) && now - createdAtMs > ORPHAN_SWEEP_STALE_MS;
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
    runId: string = "",
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
        phase: "running",
        finishedAt: null,
        summary: null,
        error: null,
        runId,
        artifactStats: null,
        parsedCacheStats: null,
        pairListProvenanceMeta: null,
        universeCounts: null,
        researchRegistrationMeta: null,
    };
    const snapshot = runState;
    // R-F1: create THIS run's ArtifactStore and capture it in the closure so
    // `onSymbolComplete` writes against this generation only. If Stop + new Run
    // detaches this store mid-flight, the captured writer bails instead of
    // contaminating the new generation's globals.
    const store = new ArtifactStore();
    currentArtifactStore = store;
    // Phase 3 MAX_ACTIVE: verify pair-list provenance against the canonical
    // submitted symbols. The fingerprint includes the verified provenance so
    // a manual textarea edit (which clears the provenance client-side) also
    // changes the fingerprint and invalidates retained artifacts.
    const pairListProvenanceMeta = (() => {
        const v = verifyPairListProvenance(input.pairListProvenance ?? null, input.symbols, fnv1a64Hex);
        if (v.ok) return { provenance: input.pairListProvenance ?? null, status: "verified" as const };
        return {
            provenance: input.pairListProvenance ?? null,
            status: "manual/unverified" as const,
            reason: v.reason,
        };
    })();
    snapshot.pairListProvenanceMeta = pairListProvenanceMeta;
    // Phase 3 MAX_ACTIVE: compute canonical universe counts from the request.
    // Canonical relationships dedupe BASE+QUOTE / QUOTE+BASE so the count is
    // invariant to orientation in the submitted list.
    snapshot.universeCounts = computeUniverseCountsFromSymbols(input.symbols);
    // Phase 3 MAX_ACTIVE: verify the optional research registration against
    // the committed server-side constant (currently null → unverified).
    snapshot.researchRegistrationMeta = {
        registration: input.maxActiveResearchRegistration ?? null,
        status: "manual/unverified",
        reason: "no committed holdout registration",
    };
    const fingerprint = buildBatchRunFingerprint({
        symbols: input.symbols,
        strategyKey: input.strategyKey,
        strategyParams: input.strategyParams,
        backtestSettings: input.backtestSettings,
        capitalSettings: input.capitalSettings,
        interval: input.interval,
        ...(pairListProvenanceMeta.status === "verified" && pairListProvenanceMeta.provenance
            ? { pairListProvenance: pairListProvenanceMeta.provenance }
            : {}),
    });

    writer({ type: "start", total, interval: input.interval, strategyKey: input.strategyKey, runId });

    const lostOwnership = () => runOwner !== owner;
    let cancelled = false;
    // setProgress already carries the status; do not emit it twice per symbol.
    try {
        const output = await runBatchBacktest({ ...input, pruneResultArtifacts: true }, {
            setProgress: (percent, text) => {
                if (lostOwnership()) return;
                writer({ type: "progress", percent, text, status: text });
            },
            setStatus: () => {},
            onSymbolStart: (_index, symbol) => {
                if (lostOwnership()) return;
                if (runState === snapshot) {
                    snapshot.currentSymbol = symbol;
                }
            },
            onSymbolComplete: async (index, result) => {
                if (lostOwnership()) return;
                const scalarRow = toScalarRow(result);
                if (runState === snapshot) {
                    snapshot.completed = index + 1;
                    snapshot.rows.push(scalarRow);
                }
                // Audit Finding 2: await the artifact write so the runner
                // applies backpressure instead of stacking unbounded closures
                // that each retain a full multi-MB row. R-F1: pass THIS run's
                // captured store so a stale writer can't contaminate a newer
                // generation after Stop + new Run detached it.
                await storeMineArtifact(index, result, store);
                if (store.isDetached()) return;
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
        // R-F1: only stamp the global run-provenance fields if THIS run still
        // owns the snapshot. An unwinding old run whose ownership was taken by
        // a newer run must not overwrite the newer run's fingerprint/interval/
        // strategy — those gate Mine/Stability/Portfolio Fit acceptance.
        // Flush in-flight artifact writes before the `done` event so
        // `serverHasArtifacts` is truthful — the browser gates the Mine button
        // on that flag, and Mine reads the artifacts from disk (audit Finding 4).
        // Bind completion to this captured generation. A stopped old run can
        // resume after a newer run installs another global store; it must not
        // flush, release, or report that newer generation's artifacts.
        if (store.isDetached() || currentArtifactStore !== store) return;
        await store.flush();
        if (store.isDetached() || currentArtifactStore !== store) return;
        const artifactsAvailable = store.hasStored();
        const artifactStats = store.artifactStats();
        const parsedCacheStats = store.parsedCacheStats();
        if (runState === snapshot) {
            lastRunFingerprint = fingerprint;
            lastRunInterval = input.interval;
            lastRunStrategyKey = input.strategyKey;
            lastRunBacktestSettings = { ...input.backtestSettings };
            lastRunCapitalSettings = { ...input.capitalSettings };
            lastRunUseRustEnginePreference = input.useRustEnginePreference === true;
        }
        const cacheStats = getServerBatchDatasetCacheStats();
        lastRunCacheStats = cacheStats;
        let terminalSummary = `Done — ${output.results.length} pairs${output.failedSymbols.length > 0 ? `, ${output.failedSymbols.length} failed` : ""}${cancelled ? ", cancelled" : ""}`;
        // Audit artifact-stats finding: when a run retains some but not all
        // Mine artifacts (disk pressure on a 1000-pair run), surface the
        // partial-failure count in the summary so Mine-analyzing fewer pairs
        // is visible rather than silent. Keep `serverHasArtifacts` truthful
        // (true iff `stored > 0`) so the Mine button stays enabled.
        if (artifactStats.failed > 0) {
            terminalSummary += ` — artifacts ${artifactStats.stored}/${artifactStats.eligible}; Mine will omit ${artifactStats.failed} failed write${artifactStats.failed === 1 ? "" : "s"}.`;
        }
        // Audit Finding 6: stamp the terminal snapshot fields BEFORE releasing
        // ownership so /status can recover a terminal failure even if the run
        // produced no Mine artifacts. The previous `lastRun` gate
        // (`hasStoredMineArtifacts()`) made fatal/no-artifact runs vanish from
        // /status after a reload.
        if (runState === snapshot) {
            snapshot.phase = cancelled ? "cancelled" : "done";
            snapshot.finishedAt = Date.now();
            snapshot.summary = terminalSummary;
            snapshot.error = null;
            // Audit artifact-stats finding: stash the partial-write snapshot
            // on the run state so `/status.lastRun` can render the same
            // diagnostic to a reloaded tab without needing the stream.
            snapshot.artifactStats = artifactStats;
            snapshot.parsedCacheStats = parsedCacheStats;
            // Phase 3 MAX_ACTIVE: fold the artifact-store counts into the
            // universe counts so the OPEN_SCORE USD report can name every
            // failed sufficiency gate (eligible/stored/failed ratios).
            if (snapshot.universeCounts) {
                snapshot.universeCounts.artifactEligible = artifactStats.eligible;
                snapshot.universeCounts.artifactsStored = artifactStats.stored;
                snapshot.universeCounts.artifactWriteFailures = artifactStats.failed;
            }
        }
        writer({
            type: "done",
            ok: output.failedSymbols.length === 0 && !cancelled,
            cancelled,
            interval: input.interval,
            totals: { loadedSymbols: output.loadedSymbols, failedSymbols: output.failedSymbols.length },
            summary: terminalSummary,
            serverHasArtifacts: artifactsAvailable,
            fingerprint,
            cacheStats,
            runId,
            artifactStats,
            parsedCacheStats,
            pairListProvenanceMeta: snapshot.pairListProvenanceMeta ?? null,
            universeCounts: snapshot.universeCounts ?? null,
            verifiedPairListProvenance: snapshot.pairListProvenanceMeta?.status === "verified"
                ? snapshot.pairListProvenanceMeta.provenance
                : null,
        });

        // Schedule the TTL release only if the run produced mineable
        // artifacts. Empty / fully-failed runs release immediately so the
        // server heap doesn't retain a placeholder.
        if (artifactsAvailable) {
            scheduleArtifactTtl();
        } else {
            if (currentArtifactStore === store) {
                await releaseLastResults("run_no_artifacts");
            }
        }
        debugLogger.event("batch.server.run.complete", {
            symbols: input.symbols.length,
            loadedSymbols: output.loadedSymbols,
            failedSymbols: output.failedSymbols.length,
            cancelled,
            artifacts: store.collectMetas().length,
            durationMs: Date.now() - snapshot.startedAt,
            heapUsedMb: Math.round(process.memoryUsage().heapUsed / HEAP_MB),
            heapLimitMb: getV8HeapLimitMb(),
            interval: input.interval,
            strategyKey: input.strategyKey,
            // Audit artifact-stats / parse-cache findings: surface counters so
            // the heap-bound + partial-write behavior is observable in logs.
            artifactStats,
            parsedCacheStats,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.run.fatal", { error: message });
        // Audit Finding 6: stamp the fatal snapshot BEFORE releaseLastResults
        // (which can null nothing here — runState survives for status reattach).
        // The previous `lastRun` gate hid fatal runs from /status after reload.
        if (runState === snapshot) {
            snapshot.phase = "fatal";
            snapshot.finishedAt = Date.now();
            snapshot.summary = `Fatal — ${message}`;
            snapshot.error = message;
        }
        writer({ type: "fatal", error: message, runId });
        if (currentArtifactStore === store) {
            await releaseLastResults("run_fatal");
        }
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
            const linkedArtifacts = await Promise.all(linkedMetas.map(loadStoredMineArtifact));
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
        if (lostOwnership()) {
            snapshot.cancelled = true;
            snapshot.running = false;
            writer({ type: "done", ok: false, cancelled: true, summary: "Mining cancelled.", totals: { verdicts: verdictCount } });
            return;
        }
        snapshot.running = false;
        writer({
            type: "done",
            ok: true,
            cancelled: false,
            summary: `Miner | Assets ${verdictCount}`,
            totals: { verdicts: verdictCount },
        });
        captureCurrentParsedCacheStats();
        // Mine was the last consumer of the per-row artifacts. Release them.
        await releaseLastResults("mine_completed");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.mine.fatal", { error: message });
        snapshot.running = false;
        writer({ type: "fatal", error: message });
    } finally {
        captureCurrentParsedCacheStats();
        if (minerState === snapshot) {
            snapshot.running = false;
        }
        if (hasStoredMineArtifacts()) {
            scheduleArtifactTtl();
        }
    }
}

function cancelMinerOnDisconnect(owner: number): void {
    if (minerOwner !== owner) return;
    minerAbortController?.abort();
    minerOwner = RUN_OWNER_NONE;
    if (minerState) {
        minerState.cancelled = true;
        minerState.running = false;
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
        retainedStabilityResult = null;
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

        // Phase 3: when the rerun count justifies it, partition the rerun range
        // across Node worker_threads. Each worker reads artifact files from disk
        // independently, so worker startup cost stays bounded regardless of pair
        // count. On any worker failure, fall through once to the sequential
        // TypeScript loop. Gated by `BATCH_MINER_PARALLEL_STABILITY_ENABLED`,
        // which defaults true after the worker bundling/parity tests locked the
        // loading story.
        if (
            BATCH_MINER_PARALLEL_STABILITY_ENABLED
            && reruns >= PARALLEL_STABILITY_MIN_RERUNS
            && !lostOwnership()
        ) {
            const parallelStartedAt = performance.now();
            const manifest = buildStabilityManifest();
            // Workers deserialize artifacts from disk independently. Keeping
            // the parent copies adds another full prepared-universe footprint
            // during the peak and is unnecessary; sequential fallback reloads
            // them through loadStoredMineArtifact if worker startup fails.
            currentArtifactStore?.parsedCache.clear();
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
                snapshot.verdicts = parallelResult.hitEvents;
                writer({ type: "progress", run: reruns, reruns, hits: parallelResult.hitEvents });
                if (lostOwnership()) {
                    writeCancelled();
                    return;
                }
                snapshot.running = false;
                retainedStabilityResult = parallelResult;
                writer({ type: "done", ok: true, result: parallelResult });
                // Do NOT releaseLastResults("mine_completed") here. The sequential
                // Stability path intentionally retains artifacts so a second
                // Stability run (different seed / reruns) can reuse them without
                // recomputing the entire Batch run; its `finally` block schedules
                // the TTL cleanup. Releasing here deleted artifacts immediately
                // after the first parallel Stability success, while `done` set
                // `serverHasArtifacts = true`, so the next Stability click hit
                // "no artifacts on server". Falling through to `return` lets the
                // shared `finally` schedule the TTL exactly like the sequential
                // path — one contract for both accelerated and sequential paths.
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
        // Split the artifact load (disk deserialize/cache) from the prepare step
        // (ATR/trade/signal index building) so `artifactConversionMs` reports
        // disk artifact load separately from preparation.
        profileStartedAt = performance.now();
        const loadedPairs = await Promise.all(artifactMetas.map(loadStoredMineArtifact));
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
        finalResult.engine = "typescript";
        if (lostOwnership()) {
            writeCancelled();
            return;
        }
        snapshot.running = false;
        retainedStabilityResult = finalResult;
        writer({ type: "done", ok: true, result: finalResult });
    } catch (error) {
        if (lostOwnership()) {
            writeCancelled();
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.stability_mine.fatal", { error: message });
        snapshot.running = false;
        retainedStabilityResult = null;
        writer({ type: "fatal", error: message });
    } finally {
        captureCurrentParsedCacheStats();
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
    baseOnly = false,
    onAssetProgress?: (asset: string, doneAssets: number, totalAssets: number) => void,
): Promise<BatchSyntheticTargetArtifact[]> {
    const assets = Array.from(new Set(
        pairArtifacts.flatMap((artifact) => baseOnly ? [artifact.baseAsset] : [artifact.baseAsset, artifact.quoteAsset])
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
    let completedAssets = 0;
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
            } finally {
                completedAssets += 1;
                onAssetProgress?.(asset, completedAssets, assets.length);
            }
        },
    );
    return loaded.filter((entry): entry is BatchSyntheticTargetArtifact => entry !== null);
}

// ---------------------------------------------------------------------------
// Parallel-Stability file manifest
// ---------------------------------------------------------------------------

/**
 * Collect the on-disk pair artifact file paths for the parallel-Stability
 * workers. Each worker reads these files independently from disk so the
 * structured-clone cost at worker startup stays bounded regardless of pair
 * count. Returns null when no artifacts are retained (e.g. after TTL release).
 */
function buildStabilityManifest(): { pairArtifactFiles: string[] } | null {
    if (!currentMineArtifactDir()) return null;
    const metas = collectStoredMineArtifactMetas();
    if (metas.length === 0) return null;
    return { pairArtifactFiles: metas.map((meta) => meta.filePath) };
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
    if (symbols.length > BATCH_MAX_SYMBOLS) {
        // Keep accepted runs within the shared persistence ceiling.
        throw new HttpStatusError(
            400,
            `Batch size ${symbols.length} exceeds the ${BATCH_MAX_SYMBOLS}-symbol limit. Split the run into chunks of ${BATCH_MAX_SYMBOLS} or fewer.`,
        );
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
    // Audit Finding 5: browser-generated run id scopes Stop and reattach to
    // THIS run. Empty string signals a stale browser bundle that predates the
    // contract; the server falls back to legacy unscoped behavior in that case.
    const runId = parseBatchRunId(body.runId);

    // Phase 3 MAX_ACTIVE: extract the optional pair-list provenance and the
    // optional research registration. Both are untrusted client input; the
    // server verifies the pair-list hash against the submitted symbols and
    // only trusts a registration that exactly matches the committed constant.
    // Malformed/oversized values become unverified metadata and cannot
    // produce a HOLDOUT/PASS verdict.
    const pairListProvenanceRaw = body.pairListProvenance;
    const pairListProvenance = (pairListProvenanceRaw && typeof pairListProvenanceRaw === "object"
        && (pairListProvenanceRaw as { schema?: unknown }).schema === "batch.pair_list.v1"
        && (pairListProvenanceRaw as { algorithm?: unknown }).algorithm === "seeded_round_robin_v1")
        ? pairListProvenanceRaw as PairListProvenanceV1
        : null;
    const maxActiveResearchRegistrationRaw = body.maxActiveResearchRegistration;
    const maxActiveResearchRegistration = (maxActiveResearchRegistrationRaw
        && typeof maxActiveResearchRegistrationRaw === "object"
        && (maxActiveResearchRegistrationRaw as { schema?: unknown }).schema === "batch.max_active_research.v1")
        ? maxActiveResearchRegistrationRaw as MaxActiveResearchRegistrationV1
        : null;

    // Audit single-flight finding: claim ownership BEFORE the first await
    // (`resolveStrategy` does an async `loadBuiltInStrategyByKey`). Pre-fix
    // two concurrent /run requests could both pass the `runOwner !== NONE`
    // gate above, both await resolveStrategy, then both try to claim — the
    // second stole ownership and the first stream cancelled. Claiming here
    // (synchronously, after the cheap input validation) makes the gate
    // authoritative; the `try/finally` releases ownership if a later step
    // throws before `processRunBatch` takes over.
    const owner = ++runOwnerGen;
    runOwner = owner;
    runOwnerRunId = runId;
    const runAbort = new AbortController();
    abortController = runAbort;
    try {
        // Audit Finding 5: if a scoped Stop arrived while this request was
        // still parsing/loading (before ownership was acquired), finish
        // cancelled instead of starting heavy work. Closes the
        // Stop-before-ownership race without an unbounded cancellation set.
        if (runId && consumePendingBatchStopForRun(runId)) {
            throw new HttpStatusError(409, "Batch run was stopped before it started.");
        }

        const strategy = await resolveStrategy(strategyKey);
        if (runOwner !== owner) {
            throw new HttpStatusError(409, "Batch run was stopped before it started.");
        }
        const strategyParams = (body.strategyParams ?? {}) as StrategyParams;
        const backtestSettings = (body.backtestSettings ?? {}) as BacktestSettings;
        const capitalSettings = (body.capitalSettings ?? {}) as CapitalSettings;
        const useRustEnginePreference = body.useRustEnginePreference === true;
        await releaseLastResults("new_run");
        if (runOwner !== owner) {
            throw new HttpStatusError(409, "Batch run was stopped before it started.");
        }
        lastRunFingerprint = null;
        lastRunInterval = null;
        lastRunStrategyKey = null;
        lastRunBacktestSettings = null;
        lastRunCapitalSettings = null;
        lastRunUseRustEnginePreference = false;
        lastRunCacheStats = null;

        let stream: ReturnType<typeof createDisconnectSafeStream> | null = null;
        try {
            // Audit Finding 4: disconnect-safe writer. A reload / closed tab flips
            // the internal flag and silently drops further writes; the job keeps
            // running and updating runState so a reloaded tab reattaches via
            // /status instead of the dead stream throwing into the run loop.
            stream = createDisconnectSafeStream(res);
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
                    // Phase 3 MAX_ACTIVE: carry the verified pair-list provenance
                    // and the research registration into the run so the snapshot
                    // and the OPEN_SCORE USD report can name the provenance status
                    // and label the report HOLDOUT vs EXPLORATORY.
                    pairListProvenance,
                    maxActiveResearchRegistration,
                    loadDataset: (sym, intv, signal) => loadServerBatchDataset(sym, intv, signal),
                },
                (event) => stream!.write(event),
                owner,
                runId,
            );
            stream.end();
        } catch (error) {
            if (!stream) throw error;
            const message = error instanceof Error ? error.message : String(error);
            try {
                stream.end({ type: "fatal", error: message, runId });
            } catch {
                /* best-effort */
            }
        } finally {
            if (abortController === runAbort) {
                abortController = null;
            }
        }
    } finally {
        // Release ownership only if THIS request still owns it. A normal run
        // completion leaves `runOwner === owner` until this fires; a Stop that
        // already force-bumped the lock leaves it on a newer owner — leave
        // that alone. The `processRunBatch` `finally` does NOT touch
        // `runOwner`, so this is the single release point.
        if (runOwner === owner) {
            runOwner = RUN_OWNER_NONE;
            runOwnerRunId = null;
        }
        if (abortController === runAbort) abortController = null;
    }
}

function rememberLocalApiOriginFromRequest(req: { headers?: Record<string, unknown>; socket?: { localAddress?: string; localPort?: number } | null }): void {
    // Derive the origin from the server's bound socket, not the spoofable Host
    // header (Finding 6). See `rememberLoopbackOriginFromRequest`.
    rememberLoopbackOriginFromRequest(req);
}

async function handleStopRequest(rawRunId?: unknown): Promise<{ ok: boolean; stopped: boolean }> {
    // Audit Finding 5: Stop is scoped by run id when the browser sends one.
    // A mismatched run id must NOT cancel the active run — a stale tab cannot
    // stop a newer run. The miner (Mine / Stability / Portfolio Fit) has no
    // runId in this contract; its locks are still force-reset so Stop remains
    // the recovery path for a stuck analysis job.
    const requestedRunId = parseBatchRunId(rawRunId);
    const runWasActive = runOwner !== RUN_OWNER_NONE;
    const minerWasActive = minerOwner !== RUN_OWNER_NONE;

    // During preflight the new request has already claimed `runOwner`, but
    // `runState` may still belong to the prior generation. Prefer the explicit
    // reservation so a matching Stop can cancel the new request reliably.
    const ownedRunId = runWasActive
        ? (runOwnerRunId ?? runState?.runId ?? "")
        : (runState?.runId ?? "");
    if ((runWasActive || minerWasActive) && ownedRunId && requestedRunId !== ownedRunId) {
        return { ok: false, stopped: false };
    }

    // Scoped Stop: if the browser sent a runId AND the active run has one,
    // they must match. A mismatch is a stale tab — reject without mutating
    // ownership so the active run is unaffected.
    // Run cancellation (scoped or legacy unscoped).
    if (runWasActive) {
        if (abortController) {
            try {
                abortController.abort();
            } catch {
                /* best-effort */
            }
        }
        runOwner = RUN_OWNER_NONE;
        runOwnerRunId = null;
    } else if (requestedRunId) {
        // Stop arrived before the matching run acquired ownership. Record the
        // run id so the run request finishes cancelled instead of starting
        // heavy work (Stop-before-ownership race closer). Single slot — only
        // the latest pending stop run id is retained.
        pendingStopRunId = requestedRunId;
    }

    // Miner force-reset: always cancels in-flight Mine / Stability / Portfolio
    // Fit so Stop stays the recovery path for a stuck analysis job. Target
    // loads swallow AbortError via the per-target try/catch.
    if (minerAbortController) {
        try {
            minerAbortController.abort();
        } catch {
            /* best-effort */
        }
    }
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

    let stream: ReturnType<typeof createDisconnectSafeStream> | null = null;
    try {
        // Audit Finding 4: disconnect-safe writer (see handleRunRequest).
        stream = createDisconnectSafeStream(res, { onDisconnect: () => cancelMinerOnDisconnect(owner) });
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

    let stream: ReturnType<typeof createDisconnectSafeStream> | null = null;
    try {
        // Audit Finding 4: disconnect-safe writer (see handleRunRequest).
        stream = createDisconnectSafeStream(res, { onDisconnect: () => cancelMinerOnDisconnect(owner) });
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

/**
 * Mine Prediction diagnostic. Mirrors the Stability Mine's ownership
 * / abort / read-only-on-artifacts pattern, but the compute is heavier:
 * re-runs the Mine engine at ~hundreds of historical bars per asset, so the
 * endpoint streams per-asset `progress` events. Does NOT call
 * `releaseLastResults` (read-only — Mine/Stability can still run
 * after it within the TTL window).
 *
 * Exported for direct invocation in tests.
 */
export async function processMinePrediction(
    fingerprint: string | null,
    interval: string | null,
    writer: MinerStreamWriter,
    owner: number,
    loadTargets: (pairArtifacts: readonly StoredMineArtifactMeta[], interval: string, signal?: AbortSignal) => Promise<BatchSyntheticTargetArtifact[]> = loadMinerTargets,
    sampleFromSec: number | null = null,
    sampleToSec: number | null = null,
    directionFilter: "both" | "long" | "short" = "both",
    sampleBars: number | null = null,
    sampleStep: number | null = null,
    horizons: number[] | null = null,
): Promise<void> {
    const artifactMetas = collectStoredMineArtifactMetas();
    if (artifactMetas.length === 0) {
        writer({ type: "fatal", error: "Run Batch before Mine Prediction; no artifacts on server." });
        return;
    }
    if (!fingerprint || fingerprint !== lastRunFingerprint || !interval) {
        writer({ type: "fatal", error: "Rerun Batch before Mine Prediction; settings or symbols changed." });
        return;
    }

    clearArtifactReleaseTimer();
    const lostOwnership = () => minerOwner !== owner;

    try {
        const targets = await loadTargets(artifactMetas, interval, minerAbortController?.signal);
        if (lostOwnership()) {
            writer({ type: "done", ok: false, cancelled: true, summary: "Mine Prediction cancelled." });
            return;
        }
        if (targets.length === 0) {
            writer({ type: "done", ok: false, cancelled: true, summary: "No target asset candles loaded." });
            return;
        }

        const artifacts = await Promise.all(artifactMetas.map(loadStoredMineArtifact));
        if (lostOwnership()) {
            writer({ type: "done", ok: false, cancelled: true, summary: "Mine Prediction cancelled." });
            return;
        }

        writer({ type: "start", assets: targets.length, pairs: artifactMetas.length });

        // Per-asset throttle state for onBarProgress (see comment below).
        const lastBarBucketSentByAsset = new Map<string, number>();

        const result = runMinePredictionDiagnostic({
            artifacts,
            targets,
            interval,
            strategyKey: lastRunStrategyKey,
            // Optional verdict-bar date window (unix seconds). Null/undefined
            // = sample full history. Lets the UI run regime-specific tests
            // (e.g. 2022 bear market) without a separate CLI invocation.
            ...(sampleFromSec !== null ? { sampleFromSec } : {}),
            ...(sampleToSec !== null ? { sampleToSec } : {}),
            // Direction filter: score only the chosen direction's verdicts.
            // Critical for long-only strategies — see engine docstring.
            directionFilter,
            // Sample density (null = engine defaults of 25/80). Lower step =
            // denser sampling for regime tests; higher sampleBars = tighter IC.
            ...(sampleBars !== null ? { sampleBars } : {}),
            ...(sampleStep !== null ? { sampleStep } : {}),
            ...(horizons !== null ? { horizons } : {}),
            onAssetProgress: (asset, samples, totalAssets, doneAssets) => {
                if (lostOwnership()) return;
                writer({ type: "progress", asset, samples, doneAssets, totalAssets });
            },
            // Throttle per-bar updates: emitting on every bar (25 x 24 = 600
            // writes) floods the stream. Emit at 0%, 25%, 50%, 75%, 100% of
            // each asset so the user sees live progress without the overhead.
            onBarProgress: (asset, barsDone, barsTotal) => {
                if (lostOwnership() || barsTotal <= 0) return;
                const frac = barsDone / barsTotal;
                // Emit when frac crosses each 0.25 boundary (or at the end).
                const bucket = Math.floor(frac * 4) / 4;
                const lastKey = lastBarBucketSentByAsset.get(asset) ?? -1;
                if (bucket > lastKey || barsDone >= barsTotal) {
                    lastBarBucketSentByAsset.set(asset, bucket);
                    writer({ type: "bar", asset, barsDone, barsTotal });
                }
            },
            shouldStop: () => lostOwnership(),
        });
        if (lostOwnership()) {
            writer({ type: "done", ok: false, cancelled: true, summary: "Mine Prediction cancelled." });
            return;
        }
        writer({ type: "done", ok: true, result });
        // Intentionally NO releaseLastResults — read-only on the artifact store.
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.mine_prediction.fatal", { error: message });
        writer({ type: "fatal", error: message });
    } finally {
        captureCurrentParsedCacheStats();
        if (hasStoredMineArtifacts()) {
            scheduleArtifactTtl();
        }
    }
}

async function handleMinePredictionRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "An analysis is already running. Use Stop first.");
    }
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is running. Use Stop first.");
    }
    if (!hasStoredMineArtifacts()) {
        throw new HttpStatusError(400, "Run Batch before Mine Prediction; no artifacts on server.");
    }
    const owner = ++minerOwnerGen;
    minerOwner = owner;
    minerAbortController = new AbortController();

    let stream: ReturnType<typeof createDisconnectSafeStream> | null = null;
    try {
        stream = createDisconnectSafeStream(res, { onDisconnect: () => cancelMinerOnDisconnect(owner) });
        // Parse optional verdict-bar date window (YYYY-MM-DD or ISO). Null when
        // absent or unparseable = sample full history.
        const parseBodyDateSec = (key: string): number | null => {
            const raw = body[key];
            if (typeof raw !== "string" || raw.trim() === "") return null;
            const ms = Date.parse(raw);
            return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
        };
        await processMinePrediction(
            typeof body.fingerprint === "string" ? body.fingerprint : null,
            typeof body.interval === "string" ? body.interval : lastRunInterval,
            (event) => stream!.write(event),
            owner,
            loadMinerTargets,
            parseBodyDateSec("sampleFrom"),
            parseBodyDateSec("sampleTo"),
            body.directionFilter === "long" || body.directionFilter === "short" ? body.directionFilter : "both",
            typeof body.sampleBars === "number" && body.sampleBars >= 5 ? Math.floor(body.sampleBars) : null,
            typeof body.sampleStep === "number" && body.sampleStep >= 1 ? Math.floor(body.sampleStep) : null,
            Array.isArray(body.horizons) && body.horizons.length > 0
                ? body.horizons.filter((h: unknown) => typeof h === "number" && h >= 1).map((h: number) => Math.floor(h))
                : null,
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
        minerAbortController = null;
    }
}

/**
 * Exposure & Redundancy report. Mirrors {@link processMinePrediction}'s
 * ownership / abort / read-only-on-artifacts pattern, but the compute is a
 * single pass: iterate stored artifacts ONE AT A TIME, snapshot the scalars
 * the engine needs (metadata, trade pnl, ratio closes), release the artifact,
 * then compute incidence + clusters + correlations. Does NOT call
 * `releaseLastResults` (read-only — Mine/Stability can still run after it
 * within the TTL window).
 *
 * CRITICAL: artifacts are loaded SEQUENTIALLY inside the async generator, NOT
 * via `Promise.all(metas.map(loadStoredMineArtifact))`. `Promise.all` would
 * load every artifact simultaneously and defeat the disk-backed parsed-artifact
 * LRU (`parsedCache`, capped at 32). Peak memory = 1 artifact + accumulated
 * scalar arrays.
 *
 * Exported for direct invocation in tests.
 */
export async function processExposureRedundancy(
    fingerprint: string | null,
    interval: string | null,
    writer: MinerStreamWriter,
    owner: number,
): Promise<void> {
    const artifactMetas = collectStoredMineArtifactMetas();
    if (artifactMetas.length === 0) {
        writer({ type: "fatal", error: "Run Batch before Exposure & Redundancy; no artifacts on server." });
        return;
    }
    if (!fingerprint || fingerprint !== lastRunFingerprint || !interval) {
        writer({ type: "fatal", error: "Rerun Batch before Exposure & Redundancy; settings or symbols changed." });
        return;
    }

    clearArtifactReleaseTimer();
    const lostOwnership = () => minerOwner !== owner;

    // Async generator: yields one artifact at a time so the engine never holds
    // the whole set. `lostOwnership` is checked before each load so a Stop
    // mid-iteration aborts the next disk read.
    async function* artifactLoader(): AsyncIterable<BatchSyntheticPairArtifact> {
        for (const meta of artifactMetas) {
            if (lostOwnership()) return;
            yield await loadStoredMineArtifact(meta);
        }
    }

    try {
        writer({ type: "start", pairs: artifactMetas.length });
        const result = await runExposureRedundancyReport(
            artifactLoader,
            (symbol, done) => {
                if (lostOwnership()) return;
                writer({ type: "progress", symbol, donePairs: done, totalPairs: artifactMetas.length });
            },
            () => lostOwnership(),
        );
        if (lostOwnership()) {
            writer({ type: "done", ok: false, cancelled: true, summary: "Exposure & Redundancy cancelled." });
            return;
        }
        writer({ type: "done", ok: true, result });
        // Intentionally NO releaseLastResults — read-only on the artifact store.
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.exposure_redundancy.fatal", { error: message });
        writer({ type: "fatal", error: message });
    } finally {
        captureCurrentParsedCacheStats();
        if (hasStoredMineArtifacts()) {
            scheduleArtifactTtl();
        }
    }
}

async function handleExposureRedundancyRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "An analysis is already running. Use Stop first.");
    }
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is running. Use Stop first.");
    }
    if (!hasStoredMineArtifacts()) {
        throw new HttpStatusError(400, "Run Batch before Exposure & Redundancy; no artifacts on server.");
    }
    const owner = ++minerOwnerGen;
    minerOwner = owner;
    minerAbortController = new AbortController();

    let stream: ReturnType<typeof createDisconnectSafeStream> | null = null;
    try {
        stream = createDisconnectSafeStream(res, { onDisconnect: () => cancelMinerOnDisconnect(owner) });
        await processExposureRedundancy(
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
        minerAbortController = null;
    }
}

/**
 * OPEN_SCORE USD Replay: reconstructs historical OPEN_SCORE decision events
 * from the retained Batch artifacts and asks whether picking the top positive
 * score asset (traded vs USD at the next bar's open) beat a uniform random
 * pick among the other positive candidates at the same event.
 *
 * Read-only on the artifact store (no releaseLastResults). Artifacts are loaded
 * ONE AT A TIME inside the async generator (never `Promise.all` over metas) so
 * peak memory stays at 1 artifact + accumulated scalar deltas; target datasets
 * are loaded one at a time and released after their event requests are consumed.
 *
 * Exported for direct invocation in tests.
 */
export async function processOpenScoreUsdReplay(
    fingerprint: string | null,
    interval: string | null,
    writer: MinerStreamWriter,
    owner: number,
    horizons: number[] | null,
    sampleFromSec: number | null = null,
    sampleToSec: number | null = null,
    loadTargetDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<unknown> = loadServerBatchDataset,
): Promise<void> {
    const artifactMetas = collectStoredMineArtifactMetas();
    if (artifactMetas.length === 0) {
        writer({ type: "fatal", error: "Run Batch before OPEN_SCORE USD; no artifacts on server." });
        return;
    }
    if (!fingerprint || fingerprint !== lastRunFingerprint || !interval || interval !== lastRunInterval) {
        writer({ type: "fatal", error: "Rerun Batch before OPEN_SCORE USD; settings or symbols changed." });
        return;
    }
    const runInterval: string = interval;
    const validHorizons = (horizons ?? []).filter((h) => Number.isFinite(h) && h >= 1).map((h) => Math.floor(h));
    if (validHorizons.length === 0) {
        writer({ type: "fatal", error: "OPEN_SCORE USD requires at least one positive bar horizon." });
        return;
    }
    if (sampleFromSec !== null && sampleToSec !== null && sampleFromSec > sampleToSec) {
        writer({ type: "fatal", error: "OPEN_SCORE USD date window is reversed; From must not be after To." });
        return;
    }
    if (!lastRunBacktestSettings || !lastRunCapitalSettings) {
        writer({ type: "fatal", error: "Rerun Batch before OPEN_SCORE USD; retained Batch cost settings are unavailable." });
        return;
    }
    // Slippage/commission come from the RETAINED Batch settings (the same ones
    // the artifacts were produced under), not bespoke request fields. This
    // mirrors backtest-engine.ts: slippageRate = slippageBps/10000,
    // commissionRate = commissionPercent/100. Bespoke UI rate inputs would
    // drift from the run's actual execution-cost assumptions.
    const slippageRate = (lastRunBacktestSettings.slippageBps ?? 0) / 10000;
    const commissionRate = (lastRunCapitalSettings.commission ?? 0) / 100;

    clearArtifactReleaseTimer();
    const lostOwnership = () => minerOwner !== owner;
    const startedAt = Date.now();
    debugLogger.info("batch.server.open_score_usd.start", { pairs: artifactMetas.length, horizons: validHorizons });

    // Async generator: yields one artifact at a time (peak memory = 1 artifact).
    // A disk-read failure for ONE pair must NOT abort the entire analysis —
    // yield a tombstone with no trades so the engine counts it as omitted and
    // continues. The aggregate report surfaces omittedPairs.
    async function* artifactLoader(): AsyncIterable<BatchSyntheticPairArtifact> {
        for (const meta of artifactMetas) {
            if (lostOwnership()) return;
            try {
                yield await loadStoredMineArtifact(meta);
            } catch (error) {
                if (minerAbortController?.signal?.aborted || lostOwnership()) return;
                debugLogger.warn("batch.server.open_score_usd.artifact_load_failed", {
                    symbol: meta.symbol, error: error instanceof Error ? error.message : String(error),
                });
                yield {
                    symbol: meta.symbol,
                    baseAsset: meta.baseAsset,
                    quoteAsset: meta.quoteAsset,
                    baseSymbol: meta.baseSymbol,
                    quoteSymbol: meta.quoteSymbol,
                    data: [],
                    signals: [],
                    result: createEmptyBacktestResult(),
                } as BatchSyntheticPairArtifact;
            }
        }
    }

    // Resolve the marked target symbol for each asset from artifact metadata,
    // then yield one target dataset at a time so it is released after use.
    const markedSymbolByAsset = new Map<string, string>();
    const assetSet = new Set<string>();
    for (const meta of artifactMetas) {
        for (const [asset, symbol] of [
            [meta.baseAsset, meta.baseSymbol],
            [meta.quoteAsset, meta.quoteSymbol],
        ] as const) {
            const key = asset?.trim().toUpperCase();
            if (!key) continue;
            assetSet.add(key);
            if (symbol && !markedSymbolByAsset.has(key)) markedSymbolByAsset.set(key, symbol);
        }
    }
    const assets = Array.from(assetSet).sort();

    async function* targetLoader(): AsyncIterable<OpenScoreUsdTarget> {
        for (const asset of assets) {
            if (lostOwnership()) return;
            const symbol = markedSymbolByAsset.get(asset) ?? resolveBatchSyntheticTargetSymbol(asset);
            try {
                const data = (await loadTargetDataset(symbol, runInterval, minerAbortController?.signal)) as BatchSyntheticTargetArtifact["data"] | null;
                if (Array.isArray(data) && data.length > 0) {
                    yield { asset, symbol, data };
                }
            } catch (error) {
                if (minerAbortController?.signal?.aborted || lostOwnership()) return;
                debugLogger.warn("batch.server.open_score_usd.target_load_failed", {
                    asset, symbol, error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    let lastPhase = "";
    try {
        writer({ type: "start", pairs: artifactMetas.length, assets: assets.length, horizons: validHorizons });
        const result = await runOpenScoreUsdReplay(
            artifactLoader,
            targetLoader,
            {
                horizons: validHorizons,
                interval: runInterval,
                ...(sampleFromSec !== null ? { sampleFromSec } : {}),
                ...(sampleToSec !== null ? { sampleToSec } : {}),
                slippageRate,
                commissionRate,
                // Phase 3 MAX_ACTIVE: thread the canonical submitted degree
                // map from the retained Batch run state. The engine uses this
                // to drive the MAX_SUBMITTED selector distinct from
                // MAX_RETAINED (which counts loaded-artifact legs).
                ...(runState?.universeCounts?.submittedDegreeByAsset
                    ? { submittedDegreeByAsset: runState.universeCounts.submittedDegreeByAsset }
                    : {}),
                shouldStop: () => lostOwnership(),
                onPhase: (phase, detail, completed, total) => {
                    if (lostOwnership()) return;
                    const elapsedMs = Date.now() - startedAt;
                    if (phase !== lastPhase) {
                        lastPhase = phase;
                        debugLogger.info("batch.server.open_score_usd.phase", { phase, detail, completed, total });
                        writer({ type: "phase", phase, detail, completed, total, elapsedMs });
                    } else {
                        writer({ type: "progress", phase, detail, completed, total, elapsedMs });
                    }
                },
            },
        );
        if (lostOwnership()) {
            writer({ type: "done", ok: false, cancelled: true, summary: "OPEN_SCORE USD cancelled." });
            return;
        }
        debugLogger.info("batch.server.open_score_usd.complete", {
            pairs: result.pairs, assets: result.assets, events: result.totalEvents,
            eligible: result.eligibleEvents, complete: result.complete,
        });
        writer({ type: "done", ok: true, result });
        // Intentionally NO releaseLastResults — read-only on the artifact store.
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.open_score_usd.fatal", { error: message });
        writer({ type: "fatal", error: message });
    } finally {
        captureCurrentParsedCacheStats();
        if (hasStoredMineArtifacts()) {
            scheduleArtifactTtl();
        }
    }
}

async function handleOpenScoreUsdRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "An analysis is already running. Use Stop first.");
    }
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is running. Use Stop first.");
    }
    if (!hasStoredMineArtifacts()) {
        throw new HttpStatusError(400, "Run Batch before OPEN_SCORE USD; no artifacts on server.");
    }
    const owner = ++minerOwnerGen;
    minerOwner = owner;
    minerAbortController = new AbortController();

    const parseBodyDateSec = (key: string, endOfDay = false): number | null => {
        const raw = body[key];
        if (typeof raw !== "string" || raw.trim() === "") return null;
        // YYYY-MM-DD parses as UTC midnight. For "sampleFrom" that's fine; for
        // "sampleTo" we add 24h-1s so the entire selected day is included
        // (otherwise most of the chosen day's events were excluded).
        const ms = Date.parse(raw);
        if (!Number.isFinite(ms)) return null;
        return Math.floor(ms / 1000) + (endOfDay ? 24 * 3600 - 1 : 0);
    };

    let stream: ReturnType<typeof createDisconnectSafeStream> | null = null;
    try {
        stream = createDisconnectSafeStream(res, { onDisconnect: () => cancelMinerOnDisconnect(owner) });
        await processOpenScoreUsdReplay(
            typeof body.fingerprint === "string" ? body.fingerprint : null,
            lastRunInterval,
            (event) => stream!.write(event),
            owner,
            Array.isArray(body.horizons) && body.horizons.length > 0
                ? body.horizons.filter((h: unknown) => typeof h === "number" && h >= 1).map((h: number) => Math.floor(h))
                : null,
            parseBodyDateSec("sampleFrom", false),
            parseBodyDateSec("sampleTo", true),
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
        minerAbortController = null;
    }
}

/**
 * Mine A/B Test: re-runs each pair's backtest with signals filtered to only
 * Mine-LONG-gated entries, compares P&L vs control (all entries). Read-only
 * on artifacts — does NOT release them.
 */
export async function processMineAb(
    fingerprint: string | null,
    interval: string | null,
    writer: MinerStreamWriter,
    owner: number,
    loadTargets: (pairArtifacts: readonly StoredMineArtifactMeta[], interval: string, signal?: AbortSignal, baseOnly?: boolean, onAssetProgress?: (asset: string, doneAssets: number, totalAssets: number) => void) => Promise<BatchSyntheticTargetArtifact[]> = loadMinerTargets,
): Promise<void> {
    const artifactMetas = collectStoredMineArtifactMetas();
    if (artifactMetas.length === 0) {
        writer({ type: "fatal", error: "Run Batch before Mine A/B Test; no artifacts on server." });
        return;
    }
    if (!fingerprint || fingerprint !== lastRunFingerprint || !interval) {
        writer({ type: "fatal", error: "Rerun Batch before Mine A/B Test; settings or symbols changed." });
        return;
    }
    if (!lastRunBacktestSettings || !lastRunCapitalSettings) {
        writer({ type: "fatal", error: "Rerun Batch before Mine A/B Test; original run settings are unavailable." });
        return;
    }

    clearArtifactReleaseTimer();
    const lostOwnership = () => minerOwner !== owner;

    try {
        // Emit this before any dataset I/O. Previously the client stayed on
        // its initial text until every base+quote asset had loaded.
        writer({ type: "start", pairs: artifactMetas.length });
        const targets = await loadTargets(
            artifactMetas,
            interval,
            minerAbortController?.signal,
            true,
            (asset, doneAssets, totalAssets) => {
                if (!lostOwnership()) writer({ type: "target-progress", asset, doneAssets, totalAssets });
            },
        );
        if (lostOwnership()) {
            writer({ type: "done", ok: false, cancelled: true, summary: "Mine A/B Test cancelled." });
            return;
        }
        if (targets.length === 0) {
            writer({ type: "done", ok: false, cancelled: true, summary: "No target asset candles loaded." });
            return;
        }

        writer({ type: "progress", symbol: "Loading pair artifacts...", donePairs: 0, totalPairs: artifactMetas.length });
        // Do not start hundreds of reads/deserializations at once. V8's
        // deserialize step is synchronous after each read and an unbounded
        // Promise.all made the event loop appear hung while retaining every
        // decoded row simultaneously. Eight in-flight artifacts keeps disk
        // throughput high and lets the browser receive progress events.
        let loadedArtifactCount = 0;
        const loadedArtifacts = await mapWithConcurrencyLimit(
            artifactMetas,
            8,
            async (meta) => {
                let artifact: BatchSyntheticPairArtifact | null = null;
                let failure: string | null = null;
                try {
                    artifact = await loadStoredMineArtifactBounded(meta);
                    if (artifact === null) failure = "timeout";
                } catch (error) {
                    failure = error instanceof Error ? error.message : String(error);
                }
                loadedArtifactCount += 1;
                if (!lostOwnership()) {
                    writer({
                        type: "progress",
                        symbol: failure ? `Artifact ${meta.symbol} skipped (${failure})` : "Loading pair artifacts...",
                        donePairs: loadedArtifactCount,
                        totalPairs: artifactMetas.length,
                    });
                }
                return artifact;
            },
        );
        const artifacts = loadedArtifacts.filter((artifact): artifact is BatchSyntheticPairArtifact => artifact !== null);
        if (lostOwnership()) {
            writer({ type: "done", ok: false, cancelled: true, summary: "Mine A/B Test cancelled." });
            return;
        }

        writer({ type: "progress", symbol: "Preparing Mine pair state...", donePairs: artifacts.length, totalPairs: artifactMetas.length });
        // Let the NDJSON writer flush the final load progress before the
        // synchronous ATR/trade-index preparation begins in the leaf.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const result = await runMineAbTest({
            artifacts,
            targets,
            interval,
            strategyKey: lastRunStrategyKey,
            backtestSettings: lastRunBacktestSettings,
            capitalSettings: lastRunCapitalSettings,
            useRustEnginePreference: lastRunUseRustEnginePreference,
            expectedPairs: artifactMetas.length,
            onPairProgress: (symbol, donePairs, totalPairs) => {
                if (lostOwnership()) return;
                writer({ type: "progress", symbol, donePairs, totalPairs });
            },
            shouldStop: () => lostOwnership(),
        });
        if (lostOwnership()) {
            writer({ type: "done", ok: false, cancelled: true, summary: "Mine A/B Test cancelled." });
            return;
        }
        writer({ type: "done", ok: true, result });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.mine_ab.fatal", { error: message });
        writer({ type: "fatal", error: message });
    } finally {
        if (hasStoredMineArtifacts()) {
            scheduleArtifactTtl();
        }
    }
}

async function handleMineAbRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "An analysis is already running. Use Stop first.");
    }
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is running. Use Stop first.");
    }
    if (!hasStoredMineArtifacts()) {
        throw new HttpStatusError(400, "Run Batch before Mine A/B Test; no artifacts on server.");
    }
    const owner = ++minerOwnerGen;
    minerOwner = owner;
    minerAbortController = new AbortController();

    let stream: ReturnType<typeof createDisconnectSafeStream> | null = null;
    try {
        stream = createDisconnectSafeStream(res, { onDisconnect: () => cancelMinerOnDisconnect(owner) });
        await processMineAb(
            typeof body.fingerprint === "string" ? body.fingerprint : null,
            typeof body.interval === "string" ? body.interval : lastRunInterval,
            (event) => stream!.write(event),
            owner,
            loadMinerTargets,
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
        minerAbortController = null;
    }
}

function handleStatusRequest(afterRow = 0, limitRaw?: number, requestedRunId?: string): unknown {
    // Audit runId-scoping finding: a paginated drain that started against run
    // generation A must NOT receive rows from generation B (started by another
    // tab while A was being drained). When the caller supplies a runId and it
    // no longer matches the retained snapshot, return an explicit mismatch
    // signal (HTTP 200) so the browser stops paginating and drops the run
    // instead of stitching together rows from two generations. An empty/absent
    // runId preserves the legacy behavior (legacy browser bundle, or the
    // internal `refreshServerArtifactState` probe that intentionally queries
    // the latest server state without scoping).
    if (
        requestedRunId
        && runState
        && runState.runId
        && runState.runId !== requestedRunId
    ) {
        return {
            ok: true,
            runMismatch: true,
            running: false,
            run: null,
            lastRun: null,
            miner: null,
        };
    }
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
                // Surface phase/summary on the in-progress branch too so a tab
                // polling /status sees a consistent shape before and after the
                // run completes. `phase === "running"` here.
                phase: runState.phase,
                summary: runState.summary,
                // Audit Finding 5: runId lets a reloaded tab reconcile that
                // THIS run is still the one it started.
                runId: runState.runId,
            }
            : null,
        // Audit Finding 6: expose the terminal snapshot whenever a run has
        // finished (runOwner is NONE) and runState is retained — INDEPENDENTLY
        // of artifact availability. The previous gate
        // (`hasStoredMineArtifacts() && runState`) hid fatal/no-artifact runs
        // from /status after a reload, making long-running failures
        // undiagnosable. `hasArtifacts` remains a separate capability flag so
        // the browser can still gate the Mine button on it.
        //
        // `rowCount` here is the true scalar row count (`runState.rows.length`),
        // matching its meaning on the `run` branch; the artifact count stays
        // available via `hasArtifacts` + Mine APIs.
        lastRun: runState && runOwner === RUN_OWNER_NONE
            ? {
                interval: lastRunInterval ?? runState.interval,
                strategyKey: lastRunStrategyKey ?? runState.strategyKey,
                fingerprint: lastRunFingerprint,
                rowCount,
                hasArtifacts: hasStoredMineArtifacts(),
                cacheStats: lastRunCacheStats,
                rows,
                rowOffset,
                nextOffset,
                // Terminal-only fields. A reloaded tab recovers the failure
                // reason and the terminal summary here without a live stream.
                phase: runState.phase,
                finishedAt: runState.finishedAt,
                summary: runState.summary,
                error: runState.error,
                startedAt: runState.startedAt,
                total: runState.total,
                completed: runState.completed,
                failed: runState.failed,
                cancelled: runState.cancelled,
                // Audit Finding 5: runId so the browser can match the
                // terminal snapshot to the run it started (and decide whether
                // to adopt it on reattach).
                runId: runState.runId,
                // Audit artifact-stats / parse-cache findings: surface the
                // partial-write + LRU snapshots so a reloaded tab sees the same
                // diagnostics the stream would have carried.
                artifactStats: runState.artifactStats ?? null,
                parsedCacheStats: runState.parsedCacheStats ?? null,
                // Phase 3 MAX_ACTIVE: pair-list provenance + universe counts +
                // research registration metadata. Bounded scalars only.
                pairListProvenanceMeta: runState.pairListProvenanceMeta ?? null,
                universeCounts: runState.universeCounts ?? null,
                researchRegistrationMeta: runState.researchRegistrationMeta ?? null,
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
    return {
        name: "batch-backtest",
        configureServer(server) {
            // Best-effort: sweep orphaned dirs from a prior crash without
            // blocking dev-server registration (audit Finding 4).
            void sweepOrphanedMineArtifactDirs();
            registerBatchRoutes(server.middlewares);
        },
        configurePreviewServer(server) {
            void sweepOrphanedMineArtifactDirs();
            registerBatchRoutes(server.middlewares);
        },
    };
}

/** Install all Batch routes; exposed through test internals for route tests. */
function registerBatchRoutes(middlewares: any): void {
        middlewares.use("/api/batch-backtest/run", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            // Audit Finding 2: gate mutations on the same loopback/bearer
            // policy the IBKR and strategy-admin routes enforce, so a Vite
            // server exposed via --host / tunnel / reverse proxy can't be
            // driven into CPU-heavy 1000-pair backtests remotely.
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleRunRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/stop", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            // Audit Finding 2: gate Stop too — an unauthenticated remote caller
            // must not be able to cancel a long-running batch.
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            try {
                // Audit Finding 5: read the optional runId so Stop can be
                // scoped. Empty bodies remain valid for legacy server state;
                // malformed JSON and invalid ids fail closed as client errors.
                const body = await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES);
                const result = await handleStopRequest((body as { runId?: unknown })?.runId);
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
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleMineRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/stability-mine", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleStabilityMineRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });
        middlewares.use("/api/batch-backtest/mine-prediction", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleMinePredictionRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/mine-prediction-ab", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleMineAbRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/exposure-redundancy", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleExposureRedundancyRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/open-score-usd", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleOpenScoreUsdRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/status", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            // Status exposes run inputs, progress, results, and miner state.
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: batch routes are local-only." });
                return;
            }
            const parsedUrl = new URL(req.url ?? "/api/batch-backtest/status", "http://localhost");
            const after = Number(parsedUrl.searchParams.get("after") ?? 0);
            const limitParam = parsedUrl.searchParams.get("limit");
            const limit = limitParam === null ? undefined : Number(limitParam);
            // Audit runId-scoping finding: optional `?runId=` so a paginated
            // drain is scoped to one generation. Empty/absent preserves legacy
            // behavior (the server cannot distinguish an old browser bundle
            // from a probe, and an unmatched id returns runMismatch).
            const runIdParam = parsedUrl.searchParams.get("runId");
            const runId = runIdParam && runIdParam.trim() ? runIdParam.trim() : undefined;
            sendJson(res, 200, handleStatusRequest(after, limit, runId));
        });
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
    getParsedArtifactCacheSizeForTests(): number {
        return currentArtifactStore?.parsedCache.size ?? 0;
    },
    /**
     * Audit parse-cache finding: snapshot of the active store's LRU counters
     * (or null when no store is active). Used by tests to assert eviction and
     * hit-rate behavior without poking internal state directly.
     */
    getParsedArtifactCacheStatsForTests(): { size: number; max: number; hits: number; misses: number; evictions: number; peak: number } | null {
        return currentArtifactStore ? currentArtifactStore.parsedCacheStats() : null;
    },
    /**
     * Audit artifact-stats finding: snapshot of the active store's write
     * counters (or null when no store is active). Used by tests to assert
     * partial-write handling without poking internal state directly.
     */
    getArtifactStatsForTests(): { eligible: number; stored: number; failed: number; bytesWritten: number } | null {
        return currentArtifactStore ? currentArtifactStore.artifactStats() : null;
    },
    DEFAULT_ARTIFACT_RETENTION_MS,
    handleStatusRequest,
    handleStopRequest,
    registerBatchRoutesForTests: registerBatchRoutes,
    processMinePrediction,
    processMineAb,
    processExposureRedundancy,
    processOpenScoreUsdReplay,
    // Audit Finding 5 test seams.
    parseBatchRunId,
    consumePendingBatchStopForRun,
    setPendingStopRunIdForTests(runId: string | null): void {
        pendingStopRunId = runId;
    },
    getPendingStopRunIdForTests(): string | null {
        return pendingStopRunId;
    },
    setRunReservationForTests(owner: number, runId: string | null): void {
        runOwner = owner;
        runOwnerRunId = runId;
    },
    getRunOwnerForTests(): number {
        return runOwner;
    },
    // Audit Finding 7 test seams.
    shouldSweepOrphanEntryForTests: shouldSweepOrphanEntry,
    MINE_ARTIFACT_DIR_PREFIX_FOR_TESTS: MINE_ARTIFACT_DIR_PREFIX,
    ORPHAN_SWEEP_STALE_MS_FOR_TESTS: ORPHAN_SWEEP_STALE_MS,
    setRetainedStabilityResultForTests(stability: BatchStabilityMineResult | null): void {
        retainedStabilityResult = stability;
    },
    getRetainedStabilityResultForTests(): BatchStabilityMineResult | null {
        return retainedStabilityResult;
    },
    hasArtifactReleaseTimerForTests(): boolean {
        return artifactReleaseTimer !== null;
    },
    setRunOwnerForTests(owner: number): void {
        runOwner = owner;
        if (owner === RUN_OWNER_NONE) {
            runOwnerRunId = null;
            runState = null;
            // Clear the pending-stop slot too so a prior test's Stop marker
            // can't make the next test's run finish cancelled (audit F5).
            pendingStopRunId = null;
        }
    },
    /**
     * Simulate the production HTTP handler's `finally` for a completed run:
     * release ownership (`runOwner = NONE`) but PRESERVE `runState` as the
     * `lastRun` snapshot for status reattach / recovery. This is the faithful
     * post-completion state; `setRunOwnerForTests(0)` additionally nulls
     * `runState` (a stricter reset that some tests rely on for isolation), so
     * it cannot be used to test the completed-run `lastRun` branch.
     */
    completeRunForTests(): void {
        runOwner = RUN_OWNER_NONE;
        runOwnerRunId = null;
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
     * Set `runState` directly so a test can exercise the /status presentation
     * of a terminal snapshot (phase/finishedAt/summary/error — audit Finding 6)
     * without having to trigger a real fatal path through the runner, which
     * converts most errors into per-symbol `load_failed` rows rather than a
     * thrown fatal. Mirrors the Finder plugin's `setRunStateForTests`.
     */
    setRunStateForTests(snapshot: BatchRunSnapshot | null): void {
        runState = snapshot;
    },
    /**
     * Toggle the parallel-Stability gate during tests. It defaults true in
     * production, but tests that need the sequential TypeScript path (e.g. to
     * lock the non-parallel merge) opt OUT. Always restore via
     * resetMinerGatesForTests() in finally so a toggled gate cannot leak.
     */
    setMinerGatesForTests(args: { parallelStability?: boolean }): void {
        if (args.parallelStability !== undefined) BATCH_MINER_PARALLEL_STABILITY_ENABLED = args.parallelStability;
    },
    resetMinerGatesForTests(): void {
        BATCH_MINER_PARALLEL_STABILITY_ENABLED = BATCH_MINER_PARALLEL_STABILITY_ENABLED_DEFAULT;
    },
    // --- Audit Finding 3 / follow-up R-F1 generation-safety test seams ---
    /**
     * Get the current generation's ArtifactStore so a test can drive the write
     * path (including its backpressure gate) directly. Returns null when no run
     * is active.
     */
    getArtifactStoreForTests(): ArtifactStore | null {
        return currentArtifactStore;
    },
    /**
     * Push a controllable pending write into the current store so a test can
     * pause `releaseLastResults` mid-flush. Creates a store if none exists,
     * mirroring the production run-start path.
     */
    pushPendingArtifactWriteForTests(write: Promise<void>): void {
        if (!currentArtifactStore) currentArtifactStore = new ArtifactStore();
        currentArtifactStore.pendingWrites.push(write);
    },
    /** Read the current generation's dir so a test can assert detach timing. */
    getMineArtifactDirForTests(): string | null {
        return currentMineArtifactDir();
    },
    /** Install a fresh store+dir for the new-generation race scenario. */
    ensureMineArtifactDirForTests(): string {
        return ensureCurrentArtifactStoreDir();
    },
};
