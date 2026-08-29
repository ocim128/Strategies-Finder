/**
 * Per-asset orchestration for the Finder Asset Opportunity scope.
 *
 * For each supplied asset:
 *  1. Take closed candles via the caller-provided dataset + closed-data
 *     selector.
 *  2. Reserve the latest closed candle (the application candle) for current-
 *     signal detection. With no fixed holdout, dataSlice "all", and a
 *     non-`signal_close` execution model, the in-sample search includes it so
 *     fresh detection can reuse the search run's signals; the winner's
 *     displayed metrics still exclude it.
 *  3. Reserve the optional last-N historical candles for forward OOS
 *     measurement, then apply the existing Finder data-slice behavior to the
 *     IS window.
 *  4. Run the existing random Finder search (`runFinderExecution`) with the
 *     selected strategy library and a deterministic seed derived from
 *     `(runSeed, canonicalSymbol)`.
 *  5. Keep the top-K candidates (K = `candidatePoolSize`).
 *  6. Detect fresh entries for those candidates on the boundary data
 *     (including the application candle). When the boundary window is
 *     bar-for-bar identical to the in-sample window and the execution model
 *     is not `signal_close` (whose recheck needs re-simulated trades), the
 *     in-sample run's retained signals are reused; otherwise the candidates
 *     are re-executed on the boundary data.
 *  7. Select the highest-ranked fresh candidate within the top-K pool.
 *  8. Measure the selected candidate's forward OOS PnL using the configured
 *     fixed-horizon or next-exit mode, then build one scalar asset result +
 *     decision grade.
 *
 * Memory budget: candidates are executed via the existing Finder runner, which
 * holds per-strategy state for the duration of one asset's run. The runner
 * releases the input dataset reference after each asset's reduce step so a
 * large symbol list does not retain all datasets simultaneously.
 *
 * Import hygiene: this module IS safe to import from the Vite config bundle.
 * It imports `FinderSelectedStrategy` as a TYPE ONLY from `./finder-runner`
 * (erased at compile time) and pulls `createEmptyBacktestResult` from
 * `../strategies/index`, whose backtest-engine modules do not reach
 * `lightweight-charts`. The server-side Asset Opportunity plugin imports this
 * module directly. The separate `runServerAssetIsSearch` leaf exists so the
 * server runs a lean IS loop (no browser plan/UI machinery), NOT because of a
 * bundle constraint. `tests/vite-config-bundle.spec.ts` fails the build if a
 * future import re-introduces the documented `lightweight-charts` ESM-only
 * bundle error.
 */

import { mapWithConcurrencyLimit } from "../async-pool";
import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
} from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type {
    TypescriptSimulationConcurrencyTracker,
} from "../backtest-endpoint-contract";
import type { RustCapabilities, RustDiagnosticPhase } from "../rust-engine-client";
import type {
    FinderAssetDirection,
    FinderAssetOpportunityResult,
    FinderOosVerdict,
    FinderOptions,
    FinderResult,
} from "../types/finder";
import { type FinderSelectedStrategy } from "./finder-runner";
import { buildFinderEvaluationData } from "./finder-runner-shared";
import {
    createPreparedFinderStrategy,
    finderAssetSearchRequiresFullAnalytics,
    type FinderPreparedDataCache,
    normalizeFinderCandidateParams,
} from "./finder-runner-core";
import { withExitStrategyBaseParams, splitExitStrategyParams } from "./exit-strategy-param-prefix";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import type { CrossSymbolDataFetcher } from "../cross-symbol-runtime";
import {
    runAssetCandidateBacktest,
    type AssetCandidateExitSignalCache,
} from "./finder-asset-candidate-execution";
import { createEmptyBacktestResult } from "../strategies/index";
import { buildSelectionResult } from "./endpoint";
import {
    computeFinderOosVerdict,
    resolveOosDataSlice,
    sliceFinderDataWindow,
    matchesFinderTradeCountFilter,
} from "./finder-manager-logic";
import { deriveStrategySeed } from "./finder-runner-shared";
import { detectFreshEntry } from "./finder-fresh-entry";
import {
    calculateAssetOpportunityDerivedMetrics,
    computeAssetSupportCounts,
    decideAssetGrade,
    MEDIAN_BARS_TO_TP_MIN_HITS,
    type AssetPoolCandidate,
} from "./finder-asset-opportunity-metrics";
import {
    calculateFinderAssetOosNextExitMetrics,
    calculateFinderAssetOosSignalMetrics,
    type FinderAssetOosNextExitUnavailableReason,
    normalizeFinderAssetEvalLastBars,
    normalizeFinderAssetOosMeasurementMode,
    normalizeFinderAssetOosHorizons,
    normalizeFinderAssetOosIgnoreLastBars,
} from "./finder-asset-opportunity-oos";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { timeKey } from "../strategies/backtest/backtest-utils";
import { debugLogger } from "../debug-logger";
import type { AssetOpportunitySignalCache } from "./finder-asset-opportunity-search-cache";

/**
 * Bounded concurrency for fresh-entry signal regeneration. The server clamps
 * the candidate pool to 50, so unbounded `Promise.all` would launch up to 50
 * simultaneous signal regenerations + backtests per asset — a transient CPU /
 * Rust-worker / heap spike. Indexed results keep output order identical.
 */
const ASSET_FRESH_RECHECK_CONCURRENCY = 6;

const FRESH_SIGNAL_WARMUP_MIN_BARS = 64;
const FRESH_SIGNAL_WARMUP_MAX_BARS = 2_048;

function resolveFreshSignalWarmupBars(
    candidates: readonly FinderResult[],
    settings: BacktestSettings,
): number {
    let largestPeriod = 0;
    const periodLikeKey = /(period|lookback|bars|length|window|horizon|lag|slow|fast)/i;
    const inspect = (values: Record<string, unknown>): void => {
        for (const [key, value] of Object.entries(values)) {
            if (!periodLikeKey.test(key)) continue;
            const numeric = Number(value);
            if (Number.isFinite(numeric)) largestPeriod = Math.max(largestPeriod, Math.abs(numeric));
        }
    };
    inspect(settings as unknown as Record<string, unknown>);
    for (const candidate of candidates) {
        inspect(candidate.params);
        if (candidate.exitStrategyParams) inspect(candidate.exitStrategyParams);
    }
    return Math.min(
        FRESH_SIGNAL_WARMUP_MAX_BARS,
        Math.max(FRESH_SIGNAL_WARMUP_MIN_BARS, Math.ceil(largestPeriod * 3)),
    );
}

/**
 * A finite max-hold makes a recent next-exit replay exact: no position from
 * before this window can still be open at the freshness boundary. Include
 * cooldown time as well because a recently closed position can still block a
 * later entry. Return null when the execution state is not safely bounded.
 */
function resolveBoundedNextExitReplayBars(
    settings: BacktestSettings,
    candidates: readonly FinderResult[],
): number | null {
    if (
        settings.riskMaxHoldEnabled !== true
        || settings.strategyTimeframeEnabled === true
        || (settings.confirmationStrategies?.length ?? 0) > 0
        || settings.riskWinStreakStopLossEnabled === true
    ) return null;
    let maxHoldBars = Number(settings.riskMaxHoldBars);
    for (const candidate of candidates) {
        const candidateMaxHoldBars = Number(candidate.params.riskMaxHoldBars);
        if (Number.isFinite(candidateMaxHoldBars)) {
            maxHoldBars = Math.max(maxHoldBars, Math.max(1, Math.round(candidateMaxHoldBars)));
        }
    }
    if (!Number.isFinite(maxHoldBars) || maxHoldBars < 1) return null;
    const cooldownEnabled = settings.riskCooldownEnabled !== false;
    const cooldownBars = cooldownEnabled
        ? Number.isFinite(settings.riskCooldownBars)
            ? Math.max(0, Math.ceil(Number(settings.riskCooldownBars)))
            : 1
        : 0;
    return Math.max(4, Math.ceil(maxHoldBars) + cooldownBars + 3);
}

/**
 * A bounded next-exit OOS replay needs the indicator warmup before the last
 * bounded execution-state window, followed by the hidden holdout itself.
 * Keep the full series available to the metrics extractor, but avoid sending
 * all historical candles through the strategy and trade engine.
 */
function resolveBoundedNextExitOosReplayData(args: {
    fullClosed: OHLCVData[];
    hiddenBars: number;
    candidates: readonly FinderResult[];
    settings: BacktestSettings;
}): OHLCVData[] | undefined {
    const boundedExecutionBars = resolveBoundedNextExitReplayBars(args.settings, args.candidates);
    if (boundedExecutionBars === null) return undefined;
    const hiddenBars = Math.max(0, Math.ceil(args.hiddenBars));
    const replayBars = boundedExecutionBars
        + resolveFreshSignalWarmupBars(args.candidates, args.settings)
        + hiddenBars;
    if (replayBars >= args.fullClosed.length) return undefined;
    return args.fullClosed.slice(-replayBars);
}

/**
 * Build the smallest useful recent window for a bounded Asset Opportunity
 * evaluation. Fixed-horizon paths use it for signal-only detection; bounded
 * next-exit paths also use it for the replay because their finite execution
 * state makes older candles irrelevant. The warmup is deliberately
 * conservative because Strategy has no universal lookback contract and
 * several built-ins use EMA/rolling state.
 */
function resolveFreshSignalWindow(args: {
    boundaryData: OHLCVData[];
    slicedHistorical: OHLCVData[];
    signalLookbackBars: number;
    dataSlice: FinderOptions["dataSlice"];
    candidates: readonly FinderResult[];
    settings: BacktestSettings;
    crossSymbol: boolean;
    canUseBoundedSignalWindow: boolean;
}): OHLCVData[] | undefined {
    if (
        args.signalLookbackBars <= 0
        || args.dataSlice !== "all"
        || args.crossSymbol
        || args.boundaryData.length <= args.slicedHistorical.length
        || !args.canUseBoundedSignalWindow
    ) {
        return undefined;
    }
    const signalWindowBars = args.signalLookbackBars
        + resolveFreshSignalWarmupBars(args.candidates, args.settings);
    if (signalWindowBars >= args.boundaryData.length) return undefined;
    return args.boundaryData.slice(-signalWindowBars);
}

/**
 * Strategy signal barIndex values are local to the shortened signal window.
 * Rust and the fresh detector consume the full boundary timeline, so align
 * them by timestamp before the signals leave the TypeScript process.
 */
function alignSignalsToBoundary(
    signals: readonly Signal[],
    boundaryData: readonly OHLCVData[],
): Signal[] {
    const indexByTime = new Map<string, number>();
    for (let index = 0; index < boundaryData.length; index += 1) {
        indexByTime.set(timeKey(boundaryData[index]!.time), index);
    }
    return signals.flatMap((signal) => {
        const barIndex = indexByTime.get(timeKey(signal.time));
        return barIndex === undefined
            ? []
            : [{ ...signal, barIndex }];
    });
}

/**
 * The in-sample search seam. Production wires the existing browser
 * `runFinderExecution`; the server-side Asset Opportunity path wires a server
 * runner. Tests inject a deterministic stub.
 *
 * The input mirrors `FinderRunInput` minus the callbacks surface; the caller
 * supplies its own progress/status/yield plumbing at the outer level.
 */
export type AssetIsSearch = (args: {
    ohlcvData: OHLCVData[];
    symbol: string;
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    rustCapabilities?: RustCapabilities;
    selectedStrategies: FinderSelectedStrategy[];
    exitStrategyCandidates?: FinderSelectedStrategy[];
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    isCancelled: () => boolean;
    yieldControl: () => Promise<void>;
    /**
     * When true, the search should retain each returned candidate's generated
     * signals and surface them via `signalsByCandidate`, so the caller can
     * detect fresh entries without re-executing every top-K candidate. Only
     * requested when the caller has proven the fresh-entry recheck window is
     * bar-for-bar identical to the in-sample window.
     */
    retainSignals?: boolean;
    /** Full closed data used only by the batch signal-reuse optimization. */
    fullSignalData?: OHLCVData[];
    signalCache?: AssetOpportunitySignalCache;
    /** Per-asset cache for deterministic Exit Strategy Override signals. */
    exitSignalCache?: AssetCandidateExitSignalCache;
    signal?: AbortSignal;
    /** Optional bounded probe used to reject a single-candidate search early. */
    freshEntryPrecheck?: AssetOpportunityFreshEntryPrecheck;
}) => Promise<{
    results: FinderResult[];
    /** Total candidates considered before the returned top-K reduction. */
    totalCandidatesEvaluated?: number;
    candidateEvaluationsAttempted?: number;
    candidateEvaluationsCompleted?: number;
    candidateEvaluationFailures?: number;
    signalCacheHits?: number;
    signalCacheMisses?: number;
    /**
     * Parallel to `results` (same order): the signals from each returned
     * candidate's in-sample evaluation. Present only when `retainSignals` was
     * requested AND the implementation supports it; callers must fall back to
     * re-execution when absent.
     */
    signalsByCandidate?: Signal[][];
    timingsMs?: {
        total: number;
        parameterGeneration: number;
        backtest: number;
        yielding: number;
    };
    engineUsage?: {
        rustAttemptedRuns: number;
        rustCompletedRuns: number;
        rustFallbackRuns: number;
        typescriptCompletedRuns: number;
        typescriptReasons: Array<{ reason: string; runs: number }>;
    };
    /** Present when the bounded freshness probe rejected the only candidate. */
    freshEntryPrecheck?: AssetOpportunityFreshEntryPrecheckResult;
}>;

export interface AssetOpportunitySearchDiagnostics {
    dataBars: number;
    historicalBars: number;
    slicedHistoricalBars: number;
    freshSignalWindowBars: number;
    oosBars: number;
    candidatesEvaluated: number;
    candidateEvaluationsAttempted: number;
    candidateEvaluationsCompleted: number;
    candidateEvaluationFailures: number;
    signalCacheHits: number;
    signalCacheMisses: number;
    freshEntryRechecks: number;
    freshEntryExecutions: number;
    oosEvaluations: number;
    fixedHorizonEvaluations: number;
    nextExitEvaluations: number;
    complementaryOosEvaluations: number;
    winnerAnalyticsRecomputations: number;
    timingsMs: {
        total: number;
        preparation: number;
        inSampleSearch: number;
        parameterGeneration: number;
        candidateBacktests: number;
        yielding: number;
        freshEntryRechecks: number;
        oosValidation: number;
        resultReduction: number;
        winnerAnalytics: number;
    };
    engineUsage: {
        rustAttemptedRuns: number;
        rustCompletedRuns: number;
        rustFallbackRuns: number;
        typescriptCompletedRuns: number;
        typescriptReasons: Array<{ reason: string; runs: number }>;
    };
}

/**
 * One asset's input to the runner.
 */
export interface AssetOpportunityAssetInput {
    /** Canonical symbol (used for deterministic per-asset seeding). */
    symbol: string;
    /** Raw OHLCV dataset for the asset (closed-candle selection happens inside). */
    data: OHLCVData[];
    /**
     * Optional caller-supplied execution-aware closed-candle view of `data`.
     * When the caller runs multiple strategies over the same asset, hoisting
     * this build out of the per-strategy loop avoids re-walking the dataset to
     * find the latest closed bar (`selectExecutionAwareClosedCandles`) once per
     * strategy. Omitted by tests and the single-strategy path; the runner
     * builds it from `data` when absent.
     */
    precomputedFullClosed?: OHLCVData[];
}

export interface AssetOpportunityFreshEntryPrecheckResult {
    fresh: boolean;
    /** True when the bounded probe could not be formed; the full search runs. */
    skipped?: boolean;
    engineUsed: "rust" | "typescript";
    rustAttempted: boolean;
    typescriptReason?: string;
}

export type AssetOpportunityFreshEntryPrecheck = (args: {
    entryParams: StrategyParams;
    exitStrategyKey?: string;
    exitStrategyParams?: StrategyParams;
}) => Promise<AssetOpportunityFreshEntryPrecheckResult>;

/**
 * The full per-run input.
 */
export interface AssetOpportunityRunInput {
    interval: string;
    /** Finder options (mode, sortPriority, topN, maxRuns, steps, rangePercent, dataSlice, etc.). */
    options: FinderOptions;
    /** Base backtest settings (capital/risk/execution model). */
    settings: BacktestSettings;
    /** Capital settings shared by every candidate. */
    capitalSettings: CapitalSettings;
    /** One selected strategy library for this independent per-strategy pass. */
    selectedStrategy: FinderSelectedStrategy;
    /** Optional pre-loaded exit strategies for Exit Strategy Override. */
    exitStrategyCandidates?: FinderSelectedStrategy[];
    /** Param-space generator (mirrors the current-chart path). */
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    /** Run-level seed combined with each symbol for deterministic per-asset seeding. */
    runSeed: number;
    /** Internal top-K historical candidate pool size. Default: 10. */
    candidatePoolSize: number;
    /** Minimum same-direction fresh support for a `select` grade. Default: 2. */
    minFreshSupport: number;
    /** Shared secondary-data resolver for cross-symbol replay parity. */
    dataFetcher?: CrossSymbolDataFetcher;
    /** Matches the server's explicit Rust preference for replay execution. */
    useRustEnginePreference?: boolean;
    rustCapabilities?: RustCapabilities;
    typescriptSimulationConcurrency?: TypescriptSimulationConcurrencyTracker;
    /** Cancels every in-flight candidate, freshness, and OOS replay. */
    signal?: AbortSignal;
    /** Worker-local cache for full-series signals reused across batch holdouts. */
    signalCache?: AssetOpportunitySignalCache;
    /** Per-asset cache for deterministic Exit Strategy Override signals. */
    exitSignalCache?: AssetCandidateExitSignalCache;
    /** Enable the bounded single-candidate freshness probe on server runs. */
    precheckFreshEntry?: boolean;
    /** Recompute full scalar analytics once for the selected winner. */
    recomputeWinnerAnalytics?: boolean;
    /** Asset list (each independently searched). */
    assets: AssetOpportunityAssetInput[];
    /**
     * In-sample search seam. Production wires the existing browser
     * `runFinderExecution`; tests inject a deterministic stub; the server-side
     * path wires the server runner. Decouples this leaf from the browser-bound
     * `finder-runner` module so it can be reused server-side.
     */
    runIsSearch: AssetIsSearch;
}

export interface AssetOpportunityRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    yieldControl: () => Promise<void>;
    isCancelled: () => boolean;
    /** Called once per asset after the asset result is finalized. */
    onAssetComplete?: (result: AssetOpportunityAssetResult) => void;
}

/**
 * One asset's terminal outcome. `result` is null when the asset had no fresh
 * entry, or when it failed to load/evaluate. The caller counts these into
 * diagnostics but does NOT display them as opportunity rows.
 */
export type AssetOpportunityAssetResult =
    | {
        kind: "opportunity";
        symbol: string;
        result: FinderAssetOpportunityResult;
        diagnostics?: AssetOpportunitySearchDiagnostics;
    }
    | {
        kind: "no_fresh_entry";
        symbol: string;
        /** Total historical candidates evaluated. */
        candidatesEvaluated: number;
        /** Best historical rank among all candidates (1-based). */
        bestHistoricalRank: number | null;
        diagnostics?: AssetOpportunitySearchDiagnostics;
    }
    | {
        kind: "failed";
        symbol: string;
        reason: string;
        diagnostics?: AssetOpportunitySearchDiagnostics;
    };

export interface AssetOpportunityRunOutput {
    /** Final, ranked asset rows (fresh-entry opportunities only). */
    results: FinderAssetOpportunityResult[];
    /** Per-asset outcomes (including failures and no-fresh), in input order. */
    outcomes: AssetOpportunityAssetResult[];
}

/**
 * Validate the selected strategy list; Asset Opportunity runs every selected
 * strategy independently; only an empty selection is invalid.
 * one — this helper exists for the server-side boundary that re-checks.
 */
export function assertAssetOpportunityStrategySelection(selectedStrategies: FinderSelectedStrategy[]): void {
    if (selectedStrategies.length === 0) {
        throw new Error("Asset Opportunity requires at least one selected strategy; received zero.");
    }
}

/**
 * Reserve the latest closed candle (the application candle). Returns:
 * - `historical`: the search data (closed set minus the application candle);
 * - `fullClosed`: the full closed set including the application candle.
 *
 * When the closed set has fewer than 2 candles, there is no historical window
 * and the asset is rejected upstream.
 */
export function splitApplicationCandle(closedData: OHLCVData[]): {
    historical: OHLCVData[];
    applicationCandle: OHLCVData | null;
    fullClosed: OHLCVData[];
} {
    if (closedData.length === 0) {
        return { historical: [], applicationCandle: null, fullClosed: [] };
    }
    if (closedData.length === 1) {
        return { historical: [], applicationCandle: closedData[0]!, fullClosed: closedData };
    }
    const applicationCandle = closedData[closedData.length - 1]!;
    return {
        historical: closedData.slice(0, -1),
        applicationCandle,
        fullClosed: closedData,
    };
}

/**
 * Apply the Finder data-slice to the historical search data. Mirrors the
 * current-chart Finder: `sliceFinderDataWindow` over the historical window.
 */
export function sliceHistoricalWindow(
    historical: OHLCVData[],
    options: FinderOptions,
): OHLCVData[] {
    return sliceFinderDataWindow(historical, options.dataSlice ?? "all");
}

/**
 * Derive a deterministic per-asset seed from the run seed + canonical symbol.
 * Reuses `deriveStrategySeed` so the seed distribution matches the existing
 * Finder's hash-based seeding.
 */
export function deriveAssetSeed(runSeed: number, canonicalSymbol: string): number {
    return deriveStrategySeed(runSeed, canonicalSymbol);
}

/**
 * Resolve the canonical symbol for per-asset seeding. Synthetic-pair tokens
 * (e.g. `BTCUSDT•ETHUSDT`) need the same canonical key as the runner's
 * universe cache so a re-run reproduces identical candidate parameters.
 */
export function canonicalAssetSymbol(symbol: string): string {
    return symbol;
}

export interface AssetOpportunityOosEvaluation {
    verdict: FinderOosVerdict;
    result: BacktestResult;
    engineUsed?: "rust" | "typescript";
    rustAttempted?: boolean;
    typescriptReason?: string;
}

/**
 * Reduce one asset's top-K candidate pool to one scalar asset result.
 *
 * Inputs:
 * - `topK`: the bounded top-K historical candidates from the random search,
 *   in ranked order (index 0 is best).
 * - `freshByCandidate`: a parallel array of fresh-entry results produced by
 *   re-running each top-K candidate on the FULL closed data.
 *
 * The current signal is never used to choose the historical candidate rank;
 * it is only evaluated after historical ranking. So the winner is the
 * highest-ranked candidate that has a `fresh` status; if none, the asset has
 * no opportunity.
 *
 * Returns the asset result + the per-candidate support inputs.
 */
export function reduceAssetTopKToResult(args: {
    symbol: string;
    strategyKey: string;
    strategyName: string;
    options: FinderOptions;
    minFreshSupport: number;
    topK: FinderResult[];
    totalCandidatesEvaluated: number;
    freshByCandidate: Array<{
        freshStatus: "fresh" | "active" | "flat";
        direction: FinderAssetDirection | null;
        latestSignalTime: Time | null;
        signalAgeBars: number;
        fillTiming: "signal_close" | "next_open" | "next_close";
        isOpen: boolean;
        latestTradeEntryTime: number | null;
    }>;
    oosByCandidate?: (AssetOpportunityOosEvaluation | undefined)[];
}): { result: FinderAssetOpportunityResult | null; support: AssetPoolCandidate[] } {
    const { symbol, strategyKey, strategyName, topK, freshByCandidate, options } = args;

    if (topK.length === 0) {
        return { result: null, support: [] };
    }

    // Build the support pool from the parallel fresh arrays.
    const supportPool: AssetPoolCandidate[] = topK.map((_, idx) => {
        const fresh = freshByCandidate[idx]!;
        return {
            rank: idx + 1,
            freshStatus: fresh.freshStatus,
            direction: fresh.direction,
            isOpen: fresh.isOpen,
        };
    });

    // Pick the highest-ranked fresh candidate as the winner.
    let winnerIndex = -1;
    for (let i = 0; i < freshByCandidate.length; i++) {
        if (freshByCandidate[i]!.freshStatus === "fresh") {
            winnerIndex = i;
            break;
        }
    }
    if (winnerIndex < 0) {
        return { result: null, support: supportPool };
    }

    const winner = topK[winnerIndex]!;
    const winnerFresh = freshByCandidate[winnerIndex]!;
    const winnerDirection = winnerFresh.direction ?? "long";
    const support = computeAssetSupportCounts({
        pool: supportPool,
        winnerDirection,
    });

    const minHistoricalTrades = options.tradeFilterEnabled ? options.minTrades : 0;
    const selectionResult = winner.selectionResult;
    const hasPositiveExpectancy = Number.isFinite(selectionResult.expectancy)
        ? selectionResult.expectancy > 0
        : false;
    const oosEvaluation = args.oosByCandidate?.[winnerIndex];

    const grade = decideAssetGrade({
        hasFreshEntry: true,
        hasPositiveExpectancy,
        historicalTrades: selectionResult.totalTrades,
        sameDirectionSupport: support.freshSameDirection,
        minHistoricalTrades,
        minFreshSupport: args.minFreshSupport,
        ...(oosEvaluation ? { oosVerdict: oosEvaluation.verdict } : {}),
    });

    const { entryParams, exitParams } = winner.exitStrategyKey
        ? splitExitStrategyParams(winner.params)
        : { entryParams: winner.params, exitParams: {} };

    const result: FinderAssetOpportunityResult = {
        symbol,
        strategyKey,
        strategyName,
        params: entryParams,
        ...(winner.exitStrategyKey
            ? {
                exitStrategyKey: winner.exitStrategyKey,
                exitStrategyParams: exitParams,
            }
            : {}),
        historicalRank: winnerIndex + 1,
        totalCandidatesEvaluated: args.totalCandidatesEvaluated,
        isHistoricalBest: winnerIndex === 0,
        freshStatus: winnerFresh.freshStatus,
        direction: winnerDirection,
        latestSignalTime: winnerFresh.latestSignalTime,
        signalAgeBars: winnerFresh.signalAgeBars,
        fillTiming: winnerFresh.fillTiming,
        selectionResult,
        ...(oosEvaluation ? { oosResult: oosEvaluation.result, oosVerdict: oosEvaluation.verdict } : {}),
        support,
        grade,
    };

    return { result, support: supportPool };
}

/**
 * Run the Asset Opportunity search over the supplied assets. Each asset is
 * searched independently; no value is averaged across assets.
 *
 * Returns one scalar asset result per asset that produced a fresh-entry
 * opportunity, plus a per-asset outcome list (including no-fresh and failed
 * entries) for diagnostics.
 */
export async function runAssetOpportunitySearch(
    input: AssetOpportunityRunInput,
    callbacks: AssetOpportunityRunCallbacks,
): Promise<AssetOpportunityRunOutput> {
    throwIfAborted(input.signal);
    const outcomes: AssetOpportunityAssetResult[] = [];
    const results: FinderAssetOpportunityResult[] = [];
    const totalAssets = input.assets.length;
    const selectedStrategy = input.selectedStrategy;

    callbacks.setProgress(0, `Asset Opportunity: 0/${totalAssets} assets`);

    for (let assetIndex = 0; assetIndex < totalAssets; assetIndex++) {
        throwIfAborted(input.signal);
        if (callbacks.isCancelled()) break;
        const asset = input.assets[assetIndex]!;
        const symbol = asset.symbol;

        callbacks.setProgress(
            (assetIndex / totalAssets) * 100,
            `Asset Opportunity ${assetIndex + 1}/${totalAssets}: ${symbol}`,
        );
        callbacks.setStatus(`Searching ${symbol} (${assetIndex + 1}/${totalAssets})...`);

        try {
            const outcome = await searchOneAsset({
                asset,
                input,
                selectedStrategy,
                callbacks,
            });
            outcomes.push(outcome);
            if (outcome.kind === "opportunity") {
                results.push(outcome.result);
                callbacks.onAssetComplete?.(outcome);
            } else {
                callbacks.onAssetComplete?.(outcome);
            }
        } catch (error) {
            if (input.signal?.aborted || isAbortError(error)) {
                throw error;
            }
            if (callbacks.isCancelled()) {
                break;
            }
            const reason = error instanceof Error ? error.message : String(error);
            debugLogger.warn("finder.asset_opportunity.asset_failed", { symbol, reason });
            const failed: AssetOpportunityAssetResult = { kind: "failed", symbol, reason };
            outcomes.push(failed);
            callbacks.onAssetComplete?.(failed);
        }

        await callbacks.yieldControl();
    }

    callbacks.setProgress(100, `Asset Opportunity complete: ${results.length}/${totalAssets} fresh opportunities`);

    return { results, outcomes };
}

/**
 * Search one asset: split the application candle, run the historical search,
 * then re-evaluate the top-K on the full closed set for fresh-entry detection.
 */
async function searchOneAsset(args: {
    asset: AssetOpportunityAssetInput;
    input: AssetOpportunityRunInput;
    selectedStrategy: FinderSelectedStrategy;
    callbacks: AssetOpportunityRunCallbacks;
}): Promise<AssetOpportunityAssetResult> {
    const { asset, input, selectedStrategy, callbacks } = args;
    const symbol = asset.symbol;
    const exitSignalCache = input.exitSignalCache ?? new Map();
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const preparedStrategy = createPreparedFinderStrategy(
        selectedStrategy.key,
        selectedStrategy.strategy,
        preparedDataCache,
        () => input.settings,
    );
    const startedAt = performance.now();
    const preparationStartedAt = performance.now();
    const diagnostics: AssetOpportunitySearchDiagnostics = {
        dataBars: asset.data.length,
        historicalBars: 0,
        slicedHistoricalBars: 0,
        freshSignalWindowBars: 0,
        oosBars: 0,
        candidatesEvaluated: 0,
        candidateEvaluationsAttempted: 0,
        candidateEvaluationsCompleted: 0,
        candidateEvaluationFailures: 0,
        signalCacheHits: 0,
        signalCacheMisses: 0,
        freshEntryRechecks: 0,
        freshEntryExecutions: 0,
        oosEvaluations: 0,
        fixedHorizonEvaluations: 0,
        nextExitEvaluations: 0,
        complementaryOosEvaluations: 0,
        winnerAnalyticsRecomputations: 0,
        timingsMs: {
            total: 0,
            preparation: 0,
            inSampleSearch: 0,
            parameterGeneration: 0,
            candidateBacktests: 0,
            yielding: 0,
            freshEntryRechecks: 0,
            oosValidation: 0,
            resultReduction: 0,
            winnerAnalytics: 0,
        },
        engineUsage: {
            rustAttemptedRuns: 0,
            rustCompletedRuns: 0,
            rustFallbackRuns: 0,
            typescriptCompletedRuns: 0,
            typescriptReasons: [],
        },
    };
    const finish = (outcome: AssetOpportunityAssetResult): AssetOpportunityAssetResult => {
        if (diagnostics.timingsMs.preparation === 0) {
            diagnostics.timingsMs.preparation = performance.now() - preparationStartedAt;
        }
        diagnostics.timingsMs.total = performance.now() - startedAt;
        diagnostics.engineUsage.typescriptReasons.sort(
            (a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason),
        );
        return { ...outcome, diagnostics };
    };

    const fullClosed = asset.precomputedFullClosed
        ?? buildFinderEvaluationData(asset.data, input.interval, input.settings);
    diagnostics.dataBars = fullClosed.length;
    if (fullClosed.length < 2) {
        return finish({ kind: "failed", symbol, reason: "insufficient closed candles" });
    }

    const { historical } = splitApplicationCandle(fullClosed);
    diagnostics.historicalBars = historical.length;
    if (historical.length === 0) {
        return finish({ kind: "failed", symbol, reason: "no historical candles after reserving application candle" });
    }

    const oosIgnoreLastBars = normalizeFinderAssetOosIgnoreLastBars(
        input.options.assetOpportunity?.oosIgnoreLastBars,
    );
    const oosMeasurementMode = normalizeFinderAssetOosMeasurementMode(
        input.options.assetOpportunity?.oosMeasurementMode,
    );
    const needsExecutableFreshRecheck = oosMeasurementMode === "next_exit";
    const oosHorizons = normalizeFinderAssetOosHorizons(input.options.assetOpportunity?.oosHorizons);
    const evalLastBars = normalizeFinderAssetEvalLastBars(input.options.assetOpportunity?.evalLastBars);
    if (oosIgnoreLastBars > 0 && fullClosed.length - oosIgnoreLastBars < 2) {
        return finish({
            kind: "failed",
            symbol,
            reason: "not enough visible candles before the OOS holdout",
        });
    }
    // In validation mode the visible chart ends at the signal boundary. The
    // final N candles are hidden entirely, including the current/latest bar;
    // the candidate search and boundary replay both stop before that window.
    const visibleValidationData = oosIgnoreLastBars > 0
        ? fullClosed.slice(0, -oosIgnoreLastBars)
        : fullClosed;
    // Retained-signal reuse for fresh-entry detection is only parity-safe for
    // the non-`signal_close` fixed-horizon paths: their recheck runs
    // `signalsOnly`, so `detectFreshEntry` sees an empty-trades result that
    // the retained in-sample signals reproduce exactly. `signal_close` and
    // `next_exit` need the re-simulated trade list (`next_exit` must honor
    // max-open-trades and other execution gates); next_exit can use a recent
    // execution-aware replay only when max-hold/cooldown bound that state.
    const executionModel = input.settings.executionModel ?? "signal_close";
    const canReuseIsSignalsForFreshModel = executionModel !== "signal_close"
        && !needsExecutableFreshRecheck;
    // With no fixed holdout, no data slice, and no evaluation window, the
    // in-sample search includes the reserved application candle so the
    // fresh-entry check below can reuse the candidate run's retained signals
    // instead of re-executing every top-K candidate on the same bars. The search
    // window gains one bar out of the full dataset (ranking/grade inputs shift
    // negligibly — the existing endpoint adjustment already strips the
    // still-open final trade); the winner's displayed metrics are still
    // recomputed on the historical window further below, so displayed results
    // exclude the application candle. An evalLastBars cap must NOT include it:
    // the trailing window would re-capture the application candle into the
    // search window.
    const includeApplicationCandleInSearch = canReuseIsSignalsForFreshModel
        && oosIgnoreLastBars === 0
        && evalLastBars === 0
        && (input.options.dataSlice ?? "all") === "all";
    const inSampleHistorical = oosIgnoreLastBars > 0
        ? visibleValidationData
        : includeApplicationCandleInSearch
            ? fullClosed
            : historical;
    diagnostics.historicalBars = inSampleHistorical.length;
    const fixedOosSignalIndex = oosIgnoreLastBars > 0
        ? visibleValidationData.length - 1
        : -1;
    const fixedOosBars = oosIgnoreLastBars > 0
        ? fullClosed.slice(visibleValidationData.length)
        : [];
    diagnostics.oosBars = fixedOosBars.length;

    const assetSeed = deriveAssetSeed(input.runSeed, canonicalAssetSymbol(symbol));
    const assetOptions: FinderOptions = {
        ...input.options,
        // Keep K candidates (caller passes `candidatePoolSize`); the public
        // `topN` is the number of final ASSET rows, not candidate pool size.
        // The historical search uses the pool size as its internal topN.
        topN: input.candidatePoolSize,
        // Override randomSeed with the per-asset derived seed for deterministic
        // per-asset search.
        ...(input.options.mode === "random" ? { randomSeed: assetSeed } : {}),
    };

    const fractionSlicedHistorical = sliceHistoricalWindow(inSampleHistorical, assetOptions);
    // Cap the evaluation window to the last N bars AFTER the holdout trim and
    // fraction slice, so `evalLastBars` composes with `oosIgnoreLastBars`:
    // N=1000 + holdout=1000 evaluates bars [-2000, -1001]. Shorter datasets
    // keep all their bars before the gap (slice(-N) semantics).
    const slicedHistorical = evalLastBars > 0
        ? fractionSlicedHistorical.slice(-evalLastBars)
        : fractionSlicedHistorical;
    diagnostics.slicedHistoricalBars = slicedHistorical.length;
    diagnostics.timingsMs.preparation = performance.now() - preparationStartedAt;
    if (slicedHistorical.length === 0) {
        return finish({ kind: "failed", symbol, reason: "historical window empty after data slice" });
    }

    // The fresh-entry recheck re-executes each top-K candidate only when the
    // recheck window differs from the in-sample window. With dataSlice "all",
    // `slicedHistorical` is a verbatim copy of `inSampleHistorical`; when that
    // also matches the recheck window (always in fixed-holdout mode; in
    // no-holdout mode when the application candle was included above), the
    // retained in-sample signals are sufficient and the re-execution is
    // skipped. A fixed holdout with a recency cap is also safe for fixed-horizon
    // next-bar models: the capped in-sample window is a suffix ending at the
    // same boundary, and fresh detection only reads signals from the latest
    // one or two boundary bars. `next_exit` intentionally keeps the full
    // execution-aware recheck path because signal-only reuse cannot see
    // position-capacity or cooldown gates.
    const recheckData = oosIgnoreLastBars > 0 ? visibleValidationData : fullClosed;
    const sameSignalBoundary = slicedHistorical.length > 0
        && recheckData.length > slicedHistorical.length
        && timeKey(slicedHistorical[slicedHistorical.length - 1]!.time)
            === timeKey(recheckData[recheckData.length - 1]!.time);
    // Exit overrides affect trade exits, while the retained signals exposed by
    // the IS search are primary entry signals. They therefore do not prevent
    // this signal-only freshness reuse.
    const canReuseCappedNextBarSignals = executionModel !== "signal_close"
        && !needsExecutableFreshRecheck
        && oosIgnoreLastBars > 0
        && evalLastBars > 0
        && (input.options.dataSlice ?? "all") === "all"
        && sameSignalBoundary
        && !input.dataFetcher
        && !selectedStrategy.strategy.crossSymbolConfig
        && !selectedStrategy.strategy.polymarket1sConfig
        && input.settings.strategyTimeframeEnabled !== true
        && !(input.settings.confirmationStrategies?.length);
    const canReuseFreshSignals = (input.options.dataSlice ?? "all") === "all"
        && (recheckData.length === slicedHistorical.length || canReuseCappedNextBarSignals);
    const canReuseIsSignalsForFresh = canReuseIsSignalsForFreshModel && canReuseFreshSignals;

    // A random search with one candidate has no ranking decision to preserve.
    // Probe that candidate on the same bounded freshness window used by the
    // later recheck first; a non-fresh probe proves that the historical pass
    // cannot produce an Asset Opportunity result. Keep this server-only and
    // execution-aware so the browser path and multi-candidate ranking remain
    // unchanged.
    const canPrecheckFreshEntry = input.precheckFreshEntry === true
        && input.options.mode === "random"
        && Number(input.options.maxRuns) <= 1
        && executionModel !== "signal_close"
        && (input.options.dataSlice ?? "all") === "all"
        && !input.dataFetcher
        && !selectedStrategy.strategy.crossSymbolConfig
        && !selectedStrategy.strategy.polymarket1sConfig
        && input.settings.strategyTimeframeEnabled !== true
        && !(input.settings.confirmationStrategies?.length);
    const freshEntryPrecheck: AssetOpportunityFreshEntryPrecheck | undefined = canPrecheckFreshEntry
        ? async ({ entryParams, exitStrategyKey, exitStrategyParams }) => {
            const candidate: FinderResult = {
                key: selectedStrategy.key,
                name: selectedStrategy.name,
                params: entryParams,
                ...(exitStrategyKey
                    ? { exitStrategyKey, exitStrategyParams: exitStrategyParams ?? {} }
                    : {}),
                result: createEmptyBacktestResult(),
                selectionResult: createEmptyBacktestResult(),
                endpointAdjusted: false,
                endpointRemovedTrades: 0,
            };
            const boundedNextExitReplayBars = needsExecutableFreshRecheck
                ? resolveBoundedNextExitReplayBars(input.settings, [candidate])
                : null;
            const signalData = resolveFreshSignalWindow({
                boundaryData: recheckData,
                slicedHistorical,
                signalLookbackBars: needsExecutableFreshRecheck
                    ? (boundedNextExitReplayBars ?? 0)
                    : Math.max(2, resolveAssetOpportunityFreshnessBars(input.settings) + 1),
                dataSlice: input.options.dataSlice ?? "all",
                candidates: [candidate],
                settings: input.settings,
                crossSymbol: false,
                canUseBoundedSignalWindow: (
                    !needsExecutableFreshRecheck
                    || boundedNextExitReplayBars !== null
                ),
            });
            if (!signalData) {
                return {
                    fresh: true,
                    skipped: true,
                    engineUsed: "typescript",
                    rustAttempted: false,
                };
            }
            const evaluation = await regenerateSignalsAndDetectFresh({
                candidate,
                strategy: preparedStrategy,
                fullClosed: recheckData,
                signalData,
                ...(needsExecutableFreshRecheck ? { replayData: signalData } : {}),
                symbol,
                interval: input.interval,
                settings: input.settings,
                capitalSettings: input.capitalSettings,
                options: assetOptions,
                exitStrategyCandidates: input.exitStrategyCandidates,
                exitSignalCache,
                useRustEnginePreference: input.useRustEnginePreference,
                rustDiagnosticPhase: "fresh_entry",
                rustCapabilities: input.rustCapabilities,
                signal: input.signal,
                primarySignalPrefilter: true,
            });
            return {
                fresh: evaluation.freshStatus === "fresh",
                engineUsed: evaluation.engineUsed,
                rustAttempted: evaluation.rustAttempted,
                ...(evaluation.typescriptReason
                    ? { typescriptReason: evaluation.typescriptReason }
                    : {}),
            };
        }
        : undefined;

    // 5. Run the in-sample search on the historical window. The `runIsSearch`
    // seam decouples this leaf from the browser-bound `finder-runner` module.
    const inSampleStartedAt = performance.now();
    const finderOutput = await input.runIsSearch({
        ohlcvData: slicedHistorical,
        symbol,
        interval: input.interval,
        options: assetOptions,
        settings: input.settings,
        capitalSettings: input.capitalSettings,
        selectedStrategies: [selectedStrategy],
        exitStrategyCandidates: input.exitStrategyCandidates,
        generateParamSets: input.generateParamSets,
        isCancelled: callbacks.isCancelled,
        yieldControl: callbacks.yieldControl,
        retainSignals: canReuseFreshSignals,
        fullSignalData: fullClosed,
        ...(input.signalCache ? { signalCache: input.signalCache } : {}),
        exitSignalCache,
        signal: input.signal,
        ...(freshEntryPrecheck ? { freshEntryPrecheck } : {}),
    });
    diagnostics.timingsMs.inSampleSearch = performance.now() - inSampleStartedAt;
    diagnostics.candidatesEvaluated = finderOutput.totalCandidatesEvaluated ?? finderOutput.results.length;
    diagnostics.candidateEvaluationsAttempted = finderOutput.candidateEvaluationsAttempted ?? finderOutput.results.length;
    diagnostics.candidateEvaluationsCompleted = finderOutput.candidateEvaluationsCompleted ?? finderOutput.results.length;
    diagnostics.candidateEvaluationFailures = finderOutput.candidateEvaluationFailures ?? 0;
    diagnostics.signalCacheHits = finderOutput.signalCacheHits ?? 0;
    diagnostics.signalCacheMisses = finderOutput.signalCacheMisses ?? 0;
    if (finderOutput.timingsMs) {
        diagnostics.timingsMs.parameterGeneration = finderOutput.timingsMs.parameterGeneration;
        diagnostics.timingsMs.candidateBacktests = finderOutput.timingsMs.backtest;
        diagnostics.timingsMs.yielding = finderOutput.timingsMs.yielding;
    }
    if (finderOutput.engineUsage) {
        mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, finderOutput.engineUsage);
    }
    if (finderOutput.freshEntryPrecheck && !finderOutput.freshEntryPrecheck.fresh) {
        diagnostics.freshEntryRechecks = 1;
        diagnostics.freshEntryExecutions = 1;
        diagnostics.timingsMs.freshEntryRechecks = finderOutput.timingsMs?.backtest ?? 0;
        const precheck = finderOutput.freshEntryPrecheck;
        mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, {
            rustAttemptedRuns: precheck.rustAttempted ? 1 : 0,
            rustCompletedRuns: precheck.engineUsed === "rust" ? 1 : 0,
            rustFallbackRuns: precheck.engineUsed === "typescript" && precheck.rustAttempted ? 1 : 0,
            typescriptCompletedRuns: precheck.engineUsed === "typescript" ? 1 : 0,
            typescriptReasons: precheck.typescriptReason
                ? [{ reason: precheck.typescriptReason, runs: 1 }]
                : [],
        });
    }

    const eligibleCandidateIndexes = finderOutput.results
        .map((candidate, index) => matchesFinderTradeCountFilter(candidate.selectionResult.totalTrades, assetOptions) ? index : -1)
        .filter((index): index is number => index >= 0);
    const topK = eligibleCandidateIndexes.map((index) => finderOutput.results[index]!);
    const totalCandidatesEvaluated = Math.max(
        topK.length,
        finderOutput.totalCandidatesEvaluated ?? topK.length,
    );
    if (topK.length === 0) {
        diagnostics.candidatesEvaluated = totalCandidatesEvaluated;
        return finish({ kind: "no_fresh_entry", symbol, candidatesEvaluated: totalCandidatesEvaluated, bestHistoricalRank: null });
    }

    // With an explicit recency-bounded evaluation, the historical ranking
    // window is intentionally shorter than the visible boundary. Generate
    // fresh signals on that recent window plus conservative indicator warmup,
    // then replay them on either the full boundary or a safely bounded recent
    // window. Cross-symbol strategies stay on the exact full-data path because
    // their secondary alignment has no equivalent bounded-window contract.
    const boundedNextExitReplayBars = needsExecutableFreshRecheck
        ? resolveBoundedNextExitReplayBars(input.settings, topK)
        : null;
    const freshSignalData = resolveFreshSignalWindow({
        boundaryData: recheckData,
        slicedHistorical,
        // signal_close and next_exit replay need the full boundary timeline
        // to reconstruct the latest trade unless a finite max-hold bounds the
        // required execution state. Fixed-horizon next-bar detection only
        // needs the accepted freshness range (0..1 bars) plus warmup.
        signalLookbackBars: needsExecutableFreshRecheck
            ? (boundedNextExitReplayBars ?? 0)
            : executionModel === "signal_close"
                ? evalLastBars
                : Math.max(2, resolveAssetOpportunityFreshnessBars(input.settings) + 1),
        dataSlice: input.options.dataSlice ?? "all",
        candidates: topK,
        settings: input.settings,
        crossSymbol: Boolean(input.dataFetcher || selectedStrategy.strategy.crossSymbolConfig),
        // signal_close and next_exit consume replayed trades. Fixed-horizon
        // next_open/next_close only consume generated signals, so their
        // signal-only recheck can safely use the same bounded recent window.
        // A bounded next-exit replay is
        // also exact when max-hold/cooldown bound all prior execution state.
        canUseBoundedSignalWindow: (
            !needsExecutableFreshRecheck
            && executionModel !== "signal_close"
        ) || (
            needsExecutableFreshRecheck
            && boundedNextExitReplayBars !== null
        ),
    });
    diagnostics.freshSignalWindowBars = freshSignalData?.length ?? 0;

    // 7. Re-generate signals for each top-K candidate on the visible boundary
    // data. In validation mode this ends before the hidden OOS window; with no
    // holdout it retains the normal full-closed application-candle behavior.
    // When the boundary window is identical to the in-sample window (see
    // `canReuseIsSignalsForFresh`), the in-sample run's retained signals are
    // reused instead of re-executing every candidate on the same bars.
    const freshStartedAt = performance.now();
    const retainedFreshSignals = canReuseFreshSignals && finderOutput.signalsByCandidate
        ? eligibleCandidateIndexes.map((index) => finderOutput.signalsByCandidate![index] ?? [])
        : undefined;
    const retainedSignals = canReuseIsSignalsForFresh ? retainedFreshSignals : undefined;
    const freshRecheckConcurrency = input.useRustEnginePreference === true
        ? 1
        : ASSET_FRESH_RECHECK_CONCURRENCY;
    const freshEvaluations: AssetFreshEvaluation[] = retainedSignals
        ? topK.map((_candidate, candidateIndex) => detectFreshFromRetainedSignals({
            signals: retainedSignals[candidateIndex] ?? [],
            candles: recheckData,
            settings: input.settings,
        }))
        // Bounded concurrency: up to 6 simultaneous regenerations instead of
        // one per pool candidate (50). Indexed result storage keeps the
        // output order identical to the old Promise.all path. Cancellation is
        // checked between tasks so Stop does not drain the whole pool.
        : await mapWithConcurrencyLimit(
            topK,
            // next_exit always uses the generic execution-aware replay.
            needsExecutableFreshRecheck
                ? 1
                : freshRecheckConcurrency,
            (candidate) => {
                if (input.signal?.aborted) throwAbortError();
                if (callbacks.isCancelled()) {
                    throw new Error("Finder stopped.");
                }
                return regenerateSignalsAndDetectFresh({
                    candidate,
                    strategy: preparedStrategy,
                    fullClosed: recheckData,
                    ...(freshSignalData ? { signalData: freshSignalData } : {}),
                    ...(needsExecutableFreshRecheck && freshSignalData
                        ? { replayData: freshSignalData }
                        : {}),
                    symbol,
                    interval: input.interval,
                    settings: input.settings,
                    capitalSettings: input.capitalSettings,
                    options: assetOptions,
                    exitStrategyCandidates: input.exitStrategyCandidates,
                    exitSignalCache,
                    dataFetcher: input.dataFetcher,
                    useRustEnginePreference: input.useRustEnginePreference,
                    rustDiagnosticPhase: "fresh_entry",
                    rustCapabilities: input.rustCapabilities,
                    signal: input.signal,
                });
            },
        );
    diagnostics.timingsMs.freshEntryRechecks = performance.now() - freshStartedAt;
    diagnostics.freshEntryRechecks = freshEvaluations.length;
    const freshByCandidate = freshEvaluations.map((evaluation) => {
        // Reused detections executed nothing; they must not inflate the
        // engine-usage counters.
        if (evaluation.signalsReused !== true) {
            diagnostics.freshEntryExecutions += 1;
            mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, {
                rustAttemptedRuns: evaluation.rustAttempted ? 1 : 0,
                rustCompletedRuns: evaluation.engineUsed === "rust" ? 1 : 0,
                rustFallbackRuns: evaluation.engineUsed === "typescript" && evaluation.rustAttempted ? 1 : 0,
                typescriptCompletedRuns: evaluation.engineUsed === "typescript" ? 1 : 0,
                typescriptReasons: evaluation.typescriptReason
                    ? [{ reason: evaluation.typescriptReason, runs: 1 }]
                    : [],
            });
        }
        const {
            engineUsed: _engineUsed,
            rustAttempted: _rustAttempted,
            typescriptReason: _typescriptReason,
            signalsReused: _signalsReused,
            ...fresh
        } = evaluation;
        return fresh;
    });

    // Pre-resolve the legacy complementary OOS window once (cheap slice +
    // closed-candle build) so the per-winner OOS step below does not repeat it.
    // It must be based on the IS window when a fixed holdout is configured, so
    // the holdout remains untouched by candidate validation.
    const oosStartedAt = performance.now();
    let oosWindowData: OHLCVData[] = [];
    if (input.options.oosValidationEnabled) {
        const oosSlice = resolveOosDataSlice(input.options.dataSlice ?? "all");
        if (oosSlice) {
            oosWindowData = buildFinderEvaluationData(
                sliceFinderDataWindow(inSampleHistorical, oosSlice),
                input.interval,
                input.settings,
            );
            diagnostics.oosBars = Math.max(diagnostics.oosBars, oosWindowData.length);
        }
    }

    // Reduce WITHOUT OOS first. The winner is chosen by fresh rank alone (OOS
    // never changes which candidate wins — it only gates the grade), so the
    // OOS pass can be deferred to run for the single winner below.
    const reductionStartedAt = performance.now();
    const { result } = reduceAssetTopKToResult({
        symbol,
        strategyKey: selectedStrategy.key,
        strategyName: selectedStrategy.name,
        options: input.options,
        minFreshSupport: input.minFreshSupport,
        topK,
        totalCandidatesEvaluated,
        freshByCandidate,
    });
    diagnostics.timingsMs.resultReduction = performance.now() - reductionStartedAt;

    if (!result) {
        diagnostics.timingsMs.oosValidation = performance.now() - oosStartedAt;
        return finish({
            kind: "no_fresh_entry",
            symbol,
            candidatesEvaluated: totalCandidatesEvaluated,
            bestHistoricalRank: 1,
        });
    }

    // The server IS path intentionally keeps candidate results scalar. When
    // that compact result has enough trades to qualify for the metric, replay
    // only the selected winner on the exact IS window with trade history
    // retained long enough to calculate the historical TP timing scalar.
    const winnerIndex = result.historicalRank - 1;
    const winnerCandidate = topK[winnerIndex];
    const winnerFresh = freshEvaluations[winnerIndex];
    const selectionTrades = Array.isArray(result.selectionResult.trades)
        ? result.selectionResult.trades
        : [];
    let derivedMetrics = calculateAssetOpportunityDerivedMetrics({
        result: result.selectionResult,
        candles: slicedHistorical,
        freshEntryPrice: winnerFresh?.freshEntryPrice ?? null,
    });
    if (
        selectionTrades.length === 0
        && result.selectionResult.totalTrades >= MEDIAN_BARS_TO_TP_MIN_HITS
        && winnerCandidate
    ) {
        try {
            const winnerStartedAt = performance.now();
            const winnerSelection = await executeAssetCandidate({
                candidate: winnerCandidate,
                strategy: preparedStrategy,
                data: slicedHistorical,
                symbol,
                interval: input.interval,
                settings: input.settings,
                capitalSettings: input.capitalSettings,
                options: assetOptions,
                exitStrategyCandidates: input.exitStrategyCandidates,
                dataFetcher: input.dataFetcher,
                useRustEnginePreference: input.useRustEnginePreference,
                rustDiagnosticPhase: "winner_analytics",
                rustCapabilities: input.rustCapabilities,
                typescriptSimulationConcurrency: input.typescriptSimulationConcurrency,
                signal: input.signal,
            });
            const preResolvedCapital = resolveCapitalSettingsFromRaw(
                input.capitalSettings as unknown as Record<string, unknown>,
            );
            const selection = buildSelectionResult(
                winnerSelection.result,
                slicedHistorical[slicedHistorical.length - 1]?.time ?? null,
                preResolvedCapital.initialCapital,
            );
            derivedMetrics = calculateAssetOpportunityDerivedMetrics({
                result: selection.result,
                candles: slicedHistorical,
                freshEntryPrice: winnerFresh?.freshEntryPrice ?? null,
            });
            diagnostics.winnerAnalyticsRecomputations += 1;
            diagnostics.timingsMs.winnerAnalytics += performance.now() - winnerStartedAt;
            mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, {
                rustAttemptedRuns: winnerSelection.engineDiagnostics?.rustAttempted ? 1 : 0,
                rustCompletedRuns: winnerSelection.engineUsed === "rust" ? 1 : 0,
                rustFallbackRuns: winnerSelection.engineUsed === "typescript"
                    && winnerSelection.engineDiagnostics?.rustAttempted === true
                    ? 1
                    : 0,
                typescriptCompletedRuns: winnerSelection.engineUsed === "typescript" ? 1 : 0,
                typescriptReasons: winnerSelection.engineUsed === "typescript"
                    && winnerSelection.engineDiagnostics?.typescriptReason
                    ? [{ reason: winnerSelection.engineDiagnostics.typescriptReason, runs: 1 }]
                    : [],
            });
        } catch (error) {
            if (input.signal?.aborted || isAbortError(error)) throw error;
            debugLogger.warn("finder.asset_opportunity.derived_metrics_failed", {
                symbol,
                strategyKey: winnerCandidate.key,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // Run OOS only for the winner. The reducer previously ran OOS for all K
    // candidates but only consumed the winner's verdict in `decideAssetGrade`;
    // the other K-1 OOS backtests were computed and discarded. The grade is
    // recomputed here with the winner's verdict attached.
    let finalResult = {
        ...result,
        ...derivedMetrics,
        priorTupleRecurrenceCount: 0,
    };
    if (fixedOosBars.length > 0 && oosMeasurementMode === "fixed_horizon") {
        const winnerFresh = freshEvaluations[winnerIndex];
        const firstHiddenBar = fixedOosBars[0];
        const freshEntryPrice = winnerFresh?.freshEntryPrice ?? Number.NaN;
        const entryPrice = input.settings.executionModel === "signal_close"
            ? winnerFresh?.latestSignalPrice ?? Number.NaN
            : Number.isFinite(freshEntryPrice)
                ? freshEntryPrice
                : input.settings.executionModel === "next_open"
                    ? firstHiddenBar?.open ?? Number.NaN
                    : firstHiddenBar?.close ?? Number.NaN;
        if (winnerCandidate && winnerFresh?.direction && Number.isFinite(entryPrice)) {
            diagnostics.oosEvaluations += 1;
            diagnostics.fixedHorizonEvaluations += 1;
            const oosHorizonMetrics = calculateFinderAssetOosSignalMetrics({
                candles: fullClosed,
                signalIndex: fixedOosSignalIndex,
                entryPrice,
                direction: winnerFresh.direction,
                ignoreLastBars: oosIgnoreLastBars,
                horizons: oosHorizons,
            });
            finalResult = {
                ...finalResult,
                oosHorizonMetrics,
            };
        }
    }
    if (fixedOosBars.length > 0 && oosMeasurementMode === "next_exit") {
        const winnerFresh = freshEvaluations[winnerIndex];
        if (winnerCandidate && winnerFresh?.direction) {
            diagnostics.oosEvaluations += 1;
            diagnostics.nextExitEvaluations += 1;
            // The fresh-entry detector accepts a one-bar-old signal for
            // next-bar execution. That signal can fill on the last visible
            // candle, so the boundary entry is the signal candle plus the
            // model's execution shift rather than always the first hidden
            // candle.
            const latestSignalSeconds = parseTimeToUnixSeconds(winnerFresh.latestSignalTime);
            const signalIndex = latestSignalSeconds === null
                ? -1
                : fullClosed.findIndex((candle) =>
                    parseTimeToUnixSeconds(candle.time) === latestSignalSeconds);
            const fillIndex = signalIndex >= 0
                ? signalIndex + (winnerFresh.fillTiming === "signal_close" ? 0 : 1)
                : -1;
            const boundaryEntryTime = fillIndex >= 0
                ? fullClosed[fillIndex]?.time ?? null
                : null;
            const boundedNextExitOosReplayData = !input.dataFetcher
                && !selectedStrategy.strategy.crossSymbolConfig
                && !selectedStrategy.strategy.polymarket1sConfig
                && input.settings.strategyTimeframeEnabled !== true
                && !(input.settings.confirmationStrategies?.length)
                ? resolveBoundedNextExitOosReplayData({
                    fullClosed,
                    hiddenBars: oosIgnoreLastBars,
                    candidates: [winnerCandidate],
                    settings: input.settings,
                })
                : undefined;
            const winnerNextExit = await runCandidateNextExitOnAsset({
                candidate: winnerCandidate,
                strategy: preparedStrategy,
                symbol,
                fullClosed,
                ...(boundedNextExitOosReplayData
                    ? { replayData: boundedNextExitOosReplayData }
                    : {}),
                boundaryEntryTime,
                direction: winnerFresh.direction,
                interval: input.interval,
                settings: input.settings,
                capitalSettings: input.capitalSettings,
                options: assetOptions,
                exitStrategyCandidates: input.exitStrategyCandidates,
                exitSignalCache,
                dataFetcher: input.dataFetcher,
                useRustEnginePreference: input.useRustEnginePreference,
                rustDiagnosticPhase: "next_exit",
                rustCapabilities: input.rustCapabilities,
                typescriptSimulationConcurrency: input.typescriptSimulationConcurrency,
                signal: input.signal,
            });
            mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, {
                rustAttemptedRuns: winnerNextExit.rustAttempted ? 1 : 0,
                rustCompletedRuns: winnerNextExit.engineUsed === "rust" ? 1 : 0,
                rustFallbackRuns: winnerNextExit.engineUsed === "typescript" && winnerNextExit.rustAttempted ? 1 : 0,
                typescriptCompletedRuns: winnerNextExit.engineUsed === "typescript" ? 1 : 0,
                typescriptReasons: winnerNextExit.typescriptReason
                    ? [{ reason: winnerNextExit.typescriptReason, runs: 1 }]
                    : [],
            });
            finalResult = {
                ...finalResult,
                oosNextExitMetrics: winnerNextExit.metrics,
            };
        }
    }
    if (oosWindowData.length > 0) {
        if (winnerCandidate) {
            // Additive: a fixed-holdout evaluation may already have been
            // counted above; both modes can be active for the same asset.
            diagnostics.oosEvaluations += 1;
            diagnostics.complementaryOosEvaluations += 1;
            const winnerOos = await runCandidateOosOnAsset({
                candidate: winnerCandidate,
                strategy: preparedStrategy,
                symbol,
                oosData: oosWindowData,
                interval: input.interval,
                settings: input.settings,
                capitalSettings: input.capitalSettings,
                options: assetOptions,
                exitStrategyCandidates: input.exitStrategyCandidates,
                exitSignalCache,
                dataFetcher: input.dataFetcher,
                useRustEnginePreference: input.useRustEnginePreference,
                rustDiagnosticPhase: "complementary_oos",
                rustCapabilities: input.rustCapabilities,
                typescriptSimulationConcurrency: input.typescriptSimulationConcurrency,
                signal: input.signal,
            });
            mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, {
                rustAttemptedRuns: winnerOos.rustAttempted ? 1 : 0,
                rustCompletedRuns: winnerOos.engineUsed === "rust" ? 1 : 0,
                rustFallbackRuns: winnerOos.engineUsed === "typescript" && winnerOos.rustAttempted ? 1 : 0,
                typescriptCompletedRuns: winnerOos.engineUsed === "typescript" ? 1 : 0,
                typescriptReasons: winnerOos.typescriptReason
                    ? [{ reason: winnerOos.typescriptReason, runs: 1 }]
                    : [],
            });
            // Recompute the grade with the OOS verdict attached. The other
            // grade inputs are unchanged from the no-OOS reduction above.
            const minHistoricalTrades = assetOptions.tradeFilterEnabled ? assetOptions.minTrades : 0;
            const regraded = decideAssetGrade({
                hasFreshEntry: true,
                hasPositiveExpectancy: Number.isFinite(result.selectionResult.expectancy)
                    ? result.selectionResult.expectancy > 0
                    : false,
                historicalTrades: result.selectionResult.totalTrades,
                sameDirectionSupport: result.support.freshSameDirection,
                minHistoricalTrades,
                minFreshSupport: input.minFreshSupport,
                oosVerdict: winnerOos.verdict,
            });
            finalResult = {
                ...finalResult,
                oosResult: winnerOos.result,
                oosVerdict: winnerOos.verdict,
                grade: regraded,
            };
        }
    }
    diagnostics.timingsMs.oosValidation = performance.now() - oosStartedAt;

    if (
        input.recomputeWinnerAnalytics === true
        && !finderAssetSearchRequiresFullAnalytics(input.options.sortPriority)
    ) {
        const winner = topK[result.historicalRank - 1];
        if (winner) {
            // Displayed winner metrics stay on the historical window (which
            // excludes the reserved application candle) even when the search
            // window included it.
            const winnerAnalyticsData = includeApplicationCandleInSearch ? historical : slicedHistorical;
            const winnerStartedAt = performance.now();
            const winnerEvaluation = await executeAssetCandidate({
                candidate: winner,
                strategy: preparedStrategy,
                data: winnerAnalyticsData,
                symbol,
                interval: input.interval,
                settings: input.settings,
                capitalSettings: input.capitalSettings,
                options: assetOptions,
                exitStrategyCandidates: input.exitStrategyCandidates,
                dataFetcher: input.dataFetcher,
                useRustEnginePreference: input.useRustEnginePreference,
                rustDiagnosticPhase: "winner_analytics",
                rustCapabilities: input.rustCapabilities,
                signal: input.signal,
                fullAnalytics: true,
            });
            const preResolvedCapital = resolveCapitalSettingsFromRaw(
                input.capitalSettings as unknown as Record<string, unknown>,
            );
            const selection = buildSelectionResult(
                winnerEvaluation.result,
                winnerAnalyticsData[winnerAnalyticsData.length - 1]?.time ?? null,
                preResolvedCapital.initialCapital,
            );
            // Spread `finalResult` (not `result`) so the OOS overlay from the
            // winner-only pass above is preserved when we replace the
            // selection result here.
            finalResult = {
                ...finalResult,
                selectionResult: selection.result,
            };
            diagnostics.winnerAnalyticsRecomputations += 1;
            diagnostics.timingsMs.winnerAnalytics += performance.now() - winnerStartedAt;
            mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, {
                rustAttemptedRuns: winnerEvaluation.engineDiagnostics?.rustAttempted ? 1 : 0,
                rustCompletedRuns: winnerEvaluation.engineUsed === "rust" ? 1 : 0,
                rustFallbackRuns: winnerEvaluation.engineUsed === "typescript"
                    && winnerEvaluation.engineDiagnostics?.rustAttempted === true
                    ? 1
                    : 0,
                typescriptCompletedRuns: winnerEvaluation.engineUsed === "typescript" ? 1 : 0,
                typescriptReasons: winnerEvaluation.engineUsed === "typescript"
                    && winnerEvaluation.engineDiagnostics?.typescriptReason
                    ? [{ reason: winnerEvaluation.engineDiagnostics.typescriptReason, runs: 1 }]
                    : [],
            });
        }
    }
    return finish({ kind: "opportunity", symbol, result: finalResult });
}

function mergeAssetOpportunityEngineUsage(
    target: AssetOpportunitySearchDiagnostics["engineUsage"],
    source: {
        rustAttemptedRuns: number;
        rustCompletedRuns: number;
        rustFallbackRuns: number;
        typescriptCompletedRuns: number;
        typescriptReasons: Array<{ reason: string; runs: number }>;
    },
): void {
    target.rustAttemptedRuns += source.rustAttemptedRuns;
    target.rustCompletedRuns += source.rustCompletedRuns;
    target.rustFallbackRuns += source.rustFallbackRuns;
    target.typescriptCompletedRuns += source.typescriptCompletedRuns;
    for (const entry of source.typescriptReasons) {
        const existing = target.typescriptReasons.find((candidate) => candidate.reason === entry.reason);
        if (existing) existing.runs += entry.runs;
        else target.typescriptReasons.push({ ...entry });
    }
}

function resolveAssetOpportunityFreshnessBars(settings: BacktestSettings): number {
    return settings.executionModel === "signal_close" ? 0 : 1;
}

/**
 * One candidate's fresh-entry evaluation, whether produced by re-executing the
 * candidate (`regenerateSignalsAndDetectFresh`) or by reusing the in-sample
 * run's retained signals (`detectFreshFromRetainedSignals`).
 */
type AssetFreshEvaluation = {
    freshStatus: "fresh" | "active" | "flat";
    direction: FinderAssetDirection | null;
    latestSignalTime: Time | null;
    signalAgeBars: number;
    fillTiming: "signal_close" | "next_open" | "next_close";
    isOpen: boolean;
    latestTradeEntryTime: number | null;
    latestSignalPrice: number | null;
    /** Modeled fill price of the fresh entry, when the fill candle exists. */
    freshEntryPrice: number | null;
    engineUsed: "rust" | "typescript";
    rustAttempted: boolean;
    typescriptReason?: string;
    /** True when derived from retained in-sample signals — nothing executed. */
    signalsReused?: boolean;
};

/**
 * Detect the fresh-entry status from signals retained by the in-sample search,
 * WITHOUT re-executing the candidate. The caller permits this only when the
 * windows are bar-for-bar identical, or when a fixed-holdout next-bar check
 * uses a capped suffix ending at the same boundary. `signal_close` remains
 * excluded because its recheck consumes a re-simulated trade list.
 *
 * Parity with `regenerateSignalsAndDetectFresh`: for non-`signal_close`
 * models the recheck runs `signalsOnly`, so `detectFreshEntry` sees an
 * empty-trades result. Reproduce that input exactly with an empty result —
 * passing the in-sample result (which may carry trades) would take a
 * different branch and could flip "fresh" to "active" for repeated
 * same-direction signals.
 */
function detectFreshFromRetainedSignals(args: {
    signals: Signal[];
    candles: OHLCVData[];
    settings: BacktestSettings;
}): AssetFreshEvaluation {
    const detected = detectFreshEntry({
        result: createEmptyBacktestResult(),
        candles: args.candles,
        settings: args.settings,
        signals: args.signals,
        freshnessBars: resolveAssetOpportunityFreshnessBars(args.settings),
    });
    return {
        freshStatus: detected.freshStatus,
        direction: detected.direction,
        latestSignalTime: detected.latestSignalTime,
        signalAgeBars: detected.signalAgeBars,
        fillTiming: detected.fillTiming ?? "signal_close",
        isOpen: detected.isOpen,
        latestTradeEntryTime: detected.latestTrade
            ? parseTimeToUnixSeconds(detected.latestTrade.entryTime)
            : null,
        latestSignalPrice: resolveLatestSignalPrice({
            signals: args.signals,
            candle: args.candles[args.candles.length - 1]!,
            direction: detected.direction,
            signalTime: detected.latestSignalTime,
            fallback: detected.latestTrade?.entryPrice ?? null,
        }),
        freshEntryPrice: resolveFreshEntryPrice({
            latestTrade: detected.latestTrade,
            candles: args.candles,
            settings: args.settings,
            signalTime: detected.latestSignalTime,
            signalPrice: resolveLatestSignalPrice({
                signals: args.signals,
                candle: args.candles[args.candles.length - 1]!,
                direction: detected.direction,
                signalTime: detected.latestSignalTime,
                fallback: null,
            }),
        }),
        engineUsed: "typescript",
        rustAttempted: false,
        signalsReused: true,
    };
}

function buildFreshEntryEvaluation(args: {
    result: BacktestResult;
    candles: OHLCVData[];
    settings: BacktestSettings;
    signals: Signal[];
    engineUsed: "rust" | "typescript";
    rustAttempted: boolean;
    typescriptReason?: string;
}): AssetFreshEvaluation {
    const detected = detectFreshEntry({
        result: args.result,
        candles: args.candles,
        settings: args.settings,
        signals: args.signals,
        freshnessBars: resolveAssetOpportunityFreshnessBars(args.settings),
    });
    return {
        freshStatus: detected.freshStatus,
        direction: detected.direction,
        latestSignalTime: detected.latestSignalTime,
        signalAgeBars: detected.signalAgeBars,
        fillTiming: detected.fillTiming ?? "signal_close",
        isOpen: detected.isOpen,
        latestTradeEntryTime: detected.latestTrade
            ? parseTimeToUnixSeconds(detected.latestTrade.entryTime)
            : null,
        latestSignalPrice: resolveLatestSignalPrice({
            signals: args.signals,
            candle: args.candles[args.candles.length - 1]!,
            direction: detected.direction,
            signalTime: detected.latestSignalTime,
            fallback: detected.latestTrade?.entryPrice ?? null,
        }),
        freshEntryPrice: resolveFreshEntryPrice({
            latestTrade: detected.latestTrade,
            candles: args.candles,
            settings: args.settings,
            signalTime: detected.latestSignalTime,
            signalPrice: resolveLatestSignalPrice({
                signals: args.signals,
                candle: args.candles[args.candles.length - 1]!,
                direction: detected.direction,
                signalTime: detected.latestSignalTime,
                fallback: null,
            }),
        }),
        engineUsed: args.engineUsed,
        rustAttempted: args.rustAttempted,
        ...(args.typescriptReason ? { typescriptReason: args.typescriptReason } : {}),
    };
}

/**
 * Re-run one candidate's strategy on the boundary data and detect the
 * fresh-entry status. Fixed-horizon non-signal-close paths may generate
 * signals on a bounded recent window first; next-exit always replays the full
 * boundary timeline so execution gates and the existing position state are
 * included in freshness, unless a finite max-hold/cooldown bound makes a
 * recent replay exact.
 *
 * Returns the parallel-array entry consumed by `reduceAssetTopKToResult`.
 */
async function regenerateSignalsAndDetectFresh(args: {
    candidate: FinderResult;
    strategy: Strategy;
    fullClosed: OHLCVData[];
    signalData?: OHLCVData[];
    replayData?: OHLCVData[];
    symbol: string;
    interval: string;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    options: FinderOptions;
    exitStrategyCandidates?: FinderSelectedStrategy[];
    exitSignalCache?: AssetCandidateExitSignalCache;
    dataFetcher?: CrossSymbolDataFetcher;
    useRustEnginePreference?: boolean;
    rustDiagnosticPhase?: RustDiagnosticPhase;
    rustCapabilities?: RustCapabilities;
    signal?: AbortSignal;
    /** Generate primary signals first so exit override work can be skipped. */
    primarySignalPrefilter?: boolean;
}): Promise<AssetFreshEvaluation> {
    const needsExecutableFreshRecheck = args.options.assetOpportunity?.oosMeasurementMode === "next_exit";
    const signalData = args.signalData ?? args.fullClosed;
    const replayData = args.replayData ?? signalData;
    const primarySignalPrefilter = args.primarySignalPrefilter === true && args.signalData !== undefined;
    let preGeneratedSignals: Signal[] | undefined;
    if (primarySignalPrefilter) {
        const primary = await executeAssetCandidate({
            candidate: args.candidate,
            strategy: args.strategy,
            data: signalData,
            symbol: args.symbol,
            interval: args.interval,
            settings: args.settings,
            capitalSettings: args.capitalSettings,
            options: args.options,
            exitStrategyCandidates: args.exitStrategyCandidates,
            exitSignalCache: args.exitSignalCache,
            dataFetcher: args.dataFetcher,
            useRustEnginePreference: args.useRustEnginePreference,
            rustDiagnosticPhase: args.rustDiagnosticPhase,
            rustCapabilities: args.rustCapabilities,
            signal: args.signal,
            signalOnly: true,
            ignoreExitOverride: true,
        });
        const primarySignals = alignSignalsToBoundary(primary.signals, args.fullClosed);
        const possibleFreshEntry = detectFreshEntry({
            result: createEmptyBacktestResult(),
            candles: args.fullClosed,
            settings: args.settings,
            signals: primarySignals,
            freshnessBars: resolveAssetOpportunityFreshnessBars(args.settings),
        });
        if (possibleFreshEntry.freshStatus !== "fresh") {
            return buildFreshEntryEvaluation({
                result: createEmptyBacktestResult(),
                candles: args.fullClosed,
                settings: args.settings,
                signals: primarySignals,
                engineUsed: primary.engineUsed,
                rustAttempted: primary.engineDiagnostics?.rustAttempted === true,
                ...(primary.engineDiagnostics?.typescriptReason
                    ? { typescriptReason: primary.engineDiagnostics.typescriptReason }
                    : {}),
            });
        }
        if (replayData === signalData) {
            preGeneratedSignals = primary.signals;
        }
    }
    return executeAssetCandidate({
        candidate: args.candidate,
        strategy: args.strategy,
        data: replayData,
        symbol: args.symbol,
        interval: args.interval,
        settings: args.settings,
        capitalSettings: args.capitalSettings,
        options: args.options,
        exitStrategyCandidates: args.exitStrategyCandidates,
        exitSignalCache: args.exitSignalCache,
        dataFetcher: args.dataFetcher,
        useRustEnginePreference: args.useRustEnginePreference,
        rustDiagnosticPhase: args.rustDiagnosticPhase,
        rustCapabilities: args.rustCapabilities,
        signal: args.signal,
        ...(preGeneratedSignals ? { preGeneratedSignals } : {}),
        signalOnly: args.settings.executionModel !== "signal_close" && !needsExecutableFreshRecheck,
    }).then(({ result, signals, engineUsed, engineDiagnostics }) => {
        const boundarySignals = args.signalData
            ? alignSignalsToBoundary(signals, args.fullClosed)
            : signals;
        const detected = detectFreshEntry({
            result,
            candles: args.fullClosed,
            settings: args.settings,
            signals: boundarySignals,
            freshnessBars: resolveAssetOpportunityFreshnessBars(args.settings),
        });
        return {
            freshStatus: detected.freshStatus,
            direction: detected.direction,
            latestSignalTime: detected.latestSignalTime,
            signalAgeBars: detected.signalAgeBars,
            fillTiming: detected.fillTiming ?? "signal_close",
            isOpen: detected.isOpen,
            latestTradeEntryTime: detected.latestTrade
                ? parseTimeToUnixSeconds(detected.latestTrade.entryTime)
                : null,
            latestSignalPrice: resolveLatestSignalPrice({
                signals: boundarySignals,
                candle: args.fullClosed[args.fullClosed.length - 1]!,
                direction: detected.direction,
                signalTime: detected.latestSignalTime,
                fallback: detected.latestTrade?.entryPrice ?? null,
            }),
            freshEntryPrice: resolveFreshEntryPrice({
                latestTrade: detected.latestTrade,
                candles: args.fullClosed,
                settings: args.settings,
                signalTime: detected.latestSignalTime,
                signalPrice: resolveLatestSignalPrice({
                    signals: boundarySignals,
                    candle: args.fullClosed[args.fullClosed.length - 1]!,
                    direction: detected.direction,
                    signalTime: detected.latestSignalTime,
                    fallback: null,
                }),
            }),
            engineUsed,
            rustAttempted: engineDiagnostics?.rustAttempted === true,
            ...(engineDiagnostics?.typescriptReason
                ? { typescriptReason: engineDiagnostics.typescriptReason }
                : {}),
        };
    });
}

function resolveLatestSignalPrice(args: {
    signals: Signal[];
    candle: OHLCVData;
    direction: FinderAssetDirection | null;
    signalTime?: Time | null;
    fallback: number | null;
}): number | null {
    const candleTimeSec = parseTimeToUnixSeconds(args.signalTime ?? args.candle.time);
    if (args.direction) {
        for (let index = args.signals.length - 1; index >= 0; index -= 1) {
            const signal = args.signals[index]!;
            const signalTimeSec = parseTimeToUnixSeconds(signal.time);
            if (signalTimeSec === null || candleTimeSec === null || signalTimeSec !== candleTimeSec) continue;
            if (args.direction === "long" && signal.type === "buy") return signal.price;
            if (args.direction === "short" && signal.type === "sell") return signal.price;
        }
    }
    return args.fallback;
}

function resolveFreshEntryPrice(args: {
    latestTrade: BacktestResult["trades"][number] | null;
    candles: OHLCVData[];
    settings: BacktestSettings;
    signalTime: Time | null;
    signalPrice: number | null;
}): number | null {
    if (args.signalTime === null) {
        return args.latestTrade && Number.isFinite(args.latestTrade.entryPrice)
            ? args.latestTrade.entryPrice
            : null;
    }
    const signalSeconds = parseTimeToUnixSeconds(args.signalTime);
    if (signalSeconds === null) return null;
    const signalIndex = args.candles.findIndex((candle) => parseTimeToUnixSeconds(candle.time) === signalSeconds);
    if (signalIndex < 0) return null;
    const fillIndex = signalIndex + (args.settings.executionModel === "signal_close" ? 0 : 1);
    const entryIndex = args.latestTrade
        ? args.candles.findIndex((candle) =>
            parseTimeToUnixSeconds(candle.time) === parseTimeToUnixSeconds(args.latestTrade!.entryTime))
        : -1;
    if (args.latestTrade && entryIndex === fillIndex && Number.isFinite(args.latestTrade.entryPrice)) {
        return args.latestTrade.entryPrice;
    }
    if (args.settings.executionModel === "signal_close") {
        return args.signalPrice !== null && Number.isFinite(args.signalPrice) ? args.signalPrice : null;
    }
    const fillCandle = args.candles[fillIndex];
    if (!fillCandle) return null;
    const price = args.settings.executionModel === "next_open" ? fillCandle.open : fillCandle.close;
    return Number.isFinite(price) ? price : null;
}

async function executeAssetCandidate(args: {
    candidate: FinderResult;
    strategy: Strategy;
    data: OHLCVData[];
    symbol: string;
    interval: string;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    options: FinderOptions;
    exitStrategyCandidates?: FinderSelectedStrategy[];
    exitSignalCache?: AssetCandidateExitSignalCache;
    dataFetcher?: CrossSymbolDataFetcher;
    useRustEnginePreference?: boolean;
    rustDiagnosticPhase?: RustDiagnosticPhase;
    rustCapabilities?: RustCapabilities;
    signal?: AbortSignal;
    typescriptSimulationConcurrency?: TypescriptSimulationConcurrencyTracker;
    signalOnly?: boolean;
    ignoreExitOverride?: boolean;
    preGeneratedSignals?: Signal[];
    fullAnalytics?: boolean;
}): Promise<{
    result: BacktestResult;
    candles: OHLCVData[];
    signals: Signal[];
    engineUsed: "rust" | "typescript";
    engineDiagnostics?: {
        rustAttempted: boolean;
        typescriptReason?: string;
    };
}> {
    const exitStrategyKey = args.candidate.exitStrategyKey;
    const useExitOverride = args.ignoreExitOverride !== true && exitStrategyKey !== undefined;
    const combinedParams = args.ignoreExitOverride === true
        ? args.candidate.params
        : withExitStrategyBaseParams(args.candidate.params, args.candidate.exitStrategyParams ?? {});
    const exitStrategy = useExitOverride
        ? args.exitStrategyCandidates?.find((candidate) => candidate.key === exitStrategyKey)?.strategy
        : undefined;
    const normalizedParams = normalizeFinderCandidateParams(
        args.strategy,
        combinedParams,
        exitStrategy?.normalizeParams
            ? { normalizeExitParams: exitStrategy.normalizeParams }
            : undefined,
    );
    // Shared candidate execution (risk overrides, exit override injection,
    // executor settings, and the compact/trade-history option matrix) lives in
    // `finder-asset-candidate-execution.ts`, kept in parity with the server IS
    // search's per-candidate loop (`server-asset-is-search.ts`).
    const output = await runAssetCandidateBacktest({
        data: args.data,
        symbol: args.symbol,
        interval: args.interval,
        strategy: args.strategy,
        strategyKey: args.candidate.key,
        strategyParams: args.candidate.params,
        riskOverrideParams: normalizedParams,
        settings: args.settings,
        capitalSettings: args.capitalSettings,
        options: args.options,
        ...(useExitOverride
            ? {
                exitOverride: {
                    key: exitStrategyKey,
                    params: args.candidate.exitStrategyParams ?? {},
                },
            }
            : {}),
        ...(args.dataFetcher ? { dataFetcher: args.dataFetcher } : {}),
        ...(args.exitSignalCache ? { exitSignalCache: args.exitSignalCache } : {}),
        signal: args.signal,
        useRustEnginePreference: args.useRustEnginePreference,
        rustDiagnosticPhase: args.rustDiagnosticPhase,
        rustCapabilities: args.rustCapabilities,
        typescriptSimulationConcurrency: args.typescriptSimulationConcurrency,
        ...(args.strategy.crossSymbolConfig ? {} : { closedCandleDataOverride: args.data }),
        ...(args.preGeneratedSignals ? { preGeneratedSignals: args.preGeneratedSignals } : {}),
        needs: {
            // Asset Opportunity retains scalar winner metrics plus trades for
            // endpoint adjustment. The compact engine avoids constructing the
            // full equity-curve result and post-processing analytics that are
            // not consumed by this result surface.
            compact: args.fullAnalytics === true,
            // Fresh-entry detection reads only trades + generated signals.
            // Avoid allocating an equity curve or calculating Sharpe/drawdown
            // for the second pass over every retained candidate.
            trades: true,
            fullAnalytics: args.fullAnalytics === true,
            ...(args.signalOnly === true ? { signalsOnly: true } : {}),
            endpointSelection: false,
        },
    });
    return {
        result: output.result,
        candles: args.data,
        signals: output.signals,
        engineUsed: output.engineUsed,
        engineDiagnostics: output.engineDiagnostics,
    };
}

async function runCandidateNextExitOnAsset(args: {
    candidate: FinderResult;
    strategy: Strategy;
    symbol: string;
    fullClosed: OHLCVData[];
    replayData?: OHLCVData[];
    boundaryEntryTime: Time | null;
    direction: FinderAssetDirection;
    interval: string;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    options: FinderOptions;
    exitStrategyCandidates?: FinderSelectedStrategy[];
    exitSignalCache?: AssetCandidateExitSignalCache;
    dataFetcher?: CrossSymbolDataFetcher;
    useRustEnginePreference?: boolean;
    rustDiagnosticPhase?: RustDiagnosticPhase;
    rustCapabilities?: RustCapabilities;
    typescriptSimulationConcurrency?: TypescriptSimulationConcurrencyTracker;
    signal?: AbortSignal;
}): Promise<{
    metrics: import("./finder-asset-opportunity-oos").FinderAssetOosNextExitMetrics;
    engineUsed?: "rust" | "typescript";
    rustAttempted?: boolean;
    typescriptReason?: string;
}> {
    try {
        const { result, engineUsed, engineDiagnostics } = await executeAssetCandidate({
            candidate: args.candidate,
            strategy: args.strategy,
            data: args.replayData ?? args.fullClosed,
            symbol: args.symbol,
            interval: args.interval,
            settings: args.settings,
            capitalSettings: args.capitalSettings,
            options: args.options,
            exitStrategyCandidates: args.exitStrategyCandidates,
            exitSignalCache: args.exitSignalCache,
            dataFetcher: args.dataFetcher,
            useRustEnginePreference: args.useRustEnginePreference,
            rustDiagnosticPhase: args.rustDiagnosticPhase,
            rustCapabilities: args.rustCapabilities,
            typescriptSimulationConcurrency: args.typescriptSimulationConcurrency,
            signal: args.signal,
        });
        return {
            metrics: calculateFinderAssetOosNextExitMetrics({
                candles: args.fullClosed,
                boundaryEntryTime: args.boundaryEntryTime,
                direction: args.direction,
                ignoreLastBars: args.options.assetOpportunity?.oosIgnoreLastBars ?? 0,
                trades: result.trades,
            }),
            engineUsed,
            rustAttempted: engineDiagnostics?.rustAttempted === true,
            ...(engineDiagnostics?.typescriptReason
                ? { typescriptReason: engineDiagnostics.typescriptReason }
                : {}),
        };
    } catch (error) {
        if (isAbortError(error) || args.signal?.aborted) throw error;
        debugLogger.warn("finder.asset_opportunity.next_exit_replay_failed", {
            symbol: args.symbol,
            strategyKey: args.candidate.key,
            reason: error instanceof Error ? error.message : String(error),
        });
        return {
            metrics: calculateFinderAssetOosNextExitMetrics({
                candles: args.fullClosed,
                boundaryEntryTime: null,
                direction: args.direction,
                ignoreLastBars: args.options.assetOpportunity?.oosIgnoreLastBars ?? 0,
                trades: [],
                unavailableReason: "replay_error" satisfies FinderAssetOosNextExitUnavailableReason,
            }),
        };
    }
}

/**
 * Run OOS validation for one candidate on the resolved OOS window. Returns the
 * verdict (or `inconclusive` on failure). Mirrors `runCandidateOosPass` for one
 * candidate, inlined to avoid re-walking the per-candidate loop.
 */
async function runCandidateOosOnAsset(args: {
    candidate: FinderResult;
    strategy: Strategy;
    symbol: string;
    oosData: OHLCVData[];
    interval: string;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    options: FinderOptions;
    exitStrategyCandidates?: FinderSelectedStrategy[];
    exitSignalCache?: AssetCandidateExitSignalCache;
    dataFetcher?: CrossSymbolDataFetcher;
    useRustEnginePreference?: boolean;
    rustDiagnosticPhase?: RustDiagnosticPhase;
    rustCapabilities?: RustCapabilities;
    typescriptSimulationConcurrency?: TypescriptSimulationConcurrencyTracker;
    signal?: AbortSignal;
}): Promise<AssetOpportunityOosEvaluation> {
    try {
        const { result, engineUsed, engineDiagnostics } = await executeAssetCandidate({
            candidate: args.candidate,
            strategy: args.strategy,
            data: args.oosData,
            symbol: args.symbol,
            interval: args.interval,
            settings: args.settings,
            capitalSettings: args.capitalSettings,
            options: args.options,
            exitStrategyCandidates: args.exitStrategyCandidates,
            exitSignalCache: args.exitSignalCache,
            dataFetcher: args.dataFetcher,
            useRustEnginePreference: args.useRustEnginePreference,
            rustDiagnosticPhase: args.rustDiagnosticPhase,
            rustCapabilities: args.rustCapabilities,
            typescriptSimulationConcurrency: args.typescriptSimulationConcurrency,
            signal: args.signal,
        });
        return {
            result,
            verdict: computeFinderOosVerdict({
                oosNetProfit: result.netProfit,
                oosProfitFactor: result.profitFactor,
                oosTotalTrades: result.totalTrades,
                minTrades: args.options.tradeFilterEnabled ? args.options.minTrades : 0,
            }),
            engineUsed,
            rustAttempted: engineDiagnostics?.rustAttempted === true,
            ...(engineDiagnostics?.typescriptReason
                ? { typescriptReason: engineDiagnostics.typescriptReason }
                : {}),
        };
    } catch (error) {
        if (isAbortError(error) || args.signal?.aborted) throw error;
        return {
            result: createEmptyBacktestResult(),
            verdict: "inconclusive",
        };
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function throwAbortError(): never {
    const error = new Error("Asset Opportunity cancelled");
    error.name = "AbortError";
    throw error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throwAbortError();
}
