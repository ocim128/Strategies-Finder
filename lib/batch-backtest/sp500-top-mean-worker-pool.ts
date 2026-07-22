import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { TopMeanRunManifest } from "./compact-pair-artifact";
import { saveManifest, writeShardArtifacts } from "./sp500-top-mean-artifact-store";
import type { TopMeanWorkerMessage, TopMeanWorkerTaskData } from "./sp500-top-mean-worker";

function moduleThisFileDir(): string {
    try {
        return dirname(fileURLToPath(import.meta.url));
    } catch {
        return __dirname;
    }
}

let cachedWorkerBundlePath: Promise<string> | null = null;

export async function resolveTopMeanWorkerPath(): Promise<string> {
    if (cachedWorkerBundlePath) return cachedWorkerBundlePath;

    cachedWorkerBundlePath = (async () => {
        const sourcePath = join(moduleThisFileDir(), "sp500-top-mean-worker.ts");
        const sibling = sourcePath.replace(/\.ts$/, ".js");
        try {
            const fs = await import("node:fs/promises");
            if (sourcePath.endsWith(".js") || (await fs.access(sibling).then(() => true).catch(() => false))) {
                return sourcePath.endsWith(".js") ? sourcePath : sibling;
            }
        } catch {
            /* fall through */
        }
        try {
            return await bundleWorkerWithEsbuild(sourcePath);
        } catch {
            return sourcePath;
        }
    })();

    return cachedWorkerBundlePath;
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

    const dir = join(root, "v1");
    const outfile = join(dir, "worker.cjs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outfile, contents);
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

    public async execute(options: WorkerPoolRunOptions): Promise<void> {
        const workerCount = resolveTopMeanWorkerCount(options.workerCount);
        const shardSize = options.shardSize || 50;
        const totalPairs = options.canonicalPairs.length;
        options.manifest.shardSize = shardSize;

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
        saveManifest(options.manifest, options.baseDir);

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
                };

                const worker = new Worker(workerScriptPath, {
                    workerData: taskData,
                });

                this.activeWorkers.add(worker);

                worker.on("message", (msg: TopMeanWorkerMessage) => {
                    if (msg.type === "progress") {
                        if (msg.status === "completed") {
                            completedPairsCount++;
                            options.manifest.completedPairsCount = completedPairsCount;
                            options.onProgress?.(
                                completedPairsCount,
                                totalPairs,
                                `Backtesting pair ${completedPairsCount}/${totalPairs}: ${msg.symbol}`,
                            );
                        } else if (msg.status === "failed") {
                            options.manifest.failedPairsCount = (options.manifest.failedPairsCount || 0) + 1;
                        }
                    } else if (msg.type === "shard_complete") {
                        writeShardArtifacts(options.runId, msg.shardIndex, msg.artifacts, options.baseDir);
                        if (!options.manifest.completedShards.includes(msg.shardIndex)) {
                            options.manifest.completedShards.push(msg.shardIndex);
                        }
                        saveManifest(options.manifest, options.baseDir);
                        this.activeWorkers.delete(worker);
                        worker.terminate();
                        resolvePromise();
                    } else if (msg.type === "error") {
                        if (!options.manifest.failedShards.includes(msg.shardIndex)) {
                            options.manifest.failedShards.push(msg.shardIndex);
                        }
                        saveManifest(options.manifest, options.baseDir);
                        this.activeWorkers.delete(worker);
                        worker.terminate();
                        rejectPromise(new Error(msg.error));
                    }
                });

                worker.on("error", (err) => {
                    this.activeWorkers.delete(worker);
                    rejectPromise(err);
                });

                worker.on("exit", (code) => {
                    this.activeWorkers.delete(worker);
                    if (code !== 0 && !options.manifest.completedShards.includes(task.shardIndex)) {
                        rejectPromise(new Error(`Worker stopped with exit code ${code}`));
                    }
                });
            });
        };

        // Queue processing with max concurrency = workerCount
        let queueIndex = 0;
        const activePromises: Set<Promise<void>> = new Set();

        while (queueIndex < pendingShards.length || activePromises.size > 0) {
            if (this.isCancelled) {
                throw new Error("Operation cancelled");
            }

            while (activePromises.size < workerCount && queueIndex < pendingShards.length) {
                const task = pendingShards[queueIndex++];
                const promise = runShardOnWorker(task)
                    .catch((err) => {
                        // Retry shard once on failure
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
    }
}
