import {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
    buildEntryBacktestResult,
    precomputeIndicators,
    runBacktest,
    applySignalPolarity,
} from "../strategies/index";
import { calculateSharpeRatioFromEquityCurve, calculateSharpeRatioFromReturns } from "../strategies/performance-metrics";
import { buildSelectionResult } from "./endpoint";
import { hasNonZeroSnapshotFilter } from "../rust-settings-sanitizer";
import { selectExecutionAwareClosedCandles } from "../alert-evaluation-window";
import { mergeStrategySignals } from "../signal-merge";
import {
    getPreparedFinderData,
    type CandidateResult,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import type { CapitalSettings } from "../types/backtest";
import type { EndpointSelectionAdjustment, FinderOptions, FinderResult } from "../types/finder";
import type { StrategyExecutionContext } from "../types/strategies";
import type { FinderRunInput } from "./finder-runner";

export function buildFinderEvaluationData(
    data: OHLCVData[],
    interval: string,
    settings: BacktestSettings
): OHLCVData[] {
    return selectExecutionAwareClosedCandles(
        data,
        interval,
        settings,
        {
            nowSec: Math.floor(Date.now() / 1000),
            minClosedCandles: 1,
            fallbackToTrimmedClosed: true,
        }
    ) ?? data;
}

export type StrategyPlan = {
    key: string;
    name: string;
    strategy: Strategy;
    paramSets: StrategyParams[];
};

export type ParamJob = {
    id: number;
    key: string;
    name: string;
    params: StrategyParams;
    backtestSettings: BacktestSettings;
    rustBacktestSettings: BacktestSettings;
    strategy: Strategy;
};

export type FinderDatasetFlags = {
    dataSize: number;
    isLargeDataset: boolean;
    isVeryLargeDataset: boolean;
    isExtremeDataset: boolean;
    compactBacktestThreshold: number;
    shouldUseCompactBacktest: boolean;
    rustCompactMode: boolean;
    batchSize: number;
    isHeavyFinderConfig: boolean;
};

export type PreparedRun = {
    id: string;
    job: ParamJob;
    signals: Signal[];
};

export function resolveEffectiveCapitalSettings(input: FinderRunInput): CapitalSettings {
    return input.comboPrimaryCapital ?? input.capitalSettings;
}

export function generateSignalsForJob(
    job: ParamJob,
    data: OHLCVData[],
    preparedDataCache?: FinderPreparedDataCache,
    preparedSettings?: BacktestSettings,
    executionContext?: StrategyExecutionContext
): Signal[] {
    const preparedFinderData = preparedDataCache
        ? getPreparedFinderData(preparedDataCache, job.key, job.strategy, data, preparedSettings ?? job.backtestSettings, executionContext)
        : undefined;
    const rawSignals = job.strategy.executePrepared
        ? job.strategy.executePrepared(preparedFinderData, job.params, data, executionContext)
        : job.strategy.execute(data, job.params, executionContext);
    return applySignalPolarity(rawSignals, job.backtestSettings);
}

export function applyComboMerge(
    signals: Signal[],
    input: FinderRunInput
): Signal[] {
    if (!input.comboPrimarySignals) return signals;
    return mergeStrategySignals(input.comboPrimarySignals, signals, "and") as Signal[];
}

export function runStrategyBacktest(args: {
    strategy: Strategy;
    data: OHLCVData[];
    signals: Signal[];
    params: StrategyParams;
    capitalSettings: CapitalSettings;
    backtestSettings: BacktestSettings;
    backtestFn: typeof runBacktest;
    precomputed?: ReturnType<typeof precomputeIndicators>;
}): BacktestResult {
    const {
        strategy,
        data,
        signals,
        params,
        capitalSettings,
        backtestSettings,
        backtestFn,
        precomputed,
    } = args;
    const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount, advancedSizing } = capitalSettings;
    const evaluation = strategy.evaluate?.(data, params, signals);
    const entryStats = evaluation?.entryStats;
    return strategy.metadata?.role === "entry" && entryStats
        ? buildEntryBacktestResult(entryStats)
        : backtestFn(
            data,
            signals,
            initialCapital,
            positionSize,
            commission,
            backtestSettings,
            { mode: sizingMode, fixedTradeAmount, advancedSizing },
            precomputed
        );
}

export function buildFinderResult(args: {
    key: string;
    name: string;
    params: StrategyParams;
    result: BacktestResult;
    comboMode?: boolean;
    comboPrimaryConfigName?: string;
    timeframes?: string[];
    selectionResult?: BacktestResult;
    compositeEdgeRatio?: number;
    endpointAdjusted?: boolean;
    endpointRemovedTrades?: number;
}): FinderResult {
    const {
        key,
        name,
        params,
        result,
        comboMode,
        comboPrimaryConfigName,
        timeframes,
        selectionResult,
        compositeEdgeRatio,
        endpointAdjusted,
        endpointRemovedTrades,
    } = args;
    return {
        key,
        name,
        comboMode,
        comboPrimaryConfigName,
        timeframes,
        params,
        result,
        selectionResult: selectionResult ?? result,
        compositeEdgeRatio,
        endpointAdjusted: endpointAdjusted ?? false,
        endpointRemovedTrades: endpointRemovedTrades ?? 0,
    };
}

export function runBacktestAndInsert(
    data: OHLCVData[],
    signals: Signal[],
    job: ParamJob,
    backtestFn: typeof runBacktest,
    capitalSettings: CapitalSettings,
    backtestSettings: BacktestSettings,
    precomputed: ReturnType<typeof precomputeIndicators>,
    insertResult: (candidate: CandidateResult) => void,
    onInsertTiming?: (durationMs: number) => void
): void {
    try {
        const result = runStrategyBacktest({
            strategy: job.strategy,
            data,
            signals,
            params: job.params,
            capitalSettings,
            backtestSettings,
            backtestFn,
            precomputed,
        });
        const insertStartedAt = performance.now();
        insertResult({
            key: job.key,
            name: job.name,
            params: job.params,
            result,
        });
        onInsertTiming?.(performance.now() - insertStartedAt);
    } catch (error) {
        console.warn(`[Finder] Backtest failed for ${job.key}:`, error);
    }
}

function hasHeavySnapshotFilters(settings: BacktestSettings): boolean {
    return hasNonZeroSnapshotFilter(settings);
}

export function computeDatasetFlags(
    dataSize: number,
    settings: BacktestSettings,
    options: FinderOptions,
    hasConfirmationStrategies: boolean
): FinderDatasetFlags {
    const isLargeDataset = dataSize > 500_000;
    const isVeryLargeDataset = dataSize > 2_000_000;
    const isExtremeDataset = dataSize > 4_000_000;
    const hasSnapshotFilters = hasHeavySnapshotFilters(settings);
    const hasHeavyTradeFiltering = options.tradeFilterEnabled && options.minTrades >= 1_000;
    const isHeavyFinderConfig = hasSnapshotFilters || hasHeavyTradeFiltering || hasConfirmationStrategies;
    const compactBacktestThreshold = options.mode === "random"
        ? (isHeavyFinderConfig ? 50_000 : 100_000)
        : (isHeavyFinderConfig ? 50_000 : 500_000);
    const shouldUseCompactBacktest = dataSize >= compactBacktestThreshold;

    const batchSize = isExtremeDataset
        ? 1
        : isVeryLargeDataset
            ? 2
            : isLargeDataset
                ? 8
                : isHeavyFinderConfig
                    ? 12
                    : 64;

    return {
        dataSize,
        isLargeDataset,
        isVeryLargeDataset,
        isExtremeDataset,
        compactBacktestThreshold,
        shouldUseCompactBacktest,
        rustCompactMode: shouldUseCompactBacktest,
        batchSize,
        isHeavyFinderConfig,
    };
}

export function normalizeResultSharpe(result: BacktestResult, _initialCapital: number): BacktestResult {
    if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
        return {
            ...result,
            sharpeRatio: calculateSharpeRatioFromEquityCurve(result.equityCurve),
        };
    }

    if (Array.isArray(result.trades) && result.trades.length > 0) {
        return {
            ...result,
            sharpeRatio: calculateSharpeRatioFromReturns(result.trades.map((trade) => trade.pnlPercent)),
        };
    }

    return result;
}

export function isBacktestResultConsistent(result: BacktestResult): boolean {
    const totalTrades = result.totalTrades;
    if (totalTrades !== result.winningTrades + result.losingTrades) return false;
    if (totalTrades <= 0) return true;

    const expectedWinRate = (result.winningTrades / totalTrades) * 100;
    if (Math.abs(expectedWinRate - result.winRate) > 1) return false;

    const expectedAvgTrade = result.netProfit / totalTrades;
    const tolerance = Math.max(0.01, Math.abs(expectedAvgTrade) * 0.15);
    if (Math.abs(expectedAvgTrade - result.avgTrade) > tolerance) return false;

    if (!Number.isFinite(result.sharpeRatio)) return false;
    if (Math.abs(result.sharpeRatio) > 8) return false;

    return true;
}

export function buildSelection(
    raw: BacktestResult,
    lastDataTime: Time | null,
    initialCapital: number
): EndpointSelectionAdjustment {
    return buildSelectionResult(raw, lastDataTime, initialCapital);
}

export function normalizeSeed(seed: number | undefined): number {
    if (!Number.isFinite(seed)) return 1;
    const normalized = (Math.floor(Number(seed)) >>> 0);
    return normalized === 0 ? 1 : normalized;
}

export function deriveStrategySeed(seed: number | undefined, strategyKey: string): number {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < strategyKey.length; i++) {
        hash ^= strategyKey.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (normalizeSeed(seed) ^ hash) >>> 0;
}
