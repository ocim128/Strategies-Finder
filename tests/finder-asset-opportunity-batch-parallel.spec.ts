/**
 * Parallel Asset Opportunity batch holdout sweep.
 *
 * Locks the load-bearing contracts of the worker-pool coordinator
 * (`finder-asset-opportunity-batch-worker-pool.ts`) and the worker task core
 * (`finder-asset-opportunity-batch-worker.ts`):
 *
 *  - PARITY: the parallel path (in-process fake runners executing the REAL
 *    worker task core with stub datasets) produces the identical ordered
 *    `asset_batch_iteration_done` sequence, asset rows, totals, and archive
 *    append order as the sequential in-process loop for the same seeded run.
 *  - ORDERING: out-of-order worker completions still emit + archive strictly
 *    ascending by holdout.
 *  - FATAL ISOLATION: a failed iteration surfaces `asset_batch_fatal`;
 *    iterations before it complete and archive; iterations after it never
 *    emit.
 *  - CANCEL: Stop discards in-flight iterations but flushes the ones that
 *    already completed, ascending.
 *  - WORKER COUNT POLICY: env override + holdout/cores/memory clamps.
 *
 * The runners are in-process fakes (not real worker_threads) so the spec is
 * hermetic: no dev server, no real dataset loads. The real Worker bootstrap
 * is exercised by the manual smoke documented in
 * docs/finder-asset-opportunity-batch-parallelization.md.
 */

import { expect } from "chai";
import { describe, it, before, after, afterEach } from "node:test";
import { strategyRegistry } from "../strategyRegistry";
import {
    processFinderAssetOpportunityBatchRun,
    __testInternals,
} from "../lib/finder/server/finder-vite-plugin";
import {
    resolveAssetOpportunityBatchWorkerCount,
    resolveAssetOpportunityDatasetCacheCapacity,
    runAssetOpportunityBatchSweep,
    FINDER_ASSET_BATCH_WORKERS_ENV,
    type AssetOpportunityBatchRunnerEvents,
    type AssetOpportunityBatchRunnerFactory,
    type AssetOpportunityBatchTaskRunner,
} from "../lib/finder/server/finder-asset-opportunity-batch-worker-pool";
import {
    runAssetOpportunityBatchWorkerTask,
    type AssetOpportunityBatchWorkerTask,
} from "../lib/finder/server/finder-asset-opportunity-batch-worker";
import type { FinderAssetOpportunityBatchStreamEvent } from "../lib/finder/server/finder-stream-types";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const { setRunOwnerForTests, resetRunStateForTests, getRunStateForTests } = __testInternals;

const GIB = 1024 * 1024 * 1024;

const STRATEGY_KEY = "asset_batch_parallel_test";

const batchStrategy: Strategy = {
    name: "Asset Batch Parallel Test",
    description: "Enters on the latest available bar for parallel batch tests.",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data) {
        const latest = data[data.length - 1];
        return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
    },
};

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

function makeCandles(closes: number[]): OHLCVData[] {
    return closes.map((close, index) => ({
        time: (1_700_000_000 + (index * 300)) as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
    }));
}

// Batch holdouts reserve trailing bars; 40 candles comfortably cover the
// tested ranges (2..4).
const longUpDownDatasets = (): Map<string, OHLCVData[]> => new Map<string, OHLCVData[]>([
    ["UP", makeCandles(Array.from({ length: 40 }, (_, i) => 100 + i))],
    ["DOWN", makeCandles(Array.from({ length: 40 }, (_, i) => 100 - i))],
]);

function makeBatchOptions(symbols: string[]): FinderOptions {
    return {
        mode: "random",
        randomSeed: 4242,
        scope: "asset_opportunity",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        symbols,
        topN: 2,
        steps: 3,
        rangePercent: 35,
        maxRuns: 2,
        dataSlice: "all",
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        assetOpportunity: {
            symbols,
            candidatePoolSize: 2,
            minFreshSupport: 1,
            oosHorizons: [1, 3, 5],
        },
    } as unknown as FinderOptions;
}

interface FakeRunnerOptions {
    datasets: Map<string, OHLCVData[]>;
    /** Per-task completion delay; late completions force out-of-order arrival. */
    delayMs?: (taskIndex: number) => number;
    /** Task indexes that surface as iteration fatals. */
    fatalTasks?: Set<number>;
    /**
     * Task indexes that park in-flight until stop() (like a real worker
     * mid-iteration when Stop arrives), then resolve as cancelled.
     */
    parkUntilStopTasks?: Set<number>;
}

/**
 * In-process stand-in for a real worker runner. Executes the REAL worker task
 * core (`runAssetOpportunityBatchWorkerTask`) with a stub dataset loader, so
 * parity with the sequential path is exercised end-to-end without threads.
 */
function createInProcessRunnerFactory(options: FakeRunnerOptions): AssetOpportunityBatchRunnerFactory {
    return (events: AssetOpportunityBatchRunnerEvents): AssetOpportunityBatchTaskRunner => {
        let abort: AbortController | null = null;
        const parked = new Set<() => void>();
        const runCore = (task: AssetOpportunityBatchWorkerTask, signal: AbortSignal): void => {
            runAssetOpportunityBatchWorkerTask({
                task,
                loadDataset: async (symbol) => options.datasets.get(symbol) ?? [],
                abortSignal: signal,
                isCancelled: () => signal.aborted,
                onProgress: (progress) => {
                    events.onProgress(task, progress);
                },
                runLog: (event, payload) => {
                    events.onRunLog(event, payload);
                },
            }).then(
                (iteration) => events.onComplete(task, iteration),
                (error) => events.onFatal(task, error instanceof Error ? error.message : String(error)),
            );
        };
        return {
            runTask: (task) => {
                abort = new AbortController();
                if (options.parkUntilStopTasks?.has(task.taskIndex)) {
                    parked.add(() => {
                        // A Stop mid-iteration resolves as a cancelled partial
                        // result — reproduced by running the core against an
                        // already-aborted signal.
                        runCore(task, AbortSignal.abort());
                    });
                    return;
                }
                const delay = options.delayMs?.(task.taskIndex) ?? 0;
                const start = (): void => {
                    if (options.fatalTasks?.has(task.taskIndex)) {
                        events.onFatal(task, `simulated fatal for holdout ${task.holdoutBars}`);
                        return;
                    }
                    runCore(task, abort!.signal);
                };
                if (delay <= 0) {
                    start();
                    return;
                }
                setTimeout(() => {
                    if (abort?.signal.aborted) {
                        runCore(task, AbortSignal.abort());
                        return;
                    }
                    start();
                }, delay);
            },
            stop: () => {
                abort?.abort();
                const resume = [...parked];
                parked.clear();
                for (const fn of resume) fn();
            },
            dispose: async () => {
                abort?.abort();
            },
        };
    };
}

interface BatchRunArgs {
    owner: number;
    start: number;
    end: number;
    runId: string;
    factory?: AssetOpportunityBatchRunnerFactory;
    isCancelled?: () => boolean;
    symbols?: string[];
    datasets?: Map<string, OHLCVData[]>;
    /** Overrides the default dataset-map loader (call counting, fault injection). */
    loadDataset?: (symbol: string) => Promise<OHLCVData[]>;
}

async function runAssetBatch(
    args: BatchRunArgs,
): Promise<{ events: FinderAssetOpportunityBatchStreamEvent[]; appended: string[]; contents: string[] }> {
    const datasets = args.datasets ?? longUpDownDatasets();
    const symbols = args.symbols ?? [...datasets.keys()];
    const events: FinderAssetOpportunityBatchStreamEvent[] = [];
    const appended: string[] = [];
    const contents: string[] = [];
    setRunOwnerForTests(args.owner);
    await processFinderAssetOpportunityBatchRun(
        {
            runId: args.runId,
            interval: "5m",
            symbols,
            options: makeBatchOptions(symbols),
            settings,
            capitalSettings,
            selectedStrategies: [{ key: STRATEGY_KEY, name: batchStrategy.name, strategy: batchStrategy }],
            useRustEnginePreference: false,
            loadDataset: args.loadDataset ?? (async (symbol) => datasets.get(symbol) ?? []),
            abortSignal: new AbortController().signal,
            candidatePoolSize: 2,
            minFreshSupport: 1,
            archiveSort: null,
            runLog: null,
            batch: { startHoldoutBars: args.start, endHoldoutBars: args.end },
            ...(args.factory ? { batchTaskRunnerFactory: args.factory } : {}),
        },
        (event) => events.push(event),
        args.owner,
        "/virtual/archive-root",
        async (_dir, filename, content) => {
            appended.push(filename);
            contents.push(content);
        },
    );
    return { events, appended, contents };
}

type IterationDoneEvent = Extract<FinderAssetOpportunityBatchStreamEvent, { type: "asset_batch_iteration_done" }>;

function extractIterations(events: FinderAssetOpportunityBatchStreamEvent[]): IterationDoneEvent[] {
    return events.filter(
        (event): event is IterationDoneEvent => event.type === "asset_batch_iteration_done",
    );
}

describe("finder Asset Opportunity batch parallel execution", () => {
    before(() => {
        strategyRegistry.register(STRATEGY_KEY, batchStrategy);
    });
    after(() => {
        strategyRegistry.unregister(STRATEGY_KEY);
    });
    afterEach(() => {
        resetRunStateForTests();
    });

    it("resolves the worker count from env override, holdout count, cores, and the system-memory ceiling", () => {
        // Env override wins outright, bypasses the memory ceiling (operator
        // judgment call), and clamps at the hard cap.
        expect(resolveAssetOpportunityBatchWorkerCount(3, 10, { [FINDER_ASSET_BATCH_WORKERS_ENV]: "2" }, 16 * GIB)).to.equal(2);
        expect(resolveAssetOpportunityBatchWorkerCount(3, 10, { [FINDER_ASSET_BATCH_WORKERS_ENV]: "99" }, 16 * GIB)).to.equal(32);
        // Invalid overrides (0, negative, non-numeric) fall back to auto.
        const auto = resolveAssetOpportunityBatchWorkerCount(3, 10, {}, 64 * GIB);
        expect(auto).to.be.at.most(3);
        expect(auto).to.be.at.least(1);
        expect(resolveAssetOpportunityBatchWorkerCount(3, 10, { [FINDER_ASSET_BATCH_WORKERS_ENV]: "0" }, 64 * GIB)).to.equal(auto);
        // The memory ceiling budgets 75% of ACTUAL system RAM for one dataset
        // copy per worker (~9MB/symbol): 1000 symbols on a 64 GB host -> 5
        // workers, but only 1 on a 16 GB host (the documented heap-guidance
        // host must not auto-OOM).
        expect(resolveAssetOpportunityBatchWorkerCount(41, 1000, {}, 64 * GIB)).to.equal(5);
        expect(resolveAssetOpportunityBatchWorkerCount(41, 1000, {}, 16 * GIB)).to.equal(1);
        // Few symbols: the memory ceiling stops binding; cores/holdouts clamp.
        expect(resolveAssetOpportunityBatchWorkerCount(2, 10, {}, 16 * GIB)).to.be.at.most(2);
    });

    it("clamps the auto worker count for Rust-engine runs; the env override still wins", () => {
        const auto = resolveAssetOpportunityBatchWorkerCount(41, 10, {}, 64 * GIB);
        // rustEngine caps the AUTO value at 8 (the Rust HTTP server serializes;
        // extra workers only contend for its queue)...
        expect(resolveAssetOpportunityBatchWorkerCount(41, 10, {}, 64 * GIB, { rustEngine: true }))
            .to.equal(Math.min(auto, 8));
        // ...and never raises it when auto is already below the cap.
        expect(resolveAssetOpportunityBatchWorkerCount(3, 10, {}, 64 * GIB, { rustEngine: true }))
            .to.equal(Math.min(resolveAssetOpportunityBatchWorkerCount(3, 10, {}, 64 * GIB), 8));
        // rustEngine: false / undefined keep the unchanged auto value.
        expect(resolveAssetOpportunityBatchWorkerCount(41, 10, {}, 64 * GIB, { rustEngine: false })).to.equal(auto);
        // The env override is the operator's explicit judgment call: it
        // bypasses the Rust cap exactly like it bypasses the memory ceiling.
        expect(resolveAssetOpportunityBatchWorkerCount(
            41,
            10,
            { [FINDER_ASSET_BATCH_WORKERS_ENV]: "16" },
            64 * GIB,
            { rustEngine: true },
        )).to.equal(16);
    });

    it("produces identical ordered results, archives, and totals as the sequential loop", async () => {
        const sequential = await runAssetBatch({ owner: 8101, start: 2, end: 4, runId: "parallel-parity" });
        const parallel = await runAssetBatch({
            owner: 8102,
            start: 2,
            end: 4,
            runId: "parallel-parity",
            factory: createInProcessRunnerFactory({ datasets: longUpDownDatasets() }),
        });

        const seqIterations = extractIterations(sequential.events);
        const parIterations = extractIterations(parallel.events);
        expect(seqIterations.length).to.equal(3);
        expect(parIterations.map((event) => event.holdoutBars)).to.deep.equal([2, 3, 4]);
        expect(parIterations.map((event) => event.iterationIndex)).to.deep.equal([0, 1, 2]);

        // Identical scalar rows + totals per iteration (the parallel path
        // executes the same worker task core with the same seeded options).
        for (let index = 0; index < seqIterations.length; index += 1) {
            expect(parIterations[index]!.assets).to.deep.equal(seqIterations[index]!.assets);
            expect(parIterations[index]!.totals).to.deep.equal(seqIterations[index]!.totals);
        }

        // Identical ascending archive append order.
        expect(parallel.appended).to.deep.equal(sequential.appended);

        // Terminal event parity: completed count, final rows, last holdout.
        const seqDone = sequential.events[sequential.events.length - 1]!;
        const parDone = parallel.events[parallel.events.length - 1]!;
        expect(seqDone.type).to.equal("asset_batch_done");
        expect(parDone.type).to.equal("asset_batch_done");
        if (parDone.type === "asset_batch_done" && seqDone.type === "asset_batch_done") {
            expect(parDone.completedIterations).to.equal(seqDone.completedIterations);
            expect(parDone.failedIterations).to.equal(seqDone.failedIterations);
            expect(parDone.holdoutBars).to.equal(seqDone.holdoutBars);
            expect(parDone.assets).to.deep.equal(seqDone.assets);
            expect(parDone.ok).to.equal(true);
        }

        // Regression (audit finding): the parallel path must keep the
        // snapshot's live counters non-zero for /status — worker progress
        // carries loadedSymbols/failedSymbols/strategyIndex and the parallel
        // onProgress mirrors them onto the snapshot (latest-writer-wins).
        const state = getRunStateForTests();
        expect(state).to.not.equal(null);
        expect(state!.loadedSymbols).to.be.greaterThan(0);
        expect(state!.strategyIndex).to.equal(0);
    });

    it("emits and archives strictly ascending even when workers complete out of order", async () => {
        // Reverse-completion delays: the LAST holdout finishes first.
        const { events, appended } = await runAssetBatch({
            owner: 8103,
            start: 2,
            end: 5,
            runId: "parallel-order",
            factory: createInProcessRunnerFactory({
                datasets: longUpDownDatasets(),
                delayMs: (taskIndex) => (4 - taskIndex) * 15,
            }),
        });

        const iterations = extractIterations(events);
        expect(iterations.map((event) => event.holdoutBars)).to.deep.equal([2, 3, 4, 5]);
        expect(iterations.map((event) => event.iterationIndex)).to.deep.equal([0, 1, 2, 3]);
        // Archive appends follow the same ascending order (block per sort per N).
        const holdoutsInOrder: number[] = [];
        for (const filename of appended) {
            const match = /^oos-holdout-(\d+)-bars\.txt$/.exec(filename);
            if (match) holdoutsInOrder.push(Number(match[1]));
        }
        expect(holdoutsInOrder).to.deep.equal([2, 3, 4, 5].flatMap((holdout) =>
            Array.from({ length: holdoutsInOrder.length / 4 }, () => holdout),
        ));
    });

    it("isolates a fatal iteration: earlier holdouts archive, later ones never emit", async () => {
        // Holdout 3 (task index 1) fatals while holdouts 2 and 4 run.
        const { events, appended } = await runAssetBatch({
            owner: 8104,
            start: 2,
            end: 4,
            runId: "parallel-fatal",
            factory: createInProcessRunnerFactory({
                datasets: longUpDownDatasets(),
                delayMs: (taskIndex) => (taskIndex === 1 ? 40 : (2 - taskIndex) * 15),
                fatalTasks: new Set([1]),
            }),
        });

        const fatal = events.find(
            (event): event is Extract<FinderAssetOpportunityBatchStreamEvent, { type: "asset_batch_fatal" }> =>
                event.type === "asset_batch_fatal",
        );
        expect(fatal).to.not.equal(undefined);
        expect(fatal!.holdoutBars).to.equal(3);

        const iterations = extractIterations(events);
        // Holdout 2 completed and archived; holdout 4 (after the fatal) never emits.
        expect(iterations.map((event) => event.holdoutBars)).to.deep.equal([2]);
        expect(appended.every((filename) => !filename.includes("oos-holdout-4-bars"))).to.equal(true);
        expect(appended.some((filename) => filename.includes("oos-holdout-2-bars"))).to.equal(true);
    });

    it("discards in-flight iterations on Stop but flushes completed ones ascending", async () => {
        // Drives the sweep coordinator directly so Stop timing is
        // deterministic: the cancel flag flips after the FIRST iteration is
        // emitted, while a second runner is parked mid-task (a real worker
        // mid-iteration when Stop arrives) and later tasks never start.
        const datasets = longUpDownDatasets();
        const symbols = [...datasets.keys()];
        const tasks: AssetOpportunityBatchWorkerTask[] = [2, 3, 4, 5].map((holdoutBars, taskIndex) => ({
            taskIndex,
            holdoutBars,
            runId: "parallel-stop",
            interval: "5m",
            symbols,
            options: makeBatchOptions(symbols),
            settings,
            capitalSettings,
            strategyKeys: [STRATEGY_KEY],
            exitStrategyKeys: [],
            useRustEnginePreference: false,
            providerBySymbol: null,
            candidatePoolSize: 2,
            minFreshSupport: 1,
        }));
        let stopRequested = false;
        const emitted: number[] = [];
        const result = await runAssetOpportunityBatchSweep({
            tasks,
            runnerCount: 2,
            createRunner: createInProcessRunnerFactory({
                datasets,
                parkUntilStopTasks: new Set([1]),
            }),
            onIterationResult: async (task) => {
                emitted.push(task.holdoutBars);
                if (task.taskIndex === 0) stopRequested = true;
            },
            onProgress: () => {},
            onRunLog: () => {},
            isCancelled: () => stopRequested,
        });

        expect(result.cancelled).to.equal(true);
        expect(result.fatal).to.equal(null);
        expect(result.completedIterations).to.equal(1);
        // Task 0 (holdout 2) completed and flushed; task 1 (holdout 3) was
        // aborted mid-flight and discarded; tasks 2/3 never started.
        expect(emitted).to.deep.equal([2]);
    });

    it("keeps the sequential in-process loop when no runner factory is wired", async () => {
        // Direct callers without batchTaskRunnerFactory (e.g. tests and any
        // FINDER_ASSET_BATCH_WORKERS=1 rollback) must keep the original path.
        const { events } = await runAssetBatch({ owner: 8106, start: 2, end: 3, runId: "parallel-sequential" });
        const iterations = extractIterations(events);
        expect(iterations.map((event) => event.holdoutBars)).to.deep.equal([2, 3]);
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("asset_batch_done");
        if (done.type === "asset_batch_done") {
            expect(done.completedIterations).to.equal(2);
            expect(done.ok).to.equal(true);
        }
    });

    it("loads each plain dataset once across sequential holdout iterations (run-scoped dataset LRU)", async () => {
        // The sequential batch attaches a plain-dataset LRU sized to the
        // symbol count; without it every holdout iteration re-fetches every
        // symbol (the shared DataCache is only 64 entries and thrashes on
        // sequential scans).
        const datasets = longUpDownDatasets();
        const loadCounts = new Map<string, number>();
        const { events } = await runAssetBatch({
            owner: 8107,
            start: 2,
            end: 4,
            runId: "parallel-dataset-cache",
            datasets,
            loadDataset: async (symbol) => {
                loadCounts.set(symbol, (loadCounts.get(symbol) ?? 0) + 1);
                return datasets.get(symbol) ?? [];
            },
        });

        // 3 iterations completed, but each of the 2 plain symbols loaded once.
        const iterations = extractIterations(events);
        expect(iterations.length).to.equal(3);
        expect(loadCounts.get("UP")).to.equal(1);
        expect(loadCounts.get("DOWN")).to.equal(1);
        // Iterations still produce their own (holdout-specific) result rows.
        for (const iteration of iterations) {
            expect(iteration.assets.length).to.be.greaterThan(0);
        }
    });

    it("never caches failed dataset loads — every iteration retries them", async () => {
        const datasets = longUpDownDatasets();
        const loadCounts = new Map<string, number>();
        const { events } = await runAssetBatch({
            owner: 8108,
            start: 2,
            end: 4,
            runId: "parallel-dataset-cache-retry",
            datasets,
            loadDataset: async (symbol) => {
                const calls = (loadCounts.get(symbol) ?? 0) + 1;
                loadCounts.set(symbol, calls);
                // DOWN fails its FIRST load only; the retry proves rejections
                // are not served from (or retained in) the dataset LRU.
                if (symbol === "DOWN" && calls === 1) throw new Error("simulated transient load failure");
                return datasets.get(symbol) ?? [];
            },
        });

        const iterations = extractIterations(events);
        expect(iterations.length).to.equal(3);
        // UP succeeded immediately: cached, loaded once for the whole sweep.
        expect(loadCounts.get("UP")).to.equal(1);
        // DOWN's failed load was not cached: iteration 1 failed it, iteration
        // 2 reloaded (success -> cached), iteration 3 reused the cache. Two
        // loads total — never a cached failure, never an extra reload.
        expect(loadCounts.get("DOWN")).to.equal(2);
        const first = iterations[0]!;
        expect(first.assetDiagnostics.failedAssets.map((failure) => failure.symbol)).to.deep.equal(["DOWN"]);
        expect(iterations[1]!.assetDiagnostics.failedAssets).to.deep.equal([]);
        expect(iterations[2]!.assetDiagnostics.failedAssets).to.deep.equal([]);
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("asset_batch_done");
    });

    it("sizes the dataset LRU by the same memory budget as the worker pool", () => {
        // Never more entries than symbols; memory-bounded at
        // floor(75% RAM / 9MB per symbol), mirroring the worker-count ceiling.
        expect(resolveAssetOpportunityDatasetCacheCapacity(10, 8 * GIB)).to.equal(10);
        expect(resolveAssetOpportunityDatasetCacheCapacity(1000, 8 * GIB)).to.equal(682);
        expect(resolveAssetOpportunityDatasetCacheCapacity(1000, 64 * GIB)).to.equal(1000);
        expect(resolveAssetOpportunityDatasetCacheCapacity(0, 8 * GIB)).to.equal(1);
    });
});
