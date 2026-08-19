/**
 * Coordinator for the parallel Finder Asset Opportunity BATCH holdout sweep.
 *
 * Partitions the ascending holdout sweep across a bounded pool of
 * worker_threads (a task is either one whole holdout or one contiguous asset
 * chunk), then returns completed iterations to the caller IN ASCENDING
 * HOLDOUT ORDER so the existing
 * archive-append / `asset_batch_iteration_done` / snapshot bookkeeping stays
 * on the main thread and byte-identical to the sequential loop.
 *
 * Semantics preserved from the sequential loop:
 *  - `onIterationResult` is awaited for iteration i before iteration i+1 is
 *    emitted (archive appends stay strictly ordered).
 *  - A fatal iteration stops the sweep with a visible fatal; iterations
 *    BEFORE the failed index complete and archive normally (their runners are
 *    allowed to finish), iterations AFTER it are stopped and discarded.
 *  - On Stop/cancel, in-flight iterations are aborted and discarded, while
 *    iterations that already completed (even if not yet emitted) flush in
 *    ascending order — the sequential loop archives the same set because it
 *    cannot have unarchived completed iterations at Stop time.
 *
 * Worker count policy: `FINDER_ASSET_BATCH_WORKERS` env override (1 = the
 * caller keeps the sequential in-process loop); otherwise
 * min(effective task count, cores - 2, memoryCeiling) where memoryCeiling
 * estimates one full dataset copy per worker (~9 MB/symbol) against a 48 GB
 * budget. Chunked tasks carry only their assigned asset partition and are
 * affinity-scheduled to the same persistent worker across holdouts, preserving
 * that worker's leg/pair cache.
 *
 * Import hygiene (the documented vite.config bundle trap): leaf modules and
 * node:worker_threads only. This module is imported by finder-vite-plugin.ts
 * and must NOT transitively reach `lightweight-charts`.
 */

import { availableParallelism, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { debugLogger } from "../../debug-logger";
import type { AssetOpportunityIterationResult } from "./asset-opportunity-iteration";
import type {
    AssetOpportunityBatchWorkerCommand,
    AssetOpportunityBatchWorkerEvent,
    AssetOpportunityBatchWorkerTask,
} from "./finder-asset-opportunity-batch-worker";

export type {
    AssetOpportunityBatchWorkerCommand,
    AssetOpportunityBatchWorkerEvent,
    AssetOpportunityBatchWorkerTask,
} from "./finder-asset-opportunity-batch-worker";

// ---------------------------------------------------------------------------
// Worker count policy
// ---------------------------------------------------------------------------

export const FINDER_ASSET_BATCH_WORKERS_ENV = "FINDER_ASSET_BATCH_WORKERS";

/** Hard cap so a mistyped env value cannot fork an absurd pool. */
export const ASSET_OPPORTUNITY_BATCH_WORKER_COUNT_MAX = 32;

/**
 * Fraction of TOTAL system memory the worker pool may budget for dataset
 * copies. The main dev-server process and the OS keep the rest. Workers are
 * separate isolates, so `--max-old-space-size` (per-isolate) cannot bound the
 * SUM of their footprints — only this budget does.
 */
const ASSET_OPPORTUNITY_BATCH_MEMORY_BUDGET_FRACTION = 0.75;
const ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL = 9 * 1024 * 1024;

/** 75% of ACTUAL system RAM budgeted for dataset copies (injectable for tests). */
function resolveAssetOpportunityMemoryBudgetBytes(systemMemoryBytes: number): number {
    return Math.max(
        1,
        Math.floor(
            (Number.isFinite(systemMemoryBytes) && systemMemoryBytes > 0
                ? systemMemoryBytes
                : 8 * 1024 * 1024 * 1024)
            * ASSET_OPPORTUNITY_BATCH_MEMORY_BUDGET_FRACTION,
        ),
    );
}

/**
 * Capacity for a run-scoped PLAIN-dataset LRU that retains one copy of every
 * symbol's series across batch holdout iterations (~9 MB/symbol at the 100k-bar
 * cap). Uses the SAME memory budget as the worker-count policy so the retention
 * a pool of N workers can afford is the retention the cache allows: bounded by
 * the symbol count (never more entries than symbols exist) and by
 * floor(budget / 9MB).
 */
export function resolveAssetOpportunityDatasetCacheCapacity(
    symbolCount: number,
    systemMemoryBytes: number = totalmem(),
): number {
    const memoryCeilingEntries = Math.floor(
        resolveAssetOpportunityMemoryBudgetBytes(systemMemoryBytes)
        / ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL,
    );
    return Math.max(1, Math.min(Math.max(1, Math.floor(symbolCount)), memoryCeilingEntries));
}

/**
 * Auto-pool cap when the Rust engine is preferred: its external HTTP server
 * serializes execution, so a large pool only multiplies queued requests.
 * The env override deliberately bypasses this cap (operator judgment).
 */
export const ASSET_OPPORTUNITY_BATCH_RUST_WORKER_CAP = 8;

/**
 * Resolve the worker count for one batch sweep.
 *
 * - `FINDER_ASSET_BATCH_WORKERS` env: integer >= 1 wins outright (1 = caller
 *   should keep the sequential in-process loop; this is also the rollback
 *   lever). The override intentionally bypasses the memory ceiling — it is
 *   the operator's explicit judgment call — but is still capped at
 *   {@link ASSET_OPPORTUNITY_BATCH_WORKER_COUNT_MAX}.
 * - Auto: min(effective task count, logical cores - 2, memory ceiling). The memory
 *   ceiling budgets 75% of ACTUAL system RAM (`os.totalmem()`, injectable for
 *   tests) for one full dataset copy per worker (~9 MB/symbol), so a 16 GB
 *   host auto-selects ~3x fewer workers than a 64 GB host. Always >= 1.
 *   `options.taskCount` replaces the holdout count when a caller decomposes
 *   each holdout into independent asset chunks.
 *   `options.taskSymbolCount` replaces `symbolCount` for the memory estimate
 *   when each task retains only an asset partition.
 * - `options.rustEngine`: clamps the AUTO value (never the env override) to
 *   {@link ASSET_OPPORTUNITY_BATCH_RUST_WORKER_CAP} — the Rust server
 *   serializes, so extra workers only contend for its queue.
 */
export function resolveAssetOpportunityBatchWorkerCount(
    holdoutCount: number,
    symbolCount: number,
    env: NodeJS.ProcessEnv = process.env,
    systemMemoryBytes: number = totalmem(),
    options?: { rustEngine?: boolean; taskCount?: number; taskSymbolCount?: number },
): number {
    const raw = env[FINDER_ASSET_BATCH_WORKERS_ENV];
    if (raw !== undefined && raw !== "") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 1) {
            return Math.max(1, Math.min(ASSET_OPPORTUNITY_BATCH_WORKER_COUNT_MAX, Math.floor(parsed)));
        }
    }
    let cores = 8;
    try {
        cores = availableParallelism() || cores;
    } catch {
        // Older Node without availableParallelism; keep the conservative default.
    }
    const memoryBudgetBytes = resolveAssetOpportunityMemoryBudgetBytes(systemMemoryBytes);
    const memorySymbolCount = Math.max(1, Math.floor(options?.taskSymbolCount ?? symbolCount));
    const memoryCeiling = Math.max(
        1,
        Math.floor(
            memoryBudgetBytes / (memorySymbolCount * ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL),
        ),
    );
    const auto = Math.max(
        1,
        Math.min(
            Math.max(1, Math.floor(options?.taskCount ?? holdoutCount)),
            Math.max(1, cores - 2),
            memoryCeiling,
        ),
    );
    if (options?.rustEngine === true) {
        return Math.min(auto, ASSET_OPPORTUNITY_BATCH_RUST_WORKER_CAP);
    }
    return auto;
}

// ---------------------------------------------------------------------------
// Worker script resolution (pattern-mirrors sp500-top-mean-worker-pool.ts)
// ---------------------------------------------------------------------------

function moduleThisFileDir(): string {
    try {
        return dirname(fileURLToPath(import.meta.url));
    } catch {
        return __dirname;
    }
}

export async function resolveAssetOpportunityBatchWorkerPath(): Promise<string> {
    const fs = await import("node:fs/promises");
    const repositorySource = resolve(
        process.cwd(),
        "lib",
        "finder",
        "server",
        "finder-asset-opportunity-batch-worker.ts",
    );
    const moduleSource = join(moduleThisFileDir(), "finder-asset-opportunity-batch-worker.ts");
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
 * file's mtime + size (one esbuild.build() is 50-150ms; a cheap stat cuts
 * that back to a single filesystem access while the source is unchanged).
 */
let cachedWorkerBundle: { sourcePath: string; mtimeMs: number; size: number; outfile: string } | null = null;

async function bundleWorkerWithEsbuild(sourcePath: string): Promise<string> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const esbuild = (await import("esbuild")) as unknown as {
        build: (opts: any) => Promise<{ outputFiles?: Array<{ contents: Uint8Array }> }>;
    };
    const tmp = os.tmpdir();
    const root = join(tmp, "finder-asset-opportunity-batch-workers");

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
        throw new Error("esbuild produced an empty asset-opportunity batch worker bundle");
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
    try {
        const stat = await fs.stat(sourcePath);
        cachedWorkerBundle = { sourcePath, mtimeMs: stat.mtimeMs, size: stat.size, outfile };
    } catch {
        // Best-effort: leave the previous cache entry in place.
    }
    return outfile;
}

// ---------------------------------------------------------------------------
// Task runner abstraction (production: real Worker; tests: in-process fakes)
// ---------------------------------------------------------------------------

export interface AssetOpportunityBatchRunnerEvents {
    onProgress: (
        task: AssetOpportunityBatchWorkerTask,
        progress: {
            percent: number;
            status: string;
            phase: string;
            assetIndex: number;
            loadedSymbols: number;
            failedSymbols: number;
            strategyIndex: number;
        },
    ) => void;
    onRunLog: (event: string, payload: Record<string, unknown>) => void;
    onComplete: (task: AssetOpportunityBatchWorkerTask, iteration: AssetOpportunityIterationResult) => void;
    onFatal: (task: AssetOpportunityBatchWorkerTask, error: string) => void;
}

export interface AssetOpportunityBatchTaskRunner {
    /** Start one task; exactly one terminal callback (onComplete/onFatal) follows. */
    runTask(task: AssetOpportunityBatchWorkerTask): void;
    /** Best-effort abort of the in-flight task (Stop / sweep-fatal). */
    stop(): void;
    /** Terminate the runner; resolves once the underlying worker is gone. */
    dispose(): Promise<void>;
}

export type AssetOpportunityBatchRunnerFactory = (
    events: AssetOpportunityBatchRunnerEvents,
) => AssetOpportunityBatchTaskRunner | Promise<AssetOpportunityBatchTaskRunner>;

/**
 * Production runner: one persistent worker_threads Worker per runner, one
 * task at a time (the worker's dataset caches persist across tasks).
 */
export async function createRealWorkerAssetOpportunityBatchRunner(
    events: AssetOpportunityBatchRunnerEvents,
): Promise<AssetOpportunityBatchTaskRunner> {
    const workerPath = await resolveAssetOpportunityBatchWorkerPath();
    const worker = new Worker(workerPath, {});
    let currentTask: AssetOpportunityBatchWorkerTask | null = null;
    let disposed = false;
    let stopping = false;
    let termination: Promise<number> | null = null;
    const terminateWorker = (): Promise<number> => {
        termination ??= worker.terminate();
        return termination;
    };
    const takeCurrentTask = (): AssetOpportunityBatchWorkerTask | null => {
        const task = currentTask;
        currentTask = null;
        return task;
    };

    worker.on("message", (message: AssetOpportunityBatchWorkerEvent) => {
        if (message.type === "progress") {
            if (currentTask && currentTask.taskIndex === message.taskIndex) {
                events.onProgress(currentTask, {
                    percent: message.percent,
                    status: message.status,
                    phase: message.phase,
                    assetIndex: message.assetIndex,
                    loadedSymbols: message.loadedSymbols,
                    failedSymbols: message.failedSymbols,
                    strategyIndex: message.strategyIndex,
                });
            }
            return;
        }
        if (message.type === "run_log") {
            events.onRunLog(message.event, message.payload);
            return;
        }
        if (message.type === "iteration_complete") {
            const task = takeCurrentTask();
            if (task && task.taskIndex === message.taskIndex) {
                events.onComplete(task, {
                    results: message.results,
                    cancelled: message.cancelled,
                    assetDiagnostics: message.assetDiagnostics,
                    totals: message.totals,
                    summary: "",
                });
            }
            return;
        }
        if (message.type === "iteration_fatal") {
            const task = takeCurrentTask();
            if (task && task.taskIndex === message.taskIndex) {
                events.onFatal(task, message.error);
            }
        }
    });
    worker.on("error", (error: Error) => {
        const task = takeCurrentTask();
        if (task) {
            events.onFatal(task, `batch worker crashed: ${error.message}`);
        }
    });
    worker.on("exit", (code) => {
        const task = takeCurrentTask();
        // ANY exit with a task still current is fatal for that task — a
        // clean-exit disappearance mid-task would otherwise leave the sweep
        // waiting forever for a terminal callback.
        if (task) {
            events.onFatal(
                task,
                code !== 0
                    ? `batch worker exited with code ${code}`
                    : "batch worker exited unexpectedly mid-task",
            );
        }
    });

    return {
        runTask: (task) => {
            if (disposed || stopping) {
                events.onFatal(task, "batch worker was stopped before task start");
                return;
            }
            currentTask = task;
            const command: AssetOpportunityBatchWorkerCommand = { type: "run_task", task };
            worker.postMessage(command);
        },
        stop: () => {
            if (disposed || stopping) return;
            stopping = true;
            // A worker may be inside a long synchronous simulation and unable
            // to service parentPort until it yields. Terminate immediately so
            // Stop cannot leave CPU/RAM-heavy orphan work behind. The exit
            // handler reports the in-flight task as terminal; the sweep treats
            // that callback as cancellation when its flag is set.
            void terminateWorker();
        },
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            stopping = true;
            await terminateWorker();
        },
    };
}

// ---------------------------------------------------------------------------
// Sweep coordinator
// ---------------------------------------------------------------------------

export interface AssetOpportunityBatchSweepAggregate {
    /** Mean per-iteration progress over ALL tasks (0-100), completed = 100. */
    percent: number;
    /** Holdout bars of every currently in-flight iteration, ascending. */
    inFlightHoldoutBars: number[];
}

export interface AssetOpportunityBatchSweepArgs {
    /** Ordered ascending by taskIndex (iteration order == holdout order). */
    tasks: AssetOpportunityBatchWorkerTask[];
    runnerCount: number;
    createRunner: AssetOpportunityBatchRunnerFactory;
    /**
     * Called once per COMPLETED iteration in ascending task order; awaited
     * before the next iteration is emitted. Throws propagate out of the
     * sweep (after runners are stopped and disposed) — the caller maps them
     * to its archive-fatal path.
     */
    onIterationResult: (task: AssetOpportunityBatchWorkerTask, iteration: AssetOpportunityIterationResult) => Promise<void>;
    onProgress: (
        task: AssetOpportunityBatchWorkerTask,
        progress: {
            percent: number;
            status: string;
            phase: string;
            assetIndex: number;
            loadedSymbols: number;
            failedSymbols: number;
            strategyIndex: number;
        },
        aggregate: AssetOpportunityBatchSweepAggregate,
    ) => void;
    onRunLog: (event: string, payload: Record<string, unknown>) => void;
    isCancelled: () => boolean;
}

export interface AssetOpportunityBatchSweepResult {
    cancelled: boolean;
    /** Iterations whose onIterationResult completed (archived). */
    completedIterations: number;
    /** The first fatal iteration, if any; callers surface it as batch-fatal. */
    fatal: { task: AssetOpportunityBatchWorkerTask; error: string } | null;
}

/**
 * Drive the parallel sweep. See the module header for the exact sequential-
 * parity semantics (ordered emission, fatal isolation, cancel flush).
 */
export async function runAssetOpportunityBatchSweep(
    args: AssetOpportunityBatchSweepArgs,
): Promise<AssetOpportunityBatchSweepResult> {
    const tasks = args.tasks;
    const totalTasks = tasks.length;
    const runnerCount = Math.max(1, Math.min(args.runnerCount, totalTasks));
    const runners: AssetOpportunityBatchTaskRunner[] = [];

    let nextTaskIndex = 0;
    let nextToEmit = 0;
    let completedIterations = 0;
    let cancelledFlag = false;
    let sweepError: unknown = null;
    let fatal: { task: AssetOpportunityBatchWorkerTask; error: string } | null = null;
    const buffered = new Map<number, { task: AssetOpportunityBatchWorkerTask; iteration: AssetOpportunityIterationResult }>();
    const inFlight = new Map<number, AssetOpportunityBatchWorkerTask>();
    const percentByIndex = new Map<number, number>();
    const freeRunners: AssetOpportunityBatchTaskRunner[] = [];
    const chunkAffinityMode = tasks.length > 0 && tasks.every(
        (task) => Number.isInteger(task.assetChunkIndex)
            && Number.isInteger(task.assetChunkCount)
            && task.assetChunkCount! > 1,
    );
    const pendingChunkTasks = chunkAffinityMode ? [...tasks] : [];
    const chunkRunnerByIndex = new Map<number, AssetOpportunityBatchTaskRunner>();
    const freeChunkRunners = new Map<number, AssetOpportunityBatchTaskRunner>();
    const runnerTasks = new Map<AssetOpportunityBatchTaskRunner, AssetOpportunityBatchWorkerTask>();
    let cancelFlushed = false;
    let assignedTaskCount = 0;

    const aggregate = (): AssetOpportunityBatchSweepAggregate => {
        let sum = 0;
        for (const value of percentByIndex.values()) sum += value;
        return {
            percent: totalTasks > 0 ? sum / totalTasks : 100,
            inFlightHoldoutBars: [...inFlight.values()]
                .map((task) => task.holdoutBars)
                .sort((a, b) => a - b),
        };
    };

    let pumpRunning = false;
    let pumpAgain = false;
    const pump = async (): Promise<void> => {
        if (pumpRunning) {
            pumpAgain = true;
            return;
        }
        pumpRunning = true;
        try {
            do {
                pumpAgain = false;
                // 1. Ordered emission: contiguous completions from nextToEmit.
                while (!sweepError && buffered.has(nextToEmit)) {
                    const entry = buffered.get(nextToEmit)!;
                    buffered.delete(nextToEmit);
                    try {
                        await args.onIterationResult(entry.task, entry.iteration);
                    } catch (error) {
                        sweepError = error;
                        break;
                    }
                    completedIterations += 1;
                    nextToEmit += 1;
                }
                if (sweepError) break;

                // 2. Cancel flush: once Stop drained all in-flight work, emit
                //    the iterations that completed before the Stop, skipping
                //    the gaps left by aborted iterations (per-holdout archive
                //    files are independent; the sequential loop archives the
                //    same completed set).
                if (cancelledFlag && inFlight.size === 0 && !cancelFlushed && nextTaskIndex >= 0) {
                    cancelFlushed = true;
                    for (const index of [...buffered.keys()].sort((a, b) => a - b)) {
                        const entry = buffered.get(index)!;
                        buffered.delete(index);
                        try {
                            await args.onIterationResult(entry.task, entry.iteration);
                        } catch (error) {
                            sweepError = error;
                            break;
                        }
                        completedIterations += 1;
                        nextToEmit = index + 1;
                    }
                }
                if (sweepError) break;

                // 3. Assignment: only while healthy and tasks remain. Chunked
                // tasks stay on the same runner by assetChunkIndex so the
                // persistent worker cache survives the holdout sweep.
                while (fatal === null && !cancelledFlag && !args.isCancelled()) {
                    let runner: AssetOpportunityBatchTaskRunner | undefined;
                    let task: AssetOpportunityBatchWorkerTask | undefined;
                    if (chunkAffinityMode) {
                        for (const [chunkIndex, readyRunner] of freeChunkRunners) {
                            const pendingIndex = pendingChunkTasks.findIndex(
                                (candidate) => candidate.assetChunkIndex === chunkIndex,
                            );
                            if (pendingIndex >= 0) {
                                runner = readyRunner;
                                freeChunkRunners.delete(chunkIndex);
                                task = pendingChunkTasks.splice(pendingIndex, 1)[0];
                                break;
                            }
                            freeChunkRunners.delete(chunkIndex);
                        }
                        if (!task && freeRunners.length > 0) {
                            const pendingIndex = pendingChunkTasks.findIndex(
                                (candidate) => !chunkRunnerByIndex.has(candidate.assetChunkIndex!),
                            );
                            if (pendingIndex >= 0) {
                                runner = freeRunners.pop();
                                task = pendingChunkTasks.splice(pendingIndex, 1)[0];
                                chunkRunnerByIndex.set(task.assetChunkIndex!, runner!);
                            }
                        }
                    } else if (nextTaskIndex < totalTasks && freeRunners.length > 0) {
                        runner = freeRunners.pop();
                        task = tasks[nextTaskIndex];
                        nextTaskIndex += 1;
                    }
                    if (!runner || !task) break;
                    assignedTaskCount += 1;
                    inFlight.set(task.taskIndex, task);
                    percentByIndex.set(task.taskIndex, 0);
                    runnerTasks.set(runner, task);
                    runner.runTask(task);
                }

                // 4. Stop signaling. Fatal: abort only iterations AFTER the
                //    failed index (earlier ones complete and archive
                //    normally). Cancel: abort everything in flight.
                if (args.isCancelled() && !cancelledFlag) {
                    cancelledFlag = true;
                }
                if (cancelledFlag) {
                    for (const [runner, task] of runnerTasks) {
                        if (inFlight.has(task.taskIndex)) runner.stop();
                    }
                } else if (fatal !== null) {
                    for (const [runner, task] of runnerTasks) {
                        if (inFlight.has(task.taskIndex) && task.taskIndex > fatal.task.taskIndex) {
                            runner.stop();
                        }
                    }
                }
            } while (pumpAgain && !sweepError);
        } finally {
            pumpRunning = false;
        }
    };

    let settleResolve: () => void = () => undefined;
    const settle = new Promise<void>((resolveSettle) => {
        settleResolve = resolveSettle;
    });
    let settled = false;
    const checkDone = (): void => {
        if (settled) return;
        if (sweepError !== null) {
            settled = true;
            settleResolve();
            return;
        }
        if (cancelledFlag || fatal !== null) {
            if (inFlight.size === 0 && !pumpRunning) {
                settled = true;
                settleResolve();
            }
            return;
        }
        if (assignedTaskCount >= totalTasks && inFlight.size === 0 && buffered.size === 0) {
            settled = true;
            settleResolve();
        }
    };

    const handleTerminal = (): void => {
        void pump().then(checkDone, (error) => {
            sweepError = sweepError ?? error;
            checkDone();
        });
    };

    // Stop can arrive while every real worker is busy in synchronous strategy
    // evaluation. Progress messages are not a reliable wake-up signal, so
    // poll the shared cancellation token and drive the same pump that sends
    // termination to in-flight runners. The poll is cleared in the sweep
    // finally block below.
    const cancellationPoll = setInterval(() => {
        if (!cancelledFlag && args.isCancelled()) {
            cancelledFlag = true;
            handleTerminal();
        }
    }, 25);

    try {
        for (let index = 0; index < runnerCount; index += 1) {
            let self!: AssetOpportunityBatchTaskRunner;
            const eventsForRunner: AssetOpportunityBatchRunnerEvents = {
                onProgress: (task, progress) => {
                    percentByIndex.set(task.taskIndex, progress.percent);
                    args.onProgress(task, progress, aggregate());
                },
                onRunLog: args.onRunLog,
                onComplete: (task, iteration) => {
                    inFlight.delete(task.taskIndex);
                    percentByIndex.set(task.taskIndex, 100);
                    runnerTasks.delete(self);
                    if (chunkAffinityMode) {
                        freeChunkRunners.set(task.assetChunkIndex!, self);
                    } else {
                        freeRunners.push(self);
                    }
                    // Discard aborted results; archive only true completions.
                    // After a fatal, iterations AFTER the failed index are
                    // dropped (the sequential loop never runs them).
                    const drop = iteration.cancelled
                        || (fatal !== null && task.taskIndex > fatal.task.taskIndex);
                    if (!drop && !cancelledFlag) {
                        buffered.set(task.taskIndex, { task, iteration });
                    }
                    handleTerminal();
                },
                onFatal: (task, error) => {
                    inFlight.delete(task.taskIndex);
                    runnerTasks.delete(self);
                    if (chunkAffinityMode) {
                        freeChunkRunners.set(task.assetChunkIndex!, self);
                    } else {
                        freeRunners.push(self);
                    }
                    if (fatal === null && !cancelledFlag) {
                        fatal = { task, error };
                        debugLogger.warn("finder.asset_opportunity_batch.worker_iteration_failed", {
                            taskIndex: task.taskIndex,
                            holdoutBars: task.holdoutBars,
                            error,
                        });
                        // Iterations after the failed index must never emit.
                        for (const index of [...buffered.keys()]) {
                            if (index > fatal.task.taskIndex) buffered.delete(index);
                        }
                    }
                    handleTerminal();
                },
            };
            self = await args.createRunner(eventsForRunner);
            runners.push(self);
            freeRunners.push(self);
        }

        if (args.isCancelled()) {
            cancelledFlag = true;
        }
        handleTerminal();
        await settle;

        if (sweepError !== null) {
            // onIterationResult threw (archive failure semantics live at the
            // caller); rethrow after cleanup.
            throw sweepError;
        }
        return {
            cancelled: cancelledFlag,
            completedIterations,
            fatal,
        };
    } finally {
        clearInterval(cancellationPoll);
        for (const runner of runners) {
            try {
                runner.stop();
            } catch {
                // Best-effort; dispose below terminates regardless.
            }
        }
        await Promise.all(runners.map((runner) => runner.dispose()));
    }
}
