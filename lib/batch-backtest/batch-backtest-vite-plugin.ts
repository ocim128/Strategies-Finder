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
 * per-row artifacts (`data` + `signals` + `result.trades`) for the
 * OPEN_SCORE USD Replay step. That workload OOMs a browser tab; Node can use
 * main RAM directly. The browser tab keeps only rendered scalars and DOM rows.
 *
 * Memory contract: the plugin writes per-row analysis artifacts to a temp
 * directory until one of three release triggers fires:
 *   1. A new Run starting (`POST /run` removes the prior artifact directory).
 *   2. A bounded TTL (default 10 minutes after the Run's `done` event with no
 *      analysis click) so a user who walks away doesn't leave ~5 GB pinned.
 *   3. Explicit Stop / fatal handling.
 *
 * The browser path got release (2) for free via tab reload; the server path
 * needs it explicitly.
 */

import type { Plugin } from "vite";
import { deserialize, serialize } from "node:v8";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLogger } from "../debug-logger";
import { createDisconnectSafeStream, HttpStatusError, registerLocalJsonRoute, sendJson, type ViteHttpResponse } from "../vite-http-utils";
import { FINDER_BATCH_MAX_BODY_BYTES } from "../server-request-limits";
import { runBatchBacktest, type BatchBacktestRunInput, type BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { clearServerBatchDatasetCaches, getServerBatchDatasetCacheStats, loadServerBatchDataset } from "./server-batch-data-loader";
import {
    TRADE_LEDGER_DEFAULT_FOLDER,
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_VERSION,
    buildTradeLedgerRowsForPair,
    sanitizeTradeLedgerFolder,
    TradeLedgerWriter,
    type TradeLedgerFinalizeResult,
    type TradeLedgerProvenance,
    type TradeLedgerRow,
    type TradeLedgerRowContext,
    type TradeLedgerRunOptions,
} from "./trade-ledger-exporter";
import { resolveLedgerSweepFolder, resolveLedgerSweepRule } from "./trade-ledger-sweep-catalog";
import { toTradeGateFeatureRow, tradeGateSignalKey, type TradeGateFeatureRow } from "./trade-ledger-features";
import { createTradeGateStats, addTradeGateStats, type TradeGate, type TradeGatePairContext, type TradeGateProvenance, type TradeGateStats } from "./trade-gate";
import { createTradeGateRuleLoaderRun, type TradeGateRuleLoaderRun } from "./trade-gate-rule-loader";
import type { TradeGateRunOptions } from "./trade-gate-wire";
import {
    buildAsIfPairModel,
    evaluateReplayEligibility,
} from "./trade-ledger-asif";
import { resolveExecutorBacktestSettings } from "../backtest-executor";
import type {
    BatchSyntheticPairArtifact,
} from "./batch-synthetic-artifact";
import { parsePortfolioSyntheticPairSymbol } from "../synthetic-pair-parser";
import { loadBuiltInStrategyByKey } from "../../strategyRegistry";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import { toScalarRow, type BatchStatusResponse, type BatchStreamEvent } from "./batch-backtest-stream-types";
import { rememberLoopbackOriginFromRequest } from "../local-api-transport";
import { buildBatchRunFingerprint, normalizeBatchSymbols, BATCH_MAX_SYMBOLS, validateBatchSymbols, verifyPairListProvenance, type BatchRunPairListProvenanceMeta, type BatchUniverseCounts } from "./batch-run-contract";
import { fnv1a64Hex, type MaxActiveResearchRegistrationV1 } from "./max-active-research-contract";
import { canonicalizeLegIdentity } from "../synthetic-leg-identity";
import type { PairListProvenanceV1 } from "./balanced-pair-list-generator";
import { runOpenScoreUsdReplay, type OpenScoreUsdTarget } from "./batch-open-score-usd-replay-engine";
import { createEmptyBacktestResult } from "../strategies/backtest/position-stats";
import { registerSp500TopMeanRoutes, type BatchOwnerLocks } from "./sp500-top-mean-vite-routes";
import { isValidRunId } from "./sp500-top-mean-artifact-store";
import { getV8HeapLimitMb, resolveServerHeapWarning } from "../server-heap-guard";
import { releaseIfOwner as releaseResearchWorkloadIfOwner, tryAcquire as tryAcquireResearchWorkload } from "../server-research-job-coordinator";

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
 * Max concurrent `writeFile` calls for analysis artifact persistence. Each artifact
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
 * Caps for the OPEN_SCORE USD Replay `horizons` input. The route is reachable
 * via the documented Cloudflare-tunnel / LOCAL_PROXY_TOKEN path and accepts no
 * symbols (so `BATCH_MAX_SYMBOLS` does not gate it). Without these caps a
 * single request with a million-entry `horizons` array (or one huge horizon)
 * triggers a million-horizon replay across every retained artifact. The
 * browser UI only ever sends a handful of small horizons, so these caps are
 * invisible to legitimate callers.
 */
const OPEN_SCORE_HORIZONS_MAX_LENGTH = 8;
const OPEN_SCORE_HORIZONS_MAX_VALUE = 1000;

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
        // Status polling hits this every ~2s during reattach. `collectMetas`
        // filters `metas` (which can be sparse after a failed write); reuse
        // the same defined-ness test but short-circuit on the first hit so a
        // 1000-pair run does not allocate a 1000-entry array per poll.
        for (let i = 0; i < this.metas.length; i += 1) {
            if (this.metas[i]) return true;
        }
        return false;
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
let analysisOwner = RUN_OWNER_NONE;
let analysisOwnerGen = 0;

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
let lastRunCacheStats: BatchDatasetCacheStats | null = null;
let abortController: AbortController | null = null;
// Abort controller for in-flight OPEN_SCORE USD target dataset loads.
// Mirrors `abortController` (Run path): created when an analysis starts,
// aborted in `handleStopRequest`, nulled in the handler's `finally`. The
// server-side target loader forwards this signal to `loadServerBatchDataset`,
// which already accepts an optional AbortSignal — so Stop now cancels up to
// `TARGET_LOAD_CONCURRENCY` (=8) target loads that would otherwise keep
// running after the user clicks Stop.
let analysisAbortController: AbortController | null = null;
let artifactReleaseTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Root directory for trade-ledger export folders (Batch "Save trade ledger").
 * Set from `server.config.root` at plugin registration so launching Vite from
 * another working directory cannot write the ledger into the wrong archive;
 * falls back to the process working directory for direct `processRunBatch`
 * test invocations.
 */
let ledgerRootDir: string | null = null;

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
    // Character-class guard: a run id is an opaque ownership token, never a
    // path. Reject separators / `..` / any other escape attempt early so the
    // value can never be misused if a future route threads it into a path.
    // Legitimate browser ids (`batch-<ts36>-<rand>`) already match.
    if (!isValidRunId(trimmed)) {
        throw new HttpStatusError(400, "runId contains invalid characters.");
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
    /** Gate folder/sweep/rule hashes used by the server-side run. */
    tradeGateProvenance?: TradeGateProvenance | null;
    /** Aggregate gate counters across completed pair results. */
    tradeGateStats?: TradeGateStats | null;
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
 * Release the per-row artifacts retained for OPEN_SCORE USD analysis. Mirrors the
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
    lastRunCacheStats = null;

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

export function resolveServerBatchHeapWarning(symbolCount: number, heapLimitMb = getV8HeapLimitMb()): string | null {
    return resolveServerHeapWarning(
        symbolCount,
        heapLimitMb,
        "Batch",
        "Restart the app with run_playground.bat, or run: set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev",
    );
}

// ---------------------------------------------------------------------------
// Trade ledger (Batch "Save trade ledger" toggle — pure side artifact)
// ---------------------------------------------------------------------------

/**
 * Parse the optional `tradeLedger` body field. Null when absent/disabled. A
 * PRESENT enabled toggle with an unsafe folder is a client error (400) rather
 * than a silent fallback so a typo'd path is visible.
 */
const MAX_TRADE_GATE_RULES = 16;

function parseTradeGateOptions(raw: unknown): TradeGateRunOptions | null {
    if (!raw || typeof raw !== "object") return null;
    if ((raw as { enabled?: unknown }).enabled !== true) return null;
    const folderId = (raw as { folderId?: unknown }).folderId;
    const ruleIds = (raw as { ruleIds?: unknown }).ruleIds;
    if (typeof folderId !== "string" || !folderId.trim() || folderId.includes("/") || folderId.includes("\\")) {
        throw new HttpStatusError(400, "Trade Gate requires a safe ledger folder id.");
    }
    if (!Array.isArray(ruleIds) || ruleIds.length < 1 || ruleIds.length > MAX_TRADE_GATE_RULES) {
        throw new HttpStatusError(400, `Trade Gate requires 1-${MAX_TRADE_GATE_RULES} rule ids.`);
    }
    const cleaned: string[] = [];
    for (const value of ruleIds) {
        if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value) || cleaned.includes(value)) {
            throw new HttpStatusError(400, "Trade Gate rule ids must be unique safe filenames.");
        }
        cleaned.push(value);
    }
    return { enabled: true, folderId: folderId.trim(), ruleIds: cleaned };
}

interface ResolvedTradeGate {
    gate: TradeGate;
    loaderRun: TradeGateRuleLoaderRun;
}

async function resolveTradeGate(
    serverRoot: string,
    options: TradeGateRunOptions,
): Promise<ResolvedTradeGate> {
    const loaderRun = await createTradeGateRuleLoaderRun();
    try {
        const folder = await resolveLedgerSweepFolder(serverRoot, options.folderId);
        if (!folder) throw new Error(`Trade Gate ledger folder not found: ${options.folderId}.`);
        if (!folder.entry.runnable) {
            throw new Error(`Trade Gate ledger folder is not runnable: ${folder.entry.refusalReason ?? "unknown reason"}.`);
        }
        const latestSweep = folder.entry.latestSweep;
        if (!latestSweep) throw new Error(`Trade Gate folder has no completed sweep: ${options.folderId}.`);
        const edgeRules = new Map(latestSweep.edgeRules.map((rule) => [rule.ruleId, rule]));
        const rules: Array<TradeGate["rules"][number]> = [];
        for (const ruleId of options.ruleIds) {
            const edgeRule = edgeRules.get(ruleId);
            if (!edgeRule) {
                throw new Error(`Trade Gate rule ${ruleId} is not an EDGE-CANDIDATE in the latest sweep ${latestSweep.sweepId}.`);
            }
            const resolved = await resolveLedgerSweepRule(serverRoot, ruleId);
            if (!resolved || resolved.entry.sourceHash !== edgeRule.sourceHash) {
                throw new Error(`Trade Gate rule ${ruleId} changed after sweep ${latestSweep.sweepId}; rerun the sweep.`);
            }
            const source = await readFile(resolved.absolutePath, "utf8");
            if (/\bfeat_rank\b/.test(source)) {
                throw new Error(`Trade Gate rule ${ruleId} reads feat_rank, which is not permitted for certification.`);
            }
            const evaluate = await loaderRun.loadRule({
                ruleId,
                sourcePath: resolved.absolutePath,
                source,
                sourceHash: edgeRule.sourceHash,
            });
            rules.push({
                ruleId,
                ruleName: edgeRule.ruleName,
                sourceHash: edgeRule.sourceHash,
                evaluate,
            });
        }
        const provenance: TradeGateProvenance = {
            schema: "batch.trade_gate.v1",
            folderId: options.folderId,
            sweepId: latestSweep.sweepId,
            rules: rules.map(({ ruleId, ruleName, sourceHash }) => ({ ruleId, ruleName, sourceHash })),
        };
        return { gate: { enabled: true, provenance, rules, pairs: new Map() }, loaderRun };
    } catch (error) {
        await loaderRun.dispose();
        throw error;
    }
}

function parseTradeLedgerOptions(raw: unknown): TradeLedgerRunOptions | null {
    if (!raw || typeof raw !== "object") return null;
    const enabled = (raw as { enabled?: unknown }).enabled === true;
    if (!enabled) return null;
    const folderRaw = (raw as { folder?: unknown }).folder;
    const folder = typeof folderRaw === "string" && folderRaw.trim()
        ? sanitizeTradeLedgerFolder(folderRaw)
        : TRADE_LEDGER_DEFAULT_FOLDER;
    if (!folder) {
        throw new HttpStatusError(400, `Invalid tradeLedger folder: ${String(folderRaw)}.`);
    }
    return { enabled: true, folder };
}

/**
 * Per-run trade-ledger context: the executor-resolved settings plus the replay
 * eligibility guard (adaptive TP / path exits / partials / win-streak stops /
 * dynamic sizing / regime filters / both-direction reversals block replay;
 * cooldown + maxOpenTrades are position-state and stay replayable).
 */
interface TradeLedgerRunContext {
    resolvedSettings: BacktestSettings;
    eligibility: ReturnType<typeof evaluateReplayEligibility>;
    rowContext: TradeLedgerRowContext;
}

function resolveTradeLedgerRunContext(input: {
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    interval: string;
}): TradeLedgerRunContext {
    const resolved = resolveExecutorBacktestSettings(
        { ...input.backtestSettings, interval: input.interval } as BacktestSettings,
        input.interval,
    );
    const eligibility = evaluateReplayEligibility(resolved, input.capitalSettings);
    return {
        resolvedSettings: resolved,
        eligibility,
        rowContext: {
            tradeDirection: eligibility.params.tradeDirection,
            executionModel: eligibility.params.executionModel,
            maxOpenTrades: eligibility.params.maxOpenTrades,
            cooldownBars: eligibility.params.cooldownBars,
            slippageRate: eligibility.params.slippageRate,
        },
    };
}

function buildTradeLedgerProvenance(
    input: BatchBacktestRunInput,
    runId: string,
    startedAtMs: number,
    context: TradeLedgerRunContext,
): TradeLedgerProvenance {
    // References only (no copies of OHLCV/config objects beyond what the run
    // already holds); serializeJson runs once at write time.
    const params = context.eligibility.params;
    return {
        ledgerVersion: TRADE_LEDGER_VERSION,
        featureVersion: TRADE_LEDGER_FEATURE_VERSION,
        runId,
        startedAt: new Date(startedAtMs).toISOString(),
        interval: input.interval,
        strategyKey: input.strategyKey,
        strategyParams: input.strategyParams as Record<string, unknown>,
        backtestSettings: input.backtestSettings as Record<string, unknown>,
        capitalSettings: input.capitalSettings as unknown as Record<string, unknown>,
        engineMode: input.useRustEnginePreference ? "rust_preferred" : "typescript",
        executionModel: params.executionModel,
        tradeDirection: params.tradeDirection,
        riskMode: String((input.backtestSettings as Record<string, unknown>).riskMode ?? ""),
        fees: {
            commissionPercent: Number(input.capitalSettings?.commission ?? 0),
            slippageBps: Number((input.backtestSettings as Record<string, unknown>).slippageBps ?? 0),
        },
        pairCount: input.symbols.length,
        symbols: input.symbols,
        // Replay contract for the offline checker. The checker refuses replay
        // when replayEligible is false (see evaluateReplayEligibility).
        replay: {
            replayEligible: context.eligibility.eligible,
            replayBlockers: context.eligibility.reasons,
            maxOpenTrades: Number.isFinite(params.maxOpenTrades) ? params.maxOpenTrades : "unlimited",
            cooldownBars: params.cooldownBars,
            executionModel: params.executionModel,
            tradeDirection: params.tradeDirection,
            allowSameBarExit: params.allowSameBarExit,
            disableSignalExits: params.disableSignalExits,
            slippageRate: params.slippageRate,
            commissionRate: params.commissionRate,
        },
    };
}

// ---------------------------------------------------------------------------
// Run + Miner core (factored out of the HTTP handlers for testability)
// ---------------------------------------------------------------------------

type StreamWriter = (event: BatchStreamEvent) => void;

async function prepareTradeGateFeatureContexts(
    input: BatchBacktestRunInput,
    gate: TradeGate,
    isCancelled: () => boolean,
    writer: StreamWriter,
): Promise<TradeGate> {
    const ledgerContext = resolveTradeLedgerRunContext(input);
    const rowsByPair = new Map<string, TradeLedgerRow[]>();
    writer({ type: "progress", percent: 0, text: "Trade Gate: building causal feature pre-pass...", status: "Trade Gate: building causal feature pre-pass..." });
    await runBatchBacktest({
        ...input,
        tradeGate: undefined,
        useRustEnginePreference: false,
        pruneResultArtifacts: true,
    }, {
        setProgress: (percent, text) => {
            if (!isCancelled()) {
                writer({ type: "progress", percent: percent * 0.5, text: `Trade Gate pre-pass: ${text}`, status: `Trade Gate pre-pass: ${text}` });
            }
        },
        setStatus: () => {},
        onSymbolComplete: (_index, result, completionContext) => {
            if (isCancelled()) return;
            if (!result.data || !result.result || !completionContext?.signals) return;
            const pairRows = buildTradeLedgerRowsForPair({
                pair: result.symbol,
                data: result.data,
                signals: completionContext.signals,
                trades: result.result.trades,
                context: ledgerContext.rowContext,
            });
            rowsByPair.set(result.symbol, pairRows.rows);
        },
        isCancelled,
    });
    if (isCancelled()) throw new Error("Trade Gate run was stopped during the feature pre-pass.");

    const pairsByTime = new Map<number, Set<string>>();
    for (const rows of rowsByPair.values()) {
        for (const row of rows) {
            let pairs = pairsByTime.get(row.signalTime);
            if (!pairs) {
                pairs = new Set<string>();
                pairsByTime.set(row.signalTime, pairs);
            }
            pairs.add(row.pair);
        }
    }
    const pairContexts = new Map<string, TradeGatePairContext>();
    for (const [pair, rows] of rowsByPair) {
        const featuresBySignalKey = new Map<string, TradeGateFeatureRow>();
        for (const row of rows) {
            const pairs = [...(pairsByTime.get(row.signalTime) ?? [])]
                .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
            featuresBySignalKey.set(
                tradeGateSignalKey(row.signalBarIndex, row.direction),
                toTradeGateFeatureRow(row, pairs.length),
            );
        }
        pairContexts.set(pair, { pair, featuresBySignalKey });
    }
    writer({ type: "progress", percent: 50, text: "Trade Gate: causal feature pre-pass complete.", status: "Trade Gate: causal feature pre-pass complete." });
    return { ...gate, pairs: pairContexts };
}

function summarizeTradeGateStats(results: readonly BatchBacktestSymbolResult[]): TradeGateStats | null {
    const stats = createTradeGateStats();
    let present = false;
    for (const row of results) {
        if (!row.result?.tradeGateStats) continue;
        present = true;
        addTradeGateStats(stats, row.result.tradeGateStats);
    }
    return present ? stats : null;
}

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
    input: BatchBacktestRunInput & {
        tradeLedger?: TradeLedgerRunOptions | null;
        tradeGateOptions?: TradeGateRunOptions | null;
    },
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
    // Trade-ledger export (Batch "Save trade ledger" toggle). Pure side
    // artifact: created per run, written inside the awaited onSymbolComplete
    // path (audit F2 shape), and never allowed to fail the run.
    const tradeLedgerRequested = input.tradeLedger?.enabled === true;
    const ledgerRunContext = tradeLedgerRequested ? resolveTradeLedgerRunContext(input) : null;
    const ledger = tradeLedgerRequested
        ? await TradeLedgerWriter.create({
            rootDir: ledgerRootDir ?? process.cwd(),
            folder: input.tradeLedger?.folder ?? TRADE_LEDGER_DEFAULT_FOLDER,
            runId,
            startedAtMs: snapshot.startedAt,
            provenance: buildTradeLedgerProvenance(input, runId, snapshot.startedAt, ledgerRunContext!),
        })
        : null;
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
        ...(input.tradeGateOptions?.enabled
            ? { tradeGate: input.tradeGateOptions }
            : {}),
        ...(pairListProvenanceMeta.status === "verified" && pairListProvenanceMeta.provenance
            ? { pairListProvenance: pairListProvenanceMeta.provenance }
            : {}),
    });

    writer({ type: "start", total, interval: input.interval, strategyKey: input.strategyKey, runId });

    const lostOwnership = () => runOwner !== owner;
    let cancelled = false;
    let lastProgressAt = 0;
    let lastProgressPercent = -1;
    let resolvedTradeGate: ResolvedTradeGate | null = null;
    // setProgress already carries the status; do not emit it twice per symbol.
    try {
        resolvedTradeGate = input.tradeGateOptions?.enabled
            ? await resolveTradeGate(ledgerRootDir ?? process.cwd(), input.tradeGateOptions)
            : null;
        const executionInput = resolvedTradeGate
            ? await prepareTradeGateFeatureContexts(input, resolvedTradeGate.gate, lostOwnership, writer)
            : null;
        if (runState === snapshot && executionInput) {
            snapshot.tradeGateProvenance = executionInput.provenance;
        }
        const output = await runBatchBacktest({
            ...input,
            ...(executionInput ? { tradeGate: executionInput } : {}),
            pruneResultArtifacts: true,
        }, {
            setProgress: (percent, text) => {
                if (lostOwnership()) return;
                const now = Date.now();
                if (
                    percent !== 100
                    && lastProgressPercent >= 0
                    && percent - lastProgressPercent < 1
                    && now - lastProgressAt < 150
                ) {
                    return;
                }
                lastProgressAt = now;
                lastProgressPercent = percent;
                writer({ type: "progress", percent, text, status: text });
            },
            setStatus: () => {},
            onSymbolStart: (_index, symbol) => {
                if (lostOwnership()) return;
                if (runState === snapshot) {
                    snapshot.currentSymbol = symbol;
                }
            },
            onSymbolComplete: async (index, result, completionContext) => {
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
                // Trade-ledger appends ride the same awaited completion path
                // (incremental, one write per pair) and only read the row.
                // The as-if model is per-pair streaming data — built here and
                // dropped when the callback returns, never accumulated.
                if (ledger && completionContext?.signals && result.data && ledgerRunContext) {
                    const asIfModel = ledgerRunContext.eligibility.eligible
                        ? await buildAsIfPairModel({
                            data: result.data,
                            primarySignals: completionContext.signals,
                            resolvedSettings: ledgerRunContext.resolvedSettings,
                            eligibility: ledgerRunContext.eligibility,
                        })
                        : null;
                    const pairRows = buildTradeLedgerRowsForPair({
                        pair: result.symbol,
                        data: result.data,
                        signals: completionContext.signals,
                        trades: result.result?.trades,
                        context: ledgerRunContext.rowContext,
                        asIfModel,
                    });
                    await ledger.appendPairRows(pairRows);
                }
                writer({ type: "symbol", index, total, row: scalarRow });
                await new Promise<void>((resolve) => setImmediate(resolve));
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

        // Keep the shared runner's dense result contract, but do not transport
        // unattempted cancelled-tail rows. The browser should render work that
        // actually ran, not thousands of synthetic placeholders after Stop.
        let attemptedSymbols = 0;
        for (let i = 0; i < output.results.length; i += 1) {
            const row = output.results[i]!;
            if (row.status === "skipped") continue;
            attemptedSymbols += 1;
            if (runState === snapshot && snapshot.rows.length < attemptedSymbols) {
                snapshot.rows.push(toScalarRow(row));
            }
        }

        const tradeGateStats = summarizeTradeGateStats(output.results);

        if (runState === snapshot) {
            snapshot.completed = attemptedSymbols;
            snapshot.failed = output.failedSymbols.length;
            snapshot.currentSymbol = null;
            snapshot.cancelled = cancelled;
            snapshot.tradeGateStats = tradeGateStats;
        }
        // R-F1: only stamp the global run-provenance fields if THIS run still
        // owns the snapshot. An unwinding old run whose ownership was taken by
        // a newer run must not overwrite the newer run's fingerprint/interval/
        // strategy — those gate OPEN_SCORE USD acceptance.
        // Flush in-flight artifact writes before the `done` event so
        // `serverHasArtifacts` is truthful — the browser gates the Mine button
        // on that flag, and Mine reads the artifacts from disk (audit Finding 4).
        // Bind completion to this captured generation. A stopped old run can
        // resume after a newer run installs another global store; it must not
        // flush, release, or report that newer generation's artifacts.
        if (store.isDetached() || currentArtifactStore !== store) return;
        await store.flush();
        if (store.isDetached() || currentArtifactStore !== store) return;
        // Finalize the trade ledger (ranks + summary) BEFORE the done event so
        // the folder is complete when the browser learns the run finished.
        // Skipped for a detached generation — a stale run must not write.
        let ledgerResult: TradeLedgerFinalizeResult | null = null;
        let ledgerRunDir: string | null = null;
        if (ledger) {
            ledgerRunDir = ledger.runDir;
            // W4 pair accounting: provenance.pairCount stays "submitted";
            // summary.json carries the full submitted/loaded/row-bearing split.
            ledgerResult = await ledger.finalize({
                cancelled,
                finishedAtMs: Date.now(),
                accounting: {
                    submittedPairs: input.symbols.length,
                    loadedPairs: output.loadedSymbols,
                },
            });
        }
        const artifactsAvailable = store.hasStored();
        const artifactStats = store.artifactStats();
        const parsedCacheStats = store.parsedCacheStats();
        if (runState === snapshot) {
            lastRunFingerprint = fingerprint;
            lastRunInterval = input.interval;
            lastRunStrategyKey = input.strategyKey;
            lastRunBacktestSettings = { ...input.backtestSettings };
            lastRunCapitalSettings = { ...input.capitalSettings };
        }
        const cacheStats = getServerBatchDatasetCacheStats();
        lastRunCacheStats = cacheStats;
        const cancelledSymbols = Math.max(0, output.results.length - attemptedSymbols);
        let terminalSummary = cancelled
            ? `Stopped — attempted ${attemptedSymbols}/${output.results.length} pairs`
            : `Done — ${attemptedSymbols} pairs`;
        if (output.failedSymbols.length > 0) {
            terminalSummary += `, ${output.failedSymbols.length} failed`;
        }
        if (tradeGateStats) {
            terminalSummary += ` | Trade Gate evaluated ${tradeGateStats.signalsEvaluated}, admitted ${tradeGateStats.admitted}, rejected ${tradeGateStats.rejectedByGate}, blocked ${tradeGateStats.blocked}`;
        }
        // Audit artifact-stats finding: when a run retains some but not all
        // Mine artifacts (disk pressure on a 1000-pair run), surface the
        // partial-failure count in the summary so Mine-analyzing fewer pairs
        // is visible rather than silent. Keep `serverHasArtifacts` truthful
        // (true iff `stored > 0`) so the Mine button stays enabled.
        if (artifactStats.failed > 0) {
            terminalSummary += ` — artifacts ${artifactStats.stored}/${artifactStats.eligible}; Mine will omit ${artifactStats.failed} failed write${artifactStats.failed === 1 ? "" : "s"}.`;
        }
        // Fail loud: a ledger that was requested but incomplete (setup failed
        // or any write failed) is visible in the run's terminal summary. A
        // healthy ledger leaves the summary unchanged.
        if (tradeLedgerRequested && (ledger === null || ledgerResult === null || !ledgerResult.ledgerComplete)) {
            terminalSummary += ` — trade ledger incomplete (${ledgerResult?.failedWrites ?? 0} failed write${(ledgerResult?.failedWrites ?? 0) === 1 ? "" : "s"}).`;
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
            totals: {
                loadedSymbols: output.loadedSymbols,
                failedSymbols: output.failedSymbols.length,
                attemptedSymbols,
                cancelledSymbols,
            },
            summary: terminalSummary,
            serverHasArtifacts: artifactsAvailable,
            fingerprint,
            cacheStats,
            performance: output.timings,
            runId,
            artifactStats,
            parsedCacheStats,
            pairListProvenanceMeta: snapshot.pairListProvenanceMeta ?? null,
            universeCounts: snapshot.universeCounts ?? null,
            verifiedPairListProvenance: snapshot.pairListProvenanceMeta?.status === "verified"
                ? snapshot.pairListProvenanceMeta.provenance
                : null,
            tradeGateProvenance: snapshot.tradeGateProvenance ?? null,
            tradeGateStats,
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
            // Trade-ledger outcome (present only when the toggle was on).
            tradeLedger: ledgerResult
                ? {
                    runDir: ledgerRunDir,
                    ...ledgerResult,
                }
                : undefined,
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
        // Best-effort ledger finalize on the fatal path too: the partial
        // ledger stays on disk with ledgerComplete=false. Never mask the fatal.
        if (ledger) {
            try {
                await ledger.finalize({ cancelled: true, finishedAtMs: Date.now() });
            } catch {
                /* best-effort */
            }
        }
        if (currentArtifactStore === store) {
            await releaseLastResults("run_fatal");
        }
    } finally {
        if (resolvedTradeGate) await resolvedTradeGate.loaderRun.dispose();
    }
}

// ---------------------------------------------------------------------------
// Analysis core
// ---------------------------------------------------------------------------

export type MinerStreamWriter = (event: unknown) => void;

function cancelMinerOnDisconnect(owner: number): void {
    if (analysisOwner !== owner) return;
    analysisAbortController?.abort();
    analysisOwner = RUN_OWNER_NONE;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async function handleRunRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is already running. Use Stop first.");
    }
    if (analysisOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "OPEN_SCORE USD analysis is currently running. Stop it before starting another batch.");
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
    const symbolValidationError = validateBatchSymbols(symbols);
    if (symbolValidationError) {
        throw new HttpStatusError(400, `Invalid Batch symbol: ${symbolValidationError}`);
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
    const nextOwner = runOwnerGen + 1;
    const coordinatorToken = tryAcquireResearchWorkload("batch", runId || `batch-${nextOwner}`);
    if (!coordinatorToken) {
        throw new HttpStatusError(409, "A Ledger Sweep is running. Stop it before starting Batch.");
    }
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
    // Trade-ledger export options (optional; null when the toggle is off or
    // the field is absent).
    const tradeLedger = parseTradeLedgerOptions(body.tradeLedger);
    const tradeGateOptions = parseTradeGateOptions(body.tradeGate);
    await releaseLastResults("new_run");
        if (runOwner !== owner) {
            throw new HttpStatusError(409, "Batch run was stopped before it started.");
        }
        lastRunFingerprint = null;
        lastRunInterval = null;
        lastRunStrategyKey = null;
        lastRunBacktestSettings = null;
        lastRunCapitalSettings = null;
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
                    tradeLedger,
                    tradeGateOptions,
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
        releaseResearchWorkloadIfOwner(coordinatorToken);
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
    // stop a newer run. The analysis owner (OPEN_SCORE USD) has no runId in
    // this contract; its locks are still force-reset so Stop remains the
    // recovery path for a stuck analysis job.
    const requestedRunId = parseBatchRunId(rawRunId);
    const runWasActive = runOwner !== RUN_OWNER_NONE;
    const analysisWasActive = analysisOwner !== RUN_OWNER_NONE;

    // During preflight the new request has already claimed `runOwner`, but
    // `runState` may still belong to the prior generation. Prefer the explicit
    // reservation so a matching Stop can cancel the new request reliably.
    const ownedRunId = runWasActive
        ? (runOwnerRunId ?? runState?.runId ?? "")
        : (runState?.runId ?? "");
    if ((runWasActive || analysisWasActive) && ownedRunId && requestedRunId !== ownedRunId) {
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

    // Analysis force-reset: always cancels in-flight OPEN_SCORE USD so Stop
    // stays the recovery path for a stuck analysis job. Target loads swallow
    // AbortError via the per-target try/catch.
    if (analysisAbortController) {
        try {
            analysisAbortController.abort();
        } catch {
            /* best-effort */
        }
    }
    analysisOwner = RUN_OWNER_NONE;
    return { ok: true, stopped: runWasActive || analysisWasActive };
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
    const lostOwnership = () => analysisOwner !== owner;
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
                if (analysisAbortController?.signal?.aborted || lostOwnership()) return;
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
            const symbol = markedSymbolByAsset.get(asset) ?? `${asset.trim().toUpperCase()}USDT`;
            try {
                const data = (await loadTargetDataset(symbol, runInterval, analysisAbortController?.signal)) as OHLCVData[] | null;
                if (Array.isArray(data) && data.length > 0) {
                    yield { asset, symbol, data };
                }
            } catch (error) {
                if (analysisAbortController?.signal?.aborted || lostOwnership()) return;
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
    // Validate client input first — a malformed date or oversized horizons
    // array is a 400 regardless of server state, and surfacing it before the
    // artifacts/owner guards keeps the error actionable (audit Finding 6).
    const parseBodyDateSec = (key: string, endOfDay = false): number | null => {
        const raw = body[key];
        if (typeof raw !== "string" || raw.trim() === "") return null;
        // YYYY-MM-DD parses as UTC midnight. For "sampleFrom" that's fine; for
        // "sampleTo" we add 24h-1s so the entire selected day is included
        // (otherwise most of the chosen day's events were excluded).
        const ms = Date.parse(raw);
        // Distinguish absent (no filter) from malformed. A typo'd non-empty
        // date previously became `null` (= "no filter") and silently triggered
        // a full-window replay, producing a misleading report. Reject it as a
        // 400 so the caller sees an actionable error instead (audit Finding 6).
        if (!Number.isFinite(ms)) {
            throw new HttpStatusError(400, `Invalid ${key} date: "${raw}".`);
        }
        return Math.floor(ms / 1000) + (endOfDay ? 24 * 3600 - 1 : 0);
    };
    const sampleFromSec = parseBodyDateSec("sampleFrom", false);
    const sampleToSec = parseBodyDateSec("sampleTo", true);

    // OPEN_SCORE horizons input validation. The route is reachable on the
    // documented Cloudflare-tunnel / LOCAL_PROXY_TOKEN path and accepts no
    // symbols (so BATCH_MAX_SYMBOLS does not gate it). Reject oversized or
    // out-of-range payloads with 400 instead of silently truncating, so a
    // legitimate UI typo is visible while a malicious million-entry array
    // can't exhaust CPU across all retained artifacts.
    let validatedHorizons: number[] | null = null;
    if (Array.isArray(body.horizons) && body.horizons.length > 0) {
        if (body.horizons.length > OPEN_SCORE_HORIZONS_MAX_LENGTH) {
            throw new HttpStatusError(
                400,
                `Too many horizons (${body.horizons.length}); limit is ${OPEN_SCORE_HORIZONS_MAX_LENGTH}.`,
            );
        }
        const cleaned: number[] = [];
        for (const h of body.horizons) {
            if (typeof h !== "number" || !Number.isFinite(h) || h < 1) {
                throw new HttpStatusError(400, `Each horizon must be a finite number >= 1; got ${String(h)}.`);
            }
            const floored = Math.floor(h);
            if (floored > OPEN_SCORE_HORIZONS_MAX_VALUE) {
                throw new HttpStatusError(
                    400,
                    `Horizon ${floored} exceeds the per-element cap of ${OPEN_SCORE_HORIZONS_MAX_VALUE}.`,
                );
            }
            cleaned.push(floored);
        }
        validatedHorizons = cleaned;
    }

    if (analysisOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "An analysis is already running. Use Stop first.");
    }
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is running. Use Stop first.");
    }
    if (!hasStoredMineArtifacts()) {
        throw new HttpStatusError(400, "Run Batch before OPEN_SCORE USD; no artifacts on server.");
    }
    const nextOwner = analysisOwnerGen + 1;
    const coordinatorToken = tryAcquireResearchWorkload("batch", `batch-analysis-${nextOwner}`);
    if (!coordinatorToken) {
        throw new HttpStatusError(409, "A Ledger Sweep is running. Stop it before starting analysis.");
    }
    const owner = ++analysisOwnerGen;
    analysisOwner = owner;
    analysisAbortController = new AbortController();

    let stream: ReturnType<typeof createDisconnectSafeStream> | null = null;
    try {
        stream = createDisconnectSafeStream(res, { onDisconnect: () => cancelMinerOnDisconnect(owner) });
        await processOpenScoreUsdReplay(
            typeof body.fingerprint === "string" ? body.fingerprint : null,
            lastRunInterval,
            (event) => stream!.write(event),
            owner,
            validatedHorizons,
            sampleFromSec,
            sampleToSec,
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
        if (analysisOwner === owner) {
            analysisOwner = RUN_OWNER_NONE;
        }
        analysisAbortController = null;
        releaseResearchWorkloadIfOwner(coordinatorToken);
    }
}


function handleStatusRequest(afterRow = 0, limitRaw?: number, requestedRunId?: string): BatchStatusResponse {
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
                tradeGateProvenance: runState.tradeGateProvenance ?? null,
                tradeGateStats: runState.tradeGateStats ?? null,
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
                tradeGateProvenance: runState.tradeGateProvenance ?? null,
                tradeGateStats: runState.tradeGateStats ?? null,
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
            ledgerRootDir = server.config.root ?? process.cwd();
            // Best-effort: sweep orphaned dirs from a prior crash without
            // blocking dev-server registration (audit Finding 4).
            void sweepOrphanedMineArtifactDirs();
            registerBatchRoutes(server.middlewares);
        },
        configurePreviewServer(server) {
            ledgerRootDir = server.config.root ?? process.cwd();
            void sweepOrphanedMineArtifactDirs();
            registerBatchRoutes(server.middlewares);
        },
    };
}

/** Install all Batch routes; exposed through test internals for route tests. */
function registerBatchRoutes(middlewares: any): void {
        // Audit Finding 2 (and the F1 Finder auth gate): every Batch route
        // gates on the same loopback/bearer policy as IBKR and strategy-admin,
        // so a Vite server exposed via --host / tunnel / reverse proxy can't
        // be driven into CPU-heavy 1000-pair backtests remotely. The
        // `registerLocalJsonRoute` helper (audit Finding 8) makes the auth gate
        // structurally impossible to forget when new routes are added.
        registerLocalJsonRoute(middlewares, "/api/batch-backtest/run", {
            methods: ["POST"],
            readBody: true,
            maxBodyBytes: FINDER_BATCH_MAX_BODY_BYTES,
            onAuthorizedRequest: (req) => rememberLocalApiOriginFromRequest(req),
            unauthorizedMessage: "Unauthorized: batch routes are local-only.",
            onAuthorized: async ({ res, body }) => {
                await handleRunRequest(res, body);
            },
        });

        registerLocalJsonRoute(middlewares, "/api/batch-backtest/stop", {
            methods: ["POST"],
            readBody: true,
            maxBodyBytes: FINDER_BATCH_MAX_BODY_BYTES,
            unauthorizedMessage: "Unauthorized: batch routes are local-only.",
            onAuthorized: async ({ res, body }) => {
                // Audit Finding 5: read the optional runId so Stop can be
                // scoped. Empty bodies remain valid for legacy server state;
                // malformed JSON and invalid ids fail closed as client errors.
                const result = await handleStopRequest((body as { runId?: unknown })?.runId);
                sendJson(res, 200, result);
            },
        });

        registerLocalJsonRoute(middlewares, "/api/batch-backtest/open-score-usd", {
            methods: ["POST"],
            readBody: true,
            maxBodyBytes: FINDER_BATCH_MAX_BODY_BYTES,
            onAuthorizedRequest: (req) => rememberLocalApiOriginFromRequest(req),
            unauthorizedMessage: "Unauthorized: batch routes are local-only.",
            onAuthorized: async ({ res, body }) => {
                await handleOpenScoreUsdRequest(res, body);
            },
        });

        registerLocalJsonRoute(middlewares, "/api/batch-backtest/status", {
            methods: ["GET"],
            unauthorizedMessage: "Unauthorized: batch routes are local-only.",
            onAuthorized: ({ res, url }) => {
                // Status exposes run inputs, progress, results, and miner state.
                const after = Number(url.searchParams.get("after") ?? 0);
                const limitParam = url.searchParams.get("limit");
                const limit = limitParam === null ? undefined : Number(limitParam);
                // Audit runId-scoping finding: optional `?runId=` so a paginated
                // drain is scoped to one generation. Empty/absent preserves
                // legacy behavior (the server cannot distinguish an old browser
                // bundle from a probe, and an unmatched id returns runMismatch).
                const runIdParam = url.searchParams.get("runId");
                const runId = runIdParam && runIdParam.trim() ? runIdParam.trim() : undefined;
                // The try/catch around `handleStatusRequest` lives inside the
                // helper now; a throwing toJSON / circular ref previously
                // propagated as an unhandled rejection and crashed the dev
                // server on a route polled every ~2s during reattach.
                sendJson(res, 200, handleStatusRequest(after, limit, runId));
            },
        });

        // SP500 TOP_MEAN routes (run/stop/status/result) live in their own
        // module now (audit Finding 9). The handlers share the Batch plugin's
        // owner-lock counters so a TOP_MEAN run and a Batch run cannot execute
        // simultaneously; that coupling is expressed through the BatchOwnerLocks
        // adapter below instead of reaching across module scope.
        const batchOwnerLocks: BatchOwnerLocks = {
            isBusy: () => runOwner !== RUN_OWNER_NONE || analysisOwner !== RUN_OWNER_NONE,
            acquire: (runId) => {
                const researchToken = tryAcquireResearchWorkload("batch", runId || `batch-analysis-${runOwnerGen + 1}`);
                if (!researchToken) {
                    throw new HttpStatusError(409, "A Ledger Sweep is running. Stop it before starting TOP_MEAN.");
                }
                const ownerGen = ++runOwnerGen;
                const analysisGen = ++analysisOwnerGen;
                runOwner = ownerGen;
                runOwnerRunId = runId;
                analysisOwner = analysisGen;
                return { runOwner: ownerGen, analysisOwner: analysisGen, researchToken };
            },
            releaseIfStillOwner: (token) => {
                if (runOwner === token.runOwner) {
                    runOwner = RUN_OWNER_NONE;
                    runOwnerRunId = null;
                }
                if (analysisOwner === token.analysisOwner) {
                    analysisOwner = RUN_OWNER_NONE;
                }
                if (token.researchToken) releaseResearchWorkloadIfOwner(token.researchToken);
            },
        };
        registerSp500TopMeanRoutes(middlewares, {
            maxBodyBytes: FINDER_BATCH_MAX_BODY_BYTES,
            rememberLocalApiOriginFromRequest: (req) => rememberLocalApiOriginFromRequest(req),
            ownerLocks: batchOwnerLocks,
        });
    }

// Exported for tests only. `processRunBatch` and `processOpenScoreUsdReplay`
// consult module-scope `runOwner` / `analysisOwner` for cancellation, mirroring
// the IBKR sync pattern. The HTTP handlers set those before invoking the
// factored functions; tests need a way to do the same without spinning up Vite.
export const __testInternals = {
    releaseLastResults,
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
    setAnalysisOwnerForTests(owner: number): void {
        analysisOwner = owner;
    },
    /**
     * Set the analysis abort controller during tests. The HTTP handlers create
     * it (`analysisAbortController = new AbortController()`), but tests that call
     * `processOpenScoreUsdReplay` directly bypass the handler, so they must
     * install one to exercise the Stop-aborts-target-loads path. Pass null to
     * clear.
     */
    setAnalysisAbortControllerForTests(controller: AbortController | null): void {
        analysisAbortController = controller;
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
    // --- Trade-ledger test seams ---
    /** Point the ledger root at a temp dir for the duration of a test. */
    setLedgerRootDirForTests(dir: string | null): void {
        ledgerRootDir = dir;
    },
    getLedgerRootDirForTests(): string | null {
        return ledgerRootDir;
    },
    parseTradeGateOptionsForTests: parseTradeGateOptions,
    async resolveTradeGateForTests(serverRoot: string, options: TradeGateRunOptions): Promise<TradeGate> {
        const resolved = await resolveTradeGate(serverRoot, options);
        await resolved.loaderRun.dispose();
        return resolved.gate;
    },
    parseTradeLedgerOptionsForTests: parseTradeLedgerOptions,
};
