import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import { runAssetCandidateBacktest } from "../lib/finder/finder-asset-candidate-execution";
import {
    simulateFinderAssetOpportunityForwardOutcome,
} from "../lib/finder/finder-asset-opportunity-forward-contract";
import {
    createServerFinderAssetOpportunityLoadContext,
} from "../lib/finder/server/server-finder-data-loader";
import {
    runAssetOpportunityBatchWorkerTask,
    type AssetOpportunityBatchWorkerTask,
} from "../lib/finder/server/finder-asset-opportunity-batch-worker";
import { createFinderAssetOpportunityRng } from "../lib/finder/finder-asset-opportunity-control-trace";
import type { FinderSelectedStrategy } from "../lib/finder/finder-runner";

function referenceRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function runRngParityProbe(): void {
    const shared = createFinderAssetOpportunityRng(42);
    const reference = referenceRng(42);
    const sharedSequence = Array.from({ length: 8 }, () => shared());
    const referenceSequence = Array.from({ length: 8 }, () => reference());
    console.log(JSON.stringify({
        sharedRngParity: sharedSequence.every((value, index) => value === referenceSequence[index]),
        sequence: sharedSequence,
    }));
}

function candle(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as unknown as Time, open, high, low, close, volume: 1_000 };
}

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0.1,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
};

const options = {
    mode: "random",
    scope: "asset_opportunity",
    sortPriority: ["netProfit"],
    topN: 1,
    maxRuns: 1,
    dataSlice: "all",
    freezeRiskManagement: false,
    assetOpportunity: {
        symbols: ["PAIR"],
        evalLastBars: 1000,
        oosIgnoreLastBars: 1,
        oosHorizons: [2, 3, 4],
        candidatePoolSize: 1,
        minFreshSupport: 1,
    },
} as unknown as FinderOptions;

const strategy: Strategy = {
    name: "reaudit-forward",
    description: "adversarial parity fixture",
    defaultParams: {},
    paramLabels: {},
    execute(data) {
        const first = data[0];
        return first ? [{ time: first.time, type: "buy", price: first.close }] : [];
    },
};

const settings: BacktestSettings = {
    executionModel: "next_open",
    tradeDirection: "long",
    allowSameBarExit: false,
    riskMode: "percentage",
    stopLossEnabled: true,
    stopLossPercent: 2,
    takeProfitEnabled: true,
    takeProfitPercent: 2,
    slippageBps: 100,
};

async function engineTrade(data: OHLCVData[], slippageBps = 100) {
    const engineSettings = { ...settings, slippageBps };
    const output = await runAssetCandidateBacktest({
        data,
        symbol: "PAIR",
        interval: "4h",
        strategy,
        strategyKey: "reaudit-forward",
        strategyParams: {},
        riskOverrideParams: {},
        settings: engineSettings,
        capitalSettings,
        options,
        closedCandleDataOverride: data,
        needs: { compact: false, trades: true, fullAnalytics: false, endpointSelection: false },
    });
    const trade = output.result.trades[0];
    return trade
        ? { exitReason: trade.exitReason, exitPrice: trade.exitPrice, pnlPercent: trade.pnlPercent }
        : null;
}

function contractOutcome(data: OHLCVData[], slippageBps = 100) {
    const rawEntry = data[1]!.open;
    const entryFill = rawEntry * (1 + slippageBps / 10_000);
    return simulateFinderAssetOpportunityForwardOutcome({
        candles: data,
        direction: "long",
        entryPrice: rawEntry,
        entryBarIndex: 1,
        takeProfitPrice: entryFill * 1.02,
        stopLossPrice: entryFill * 0.98,
        horizonBars: data.length - 1,
        executionModel: "next_open",
        allowSameBarExit: false,
        slippageBps,
        commissionPercent: 0.1,
    });
}

function parityCandleSet(kind: "entry-both" | "gap-stop" | "tp-tolerance" | "sl-tolerance" | "outside-tolerance"): OHLCVData[] {
    const entry = 100;
    const entryFill = entry * 1.01;
    const tp = entryFill * 1.02;
    const sl = entryFill * 0.98;
    const boundary = kind === "tp-tolerance"
        ? [candle(3, 100, tp * (1 - 5e-11), 100, 100)]
        : kind === "sl-tolerance"
            ? [candle(3, 100, 100, sl * (1 + 5e-11), 100)]
            : kind === "outside-tolerance"
                ? [candle(3, 100, tp * (1 - 2e-10), sl * (1 + 2e-10), 100)]
                : kind === "gap-stop"
                    ? [candle(3, 95, 104, 90, 94)]
                    : [];
    return [
        candle(1, 100, 100, 100, 100),
        candle(2, entry, kind === "entry-both" ? tp * 1.02 : 100, kind === "entry-both" ? sl * 0.98 : 100, entry),
        ...boundary,
        candle(4, 100, 100, 100, 100),
    ];
}

async function runParityMatrix(): Promise<void> {
    for (const kind of ["entry-both", "gap-stop", "tp-tolerance", "sl-tolerance", "outside-tolerance"] as const) {
        const data = parityCandleSet(kind);
        const [engine, contract] = await Promise.all([engineTrade(data), Promise.resolve(contractOutcome(data))]);
        console.log(JSON.stringify({ kind, engine, contract }));
    }
    const eodData = parityCandleSet("outside-tolerance");
    const [zeroSlippageEngine, zeroSlippageContract] = await Promise.all([
        engineTrade(eodData, 0),
        Promise.resolve(contractOutcome(eodData, 0)),
    ]);
    console.log(JSON.stringify({
        kind: "zero-slippage-end-of-data",
        engine: zeroSlippageEngine,
        contract: zeroSlippageContract,
    }));

    const entry = 100;
    const entryFill = entry * 1.01;
    const takeProfit = entryFill * 1.02;
    const finalTouchData = [
        candle(1, 100, 100, 100, 100),
        candle(2, entry, 100, 100, entry),
        candle(3, 100, takeProfit, 100, 101),
    ];
    const [finalTouchEngine, finalTouchContract] = await Promise.all([
        engineTrade(finalTouchData),
        Promise.resolve(contractOutcome(finalTouchData)),
    ]);
    console.log(JSON.stringify({
        kind: "final-bar-tp-touch",
        engine: finalTouchEngine,
        contract: finalTouchContract,
    }));
}

const cacheStrategy: FinderSelectedStrategy = {
    key: "reaudit-cache",
    name: "reaudit-cache",
    strategy: {
        name: "reaudit-cache",
        description: "cache fold fixture",
        defaultParams: {},
        paramLabels: {},
        execute(data) {
            const last = data.at(-1);
            return last ? [{ time: last.time, type: "buy", price: last.close }] : [];
        },
    },
};

const cacheOptions = {
    mode: "random",
    scope: "asset_opportunity",
    sortPriority: ["netProfit"],
    topN: 1,
    maxRuns: 1,
    dataSlice: "all",
    assetOpportunity: {
        symbols: ["PAIR"],
        evalLastBars: 1000,
        oosIgnoreLastBars: 12,
        oosHorizons: [12, 18, 24],
        candidatePoolSize: 1,
        minFreshSupport: 1,
    },
} as unknown as FinderOptions;

const cacheSettings: BacktestSettings = {
    executionModel: "next_open",
    tradeDirection: "long",
    allowSameBarExit: false,
    riskMode: "percentage",
    stopLossEnabled: true,
    stopLossPercent: 2,
    takeProfitEnabled: true,
    takeProfitPercent: 2,
    slippageBps: 0,
};

function makeCacheTask(foldEnd: number, taskIndex: number, raw: OHLCVData[]): AssetOpportunityBatchWorkerTask {
    return {
        taskIndex,
        holdoutBars: taskIndex === 0 ? 12 : 24,
        runId: "reaudit-cache",
        interval: "4h",
        symbols: ["PAIR"],
        options: cacheOptions,
        settings: cacheSettings,
        capitalSettings: { ...capitalSettings, commission: 0 },
        strategyKeys: [],
        exitStrategyKeys: [],
        useRustEnginePreference: false,
        providerBySymbol: null,
        candidatePoolSize: 1,
        minFreshSupport: 1,
        foldEnd,
        loadDatasetIsRaw: true,
        researchProgram: "fresh-window",
        inlineDatasets: { PAIR: raw },
    };
}

async function runCacheProbe(): Promise<void> {
    const raw = Array.from({ length: 24 }, (_, index) => candle(100 + index * 100, 100 + index, 101 + index, 99 + index, 100 + index));
    const context = createServerFinderAssetOpportunityLoadContext(1);
    let rawLoadCalls = 0;
    const run = async (task: AssetOpportunityBatchWorkerTask) => {
        const summaryRows: unknown[] = [];
        const result = await runAssetOpportunityBatchWorkerTask({
            task,
            strategySelection: { selectedStrategies: [cacheStrategy] },
            loadDataset: async () => { rawLoadCalls += 1; return raw; },
            loadForwardDataset: async () => raw,
            assetLoadContext: context,
            abortSignal: new AbortController().signal,
            isCancelled: () => false,
            onProgress: () => undefined,
            onCandidateSummaryChunk: (rows) => summaryRows.push(...rows),
        });
        return { result, summaryRows };
    };
    const firstRun = await run(makeCacheTask(1500, 0, raw));
    const secondRun = await run(makeCacheTask(1700, 1, raw));
    const first = firstRun.result;
    const second = secondRun.result;
    console.log(JSON.stringify({
        cacheProbe: true,
        rawLoadCalls,
        firstFold: first.foldMetadata,
        secondFold: second.foldMetadata,
        firstResult: firstRun.summaryRows[0] ?? null,
        secondResult: secondRun.summaryRows[0] ?? null,
        firstTotals: first.totals,
        secondTotals: second.totals,
        firstDiagnostics: first.assetDiagnostics,
        secondDiagnostics: second.assetDiagnostics,
        cacheStats: context.datasetCache ? { hits: context.datasetCache.hitCount(), misses: context.datasetCache.missCount() } : null,
    }));
}

(async () => {
    runRngParityProbe();
    await runParityMatrix();
    await runCacheProbe();
})();
