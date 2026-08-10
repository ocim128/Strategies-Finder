import {
    executeBacktest,
    prepareClosedCandleData,
    resolveExecutorBacktestSettings,
} from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { ensureConfirmationStrategiesLoaded } from "../confirmation-signal-filter";
import type { CrossSymbolDataFetcher } from "../cross-symbol-runtime";
import { median } from "../statistics-utils";
import type { CapitalSettings } from "../types/backtest";
import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
} from "../types/strategies";
import type {
    FinderDataSlice,
    FinderStrategyQualityDiagnostics,
    FinderStrategyQualityMetric,
    FinderStrategyQualityResult,
    FinderStrategyQualitySymbolMetrics,
    FinderStrategyQualitySymbolResult,
} from "../types/finder";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import type { FinderSelectedStrategy } from "./finder-runner";
import { resolveOosDataSlice, sliceFinderDataWindow } from "./finder-manager-logic";

export interface FinderStrategyQualityRunInput {
    selectedStrategies: FinderSelectedStrategy[];
    symbols: string[];
    interval: string;
    dataSlice: FinderDataSlice;
    oosValidationEnabled: boolean;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    loadDataset: (symbol: string, interval: string) => Promise<OHLCVData[]>;
    getProvider: (symbol: string) => string;
    getDatasetCacheStats?: () => FinderStrategyQualityDiagnostics["datasetCache"];
    yieldControl: () => Promise<void>;
    isCancelled: () => boolean;
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
}

export interface FinderStrategyQualityRunOutput {
    results: FinderStrategyQualityResult[];
    loadedSymbols: number;
    failedSymbols: number;
    failedSymbolDetails: Array<{ symbol: string; error: string }>;
    performance: FinderStrategyQualityDiagnostics;
    cancelled: boolean;
}

type QualityMetricKey = "result" | "oosResult";
type QualityRow = {
    selected: FinderSelectedStrategy;
    symbols: FinderStrategyQualitySymbolResult[];
};

// Keeps only a small batch of pair datasets live while overlapping local CSV
// and cache reads. The bounded size avoids retaining the whole universe.
const QUALITY_DATA_LOAD_CONCURRENCY = 4;
const QUALITY_LEG_CACHE_CAPACITY = 24;
const QUALITY_UI_UPDATE_EVERY_RUNS = 16;
const QUALITY_YIELD_EVERY_RUNS = 32;
type QualityDatasetCacheStats = NonNullable<FinderStrategyQualityDiagnostics["datasetCache"]>;

function getCacheDelta(
    before: QualityDatasetCacheStats | undefined,
    after: QualityDatasetCacheStats,
): QualityDatasetCacheStats {
    const delta = (current: number, previous: number | undefined): number =>
        current - (previous ?? 0);
    return {
        leg: {
            hits: delta(after.leg.hits, before?.leg.hits),
            misses: delta(after.leg.misses, before?.leg.misses),
            size: after.leg.size,
            max: after.leg.max,
        },
        pair: {
            hits: delta(after.pair.hits, before?.pair.hits),
            misses: delta(after.pair.misses, before?.pair.misses),
            size: after.pair.size,
            max: after.pair.max,
        },
        disk: {
            hits: delta(after.disk.hits, before?.disk.hits),
            misses: delta(after.disk.misses, before?.disk.misses),
            writes: delta(after.disk.writes, before?.disk.writes),
        },
    };
}

function normalizeSymbols(symbols: readonly string[]): string[] {
    return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}

/**
 * Keep pair legs hot in the existing 24-entry LRU. This only changes load
 * order; result rows are restored to the user's original symbol order below.
 */
export function optimizeQualitySymbolOrder(symbols: readonly string[]): string[] {
    const pairs = symbols.map((symbol, originalIndex) => {
        const parsed = parseSyntheticPairToken(symbol);
        return parsed
            ? { symbol, originalIndex, legs: [parsed.baseSymbol, parsed.quoteSymbol] as const }
            : null;
    });
    if (pairs.some((pair) => pair === null)) return [...symbols];

    const legUseCount = new Map<string, number>();
    for (const pair of pairs) {
        for (const leg of pair!.legs) {
            legUseCount.set(leg, (legUseCount.get(leg) ?? 0) + 1);
        }
    }

    const remaining = new Set(pairs.map((_, index) => index));
    const activeLegs = new Set<string>();
    const ordered: Array<NonNullable<typeof pairs[number]>> = [];
    const touchLeg = (leg: string): void => {
        activeLegs.delete(leg);
        activeLegs.add(leg);
        while (activeLegs.size > QUALITY_LEG_CACHE_CAPACITY) {
            const oldest = activeLegs.values().next().value;
            if (oldest === undefined) break;
            activeLegs.delete(oldest);
        }
    };

    while (remaining.size > 0) {
        let bestIndex: number | null = null;
        let bestShared = -1;
        let bestPopularity = -1;
        for (const index of remaining) {
            const pair = pairs[index]!;
            const shared = pair.legs.reduce((count, leg) => count + (activeLegs.has(leg) ? 1 : 0), 0);
            const popularity = pair.legs.reduce((sum, leg) => sum + (legUseCount.get(leg) ?? 0), 0);
            if (
                shared > bestShared
                || (shared === bestShared && popularity > bestPopularity)
                || (shared === bestShared && popularity === bestPopularity
                    && (bestIndex === null || pair.originalIndex < pairs[bestIndex]!.originalIndex))
            ) {
                bestIndex = index;
                bestShared = shared;
                bestPopularity = popularity;
            }
        }
        if (bestIndex === null) break;
        const bestPair = pairs[bestIndex]!;
        ordered.push(bestPair);
        remaining.delete(bestIndex);
        for (const leg of bestPair.legs) touchLeg(leg);
    }

    return ordered.map((pair) => pair.symbol);
}

function roundMs(value: number): number {
    return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function roundMetric(value: number): number {
    return Number((Number.isFinite(value) ? value : 0).toFixed(4));
}

function toQualityMetrics(result: BacktestResult): FinderStrategyQualitySymbolMetrics {
    return {
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        expectancy: result.expectancy,
        winRate: result.winRate,
        profitFactor: result.profitFactor,
        totalTrades: result.totalTrades,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
        sharpeRatio: result.sharpeRatio,
        maxDrawdownPercent: result.maxDrawdownPercent,
    };
}

function classifyResult(result: BacktestResult): FinderStrategyQualitySymbolResult["status"] {
    if (result.totalTrades <= 0) return "no_trades";
    if (result.netProfit > 0.0001) return "profitable";
    if (result.netProfit < -0.0001) return "losing";
    return "flat";
}

function mean(values: readonly number[]): number {
    const finite = values.filter((value) => Number.isFinite(value));
    return finite.length > 0
        ? finite.reduce((sum, value) => sum + value, 0) / finite.length
        : 0;
}

function aggregateMetrics(
    symbols: readonly FinderStrategyQualitySymbolResult[],
    key: QualityMetricKey,
): FinderStrategyQualityResult["oos"] {
    const metrics = symbols
        .map((symbol) => symbol[key])
        .filter((result): result is FinderStrategyQualitySymbolMetrics => Boolean(result));
    const active = metrics.filter((result) => result.totalTrades > 0);
    const grossProfit = active.reduce(
        (sum, result) => sum + Math.max(0, result.avgWin) * result.winningTrades,
        0,
    );
    const grossLoss = active.reduce(
        (sum, result) => sum + Math.max(0, result.avgLoss) * result.losingTrades,
        0,
    );
    const totalTrades = active.reduce((sum, result) => sum + result.totalTrades, 0);
    const totalWins = active.reduce((sum, result) => sum + result.winningTrades, 0);
    const totalNetProfit = active.reduce((sum, result) => sum + result.netProfit, 0);
    const sharpeResults = active.filter((result) => result.totalTrades >= 5);
    return {
        activeSymbols: active.length,
        profitableSymbols: active.filter((result) => result.netProfit > 0.0001).length,
        totalTrades,
        totalNetProfit,
        averageExpectancy: mean(active.map((result) => result.expectancy)),
        profitFactor: grossLoss > 0
            ? grossProfit / grossLoss
            : grossProfit > 0
                ? Number.POSITIVE_INFINITY
                : 0,
        averageSharpe: mean(sharpeResults.map((result) => result.sharpeRatio)),
        weightedWinRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
        // These fields are only used for the in-sample aggregate below. The
        // optional OOS shape intentionally stays smaller and scalar-only.
    };
}

export function buildStrategyQualityResult(
    selected: FinderSelectedStrategy,
    symbols: readonly FinderStrategyQualitySymbolResult[],
    requestedSymbols: number,
    oosEnabled: boolean,
): FinderStrategyQualityResult {
    const metrics = symbols
        .map((symbol) => symbol.result)
        .filter((result): result is FinderStrategyQualitySymbolMetrics => Boolean(result));
    const active = metrics.filter((result) => result.totalTrades > 0);
    const grossProfit = active.reduce(
        (sum, result) => sum + Math.max(0, result.avgWin) * result.winningTrades,
        0,
    );
    const grossLoss = active.reduce(
        (sum, result) => sum + Math.max(0, result.avgLoss) * result.losingTrades,
        0,
    );
    const totalTrades = active.reduce((sum, result) => sum + result.totalTrades, 0);
    const totalWins = active.reduce((sum, result) => sum + result.winningTrades, 0);
    const sharpeResults = active.filter((result) => result.totalTrades >= 5);
    const quality: FinderStrategyQualityResult = {
        strategyKey: selected.key,
        strategyName: selected.name,
        params: selected.strategy.normalizeParams
            ? selected.strategy.normalizeParams({ ...selected.strategy.defaultParams })
            : { ...selected.strategy.defaultParams },
        symbols: [...symbols],
        requestedSymbols,
        loadedSymbols: symbols.filter((symbol) => symbol.status !== "load_failed").length,
        failedSymbols: symbols.filter((symbol) => symbol.status === "load_failed" || symbol.status === "run_failed").length,
        activeSymbols: active.length,
        profitableSymbols: active.filter((result) => result.netProfit > 0.0001).length,
        losingSymbols: active.filter((result) => result.netProfit < -0.0001).length,
        noTradeSymbols: symbols.filter((symbol) => symbol.status === "no_trades").length,
        totalTrades,
        totalNetProfit: active.reduce((sum, result) => sum + result.netProfit, 0),
        averageNetProfit: mean(active.map((result) => result.netProfit)),
        averageExpectancy: mean(active.map((result) => result.expectancy)),
        medianExpectancy: median(active.map((result) => result.expectancy)),
        averageProfitFactor: mean(active.map((result) => result.profitFactor)),
        profitFactor: grossLoss > 0
            ? grossProfit / grossLoss
            : grossProfit > 0
                ? Number.POSITIVE_INFINITY
                : 0,
        averageSharpe: mean(sharpeResults.map((result) => result.sharpeRatio)),
        sharpeAvailableSymbols: sharpeResults.length,
        weightedWinRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
        worstMaxDrawdownPercent: active.length > 0
            ? Math.max(...active.map((result) => Math.max(0, result.maxDrawdownPercent)))
            : 0,
    };

    if (oosEnabled && symbols.some((symbol) => symbol.oosResult)) {
        const oos = aggregateMetrics(symbols, "oosResult");
        quality.oos = oos;
    }
    return quality;
}

function getStrategyQualityMetricValue(
    result: FinderStrategyQualityResult,
    metric: FinderStrategyQualityMetric,
): number {
    switch (metric) {
        case 'averageExpectancy': return result.averageExpectancy;
        case 'medianExpectancy': return result.medianExpectancy;
        case 'profitFactor': return result.profitFactor;
        case 'averageProfitFactor': return result.averageProfitFactor;
        case 'averageSharpe': return result.averageSharpe;
        case 'weightedWinRate': return result.weightedWinRate;
        case 'totalNetProfit': return result.totalNetProfit;
        case 'totalTrades': return result.totalTrades;
        case 'activeSymbols': return result.activeSymbols;
        case 'activeRatio': return result.requestedSymbols > 0
            ? result.activeSymbols / result.requestedSymbols
            : 0;
        case 'profitableSymbols': return result.profitableSymbols;
        case 'profitableActiveRatio': return result.activeSymbols > 0
            ? result.profitableSymbols / result.activeSymbols
            : 0;
        case 'noTradeSymbols': return result.noTradeSymbols;
        case 'worstMaxDrawdownPercent': return result.worstMaxDrawdownPercent;
    }
}

export function sortStrategyQualityResultsByMetric(
    results: readonly FinderStrategyQualityResult[],
    metric: FinderStrategyQualityMetric,
): FinderStrategyQualityResult[] {
    const ascending = metric === 'noTradeSymbols' || metric === 'worstMaxDrawdownPercent';
    return [...results].sort((left, right) => {
        const leftValue = getStrategyQualityMetricValue(left, metric);
        const rightValue = getStrategyQualityMetricValue(right, metric);
        const safeLeft = Number.isNaN(leftValue) ? 0 : leftValue;
        const safeRight = Number.isNaN(rightValue) ? 0 : rightValue;
        if (safeLeft !== safeRight) {
            return ascending ? safeLeft - safeRight : safeRight - safeLeft;
        }
        return left.strategyName.localeCompare(right.strategyName);
    });
}

function appendRunFailure(
    row: QualityRow,
    symbol: string,
    barCount: number,
    error: unknown,
): void {
    row.symbols.push({
        symbol,
        status: "run_failed",
        barCount,
        error: error instanceof Error ? error.message : String(error),
    });
}

/**
 * Runs a single normalized default-parameter backtest per strategy and symbol.
 * Datasets are loaded in bounded batches so the audit does not retain the
 * complete universe in the browser heap.
 */
export async function runStrategyQualityAudit(
    input: FinderStrategyQualityRunInput,
): Promise<FinderStrategyQualityRunOutput> {
    const symbols = normalizeSymbols(input.symbols);
    const loadSymbols = optimizeQualitySymbolOrder(symbols);
    const rows = input.selectedStrategies.map((selected) => ({
        selected,
        symbols: [] as FinderStrategyQualitySymbolResult[],
    }));
    const oosSlice = input.oosValidationEnabled ? resolveOosDataSlice(input.dataSlice) : null;
    const oosEnabled = oosSlice !== null;
    const dataFetcher: CrossSymbolDataFetcher = {
        getProvider: input.getProvider,
        fetchDataDetached: (symbol, interval) => input.loadDataset(symbol, interval),
    };
    let loadedSymbols = 0;
    let failedSymbols = 0;
    const failedSymbolDetails: Array<{ symbol: string; error: string }> = [];
    let completedRuns = 0;
    const totalRuns = Math.max(1, symbols.length * rows.length);
    const runNowSec = Math.floor(Date.now() / 1000);
    const performanceTimings = {
        total: 0,
        providerResolution: 0,
        dataLoading: 0,
        dataPreparation: 0,
        strategyExecution: 0,
        oosExecution: 0,
        yielding: 0,
        resultReduction: 0,
    };
    const strategyStats = new Map<string, FinderStrategyQualityDiagnostics["strategyBreakdown"][number]>();
    for (const row of rows) {
        strategyStats.set(row.selected.key, {
            strategyKey: row.selected.key,
            strategyName: row.selected.name,
            runs: 0,
            failedRuns: 0,
            noTradeRuns: 0,
            totalMs: 0,
            averageMs: 0,
            signalGenerationMs: 0,
            engineMs: 0,
            rustRuns: 0,
            typescriptRuns: 0,
        });
    }
    let totalBars = 0;
    let minBars = Number.POSITIVE_INFINITY;
    let maxBars = 0;
    const slowestLoads: FinderStrategyQualityDiagnostics["slowestLoads"] = [];
    const recordLoad = (symbol: string, ms: number, bars: number): void => {
        slowestLoads.push({ symbol, ms: roundMs(ms), bars });
        slowestLoads.sort((a, b) => b.ms - a.ms);
        if (slowestLoads.length > 10) slowestLoads.length = 10;
    };
    const recordExecutorOutput = (
        stats: FinderStrategyQualityDiagnostics["strategyBreakdown"][number],
        output: Awaited<ReturnType<typeof executeBacktest>>,
    ): void => {
        if (output.engineUsed === "rust") stats.rustRuns += 1;
        else stats.typescriptRuns += 1;
        stats.signalGenerationMs += output.executorTimings?.signalGenerationMs ?? 0;
        stats.engineMs += output.executorTimings?.engineMs ?? 0;
    };
    const runStartedAt = performance.now();
    const initialDatasetCache = input.getDatasetCacheStats?.();
    const setupStartedAt = performance.now();
    const resolvedSettings = resolveExecutorBacktestSettings(input.settings, input.interval);
    await ensureConfirmationStrategiesLoaded(resolvedSettings);
    const resolvedCapital = resolveCapitalSettingsFromRaw(input.capitalSettings as unknown as Record<string, unknown>);
    performanceTimings.dataPreparation += performance.now() - setupStartedAt;

    for (let batchStart = 0; batchStart < loadSymbols.length; batchStart += QUALITY_DATA_LOAD_CONCURRENCY) {
        if (input.isCancelled()) break;
        const batchSymbols = loadSymbols.slice(batchStart, batchStart + QUALITY_DATA_LOAD_CONCURRENCY);
        const batchLoadStartedAt = performance.now();
        const loadedBatch = await Promise.all(batchSymbols.map(async (symbol) => {
            const dataLoadStartedAt = performance.now();
            try {
                const rawData = await input.loadDataset(symbol, input.interval);
                if (!Array.isArray(rawData) || rawData.length === 0) {
                    throw new Error("No candles returned.");
                }
                return {
                    symbol,
                    rawData,
                    error: null,
                    loadMs: performance.now() - dataLoadStartedAt,
                };
            } catch (error) {
                return {
                    symbol,
                    rawData: [] as OHLCVData[],
                    error: error instanceof Error ? error.message : String(error),
                    loadMs: performance.now() - dataLoadStartedAt,
                };
            }
        }));
        performanceTimings.dataLoading += performance.now() - batchLoadStartedAt;

        for (const loaded of loadedBatch) {
            if (input.isCancelled()) break;
            const { symbol, rawData, error, loadMs } = loaded;
            recordLoad(symbol, loadMs, rawData.length);
            if (error) {
                failedSymbols += 1;
                failedSymbolDetails.push({ symbol, error });
                for (const row of rows) {
                    const stats = strategyStats.get(row.selected.key)!;
                    stats.runs += 1;
                    stats.failedRuns += 1;
                    row.symbols.push({ symbol, status: "load_failed", barCount: 0, error });
                }
                completedRuns += rows.length;
                input.setProgress((completedRuns / totalRuns) * 100, `Failed to load ${symbol}`);
                continue;
            }
            loadedSymbols += 1;
            totalBars += rawData.length;
            minBars = Math.min(minBars, rawData.length);
            maxBars = Math.max(maxBars, rawData.length);

            const dataPreparationStartedAt = performance.now();
            const inSampleData = sliceFinderDataWindow(rawData, input.dataSlice);
            const oosData = oosSlice ? sliceFinderDataWindow(rawData, oosSlice) : null;
            const closedData = prepareClosedCandleData(inSampleData, input.interval, resolvedSettings, runNowSec);
            const closedOosData = oosData
                ? prepareClosedCandleData(oosData, input.interval, resolvedSettings, runNowSec)
                : null;
            performanceTimings.dataPreparation += performance.now() - dataPreparationStartedAt;

            for (const row of rows) {
                if (input.isCancelled()) break;
                if (completedRuns % QUALITY_UI_UPDATE_EVERY_RUNS === 0) {
                    input.setStatus(`Quality audit: ${row.selected.name} on ${symbol}`);
                }
                const stats = strategyStats.get(row.selected.key)!;
                stats.runs += 1;
                const strategyStartedAt = performance.now();
                try {
                    const strategyExecutionStartedAt = performance.now();
                    const output = await executeBacktest({
                        ohlcvData: inSampleData,
                        closedCandleDataOverride: closedData,
                        interval: input.interval,
                        primarySymbol: symbol,
                        strategyKey: row.selected.key,
                        strategy: row.selected.strategy,
                        strategyParams: row.selected.strategy.defaultParams,
                        backtestSettings: input.settings,
                        capitalSettings: input.capitalSettings,
                        context: {
                            blockRange: null,
                            annotatePolymarket: false,
                            engineMode: "auto",
                            nowSec: runNowSec,
                        },
                        dataFetcher,
                        preResolvedSettings: resolvedSettings,
                        preResolvedCapital: resolvedCapital,
                        backtestRunOptions: {
                            includeAdvancedAnalytics: false,
                            includeSharpeRatio: true,
                            collectExecutorTimings: true,
                            omitEquityCurve: true,
                            skipResultPostProcessing: true,
                        },
                    });
                    performanceTimings.strategyExecution += performance.now() - strategyExecutionStartedAt;
                    recordExecutorOutput(stats, output);
                    const symbolResult: FinderStrategyQualitySymbolResult = {
                        symbol,
                        status: classifyResult(output.result),
                        barCount: inSampleData.length,
                        result: toQualityMetrics(output.result),
                    };
                    if (symbolResult.status === "no_trades") stats.noTradeRuns += 1;
                    if (closedOosData && oosData) {
                        const oosExecutionStartedAt = performance.now();
                        try {
                            const oos = await executeBacktest({
                                ohlcvData: oosData,
                                closedCandleDataOverride: closedOosData,
                                interval: input.interval,
                                primarySymbol: symbol,
                                strategyKey: row.selected.key,
                                strategy: row.selected.strategy,
                                strategyParams: row.selected.strategy.defaultParams,
                                backtestSettings: input.settings,
                                capitalSettings: input.capitalSettings,
                                context: {
                                    blockRange: null,
                                    annotatePolymarket: false,
                                    engineMode: "auto",
                                    nowSec: runNowSec,
                                },
                                dataFetcher,
                                preResolvedSettings: resolvedSettings,
                                preResolvedCapital: resolvedCapital,
                                backtestRunOptions: {
                                    includeAdvancedAnalytics: false,
                                    includeSharpeRatio: true,
                                    collectExecutorTimings: true,
                                    omitEquityCurve: true,
                                    skipResultPostProcessing: true,
                                },
                            });
                            performanceTimings.oosExecution += performance.now() - oosExecutionStartedAt;
                            recordExecutorOutput(stats, oos);
                            symbolResult.oosResult = toQualityMetrics(oos.result);
                        } catch {
                            // The in-sample result remains useful when the optional
                            // complementary-window run cannot be evaluated.
                            performanceTimings.oosExecution += performance.now() - oosExecutionStartedAt;
                        }
                    }
                    row.symbols.push(symbolResult);
                } catch (error) {
                    stats.failedRuns += 1;
                    appendRunFailure(row, symbol, inSampleData.length, error);
                } finally {
                    stats.totalMs += performance.now() - strategyStartedAt;
                }
                completedRuns += 1;
                if (completedRuns % QUALITY_UI_UPDATE_EVERY_RUNS === 0 || completedRuns === totalRuns) {
                    input.setProgress(
                        (completedRuns / totalRuns) * 100,
                        `Audited ${row.selected.name} on ${symbol}`,
                    );
                }
                if (completedRuns % QUALITY_YIELD_EVERY_RUNS === 0 || completedRuns === totalRuns) {
                    const yieldStartedAt = performance.now();
                    await input.yieldControl();
                    performanceTimings.yielding += performance.now() - yieldStartedAt;
                }
            }
        }
    }

    const resultReductionStartedAt = performance.now();
    const originalSymbolOrder = new Map(symbols.map((symbol, index) => [symbol, index]));
    const results = rows.map((row) => buildStrategyQualityResult(
        row.selected,
        [...row.symbols].sort(
            (a, b) => (originalSymbolOrder.get(a.symbol) ?? Number.MAX_SAFE_INTEGER)
                - (originalSymbolOrder.get(b.symbol) ?? Number.MAX_SAFE_INTEGER),
        ),
        symbols.length,
        oosEnabled,
    ));
    performanceTimings.resultReduction = performance.now() - resultReductionStartedAt;
    performanceTimings.total = performance.now() - runStartedAt;
    for (const stats of strategyStats.values()) {
        stats.totalMs = roundMs(stats.totalMs);
        stats.averageMs = roundMs(stats.totalMs / Math.max(1, stats.runs));
        stats.signalGenerationMs = roundMs(stats.signalGenerationMs);
        stats.engineMs = roundMs(stats.engineMs);
    }
    const finalDatasetCache = input.getDatasetCacheStats?.();
    const performanceDiagnostics: FinderStrategyQualityDiagnostics = {
        requestedSymbols: symbols.length,
        loadedSymbols,
        failedSymbols,
        selectedStrategies: rows.length,
        runs: {
            planned: totalRuns,
            completed: completedRuns,
            failed: [...strategyStats.values()].reduce((sum, stats) => sum + stats.failedRuns, 0),
            noTrade: [...strategyStats.values()].reduce((sum, stats) => sum + stats.noTradeRuns, 0),
        },
        timingsMs: {
            total: roundMs(performanceTimings.total),
            providerResolution: 0,
            dataLoading: roundMs(performanceTimings.dataLoading),
            dataPreparation: roundMs(performanceTimings.dataPreparation),
            strategyExecution: roundMs(performanceTimings.strategyExecution),
            oosExecution: roundMs(performanceTimings.oosExecution),
            yielding: roundMs(performanceTimings.yielding),
            resultReduction: roundMs(performanceTimings.resultReduction),
        },
        data: {
            totalBars,
            minBars: loadedSymbols > 0 ? minBars : 0,
            maxBars,
            averageBars: loadedSymbols > 0 ? roundMetric(totalBars / loadedSymbols) : 0,
        },
        strategyBreakdown: [...strategyStats.values()].sort((a, b) => b.totalMs - a.totalMs),
        slowestLoads,
        ...(finalDatasetCache
            ? { datasetCache: getCacheDelta(initialDatasetCache, finalDatasetCache) }
            : {}),
    };

    return {
        results,
        loadedSymbols,
        failedSymbols,
        failedSymbolDetails,
        performance: performanceDiagnostics,
        cancelled: input.isCancelled(),
    };
}
