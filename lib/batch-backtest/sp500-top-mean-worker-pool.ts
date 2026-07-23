import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { TopMeanRunManifest } from "./compact-pair-artifact";
import { saveManifest, writeShardArtifacts } from "./sp500-top-mean-artifact-store";
import type { TopMeanWorkerMessage, TopMeanWorkerTaskData } from "./sp500-top-mean-worker";

export const TOP_MEAN_DEFAULT_SHARD_SIZE = 250;

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

export type TopMeanEngineUsage = { rust: number; typescript: number };

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
    onProgress?: (completedPairs: number, totalPairs: number, text: string) => void;
}

export interface ShardTask {
    shardIndex: number;
    pairs: Array<{ pairIndex: number; symbol: string }>;
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

    public async execute(options: WorkerPoolRunOptions): Promise<TopMeanEngineUsage> {
        const workerCount = resolveTopMeanWorkerCount(options.workerCount);
        const shardSize = options.shardSize || TOP_MEAN_DEFAULT_SHARD_SIZE;
        const totalPairs = options.canonicalPairs.length;
        options.manifest.shardSize = shardSize;
        const engineUsage: TopMeanEngineUsage = { rust: 0, typescript: 0 };

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

        // Filter out already completed shards (for resume support)
        const completedSet = new Set(options.manifest.completedShards);
        const pendingShards = shardTasks.filter((task) => !completedSet.has(task.shardIndex));

        let completedPairsCount = options.manifest.completedPairsCount || 0;
        const workerScriptPath = await resolveTopMeanWorkerPath();

        // Helper to run a single shard task on a dedicated Worker
        const runShardOnWorker = (task: ShardTask): Promise<void> => {
            return new Promise<void>((resolvePromise, rejectPromise) => {
                if (this.isCancelled) {
                    return rejectPromise(new Error("Operation cancelled"));
                }

                const taskData: TopMeanWorkerTaskData = {
                    shardIndex: task.shardIndex,
                    pairs: task.pairs,
                    strategyKey: options.strategyKey,
                    strategyParams: options.strategyParams,
                    backtestSettings: options.backtestSettings,
                    capitalSettings: options.capitalSettings,
                    interval: options.interval,
                    useRustEnginePreference: options.useRustEnginePreference,
                    ...(options.backtestFromSec !== undefined ? { backtestFromSec: options.backtestFromSec } : {}),
                };

                const worker = new Worker(workerScriptPath, {
                    workerData: taskData,
                });
                let settled = false;

                const resolveOnce = (): void => {
                    if (settled) return;
                    settled = true;
                    resolvePromise();
                };
                const rejectOnce = (error: Error): void => {
                    if (settled) return;
                    settled = true;
                    rejectPromise(error);
                };

                this.activeWorkers.add(worker);

                worker.on("message", (msg: TopMeanWorkerMessage) => {
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
                    } else if (msg.type === "shard_complete") {
                        writeShardArtifacts(options.runId, msg.shardIndex, msg.artifacts, options.baseDir, options.windowKey);
                        if (!options.manifest.completedShards.includes(msg.shardIndex)) {
                            options.manifest.completedShards.push(msg.shardIndex);
                        }
                        saveManifest(options.manifest, options.baseDir, options.windowKey);
                        this.activeWorkers.delete(worker);
                        worker.terminate();
                        resolveOnce();
                    } else if (msg.type === "error") {
                        if (!options.manifest.failedShards.includes(msg.shardIndex)) {
                            options.manifest.failedShards.push(msg.shardIndex);
                        }
                        saveManifest(options.manifest, options.baseDir, options.windowKey);
                        this.activeWorkers.delete(worker);
                        worker.terminate();
                        rejectOnce(new Error(msg.error));
                    }
                });

                worker.on("error", (err) => {
                    this.activeWorkers.delete(worker);
                    void worker.terminate();
                    rejectOnce(err instanceof Error ? err : new Error(String(err)));
                });

                worker.on("exit", (code) => {
                    this.activeWorkers.delete(worker);
                    if (code !== 0 && !options.manifest.completedShards.includes(task.shardIndex)) {
                        rejectOnce(new Error(`Worker stopped with exit code ${code}`));
                    }
                });
            });
        };

        // Queue processing with max concurrency = workerCount
        let queueIndex = 0;
        const activePromises: Set<Promise<void>> = new Set();

        try {
            while (queueIndex < pendingShards.length || activePromises.size > 0) {
                if (this.isCancelled) {
                    throw new Error("Operation cancelled");
                }

                while (activePromises.size < workerCount && queueIndex < pendingShards.length) {
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
            this.cancel();
            await Promise.allSettled(activePromises);
            throw error;
        }
        return engineUsage;
    }
}
