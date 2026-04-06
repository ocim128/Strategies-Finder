/**
 * Pure shared backtest executor.
 *
 * This module is the single source of truth for backtest execution. Both the
 * UI-driven path and the HTTP endpoint path should flow through here so their
 * results stay identical for the same explicit inputs.
 */

import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
} from "./types/strategies";
import { isSmartTradeSizingMode, type CapitalSettings } from "./types/backtest";
import { selectExecutionAwareClosedCandles } from "./alert-evaluation-window";
import { resolveCapitalSettingsFromRaw } from "./backtest-capital-settings";
import type { BacktestExecutionContext } from "./backtest-endpoint-contract";
import {
    buildExpectancyBreakdown,
    buildPostEntryPathStats,
    enrichPolymarketBacktestResult,
} from "./backtest-result-analysis";
import {
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw,
} from "./backtest-settings-resolver";
import { sliceOhlcvByBlock } from "./block-selector";
import { shouldUseRustEngine } from "./engine-preferences";
import { annotateBacktestResultWithPolymarketOutcomes } from "./polymarket-trade-annotations";
import { rustEngine } from "./rust-engine-client";
import { sanitizeBacktestSettingsForRust, requiresTypescriptEngine } from "./rust-settings-sanitizer";
import {
    applySignalPolarity,
    buildEntryBacktestResult,
    runBacktest,
} from "./strategies/index";
import { computeEdgeStatistics } from "./strategies/backtest/edge-statistics";
import { strategies as builtInStrategies } from "./strategies/library";
import {
    getResampleBucketStart,
    resampleOHLCV,
    type ResampleOptions,
} from "./strategies/resample-utils";
import {
    calculateAdvancedPerformanceAnalyticsFromEquityCurve,
    calculateSharpeRatioFromEquityCurve,
    calculateSharpeRatioFromReturns,
} from "./strategies/performance-metrics";
import { parseTimeToUnixSeconds } from "./time-normalization";

// ============================================================================
// Executor request / response
// ============================================================================

export interface BacktestExecutorRequest {
    ohlcvData: OHLCVData[];
    interval: string;
    strategyKey: string;
    strategy?: Strategy;
    strategyParams: StrategyParams;
    /** Raw or partially-resolved settings. The executor normalizes them. */
    backtestSettings: BacktestSettings | Record<string, unknown>;
    /** Raw or fully-resolved capital configuration. */
    capitalSettings: CapitalSettings | Record<string, unknown>;
    context: BacktestExecutionContext;
}

export interface BacktestExecutorResult {
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
}

// ============================================================================
// Pure executor
// ============================================================================

/**
 * Execute a backtest given explicit inputs.
 *
 * This function does NOT read from DOM or global state. Every execution-sensitive
 * decision (closed-candle trimming, Rust eligibility, entry-only
 * shortcut, post-processing) flows through shared helpers.
 */
export async function executeBacktest(req: BacktestExecutorRequest): Promise<BacktestExecutorResult> {
    const { ohlcvData, interval, strategyKey, strategyParams, backtestSettings, capitalSettings } = req;
    const nowSec = req.context.nowSec ?? Math.floor(Date.now() / 1000);
    const blockRange = req.context.blockRange ?? null;
    const annotatePolymarket = req.context.annotatePolymarket ?? false;
    const strategy = req.strategy ?? builtInStrategies[strategyKey];
    if (!strategy) {
        throw new Error(`Strategy not found: "${strategyKey}"`);
    }

    const normalizedParams = strategy.normalizeParams
        ? strategy.normalizeParams(strategyParams)
        : strategyParams;

    const settingsWithMeta = {
        ...(backtestSettings as Record<string, unknown>),
        interval,
    } as BacktestSettings;
    const resolvedSettings = resolveBacktestSettingsFromRaw(settingsWithMeta, {
        captureSnapshots: true,
        coerceWithoutUiToggles: true,
    });
    resolvedSettings.tradeDirection = resolvedSettings.tradeDirection ?? EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
    resolvedSettings.executionModel = resolvedSettings.executionModel ?? EFFECTIVE_BACKTEST_DEFAULTS.executionModel;

    const resolvedCapital = resolveCapitalSettingsFromRaw(capitalSettings as Record<string, unknown>);
    const backtestData = selectClosedCandleData(ohlcvData, interval, resolvedSettings, nowSec, blockRange);
    let signals = executeStrategySignals(
        backtestData,
        strategy,
        normalizedParams,
        resolvedSettings,
        hasGlobalStrategyTimeframeWrapper(strategy)
    );
    signals = filterSignalsByBlockRange(signals, blockRange);

    const evaluation = strategy.evaluate?.(backtestData, normalizedParams, signals);
    const entryStats = evaluation?.entryStats;

    if (strategy.metadata?.role === "entry" && entryStats) {
        let result = buildEntryBacktestResult(entryStats);
        finalizeResult(result, backtestData, interval, settingsWithMeta);
        if (annotatePolymarket) {
            result = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
        }
        return { result, engineUsed: "typescript" };
    }

    const requireTs = requiresTypescriptEngine(resolvedSettings) || isSmartTradeSizingMode(resolvedCapital.sizingMode);
    if (shouldAttemptRust(req.context.engineMode ?? "auto", requireTs)) {
        const rustResult = await tryRustBacktest(backtestData, signals, resolvedCapital, resolvedSettings);
        if (rustResult && isResultConsistent(rustResult)) {
            let result = rustResult;
            finalizeResult(result, backtestData, interval, settingsWithMeta);
            if (annotatePolymarket) {
                result = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
            }
            return { result, engineUsed: "rust" };
        }
    }

    let result = runBacktest(
        backtestData,
        signals,
        resolvedCapital.initialCapital,
        resolvedCapital.positionSize,
        resolvedCapital.commission,
        resolvedSettings,
        {
            mode: resolvedCapital.sizingMode,
            fixedTradeAmount: resolvedCapital.fixedTradeAmount,
            advancedSizing: resolvedCapital.advancedSizing,
        }
    );
    finalizeResult(result, backtestData, interval, settingsWithMeta);
    if (annotatePolymarket) {
        result = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
    }
    return { result, engineUsed: "typescript" };
}

/**
 * Execute a backtest from pre-generated signals. Useful for combined
 * strategy backtests, alert replay, and external signal sources.
 */
export async function executeBacktestFromSignals(
    ohlcvData: OHLCVData[],
    interval: string,
    signals: Signal[],
    settings: BacktestSettings | Record<string, unknown>,
    capitalSettings: CapitalSettings | Record<string, unknown>,
    context: BacktestExecutionContext
): Promise<BacktestExecutorResult> {
    const nowSec = context.nowSec ?? Math.floor(Date.now() / 1000);
    const blockRange = context.blockRange ?? null;
    const annotatePolymarket = context.annotatePolymarket ?? false;
    const resolvedSettings = resolveBacktestSettingsFromRaw(
        {
            ...(settings as Record<string, unknown>),
            interval,
        } as BacktestSettings,
        { captureSnapshots: true, coerceWithoutUiToggles: true }
    );
    resolvedSettings.tradeDirection = resolvedSettings.tradeDirection ?? EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
    resolvedSettings.executionModel = resolvedSettings.executionModel ?? EFFECTIVE_BACKTEST_DEFAULTS.executionModel;

    const resolvedCapital = resolveCapitalSettingsFromRaw(
        capitalSettings as Record<string, unknown>
    );

    const backtestData = selectClosedCandleData(ohlcvData, interval, resolvedSettings, nowSec, blockRange);
    // Pre-generated signal callers are expected to pass fully prepared signals.
    // Re-applying invert/polarity here changes the execution meaning.
    let filteredSignals = signals;
    filteredSignals = filterSignalsByBlockRange(filteredSignals, blockRange);

    const requireTs = requiresTypescriptEngine(resolvedSettings) || isSmartTradeSizingMode(resolvedCapital.sizingMode);
    if (shouldAttemptRust(context.engineMode ?? "auto", requireTs)) {
        const rustResult = await tryRustBacktest(
            backtestData,
            filteredSignals,
            resolvedCapital,
            resolvedSettings
        );
        if (rustResult && isResultConsistent(rustResult)) {
            let result = rustResult;
            finalizeResult(result, backtestData, interval, settings);
            if (annotatePolymarket) {
                result = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
            }
            return { result, engineUsed: "rust" };
        }
    }

    let result = runBacktest(
        backtestData,
        filteredSignals,
        resolvedCapital.initialCapital,
        resolvedCapital.positionSize,
        resolvedCapital.commission,
        resolvedSettings,
        { mode: resolvedCapital.sizingMode, fixedTradeAmount: resolvedCapital.fixedTradeAmount, advancedSizing: resolvedCapital.advancedSizing }
    );
    finalizeResult(result, backtestData, interval, settings);
    if (annotatePolymarket) {
        result = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
    }
    return { result, engineUsed: "typescript" };
}

// ============================================================================
// Internal helpers
// ============================================================================

function isBrowser(): boolean {
    return typeof document !== "undefined";
}

function shouldAttemptRust(
    engineMode: BacktestExecutionContext["engineMode"],
    requireTs: boolean
): boolean {
    if (requireTs || engineMode === "typescript") return false;
    if (engineMode === "rust_preferred") return true;
    return isBrowser() && shouldUseRustEngine();
}

function selectClosedCandleData(
    data: OHLCVData[],
    interval: string,
    settings: BacktestSettings,
    nowSec: number,
    blockRange: { from: number; to: number } | null
): OHLCVData[] {
    const executionAware = selectExecutionAwareClosedCandles(
        data,
        interval,
        settings,
        {
            nowSec,
            minClosedCandles: 1,
            fallbackToTrimmedClosed: true,
        }
    );
    const base = executionAware ?? data;
    return sliceOhlcvByBlock(base, blockRange);
}

async function tryRustBacktest(
    data: OHLCVData[],
    signals: Signal[],
    capitalSettings: CapitalSettings,
    settings: BacktestSettings
): Promise<BacktestResult | null> {
    const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = capitalSettings;
    return rustEngine.runBacktest(
        data,
        signals,
        initialCapital,
        positionSize,
        commission,
        sanitizeBacktestSettingsForRust(settings),
        { mode: sizingMode, fixedTradeAmount, advancedSizing: capitalSettings.advancedSizing }
    );
}

function finalizeResult(
    result: BacktestResult,
    backtestData: OHLCVData[],
    interval: string,
    settingsRaw: BacktestSettings | Record<string, unknown>
): void {
    const settings = settingsRaw as Record<string, unknown>;
    result.marketContext = {
        symbol: (settings.symbol as string) ?? "",
        interval: (settings.interval as string) ?? interval,
        candleCount: backtestData.length,
        firstCandleTime: backtestData[0]?.time ?? null,
        lastCandleTime: backtestData[backtestData.length - 1]?.time ?? null,
    };

    if (!result.entryStats) {
        result.sharpeRatio = recomputeSharpeRatio(result);
        result.performanceAnalytics = recomputePerformanceAnalytics(result);
    }
    result.expectancyBreakdown = buildExpectancyBreakdown(result);
    result.postEntryPath = buildPostEntryPathStats(result, 5, backtestData);
    if (result.trades.length >= 3) {
        result.edgeStatistics = computeEdgeStatistics(result, backtestData);
    }
}

async function annotatePolymarketResult(
    result: BacktestResult,
    chartData: OHLCVData[],
    settings: BacktestSettings
): Promise<BacktestResult> {
    const symbol = result.marketContext?.symbol;
    const interval = result.marketContext?.interval;
    if (!symbol || !interval) {
        return result;
    }

    try {
        return enrichPolymarketBacktestResult(
            await annotateBacktestResultWithPolymarketOutcomes(
                result,
                {
                    symbol,
                    interval,
                    executionModel: settings.executionModel,
                    chartData,
                },
                settings.polymarketEntryOffset
            )
        );
    } catch {
        return result;
    }
}

function recomputeSharpeRatio(result: BacktestResult): number {
    if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
        return calculateSharpeRatioFromEquityCurve(result.equityCurve);
    }
    if (Array.isArray(result.trades) && result.trades.length > 0) {
        return calculateSharpeRatioFromReturns(result.trades.map(t => t.pnlPercent));
    }
    return Number.isFinite(result.sharpeRatio) ? result.sharpeRatio : 0;
}

function recomputePerformanceAnalytics(result: BacktestResult) {
    if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
        return calculateAdvancedPerformanceAnalyticsFromEquityCurve(result.equityCurve);
    }
    return undefined;
}

function isResultConsistent(result: BacktestResult): boolean {
    const totalTrades = result.totalTrades;
    if (totalTrades !== result.winningTrades + result.losingTrades) return false;
    if (totalTrades <= 0) return true;

    const expectedWinRate = (result.winningTrades / totalTrades) * 100;
    if (Math.abs(expectedWinRate - result.winRate) > 1) return false;

    const expectedAvgTrade = result.netProfit / totalTrades;
    const tolerance = Math.max(0.01, Math.abs(expectedAvgTrade) * 0.15);
    if (Math.abs(expectedAvgTrade - result.avgTrade) > tolerance) return false;

    return true;
}

function filterSignalsByBlockRange<T extends { time: Signal["time"] }>(
    signals: T[],
    blockRange: { from: number; to: number } | null
): T[] {
    if (!blockRange || blockRange.from === blockRange.to) {
        return signals;
    }
    return signals.filter((signal) => {
        const time = parseTimeToUnixSeconds(signal.time);
        return time !== null && time >= blockRange.from && time <= blockRange.to;
    });
}

function hasGlobalStrategyTimeframeWrapper(strategy: Strategy): boolean {
    return (strategy as Strategy & { __global_timeframe_wrapped__?: boolean }).__global_timeframe_wrapped__ === true;
}

function toNumericTimeData(data: OHLCVData[]): OHLCVData[] | null {
    const mapped: OHLCVData[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const seconds = parseTimeToUnixSeconds(data[i].time);
        if (seconds === null) return null;
        mapped[i] = { ...data[i], time: seconds as Time };
    }
    return mapped;
}

function readStrategyTimeframeConfig(settings: BacktestSettings): {
    enabled: boolean;
    interval: string;
    resampleOptions?: ResampleOptions;
} {
    const enabled = settings.strategyTimeframeEnabled === true;
    const parsedMinutes = Number(settings.strategyTimeframeMinutes);
    const minutes = Number.isFinite(parsedMinutes) && parsedMinutes > 0
        ? Math.max(1, Math.floor(parsedMinutes))
        : 120;
    const interval = `${minutes}m`;
    const resampleOptions: ResampleOptions | undefined = undefined;
    return { enabled, interval, resampleOptions };
}

function mapSignalsFromHigherTimeframe(
    baseData: OHLCVData[],
    numericBaseData: OHLCVData[],
    higherData: OHLCVData[],
    higherSignals: Signal[],
    interval: string,
    options?: ResampleOptions
): Signal[] {
    if (higherSignals.length === 0) return [];

    const lastBaseIndexByBucket = new Map<number, number>();
    for (let i = 0; i < numericBaseData.length; i++) {
        const time = Number(numericBaseData[i].time);
        if (!Number.isFinite(time)) continue;
        const bucketStart = getResampleBucketStart(time, interval, options);
        lastBaseIndexByBucket.set(bucketStart, i);
    }

    const mapped: Signal[] = [];
    for (const signal of higherSignals) {
        let bucketStart: number | null = null;

        if (Number.isFinite(signal.barIndex)) {
            const index = Math.trunc(signal.barIndex as number);
            if (index >= 0 && index < higherData.length) {
                const timeValue = higherData[index].time;
                const seconds = typeof timeValue === "number" ? timeValue : parseTimeToUnixSeconds(timeValue);
                if (seconds !== null) {
                    bucketStart = seconds;
                }
            }
        }

        if (bucketStart === null) {
            const signalTimeSec = parseTimeToUnixSeconds(signal.time);
            if (signalTimeSec !== null) {
                bucketStart = getResampleBucketStart(signalTimeSec, interval, options);
            }
        }

        if (bucketStart === null) continue;
        const baseIndex = lastBaseIndexByBucket.get(bucketStart);
        if (baseIndex === undefined) continue;

        mapped.push({
            ...signal,
            time: baseData[baseIndex].time,
            price: baseData[baseIndex].close,
            barIndex: baseIndex,
        });
    }

    return mapped;
}

function executeStrategySignals(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    settings: BacktestSettings,
    strategyAlreadyWrapped: boolean
): Signal[] {
    if (strategyAlreadyWrapped) {
        return applySignalPolarity(strategy.execute(data, params), settings);
    }

    const tfConfig = readStrategyTimeframeConfig(settings);
    if (!tfConfig.enabled || data.length === 0) {
        return applySignalPolarity(strategy.execute(data, params), settings);
    }

    const numericData = toNumericTimeData(data);
    if (!numericData) {
        return applySignalPolarity(strategy.execute(data, params), settings);
    }

    const higherData = resampleOHLCV(numericData, tfConfig.interval, tfConfig.resampleOptions);
    if (higherData.length === 0) {
        return [];
    }

    const higherSignals = strategy.execute(higherData, params);
    const mappedSignals = mapSignalsFromHigherTimeframe(
        data,
        numericData,
        higherData,
        higherSignals,
        tfConfig.interval,
        tfConfig.resampleOptions
    );
    return applySignalPolarity(mappedSignals, settings);
}

// ============================================================================
// Strategy lookup helper for the endpoint
// ============================================================================

/**
 * Return the manifest fingerprint for external drift detection.
 */
export function getManifestFingerprint(): { strategyCount: number; strategyKeys: string[]; hash: string } {
    const keys = Object.keys(builtInStrategies).sort();
    const hashStr = keys.join(",");
    let hash = 0;
    for (let i = 0; i < hashStr.length; i++) {
        hash = ((hash << 5) - hash) + hashStr.charCodeAt(i);
        hash |= 0;
    }
    return {
        strategyCount: keys.length,
        strategyKeys: keys,
        hash: hash.toString(16),
    };
}
