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
} from "./backtest-edge-analysis";
import { attachTradeTimingQuality, type TradeTimingPreparedFloorsSource } from "./trade-timing-quality";
import { resolveBinanceMarketType } from "./binance-market";
import { buildSelectionResult } from "./finder/endpoint";

// ============================================================================
// Executor request / response
// ============================================================================

export interface BacktestExecutorRequest {
    ohlcvData: OHLCVData[];
    interval: string;
    /** Primary symbol name used by callers to identify the dataset. */
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
    /** Optional low-level run controls for bulk research callers that do not need full chart artifacts. */
    backtestRunOptions?: {
        includeAdvancedAnalytics?: boolean;
        includeSharpeRatio?: boolean;
        collectDiagnostics?: boolean;
        collectExecutorTimings?: boolean;
        /** Cooperative cancellation checked inside synchronous TS simulation loops. */
        isCancelled?: () => boolean;
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
        /**
         * Prepared trade-timing movement floors for a caller-owned immutable
         * window (see {@link getTradeTimingPreparedMovementFloors}). Only pass
         * this when the same prepared context covers every run sharing the
         * window; otherwise finalization computes floors fresh. Internal
         * execution plumbing: never persisted or serialized.
         */
        preparedTradeTimingFloors?: TradeTimingPreparedFloorsSource;
    };
    /** Pre-computed closed candle data. When provided, skips selectClosedCandleData internally. */
    closedCandleDataOverride?: OHLCVData[];
    /** Longer causal history used only to warm up configured confirmation strategies. */
    confirmationDataOverride?: OHLCVData[];
    /** Pre-resolved backtest settings. When provided, skips resolveExecutorBacktestSettings. */
    preResolvedSettings?: BacktestSettings;
    /** Pre-resolved capital settings. When provided, skips resolveCapitalSettingsFromRaw. */
    preResolvedCapital?: ReturnType<typeof resolveCapitalSettingsFromRaw>;
    /** Fully prepared primary signals; skips strategy signal generation. */
    preGeneratedSignals?: Signal[];
    /**
     * Per-run cache for deterministic Exit Strategy Override signals. The
     * cache is keyed by candle-window content identity and resolved exit
     * parameters, so callers can reuse the same exit series across candidate
     * replays even when each caller owns a sliced array instance.
     */
    exitSignalCache?: BacktestExitSignalCache;
    /**
     * Precomputed full-window content identity of the exit-signal dataset
     * (see {@link computeExitSignalDataIdentity}). Only honored together with
     * `closedCandleDataOverride`, and only when the identity was computed over
     * exactly that array; otherwise the executor computes the digest itself.
     * Internal execution plumbing: never persisted or serialized to a wire.
     */
    exitSignalDataIdentity?: string;
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
    postProcessingMs: number;
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

interface PrimarySignalReuse {
    strategy: Strategy;
    params: StrategyParams;
    signals: Signal[];
    confirmationData?: OHLCVData[];
}

/**
 * Which engine produced a result and which analytics the caller requested.
 * Finalization uses this to avoid recomputing authoritative engine output
 * while still honoring requested-but-missing analytics. Undefined
 * `includeSharpeRatio`/`includeAdvancedAnalytics` mean "enabled" (the default
 * full-result contract).
 */
interface FinalizationAnalyticsOwnership {
    engineUsed: "rust" | "typescript";
    includeSharpeRatio?: boolean;
    includeAdvancedAnalytics?: boolean;
    /**
     * Prepared trade-timing movement floors for a caller-owned immutable
     * window. Only threaded where the caller owns reuse rights; undefined
     * computes floors fresh inside the attachment.
     */
    preparedTradeTimingFloors?: TradeTimingPreparedFloorsSource;
}

function haveSameStrategyParams(left: StrategyParams, right: StrategyParams): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
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

// Scratch views for exact IEEE-754 bit mixing in computeExitSignalDataIdentity.
const exitIdentityFloat = new Float64Array(1);
const exitIdentityWords = new Uint32Array(exitIdentityFloat.buffer);

function mixExitIdentityWord(hash: number, word: number): number {
    const mixed = (hash ^ Math.imul(word, 0x9e3779b1)) >>> 0;
    return (Math.imul(mixed, 0x85ebca6b) ^ (mixed >>> 13)) >>> 0;
}

/**
 * Full-window content identity for exit-signal datasets: ordered
 * time/open/high/low/close/volume values. Times go through timeKey so
 * equivalent time shapes share identity; OHLCV numbers mix their exact bit
 * pattern (no quantization), so a change below any epsilon yields a different
 * identity. Two independent 32-bit accumulators keep accidental collisions
 * negligible. Content-identical slices share identities; any content change
 * produces a fresh one.
 */
export function computeExitSignalDataIdentity(data: OHLCVData[]): string {
    let hashA = 0x243f6a88;
    let hashB = 0x85a308d3;
    const mixNumber = (value: number): void => {
        exitIdentityFloat[0] = value;
        hashA = mixExitIdentityWord(hashA, exitIdentityWords[0]!);
        hashA = mixExitIdentityWord(hashA, exitIdentityWords[1]!);
        hashB = mixExitIdentityWord(hashB, exitIdentityWords[1]!);
        hashB = mixExitIdentityWord(hashB, exitIdentityWords[0]! ^ 0x1f8b0a00);
    };
    const mixToken = (token: string): void => {
        for (let index = 0; index < token.length; index += 1) {
            const code = token.charCodeAt(index);
            hashA = mixExitIdentityWord(hashA, code);
            hashB = mixExitIdentityWord(hashB, (code + index) >>> 0);
        }
        hashA = mixExitIdentityWord(hashA, 0xab8e2f8d);
        hashB = mixExitIdentityWord(hashB, 0x6a09e667);
    };
    for (const bar of data) {
        mixToken(timeKey(bar.time));
        mixNumber(bar.open);
        mixNumber(bar.high);
        mixNumber(bar.low);
        mixNumber(bar.close);
        mixNumber(bar.volume);
    }
    return `exit-data:${data.length}:${hashA.toString(16)}:${hashB.toString(16)}`;
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
            postProcessingMs: 0,
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
    const nowSec = req.context.nowSec ?? Math.floor(Date.now() / 1000);
    const blockRange = req.context.blockRange ?? null;
    const strategy = req.strategy ?? await ensureBuiltInStrategyLoaded(strategyKey);
    if (!strategy) {
        throw new Error(`Strategy not found: "${strategyKey}"`);
    }

    // Shared finalization for every engine outcome. The engine/output context
    // decides whether Sharpe and advanced analytics are authoritative engine
    // output, requested-but-missing (fill from a usable curve), or disabled.
    const runResultFinalization = (
        result: BacktestResult,
        engineUsed: "rust" | "typescript",
        data: OHLCVData[] = backtestData,
    ): void => {
        if (shouldSkipResultPostProcessing(req)) return;
        const startedAt = executorTimings ? performance.now() : 0;
        finalizeResult(result, data, interval, settingsWithMeta, {
            engineUsed,
            includeSharpeRatio: req.backtestRunOptions?.includeSharpeRatio,
            includeAdvancedAnalytics: req.backtestRunOptions?.includeAdvancedAnalytics,
            preparedTradeTimingFloors: req.backtestRunOptions?.preparedTradeTimingFloors,
        });
        if (executorTimings) executorTimings.postProcessingMs += performance.now() - startedAt;
    };

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

    const effectiveData = ohlcvData;
    const executionContext = req.strategyExecutionContext;

    const backtestData = req.closedCandleDataOverride
        ?? selectClosedCandleData(effectiveData, interval, resolvedSettings, nowSec, blockRange);

    // Asset Opportunity's next-bar fresh-entry pass only needs the generated
// signals. Avoid the remaining context-alignment/exit
    // resolution setup when none of those execution features can affect that
    // signal-only result.
    // Keep this deliberately narrow; the regular path remains authoritative
    // for confirmation, custom execution context, and all exit-aware runs.
    if (
        req.backtestRunOptions?.signalsOnly === true
        && !req.strategyExecutionContext
        && !(resolvedSettings.confirmationStrategies?.length)
        && resolvedSettings.exitStrategyOverrideEnabled !== true
    ) {
        const signals = req.preGeneratedSignals
            ? filterSignalsByBlockRange(req.preGeneratedSignals, blockRange)
            : resolveBacktestSignalsForData({
                data: backtestData,
                confirmationData: req.confirmationDataOverride,
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

    const signalGenerationStartedAt = executorTimings ? performance.now() : 0;
    const signals = req.preGeneratedSignals
        ? filterSignalsByBlockRange(req.preGeneratedSignals, blockRange)
        : resolveBacktestSignalsForData({
            data: backtestData,
            confirmationData: req.confirmationDataOverride,
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
        // A threaded identity is only trustworthy when the executor consumed
        // the caller's override array verbatim; otherwise the selected window
        // may differ from the array the identity described.
        dataIdentity: req.closedCandleDataOverride !== undefined
            ? req.exitSignalDataIdentity
            : undefined,
        primarySignalReuse: req.preGeneratedSignals === undefined
            ? {
                strategy,
                params: normalizedParams,
                signals,
                confirmationData: req.confirmationDataOverride,
            }
            : undefined,
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
        runResultFinalization(result, "typescript");
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
        const endpointSelectionRequested = req.backtestRunOptions?.endpointSelectionLastDataTime !== undefined;
        const rustResult = await tryRustBacktest(
            backtestData,
            mergedSignals,
            resolvedCapital,
            resolvedSettings,
            {
                compact: shouldUseCompactBacktest(req),
                // Endpoint selection needs the completed trades in order to
                // remove exits on the final data bar. This is opt-in and only
                // affects the Asset Opportunity compact endpoint path.
                retainTrades: req.backtestRunOptions?.requireTradeHistory === true
                    || endpointSelectionRequested,
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
            const endpointSelection = endpointSelectionRequested
                ? buildSelectionResult(
                    result,
                    req.backtestRunOptions?.endpointSelectionLastDataTime ?? null,
                    req.backtestRunOptions?.endpointSelectionInitialCapital ?? resolvedCapital.initialCapital,
                )
                : undefined;
            if (endpointSelection) {
                // Keep Rust endpoint selection semantically identical to the
                // compact TypeScript path without leaking the temporary trade
                // history through the executor result.
                endpointSelection.result.trades = [];
                result.trades = [];
            }
            result.exitControlDiagnostics = exitControlDiagnostics;
            runResultFinalization(result, "rust");
            registerBacktestEdgeAnalysisInput(result, backtestData);
            return finish(result, "rust", primarySignals, { rustAttempted: true }, endpointSelection);
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
                req.backtestRunOptions
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
    runResultFinalization(result, "typescript");
    result.exitControlDiagnostics = exitControlDiagnostics;
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
    const nowSec = context.nowSec ?? Math.floor(Date.now() / 1000);
    const blockRange = context.blockRange ?? null;
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
            finalizeResult(result, backtestData, interval, settings, { engineUsed: "rust" });
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
    finalizeResult(result, backtestData, interval, settings, { engineUsed: "typescript" });
    registerBacktestEdgeAnalysisInput(result, backtestData);
    return { result, engineUsed: "typescript", signals: filteredSignals };
}

// ============================================================================
// Internal helpers
// ============================================================================

function shouldSkipResultPostProcessing(req: BacktestExecutorRequest): boolean {
return req.backtestRunOptions?.skipResultPostProcessing === true;
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
    confirmationData?: OHLCVData[];
    interval: string;
    strategy: Strategy;
    params: StrategyParams;
    settings: BacktestSettings;
    blockRange: { from: number; to: number } | null;
    executionContext?: StrategyExecutionContext;
}): Signal[] {
    const wrapped = hasGlobalStrategyTimeframeWrapper(args.strategy);
    // A registry-wrapped strategy resamples inside its own execute, which
    // would read live UI state. Pin it to the captured request settings so
    // execution, snapshot, and replay describe the same request.
    const executionContext = wrapped
        ? { ...args.executionContext, strategyTimeframe: readStrategyTimeframeFromSettings(args.settings) }
        : args.executionContext;
    const signals = executeStrategySignals(
        args.data,
        args.strategy,
        args.params,
        args.settings,
        args.interval,
        wrapped,
        executionContext
    );
    const confirmedSignals = applyConfirmationStrategies(
        args.data,
        args.interval,
        signals,
        args.settings,
        args.confirmationData,
    );
    return filterSignalsByBlockRange(confirmedSignals, args.blockRange);
}

/**
 * Generates close-only exit signals from the configured Exit Strategy Override, when active.
 * Returns an empty array when the override is off, when disableSignalExits is off (inert),
 * or when the configured strategy key cannot be resolved.
 *
 * Returned signals are NOT tagged here; mergeExitStrategySignals tags them exitOnly.
 *
 * The per-pair exit-signal series used by a backtest comes from this resolution,
 * so the run and signal preparation path share the same implementation.
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
    /**
     * Caller-precomputed content identity of `args.data`. When omitted, the
     * identity is computed here (an O(bars) digest), so immutable-window
     * owners should thread it to avoid repaying the digest per candidate.
     */
    dataIdentity?: string;
    primarySignalReuse?: PrimarySignalReuse;
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
    );
    const cacheKey = canReuseSignals
        ? buildExitSignalCacheKey({
            interval: args.interval,
            exitKey,
            exitParams: args.settings.exitStrategyParams ?? {},
            settings: args.settings,
        })
        : null;
    const dataCacheKey = canReuseSignals
        ? (args.dataIdentity ?? computeExitSignalDataIdentity(args.data))
        : null;
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

    const primarySignalReuse = args.primarySignalReuse;
    if (
        primarySignalReuse
        && primarySignalReuse.strategy === exitStrategy
        && (primarySignalReuse.confirmationData === undefined || primarySignalReuse.confirmationData === args.data)
        && haveSameStrategyParams(primarySignalReuse.params, normalizedExitParams)
    ) {
        const signals = primarySignalReuse.signals;
        return {
            signals,
            strategyLoaded: true,
            skippedReason: signals.length === 0 ? "exit_strategy_zero_signals" : undefined,
            timings,
        };
    }

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

const confirmationSignalCacheByData = new WeakMap<OHLCVData[], Map<string, Signal[]>>();

function applyConfirmationStrategies(
    data: OHLCVData[],
    interval: string,
    baseSignals: Signal[],
    settings: BacktestSettings,
    confirmationDataOverride?: OHLCVData[],
): Signal[] {
    const confirmationData = confirmationDataOverride ?? data;
    const confirmationSettings: BacktestSettings = {
        ...settings,
        strategyTimeframeEnabled: false,
    };
    let confirmationSignalCache = confirmationSignalCacheByData.get(confirmationData);
    if (!confirmationSignalCache) {
        confirmationSignalCache = new Map<string, Signal[]>();
        confirmationSignalCacheByData.set(confirmationData, confirmationSignalCache);
    }
    return applyConfirmationStrategiesToSignals({
        data,
        confirmationData,
        baseSignals,
        settings,
        executeStrategy: (key, confirmationStrategy, confirmationParams, signalData) => {
            const cacheKey = JSON.stringify([
                interval,
                key,
                confirmationParams,
                settings.invertSignals === true,
                hasGlobalStrategyTimeframeWrapper(confirmationStrategy),
            ]);
            const cached = confirmationSignalCache.get(cacheKey);
            if (cached) return cached;
            const generated = executeStrategySignals(
                signalData,
                confirmationStrategy,
                confirmationParams,
                confirmationSettings,
                interval,
                hasGlobalStrategyTimeframeWrapper(confirmationStrategy)
            );
            confirmationSignalCache.set(cacheKey, generated);
            return generated;
        },
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
    settingsRaw: BacktestSettings | Record<string, unknown>,
    ownership: FinalizationAnalyticsOwnership
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
        if (ownership.engineUsed === "rust") {
            // Rust output is normalized at the executor boundary: TypeScript
            // recomputes the scalar Sharpe and missing advanced analytics from
            // the returned curve/history instead of trusting Rust scalars.
            result.sharpeRatio = ownership.includeSharpeRatio === false
                ? 0
                : recomputeSharpeRatio(result);
        } else {
            // TypeScript engines own their Sharpe (including a valid 0); do
            // not silently restore analytics the caller disabled.
            if (ownership.includeSharpeRatio === false) {
                result.sharpeRatio = 0;
            }
        }
        result.performanceAnalytics = resolveFinalPerformanceAnalytics(result, ownership);
    }
    attachTradeTimingQuality(result, backtestData, ownership.preparedTradeTimingFloors);
}

/**
 * Preserve populated analytics, fill missing analytics the caller requested
 * from a usable equity curve, and keep disabled analytics omitted. Advanced
 * analytics additionally require enabled Sharpe (the calculateBacktestStats
 * rule).
 */
function resolveFinalPerformanceAnalytics(
    result: BacktestResult,
    ownership: FinalizationAnalyticsOwnership
): BacktestResult["performanceAnalytics"] {
    if (ownership.includeAdvancedAnalytics === false || ownership.includeSharpeRatio === false) {
        return undefined;
    }
    if (result.performanceAnalytics) {
        return result.performanceAnalytics;
    }
    if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
        return calculateAdvancedPerformanceAnalyticsFromEquityCurve(result.equityCurve);
    }
    return undefined;
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

function readStrategyTimeframeFromSettings(settings: BacktestSettings): {
    enabled: boolean;
    minutes: number;
} {
    const enabled = settings.strategyTimeframeEnabled === true;
    const parsedMinutes = Number(settings.strategyTimeframeMinutes);
    const minutes = Number.isFinite(parsedMinutes) && parsedMinutes > 0
        ? Math.max(1, Math.floor(parsedMinutes))
        : 120;
    return { enabled, minutes };
}

function executeStrategySignals(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    settings: BacktestSettings,
    interval: string,
    strategyAlreadyWrapped: boolean,
    executionContext?: StrategyExecutionContext
): Signal[] {
    return executeBacktestStrategySignals({
        data,
        interval,
        strategy,
        params,
        settings,
        strategyAlreadyWrapped,
        executionContext: executionContext,
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
