/**
 * Worker count policy + real worker runner for the parallel Finder Symbol
 * Universe strategy sweep.
 *
 * The sweep itself (ordered release, fatal isolation, cancel flush, 25ms
 * cancellation poll) is the GENERICIZED `runAssetOpportunityBatchSweep`
 * coordinator — the exact pump the Asset Opportunity batch sweep uses, so
 * both sweeps share one tested implementation. Tasks are whole selected
 * strategies (taskIndex = strategyIndex), and each runner executes the
 * unchanged `runFinderUniverseExecution` core inside a persistent
 * worker_threads isolate (see `finder-universe-strategy-worker.ts`).
 *
 * Worker count policy: `FINDER_UNIVERSE_WORKERS` env override (1 = the caller
 * keeps the sequential in-process loop; that is also the rollback lever).
 * Auto: min(strategy count, logical cores - 2, memory ceiling). The memory
 * ceiling budgets 75% of ACTUAL system RAM for one full dataset copy per
 * worker (~9 MB/symbol, the same conservative per-symbol constant the Asset
 * Opportunity pool uses at the 100k-bar cap), because workers are separate
 * isolates and `--max-old-space-size` cannot bound the SUM of their
 * footprints. When the Rust engine is preferred the auto value is clamped to
 * the chunked Asset Opportunity Rust cap: the external Rust HTTP server
 * serializes execution, so extra workers only multiply queued requests while
 * the TS signal-generation overlap tops out quickly. The env override
 * deliberately bypasses the memory ceiling AND the Rust cap (operator
 * judgment, capped at 32).
 *
 * Import hygiene (the documented vite.config bundle trap): this module is
 * imported by `finder-vite-plugin.ts`. It imports only leaf modules,
 * node:worker_threads, and TYPES from `finder-universe-strategy-worker.ts`
 * (the runtime worker is bundled from source by esbuild). It must NOT
 * transitively reach `lightweight-charts`.
 */

import { availableParallelism, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
    ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL,
    resolveAssetOpportunityMemoryBudgetBytes,
} from "./finder-asset-opportunity-capacity";
import {
    ASSET_OPPORTUNITY_BATCH_RUST_CHUNK_WORKER_CAP,
    runAssetOpportunityBatchSweep,
    type AssetOpportunityBatchRunnerEvents,
    type AssetOpportunityBatchRunnerFactory,
    type AssetOpportunityBatchTaskRunner,
} from "./finder-asset-opportunity-batch-worker-pool";
import type {
    FinderUniverseStrategyWorkerEvent,
    FinderUniverseStrategyWorkerResult,
    FinderUniverseStrategyWorkerTask,
} from "./finder-universe-strategy-worker";

// ---------------------------------------------------------------------------
// Worker count policy
// ---------------------------------------------------------------------------

export const FINDER_UNIVERSE_WORKERS_ENV = "FINDER_UNIVERSE_WORKERS";

/** Hard cap so a mistyped env value cannot fork an absurd pool. */
export const UNIVERSE_STRATEGY_WORKER_COUNT_MAX = 32;

/**
 * Resolve the worker count for one universe strategy sweep.
 *
 * - `FINDER_UNIVERSE_WORKERS` env: integer >= 1 wins outright (1 = caller
 *   should keep the sequential in-process loop; this is also the rollback
 *   lever). The override intentionally bypasses the memory ceiling and the
 *   Rust cap — it is the operator's explicit judgment call — but is still
 *   capped at {@link UNIVERSE_STRATEGY_WORKER_COUNT_MAX}.
 * - Auto: min(strategy count, logical cores - 2, memory ceiling). The memory
 *   ceiling budgets 75% of ACTUAL system RAM (`os.totalmem()`, injectable for
 *   tests) for one full dataset copy per worker (~9 MB/symbol), so a 16 GB
 *   host auto-selects ~3x fewer workers than a 64 GB host. Always >= 1.
 * - `options.rustEngine`: clamps the AUTO value (never the env override) to
 *   {@link ASSET_OPPORTUNITY_BATCH_RUST_CHUNK_WORKER_CAP} — the Rust HTTP
 *   server serializes, so extra workers mostly add TS signal-generation
 *   overlap, which tops out quickly.
 */
export function resolveUniverseStrategyWorkerCount(
    strategyCount: number,
    symbolCount: number,
    env: NodeJS.ProcessEnv = process.env,
    systemMemoryBytes: number = totalmem(),
    options?: { rustEngine?: boolean },
): number {
    const raw = env[FINDER_UNIVERSE_WORKERS_ENV];
    if (raw !== undefined && raw !== "") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 1) {
            return Math.max(1, Math.min(UNIVERSE_STRATEGY_WORKER_COUNT_MAX, Math.floor(parsed)));
        }
    }
    let cores = 8;
    try {
        cores = availableParallelism() || cores;
    } catch {
        // Older Node without availableParallelism; keep the conservative default.
    }
    const memoryBudgetBytes = resolveAssetOpportunityMemoryBudgetBytes(systemMemoryBytes);
    const symbolsPerWorker = Math.max(1, Math.floor(symbolCount));
    const memoryCeiling = Math.max(
        1,
        Math.floor(memoryBudgetBytes / (symbolsPerWorker * ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL)),
    );
    const auto = Math.max(
        1,
        Math.min(
            Math.max(1, Math.floor(strategyCount)),
            Math.max(1, cores - 2),
            memoryCeiling,
        ),
    );
    if (options?.rustEngine === true) {
        return Math.min(auto, ASSET_OPPORTUNITY_BATCH_RUST_CHUNK_WORKER_CAP);
    }
    return auto;
}

// ---------------------------------------------------------------------------
// Task runner abstraction (production: real Worker; tests: in-process fakes)
// ---------------------------------------------------------------------------

/** Forwarded worker progress payload for universe strategy sweeps. */
export interface FinderUniverseStrategyProgress {
    percent: number;
    status: string;
    phase: "loading" | "evaluating";
}

export type FinderUniverseStrategyRunnerEvents = AssetOpportunityBatchRunnerEvents<FinderUniverseStrategyWorkerResult, FinderUniverseStrategyWorkerTask, FinderUniverseStrategyProgress>;
export type FinderUniverseStrategyTaskRunner = AssetOpportunityBatchTaskRunner<FinderUniverseStrategyWorkerTask>;
export type FinderUniverseStrategyRunnerFactory = AssetOpportunityBatchRunnerFactory<FinderUniverseStrategyWorkerResult, FinderUniverseStrategyWorkerTask, FinderUniverseStrategyProgress>;

// ---------------------------------------------------------------------------
// Worker script resolution (pattern-mirrors the Asset Opportunity pool)
// ---------------------------------------------------------------------------

function moduleThisFileDir(): string {
    try {
        return dirname(fileURLToPath(import.meta.url));
    } catch {
        return __dirname;
    }
}

export async function resolveUniverseStrategyWorkerPath(): Promise<string> {
    const fs = await import("node:fs/promises");
    const repositorySource = resolve(
        process.cwd(),
        "lib",
        "finder",
        "server",
        "finder-universe-strategy-worker.ts",
    );
    const moduleSource = join(moduleThisFileDir(), "finder-universe-strategy-worker.ts");
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
    const root = join(tmp, "finder-universe-strategy-workers");

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
        throw new Error("esbuild produced an empty universe strategy worker bundle");
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

/**
 * Production runner: one persistent worker_threads Worker per runner, one
 * strategy task at a time (the worker's dataset cache and strategy selection
 * persist across tasks).
 */
export async function createRealWorkerUniverseStrategyRunner(
    events: FinderUniverseStrategyRunnerEvents,
): Promise<FinderUniverseStrategyTaskRunner> {
    const workerPath = await resolveUniverseStrategyWorkerPath();
    const worker = new Worker(workerPath, {});
    let currentTask: FinderUniverseStrategyWorkerTask | null = null;
    let disposed = false;
    let stopping = false;
    let termination: Promise<number> | null = null;
    const terminateWorker = (): Promise<number> => {
        termination ??= worker.terminate();
        return termination;
    };
    const takeCurrentTask = (): FinderUniverseStrategyWorkerTask | null => {
        const task = currentTask;
        currentTask = null;
        return task;
    };

    worker.on("message", (message: FinderUniverseStrategyWorkerEvent) => {
        if (message.type === "progress") {
            if (currentTask && currentTask.taskIndex === message.taskIndex) {
                events.onProgress(currentTask, {
                    percent: message.percent,
                    status: message.status,
                    phase: message.phase,
                });
            }
            return;
        }
        if (message.type === "strategy_complete") {
            const task = takeCurrentTask();
            if (task && task.taskIndex === message.taskIndex) {
                events.onComplete(task, message.result);
            }
            return;
        }
        if (message.type === "strategy_fatal") {
            const task = takeCurrentTask();
            if (task && task.taskIndex === message.taskIndex) {
                events.onFatal(task, message.error);
            }
        }
    });
    worker.on("error", (error: Error) => {
        const task = takeCurrentTask();
        if (task) {
            events.onFatal(task, `universe strategy worker crashed: ${error.message}`);
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
                    ? `universe strategy worker exited with code ${code}`
                    : "universe strategy worker exited unexpectedly mid-task",
            );
        }
    });

    return {
        runTask: (task) => {
            if (disposed || stopping) {
                events.onFatal(task, "universe strategy worker was stopped before task start");
                return;
            }
            currentTask = task;
            worker.postMessage({ type: "run_task", task });
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
// Sweep wrapper (typed for universe strategy tasks)
// ---------------------------------------------------------------------------

export interface FinderUniverseStrategySweepAggregate {
    /** Mean per-strategy progress over ALL tasks (0-100), completed = 100. */
    percent: number;
}

/**
 * Drive the parallel universe strategy sweep. Semantics are the shared
 * coordinator's (see `runAssetOpportunityBatchSweep`): completed strategies
 * are released in ASCENDING strategyIndex order, a fatal strategy stops the
 * sweep after earlier strategies merge, and Stop discards in-flight
 * strategies while flushing the ones that already completed — matching the
 * sequential loop, where completed strategies keep their survivors.
 */
export async function runFinderUniverseStrategySweep(args: {
    tasks: FinderUniverseStrategyWorkerTask[];
    runnerCount: number;
    createRunner: FinderUniverseStrategyRunnerFactory;
    onStrategyResult: (task: FinderUniverseStrategyWorkerTask, result: FinderUniverseStrategyWorkerResult) => Promise<void>;
    onProgress: (
        task: FinderUniverseStrategyWorkerTask,
        progress: { percent: number; status: string; phase: string },
        aggregate: FinderUniverseStrategySweepAggregate,
    ) => void;
    isCancelled: () => boolean;
}): Promise<{ cancelled: boolean; completedStrategies: number; fatal: { task: FinderUniverseStrategyWorkerTask; error: string } | null }> {
    const sweep = await runAssetOpportunityBatchSweep<FinderUniverseStrategyWorkerResult, FinderUniverseStrategyWorkerTask, FinderUniverseStrategyProgress>({
        tasks: args.tasks,
        runnerCount: args.runnerCount,
        createRunner: args.createRunner,
        onIterationResult: args.onStrategyResult,
        onProgress: (task, progress, aggregate) => {
            args.onProgress(task, progress, { percent: aggregate.percent });
        },
        // Universe strategies have no per-strategy JSONL run log; the runner's
        // debug events stay worker-local.
        onRunLog: () => undefined,
        isCancelled: args.isCancelled,
    });
    return {
        cancelled: sweep.cancelled,
        completedStrategies: sweep.completedIterations,
        fatal: sweep.fatal,
    };
}
