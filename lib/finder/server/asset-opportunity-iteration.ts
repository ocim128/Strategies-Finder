/**
 * ONE Asset Opportunity iteration (single run or one batch holdout value),
 * extracted verbatim from `finder-vite-plugin.ts` so a `worker_threads`
 * Worker can execute a batch holdout task without importing the plugin
 * module (which owns run state, route registration, and stream helpers).
 *
 * This module owns NO run state and emits NO stream events — the caller owns
 * the snapshot and writer. Import hygiene (the documented vite.config bundle
 * trap): this leaf must only import server-safe leaf modules; it must NOT
 * import `finder-vite-plugin.ts`, `lib/finder-manager.ts`,
 * `lib/data-manager.ts`, `lib/settings-manager.ts`, or anything that
 * transitively reaches `lib/constants.ts` or `lib/chart-manager.ts` (both
 * pull `lightweight-charts`, ESM-only).
 */

import { debugLogger } from "../../debug-logger";
import type { FinderSelectedStrategy } from "../finder-runner";
import { FinderParamSpace } from "../finder-param-space";
import type { CapitalSettings } from "../../types/backtest";
import type {
    FinderAssetOpportunityDiagnostics,
    FinderAssetOpportunityResult,
    FinderOptions,
} from "../../types/finder";
import type { BacktestSettings, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBatchDatasetLoadDiagnostics,
    type BatchDatasetLoadContext,
} from "../../batch-backtest/batch-dataset-loader-core";
import type { FinderAssetOpportunityArchiveSort } from "../finder-asset-opportunity-metrics";
import type { FinderRunLogSink } from "./finder-run-log";
import {
    runAssetOpportunitySearch,
    assertAssetOpportunityStrategySelection,
    type AssetOpportunitySearchDiagnostics,
    type AssetIsSearch,
} from "../finder-asset-opportunity-runner";
import {
    assertAssetResultIsScalar,
    toScalarAssetResult,
    type FinderAssetOpportunityTotals,
    type FinderJobPhase,
} from "./finder-stream-types";
import {
    sortAssetOpportunityResults,
} from "../finder-asset-opportunity-metrics";
import { runServerAssetIsSearch } from "./server-asset-is-search";
import { prepareClosedCandleData } from "../../backtest-executor";
import { createServerFinderAssetOpportunityLoadContext } from "./server-finder-data-loader";
import { parseSyntheticPairToken } from "../../synthetic-pair-token";

const ASSET_OPPORTUNITY_DATA_LOAD_CONCURRENCY = 12;

function mergeTimingIntervals(intervals: Array<readonly [number, number]>): number {
    if (intervals.length === 0) return 0;
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let start = sorted[0]![0];
    let end = sorted[0]![1];
    for (let index = 1; index < sorted.length; index += 1) {
        const next = sorted[index]!;
        if (next[0] <= end) {
            end = Math.max(end, next[1]);
            continue;
        }
        total += Math.max(0, end - start);
        start = next[0];
        end = next[1];
    }
    return total + Math.max(0, end - start);
}

function roundDiagnosticMs(value: number): number {
    return Math.round(value);
}

function roundAssetOpportunityPassTimings(
    timings: AssetOpportunitySearchDiagnostics["timingsMs"],
): AssetOpportunitySearchDiagnostics["timingsMs"] {
    return {
        total: roundDiagnosticMs(timings.total),
        preparation: roundDiagnosticMs(timings.preparation),
        inSampleSearch: roundDiagnosticMs(timings.inSampleSearch),
        parameterGeneration: roundDiagnosticMs(timings.parameterGeneration),
        candidateBacktests: roundDiagnosticMs(timings.candidateBacktests),
        yielding: roundDiagnosticMs(timings.yielding),
        freshEntryRechecks: roundDiagnosticMs(timings.freshEntryRechecks),
        oosValidation: roundDiagnosticMs(timings.oosValidation),
        resultReduction: roundDiagnosticMs(timings.resultReduction),
        winnerAnalytics: roundDiagnosticMs(timings.winnerAnalytics),
    };
}

// Stateless param-space generator (no constructor args, no browser deps).
// Module-scope so it's reused across iterations, mirroring the plugin's
// FinderManager.paramSpace. Stateless means a second instance (this one)
// generates identical param sets from the same seeded options.
const paramSpace = new FinderParamSpace();

/**
 * Input for ONE Asset Opportunity iteration (single run or one batch holdout).
 * Batch orchestration clones this with `options.assetOpportunity.oosIgnoreLastBars`
 * set to the current holdout value; everything else stays identical so the
 * per-iteration algorithm is the unchanged per-asset search.
 */
export interface FinderAssetOpportunityRunInput {
    runId: string;
    interval: string;
    symbols: string[];
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategies: FinderSelectedStrategy[];
    exitStrategyCandidates?: FinderSelectedStrategy[];
    useRustEnginePreference?: boolean;
    abortSignal: AbortSignal;
    loadDataset: (
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ) => Promise<OHLCVData[]>;
    /** Secondary cross-symbol data stays unsliced; the executor aligns it to the primary window. */
    loadSecondaryDataset?: (
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ) => Promise<OHLCVData[]>;
    getProvider?: (symbol: string) => string;
    candidatePoolSize: number;
    minFreshSupport: number;
    /** Reusable caches for a multi-iteration Asset Opportunity batch. */
    assetLoadContext?: BatchDatasetLoadContext;
    /** Legacy compatibility field; automatic batch archives always use All Sorts. */
    archiveSort?: FinderAssetOpportunityArchiveSort | null;
    /**
     * Optional fire-and-forget per-run diagnostics sink (JSONL run log). The
     * HTTP handlers build it from the resolved run-log root + run id; direct
     * callers (tests) may inject a capture sink or omit it to disable logging.
     */
    runLog?: FinderRunLogSink | null;
    /**
     * Optional param-set generator override (tests inject a deterministic
     * generator). Defaults to this leaf's module-scope `FinderParamSpace`,
     * which is stateless and therefore behavior-identical to the plugin's
     * module-scope instance.
     */
    generateParamSets?: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
}

/** Progress snapshot of one iteration, mirroring the single-run fields. */
export interface AssetOpportunityIterationProgress {
    percent: number;
    text: string;
    status: string;
    phase: FinderJobPhase;
    oosActive: boolean;
    assetIndex: number;
    totalAssets: number;
    strategyIndex: number;
    loadedSymbols: number;
    failedSymbols: number;
}

/** One completed scalar asset row of the current iteration. */
export interface AssetOpportunityIterationAssetResult {
    result: FinderAssetOpportunityResult;
    assetIndex: number;
    totalAssets: number;
    /** Full accumulated (unsorted) results array after this asset. */
    results: FinderAssetOpportunityResult[];
}

export interface AssetOpportunityIterationCallbacks {
    onProgress: (progress: AssetOpportunityIterationProgress) => void;
    onAssetResult: (asset: AssetOpportunityIterationAssetResult) => void;
    /** Status text updates that in single mode only mutate the snapshot. */
    onStatus?: (status: string) => void;
}

export interface AssetOpportunityIterationResult {
    /** Full scalar result set, sorted by the default run ordering. */
    results: FinderAssetOpportunityResult[];
    cancelled: boolean;
    assetDiagnostics: FinderAssetOpportunityDiagnostics;
    totals: FinderAssetOpportunityTotals;
    summary: string;
}

/**
 * Evaluate ONE Asset Opportunity iteration: loads every asset, runs the
 * unchanged per-asset multi-strategy search, and aggregates diagnostics.
 * This is the seam shared by the single-run route (called once) and the batch
 * route (called once per holdout value). It owns NO run state and emits NO
 * stream events — the caller owns the snapshot and writer, so a batch can
 * reuse the identical algorithm under one run id while keeping per-iteration
 * rows bounded.
 */
export async function runAssetOpportunityIteration(
    input: FinderAssetOpportunityRunInput,
    callbacks: AssetOpportunityIterationCallbacks,
    isCancelled: () => boolean,
): Promise<AssetOpportunityIterationResult> {
    const { symbols, selectedStrategies } = input;
    const totalAssets = symbols.length;
    const iterationStartedAt = Date.now();
    assertAssetOpportunityStrategySelection(selectedStrategies);

    input.runLog?.("iteration_start", {
        interval: input.interval,
        symbols: totalAssets,
        strategyKeys: selectedStrategies.map((strategy) => strategy.key),
        holdoutBars: input.options.assetOpportunity?.oosIgnoreLastBars ?? 0,
        maxRuns: input.options.maxRuns,
        candidatePoolSize: input.candidatePoolSize,
    });

    const assetLoadContext = input.assetLoadContext
        ? {
            ...input.assetLoadContext,
            // Cache entries are reusable across holdout iterations, while
            // diagnostics must describe this iteration only.
            diagnostics: createBatchDatasetLoadDiagnostics(),
        }
        : createServerFinderAssetOpportunityLoadContext();
    const estimatedCandidateEvaluations = totalAssets * selectedStrategies.length * (
        Math.max(1, Math.floor(input.options.maxRuns)) + input.candidatePoolSize
    );

    const failedAssets: Array<{ symbol: string; reason: string }> = [];
    let assetsWithFreshEntry = 0;
    let assetsWithNoFreshEntry = 0;
    let selectGradeAssets = 0;
    let watchGradeAssets = 0;
    let rejectGradeAssets = 0;
    let rustCompletedRuns = 0;
    let rustAttemptedRuns = 0;
    let rustFallbackRuns = 0;
    let typescriptCompletedRuns = 0;
    const typescriptReasonCounts = new Map<string, number>();
    let dataLoadingMs = 0;
    let dataPreparationMs = 0;
    let inSampleSearchMs = 0;
    let parameterGenerationMs = 0;
    let candidateBacktestMs = 0;
    let yieldingMs = 0;
    let freshEntryRechecksMs = 0;
    let oosValidationMs = 0;
    let resultReductionMs = 0;
    let winnerAnalyticsMs = 0;
    let candidateEvaluationsAttempted = 0;
    let candidateEvaluationsCompleted = 0;
    let candidateEvaluationFailures = 0;
    let freshEntryRechecks = 0;
    let oosEvaluations = 0;
    let winnerAnalyticsRecomputations = 0;
    const strategyBreakdown = new Map<string, {
        assetsEvaluated: number;
        candidatesEvaluated: number;
        candidateEvaluationsAttempted: number;
        candidateEvaluationsCompleted: number;
        candidateEvaluationFailures: number;
        freshEntryRechecks: number;
        oosEvaluations: number;
        durationMs: number;
    }>();
    // Bounded slowest-passes buffer. Mirrors `recordDatasetLoad` in the
    // Universe path: keep the array at <= SLOW_ASSET_PASSES_MAX across pushes so
    // a 1000-symbol x 5-strategy run does not retain 5000 entries (with nested
    // timingsMs) just to slice down to 10 at run end.
    const SLOW_ASSET_PASSES_MAX = 10;
    const slowAssetPasses: Array<{
        symbol: string;
        strategyKey: string;
        dataBars: number;
        historicalBars: number;
        slicedHistoricalBars: number;
        oosBars: number;
        dataLoadingMs: number;
        candidatesEvaluated: number;
        freshEntryRechecks: number;
        oosEvaluations: number;
        timingsMs: AssetOpportunitySearchDiagnostics["timingsMs"];
    }> = [];
    const recordAssetPass = (pass: typeof slowAssetPasses[number]): void => {
        slowAssetPasses.push(pass);
        slowAssetPasses.sort((a, b) => b.timingsMs.total - a.timingsMs.total);
        if (slowAssetPasses.length > SLOW_ASSET_PASSES_MAX) {
            slowAssetPasses.length = SLOW_ASSET_PASSES_MAX;
        }
    };
    // Running aggregates for loadedBars. Avoids the O(N) Math.min/Math.max
    // spread over potentially 1000+ entries at run end.
    let loadedBarsMin = Number.POSITIVE_INFINITY;
    let loadedBarsMax = 0;
    let loadedBarsSum = 0;
    let loadedBarsCount = 0;
    let assetResults: FinderAssetOpportunityResult[] = [];
    let loadedSymbols = 0;
    let failedSymbols = 0;
    let currentPhase: FinderJobPhase = "loading";
    let currentStrategyIndex = 0;
    const secondaryDataCache = new Map<string, Promise<OHLCVData[]>>();
    const assetDataFetcher = selectedStrategies.some((strategy) => strategy.strategy.crossSymbolConfig) && input.getProvider
        ? {
            getProvider: input.getProvider,
            fetchDataDetached: (symbol: string, interval: string): Promise<OHLCVData[]> => {
                const cacheKey = `${symbol}|${interval}`;
                const cached = secondaryDataCache.get(cacheKey);
                if (cached) return cached;
                const promise = (input.loadSecondaryDataset ?? input.loadDataset)(
                    symbol,
                    interval,
                    input.abortSignal,
                    assetLoadContext,
                ).then((data) => {
                    if (!Array.isArray(data) || data.length === 0) secondaryDataCache.delete(cacheKey);
                    return data;
                }, (error) => {
                    secondaryDataCache.delete(cacheKey);
                    throw error;
                });
                secondaryDataCache.set(cacheKey, promise);
                return promise;
            },
        }
        : undefined;

    // Server-safe IS search. The browser path uses `runFinderExecution` which
    // pulls `lightweight-charts` transitively; the server path uses the
    // leaf `runServerAssetIsSearch` which uses `executeBacktest` directly
    // (same pattern as the Universe server runner).
    const isSearch: AssetIsSearch = async (args) => {
        const output = await runServerAssetIsSearch({
            ohlcvData: args.ohlcvData,
            symbol: args.symbol,
            interval: args.interval,
            options: args.options,
            settings: args.settings,
            capitalSettings: args.capitalSettings,
            selectedStrategy: args.selectedStrategies[0]!,
            exitStrategyCandidates: args.exitStrategyCandidates,
            generateParamSets: args.generateParamSets,
            useRustEnginePreference: input.useRustEnginePreference,
            ...(assetDataFetcher ? { dataFetcher: assetDataFetcher } : {}),
            isCancelled: args.isCancelled,
            yieldControl: args.yieldControl,
            ...(args.retainSignals === true ? { retainSignals: true } : {}),
        });
        if (output.engineUsage.typescriptCompletedRuns > 0 && input.useRustEnginePreference === true) {
            debugLogger.event("finder.asset_opportunity.engine_fallback", {
                runId: input.runId,
                symbol: args.symbol,
                typescriptRuns: output.engineUsage.typescriptCompletedRuns,
                rustRuns: output.engineUsage.rustCompletedRuns,
            });
        }
        return {
            results: output.results,
            totalCandidatesEvaluated: output.totalCandidatesEvaluated,
            candidateEvaluationsAttempted: output.candidateEvaluationsAttempted,
            candidateEvaluationsCompleted: output.candidateEvaluationsCompleted,
            candidateEvaluationFailures: output.candidateEvaluationFailures,
            ...(output.signalsByCandidate ? { signalsByCandidate: output.signalsByCandidate } : {}),
            timingsMs: output.timingsMs,
            engineUsage: output.engineUsage,
        };
    };

    type AssetLoadOutcome = {
        data?: OHLCVData[];
        error?: unknown;
        startedAt: number;
        finishedAt: number;
        durationMs: number;
    };
    const pendingAssetLoads = new Map<number, Promise<AssetLoadOutcome>>();
    const completedAssetLoadIntervals: Array<readonly [number, number]> = [];
    // Run-scoped plain-dataset LRU (attached by the BATCH paths; undefined for
    // single runs, which load each symbol exactly once). Retaining one copy
    // per symbol across holdout iterations turns the batch sweep's per-
    // iteration full-universe reload into a single load per worker/run.
    // Synthetic pairs are excluded: their series are already retained by the
    // context's pairCache under their own keys. Only successful non-empty
    // loads are cached; rejected loads are evicted by SyntheticLegCache so
    // both stay retryable.
    const datasetCache = assetLoadContext.datasetCache;
    const scheduleAssetLoad = (assetIndex: number): void => {
        if (assetIndex >= totalAssets || isCancelled()) return;
        const symbol = symbols[assetIndex]!;
        const cacheKey = datasetCache && parseSyntheticPairToken(symbol) === null
            ? `${symbol}|${input.interval}`
            : null;
        const cached = cacheKey !== null ? datasetCache!.get(cacheKey) : undefined;
        const startedAt = performance.now();
        const dataPromise = cached
            ? cached
            : input.loadDataset(symbol, input.interval, input.abortSignal, assetLoadContext).then((data) => {
                if (cacheKey !== null && Array.isArray(data) && data.length > 0) {
                    datasetCache!.set(cacheKey, Promise.resolve(data));
                }
                return data;
            });
        const promise = Promise.resolve()
            .then(() => dataPromise)
            .then(
                (data) => {
                    const finishedAt = performance.now();
                    return { data, startedAt, finishedAt, durationMs: finishedAt - startedAt };
                },
                (error) => {
                    const finishedAt = performance.now();
                    return { error, startedAt, finishedAt, durationMs: finishedAt - startedAt };
                },
            );
        pendingAssetLoads.set(assetIndex, promise);
    };
    for (let index = 0; index < Math.min(totalAssets, ASSET_OPPORTUNITY_DATA_LOAD_CONCURRENCY); index += 1) {
        scheduleAssetLoad(index);
    }

    for (let assetIndex = 0; assetIndex < totalAssets; assetIndex += 1) {
        if (isCancelled()) break;
        const loadPromise = pendingAssetLoads.get(assetIndex);
        if (!loadPromise) break;
        const loadedAsset = await loadPromise;
        pendingAssetLoads.delete(assetIndex);
        completedAssetLoadIntervals.push([loadedAsset.startedAt, loadedAsset.finishedAt]);
        if (!isCancelled()) scheduleAssetLoad(assetIndex + ASSET_OPPORTUNITY_DATA_LOAD_CONCURRENCY);
        const symbol = symbols[assetIndex]!;
        const assetStartedAt = performance.now();
        const currentAssetLoadMs = loadedAsset.durationMs;
        currentPhase = "loading";
        const loadingText = `Loading ${symbol} (${assetIndex + 1}/${totalAssets})...`;
        callbacks.onProgress({
            percent: (assetIndex / totalAssets) * 100,
            text: loadingText,
            status: loadingText,
            phase: currentPhase,
            oosActive: false,
            assetIndex,
            totalAssets,
            strategyIndex: currentStrategyIndex,
            loadedSymbols,
            failedSymbols,
        });

        const assetFailures: Array<{ strategyKey: string; reason: string }> = [];
        let assetHadFreshEntry = false;
        let assetHadNoFreshEntry = false;
        const assetGrades = new Set<FinderAssetOpportunityResult["grade"]>();
        try {
            if (loadedAsset.error) throw loadedAsset.error;
            const data = loadedAsset.data ?? [];
            if (data.length === 0) {
                throw new Error("no data");
            }
            loadedBarsMin = Math.min(loadedBarsMin, data.length);
            loadedBarsMax = Math.max(loadedBarsMax, data.length);
            loadedBarsSum += data.length;
            loadedBarsCount += 1;
            loadedSymbols += 1;
            currentPhase = "evaluating";
            // Hoist the execution-aware closed-candle build out of the
            // per-strategy loop. The closed-candle view depends only on
            // (data, interval, settings), not on the selected strategy, so
            // building it once per asset avoids N re-walks of the dataset to
            // find the latest closed bar (selectExecutionAwareClosedCandles).
            const fullClosed = prepareClosedCandleData(data, input.interval, input.settings);
            for (let strategyIndex = 0; strategyIndex < selectedStrategies.length; strategyIndex += 1) {
                if (isCancelled()) break;
                const selectedStrategy = selectedStrategies[strategyIndex]!;
                currentStrategyIndex = strategyIndex;
                const runOutput = await runAssetOpportunitySearch(
                    {
                        interval: input.interval,
                        options: input.options,
                        settings: input.settings,
                        capitalSettings: input.capitalSettings,
                        selectedStrategy,
                        exitStrategyCandidates: input.exitStrategyCandidates,
                        generateParamSets: input.generateParamSets
                            ?? ((defaultParams, finderOptions) =>
                                paramSpace.generateParamSets(defaultParams, finderOptions)),
                        runSeed: Number.isFinite(input.options.randomSeed) ? Number(input.options.randomSeed) : 1,
                        candidatePoolSize: input.candidatePoolSize,
                        minFreshSupport: input.minFreshSupport,
                        ...(assetDataFetcher ? { dataFetcher: assetDataFetcher } : {}),
                        useRustEnginePreference: input.useRustEnginePreference,
                        // The server IS pass retains compact trade history and
                        // builds the endpoint-adjusted selection result for
                        // every candidate, so a full winner rerun is redundant.
                        recomputeWinnerAnalytics: false,
                        assets: [{ symbol, data, precomputedFullClosed: fullClosed }],
                        runIsSearch: isSearch,
                    },
                    {
                        setProgress: (percent, text) => {
                            const strategyProgress = (strategyIndex + percent / 100) / selectedStrategies.length;
                            const overall = ((assetIndex + strategyProgress) / totalAssets) * 100;
                            callbacks.onProgress({
                                percent: overall,
                                text,
                                status: text,
                                phase: currentPhase,
                                oosActive: false,
                                assetIndex,
                                totalAssets,
                                strategyIndex,
                                loadedSymbols,
                                failedSymbols,
                            });
                        },
                        setStatus: (text) => {
                            callbacks.onStatus?.(`${selectedStrategy.name}: ${text}`);
                        },
                        yieldControl: async () => {
                            await new Promise<void>((resolve) => setImmediate(resolve));
                        },
                        isCancelled,
                        onAssetComplete: (outcome) => {
                            const searchDiagnostics = outcome.diagnostics;
                            if (searchDiagnostics) {
                                dataPreparationMs += searchDiagnostics.timingsMs.preparation;
                                inSampleSearchMs += searchDiagnostics.timingsMs.inSampleSearch;
                                parameterGenerationMs += searchDiagnostics.timingsMs.parameterGeneration;
                                candidateBacktestMs += searchDiagnostics.timingsMs.candidateBacktests;
                                yieldingMs += searchDiagnostics.timingsMs.yielding;
                                freshEntryRechecksMs += searchDiagnostics.timingsMs.freshEntryRechecks;
                                oosValidationMs += searchDiagnostics.timingsMs.oosValidation;
                                resultReductionMs += searchDiagnostics.timingsMs.resultReduction;
                                winnerAnalyticsMs += searchDiagnostics.timingsMs.winnerAnalytics;
                                candidateEvaluationsAttempted += searchDiagnostics.candidateEvaluationsAttempted;
                                candidateEvaluationsCompleted += searchDiagnostics.candidateEvaluationsCompleted;
                                candidateEvaluationFailures += searchDiagnostics.candidateEvaluationFailures;
                                freshEntryRechecks += searchDiagnostics.freshEntryRechecks;
                                oosEvaluations += searchDiagnostics.oosEvaluations;
                                winnerAnalyticsRecomputations += searchDiagnostics.winnerAnalyticsRecomputations;
                                rustAttemptedRuns += searchDiagnostics.engineUsage.rustAttemptedRuns;
                                rustCompletedRuns += searchDiagnostics.engineUsage.rustCompletedRuns;
                                rustFallbackRuns += searchDiagnostics.engineUsage.rustFallbackRuns;
                                typescriptCompletedRuns += searchDiagnostics.engineUsage.typescriptCompletedRuns;
                                for (const entry of searchDiagnostics.engineUsage.typescriptReasons) {
                                    typescriptReasonCounts.set(
                                        entry.reason,
                                        (typescriptReasonCounts.get(entry.reason) ?? 0) + entry.runs,
                                    );
                                }
                                const strategyStats = strategyBreakdown.get(selectedStrategy.key) ?? {
                                    assetsEvaluated: 0,
                                    candidatesEvaluated: 0,
                                    candidateEvaluationsAttempted: 0,
                                    candidateEvaluationsCompleted: 0,
                                    candidateEvaluationFailures: 0,
                                    freshEntryRechecks: 0,
                                    oosEvaluations: 0,
                                    durationMs: 0,
                                };
                                strategyStats.assetsEvaluated += 1;
                                strategyStats.candidatesEvaluated += searchDiagnostics.candidatesEvaluated;
                                strategyStats.candidateEvaluationsAttempted += searchDiagnostics.candidateEvaluationsAttempted;
                                strategyStats.candidateEvaluationsCompleted += searchDiagnostics.candidateEvaluationsCompleted;
                                strategyStats.candidateEvaluationFailures += searchDiagnostics.candidateEvaluationFailures;
                                strategyStats.freshEntryRechecks += searchDiagnostics.freshEntryRechecks;
                                strategyStats.oosEvaluations += searchDiagnostics.oosEvaluations;
                                strategyStats.durationMs += searchDiagnostics.timingsMs.total;
                                strategyBreakdown.set(selectedStrategy.key, strategyStats);
                                recordAssetPass({
                                    symbol,
                                    strategyKey: selectedStrategy.key,
                                    dataBars: searchDiagnostics.dataBars,
                                    historicalBars: searchDiagnostics.historicalBars,
                                    slicedHistoricalBars: searchDiagnostics.slicedHistoricalBars,
                                    oosBars: searchDiagnostics.oosBars,
                                    dataLoadingMs: currentAssetLoadMs,
                                    candidatesEvaluated: searchDiagnostics.candidatesEvaluated,
                                    freshEntryRechecks: searchDiagnostics.freshEntryRechecks,
                                    oosEvaluations: searchDiagnostics.oosEvaluations,
                                    timingsMs: searchDiagnostics.timingsMs,
                                });
                            }
                            if (outcome.kind === "opportunity") {
                                assetHadFreshEntry = true;
                                assetGrades.add(outcome.result.grade);
                                const scalar = toScalarAssetResult(outcome.result);
                                assertAssetResultIsScalar(scalar);
                                assetResults.push(scalar);
                                callbacks.onAssetResult({
                                    result: scalar,
                                    assetIndex,
                                    totalAssets,
                                    results: assetResults,
                                });
                            } else if (outcome.kind === "no_fresh_entry") {
                                assetHadNoFreshEntry = true;
                            } else {
                                assetFailures.push({ strategyKey: selectedStrategy.key, reason: outcome.reason });
                            }
                            debugLogger.event("finder.asset_opportunity.asset.complete", {
                                runId: input.runId,
                                symbol,
                                strategyKey: selectedStrategy.key,
                                assetIndex,
                                outcome: outcome.kind,
                                grade: outcome.kind === "opportunity" ? outcome.result.grade : null,
                                durationMs: Math.round(performance.now() - assetStartedAt),
                            });
                            // Durable JSONL trace (survives a Vite-process crash).
                            input.runLog?.("asset_complete", {
                                symbol,
                                strategyKey: selectedStrategy.key,
                                assetIndex,
                                outcome: outcome.kind,
                                grade: outcome.kind === "opportunity" ? outcome.result.grade : null,
                                durationMs: Math.round(performance.now() - assetStartedAt),
                            });
                        },
                    },
                );
                void runOutput;
            }

            if (assetHadFreshEntry) {
                assetsWithFreshEntry += 1;
                // An asset can produce multiple fresh candidates across the
                // selected strategies, but its diagnostic grade is the best
                // grade observed for that asset. Keep these buckets
                // mutually exclusive so they partition fresh assets.
                if (assetGrades.has("select")) selectGradeAssets += 1;
                else if (assetGrades.has("watch")) watchGradeAssets += 1;
                else if (assetGrades.has("reject")) rejectGradeAssets += 1;
            } else if (assetFailures.length === selectedStrategies.length) {
                failedAssets.push({
                    symbol,
                    reason: assetFailures.map((failure) => `${failure.strategyKey}: ${failure.reason}`).join("; "),
                });
                failedSymbols += 1;
            } else if (assetHadNoFreshEntry) {
                assetsWithNoFreshEntry += 1;
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            failedAssets.push({ symbol, reason });
            failedSymbols += 1;
            debugLogger.event("finder.asset_opportunity.asset.complete", {
                runId: input.runId,
                symbol,
                assetIndex,
                strategyKey: null,
                outcome: "failed",
                grade: null,
                durationMs: Math.round(performance.now() - assetStartedAt),
            });
            input.runLog?.("asset_failed", {
                symbol,
                assetIndex,
                reason,
                durationMs: Math.round(performance.now() - assetStartedAt),
            });
        }
    }

    dataLoadingMs = mergeTimingIntervals(completedAssetLoadIntervals);
    const sortedAssetResults = sortAssetOpportunityResults(assetResults);
    const cancelled = isCancelled();
    const totals: FinderAssetOpportunityTotals = {
        totalAssets,
        assetsWithFreshEntry,
        selectGradeAssets,
        watchGradeAssets,
        rejectGradeAssets,
        failedAssets: failedAssets.length,
        engineUsage: {
            rustRequested: input.useRustEnginePreference === true,
            rustAttemptedRuns,
            rustCompletedRuns,
            rustFallbackRuns,
            typescriptCompletedRuns,
            typescriptReasons: [...typescriptReasonCounts.entries()]
                .map(([reason, runs]) => ({ reason, runs }))
                .sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason)),
        },
    };
    const totalDurationMs = Math.max(0, Date.now() - iterationStartedAt);
    const measuredPhaseMs = dataLoadingMs
        + dataPreparationMs
        + inSampleSearchMs
        + freshEntryRechecksMs
        + oosValidationMs
        + resultReductionMs
        + winnerAnalyticsMs;
    const loadedBars = loadedBarsCount > 0
        ? {
            min: loadedBarsMin,
            max: loadedBarsMax,
            avg: Math.round(loadedBarsSum / loadedBarsCount),
        }
        : { min: 0, max: 0, avg: 0 };
    const loaderDiagnostics = assetLoadContext.diagnostics
        ? {
            ...assetLoadContext.diagnostics,
            timingsMs: { ...assetLoadContext.diagnostics.timingsMs },
        }
        : undefined;
    const assetDiagnostics: FinderAssetOpportunityDiagnostics = {
        totalAssets,
        assetsWithFreshEntry,
        assetsWithNoFreshEntry,
        selectGradeAssets,
        watchGradeAssets,
        rejectGradeAssets,
        failedAssets,
        work: {
            selectedStrategies: selectedStrategies.length,
            candidateEvaluationsEstimated: estimatedCandidateEvaluations,
            candidateEvaluationsAttempted,
            candidateEvaluationsCompleted,
            candidateEvaluationFailures,
            freshEntryRechecks,
            oosEvaluations,
            winnerAnalyticsRecomputations,
            loadedBars,
        },
        timingsMs: {
            total: roundDiagnosticMs(totalDurationMs),
            dataLoading: roundDiagnosticMs(dataLoadingMs),
            dataPreparation: roundDiagnosticMs(dataPreparationMs),
            inSampleSearch: roundDiagnosticMs(inSampleSearchMs),
            parameterGeneration: roundDiagnosticMs(parameterGenerationMs),
            candidateBacktests: roundDiagnosticMs(candidateBacktestMs),
            freshEntryRechecks: roundDiagnosticMs(freshEntryRechecksMs),
            oosValidation: roundDiagnosticMs(oosValidationMs),
            resultReduction: roundDiagnosticMs(resultReductionMs),
            winnerAnalytics: roundDiagnosticMs(winnerAnalyticsMs),
            yielding: roundDiagnosticMs(yieldingMs),
            other: roundDiagnosticMs(Math.max(0, totalDurationMs - measuredPhaseMs)),
        },
        ...(loaderDiagnostics ? { loader: loaderDiagnostics } : {}),
        strategyBreakdown: [...strategyBreakdown.entries()]
            .map(([strategyKey, stats]) => ({
                strategyKey,
                ...stats,
                durationMs: roundDiagnosticMs(stats.durationMs),
            }))
            .sort((a, b) => b.durationMs - a.durationMs || a.strategyKey.localeCompare(b.strategyKey))
            .slice(0, 10),
        // slowAssetPasses is already top-10 by timingsMs.total (kept bounded
        // and sorted by `recordAssetPass` on every push), so just map to the
        // rounded diagnostic shape here.
        slowestAssets: slowAssetPasses.map((pass) => ({
            ...pass,
            dataLoadingMs: roundDiagnosticMs(pass.dataLoadingMs),
            timingsMs: roundAssetOpportunityPassTimings(pass.timingsMs),
        })),
        engineUsage: totals.engineUsage,
    };
    const summary = `Asset Opportunity complete: ${sortedAssetResults.length}/${totalAssets} fresh opportunities (${selectGradeAssets} select, ${watchGradeAssets} watch, ${rejectGradeAssets} reject, ${assetsWithNoFreshEntry} no fresh, ${failedAssets.length} failed).`;

    // Cross-iteration dataset reuse is invisible to `timingsMs.dataLoading`
    // (cache hits contribute ~0 duration), so surface the hit/miss counters
    // explicitly for post-mortems.
    if (datasetCache) {
        debugLogger.event("finder.server.dataset_cache_stats", {
            runId: input.runId,
            hits: datasetCache.hitCount(),
            misses: datasetCache.missCount(),
        });
    }

    input.runLog?.("iteration_complete", {
        totalAssets,
        assetsWithFreshEntry,
        assetsWithNoFreshEntry,
        selectGradeAssets,
        watchGradeAssets,
        rejectGradeAssets,
        failedAssets: failedAssets.length,
        retainedResults: sortedAssetResults.length,
        cancelled,
        durationMs: totalDurationMs,
        ...(datasetCache
            ? { datasetCacheHits: datasetCache.hitCount(), datasetCacheMisses: datasetCache.missCount() }
            : {}),
        summary,
    });

    return {
        results: sortedAssetResults,
        cancelled,
        assetDiagnostics,
        totals,
        summary,
    };
}
