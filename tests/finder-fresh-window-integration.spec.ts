import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { ensureBuiltInStrategyLoaded } from "../lib/strategies/built-in-catalog";
import { buildFreshFoldScheduleFromDataEnd } from "../lib/finder/finder-asset-opportunity-fold";
import {
    FINDER_ASSET_BATCH_WORKERS_ENV,
    resolveAssetOpportunityBatchWorkerPath,
    type AssetOpportunityBatchRunnerEvents,
    type AssetOpportunityBatchRunnerFactory,
    type AssetOpportunityBatchTaskRunner,
} from "../lib/finder/server/finder-asset-opportunity-batch-worker-pool";
import {
    processFinderAssetOpportunityBatchRun,
    __testInternals,
} from "../lib/finder/server/finder-vite-plugin";
import type {
    AssetOpportunityBatchWorkerEvent,
    AssetOpportunityBatchWorkerTask,
} from "../lib/finder/server/finder-asset-opportunity-batch-worker";
import { runFreshWindowAnalysis } from "../scripts/analyze-fresh-window-research";
import type { FinderAssetOpportunityBatchStreamEvent } from "../lib/finder/server/finder-stream-types";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Time } from "../lib/types/strategies";

const { setRunOwnerForTests, resetRunStateForTests } = __testInternals;
const STRATEGY_KEY = "short_return_streak_fade_chop";
const SYMBOLS = ["FIXTURE_1", "FIXTURE_2", "FIXTURE_3", "FIXTURE_4", "FIXTURE_5", "FIXTURE_6"];
const INTERVAL = "4h";
const BAR_SECONDS = 4 * 60 * 60;

function buildFixtureDatasets(): Map<string, OHLCVData[]> {
    return new Map(SYMBOLS.map((symbol) => [symbol, Array.from({ length: 400 }, (_, index) => {
        const phase = index % 8;
        const symbolIndex = SYMBOLS.indexOf(symbol);
        const moveScale = symbolIndex >= 4 ? 0.1 : 1;
        const close = 100 - moveScale * (phase < 4 ? phase : 7 - phase);
        const high = symbolIndex < 2
            ? close * 1.10
            : symbolIndex < 4
                ? close * 1.001
                : close * 1.001;
        const low = symbolIndex < 2
            ? close * 0.999
            : symbolIndex < 4
                ? close * 0.80
                : close * 0.999;
        return {
            time: (1_700_000_000 + index * BAR_SECONDS) as Time,
            open: close,
            high,
            low,
            close,
            volume: 1000,
        };
    })]));
}

function restoreWorkerCount(previous: string | undefined): void {
    if (previous === undefined) delete process.env[FINDER_ASSET_BATCH_WORKERS_ENV];
    else process.env[FINDER_ASSET_BATCH_WORKERS_ENV] = previous;
}

/**
 * Production worker bootstrap with fixture data injected into each task.
 * This keeps the test hermetic while exercising worker_threads structured
 * cloning and the actual worker event whitelist.
 */
function createFixtureWorkerFactory(
    datasets: Map<string, OHLCVData[]>,
): AssetOpportunityBatchRunnerFactory {
    return async (events: AssetOpportunityBatchRunnerEvents): Promise<AssetOpportunityBatchTaskRunner> => {
        const worker = new Worker(await resolveAssetOpportunityBatchWorkerPath(), {});
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
                if (currentTask?.taskIndex === message.taskIndex) {
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
            if (message.type === "candidate_summary_chunk") {
                if (currentTask?.taskIndex === message.taskIndex) {
                    events.onCandidateSummaryChunk?.(currentTask, message.rows);
                }
                return;
            }
            if (message.type === "iteration_complete") {
                const task = takeCurrentTask();
                if (task?.taskIndex === message.taskIndex) {
                    events.onComplete(task, {
                        results: message.results,
                        cancelled: message.cancelled,
                        assetDiagnostics: message.assetDiagnostics,
                        totals: message.totals,
                        summary: "",
                        ...(message.foldMetadata ? { foldMetadata: message.foldMetadata } : {}),
                        ...(message.expectedCandidateSummaryRows !== undefined
                            ? { expectedCandidateSummaryRows: message.expectedCandidateSummaryRows }
                            : {}),
                    });
                }
                return;
            }
            if (message.type === "iteration_fatal") {
                const task = takeCurrentTask();
                if (task?.taskIndex === message.taskIndex) events.onFatal(task, message.error);
            }
        });
        worker.on("error", (error: Error) => {
            const task = takeCurrentTask();
            if (task) events.onFatal(task, `batch worker crashed: ${error.message}`);
        });
        worker.on("exit", (code) => {
            const task = takeCurrentTask();
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
                const inlineDatasets = Object.fromEntries(
                    task.symbols.map((symbol) => [symbol, datasets.get(symbol) ?? []]),
                );
                worker.postMessage({
                    type: "run_task",
                    task: { ...task, inlineDatasets },
                });
            },
            stop: () => {
                if (disposed || stopping) return;
                stopping = true;
                void terminateWorker();
            },
            dispose: async () => {
                if (disposed) return;
                disposed = true;
                stopping = true;
                await terminateWorker();
            },
        };
    };
}

function buildOptions(): FinderOptions {
    return {
        mode: "random",
        randomSeed: 42,
        scope: "asset_opportunity",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        symbols: SYMBOLS,
        topN: 1,
        steps: 1,
        rangePercent: 10,
        maxRuns: 1,
        dataSlice: "all",
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        assetOpportunity: {
            symbols: SYMBOLS,
            candidatePoolSize: 1,
            minFreshSupport: 1,
            evalLastBars: 1000,
            oosIgnoreLastBars: 26,
            oosHorizons: [12, 18, 24],
        },
    } as unknown as FinderOptions;
}

const settings: BacktestSettings = {
    executionModel: "next_open",
    tradeDirection: "long",
    allowSameBarExit: false,
    riskMode: "percentage",
    stopLossEnabled: true,
    stopLossPercent: 2,
    takeProfitEnabled: true,
    takeProfitPercent: 2,
    slippageBps: 10,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10000,
    positionSize: 100,
    commission: 0.1,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

async function runGeneratedArchive(useWorkers: boolean): Promise<{ root: string; lines: string[] }> {
    const datasets = buildFixtureDatasets();
    const dataEndTime = Number(datasets.get(SYMBOLS[0]!)!.at(-1)!.time);
    const foldSchedule = buildFreshFoldScheduleFromDataEnd(dataEndTime, BAR_SECONDS);
    const strategy = await ensureBuiltInStrategyLoaded(STRATEGY_KEY);
    if (!strategy) throw new Error(`Fixture strategy failed to load: ${STRATEGY_KEY}`);
    const root = mkdtempSync(path.join(tmpdir(), "fresh-window-pipeline-"));
    const previousWorkerCount = process.env[FINDER_ASSET_BATCH_WORKERS_ENV];
    process.env[FINDER_ASSET_BATCH_WORKERS_ENV] = useWorkers ? "2" : "1";
    try {
        setRunOwnerForTests(useWorkers ? 9302 : 9301);
        await processFinderAssetOpportunityBatchRun(
            {
                runId: useWorkers ? "fixture-worker-run" : "fixture-sequential-run",
                interval: INTERVAL,
                symbols: SYMBOLS,
                options: buildOptions(),
                settings,
                capitalSettings,
                selectedStrategies: [{ key: STRATEGY_KEY, name: strategy.name, strategy }],
                useRustEnginePreference: false,
                loadDataset: async (symbol) => datasets.get(symbol) ?? [],
                loadForwardDataset: async (symbol) => datasets.get(symbol) ?? [],
                abortSignal: new AbortController().signal,
                candidatePoolSize: 1,
                minFreshSupport: 1,
                archiveSort: null,
                batch: { startHoldoutBars: 12, endHoldoutBars: 300 },
                researchProgram: "fresh-window",
                batchRole: "collection",
                foldSchedule,
                dataSyncSnapshot: "fixture-sync-2026-08-23",
                gitCommit: "fixture-commit-2026-08-23",
                ...(useWorkers ? { batchTaskRunnerFactory: createFixtureWorkerFactory(datasets) } : {}),
            },
            (_event: FinderAssetOpportunityBatchStreamEvent) => undefined,
            useWorkers ? 9302 : 9301,
            root,
        );
    } finally {
        restoreWorkerCount(previousWorkerCount);
        resetRunStateForTests();
    }
    const archiveDirectory = path.join(root, "archive", "fresh-window");
    const lines = runFreshWindowAnalysis({ archiveDirectory });
    return { root, lines };
}

describe("fresh-window real producer-to-analyzer integration", () => {
    afterEach(() => {
        resetRunStateForTests();
    });

    for (const [label, useWorkers] of [["sequential", false], ["worker_threads", true]] as const) {
        it(`produces an analyzer-valid collection archive through the ${label} path`, async () => {
            const { root, lines } = await runGeneratedArchive(useWorkers);
            try {
                expect(lines).to.include("S0: PASS");
                expect(lines.some((line) => line.startsWith("Recurrence: NOT AUTHORIZED"))).to.equal(true);
                const identity = readFileSync(
                    path.join(root, "archive", "fresh-window", "oos-fold-identities-300-bars.txt"),
                    "utf8",
                );
                expect(identity).to.contain("Expected evaluated row count: 6");
                expect(identity).to.contain("candidateFingerprint");
                expect(readdirSync(path.join(root, "archive", "fresh-window"))).to.have.length.greaterThan(25);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
