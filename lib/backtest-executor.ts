/**
 * Pure shared backtest executor.
 *
 * This module is the single source of truth for backtest execution. Both the
 * UI-driven path and the HTTP endpoint path should flow through here so their
 * results stay identical for the same explicit inputs.
 */

import type {
    BacktestExitControlDiagnostics,
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyExecutionContext,
    StrategyParams,
    Polymarket1sRuntimeContext,
} from "./types/strategies";
import { isRustSupportedTradeSizingMode, type CapitalSettings } from "./types/backtest";
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
import {
    hasUnsupportedRustSignalShape,
    rustEngine,
    type RustBacktestFailureReason,
    type RustCapabilities,
    type RustOutputOptions,
} from "./rust-engine-client";
import { validateRustBacktestResult } from "./rust-backtest-result-validator";
import {
    getTypescriptEngineRequirementReasons,
    getRequiredRustCapabilities,
    sanitizeBacktestSettingsForRust,
} from "./rust-settings-sanitizer";
import { mergeExitStrategySignals } from "./exit-strategy-merge";
import {
    buildEntryBacktestResult,
    createEmptyBacktestResult,
    runBacktest,
    runBacktestCompact,
} from "./strategies/index";
import type {
    BacktestEndpointSelection,
    BacktestResultWithEndpointSelection,
} from "./strategies/backtest/backtest-engine";
import {
    ensureBuiltInStrategyLoaded,
    getBuiltInStrategyKeys,
} from "./strategies/built-in-catalog";
import {
    calculateAdvancedPerformanceAnalyticsFromEquityCurve,
    calculateSharpeRatioFromEquityCurve,
    calculateSharpeRatioFromReturns,
} from "./strategies/performance-metrics";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { filterSignalsByBlockRange } from "./signal-block-filter";
import {
    applyConfirmationStrategiesToSignals,
    ensureConfirmationStrategiesLoaded,
} from "./confirmation-signal-filter";
import { executeBacktestStrategySignals } from "./strategy-signal-execution";
import {
    allowsSignalAsEntry,
    normalizeTradeDirection,
    timeKey,
} from "./strategies/backtest/backtest-utils";
import {
    registerBacktestEdgeAnalysisInput,
    transferBacktestEdgeAnalysisInput,
} from "./backtest-edge-analysis";
import { attachTradeTimingQuality } from "./trade-timing-quality";
import { resolveBinanceMarketType } from "./binance-market";

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
    /** Optional low-level run controls for bulk research callers that do not need full chart artifacts. */
    backtestRunOptions?: {
        includeAdvancedAnalytics?: boolean;
        includeSharpeRatio?: boolean;
        collectDiagnostics?: boolean;
        collectExecutorTimings?: boolean;
        useCompactBacktest?: boolean;
        omitEquityCurve?: boolean;
        skipDrawdown?: boolean;
        requireTradeHistory?: boolean;
        endpointSelectionLastDataTime?: OHLCVData["time"] | null;
        endpointSelectionInitialCapital?: number;
        /** Generate signals without running trade simulation. */
        signalsOnly?: boolean;
        skipResultPostProcessing?: boolean;
        /** Internal Finder control-run option; applied after settings normalization. */
        forceDisableSignalExits?: boolean;
        /** Skip trade simulation when primary signals cannot reach this entry count. */
        minimumPotentialEntrySignals?: number;
        /** Server-side Batch entry gate. */
        tradeGate?: import("./batch-backtest/trade-gate").TradeGate;
        /** Pair key used to select the gate's causal feature context. */
        tradeGatePair?: string;
    };
    dataFetcher?: CrossSymbolDataFetcher;
    crossSymbolInput?: {
        secondarySymbol: string;
        secondaryData: OHLCVData[];
    };
    /** Pre-computed closed candle data. When provided, skips selectClosedCandleData internally. */
    closedCandleDataOverride?: OHLCVData[];
    /** Pre-resolved backtest settings. When provided, skips resolveExecutorBacktestSettings. */
    preResolvedSettings?: BacktestSettings;
    /** Pre-resolved capital settings. When provided, skips resolveCapitalSettingsFromRaw. */
    preResolvedCapital?: ReturnType<typeof resolveCapitalSettingsFromRaw>;
    /** Fully prepared primary signals; skips strategy signal generation. */
    preGeneratedSignals?: Signal[];
    /**
     * Per-run cache for deterministic Exit Strategy Override signals. The
     * cache is keyed by candle-window fingerprint and resolved exit
     * parameters, so callers can reuse the same exit series across candidate
     * replays even when each caller owns a sliced array instance.
     */
    exitSignalCache?: BacktestExitSignalCache;
}

export type BacktestExitSignalCache = Map<string, Map<string, Signal[]>>;

export interface BacktestExecutorTimings {
    signalGenerationMs: number;
    exitProcessingMs: number;
    exitStrategyMs: number;
    exitStrategyLoadMs: number;
    exitStrategyNormalizeMs: number;
    exitSignalGenerationMs: number;
    exitMergeMs: number;
    exitBookkeepingMs: number;
    exitOverrideSignals: number;
    engineMs: number;
}

export interface BacktestExecutorResult {
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
    signals: Signal[];
    /** Explains why this execution did or did not reach the Rust backend. */
    engineDiagnostics?: {
        rustAttempted: boolean;
        typescriptReason?: string;
    };
    executorTimings?: BacktestExecutorTimings;
    endpointSelection?: BacktestEndpointSelection;
}

interface ExitStrategyOverrideSignalResolution {
    signals: Signal[];
    strategyLoaded: boolean;
    skippedReason?: string;
    timings: {
        loadMs: number;
        normalizeMs: number;
        signalGenerationMs: number;
    };
}

function buildExitSignalCacheKey(args: {
    interval: string;
    exitKey: string;
    exitParams: StrategyParams;
    settings: BacktestSettings;
}): string {
    return JSON.stringify([
        args.interval,
        args.exitKey,
        args.exitParams,
        args.settings.tradeDirection,
        args.settings.invertSignals === true,
    ]);
}

function buildExitSignalDataCacheKey(data: OHLCVData[]): string {
    const first = data[0]?.time;
    const last = data[data.length - 1]?.time;
    return JSON.stringify([
        data.length,
        first === undefined ? null : timeKey(first),
        last === undefined ? null : timeKey(last),
    ]);
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
    throwIfBacktestCancelled(req.context.signal);
    const executorTimings = req.backtestRunOptions?.collectExecutorTimings === true
        ? {
            signalGenerationMs: 0,
            exitProcessingMs: 0,
            exitStrategyMs: 0,
            exitStrategyLoadMs: 0,
            exitStrategyNormalizeMs: 0,
            exitSignalGenerationMs: 0,
            exitMergeMs: 0,
            exitBookkeepingMs: 0,
            exitOverrideSignals: 0,
            engineMs: 0,
        }
        : undefined;
    const finish = (
        result: BacktestResult,
        engineUsed: "rust" | "typescript",
        signals: Signal[],
        engineDiagnostics: BacktestExecutorResult["engineDiagnostics"],
        endpointSelection?: BacktestEndpointSelection,
    ): BacktestExecutorResult => ({
        result,
        engineUsed,
        signals,
        ...(engineDiagnostics ? { engineDiagnostics } : {}),
        ...(endpointSelection ? { endpointSelection } : {}),
        ...(executorTimings ? { executorTimings: { ...executorTimings } } : {}),
    });
    const { ohlcvData, interval, strategyKey, strategyParams, backtestSettings, capitalSettings } = req;
    if (req.context.tradeGate && isBrowser()) {
        throw new Error("Trade Gate is server-side only; run it through the Batch server route.");
    }
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
    const resolvedSettings = req.preResolvedSettings ?? resolveExecutorBacktestSettings(settingsWithMeta, interval);
    if (!req.preResolvedSettings) {
        await ensureConfirmationStrategiesLoaded(resolvedSettings);
    }

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

    const backtestData = req.closedCandleDataOverride
        ?? selectClosedCandleData(effectiveData, interval, resolvedSettings, nowSec, blockRange);

    // Asset Opportunity's next-bar fresh-entry pass only needs the generated
    // signals. Avoid the remaining context-alignment/Polymarket/exit
    // resolution setup when none of those execution features can affect that
    // signal-only result.
    // Keep this deliberately narrow; the regular path remains authoritative
    // for confirmation, custom execution context, and all exit-aware runs.
    if (
        req.backtestRunOptions?.signalsOnly === true
        && !req.dataFetcher
        && !req.crossSymbolInput
        && !strategy.crossSymbolConfig
        && !strategy.polymarket1sConfig
        && !req.strategyExecutionContext
        && !(resolvedSettings.confirmationStrategies?.length)
        && resolvedSettings.exitStrategyOverrideEnabled !== true
    ) {
        const signals = req.preGeneratedSignals
            ? filterSignalsByBlockRange(req.preGeneratedSignals, blockRange)
            : resolveBacktestSignalsForData({
                data: backtestData,
                interval,
                strategy,
                params: normalizedParams,
                settings: resolvedSettings,
                blockRange,
            });
        const result = createEmptyBacktestResult();
        result.exitControlDiagnostics = buildExitControlDiagnostics({
            requestedSettings: backtestSettings as Record<string, unknown>,
            resolvedSettings,
            primarySignals: signals.length,
            exitOverrideSignals: 0,
            mergedSignals: signals,
            mergedExitOnlySignals: 0,
            exitStrategyLoaded: false,
            skippedReason: "override_disabled",
        });
        registerBacktestEdgeAnalysisInput(result, backtestData);
        return finish(result, "typescript", signals, {
            rustAttempted: false,
            typescriptReason: "signal-only execution",
        });
    }

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
        contextMode: req.polymarket1sContextMode ?? "auto",
    });

    const signalGenerationStartedAt = executorTimings ? performance.now() : 0;
    const signals = req.preGeneratedSignals
        ? filterSignalsByBlockRange(req.preGeneratedSignals, blockRange)
        : resolveBacktestSignalsForData({
            data: backtestData,
            interval,
            strategy,
            params: normalizedParams,
            settings: resolvedSettings,
            blockRange,
            executionContext,
        });
    if (executorTimings) {
        executorTimings.signalGenerationMs += performance.now() - signalGenerationStartedAt;
    }

    const exitStrategyStartedAt = executorTimings ? performance.now() : 0;
    const primarySignals = req.backtestRunOptions?.forceDisableSignalExits === true
        ? signals.filter((signal) => signal.exitOnly !== true)
        : signals;

    const minimumPotentialEntrySignals = req.backtestRunOptions?.minimumPotentialEntrySignals;
    if (typeof minimumPotentialEntrySignals === "number"
        && Number.isFinite(minimumPotentialEntrySignals)
        && minimumPotentialEntrySignals > 0) {
        const tradeDirection = normalizeTradeDirection(resolvedSettings);
        let potentialEntrySignals = 0;
        for (const signal of primarySignals) {
            if (allowsSignalAsEntry(signal.type, tradeDirection)) potentialEntrySignals += 1;
        }
        if (potentialEntrySignals < minimumPotentialEntrySignals) {
            const result = createEmptyBacktestResult();
            result.exitControlDiagnostics = buildExitControlDiagnostics({
                requestedSettings: backtestSettings as Record<string, unknown>,
                resolvedSettings,
                primarySignals: primarySignals.length,
                exitOverrideSignals: 0,
                mergedSignals: primarySignals,
                mergedExitOnlySignals: 0,
                exitStrategyLoaded: false,
                skippedReason: "minimum_potential_entry_signals",
            });
            registerBacktestEdgeAnalysisInput(result, backtestData);
            return finish(result, "typescript", primarySignals, {
                rustAttempted: false,
                typescriptReason: "minimum potential entry signals not reached",
            });
        }
    }

    const exitOverrideResolution = await resolveExitStrategyOverrideSignals({
        data: backtestData,
        interval,
        settings: resolvedSettings,
        blockRange,
        executionContext,
        forceDisableSignalExits: req.backtestRunOptions?.forceDisableSignalExits === true,
        collectTimings: executorTimings !== undefined,
        exitSignalCache: req.exitSignalCache,
    });
    if (executorTimings) {
        const elapsed = performance.now() - exitStrategyStartedAt;
        executorTimings.exitStrategyMs += elapsed;
        executorTimings.exitProcessingMs += elapsed;
        executorTimings.exitStrategyLoadMs += exitOverrideResolution.timings.loadMs;
        executorTimings.exitStrategyNormalizeMs += exitOverrideResolution.timings.normalizeMs;
        executorTimings.exitSignalGenerationMs += exitOverrideResolution.timings.signalGenerationMs;
    }
    const exitOverrideSignals = exitOverrideResolution.signals;
    if (executorTimings) {
        executorTimings.exitOverrideSignals += exitOverrideSignals.length;
    }
    const exitMergeStartedAt = executorTimings ? performance.now() : 0;
    const mergedSignals = mergeExitStrategySignals(primarySignals, exitOverrideSignals);
    if (executorTimings) {
        const elapsed = performance.now() - exitMergeStartedAt;
        executorTimings.exitMergeMs += elapsed;
        executorTimings.exitProcessingMs += elapsed;
    }
    const exitBookkeepingStartedAt = executorTimings ? performance.now() : 0;
    const exitControlDiagnostics = buildExitControlDiagnostics({
        requestedSettings: backtestSettings as Record<string, unknown>,
        resolvedSettings,
        primarySignals: primarySignals.length,
        exitOverrideSignals: exitOverrideSignals.length,
        mergedSignals,
        mergedExitOnlySignals: exitOverrideSignals.length,
        exitStrategyLoaded: exitOverrideResolution.strategyLoaded,
        skippedReason: exitOverrideResolution.skippedReason,
    });
    if (executorTimings) {
        const elapsed = performance.now() - exitBookkeepingStartedAt;
        executorTimings.exitBookkeepingMs += elapsed;
        executorTimings.exitProcessingMs += elapsed;
    }

    if (req.backtestRunOptions?.signalsOnly === true) {
        const result = createEmptyBacktestResult();
        result.exitControlDiagnostics = exitControlDiagnostics;
        registerBacktestEdgeAnalysisInput(result, backtestData);
        return finish(result, "typescript", primarySignals, {
            rustAttempted: false,
            typescriptReason: "signal-only execution",
        });
    }

    const evaluation = strategy.evaluate?.(backtestData, normalizedParams, signals);
    const entryStats = evaluation?.entryStats;

    if (strategy.metadata?.role === "entry" && entryStats) {
        const engineStartedAt = executorTimings ? performance.now() : 0;
        let result = buildEntryBacktestResult(entryStats);
        if (executorTimings) executorTimings.engineMs += performance.now() - engineStartedAt;
        result.exitControlDiagnostics = exitControlDiagnostics;
        if (!shouldSkipResultPostProcessing(req)) {
            finalizeResult(result, backtestData, interval, settingsWithMeta);
        }
        if (annotatePolymarket) {
            const annotatedResult = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
            annotatedResult.exitControlDiagnostics = exitControlDiagnostics;
            transferBacktestEdgeAnalysisInput(result, annotatedResult);
            result = annotatedResult;
        }
        registerBacktestEdgeAnalysisInput(result, backtestData);
        return finish(result, "typescript", signals, {
            rustAttempted: false,
            typescriptReason: "entry strategy uses direct evaluation",
        });
    }

    if (signals.length === 0 && mergedSignals.length === 0 && shouldSkipResultPostProcessing(req)) {
        const engineStartedAt = executorTimings ? performance.now() : 0;
        const result = createEmptyBacktestResult();
        if (executorTimings) executorTimings.engineMs += performance.now() - engineStartedAt;
        result.exitControlDiagnostics = exitControlDiagnostics;
        registerBacktestEdgeAnalysisInput(result, backtestData);
        return finish(result, "typescript", signals, {
            rustAttempted: false,
            typescriptReason: "no signals required trade simulation",
        });
    }

    const resolvedCapital = req.preResolvedCapital ?? resolveCapitalSettingsFromRaw(capitalSettings as Record<string, unknown>);

    let rustCapabilities = req.context.rustCapabilities;
    let rustHealthUnavailable = false;
    const signalShapeUnsupported = hasUnsupportedRustSignalShape(mergedSignals);
    const requiredRustCapabilities = getRequiredRustCapabilities(resolvedSettings);
    if (!signalShapeUnsupported
        && !rustCapabilities
        && requiredRustCapabilities.length > 0
        && shouldAttemptRust(req.context.engineMode ?? "auto", false, req.context.useRustEnginePreference)) {
        if (await rustEngine.checkHealth(req.context.signal)) {
            rustCapabilities = rustEngine.capabilities;
        } else if (!req.context.signal?.aborted) {
            rustHealthUnavailable = true;
        }
    }
    throwIfBacktestCancelled(req.context.signal);
    const typescriptRequirementReasons = getTypescriptEngineRequirementReasons(resolvedSettings, rustCapabilities);
    if (rustHealthUnavailable) typescriptRequirementReasons.unshift("health_unavailable");
    if (signalShapeUnsupported) typescriptRequirementReasons.push("signal_shape_unsupported");
    if (req.backtestRunOptions?.forceDisableSignalExits === true) {
        typescriptRequirementReasons.push("Exit Alpha control run requires TypeScript");
    }
    if (req.context.tradeGate) {
        typescriptRequirementReasons.push("Trade Gate requires TypeScript");
    }
    if (!isRustSupportedTradeSizingMode(resolvedCapital.sizingMode)) {
        typescriptRequirementReasons.push(`${resolvedCapital.sizingMode} position sizing requires TypeScript`);
    }
    const requireTs = typescriptRequirementReasons.length > 0;
    const rustAttempted = shouldAttemptRust(
        req.context.engineMode ?? "auto",
        requireTs,
        req.context.useRustEnginePreference,
    );
    let rustFailureReason: RustBacktestFailureReason | undefined;
    if (rustAttempted) {
        const engineStartedAt = executorTimings ? performance.now() : 0;
        const rustResult = await tryRustBacktest(
            backtestData,
            mergedSignals,
            resolvedCapital,
            resolvedSettings,
            {
                compact: shouldUseCompactBacktest(req),
                retainTrades: req.backtestRunOptions?.requireTradeHistory === true,
                skipDrawdown: req.backtestRunOptions?.skipDrawdown === true,
                skipSharpeRatio: req.backtestRunOptions?.includeSharpeRatio === false,
            },
            rustCapabilities,
            req.context.signal,
            req.context.rustDiagnosticPhase,
        );
        if (executorTimings) executorTimings.engineMs += performance.now() - engineStartedAt;
        throwIfBacktestCancelled(req.context.signal);
        if (rustResult.result && isResultConsistent(rustResult.result)) {
            let result = rustResult.result;
            result.exitControlDiagnostics = exitControlDiagnostics;
            if (!shouldSkipResultPostProcessing(req)) {
                finalizeResult(result, backtestData, interval, settingsWithMeta);
            }
            if (annotatePolymarket) {
                const annotatedResult = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
                transferBacktestEdgeAnalysisInput(result, annotatedResult);
                result = annotatedResult;
            }
            registerBacktestEdgeAnalysisInput(result, backtestData);
            return finish(result, "rust", primarySignals, { rustAttempted: true });
        }
        if (rustResult.reason === "cancelled") throwBacktestCancelled();
        rustFailureReason = rustResult.result ? "inconsistent_result" : rustResult.reason;
    }

    const runBacktestImpl = shouldUseCompactBacktest(req)
        ? runBacktestCompact
        : runBacktest;
    const engineStartedAt = executorTimings ? performance.now() : 0;
    const runTypescriptBacktest = (): BacktestResult => {
        req.context.typescriptSimulationConcurrency?.enter();
        try {
            return runBacktestImpl(
                backtestData,
                mergedSignals,
                resolvedCapital.initialCapital,
                resolvedCapital.positionSize,
                resolvedCapital.commission,
                resolvedSettings,
                {
                    mode: resolvedCapital.sizingMode,
                    fixedTradeAmount: resolvedCapital.fixedTradeAmount,
                    advancedSizing: resolvedCapital.advancedSizing,
                },
                undefined,
                req.context.tradeGate
                    ? {
                        ...(req.backtestRunOptions ?? {}),
                        tradeGate: req.context.tradeGate,
                        tradeGatePair: req.primarySymbol,
                    }
                    : req.backtestRunOptions
            );
        } finally {
            req.context.typescriptSimulationConcurrency?.leave();
        }
    };
    let result = runTypescriptBacktest();
    throwIfBacktestCancelled(req.context.signal);
    const endpointSelection = (result as BacktestResultWithEndpointSelection).endpointSelection;
    if (endpointSelection) {
        delete (result as BacktestResultWithEndpointSelection).endpointSelection;
    }
    if (executorTimings) executorTimings.engineMs += performance.now() - engineStartedAt;
    if (!shouldSkipResultPostProcessing(req)) {
        finalizeResult(result, backtestData, interval, settingsWithMeta);
    }
    result.exitControlDiagnostics = exitControlDiagnostics;
    if (annotatePolymarket) {
        const annotatedResult = await annotatePolymarketResult(result, ohlcvData, resolvedSettings);
        annotatedResult.exitControlDiagnostics = exitControlDiagnostics;
        transferBacktestEdgeAnalysisInput(result, annotatedResult);
        result = annotatedResult;
    }
    registerBacktestEdgeAnalysisInput(result, backtestData);
    const typescriptReason = rustAttempted
        ? rustFailureReason ?? "Rust backend was unavailable or rejected the result"
        : typescriptRequirementReasons[0]
            ?? "Rust was not requested";
    return finish(result, "typescript", primarySignals, {
        rustAttempted,
        typescriptReason,
    }, endpointSelection);
}

/**
 * Pre-computes closed-candle-trimmed data for a symbol. When the result is passed
 * as `closedCandleDataOverride` to `executeBacktest`, it skips the internal
 * `selectClosedCandleData` call AND stabilizes the array reference for WeakMap
 * caches (prepared data, precomputed indicators) across multiple paramSet runs
 * on the same symbol.
 */
export function prepareClosedCandleData(
    data: OHLCVData[],
    interval: string,
    settings: BacktestSettings | Record<string, unknown>,
    nowSec?: number,
): OHLCVData[] {
    const settingsWithMeta = { ...(settings as Record<string, unknown>), interval } as BacktestSettings;
    const resolvedSettings = resolveExecutorBacktestSettings(settingsWithMeta, interval);
    return selectClosedCandleData(data, interval, resolvedSettings, nowSec ?? Math.floor(Date.now() / 1000), null);
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
    throwIfBacktestCancelled(context.signal);
    if (context.tradeGate) {
        throw new Error("Trade Gate is supported only by the Batch server route.");
    }
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

    let rustCapabilities = context.rustCapabilities;
    let rustHealthUnavailable = false;
    const signalShapeUnsupported = hasUnsupportedRustSignalShape(filteredSignals);
    const requiredRustCapabilities = getRequiredRustCapabilities(resolvedSettings);
    if (!signalShapeUnsupported
        && !rustCapabilities
        && requiredRustCapabilities.length > 0
        && shouldAttemptRust(context.engineMode ?? "auto", false, context.useRustEnginePreference)) {
        if (await rustEngine.checkHealth(context.signal)) {
            rustCapabilities = rustEngine.capabilities;
        } else if (!context.signal?.aborted) {
            rustHealthUnavailable = true;
        }
    }
    throwIfBacktestCancelled(context.signal);
    const typescriptRequirementReasons = getTypescriptEngineRequirementReasons(resolvedSettings, rustCapabilities);
    if (rustHealthUnavailable) typescriptRequirementReasons.unshift("health_unavailable");
    if (signalShapeUnsupported) typescriptRequirementReasons.push("signal_shape_unsupported");
    const requireTs = typescriptRequirementReasons.length > 0
        || !isRustSupportedTradeSizingMode(resolvedCapital.sizingMode);
    if (shouldAttemptRust(context.engineMode ?? "auto", requireTs, context.useRustEnginePreference)) {
        const rustResult = await tryRustBacktest(
            backtestData,
            filteredSignals,
            resolvedCapital,
            resolvedSettings,
            undefined,
            rustCapabilities,
            context.signal,
            context.rustDiagnosticPhase,
        );
        throwIfBacktestCancelled(context.signal);
        if (rustResult.reason === "cancelled") throwBacktestCancelled();
        if (rustResult.result && isResultConsistent(rustResult.result)) {
            let result = rustResult.result;
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

    const runTypescriptBacktest = (): BacktestResult => {
        context.typescriptSimulationConcurrency?.enter();
        try {
            return runBacktest(
                backtestData,
                filteredSignals,
                resolvedCapital.initialCapital,
                resolvedCapital.positionSize,
                resolvedCapital.commission,
                resolvedSettings,
                { mode: resolvedCapital.sizingMode, fixedTradeAmount: resolvedCapital.fixedTradeAmount, advancedSizing: resolvedCapital.advancedSizing }
            );
        } finally {
            context.typescriptSimulationConcurrency?.leave();
        }
    };
    let result = runTypescriptBacktest();
    throwIfBacktestCancelled(context.signal);
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

function shouldSkipResultPostProcessing(req: BacktestExecutorRequest): boolean {
    return req.backtestRunOptions?.skipResultPostProcessing === true
        && req.context.annotatePolymarket !== true;
}

function shouldUseCompactBacktest(req: BacktestExecutorRequest): boolean {
    if (typeof req.backtestRunOptions?.useCompactBacktest === "boolean") {
        return req.backtestRunOptions.useCompactBacktest;
    }
    return shouldSkipResultPostProcessing(req)
        && req.backtestRunOptions?.omitEquityCurve === true
        && typeof req.backtestRunOptions.includeSharpeRatio === "boolean";
}

function isBrowser(): boolean {
    return typeof document !== "undefined";
}

/**
 * Decide whether to attempt the Rust engine for this run.
 *
 * Browser path: read the DOM toggle (`shouldUseRustEngine`). The
 * `useRustEnginePreference` argument is ignored so an HTTP/worker caller that
 * also runs in a browser tab never accidentally overrides the user's toggle.
 *
 * Node path (server-side Batch Backtest plugin, etc.): there is no DOM, so the
 * toggle is unreadable. An explicit `useRustEnginePreference === true` from the
 * caller (mirroring the user's UI toggle via the request context) opts in. This
 * is the fix for the "Rust silently skipped server-side" trap: without it, a
 * user who runs Rust in browser mode would see a silent perf regression the
 * moment they switch to server-side mode.
 */
function shouldAttemptRust(
    engineMode: BacktestExecutionContext["engineMode"],
    requireTs: boolean,
    useRustEnginePreference?: boolean
): boolean {
    if (requireTs || engineMode === "typescript") return false;
    if (engineMode === "rust_preferred") return true;
    if (isBrowser()) return shouldUseRustEngine();
    return useRustEnginePreference === true;
}

export function resolveExecutorBacktestSettings(
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
    interval: string;
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
        args.interval,
        hasGlobalStrategyTimeframeWrapper(args.strategy),
        args.executionContext
    );
    const confirmedSignals = applyConfirmationStrategies(args.data, args.interval, signals, args.settings);
    return filterSignalsByBlockRange(confirmedSignals, args.blockRange);
}

/**
 * Generates close-only exit signals from the configured Exit Strategy Override, when active.
 * Returns an empty array when the override is off, when disableSignalExits is off (inert),
 * or when the configured strategy key cannot be resolved.
 *
 * Returned signals are NOT tagged here; mergeExitStrategySignals tags them exitOnly.
 *
 * Exported for the trade-ledger as-if engine (trade-ledger-asif.ts): the per-pair
 * exit-signal series must come from THIS resolution — the same one a real run
 * performs — never from a parallel reimplementation.
 */
export async function resolveExitStrategyOverrideSignals(args: {
    data: OHLCVData[];
    interval: string;
    settings: BacktestSettings;
    blockRange: { from: number; to: number } | null;
    executionContext?: StrategyExecutionContext;
    forceDisableSignalExits?: boolean;
    collectTimings?: boolean;
    exitSignalCache?: BacktestExitSignalCache;
}): Promise<ExitStrategyOverrideSignalResolution> {
    const timings = {
        loadMs: 0,
        normalizeMs: 0,
        signalGenerationMs: 0,
    };
    if (!args.settings.exitStrategyOverrideEnabled) {
        return { signals: [], strategyLoaded: false, skippedReason: "override_disabled", timings };
    }
    if (args.forceDisableSignalExits === true) {
        return { signals: [], strategyLoaded: false, skippedReason: "forced_control_run", timings };
    }
    if (!args.settings.disableSignalExits) {
        return { signals: [], strategyLoaded: false, skippedReason: "disable_signal_exits_off", timings };
    }
    const exitKey = typeof args.settings.exitStrategyKey === "string"
        ? args.settings.exitStrategyKey.trim()
        : "";
    if (!exitKey) {
        return { signals: [], strategyLoaded: false, skippedReason: "missing_exit_strategy_key", timings };
    }

    const loadStartedAt = args.collectTimings ? performance.now() : 0;
    const exitStrategy = await ensureBuiltInStrategyLoaded(exitKey);
    if (args.collectTimings) timings.loadMs += performance.now() - loadStartedAt;
    if (!exitStrategy) {
        return { signals: [], strategyLoaded: false, skippedReason: "exit_strategy_not_loaded", timings };
    }

    const canReuseSignals = Boolean(
        args.exitSignalCache
        && args.blockRange === null
        && !args.executionContext
        && args.settings.strategyTimeframeEnabled !== true
        && !(args.settings.confirmationStrategies?.length)
        && !exitStrategy.crossSymbolConfig
        && !exitStrategy.polymarket1sConfig,
    );
    const cacheKey = canReuseSignals
        ? buildExitSignalCacheKey({
            interval: args.interval,
            exitKey,
            exitParams: args.settings.exitStrategyParams ?? {},
            settings: args.settings,
        })
        : null;
    const dataCacheKey = canReuseSignals ? buildExitSignalDataCacheKey(args.data) : null;
    const datasetCache = dataCacheKey
        ? args.exitSignalCache!.get(dataCacheKey)
        : undefined;
    const cachedSignals = cacheKey && datasetCache
        ? datasetCache.get(cacheKey)
        : undefined;
    if (cachedSignals !== undefined) {
        const signals = filterSignalsByBlockRange(cachedSignals, args.blockRange);
        return {
            signals,
            strategyLoaded: true,
            skippedReason: signals.length === 0 ? "exit_strategy_zero_signals" : undefined,
            timings,
        };
    }

    const exitParams = args.settings.exitStrategyParams ?? {};
    const normalizeStartedAt = args.collectTimings ? performance.now() : 0;
    const normalizedExitParams = exitStrategy.normalizeParams
        ? exitStrategy.normalizeParams(exitParams)
        : exitParams;
    if (args.collectTimings) timings.normalizeMs += performance.now() - normalizeStartedAt;

    const signalGenerationStartedAt = args.collectTimings ? performance.now() : 0;
    const signals = resolveBacktestSignalsForData({
        data: args.data,
        interval: args.interval,
        strategy: exitStrategy,
        params: normalizedExitParams,
        settings: args.settings,
        blockRange: args.blockRange,
        executionContext: args.executionContext,
    });
    if (args.collectTimings) timings.signalGenerationMs += performance.now() - signalGenerationStartedAt;
    if (cacheKey) {
        const targetCache = datasetCache ?? new Map<string, Signal[]>();
        targetCache.set(cacheKey, signals);
        if (!datasetCache && dataCacheKey) args.exitSignalCache!.set(dataCacheKey, targetCache);
    }
    return {
        signals,
        strategyLoaded: true,
        skippedReason: signals.length === 0 ? "exit_strategy_zero_signals" : undefined,
        timings,
    };
}

function buildExitControlDiagnostics(args: {
    requestedSettings: Record<string, unknown>;
    resolvedSettings: BacktestSettings;
    primarySignals: number;
    exitOverrideSignals: number;
    mergedSignals: Signal[];
    mergedExitOnlySignals: number;
    exitStrategyLoaded: boolean;
    skippedReason?: string;
}): BacktestExitControlDiagnostics {
    const exitStrategyKey = typeof args.resolvedSettings.exitStrategyKey === "string"
        ? args.resolvedSettings.exitStrategyKey.trim()
        : "";
    return {
        requestedDisableSignalExits: args.requestedSettings.disableSignalExits === true,
        resolvedDisableSignalExits: args.resolvedSettings.disableSignalExits === true,
        exitStrategyOverrideEnabled: args.resolvedSettings.exitStrategyOverrideEnabled === true,
        exitStrategyKey,
        primarySignals: args.primarySignals,
        exitOverrideSignals: args.exitOverrideSignals,
        mergedSignals: args.mergedSignals.length,
        mergedExitOnlySignals: args.mergedExitOnlySignals,
        exitStrategyLoaded: args.exitStrategyLoaded,
        skippedReason: args.skippedReason,
    };
}

function applyConfirmationStrategies(
    data: OHLCVData[],
    interval: string,
    baseSignals: Signal[],
    settings: BacktestSettings
): Signal[] {
    const confirmationSettings: BacktestSettings = {
        ...settings,
        strategyTimeframeEnabled: false,
    };
    return applyConfirmationStrategiesToSignals({
        data,
        baseSignals,
        settings,
        executeStrategy: (_key, confirmationStrategy, confirmationParams) => executeStrategySignals(
            data,
            confirmationStrategy,
            confirmationParams,
            confirmationSettings,
            interval,
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
    let startTs = Number.POSITIVE_INFINITY;
    let endTs = Number.NEGATIVE_INFINITY;
    for (const bar of data) {
        const ts = parseTimeToUnixSeconds(bar.time);
        if (ts === null) continue;
        if (ts < startTs) startTs = ts;
        if (ts > endTs) endTs = ts;
    }
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return null;
    return {
        startTs,
        endTs,
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
    const symbolForPolymarketCheck = args.settings.polymarketOutcomeSymbol?.trim() || args.primarySymbol;
    if (!isSecondMarketPolymarketSupported(symbolForPolymarketCheck, args.interval)) {
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
    settings: BacktestSettings,
    outputOptions?: RustOutputOptions,
    rustCapabilities?: RustCapabilities,
    signal?: AbortSignal,
    rustDiagnosticPhase?: BacktestExecutionContext["rustDiagnosticPhase"],
): Promise<{ result: BacktestResult | null; reason?: RustBacktestFailureReason }> {
    const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = capitalSettings;
    const outcome = await rustEngine.runBacktestWithStatus(
        data,
        signals,
        initialCapital,
        positionSize,
        commission,
        sanitizeBacktestSettingsForRust(settings, rustCapabilities),
        { mode: sizingMode, fixedTradeAmount, advancedSizing: capitalSettings.advancedSizing },
        outputOptions,
        { signal, ...(rustDiagnosticPhase ? { rustDiagnosticPhase } : {}) },
    );
    return outcome.ok
        ? { result: outcome.result }
        : { result: null, reason: outcome.reason };
}

function throwBacktestCancelled(): never {
    const error = new Error("Backtest cancelled");
    error.name = "AbortError";
    throw error;
}

function throwIfBacktestCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throwBacktestCancelled();
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
        binanceMarketType: resolveBinanceMarketType(settings.binanceMarketType),
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
            backtestSlippageCents: settings.polymarketBacktestSlippageCents,
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
    if (!validateRustBacktestResult(result).ok) return false;
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

function hasGlobalStrategyTimeframeWrapper(strategy: Strategy): boolean {
    return (strategy as Strategy & { __global_timeframe_wrapped__?: boolean }).__global_timeframe_wrapped__ === true;
}

function executeStrategySignals(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    settings: BacktestSettings,
    interval: string,
    strategyAlreadyWrapped: boolean,
    crossSymbolContext?: StrategyExecutionContext
): Signal[] {
    return executeBacktestStrategySignals({
        data,
        interval,
        strategy,
        params,
        settings,
        strategyAlreadyWrapped,
        executionContext: crossSymbolContext,
    });
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
