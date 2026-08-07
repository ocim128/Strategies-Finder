/**
 * Per-asset orchestration for the Finder Asset Opportunity scope.
 *
 * For each supplied asset:
 *  1. Take closed candles via the caller-provided dataset + closed-data
 *     selector.
 *  2. Reserve the latest closed candle (the application candle) for current-
 *     signal detection only.
 *  3. Apply the existing Finder data-slice behavior to the historical search
 *     data (the closed set minus the application candle).
 *  4. Run the existing random Finder search (`runFinderExecution`) with the
 *     selected strategy library and a deterministic seed derived from
 *     `(runSeed, canonicalSymbol)`.
 *  5. Keep the top-K candidates (K = `candidatePoolSize`).
 *  6. Re-generate signals for only those candidates on the full closed data
 *     (including the application candle) and detect fresh entries.
 *  7. Select the highest-ranked fresh candidate within the top-K pool.
 *  8. Build one scalar asset result + decision grade.
 *
 * Memory budget: candidates are executed via the existing Finder runner, which
 * holds per-strategy state for the duration of one asset's run. The runner
 * releases the input dataset reference after each asset's reduce step so a
 * large symbol list does not retain all datasets simultaneously.
 *
 * Leaf import hygiene: this module imports `runFinderExecution` from
 * `./finder-runner`, which transitively reaches `lightweight-charts` via
 * `../strategies/index`. It is therefore browser-safe but NOT Vite-config-
 * bundle-safe; the server-side Asset Opportunity path must NOT import this
 * module from `vite.config.ts`. The server-side path uses a sibling server
 * runner that does not depend on `runFinderExecution` (it inlines the IS
 * search via the existing finder-runner core, exactly like the Universe
 * server path).
 */

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
    resolveFinderRiskOverrides,
} from "./finder-runner-core";
import { withExitStrategyBaseParams, splitExitStrategyParams } from "./exit-strategy-param-prefix";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { executeBacktest, resolveExecutorBacktestSettings } from "../backtest-executor";
import type { CrossSymbolDataFetcher } from "../cross-symbol-runtime";
import { createEmptyBacktestResult } from "../strategies/index";
import { buildSelectionResult } from "./endpoint";
import {
    computeFinderOosVerdict,
    resolveOosDataSlice,
    sliceFinderDataWindow,
} from "./finder-manager-logic";
import { deriveStrategySeed } from "./finder-runner-shared";
import { detectFreshEntry } from "./finder-fresh-entry";
import {
    computeAssetSupportCounts,
    decideAssetGrade,
    type AssetPoolCandidate,
} from "./finder-asset-opportunity-metrics";
import { debugLogger } from "../debug-logger";

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
    selectedStrategies: FinderSelectedStrategy[];
    exitStrategyCandidates?: FinderSelectedStrategy[];
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    isCancelled: () => boolean;
    yieldControl: () => Promise<void>;
}) => Promise<{
    results: FinderResult[];
    /** Total candidates considered before the returned top-K reduction. */
    totalCandidatesEvaluated?: number;
    candidateEvaluationsAttempted?: number;
    candidateEvaluationsCompleted?: number;
    candidateEvaluationFailures?: number;
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
}>;

export interface AssetOpportunitySearchDiagnostics {
    dataBars: number;
    historicalBars: number;
    slicedHistoricalBars: number;
    oosBars: number;
    candidatesEvaluated: number;
    candidateEvaluationsAttempted: number;
    candidateEvaluationsCompleted: number;
    candidateEvaluationFailures: number;
    freshEntryRechecks: number;
    oosEvaluations: number;
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
}

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
    const outcomes: AssetOpportunityAssetResult[] = [];
    const results: FinderAssetOpportunityResult[] = [];
    const totalAssets = input.assets.length;
    const selectedStrategy = input.selectedStrategy;

    callbacks.setProgress(0, `Asset Opportunity: 0/${totalAssets} assets`);

    for (let assetIndex = 0; assetIndex < totalAssets; assetIndex++) {
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
        oosBars: 0,
        candidatesEvaluated: 0,
        candidateEvaluationsAttempted: 0,
        candidateEvaluationsCompleted: 0,
        candidateEvaluationFailures: 0,
        freshEntryRechecks: 0,
        oosEvaluations: 0,
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

    const fullClosed = buildFinderEvaluationData(asset.data, input.interval, input.settings);
    diagnostics.dataBars = fullClosed.length;
    if (fullClosed.length < 2) {
        return finish({ kind: "failed", symbol, reason: "insufficient closed candles" });
    }

    const { historical } = splitApplicationCandle(fullClosed);
    diagnostics.historicalBars = historical.length;
    if (historical.length === 0) {
        return finish({ kind: "failed", symbol, reason: "no historical candles after reserving application candle" });
    }

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

    const slicedHistorical = sliceHistoricalWindow(historical, assetOptions);
    diagnostics.slicedHistoricalBars = slicedHistorical.length;
    diagnostics.timingsMs.preparation = performance.now() - preparationStartedAt;
    if (slicedHistorical.length === 0) {
        return finish({ kind: "failed", symbol, reason: "historical window empty after data slice" });
    }

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
    });
    diagnostics.timingsMs.inSampleSearch = performance.now() - inSampleStartedAt;
    diagnostics.candidatesEvaluated = finderOutput.totalCandidatesEvaluated ?? finderOutput.results.length;
    diagnostics.candidateEvaluationsAttempted = finderOutput.candidateEvaluationsAttempted ?? finderOutput.results.length;
    diagnostics.candidateEvaluationsCompleted = finderOutput.candidateEvaluationsCompleted ?? finderOutput.results.length;
    diagnostics.candidateEvaluationFailures = finderOutput.candidateEvaluationFailures ?? 0;
    if (finderOutput.timingsMs) {
        diagnostics.timingsMs.parameterGeneration = finderOutput.timingsMs.parameterGeneration;
        diagnostics.timingsMs.candidateBacktests = finderOutput.timingsMs.backtest;
        diagnostics.timingsMs.yielding = finderOutput.timingsMs.yielding;
    }
    if (finderOutput.engineUsage) {
        mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, finderOutput.engineUsage);
    }

    const topK = finderOutput.results;
    const totalCandidatesEvaluated = Math.max(
        topK.length,
        finderOutput.totalCandidatesEvaluated ?? topK.length,
    );
    if (topK.length === 0) {
        diagnostics.candidatesEvaluated = totalCandidatesEvaluated;
        return finish({ kind: "no_fresh_entry", symbol, candidatesEvaluated: totalCandidatesEvaluated, bestHistoricalRank: null });
    }

    // 7. Re-generate signals for each top-K candidate on the FULL closed data
    // (including the application candle). The latest closed candle's signal
    // resolves the fresh status.
    const freshStartedAt = performance.now();
    const freshEvaluations = await Promise.all(topK.map((candidate) => regenerateSignalsAndDetectFresh({
        candidate,
        strategy: preparedStrategy,
        fullClosed,
        symbol,
        interval: input.interval,
        settings: input.settings,
        capitalSettings: input.capitalSettings,
        options: assetOptions,
        exitStrategyCandidates: input.exitStrategyCandidates,
        dataFetcher: input.dataFetcher,
        useRustEnginePreference: input.useRustEnginePreference,
    })));
    diagnostics.timingsMs.freshEntryRechecks = performance.now() - freshStartedAt;
    diagnostics.freshEntryRechecks = freshEvaluations.length;
    const freshByCandidate = freshEvaluations.map((evaluation) => {
        mergeAssetOpportunityEngineUsage(diagnostics.engineUsage, {
            rustAttemptedRuns: evaluation.rustAttempted ? 1 : 0,
            rustCompletedRuns: evaluation.engineUsed === "rust" ? 1 : 0,
            rustFallbackRuns: evaluation.engineUsed === "typescript" && evaluation.rustAttempted ? 1 : 0,
            typescriptCompletedRuns: evaluation.engineUsed === "typescript" ? 1 : 0,
            typescriptReasons: evaluation.typescriptReason
                ? [{ reason: evaluation.typescriptReason, runs: 1 }]
                : [],
        });
        const {
            engineUsed: _engineUsed,
            rustAttempted: _rustAttempted,
            typescriptReason: _typescriptReason,
            ...fresh
        } = evaluation;
        return fresh;
    });

    // Optional OOS validation per top-K candidate (only when enabled + half-window).
    let oosByCandidate: (AssetOpportunityOosEvaluation | undefined)[] | undefined;
    const oosStartedAt = performance.now();
    if (input.options.oosValidationEnabled) {
        const oosSlice = resolveOosDataSlice(input.options.dataSlice ?? "all");
        if (oosSlice) {
            // OOS complementary window is computed from the HISTORICAL search
            // data, never the application candle.
            const oosWindowData = buildFinderEvaluationData(
                sliceFinderDataWindow(historical, oosSlice),
                input.interval,
                input.settings,
            );
            diagnostics.oosBars = oosWindowData.length;
            if (oosWindowData.length > 0) {
                diagnostics.oosEvaluations = topK.length;
                oosByCandidate = await Promise.all(topK.map((candidate) =>
                    runCandidateOosOnAsset({
                        candidate,
                        strategy: preparedStrategy,
                        symbol,
                        oosData: oosWindowData,
                        interval: input.interval,
                        settings: input.settings,
                        capitalSettings: input.capitalSettings,
                        options: assetOptions,
                        exitStrategyCandidates: input.exitStrategyCandidates,
                        dataFetcher: input.dataFetcher,
                        useRustEnginePreference: input.useRustEnginePreference,
                    }),
                ));
                for (const evaluation of oosByCandidate) {
                    if (!evaluation) continue;
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
            }
        }
    }
    diagnostics.timingsMs.oosValidation = performance.now() - oosStartedAt;

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
        ...(oosByCandidate ? { oosByCandidate } : {}),
    });
    diagnostics.timingsMs.resultReduction = performance.now() - reductionStartedAt;

    if (!result) {
        return finish({
            kind: "no_fresh_entry",
            symbol,
            candidatesEvaluated: totalCandidatesEvaluated,
            bestHistoricalRank: 1,
        });
    }

    let finalResult = result;
    if (
        input.recomputeWinnerAnalytics === true
        && !finderAssetSearchRequiresFullAnalytics(input.options.sortPriority)
    ) {
        const winner = topK[result.historicalRank - 1];
        if (winner) {
            const winnerStartedAt = performance.now();
            const winnerEvaluation = await executeAssetCandidate({
                candidate: winner,
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
                fullAnalytics: true,
            });
            const preResolvedCapital = resolveCapitalSettingsFromRaw(
                input.capitalSettings as unknown as Record<string, unknown>,
            );
            const selection = buildSelectionResult(
                winnerEvaluation.result,
                slicedHistorical[slicedHistorical.length - 1]?.time ?? null,
                preResolvedCapital.initialCapital,
            );
            finalResult = {
                ...result,
                selectionResult: selection.result,
            };
            diagnostics.winnerAnalyticsRecomputations += 1;
            diagnostics.timingsMs.winnerAnalytics = performance.now() - winnerStartedAt;
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

/**
 * Re-run one candidate's strategy on the full closed data and detect the
 * fresh-entry status. Mirrors the prior current-chart Apply path: signal
 * generation + backtest on the FULL closed set (including the application
 * candle), then `detectFreshEntry`.
 *
 * Returns the parallel-array entry consumed by `reduceAssetTopKToResult`.
 */
function regenerateSignalsAndDetectFresh(args: {
    candidate: FinderResult;
    strategy: Strategy;
    fullClosed: OHLCVData[];
    symbol: string;
    interval: string;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    options: FinderOptions;
    exitStrategyCandidates?: FinderSelectedStrategy[];
    dataFetcher?: CrossSymbolDataFetcher;
    useRustEnginePreference?: boolean;
}): Promise<{
    freshStatus: "fresh" | "active" | "flat";
    direction: FinderAssetDirection | null;
    latestSignalTime: Time | null;
    signalAgeBars: number;
    fillTiming: "signal_close" | "next_open" | "next_close";
    isOpen: boolean;
    latestTradeEntryTime: number | null;
    engineUsed: "rust" | "typescript";
    rustAttempted: boolean;
    typescriptReason?: string;
}> {
    return executeAssetCandidate({
        candidate: args.candidate,
        strategy: args.strategy,
        data: args.fullClosed,
        symbol: args.symbol,
        interval: args.interval,
        settings: args.settings,
        capitalSettings: args.capitalSettings,
        options: args.options,
        exitStrategyCandidates: args.exitStrategyCandidates,
        dataFetcher: args.dataFetcher,
        useRustEnginePreference: args.useRustEnginePreference,
        signalOnly: args.settings.executionModel !== "signal_close",
    }).then(({ result, candles, signals, engineUsed, engineDiagnostics }) => {
        const detected = detectFreshEntry({ result, candles, settings: args.settings, signals });
        return {
            freshStatus: detected.freshStatus,
            direction: detected.direction,
            latestSignalTime: detected.latestSignalTime,
            signalAgeBars: detected.signalAgeBars,
            fillTiming: detected.fillTiming ?? "signal_close",
            isOpen: detected.isOpen,
            latestTradeEntryTime: detected.latestTrade
                ? timeToUnixSeconds(detected.latestTrade.entryTime)
                : null,
            engineUsed,
            rustAttempted: engineDiagnostics?.rustAttempted === true,
            ...(engineDiagnostics?.typescriptReason
                ? { typescriptReason: engineDiagnostics.typescriptReason }
                : {}),
        };
    });
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
    dataFetcher?: CrossSymbolDataFetcher;
    useRustEnginePreference?: boolean;
    signalOnly?: boolean;
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
    const combinedParams = withExitStrategyBaseParams(args.candidate.params, args.candidate.exitStrategyParams ?? {});
    const exitStrategy = args.candidate.exitStrategyKey
        ? args.exitStrategyCandidates?.find((candidate) => candidate.key === args.candidate.exitStrategyKey)?.strategy
        : undefined;
    const normalizedParams = normalizeFinderCandidateParams(
        args.strategy,
        combinedParams,
        exitStrategy?.normalizeParams
            ? { normalizeExitParams: exitStrategy.normalizeParams }
            : undefined,
    );
    const rustSettings = sanitizeBacktestSettingsForRust(args.settings);
    const { backtestSettings: riskAdjustedSettings } = resolveFinderRiskOverrides(
        args.settings,
        rustSettings,
        normalizedParams,
        args.options,
    );
    const backtestSettings: BacktestSettings = args.candidate.exitStrategyKey
        ? {
            ...riskAdjustedSettings,
            disableSignalExits: true,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: args.candidate.exitStrategyKey,
            exitStrategyParams: { ...(args.candidate.exitStrategyParams ?? {}) },
        }
        : riskAdjustedSettings;
    const preResolvedSettings = resolveExecutorBacktestSettings(
        { ...(backtestSettings as Record<string, unknown>), interval: args.interval } as BacktestSettings,
        args.interval,
    );
    const output = await executeBacktest({
        ohlcvData: args.data,
        interval: args.interval,
        primarySymbol: args.symbol,
        strategyKey: args.candidate.key,
        strategy: args.strategy,
        strategyParams: args.candidate.params,
        backtestSettings,
        capitalSettings: args.capitalSettings,
        context: {
            blockRange: null,
            annotatePolymarket: false,
            engineMode: "auto",
            nowSec: Math.floor(Date.now() / 1000),
            useRustEnginePreference: args.useRustEnginePreference,
        },
        ...(args.dataFetcher ? { dataFetcher: args.dataFetcher } : {}),
        ...(args.strategy.crossSymbolConfig ? {} : { closedCandleDataOverride: args.data }),
        preResolvedSettings,
        backtestRunOptions: {
            includeAdvancedAnalytics: false,
            // Fresh-entry detection reads only trades + generated signals.
            // Avoid allocating an equity curve or calculating Sharpe/drawdown
            // for the second pass over every retained candidate.
            includeSharpeRatio: args.fullAnalytics === true,
            useCompactBacktest: args.fullAnalytics === true ? true : false,
            omitEquityCurve: true,
            skipDrawdown: args.fullAnalytics !== true,
            requireTradeHistory: args.fullAnalytics !== true,
            signalsOnly: args.signalOnly === true,
            skipResultPostProcessing: true,
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
    dataFetcher?: CrossSymbolDataFetcher;
    useRustEnginePreference?: boolean;
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
            dataFetcher: args.dataFetcher,
            useRustEnginePreference: args.useRustEnginePreference,
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
    } catch {
        return {
            result: createEmptyBacktestResult(),
            verdict: "inconclusive",
        };
    }
}

/**
 * Convert a `Time` to unix seconds (best-effort). Lifted locally to keep this
 * leaf independent of `signal-entry-evaluator` (which is not a leaf for the
 * server bundle).
 */
function timeToUnixSeconds(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
        return value >= 1e11 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }
    const maybeDate = value as { year?: number; month?: number; day?: number; getTime?: () => number };
    if (typeof maybeDate.getTime === "function") {
        return Math.floor(maybeDate.getTime() / 1000);
    }
    if (maybeDate.year !== undefined) {
        const ms = Date.UTC(maybeDate.year, (maybeDate.month ?? 1) - 1, maybeDate.day ?? 1);
        return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
    return null;
}
