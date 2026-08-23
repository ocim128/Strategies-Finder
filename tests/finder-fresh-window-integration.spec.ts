import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { ensureBuiltInStrategyLoaded } from "../lib/strategies/built-in-catalog";
import {
    buildFreshFoldScheduleFromDataEnd,
    sliceFinderAssetDataWithinFreshFoldWindow,
} from "../lib/finder/finder-asset-opportunity-fold";
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
type FreshFoldSchedule = ReturnType<typeof buildFreshFoldScheduleFromDataEnd>;

function buildFixtureDatasets(): Map<string, OHLCVData[]> {
    const calendarSlotTimes = Array.from({ length: 720 }, (_, slot) => 1_700_000_000 + slot * BAR_SECONDS);
    const holidayTime = calendarSlotTimes[300]!;
    const calendarTimes = calendarSlotTimes
        .filter((time) => ![0, 6].includes(new Date(time * 1000).getUTCDay()) && time !== holidayTime);
    const schedule = buildFreshFoldScheduleFromDataEnd(calendarTimes);
    const signalHoldouts = new Map(SYMBOLS.map((_, symbolIndex) => [
        symbolIndex,
        schedule
            .filter((_, foldIndex) => symbolIndex === 0
                || (symbolIndex === 5 && foldIndex === 6)
                || (symbolIndex === 1 && foldIndex === 1)
                || (symbolIndex === 2 && foldIndex === 2))
            .map((entry) => entry.holdoutBars),
    ]));

    return new Map(SYMBOLS.map((symbol, symbolIndex) => {
        const times = (symbolIndex === 5 ? calendarSlotTimes : calendarTimes).filter((_, slot) =>
            !(symbolIndex === 1 && slot % 17 === 0)
            && !(symbolIndex === 2 && slot % 23 === 0)
            && !(symbolIndex === 3 && slot % 31 === 0),
        );
        const moveScale = symbolIndex === 2 ? 0.1 : 1;
        const phaseBars = symbolIndex === 5 ? 80 : 180;
        const closes = times.map((_, index) => {
            // A bounded, old in-sample regime supplies real trade/path
            // scalars. It ends well before the judged boundaries; the later
            // flat region plus isolated fold markers keeps forward outcomes
            // sparse instead of making every candidate eligible.
            if (index >= phaseBars) return 100;
            const phase = index % 8;
            return 100 - moveScale * (phase < 4 ? phase : 7 - phase);
        });
        const signalIndexes = (signalHoldouts.get(symbolIndex) ?? []).map((holdout) => {
            const foldEnd = schedule.find((entry) => entry.holdoutBars === holdout)!.foldEnd;
            const boundaryIndex = times.reduce(
                (last, time, index) => time <= foldEnd ? index : last,
                -1,
            );
            // The batch hides `holdoutBars` candles before it asks the
            // fresh-entry path about this fold. Put the sparse streak at the
            // actual visible boundary, not at raw foldEnd (which is outside
            // the search window once the holdout is applied).
            const signalIndex = boundaryIndex - holdout;
            return signalIndex;
        }).filter((signalIndex) => signalIndex >= 4);
        const sortedSignalIndexes = [...new Set(signalIndexes)].sort((left, right) => left - right);
        let clusterStart = 0;
        while (clusterStart < sortedSignalIndexes.length) {
            let clusterEnd = clusterStart;
            while (
                clusterEnd + 1 < sortedSignalIndexes.length
                && sortedSignalIndexes[clusterEnd + 1]! - sortedSignalIndexes[clusterEnd]! <= 4
            ) {
                clusterEnd += 1;
            }
            const firstSignalIndex = sortedSignalIndexes[clusterStart]!;
            const lastSignalIndex = sortedSignalIndexes[clusterEnd]!;
            for (let index = firstSignalIndex - 3; index <= lastSignalIndex; index += 1) {
                closes[index] = 100 - (index - (firstSignalIndex - 3)) * moveScale;
            }
            clusterStart = clusterEnd + 1;
        }
        if (symbolIndex === 0) {
            // Weekend folds have fewer visible rows before their boundary.
            // Keep the bounded in-sample regime available in those windows.
            for (const holdout of [84, 168, 252]) {
                const foldEnd = schedule.find((entry) => entry.holdoutBars === holdout)!.foldEnd;
                const boundaryIndex = times.reduce(
                    (last, time, index) => time <= foldEnd ? index : last,
                    -1,
                );
                const signalIndex = boundaryIndex - holdout;
                for (const offset of [30, 18, 6]) {
                    const cycleEnd = signalIndex - offset;
                    if (cycleEnd < 4 || cycleEnd + 1 >= closes.length) continue;
                    closes[cycleEnd - 3] = 100;
                    closes[cycleEnd - 2] = 99;
                    closes[cycleEnd - 1] = 98;
                    closes[cycleEnd] = 97;
                    closes[cycleEnd + 1] = 100;
                }
            }
        }
        const candles = times.map((time, index) => {
            const close = closes[index]!;
            const takeProfitAsset = symbolIndex === 0 || symbolIndex === 4 || symbolIndex === 5;
            const stopLossAsset = symbolIndex === 1;
            return {
                time: time as Time,
                open: close,
                high: close * (takeProfitAsset ? 1.10 : 1.001),
                low: close * (stopLossAsset ? 0.80 : 0.999),
                close,
                volume: 1000,
            };
        });
        return [symbol, candles];
    }));
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
                        ...(message.expectedOutcomeSummaryRows !== undefined
                            ? { expectedOutcomeSummaryRows: message.expectedOutcomeSummaryRows }
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

function buildWallClockSchedule(dataEndTime: number): FreshFoldSchedule {
    return Array.from({ length: 25 }, (_, index) => {
        const foldEnd = dataEndTime - (25 - index) * 12 * BAR_SECONDS;
        return {
            holdoutBars: (index + 1) * 12,
            foldEnd,
            oosStart: foldEnd + BAR_SECONDS,
            oosEnd: foldEnd + 12 * BAR_SECONDS,
        };
    });
}

async function runGeneratedArchive(
    useWorkers: boolean,
    scheduleOverride?: FreshFoldSchedule,
): Promise<{ root: string; lines: string[] }> {
    const datasets = buildFixtureDatasets();
    const referenceTimestamps = datasets.get(SYMBOLS[0]!)!.map((candle) => Number(candle.time));
    const foldSchedule = scheduleOverride ?? buildFreshFoldScheduleFromDataEnd(referenceTimestamps);
    const hasCalendarGap = datasets.get(SYMBOLS[0]!)!.some((candle, index, candles) =>
        index > 0 && Number(candle.time) - Number(candles[index - 1]!.time) > BAR_SECONDS,
    );
    const forwardWidths = SYMBOLS.flatMap((symbol) => foldSchedule.map((fold) =>
        sliceFinderAssetDataWithinFreshFoldWindow(datasets.get(symbol)!, fold).length,
    ));
    if (!hasCalendarGap || new Set(forwardWidths).size < 2) {
        throw new Error(`Fixture is not calendar-realistic: gap=${hasCalendarGap}, widths=${forwardWidths.join(",")}`);
    }
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
                expect(lines).to.include("S0 windows=25, fullPoolRows=150, eligibleRows=150, finiteExecutionRows=49, randomControls=25");
                expect(lines).to.include("S0 hand checks: TP=32, SL=3, horizon=14");
                const identity = readFileSync(
                    path.join(root, "archive", "fresh-window", "oos-fold-identities-300-bars.txt"),
                    "utf8",
                );
                expect(identity).to.contain("Expected evaluated row count: 6");
                expect(identity).to.contain("Expected eligible outcome row count:");
                expect(identity).to.contain("candidateFingerprint");
                const coverage = lines.find((line) => line.startsWith("S0 coverage:"));
                expect(coverage).to.not.equal(undefined);
                expect(coverage).to.contain("eligible-outcomes=49/49");
                expect(coverage).to.contain("all-evaluated=32.67%");
                expect(Number(coverage!.match(/all-evaluated=([0-9.]+)%/)?.[1])).to.be.lessThan(50);
                const identityFiles = readdirSync(path.join(root, "archive", "fresh-window"))
                    .filter((file) => /^oos-fold-identities-\d+-bars\.txt$/.test(file));
                expect(identityFiles).to.have.length(25);
                for (const file of identityFiles) {
                    const count = Number(readFileSync(
                        path.join(root, "archive", "fresh-window", file),
                        "utf8",
                    ).match(/Forward outcome row count: (\d+)/)?.[1] ?? 0);
                    expect(count, file).to.be.greaterThan(0);
                }
                expect(readdirSync(path.join(root, "archive", "fresh-window"))).to.have.length.greaterThan(25);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }

    it("fails S0 for the old wall-clock schedule against the same gapped data", async () => {
        const datasets = buildFixtureDatasets();
        const dataEndTime = Number(datasets.get(SYMBOLS[0]!)!.at(-1)!.time);
        const { root, lines } = await runGeneratedArchive(false, buildWallClockSchedule(dataEndTime));
        try {
            expect(lines).to.include("S0: FAIL");
            expect(lines).to.include("S0 ERROR: full-pool random control is missing in one or more windows");
            const identityFiles = readdirSync(path.join(root, "archive", "fresh-window"))
                .filter((file) => /^oos-fold-identities-\d+-bars\.txt$/.test(file));
            expect(identityFiles.some((file) =>
                /Forward outcome row count: 0/.test(readFileSync(
                    path.join(root, "archive", "fresh-window", file),
                    "utf8",
                )),
            )).to.equal(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
