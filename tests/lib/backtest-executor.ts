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
    StrategyExecutionContext,
    StrategyParams,
    Time,
    Polymarket1sRuntimeContext,
} from "./types/strategies";
import { isSmartTradeSizingMode, type CapitalSettings } from "./types/backtest";
import { selectExecutionAwareClosedCandles } from "./alert-evaluation-window";
import { resolveCapitalSettingsFromRaw } from "./backtest-capital-settings";
import type { BacktestExecutionContext } from "./backtest-endpoint-contract";
import {
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw,
} from "./backtest-settings-resolver";
import { sliceOhlcvByBlock } from "./block-selector";
import {
    resolveCrossSymbolExecution,
    resolveCrossSymbolExecutionSync,
    resolveCrossSymbolSecondaryForStrategy,
    type CrossSymbolDataFetcher,
} from "./cross-symbol-runtime";
import { shouldUseRustEngine } from "./engine-preferences";
import { rustEngine } from "./rust-engine-client";
import { sanitizeBacktestSettingsForRust, requiresTypescriptEngine } from "./rust-settings-sanitizer";
import {
    applySignalPolarity,
    buildEntryBacktestResult,
    runBacktest,
} from "./strategies/index";
import {
    ensureBuiltInStrategyLoaded,
    getBuiltInStrategyKeys,
} from "./strategies/built-in-catalog";
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
import { filterSignalsByBlockRange as filterSignalsBySelectedBlockRange } from "./signal-block-filter";
import {
    applyConfirmationStrategiesToSignals,
    ensureConfirmationStrategiesLoaded,
} from "./confirmation-signal-filter";
import { timeKey } from "./strategies/backtest/backtest-utils";
import {
    registerBacktestEdgeAnalysisInput,
    transferBacktestEdgeAnalysisInput,
} from "./backtest-edge-analysis";
import { attachTradeTimingQuality } from "./trade-timing-quality";

// ============================================================================
// Executor request / response
// ============================================================================

export interface BacktestExecutorRequest {
    ohlcvData: OHLCVData[];
    interval: string;
    /** Primary symbol name. Used for cross-symbol resolution. */
    primarySymbol?: string;
    strategyKey: string;
    strategy?: Strategy;
    strategyParams: StrategyParams;
    /** Raw or partially-resolved settings. The executor normalizes them. */
    backtestSettings: BacktestSettings | Record<string, unknown>;
    /** Raw or fully-resolved capital configuration. */
    capitalSettings: CapitalSettings | Record<string, unknown>;
    context: BacktestExecutionContext;
    /** Optional caller-supplied runtime context for strategy helpers. */
    strategyExecutionContext?: StrategyExecutionContext;
    /** Use "provided" when a caller must not augment Polymarket 1s helpers from local historical quote storage. */
    polymarket1sContextMode?: "auto" | "provided";
    dataFetcher?: CrossSymbolDataFetcher;
    secondMarketApiBaseUrl?: string;
    crossSymbolInput?: {
        secondarySymbol: string;
        secondaryData: OHLCVData[];
    };
}

export interface BacktestExecutorResult {
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
    signals: Signal[];
}

function mergeStrategyExecutionContext(
    base: StrategyExecutionContext | undefined,
    override: StrategyExecutionContext | undefined
): StrategyExecutionContext | undefined {
    if (!base) return override;
    if (!override) return base;
    return {
        ...base,
        ...override,
        crossSymbol: override.crossSymbol ?? base.crossSymbol,
        polymarket1s: override.polymarket1s ?? base.polymarket1s,
    };
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
    const strategy = req.strategy ?? await ensureBuiltInStrategyLoaded(strategyKey);
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
    const resolvedSettings = resolveExecutorBacktestSettings(settingsWithMeta, interval);
    await ensureConfirmationStrategiesLoaded(resolvedSettings);

    const resolvedCapital = resolveCapitalSettingsFromRaw(capitalSettings as Record<string, unknown>);

    // --- Cross-symbol resolution ---
    const primarySymbol = req.primarySymbol ?? (settingsWithMeta as Record<string, unknown>).symbol as string ?? "";
    const configuredSecondarySymbol = resolveCrossSymbolSecondaryForStrategy(strategy, resolvedSettings);
    if (strategy.crossSymbolConfig && !req.dataFetcher && !req.crossSymbolInput) {
        throw new Error(
            `Cross-symbol strategy "${strategy.name}" requires either a dataFetcher or explicit secondary dataset input. ` +
            'This surface does not support cross-symbol strategies.'
        );
    }
    const crossSymbolResolved = req.crossSymbolInput
        ? (() => {
            const normalizedProvidedSymbol = req.crossSymbolInput!.secondarySymbol.trim().toUpperCase();
            if (!configuredSecondarySymbol || normalizedProvidedSymbol !== configuredSecondarySymbol) {
                throw new Error(
                    `Cross-symbol secondary mismatch: request provided "${normalizedProvidedSymbol}" but strategy execution resolved "${configuredSecondarySymbol ?? ""}".`
                );
            }
            return resolveCrossSymbolExecutionSync({
                strategy,
                primarySymbol,
                primaryData: ohlcvData,
                secondarySymbol: normalizedProvidedSymbol,
                secondaryData: req.crossSymbolInput!.secondaryData,
                settings: resolvedSettings,
            });
        })()
        : req.dataFetcher
            ? await resolveCrossSymbolExecution({
                strategy,
                primarySymbol,
                interval,
                primaryData: ohlcvData,
                settings: resolvedSettings,
                dataFetcher: req.dataFetcher,
            })
            : { primaryData: ohlcvData, context: req.strategyExecutionContext } as const;
    const effectiveData = crossSymbolResolved.primaryData;
    const crossSymbolContext = mergeStrategyExecutionContext(req.strategyExecutionContext, crossSymbolResolved.context);

    const backtestData = selectClosedCandleData(effectiveData, interval, resolvedSettings, nowSec, blockRange);

    let alignedCrossSymbolContext = crossSymbolContext;
    if (alignedCrossSymbolContext?.crossSymbol && backtestData.length > 0) {
        const firstTime = backtestData[0].time;
        const lastTime = backtestData[backtestData.length - 1].time;
        const primaryData = effectiveData;
        const secondaryData = alignedCrossSymbolContext.crossSymbol.secondaryData;

        const firstKey = timeKey(firstTime);
        const lastKey = timeKey(lastTime);

        let startIndex = primaryData.findIndex(d => timeKey(d.time) === firstKey);
        if (startIndex === -1) startIndex = 0;

        let endIndex = primaryData.findIndex(d => timeKey(d.time) === lastKey);
        endIndex = endIndex === -1 ? secondaryData.length : endIndex + 1;

        alignedCrossSymbolContext = {
            ...alignedCrossSymbolContext,
            crossSymbol: {
                ...alignedCrossSymbolContext.crossSymbol,
                secondaryData: secondaryData.slice(startIndex, endIndex),
                alignedLength: backtestData.length
            }
        };
    } else if (alignedCrossSymbolContext?.crossSymbol) {
        alignedCrossSymbolContext = {
            ...alignedCrossSymbolContext,
            crossSymbol: {
                ...alignedCrossSymbolContext.crossSymbol,
                secondaryData: [],
                alignedLength: 0
            }
        };
    }

    const executionContext = await resolvePolymarket1sExecutionContext({
        strategy,
        primarySymbol,
        interval,
        data: backtestData,
        settings: resolvedSettings,
        baseContext: alignedCrossSymbolContext,
        apiBaseUrl: req.secondMarketApiBaseUrl,
        contextMode: req.polymarket1sContextMode ?? "auto",
    });

    const signals = resolveBacktestSignalsForData({
        data: backtestData,
        strategy,
        params: normalizedParams,
        settings: resolvedSettings,
        blockRange,
        executionContext,
    });

    const evaluation = strategy.evaluate?.(backtestData, normalizedParams, signals);
    const entryStats = evaluation?.entryStats;

    if (strategy.metadata?.role === "entry" && entryStats) {
        let result = buildEntryBacktestResult(entryStats);
        finalizeResult(result, backtestData, interval, settingsWithMeta);
        if (annotatePolymarket) {
            const annotatedResult = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
            transferBacktestEdgeAnalysisInput(result, annotatedResult);
            result = annotatedResult;
        }
        registerBacktestEdgeAnalysisInput(result, backtestData);
        return { result, engineUsed: "typescript", signals };
    }

    const requireTs = requiresTypescriptEngine(resolvedSettings) || isSmartTradeSizingMode(resolvedCapital.sizingMode);
    if (shouldAttemptRust(req.context.engineMode ?? "auto", requireTs)) {
        const rustResult = await tryRustBacktest(backtestData, signals, resolvedCapital, resolvedSettings);
        if (rustResult && isResultConsistent(rustResult)) {
            let result = rustResult;
            finalizeResult(result, backtestData, interval, settingsWithMeta);
            if (annotatePolymarket) {
                const annotatedResult = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
                transferBacktestEdgeAnalysisInput(result, annotatedResult);
                result = annotatedResult;
            }
            registerBacktestEdgeAnalysisInput(result, backtestData);
            return { result, engineUsed: "rust", signals };
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
        const annotatedResult = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
        transferBacktestEdgeAnalysisInput(result, annotatedResult);
        result = annotatedResult;
    }
    registerBacktestEdgeAnalysisInput(result, backtestData);
    return { result, engineUsed: "typescript", signals };
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
    const resolvedSettings = resolveExecutorBacktestSettings(settings, interval);

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
                const annotatedResult = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
                transferBacktestEdgeAnalysisInput(result, annotatedResult);
                result = annotatedResult;
            }
            registerBacktestEdgeAnalysisInput(result, backtestData);
            return { result, engineUsed: "rust", signals: filteredSignals };
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
        const annotatedResult = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
        transferBacktestEdgeAnalysisInput(result, annotatedResult);
        result = annotatedResult;
    }
    registerBacktestEdgeAnalysisInput(result, backtestData);
    return { result, engineUsed: "typescript", signals: filteredSignals };
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

function resolveExecutorBacktestSettings(
    settings: BacktestSettings | Record<string, unknown>,
    interval: string
): BacktestSettings {
    const resolvedSettings = resolveBacktestSettingsFromRaw(
        {
            ...(settings as Record<string, unknown>),
            interval,
        } as BacktestSettings,
        { coerceWithoutUiToggles: true }
    );
    resolvedSettings.tradeDirection = resolvedSettings.tradeDirection ?? EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
    resolvedSettings.executionModel = resolvedSettings.executionModel ?? EFFECTIVE_BACKTEST_DEFAULTS.executionModel;
    return resolvedSettings;
}

function resolveBacktestSignalsForData(args: {
    data: OHLCVData[];
    strategy: Strategy;
    params: StrategyParams;
    settings: BacktestSettings;
    blockRange: { from: number; to: number } | null;
    executionContext?: StrategyExecutionContext;
}): Signal[] {
    const signals = executeStrategySignals(
        args.data,
        args.strategy,
        args.params,
        args.settings,
        hasGlobalStrategyTimeframeWrapper(args.strategy),
        args.executionContext
    );
    const confirmedSignals = applyConfirmationStrategies(args.data, signals, args.settings);
    return filterSignalsByBlockRange(confirmedSignals, args.blockRange);
}

function applyConfirmationStrategies(
    data: OHLCVData[],
    baseSignals: Signal[],
    settings: BacktestSettings
): Signal[] {
    return applyConfirmationStrategiesToSignals({
        data,
        baseSignals,
        settings,
        executeStrategy: (_key, confirmationStrategy, confirmationParams) => executeStrategySignals(
            data,
            confirmationStrategy,
            confirmationParams,
            settings,
            hasGlobalStrategyTimeframeWrapper(confirmationStrategy)
        ),
    });
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

function getDataTimeRange(data: readonly OHLCVData[]): { startTs: number; endTs: number } | null {
    const times: number[] = [];
    for (const bar of data) {
        const ts = parseTimeToUnixSeconds(bar.time);
        if (ts !== null) times.push(ts);
    }
    if (times.length === 0) return null;
    return {
        startTs: Math.min(...times),
        endTs: Math.max(...times),
    };
}

function polymarket1sQuoteKey(quote: Polymarket1sRuntimeContext["quotes"][number]): string {
    return [
        quote.series_id,
        quote.symbol,
        quote.event_start_ts,
        quote.sample_ts,
    ].join("|");
}

function mergePolymarket1sRuntimeContext(
    loaded: Polymarket1sRuntimeContext,
    caller: Polymarket1sRuntimeContext | undefined
): Polymarket1sRuntimeContext {
    if (!caller) return loaded;

    const quoteByKey = new Map<string, Polymarket1sRuntimeContext["quotes"][number]>();
    for (const quote of loaded.quotes) quoteByKey.set(polymarket1sQuoteKey(quote), quote);
    for (const quote of caller.quotes) quoteByKey.set(polymarket1sQuoteKey(quote), quote);

    return {
        ...loaded,
        quotes: Array.from(quoteByKey.values()).sort((left, right) => left.sample_ts - right.sample_ts),
        gammaSnapshots: [
            ...(loaded.gammaSnapshots ?? []),
            ...(caller.gammaSnapshots ?? []),
        ],
    };
}

async function resolvePolymarket1sExecutionContext(args: {
    strategy: Strategy;
    primarySymbol: string;
    interval: string;
    data: OHLCVData[];
    settings: BacktestSettings;
    baseContext?: StrategyExecutionContext;
    apiBaseUrl?: string;
    contextMode: "auto" | "provided";
}): Promise<StrategyExecutionContext | undefined> {
    const config = args.strategy.polymarket1sConfig;
    if (!config) return args.baseContext;
    const callerPolymarketContext = args.baseContext?.polymarket1s;

    if (args.settings.strategyTimeframeEnabled) {
        throw new Error(
            `"${args.strategy.name}" uses 1s Polymarket context and cannot be run with Strategy Timeframe enabled.`
        );
    }

    if (args.contextMode === "provided") {
        return args.baseContext;
    }

    const { isSecondMarketPolymarketSupported, loadSecondMarketEvaluationContext } = await import("./second-market/evaluation");
    if (!isSecondMarketPolymarketSupported(args.primarySymbol, args.interval)) {
        if (config.required) {
            throw new Error(`"${args.strategy.name}" requires a supported 1s Polymarket chart context.`);
        }
        return args.baseContext;
    }

    const range = getDataTimeRange(args.data);
    if (!range) return args.baseContext;

    let context: Awaited<ReturnType<typeof loadSecondMarketEvaluationContext>>;
    try {
        context = await loadSecondMarketEvaluationContext({
            symbol: args.primarySymbol,
            outcomeSymbol: args.settings.polymarketOutcomeSymbol,
            outcomeInterval: args.settings.polymarketOutcomeInterval,
            startTs: range.startTs - 300,
            endTs: range.endTs + 300,
            apiBaseUrl: args.apiBaseUrl,
        });
    } catch (error) {
        if (callerPolymarketContext && callerPolymarketContext.quotes.length > 0) {
            return args.baseContext;
        }
        if (config.required) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`"${args.strategy.name}" could not load 1s Polymarket context. ${detail}`);
        }
        return args.baseContext;
    }

    if (!context) {
        if (callerPolymarketContext && callerPolymarketContext.quotes.length > 0) {
            return args.baseContext;
        }
        if (config.required) {
            throw new Error(`"${args.strategy.name}" could not load 1s Polymarket context.`);
        }
        return args.baseContext;
    }

    const polymarket1s = mergePolymarket1sRuntimeContext({
        symbol: context.symbol,
        outcomeSymbol: context.outcomeSymbol,
        seriesId: context.seriesId,
        outcomeInterval: context.outcomeInterval,
        quotes: context.quotes,
        gammaSnapshots: context.gammaSnapshots,
    }, callerPolymarketContext);

    return {
        ...(args.baseContext ?? {}),
        polymarket1s,
    };
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
    attachTradeTimingQuality(result, backtestData);
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
        const { annotateBacktestResultWithPolymarketOutcomes } = await import("./polymarket-trade-annotations");
        return await annotateBacktestResultWithPolymarketOutcomes(result, {
            symbol,
            interval,
            executionModel: settings.executionModel,
            chartData,
            outcomeSymbol: settings.polymarketOutcomeSymbol,
            // The shared executor does not load same-event price points, so
            // endpoint/executor annotation stays on resolve_hold.
            polymarketExitMode: "resolve_hold",
        }, {
            selectedOffset: settings.polymarketEntryOffset,
            entrySelectionMode: settings.polymarketEntrySelectionMode,
            entryPriceFilterCents: settings.polymarketEntryPriceFilterCents,
        });
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
    return filterSignalsBySelectedBlockRange(signals, blockRange);
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
    strategyAlreadyWrapped: boolean,
    crossSymbolContext?: StrategyExecutionContext
): Signal[] {
    if (strategyAlreadyWrapped) {
        return applySignalPolarity(strategy.execute(data, params, crossSymbolContext), settings);
    }

    const tfConfig = readStrategyTimeframeConfig(settings);
    if (!tfConfig.enabled || data.length === 0) {
        return applySignalPolarity(strategy.execute(data, params, crossSymbolContext), settings);
    }

    const numericData = toNumericTimeData(data);
    if (!numericData) {
        return applySignalPolarity(strategy.execute(data, params, crossSymbolContext), settings);
    }

    const higherData = resampleOHLCV(numericData, tfConfig.interval, tfConfig.resampleOptions);
    if (higherData.length === 0) {
        return [];
    }

    // Cross-symbol and Polymarket-1s context combinations with Strategy Timeframe
    // are rejected before this point; keep the context argument here so helper
    // strategies cannot silently lose their runtime context if another caller
    // reaches this path.
    const higherSignals = strategy.execute(higherData, params, crossSymbolContext);
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
    const keys = [...getBuiltInStrategyKeys()].sort();
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
