import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { TopMeanRunManifest } from "./compact-pair-artifact";
import { saveManifest, saveManifestAsync, writeShardArtifactsAsync } from "./sp500-top-mean-artifact-store";
import type { TopMeanWorkerMessage, TopMeanWorkerTaskData } from "./sp500-top-mean-worker";
import { debugLogger } from "../debug-logger";
import type {
    TopMeanCacheCounters,
    TopMeanWorkerPoolPerformance,
    TopMeanWorkerTiming,
} from "./sp500-top-mean-performance";
import { TOP_MEAN_WORKER_COUNT_MAX } from "./sp500-top-mean-request-limits";
import { MAX_CACHE_FILES } from "./synthetic-pair-disk-cache";

export const TOP_MEAN_DEFAULT_SHARD_SIZE = 250;
export const TOP_MEAN_TARGET_SHARDS_PER_WORKER = 4;
export const TOP_MEAN_DISK_CACHE_BYPASS_PAIR_THRESHOLD = MAX_CACHE_FILES;

export function shouldBypassTopMeanSyntheticPairDiskCache(totalPairs: number): boolean {
    return Number.isFinite(totalPairs) && totalPairs > TOP_MEAN_DISK_CACHE_BYPASS_PAIR_THRESHOLD;
}

function moduleThisFileDir(): string {
    try {
        return dirname(fileURLToPath(import.meta.url));
    } catch {
        return __dirname;
    }
}

export async function resolveTopMeanWorkerPath(): Promise<string> {
    const fs = await import("node:fs/promises");
    const repositorySource = resolve(process.cwd(), "lib", "batch-backtest", "sp500-top-mean-worker.ts");
    const moduleSource = join(moduleThisFileDir(), "sp500-top-mean-worker.ts");
    const sourcePath = await fs.access(repositorySource).then(() => repositorySource).catch(() => moduleSource);
    const sibling = sourcePath.replace(/\.ts$/, ".js");
    if (sourcePath.endsWith(".js") || (await fs.access(sibling).then(() => true).catch(() => false))) {
        return sourcePath.endsWith(".js") ? sourcePath : sibling;
    }
    try {
        return await bundleWorkerWithEsbuild(sourcePath);
    } catch {
        return sourcePath;
    }
}

/**
 * Bundle the worker source and reuse the content-addressed output file.
 */
async function bundleWorkerWithEsbuild(sourcePath: string): Promise<string> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const esbuild = (await import("esbuild")) as unknown as {
        build: (opts: any) => Promise<{ outputFiles?: Array<{ contents: Uint8Array }> }>;
    };
    const tmp = os.tmpdir();
    const root = join(tmp, "sp500-top-mean-workers");

    const result = await esbuild.build({
        entryPoints: [sourcePath],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node18",
        outfile: "worker.cjs",
        write: false,
        logLevel: "silent",
    });

    const contents = result.outputFiles?.[0]?.contents;
    if (!contents?.byteLength) {
        throw new Error("esbuild produced an empty top-mean worker bundle");
    }

    const bundleHash = createHash("sha256").update(contents).digest("hex").slice(0, 16);
    const dir = join(root, bundleHash);
    const outfile = join(dir, "worker.cjs");
    await fs.mkdir(dir, { recursive: true });
    if (!(await fs.access(outfile).then(() => true).catch(() => false))) {
        const temporary = join(dir, `worker.${process.pid}.${Date.now()}.tmp`);
        await fs.writeFile(temporary, contents);
        await fs.rename(temporary, outfile);
    }
    return outfile;
}

export function resolveTopMeanWorkerCount(explicit?: number): number {
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
        return Math.max(1, Math.min(TOP_MEAN_WORKER_COUNT_MAX, Math.floor(explicit)));
    }
    let cores = 8;
    try {
        cores = availableParallelism() || cores;
    } catch {
        // Fallback for older Node versions
    }
    // Cold-run benchmarking on a 24-logical-core / 64 GiB host showed that
    // using all 24 workers improved 2,271-pair throughput by ~26% versus
    // reserving four cores. The coordinator runs server-side, so an explicit
    // UI value can still reserve capacity when desired.
    return Math.max(1, Math.min(TOP_MEAN_WORKER_COUNT_MAX, cores));
}

export function resolveTopMeanShardSize(
    totalPairs: number,
    workerCount: number,
    explicit?: number,
): number {
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
        return Math.max(1, Math.floor(explicit));
    }
    if (totalPairs <= 0) return 1;
    const targetShards = Math.max(1, workerCount) * TOP_MEAN_TARGET_SHARDS_PER_WORKER;
    return Math.max(
        1,
        Math.min(TOP_MEAN_DEFAULT_SHARD_SIZE, Math.ceil(totalPairs / targetShards)),
    );
}

export type TopMeanEngineUsage = { rust: number; typescript: number };
export type TopMeanWorkerPoolExecutionResult = TopMeanEngineUsage & {
    performance: TopMeanWorkerPoolPerformance;
};

function emptyCacheCounters(): TopMeanCacheCounters {
    return {
        legHits: 0,
        legMisses: 0,
        pairHits: 0,
        pairMisses: 0,
        diskHits: 0,
        diskMisses: 0,
        diskWrites: 0,
    };
}

function addWorkerTiming(target: TopMeanWorkerTiming, source: TopMeanWorkerTiming): void {
    target.attemptedPairs += source.attemptedPairs;
    target.completedPairs += source.completedPairs;
    target.failedPairs += source.failedPairs;
    target.loadMs += source.loadMs;
    target.prepareMs += source.prepareMs;
    target.backtestMs += source.backtestMs;
    target.signalGenerationMs += source.signalGenerationMs;
    target.exitProcessingMs += source.exitProcessingMs;
    target.exitStrategyMs += source.exitStrategyMs;
    target.exitStrategyLoadMs += source.exitStrategyLoadMs;
    target.exitStrategyNormalizeMs += source.exitStrategyNormalizeMs;
    target.exitSignalGenerationMs += source.exitSignalGenerationMs;
    target.exitMergeMs += source.exitMergeMs;
    target.exitBookkeepingMs += source.exitBookkeepingMs;
    target.exitOverrideSignals += source.exitOverrideSignals;
    target.engineMs += source.engineMs;
    target.engineDiagnosticPairs += source.engineDiagnosticPairs;
    for (const key of Object.keys(source.engineDiagnostics) as Array<keyof typeof source.engineDiagnostics>) {
        target.engineDiagnostics[key] += source.engineDiagnostics[key];
    }
    target.artifactMs += source.artifactMs;
    target.pairWallMs += source.pairWallMs;
    target.shardWallMs += source.shardWallMs;
    target.cache.legHits += source.cache.legHits;
    target.cache.legMisses += source.cache.legMisses;
    target.cache.pairHits += source.cache.pairHits;
    target.cache.pairMisses += source.cache.pairMisses;
    target.cache.diskHits += source.cache.diskHits;
    target.cache.diskMisses += source.cache.diskMisses;
    target.cache.diskWrites += source.cache.diskWrites;
}

export interface WorkerPoolRunOptions {
    runId: string;
    manifest: TopMeanRunManifest;
    canonicalPairs: string[];
    strategyKey: string;
    strategyParams: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    interval: string;
    workerCount?: number;
    shardSize?: number;
    useRustEnginePreference?: boolean;
    baseDir?: string;
    /** Test seam for deterministic worker lifecycle specs; production uses the resolved worker bundle. */
    workerPath?: string;
    /** Test seam; production uses the atomic async artifact writer. */
    writeShardArtifacts?: typeof writeShardArtifactsAsync;
    onProgress?: (completedPairs: number, totalPairs: number, text: string) => void;
}

export interface ShardTask {
    shardIndex: number;
    pairs: Array<{ pairIndex: number; symbol: string }>;
}

function pairAffinityKey(symbol: string): string {
    const separator = symbol.indexOf("+");
    if (separator < 1 || separator === symbol.length - 1) {
        return `1:${symbol.trim().toUpperCase()}`;
    }
    const left = symbol.slice(0, separator).trim().toUpperCase();
    const right = symbol.slice(separator + 1).trim().toUpperCase();
    return `0:${left < right ? left : right}`;
}

/**
 * Group synthetic pairs that share a leg into the same shards. TOP_MEAN
 * workers keep a deliberately bounded 24-leg LRU; shuffled custom pair lists
 * otherwise evict both legs between nearly every pair and repeatedly parse the
 * same seed CSVs on a cold disk-cache run.
 *
 * `pairIndex` always refers to the caller's original order, so artifacts and
 * replay semantics stay unchanged. Resumed runs can request the legacy input
 * order because their persisted completed-shard indexes predate this planner.
 */
export function buildTopMeanShardTasks(
    canonicalPairs: string[],
    shardSize: number,
    preserveInputOrder = false,
): ShardTask[] {
    const orderedPairs = canonicalPairs.map((symbol, pairIndex) => ({ pairIndex, symbol }));
    if (!preserveInputOrder) {
        orderedPairs.sort((a, b) => {
            const left = pairAffinityKey(a.symbol);
            const right = pairAffinityKey(b.symbol);
            if (left < right) return -1;
            if (left > right) return 1;
            return a.pairIndex - b.pairIndex;
        });
    }

    const tasks: ShardTask[] = [];
    for (let i = 0; i < orderedPairs.length; i += shardSize) {
        tasks.push({
            shardIndex: tasks.length,
            pairs: orderedPairs.slice(i, i + shardSize),
        });
    }
    return tasks;
}

export class TopMeanWorkerPool {
    private activeWorkers = new Set<Worker>();
    private isCancelled = false;

    public cancel(): void {
        this.isCancelled = true;
        for (const worker of this.activeWorkers) {
            try {
                worker.terminate();
            } catch {
                // Ignore worker termination error
            }
        }
        this.activeWorkers.clear();
    }

    public async execute(options: WorkerPoolRunOptions): Promise<TopMeanWorkerPoolExecutionResult> {
        const poolStartedAt = performance.now();
        const workerCount = resolveTopMeanWorkerCount(options.workerCount);
        const totalPairs = options.canonicalPairs.length;
        const preferInMemorySyntheticPairs = shouldBypassTopMeanSyntheticPairDiskCache(totalPairs);
        // Completed shard indexes are meaningful only under the size that
        // created them. A resumed run must preserve that persisted partition;
        // new runs are free to use the dynamic worker-fed size.
        const hasPersistedShardPartition = (
            options.manifest.completedShards.length > 0
            || options.manifest.failedShards.length > 0
        );
        if (!options.manifest.shardOrder && !hasPersistedShardPartition) {
            options.manifest.shardOrder = "leg_affinity_v1";
        }
        const preserveInputShardOrder = options.manifest.shardOrder !== "leg_affinity_v1";
        const resumedShardSize = hasPersistedShardPartition
            ? options.manifest.shardSize
            : undefined;
        const shardSize = resolveTopMeanShardSize(
            totalPairs,
            workerCount,
            options.shardSize ?? resumedShardSize,
        );
        options.manifest.shardSize = shardSize;
        const engineUsage: TopMeanEngineUsage = { rust: 0, typescript: 0 };
        const workerTiming: TopMeanWorkerTiming = {
            attemptedPairs: 0,
            completedPairs: 0,
            failedPairs: 0,
            loadMs: 0,
            prepareMs: 0,
            backtestMs: 0,
            signalGenerationMs: 0,
            exitProcessingMs: 0,
            exitStrategyMs: 0,
            exitStrategyLoadMs: 0,
            exitStrategyNormalizeMs: 0,
            exitSignalGenerationMs: 0,
            exitMergeMs: 0,
            exitBookkeepingMs: 0,
            exitOverrideSignals: 0,
            engineMs: 0,
            engineDiagnosticPairs: 0,
            engineDiagnostics: {
                total: 0,
                dataClean: 0,
                indicatorResolution: 0,
                signalPreparation: 0,
                signalIndexing: 0,
                entryEvaluation: 0,
                tradeSimulation: 0,
                forcedClose: 0,
                drawdown: 0,
                metrics: 0,
            },
            artifactMs: 0,
            pairWallMs: 0,
            shardWallMs: 0,
            cache: emptyCacheCounters(),
        };

        // Debounced manifest persistence. The prior code called `saveManifest`
        // (a synchronous multi-KB atomic write with a Windows EPERM retry loop)
        // on EVERY shard_complete — with 12 concurrent workers across a 400-
        // shard run that blocked the event loop on hundreds of redundant writes
        // while the in-flight manifest only grew. Flush on count OR time
        // thresholds; always force-flush on the terminal paths (error/end).
        // Resume safety is preserved: `reconcileInterruptedManifestsOnStartup`
        // re-marks any post-flush crash as interrupted on the next run.
        const MANIFEST_FLUSH_EVERY_N_SHARDS = 8;
        const MANIFEST_FLUSH_INTERVAL_MS = 5_000;
        let shardsSinceFlush = 0;
        let lastFlushAt = Date.now();
        let manifestDirty = false;
        // Per-shard artifact writes are now async (see `shard_complete`
        // handler) so the message handler does not block the event loop on a
        // multi-hundred-KB write. Track every fired write here; the terminal
        // paths `await settleInFlightShardWrites()` before the final manifest
        // flush so the on-disk state is durable before the manifest claims it.
        const inFlightShardWrites = new Set<Promise<void>>();
        const settleInFlightShardWrites = async (): Promise<void> => {
            if (inFlightShardWrites.size === 0) return;
            const pending = [...inFlightShardWrites];
            inFlightShardWrites.clear();
            await Promise.allSettled(pending);
        };
        let manifestFlushChain = Promise.resolve();
        let manifestFlushError: unknown = null;
        const flushManifest = (force: boolean): Promise<void> => {
            if (!manifestDirty && !force) return manifestFlushChain;
            const due = force
                || shardsSinceFlush >= MANIFEST_FLUSH_EVERY_N_SHARDS
                || Date.now() - lastFlushAt >= MANIFEST_FLUSH_INTERVAL_MS;
            if (!due) return manifestFlushChain;
            const snapshot = structuredClone(options.manifest);
            manifestDirty = false;
            shardsSinceFlush = 0;
            lastFlushAt = Date.now();
            manifestFlushChain = manifestFlushChain
                .then(() => saveManifestAsync(snapshot, options.baseDir))
                .then(() => {
                    manifestFlushError = null;
                })
                .catch((error) => {
                    manifestFlushError = error;
                    debugLogger.warn("sp500_top_mean.manifest_write_failed", {
                        runId: options.runId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            return manifestFlushChain;
        };
        const requireManifestFlush = async (): Promise<void> => {
            await flushManifest(true);
            if (manifestFlushError) throw manifestFlushError;
        };

        // Existing completed shard indexes refer to the legacy contiguous
        // input partition. Preserve it on resume; new runs use cache-aware
        // grouping while retaining every pair's original pairIndex.
        const shardTasks = buildTopMeanShardTasks(
            options.canonicalPairs,
            shardSize,
            preserveInputShardOrder,
        );

        options.manifest.totalShards = shardTasks.length;
        saveManifest(options.manifest, options.baseDir);

        // Filter out already completed shards (for resume support). The two
        // Sets below are maintained INCREMENTALLY for the duration of this
        // execute() call so the per-shard message handler can dedupe in O(1)
        // instead of O(N) per shard — completing 400 shards previously cost
        // ~80k comparisons via Array.includes.
        const completedSet = new Set<number>(options.manifest.completedShards);
        const failedSet = new Set<number>(options.manifest.failedShards);
        const pendingShards = shardTasks.filter((task) => !completedSet.has(task.shardIndex));

        let completedPairsCount = options.manifest.completedPairsCount || 0;
        const workerBundleStartedAt = performance.now();
        const workerScriptPath = options.workerPath ?? await resolveTopMeanWorkerPath();
        const workerBundleMs = performance.now() - workerBundleStartedAt;

        // ---- Persistent worker pool (F3+F7) ---------------------------------
        // The prior implementation spawned a fresh `new Worker(...)` per shard
        // and terminated it after one shard_complete. Each worker cold-start
        // eagerly evaluates the 188-strategy manifest + backtest-executor
        // import graph (~1000+ lines transitive), so per-shard overhead was
        // ~workerCount× the steady-state cost. The worker file ALREADY exposes
        // a `parentPort.on("message", ...)` follow-up handler alongside the
        // workerData one-shot — that handler was dead code (F7). Spawn workers
        // ONCE with TOP_MEAN workerData metadata; the message listener handles
        // every task, and workers are reused across shards via
        // a free-list, and terminate them only on cancel / end / fatal.
        const buildTaskData = (task: ShardTask): TopMeanWorkerTaskData => ({
            shardIndex: task.shardIndex,
            pairs: task.pairs,
            strategyKey: options.strategyKey,
            strategyParams: options.strategyParams,
            backtestSettings: options.backtestSettings,
            capitalSettings: options.capitalSettings,
            interval: options.interval,
            useRustEnginePreference: options.useRustEnginePreference,
            preferInMemorySyntheticPairs,
        });

        type InFlight = {
            task: ShardTask;
            resolve: () => void;
            reject: (err: Error) => void;
            settled: boolean;
        };
        const workerInFlight = new Map<Worker, InFlight>();
        const freeWorkers: Worker[] = [];
        const pendingTasks: Array<() => void> = [];
        let dispatchHalted = false;

        const attachWorkerHandlers = (worker: Worker): void => {
            this.activeWorkers.add(worker);

            const failInFlight = (worker: Worker, error: Error): void => {
                const inflight = workerInFlight.get(worker);
                if (inflight && !inflight.settled) {
                    inflight.settled = true;
                    inflight.reject(error);
                }
            };

            const onMessage = (msg: TopMeanWorkerMessage): void => {
                if (msg.type === "progress") {
                    if (msg.status === "completed") {
                        completedPairsCount++;
                        options.manifest.completedPairsCount = completedPairsCount;
                        if (msg.engineUsed === "rust") engineUsage.rust += 1;
                        else if (msg.engineUsed === "typescript") engineUsage.typescript += 1;
                        options.onProgress?.(
                            completedPairsCount,
                            totalPairs,
                            `Backtesting pair ${completedPairsCount}/${totalPairs}: ${msg.symbol}`,
                        );
                    } else if (msg.status === "failed") {
                        options.manifest.failedPairsCount = (options.manifest.failedPairsCount || 0) + 1;
                    }
                    return;
                }

                const inflight = workerInFlight.get(worker);
                if (!inflight || inflight.settled) return;

                if (msg.type === "shard_complete") {
                    addWorkerTiming(workerTiming, msg.performance);
                    // A shard is complete only after its artifact is durable.
                    // Keeping the worker occupied until this settles bounds
                    // retained artifact closures to the worker count and lets
                    // the existing task retry path handle write failures.
                    const writePromise = (options.writeShardArtifacts ?? writeShardArtifactsAsync)(
                        options.runId,
                        msg.shardIndex,
                        msg.artifacts,
                        options.baseDir,
                    ).then(() => {
                        if (!completedSet.has(msg.shardIndex)) {
                            completedSet.add(msg.shardIndex);
                            options.manifest.completedShards.push(msg.shardIndex);
                        }
                        shardsSinceFlush += 1;
                        manifestDirty = true;
                        void flushManifest(false);
                        inflight.settled = true;
                        inflight.resolve();
                        releaseWorker(worker);
                    }).catch((err: unknown) => {
                        debugLogger.warn("sp500_top_mean.shard_write_failed", {
                            runId: options.runId,
                            shardIndex: msg.shardIndex,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        inflight.settled = true;
                        inflight.reject(err instanceof Error ? err : new Error(String(err)));
                        releaseWorker(worker);
                    }).finally(() => {
                        inFlightShardWrites.delete(writePromise);
                    });
                    inFlightShardWrites.add(writePromise);
                } else if (msg.type === "error") {
                    if (!failedSet.has(msg.shardIndex)) {
                        failedSet.add(msg.shardIndex);
                        options.manifest.failedShards.push(msg.shardIndex);
                    }
                    // Force-flush on errors so the failedShards list is
                    // durable before the rejection propagates.
                    manifestDirty = true;
                    void flushManifest(true);
                    inflight.settled = true;
                    inflight.reject(new Error(msg.error));
                    releaseWorker(worker);
                }
            };
            worker.on("message", onMessage);

            const onError = (err: Error): void => {
                failInFlight(worker, err instanceof Error ? err : new Error(String(err)));
                // Surface the failure: this path previously swallowed the
                // error object after routing it to the in-flight reject, so a
                // worker that OOM'd or hit a script-load error produced zero
                // diagnostic output even though the run kept going (or hung).
                debugLogger.warn("sp500_top_mean.worker_error", {
                    runId: options.runId,
                    error: err instanceof Error ? err.message : String(err),
                    activeWorkersBefore: this.activeWorkers.size,
                });
                // A worker that errored cannot be safely reused; drop it. The
                // free-list may have already absorbed it — remove if present.
                const freeIdx = freeWorkers.indexOf(worker);
                if (freeIdx >= 0) freeWorkers.splice(freeIdx, 1);
                this.activeWorkers.delete(worker);
                try { worker.terminate(); } catch { /* best-effort */ }
            };
            worker.on("error", onError);

            const onExit = (code: number): void => {
                // Unexpected exit while a task is in flight: fail the task.
                // Expected exits happen after we terminate() the worker at the
                // end of the run, by which point workerInFlight is empty.
                const inflight = workerInFlight.get(worker);
                if (inflight && !inflight.settled && code !== 0) {
                    inflight.settled = true;
                    inflight.reject(new Error(`Worker stopped with exit code ${code}`));
                }
                if (code !== 0) {
                    debugLogger.warn("sp500_top_mean.worker_unexpected_exit", {
                        runId: options.runId,
                        exitCode: code,
                        activeWorkersBefore: this.activeWorkers.size,
                    });
                }
                const freeIdx = freeWorkers.indexOf(worker);
                if (freeIdx >= 0) freeWorkers.splice(freeIdx, 1);
                this.activeWorkers.delete(worker);
            };
            worker.on("exit", onExit);
        };

        // Dispatch one task to a free worker, or queue it if all workers are
        // busy. Returns a Promise that resolves when the shard completes (or
        // rejects on error). The scheduler pulls queued tasks whenever a worker
        // returns to the free-list.
        const runShardOnWorker = (task: ShardTask): Promise<void> => {
            return new Promise<void>((resolvePromise, rejectPromise) => {
                if (this.isCancelled || dispatchHalted) {
                    return rejectPromise(new Error("Operation cancelled"));
                }

                const inflight: InFlight = {
                    task,
                    resolve: resolvePromise,
                    reject: rejectPromise,
                    settled: false,
                };

                const dispatch = (worker: Worker): void => {
                    workerInFlight.set(worker, inflight);
                    worker.postMessage(buildTaskData(task));
                };

                // Try to grab a free worker immediately; otherwise queue.
                // The dispatch loop caps activePromises at spawned.length, so
                // in steady state this branch is rare (only the retry path
                // can hit it, when its original worker just died). When
                // queued, releaseWorker's push-then-drain will pop a free
                // worker and call this callback.
                const free = freeWorkers.pop();
                if (free) {
                    dispatch(free);
                } else {
                    pendingTasks.push(() => {
                        // Re-check cancel between queueing and dispatch.
                        if (this.isCancelled || dispatchHalted) {
                            if (!inflight.settled) {
                                inflight.settled = true;
                                inflight.reject(new Error("Operation cancelled"));
                            }
                            return;
                        }
                        // releaseWorker pushes the freed worker BEFORE
                        // shifting this callback, so the pop below must
                        // succeed. If it ever doesn't (defensive), settle the
                        // inflight as a cancel rather than silently dropping.
                        const w = freeWorkers.pop();
                        if (!w) {
                            if (!inflight.settled) {
                                inflight.settled = true;
                                inflight.reject(new Error("No worker available for queued task"));
                            }
                            return;
                        }
                        dispatch(w);
                    });
                }
            });
        };

        // Release a worker back to the free-list and pump the pending queue.
        // Called from the message handler each time a shard settles.
        //
        // Push-then-drain order is the simpler and more robust form of the
        // free-list return: push the worker FIRST, then drain any queued
        // tasks so each can pop a free worker from inside its callback.
        // The prior shift-then-dispatch order relied on a subtle timing
        // invariant (reject-before-release in the message handler) to keep
        // the retry path from requeueing itself into a stuck queue. While
        // that ordering held today, push-then-drain removes the foot-gun
        // and the dead "no worker available, requeue" branch in
        // runShardOnWorker at once.
        const releaseWorker = (worker: Worker): void => {
            workerInFlight.delete(worker);
            if (dispatchHalted || this.isCancelled) return;
            freeWorkers.push(worker);
            // Drain any queued tasks that now have a free worker to grab.
            // Each callback pops its own worker via freeWorkers.pop(), so the
            // while condition re-checks the (post-pop) length on each iter.
            while (freeWorkers.length > 0 && pendingTasks.length > 0) {
                const next = pendingTasks.shift()!;
                next();
            }
        };

        // Spawn the worker pool. The workerData flag selects the smaller
        // parsed-CSV cache used by large TOP_MEAN runs.
        const spawned: Worker[] = [];
        let spawnedWorkerCount = 0;
        const workerStartupStartedAt = performance.now();
        try {
            for (let i = freeWorkers.length; i < workerCount; i++) {
                if (this.isCancelled) break;
                const worker = new Worker(workerScriptPath, { workerData: { topMean: true } });
                attachWorkerHandlers(worker);
                freeWorkers.push(worker);
                spawned.push(worker);
                spawnedWorkerCount += 1;
            }
        } catch (err) {
            // If spawn failed mid-loop, terminate what we got and rethrow.
            for (const w of spawned) {
                try { w.terminate(); } catch { /* best-effort */ }
                this.activeWorkers.delete(w);
            }
            throw err;
        }
        const workerStartupMs = performance.now() - workerStartupStartedAt;

        // If the pool couldn't spawn any workers (e.g. script resolution
        // issue), surface that explicitly rather than hanging.
        if (spawned.length === 0 && !this.isCancelled) {
            throw new Error("Failed to spawn any TOP_MEAN workers");
        }

        // Concurrency driver: dispatch up to `spawned.length` shards in
        // parallel. Each completed/failed shard releases its worker via
        // `releaseWorker` inside the message handler, which then pulls the
        // next pending task and dispatches it on the freed worker. The
        // `.finally` here only updates the active-set bookkeeping.
        let queueIndex = 0;
        const activePromises: Set<Promise<void>> = new Set();

        try {
            while (queueIndex < pendingShards.length || activePromises.size > 0) {
                if (this.isCancelled) {
                    throw new Error("Operation cancelled");
                }

                while (
                    activePromises.size < spawned.length
                    && queueIndex < pendingShards.length
                ) {
                    const task = pendingShards[queueIndex++];
                    const promise = runShardOnWorker(task)
                        .catch((err) => {
                            // Retry shard once on failure.
                            if (!this.isCancelled) {
                                return runShardOnWorker(task);
                            }
                            throw err;
                        })
                        .finally(() => {
                            activePromises.delete(promise);
                        });

                    activePromises.add(promise);
                }

                if (activePromises.size > 0) {
                    await Promise.race(activePromises);
                }

                // All-workers-dead guard (B5). If every spawned worker has
                // died (OOM, script-load error, etc.) there is nothing left
                // to call `releaseWorker`, which means any task sitting in
                // `pendingTasks` and any retry whose `runShardOnWorker`
                // chained into `pendingTasks` will NEVER settle. Without
                // this guard `Promise.race(activePromises)` hangs forever
                // and the only recovery is a Stop. Surface the fatal
                // condition so the run terminates with a diagnostic.
                //
                // The check fires when no worker is left alive AND no worker
                // is idle (freeWorkers empty) AND there is still work to do.
                // The caught throw's `Promise.allSettled(activePromises)`
                // lets any in-flight retry settle defensively via the
                // callback's "No worker available" branch.
                if (
                    this.activeWorkers.size === 0
                    && freeWorkers.length === 0
                    && (pendingTasks.length > 0 || queueIndex < pendingShards.length)
                    && !this.isCancelled
                ) {
                    debugLogger.warn("sp500_top_mean.all_workers_died", {
                        runId: options.runId,
                        pendingTaskCount: pendingTasks.length,
                        unqueuedShardCount: Math.max(0, pendingShards.length - queueIndex),
                        activePromiseCount: activePromises.size,
                    });
                    // Reject the queued callbacks so their inflight promises
                    // settle defensively (each callback's "No worker
                    // available" branch handles the empty free-list).
                    const stuck = pendingTasks.splice(0);
                    for (const cb of stuck) cb();
                    throw new Error(
                        `All TOP_MEAN workers died mid-run (runId=${options.runId}); `
                            + `${stuck.length} queued task(s) and `
                            + `${Math.max(0, pendingShards.length - queueIndex)} unqueued shard(s) left unprocessed.`,
                    );
                }
            }
        } catch (error) {
            // Force-flush whatever we have before propagating so the
            // interrupted/cancel state on disk reflects progress through the
            // last completed shard (resume reattach reads from this). Await
            // any in-flight async shard writes first so the manifest cannot
            // claim a shard whose artifacts have not landed yet.
            await settleInFlightShardWrites();
            await flushManifest(true);
            dispatchHalted = true;
            this.cancel();
            await Promise.allSettled(activePromises);
            throw error;
        }
        // Final force-flush so the terminal manifest reflects every completed
        // shard, not the most recent debounced snapshot. Await in-flight
        // shard writes first so the manifest cannot precede the artifacts.
        await settleInFlightShardWrites();
        await requireManifestFlush();
        dispatchHalted = true;
        // Terminate the persistent workers now that the run is done.
        this.cancel();
        return {
            ...engineUsage,
            performance: {
                ...workerTiming,
                workers: spawned.length,
                spawnedWorkers: spawnedWorkerCount,
                shards: shardTasks.length,
                pendingShards: pendingShards.length,
                shardSize,
                workerBundleMs,
                workerStartupMs,
                wallMs: performance.now() - poolStartedAt,
            },
        };
    }
}
