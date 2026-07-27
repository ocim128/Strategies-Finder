import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { TopMeanRunManifest } from "./compact-pair-artifact";
import { saveManifest, writeShardArtifactsAsync } from "./sp500-top-mean-artifact-store";
import type { TopMeanWorkerMessage, TopMeanWorkerTaskData } from "./sp500-top-mean-worker";
import { debugLogger } from "../debug-logger";
import type {
    TopMeanCacheCounters,
    TopMeanWorkerPoolPerformance,
    TopMeanWorkerTiming,
} from "./sp500-top-mean-performance";

export const TOP_MEAN_DEFAULT_SHARD_SIZE = 250;
export const TOP_MEAN_TARGET_SHARDS_PER_WORKER = 4;

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
 * Per-process cache of the last resolved worker bundle, keyed by the source
 * file's `mtimeMs` + `size`. esbuild is invoked on every `execute()` call
 * (once per stability window), and a single esbuild.build() is 50-150ms —
 * the bundle bytes hash identically across invocations until the source
 * changes, so a cheap stat before the bundle call cuts per-window latency
 * back to one filesystem stat.
 */
let cachedWorkerBundle: { sourcePath: string; mtimeMs: number; size: number; outfile: string } | null = null;

async function bundleWorkerWithEsbuild(sourcePath: string): Promise<string> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const esbuild = (await import("esbuild")) as unknown as {
        build: (opts: any) => Promise<{ outputFiles?: Array<{ contents: Uint8Array }> }>;
    };
    const tmp = os.tmpdir();
    const root = join(tmp, "sp500-top-mean-workers");

    // Cheap cache check: if the source file's mtime + size match the last
    // successful bundle, reuse its outfile without re-running esbuild.
    try {
        const stat = await fs.stat(sourcePath);
        if (
            cachedWorkerBundle
            && cachedWorkerBundle.sourcePath === sourcePath
            && cachedWorkerBundle.mtimeMs === stat.mtimeMs
            && cachedWorkerBundle.size === stat.size
            && await fs.access(cachedWorkerBundle.outfile).then(() => true).catch(() => false)
        ) {
            return cachedWorkerBundle.outfile;
        }
    } catch {
        // Stat failure: fall through to the full bundle path.
    }

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
    // Refresh the cache key from the freshest stat available.
    try {
        const stat = await fs.stat(sourcePath);
        cachedWorkerBundle = { sourcePath, mtimeMs: stat.mtimeMs, size: stat.size, outfile };
    } catch {
        // Best-effort: leave the previous cache entry in place.
    }
    return outfile;
}

export function resolveTopMeanWorkerCount(explicit?: number): number {
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
        return Math.max(1, Math.min(24, Math.floor(explicit)));
    }
    let cores = 8;
    try {
        cores = availableParallelism() || cores;
    } catch {
        // Fallback for older Node versions
    }
    return Math.max(1, Math.min(24, cores - 4));
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
    /**
     * Optional start-date slice (unix seconds) for the stability mode. When
     * set, each worker trims its loaded candles to [backtestFromSec, inf)
     * BEFORE executeBacktest, so the open position reflects a simulation that
     * started at this date. Undefined = full history (existing behavior).
     */
    backtestFromSec?: number;
    /**
     * Optional window key for per-start-date artifact partitioning. When set,
     * shards + manifest land in <runDir>/windows/<windowKey>/ so concurrent
     * stability windows do not overwrite each other. Undefined = top-level
     * <runDir>/shards (existing behavior).
     */
    windowKey?: string;
    /**
     * When true, `execute()` does NOT terminate its workers at the end of the
     * run — they stay spawned and ready for the next `execute()` call on the
     * SAME pool instance. Used by stability mode so the workers' in-memory
     * pair/leg LRU caches survive across windows (the synthetic-pair disk
     * cache already eliminates the 30m-aggregation cost across windows; this
     * layer additionally eliminates the disk JSON re-parse per window).
     *
     * Contract: the caller MUST eventually call {@link cancel} on the pool
     * (typically in a `finally`) to terminate the workers; otherwise they
     * will outlive the run. The coordinator's existing `stop()` / `finally`
     * paths already do this.
     */
    keepWorkersAlive?: boolean;
    onProgress?: (completedPairs: number, totalPairs: number, text: string) => void;
}

export interface ShardTask {
    shardIndex: number;
    pairs: Array<{ pairIndex: number; symbol: string }>;
}

export class TopMeanWorkerPool {
    private activeWorkers = new Set<Worker>();
    private isCancelled = false;
    /**
     * Workers that survived the previous `execute()` call (because
     * `keepWorkersAlive` was true) and are ready for reuse. Persisted at the
     * instance level so a coordinator that creates ONE pool and calls
     * `execute()` N times (e.g. stability mode's per-window calls) gets
     * worker reuse + the workers' in-memory dataset caches for free.
     * Cleared by {@link cancel}.
     */
    private reusableWorkers: Worker[] = [];
    /**
     * Per-worker disposers returned by {@link attachWorkerHandlers}. Each
     * entry is a list of `() => void` functions that remove ONLY the handlers
     * the pool attached (NOT Node's internal 'exit'/'error' wiring). The
     * absorb path calls these before re-attaching, so a worker can move from
     * one execute() call to the next without `Worker.removeAllListeners()`
     * (which nukes the internal message pump and silently breaks reuse).
     */
    private workerAttachedListeners = new WeakMap<Worker, Array<() => void>>();

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
        for (const worker of this.reusableWorkers) {
            try {
                worker.terminate();
            } catch {
                // Ignore worker termination error
            }
        }
        this.reusableWorkers = [];
    }

    public async execute(options: WorkerPoolRunOptions): Promise<TopMeanWorkerPoolExecutionResult> {
        const poolStartedAt = performance.now();
        const workerCount = resolveTopMeanWorkerCount(options.workerCount);
        const totalPairs = options.canonicalPairs.length;
        // Completed shard indexes are meaningful only under the size that
        // created them. A resumed run must preserve that persisted partition;
        // new runs are free to use the dynamic worker-fed size.
        const resumedShardSize = (
            options.manifest.completedShards.length > 0
            || options.manifest.failedShards.length > 0
        )
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
        const flushManifest = (force: boolean): void => {
            if (!manifestDirty && !force) return;
            const due = force
                || shardsSinceFlush >= MANIFEST_FLUSH_EVERY_N_SHARDS
                || Date.now() - lastFlushAt >= MANIFEST_FLUSH_INTERVAL_MS;
            if (!due) return;
            saveManifest(options.manifest, options.baseDir, options.windowKey);
            manifestDirty = false;
            shardsSinceFlush = 0;
            lastFlushAt = Date.now();
        };

        // Partition pairs into shards
        const shardTasks: ShardTask[] = [];
        let shardIndex = 0;
        for (let i = 0; i < totalPairs; i += shardSize) {
            const pairSlice = options.canonicalPairs.slice(i, i + shardSize).map((symbol, idx) => ({
                pairIndex: i + idx,
                symbol,
            }));
            shardTasks.push({
                shardIndex,
                pairs: pairSlice,
            });
            shardIndex++;
        }

        options.manifest.totalShards = shardTasks.length;
        saveManifest(options.manifest, options.baseDir, options.windowKey);

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
        const workerScriptPath = await resolveTopMeanWorkerPath();
        const workerBundleMs = performance.now() - workerBundleStartedAt;

        // ---- Persistent worker pool (F3+F7) ---------------------------------
        // The prior implementation spawned a fresh `new Worker(...)` per shard
        // and terminated it after one shard_complete. Each worker cold-start
        // eagerly evaluates the 188-strategy manifest + backtest-executor
        // import graph (~1000+ lines transitive), so per-shard overhead was
        // ~workerCount× the steady-state cost. The worker file ALREADY exposes
        // a `parentPort.on("message", ...)` follow-up handler alongside the
        // workerData one-shot — that handler was dead code (F7). Spawn workers
        // ONCE without workerData (so the one-shot branch is skipped and the
        // message listener handles every task), reuse them across shards via
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
            ...(options.backtestFromSec !== undefined ? { backtestFromSec: options.backtestFromSec } : {}),
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
            // Track disposers so the absorb path on the NEXT execute() call
            // can remove ONLY these handlers without nuking Node's internal
            // Worker wiring (removeAllListeners breaks the message pump).
            const disposers: Array<() => void> = [];

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
                    // Fire the artifact write asynchronously and track it.
                    // The shard artifact is multi-hundred-KB; writing it
                    // synchronously here blocked the message handler (and
                    // therefore the rest of the event loop) for the duration
                    // of `writeFileSync` + the Windows EPERM retry loop. The
                    // worker has already moved on; we only need the artifact
                    // on disk before the terminal manifest flush, which
                    // `settleInFlightShardWrites()` guarantees.
                    const writePromise = writeShardArtifactsAsync(
                        options.runId,
                        msg.shardIndex,
                        msg.artifacts,
                        options.baseDir,
                        options.windowKey,
                    ).catch((err: unknown) => {
                        // Best-effort: a failed artifact write is not fatal to
                        // the run, but the shard will be missing on resume.
                        // Surface via debug so the operator can see it without
                        // taking down the whole batch.
                        debugLogger.warn("sp500_top_mean.shard_write_failed", {
                            runId: options.runId,
                            shardIndex: msg.shardIndex,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }).finally(() => {
                        inFlightShardWrites.delete(writePromise);
                    });
                    inFlightShardWrites.add(writePromise);
                    if (!completedSet.has(msg.shardIndex)) {
                        completedSet.add(msg.shardIndex);
                        options.manifest.completedShards.push(msg.shardIndex);
                    }
                    // Debounced flush: the shard ARTIFACTS are queued to land
                    // on disk (above); the manifest only matters for resume
                    // reattach, which tolerates a small lag (startup
                    // reconcile covers the gap). The terminal-path
                    // flushManifest(true) calls await the in-flight writes
                    // first so the manifest never claims a shard that has
                    // not yet been written.
                    shardsSinceFlush += 1;
                    manifestDirty = true;
                    flushManifest(false);
                    inflight.settled = true;
                    inflight.resolve();
                    // Return the worker to the free-list and pull the next
                    // pending task. Done here (not in the promise .finally)
                    // because the message handler is the only place that knows
                    // WHICH worker handled this task.
                    releaseWorker(worker);
                } else if (msg.type === "error") {
                    if (!failedSet.has(msg.shardIndex)) {
                        failedSet.add(msg.shardIndex);
                        options.manifest.failedShards.push(msg.shardIndex);
                    }
                    // Force-flush on errors so the failedShards list is
                    // durable before the rejection propagates.
                    manifestDirty = true;
                    flushManifest(true);
                    inflight.settled = true;
                    inflight.reject(new Error(msg.error));
                    releaseWorker(worker);
                }
            };
            worker.on("message", onMessage);
            disposers.push(() => worker.off("message", onMessage));

            const onError = (err: Error): void => {
                failInFlight(worker, err instanceof Error ? err : new Error(String(err)));
                // A worker that errored cannot be safely reused; drop it. The
                // free-list may have already absorbed it — remove if present.
                const freeIdx = freeWorkers.indexOf(worker);
                if (freeIdx >= 0) freeWorkers.splice(freeIdx, 1);
                this.activeWorkers.delete(worker);
                // Also drop from the cross-execute reusable list — a worker
                // can die between windows (e.g. OOM while idle) and the next
                // absorb would otherwise re-attach handlers to a dead worker
                // and silently hang on its first postMessage.
                const reusableIdx = this.reusableWorkers.indexOf(worker);
                if (reusableIdx >= 0) this.reusableWorkers.splice(reusableIdx, 1);
                try { worker.terminate(); } catch { /* best-effort */ }
            };
            worker.on("error", onError);
            disposers.push(() => worker.off("error", onError));

            const onExit = (code: number): void => {
                // Unexpected exit while a task is in flight: fail the task.
                // Expected exits happen after we terminate() the worker at the
                // end of the run, by which point workerInFlight is empty.
                const inflight = workerInFlight.get(worker);
                if (inflight && !inflight.settled && code !== 0) {
                    inflight.settled = true;
                    inflight.reject(new Error(`Worker stopped with exit code ${code}`));
                }
                const freeIdx = freeWorkers.indexOf(worker);
                if (freeIdx >= 0) freeWorkers.splice(freeIdx, 1);
                this.activeWorkers.delete(worker);
                // Same cross-execute cleanup as onError — see comment there.
                const reusableIdx = this.reusableWorkers.indexOf(worker);
                if (reusableIdx >= 0) this.reusableWorkers.splice(reusableIdx, 1);
            };
            worker.on("exit", onExit);
            disposers.push(() => worker.off("exit", onExit));

            this.workerAttachedListeners.set(worker, disposers);
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

        // Spawn or reuse the persistent worker pool. No workerData → the
        // worker's one-shot branch is skipped and the message listener handles
        // every task, which is what makes them reusable. When this same pool
        // instance ran a previous `execute({ keepWorkersAlive: true })`, those
        // workers survive in `this.reusableWorkers` and are reabsorbed here —
        // their in-memory dataset LRU caches come with them, eliminating the
        // disk JSON re-parse cost across windows in stability mode.
        const spawned: Worker[] = [];
        let reusedWorkerCount = 0;
        let spawnedWorkerCount = 0;
        const workerStartupStartedAt = performance.now();
        try {
            // First absorb any reusable workers from a prior execute() call.
            // The activeWorkers Set is preserved so cancel() / error handling
            // still tracks them.
            while (this.reusableWorkers.length > 0 && freeWorkers.length < workerCount) {
                const w = this.reusableWorkers.pop()!;
                // Detach the previous execute() call's listeners. We track
                // them via the per-worker WeakMap so we remove ONLY our own
                // handlers — Worker.removeAllListeners() would also nuke
                // Node's internal 'exit'/'error' wiring and silently break
                // the worker's message pump on the next postMessage.
                const prev = this.workerAttachedListeners.get(w);
                if (prev) {
                    for (const fn of prev) fn();
                    this.workerAttachedListeners.delete(w);
                }
                attachWorkerHandlers(w);
                freeWorkers.push(w);
                spawned.push(w);
                reusedWorkerCount += 1;
            }
            // Spawn any additional workers needed to reach workerCount.
            for (let i = freeWorkers.length; i < workerCount; i++) {
                if (this.isCancelled) break;
                const worker = new Worker(workerScriptPath, {});
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
            }
        } catch (error) {
            // Force-flush whatever we have before propagating so the
            // interrupted/cancel state on disk reflects progress through the
            // last completed shard (resume reattach reads from this). Await
            // any in-flight async shard writes first so the manifest cannot
            // claim a shard whose artifacts have not landed yet.
            await settleInFlightShardWrites();
            flushManifest(true);
            dispatchHalted = true;
            this.cancel();
            await Promise.allSettled(activePromises);
            throw error;
        }
        // Final force-flush so the terminal manifest reflects every completed
        // shard, not the most recent debounced snapshot. Await in-flight
        // shard writes first so the manifest cannot precede the artifacts.
        await settleInFlightShardWrites();
        flushManifest(true);
        dispatchHalted = true;
        if (options.keepWorkersAlive) {
            // Preserve workers for the next execute() call on this same pool
            // instance. Their in-memory dataset LRU caches survive with them.
            // Listeners stay attached; they will be removeAllListeners()'d on
            // the next absorb (or cleared by cancel()).
            for (const w of spawned) {
                // A worker may still be in activeWorkers if it crashed during
                // the run; only retain live ones.
                if (this.activeWorkers.has(w)) {
                    this.reusableWorkers.push(w);
                }
            }
            // Do NOT clear this.activeWorkers here — the next execute() will
            // re-add the same workers via attachWorkerHandlers, and cancel()
            // (the cleanup path) iterates both sets.
        } else {
            // Terminate the persistent workers now that the run is done.
            this.cancel();
        }
        return {
            ...engineUsage,
            performance: {
                ...workerTiming,
                workers: spawned.length,
                spawnedWorkers: spawnedWorkerCount,
                reusedWorkers: reusedWorkerCount,
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
