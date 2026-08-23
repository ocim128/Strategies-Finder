/**
 * Server-safe in-sample candidate search for the Asset Opportunity scope.
 *
 * This leaf replaces the browser `runFinderExecution` in the server path so the
 * server runs a lean IS loop without the browser's strategy-plan/UI-callback
 * machinery (polymarket interception, confirmation filters, quick funnel, live
 * UI updates). It is NOT a bundle-safety workaround: the browser runner is
 * already safe for the Vite config bundle — its `finder-runner` import is
 * type-only and the backtest-engine modules do not reach `lightweight-charts` —
 * and `tests/vite-config-bundle.spec.ts` locks that invariant.
 *
 * This leaf reaches only server-safe modules (matching
 * `finder-runner-universe.ts`'s import hygiene): `../backtest-executor`,
 * `./finder-runner-core`, `./exit-strategy-param-prefix`, and
 * `./finder-manager-logic`.
 *
 * The function is a minimal IS search: it generates candidate params from the
 * injected param-space generator, executes each on the supplied historical
 * data, ranks them by the same sort priority, and returns the bounded top-K
 * result set. OOS validation is NOT done here — it is done by the caller
 * (Asset Opportunity server job) via the extracted candidate-OOS leaf.
 *
 * Determinism: the caller injects a deterministic per-asset seed through
 * `options.randomSeed`; the param-space generator consumes it unchanged, so
 * the same seed + same inputs produce the same candidate ordering.
 */

import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    StrategyParams,
} from "../../types/strategies";
import type { CapitalSettings } from "../../types/backtest";
import type { FinderOptions, FinderResult } from "../../types/finder";
import type { FinderSelectedStrategy } from "../finder-runner";
import type { CrossSymbolDataFetcher } from "../../cross-symbol-runtime";
import { resolveCapitalSettingsFromRaw } from "../../backtest-capital-settings";
import { serializeParams } from "../finder-param-math";
import {
    buildFinderSearchBaseParams,
    createPreparedFinderStrategy,
    finderAssetSearchRequiresFullAnalytics,
    getFinderStrategyParamDefaults,
    type FinderPreparedDataCache,
    normalizeFinderCandidateParamSets,
} from "../finder-runner-core";
import { withExitStrategyBaseParams, splitExitStrategyParams } from "../exit-strategy-param-prefix";
import { FinderResultRanker } from "../finder-result-ranker";
import { buildSelectionResult } from "../endpoint";
import { matchesFinderTradeCountFilter } from "../finder-manager-logic";
import { runAssetCandidateBacktest } from "../finder-asset-candidate-execution";
import { ensureConfirmationStrategiesLoaded } from "../../confirmation-signal-filter";
import type { AssetOpportunitySignalCache } from "../finder-asset-opportunity-search-cache";
import { rustEngine } from "../../rust-engine-client";
import { debugLogger } from "../../debug-logger";
import { applySlippage, entrySideForDirection, timeKey } from "../../strategies/backtest/backtest-utils";
import { resolveEntryRiskTargets } from "../../entry-risk-targets";
import {
    dispatchAssetOpportunityRustBatch,
    buildAssetOpportunityRustDatasetCacheKey,
    normalizeAssetOpportunityRustCandidateResult,
    resolveAssetOpportunityRustBatchEligibility,
    resolveAssetOpportunityRustBatchFeatureConfig,
    shouldUseRustAssetOpportunityBatch,
    type AssetOpportunityRustBatchClient,
    type AssetOpportunityRustBatchItem,
} from "./finder-asset-opportunity-rust-batch";
import type { AssetOpportunityRustMultiBatchCoordinator } from "./finder-asset-opportunity-multi-rust-batch";
import {
    FINDER_ASSET_OPPORTUNITY_RESEARCH_CHUNK_SIZE,
    attachFinderAssetOpportunityPathScalars,
    buildFinderAssetOpportunityCandidateFingerprint,
    buildFinderAssetOpportunityCandidateSummaryRow,
    type FinderAssetOpportunityCandidateSummaryRow,
} from "./finder-asset-opportunity-research";
import type { FinderAssetOpportunityCandidateSummaryRow as FinderAssetOpportunityCandidateSummaryRowType } from "../finder-asset-opportunity-research-types";
import { simulateFinderAssetOpportunityForwardOutcome } from "../finder-asset-opportunity-forward-contract";

const ASSET_IS_SEARCH_YIELD_EVERY_RUNS = 256;
const ASSET_IS_SEARCH_YIELD_MIN_MS = 1000;

export interface ServerAssetIsSearchInput {
    ohlcvData: OHLCVData[];
    symbol: string;
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategy: FinderSelectedStrategy;
    exitStrategyCandidates?: FinderSelectedStrategy[];
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    useRustEnginePreference?: boolean;
    dataFetcher?: CrossSymbolDataFetcher;
    /** Caller already preloaded the configured confirmation libraries for this task. */
    confirmationStrategiesLoaded?: boolean;
    /** Full closed series for batch-only signal reuse across holdout prefixes. */
    fullSignalData?: OHLCVData[];
    /** Candles strictly after a declared point-in-time fold. */
    forwardData?: OHLCVData[];
    /** Fixed execution-unit horizons captured for the fresh research program. */
    forwardHorizons?: number[];
    signalCache?: AssetOpportunitySignalCache;
    abortSignal?: AbortSignal;
    rustBatchClient?: AssetOpportunityRustBatchClient;
    rustMultiAssetBatch?: AssetOpportunityRustMultiBatchCoordinator;
    /** Per-iteration cache of Rust dataset uploads, keyed by asset/window. */
    rustBatchDatasetCache?: Map<string, Promise<string | null>>;
    /** Persistent cache of normalized default candidate sets for batch runs. */
    paramSetCache?: Map<string, StrategyParams[]>;
    isCancelled: () => boolean;
    yieldControl: () => Promise<void>;
    /**
     * When true, retain each candidate's generated signals and return them via
     * `signalsByCandidate` so the caller can run fresh-entry detection without
     * re-executing the top-K candidates. Only enable when the caller has proven
     * its recheck window is identical to this search's `ohlcvData`; the
     * retention is bounded by (param sets x signals) for one asset-strategy
     * pass and released once the caller finishes the asset.
     */
    retainSignals?: boolean;
    /** Fresh-window captures disable Rust until equivalent scalars exist there. */
    researchProgram?: "fresh-window";
    onCandidateSummaryChunk?: (
        rows: FinderAssetOpportunityCandidateSummaryRowType[],
    ) => void | Promise<void>;
}

function buildFreshForwardOutcomes(args: {
    input: ServerAssetIsSearchInput;
    signals: Signal[];
    resolvedSettings: BacktestSettings;
}): FinderAssetOpportunityCandidateSummaryRowType["forwardOutcomes"] {
    const { input, signals, resolvedSettings } = args;
    if (input.researchProgram !== "fresh-window" || !input.forwardData?.length) return undefined;
    const foldCandle = input.ohlcvData[input.ohlcvData.length - 1];
    if (!foldCandle) return undefined;
    const boundarySignal = [...signals]
        .filter((signal) => timeKey(signal.time) === timeKey(foldCandle.time))
        .at(-1);
    if (!boundarySignal || (boundarySignal.type !== "buy" && boundarySignal.type !== "sell")) return undefined;
    const direction = boundarySignal.type === "buy" ? "long" : "short";
    const fullData = [...input.ohlcvData, ...input.forwardData];
    const isNextEntry = resolvedSettings.executionModel !== "signal_close";
    const entryBarIndex = isNextEntry ? input.ohlcvData.length : input.ohlcvData.length - 1;
    const firstForward = input.forwardData[0];
    if (!firstForward) return undefined;
    const rawEntryPrice = resolvedSettings.executionModel === "signal_close"
        ? boundarySignal.price
        : resolvedSettings.executionModel === "next_open"
            ? firstForward.open
            : firstForward.close;
    const slippageRate = Math.max(0, Number(resolvedSettings.slippageBps ?? 0)) / 10_000;
    const entryFillPrice = applySlippage(
        rawEntryPrice,
        entrySideForDirection(direction),
        slippageRate,
    );
    const targets = resolveEntryRiskTargets({
        candles: fullData,
        entryTime: isNextEntry ? firstForward.time : foldCandle.time,
        entryPrice: entryFillPrice,
        direction,
        settings: resolvedSettings,
        entryBarIndex,
    });
    const horizons = input.forwardHorizons?.length ? input.forwardHorizons : [12, 18, 24];
    const outcomes: NonNullable<FinderAssetOpportunityCandidateSummaryRowType["forwardOutcomes"]> = {};
    for (const horizonBars of horizons) {
        if (!Number.isInteger(horizonBars) || horizonBars <= 0) continue;
        const outcome = simulateFinderAssetOpportunityForwardOutcome({
            candles: fullData,
            direction,
            entryPrice: rawEntryPrice,
            entryBarIndex,
            takeProfitPrice: targets.takeProfitPrice,
            stopLossPrice: targets.stopLossPrice,
            horizonBars,
            executionModel: resolvedSettings.executionModel ?? "signal_close",
            allowSameBarExit: resolvedSettings.allowSameBarExit === true,
            slippageBps: Number(resolvedSettings.slippageBps ?? 0),
            commissionPercent: Number(input.capitalSettings.commission ?? 0),
        });
        if (outcome) outcomes[String(horizonBars)] = outcome;
    }
    return Object.keys(outcomes).length > 0 ? outcomes : undefined;
}

function buildSignalCacheKey(input: ServerAssetIsSearchInput, params: StrategyParams): string {
    const fullData = input.fullSignalData!;
    return JSON.stringify([
        input.symbol,
        input.selectedStrategy.key,
        fullData.length,
        fullData[fullData.length - 1]?.time ?? null,
        params,
    ]);
}

type SignalWindow = {
    startIndex: number;
    endIndex: number;
};

/** Find the exact contiguous location of a capped search window in full data. */
function resolveSignalWindow(
    fullData: readonly OHLCVData[],
    windowData: readonly OHLCVData[],
): SignalWindow | null {
    if (windowData.length === 0 || windowData.length > fullData.length) return null;
    const firstTime = timeKey(windowData[0]!.time);
    const lastTime = timeKey(windowData[windowData.length - 1]!.time);
    let startIndex = fullData.findIndex((candle) => timeKey(candle.time) === firstTime);
    while (startIndex >= 0) {
        const endIndex = startIndex + windowData.length;
        if (
            endIndex <= fullData.length
            && timeKey(fullData[endIndex - 1]!.time) === lastTime
        ) {
            let matches = true;
            for (let offset = 1; offset < windowData.length - 1; offset += 1) {
                if (timeKey(fullData[startIndex + offset]!.time) !== timeKey(windowData[offset]!.time)) {
                    matches = false;
                    break;
                }
            }
            if (matches) return { startIndex, endIndex };
        }
        startIndex = fullData.findIndex(
            (candle, index) => index > startIndex && timeKey(candle.time) === firstTime,
        );
    }
    return null;
}

function resolveCachedSignalsForWindow(
    signals: readonly Signal[],
    signalWindow: SignalWindow | null,
): Signal[] | null {
    if (!signals.every((signal) => Number.isInteger(signal.barIndex))) return null;
    if (!signalWindow) return null;
    // Rust uses barIndex for execution state, so cached full-series indexes
    // must be rebased to the local capped dataset before dispatch.
    return signals.flatMap((signal) => {
        const barIndex = signal.barIndex!;
        if (barIndex < signalWindow.startIndex || barIndex >= signalWindow.endIndex) return [];
        return [{ ...signal, barIndex: barIndex - signalWindow.startIndex }];
    });
}

function canReuseFullSignalsForWindow(
    input: ServerAssetIsSearchInput,
    signalWindow: SignalWindow | null,
): boolean {
    // Full-series signal reuse is only valid for primary, deterministic entry
    // signals. These features can introduce data/context outside the supplied
    // primary window, so they retain the direct path.
    return Boolean(
        input.signalCache
        && input.fullSignalData
        && signalWindow
        && !input.exitStrategyCandidates?.length
        && (input.options.dataSlice ?? "all") === "all"
        && input.settings.strategyTimeframeEnabled !== true
        && !input.dataFetcher
        && !input.selectedStrategy.strategy.crossSymbolConfig
        && !input.selectedStrategy.strategy.polymarket1sConfig
        && !(input.settings.confirmationStrategies?.length)
        && input.settings.exitStrategyOverrideEnabled !== true,
    );
}

function buildParamSetCacheKey(
    selectedStrategy: FinderSelectedStrategy,
    entryDefaults: StrategyParams,
    options: FinderOptions,
): string {
    // A random single-run search always returns the normalized default, so its
    // per-asset seed does not affect the cached candidate. Other modes retain
    // the seed because it changes sampled candidate ordering.
    const seed = options.mode === "random" && Number(options.maxRuns) <= 1
        ? ""
        : String(options.randomSeed);
    return [
        selectedStrategy.key,
        serializeParams(entryDefaults),
        options.mode,
        String(options.maxRuns),
        String(options.rangePercent),
        String(options.steps),
        seed,
    ].join("\u0001");
}

export interface ServerAssetIsSearchOutput {
    results: FinderResult[];
    totalCandidatesEvaluated: number;
    candidateEvaluationsAttempted: number;
    candidateEvaluationsCompleted: number;
    candidateEvaluationFailures: number;
    signalCacheHits: number;
    signalCacheMisses: number;
    /**
     * Parallel to `results` (same order): the signals generated by each
     * returned candidate. Present only when `retainSignals` was requested.
     */
    signalsByCandidate?: Signal[][];
    timingsMs: {
        total: number;
        parameterGeneration: number;
        backtest: number;
        yielding: number;
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
 * Run the in-sample search for one asset. Returns the top-N candidates
 * (N = `options.topN`) sorted by `options.sortPriority`.
 *
 * Mirrors the browser `runFinderExecution` candidate loop but uses
 * `executeBacktest` directly so the module stays server-safe. The caller
 * reserves the application candle and slices the historical window BEFORE
 * calling this function; the data passed here is the historical search data.
 */
export async function runServerAssetIsSearch(
    input: ServerAssetIsSearchInput,
): Promise<ServerAssetIsSearchOutput> {
    const { options, settings, capitalSettings, selectedStrategy } = input;
    const freshResearchCapture = input.researchProgram === "fresh-window";
    // `executeBacktest` skips its own confirmation preload when this lean path
    // supplies pre-resolved settings, so load the configured libraries once
    // before the candidate loop.
    if (input.confirmationStrategiesLoaded !== true) {
        await ensureConfirmationStrategiesLoaded(settings);
    }
    const totalStartedAt = performance.now();
    const requiresFullAnalytics = finderAssetSearchRequiresFullAnalytics(options.sortPriority);
    if (selectedStrategy.strategy.crossSymbolConfig && !input.dataFetcher) {
        throw new Error(
            `Cross-symbol strategy "${selectedStrategy.name}" requires secondary asset data for Asset Opportunity.`,
        );
    }
    const preResolvedCapital = resolveCapitalSettingsFromRaw(
        capitalSettings as unknown as Record<string, unknown>,
    );
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    let currentBacktestSettings = settings;
    const preparedStrategy = createPreparedFinderStrategy(
        selectedStrategy.key,
        selectedStrategy.strategy,
        preparedDataCache,
        () => currentBacktestSettings,
    );

    // Build the same base params the current-chart path uses.
    const parameterGenerationStartedAt = performance.now();
    const entryDefaults = buildFinderSearchBaseParams(selectedStrategy.strategy, settings, options);
    const canReuseParamSets = input.paramSetCache
        && options.mode === "random"
        && Number(options.maxRuns) <= 1;
    const paramCacheKey = canReuseParamSets
        ? buildParamSetCacheKey(selectedStrategy, entryDefaults, options)
        : null;
    const cachedParamSets = paramCacheKey
        ? input.paramSetCache!.get(paramCacheKey)
        : undefined;
    let paramSets = cachedParamSets;
    if (!paramSets) {
        const generated = input.generateParamSets(entryDefaults, options);
        const normalized = normalizeFinderCandidateParamSets(selectedStrategy.strategy, generated);
        paramSets = normalized.length > 0
            ? normalized
            : [{ ...selectedStrategy.strategy.defaultParams }];
        if (paramCacheKey) input.paramSetCache!.set(paramCacheKey, paramSets);
    }
    const parameterGenerationMs = performance.now() - parameterGenerationStartedAt;

    const rustBatchFeatureConfig = resolveAssetOpportunityRustBatchFeatureConfig();
    const rustBatchDensityEligible = shouldUseRustAssetOpportunityBatch(
        paramSets.length,
        Number(options.assetOpportunity?.evalLastBars ?? 0),
    );
    const rustBatchEligibility = resolveAssetOpportunityRustBatchEligibility({
        featureConfig: rustBatchFeatureConfig,
        useRustEnginePreference: input.useRustEnginePreference,
        settings,
        capitalSettings,
        selectedStrategy,
        exitStrategyCandidates: input.exitStrategyCandidates,
    });
    if (!freshResearchCapture && rustBatchEligibility.eligible && rustBatchDensityEligible) {
        return runServerAssetIsSearchWithRustBatch({
            input,
            paramSets,
            preparedStrategy,
            preResolvedCapital,
            requiresFullAnalytics,
            parameterGenerationMs,
            rustBatchClient: input.rustBatchClient ?? rustEngine,
            rustBatchFeatureConfig,
            ...(input.rustMultiAssetBatch ? { rustMultiAssetBatch: input.rustMultiAssetBatch } : {}),
            ...(input.rustBatchDatasetCache ? { rustBatchDatasetCache: input.rustBatchDatasetCache } : {}),
            setCurrentBacktestSettings: (nextSettings) => {
                currentBacktestSettings = nextSettings;
            },
        });
    }
    if (rustBatchEligibility.eligible && !rustBatchDensityEligible) {
        debugLogger.event("finder.asset_opportunity.rust_batch.skipped_low_density", {
            symbol: input.symbol,
            candidateCount: paramSets.length,
            dataBars: input.ohlcvData.length,
        });
    }
    const rustBatchFallbackReason = input.useRustEnginePreference === true && !rustBatchEligibility.eligible
        ? `Asset Opportunity Rust batch ineligible: ${rustBatchEligibility.reason ?? "unknown"}`
        : undefined;
    const executionUseRustEnginePreference = freshResearchCapture
        ? false
        : rustBatchEligibility.eligible && !rustBatchDensityEligible
            ? false
            : input.useRustEnginePreference;

    // Bounded top-K accumulation, mirroring the browser single-timeframe path
    // (FinderResultRanker). Keeping only the best `topN` candidates live means
    // the retained `results` set — and, when `retainSignals` is on, the
    // retained signal arrays — stay bounded by `topN` instead of by
    // `maxRuns` (up to 1,000 per asset pass). The ranker's comparator is
    // `compareFinderResults` with strict ordering, so the retained set is
    // identical to a full sort + slice; ties keep insertion order.
    const topKRanker = new FinderResultRanker(
        Math.max(1, options.topN),
        options.sortPriority,
        // Signals are keyed by candidate object identity; drop them when the
        // candidate falls out of the running top-K so the map cannot grow to
        // one entry per evaluated candidate.
        (evicted) => {
            signalsByResult.delete(evicted);
        },
    );
    // Keyed by candidate object identity so the signals survive the final
    // sort + top-N slice without an index bookkeeping pass. Bounded by the
    // ranker's eviction hook above.
    const signalsByResult = new Map<FinderResult, Signal[]>();
    let candidateEvaluationsAttempted = 0;
    let candidateEvaluationsCompleted = 0;
    let candidateEvaluationFailures = 0;
    let signalCacheHits = 0;
    let signalCacheMisses = 0;
    let backtestMs = 0;
    let yieldingMs = 0;
    let evaluationsSinceYield = 0;
    let lastYieldAt = performance.now();
    let rustAttemptedRuns = 0;
    let rustCompletedRuns = 0;
    let rustFallbackRuns = 0;
    let typescriptCompletedRuns = 0;
    const typescriptReasonCounts = new Map<string, number>();
    let researchSummaryChunk: FinderAssetOpportunityCandidateSummaryRow[] = [];
    const emitResearchSummary = async (row: FinderAssetOpportunityCandidateSummaryRow): Promise<void> => {
        if (!freshResearchCapture || !input.onCandidateSummaryChunk) return;
        researchSummaryChunk.push(row);
        if (researchSummaryChunk.length >= FINDER_ASSET_OPPORTUNITY_RESEARCH_CHUNK_SIZE) {
            const chunk = researchSummaryChunk;
            researchSummaryChunk = [];
            await input.onCandidateSummaryChunk(chunk);
        }
    };
    // Cache each exit lib's normalized param space so the per-candidate loop
    // does not regenerate the full space (up to `maxRuns` param objects) once
    // per entry candidate — O(maxRuns^2) allocations otherwise. Generation is
    // deterministic here because the Asset path always sets a finite
    // `options.randomSeed`, so the cached list equals what every in-loop call
    // would produce. Mirrors `exitParamSetsByKey` in the browser
    // `finder-runner.ts` and `finder-runner-universe.ts` runners.
    const exitParamSetsByKey = new Map<string, StrategyParams[]>();
    const getExitParamSets = (selection: FinderSelectedStrategy): StrategyParams[] => {
        const cached = exitParamSetsByKey.get(selection.key);
        if (cached) return cached;
        const exitDefaults = getFinderStrategyParamDefaults(selection.strategy);
        const exitGenerated = input.generateParamSets(exitDefaults, options);
        const exitNormalized = normalizeFinderCandidateParamSets(selection.strategy, exitGenerated);
        const exitParamSets = exitNormalized.length > 0
            ? exitNormalized
            : [{ ...selection.strategy.defaultParams }];
        exitParamSetsByKey.set(selection.key, exitParamSets);
        return exitParamSets;
    };
    const signalWindow = input.fullSignalData
        ? resolveSignalWindow(input.fullSignalData, input.ohlcvData)
        : null;
    const canReuseFullSignals = canReuseFullSignalsForWindow(input, signalWindow);

    for (let index = 0; index < paramSets.length; index++) {
        if (input.isCancelled()) break;
        candidateEvaluationsAttempted += 1;
        const entryParams = paramSets[index]!;

        // Exit Strategy Override: sample one exit strategy + param set per
        // entry candidate (deterministic via the seeded random in the caller).
        let exitStrategy: FinderSelectedStrategy | undefined;
        let exitParams: StrategyParams | undefined;
        if (input.exitStrategyCandidates && input.exitStrategyCandidates.length > 0) {
            // Deterministic sampling: pick by candidate index modulo the exit
            // candidate count. This mirrors the seeded `exitRandom` behavior of
            // the current-chart path without requiring a random source.
            const candidateIndex = index % input.exitStrategyCandidates.length;
            exitStrategy = input.exitStrategyCandidates[candidateIndex];
            const exitParamSets = getExitParamSets(exitStrategy);
            exitParams = exitParamSets[index % exitParamSets.length];
        }

        const combinedParams = exitParams
            ? withExitStrategyBaseParams(entryParams, exitParams)
            : entryParams;
        const candidateFingerprint = buildFinderAssetOpportunityCandidateFingerprint(combinedParams);
        const signalCacheKey = canReuseFullSignals
            ? buildSignalCacheKey(input, entryParams)
            : null;
        const cachedFullSignals = signalCacheKey
            ? input.signalCache!.get(signalCacheKey)
            : undefined;
        const preGeneratedSignals = cachedFullSignals
            ? resolveCachedSignalsForWindow(cachedFullSignals, signalWindow)
            : null;
        if (signalCacheKey) {
            if (preGeneratedSignals !== null) signalCacheHits += 1;
            else signalCacheMisses += 1;
        }
        const candidateStartedAt = performance.now();
        let resolvedCandidateSettings = settings;
        let candidateSignals: Signal[] = [];
        try {
            // Shared candidate execution (risk overrides, exit override
            // injection, executor settings, and the compact endpoint-selection
            // / trade-history option matrix) lives in
            // `finder-asset-candidate-execution.ts`, kept in parity with the
            // browser runner's `executeAssetCandidate`.
            const output = await runAssetCandidateBacktest({
                data: input.ohlcvData,
                symbol: input.symbol,
                interval: input.interval,
                strategy: preparedStrategy,
                strategyKey: selectedStrategy.key,
                strategyParams: entryParams,
                riskOverrideParams: combinedParams,
                settings,
                capitalSettings,
                options,
                ...(exitStrategy
                    ? { exitOverride: { key: exitStrategy.key, params: exitParams ?? {} } }
                    : {}),
                ...(input.dataFetcher ? { dataFetcher: input.dataFetcher } : {}),
                useRustEnginePreference: executionUseRustEnginePreference,
                // The caller has already supplied the historical closed
                // window. Keep its array identity stable so prepared Finder
                // data and executor-side caches can be reused per asset.
                closedCandleDataOverride: input.ohlcvData,
                ...(preGeneratedSignals ? { preGeneratedSignals } : {}),
                needs: {
                    compact: true,
                    trades: freshResearchCapture,
                    fullAnalytics: requiresFullAnalytics,
                    // Compact endpoint-adjusted selection scalars unless the
                    // resolved trade direction is "combined" (which retains
                    // trades instead) — the prior explicit branch, now
                    // centralized in the shared helper.
                    endpointSelection: "auto",
                },
            });
            if (canReuseFullSignals && !cachedFullSignals && signalCacheKey) {
                // The first holdout pays one signal-only full-series pass. Its
                // result is reused by every later holdout in this worker;
                // failures simply leave the existing exact path in place.
                try {
                    const fullSignalOutput = await runAssetCandidateBacktest({
                        data: input.fullSignalData!,
                        symbol: input.symbol,
                        interval: input.interval,
                        strategy: preparedStrategy,
                        strategyKey: selectedStrategy.key,
                        strategyParams: entryParams,
                        riskOverrideParams: combinedParams,
                        settings,
                        capitalSettings,
                        options,
                        useRustEnginePreference: executionUseRustEnginePreference,
                        closedCandleDataOverride: input.fullSignalData,
                        needs: {
                            compact: false,
                            trades: false,
                            fullAnalytics: false,
                            signalsOnly: true,
                            endpointSelection: false,
                        },
                    });
                    const cachedSignals = resolveCachedSignalsForWindow(
                        fullSignalOutput.signals,
                        signalWindow,
                    );
                    if (cachedSignals !== null) {
                        input.signalCache!.set(signalCacheKey, fullSignalOutput.signals);
                    }
                } catch {
                    // Signal reuse is an optimization only; keep the current
                    // candidate result authoritative if the warm pass fails.
                }
            }
            // Keep the prepared-strategy settings provider aligned with the
            // settings the run actually used (risk overrides + exit override).
            currentBacktestSettings = output.backtestSettings;
            resolvedCandidateSettings = output.backtestSettings;
            candidateSignals = output.signals;
            backtestMs += performance.now() - candidateStartedAt;
            candidateEvaluationsCompleted += 1;
            if (output.engineDiagnostics?.rustAttempted) rustAttemptedRuns += 1;
            if (output.engineUsed === "rust") rustCompletedRuns += 1;
            else {
                typescriptCompletedRuns += 1;
                const reason = rustBatchFallbackReason
                    ?? (rustBatchEligibility.eligible && !rustBatchDensityEligible
                        ? "Rust batch skipped: low candidate density"
                        : output.engineDiagnostics?.typescriptReason ?? "TypeScript execution reason unavailable");
                typescriptReasonCounts.set(reason, (typescriptReasonCounts.get(reason) ?? 0) + 1);
                if (output.engineDiagnostics?.rustAttempted) rustFallbackRuns += 1;
            }

            const result: BacktestResult = output.result;
            const selection = output.endpointSelection ?? buildSelectionResult(
                result,
                input.ohlcvData[input.ohlcvData.length - 1]?.time ?? null,
                preResolvedCapital.initialCapital,
            );
            // The current-chart path builds a FinderResult through
            // `enrichFinderCandidate` (endpoint adjustment + selection result).
            // Keep the same endpoint-adjusted selection semantics here so
            // historical ranking and grading use the same capital-aware view.
            const candidate: FinderResult = {
                key: selectedStrategy.key,
                name: selectedStrategy.name,
                params: exitStrategy
                    ? splitExitStrategyParams(combinedParams).entryParams
                    : entryParams,
                ...(exitStrategy
                    ? {
                        exitStrategyKey: exitStrategy.key,
                        exitStrategyParams: exitParams ?? {},
                    }
                    : {}),
                result,
                selectionResult: selection.result,
                endpointAdjusted: selection.adjusted,
                endpointRemovedTrades: selection.removedTrades,
            };
            const passesTradeFilter = matchesFinderTradeCountFilter(candidate.selectionResult.totalTrades, options);
            if (freshResearchCapture) {
                const summary = buildFinderAssetOpportunityCandidateSummaryRow({
                    symbol: input.symbol,
                    strategyKey: selectedStrategy.key,
                    candidateIndex: index,
                    candidateFingerprint,
                    result: candidate.selectionResult,
                    passesTradeFilter,
                });
                const pathSummary = attachFinderAssetOpportunityPathScalars(
                    summary,
                    candidate.selectionResult,
                    input.ohlcvData,
                );
                const forwardOutcomes = buildFreshForwardOutcomes({
                    input,
                    signals: candidateSignals,
                    resolvedSettings: resolvedCandidateSettings,
                });
                await emitResearchSummary({
                    ...pathSummary,
                    ...(forwardOutcomes ? { forwardOutcomes } : {}),
                });
            }
            if (!passesTradeFilter) {
                continue;
            }
            // Attach signals only when the candidate is actually retained:
            // a rejected candidate's signals would otherwise linger in the
            // map until the end of the asset pass. Evictions delete below.
            const retained = topKRanker.offer(candidate);
            if (input.retainSignals === true && retained) {
                signalsByResult.set(candidate, output.signals);
            }
        } catch {
            if (freshResearchCapture) {
                await emitResearchSummary(buildFinderAssetOpportunityCandidateSummaryRow({
                    symbol: input.symbol,
                    strategyKey: selectedStrategy.key,
                    candidateIndex: index,
                    candidateFingerprint,
                }));
            }
            backtestMs += performance.now() - candidateStartedAt;
            candidateEvaluationFailures += 1;
            // Skip failed candidates; the caller counts failures in diagnostics.
            continue;
        }

        evaluationsSinceYield += 1;
        const now = performance.now();
        if (
            evaluationsSinceYield >= ASSET_IS_SEARCH_YIELD_EVERY_RUNS
            || now - lastYieldAt >= ASSET_IS_SEARCH_YIELD_MIN_MS
        ) {
            evaluationsSinceYield = 0;
            lastYieldAt = now;
            const yieldingStartedAt = performance.now();
            await input.yieldControl();
            yieldingMs += performance.now() - yieldingStartedAt;
        }
    }

    if (researchSummaryChunk.length > 0 && input.onCandidateSummaryChunk) {
        const chunk = researchSummaryChunk;
        researchSummaryChunk = [];
        await input.onCandidateSummaryChunk(chunk);
    }

    const topN = Math.max(1, options.topN);
    const topK = topKRanker.toSortedArray(topN);
    return {
        results: topK,
        totalCandidatesEvaluated: paramSets.length,
        candidateEvaluationsAttempted,
        candidateEvaluationsCompleted,
        candidateEvaluationFailures,
        signalCacheHits,
        signalCacheMisses,
        ...(input.retainSignals === true
            ? { signalsByCandidate: topK.map((candidate) => signalsByResult.get(candidate) ?? []) }
            : {}),
        timingsMs: {
            total: performance.now() - totalStartedAt,
            parameterGeneration: parameterGenerationMs,
            backtest: backtestMs,
            yielding: yieldingMs,
        },
        engineUsage: {
            rustAttemptedRuns,
            rustCompletedRuns,
            rustFallbackRuns,
            typescriptCompletedRuns,
            typescriptReasons: [...typescriptReasonCounts.entries()]
                .map(([reason, runs]) => ({ reason, runs }))
                .sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason)),
        },
    };
}

type RustBatchSearchInput = {
    input: ServerAssetIsSearchInput;
    paramSets: StrategyParams[];
    preparedStrategy: ReturnType<typeof createPreparedFinderStrategy>;
    preResolvedCapital: ReturnType<typeof resolveCapitalSettingsFromRaw>;
    requiresFullAnalytics: boolean;
    parameterGenerationMs: number;
    rustBatchClient: AssetOpportunityRustBatchClient;
    rustMultiAssetBatch?: AssetOpportunityRustMultiBatchCoordinator;
    rustBatchFeatureConfig: ReturnType<typeof resolveAssetOpportunityRustBatchFeatureConfig>;
    rustBatchDatasetCache?: Map<string, Promise<string | null>>;
    setCurrentBacktestSettings: (settings: BacktestSettings) => void;
};

type PreparedRustBatchCandidate = {
    id: string;
    entryParams: StrategyParams;
    signals: Signal[];
    backtestSettings: BacktestSettings;
};

type RustDatasetWindow = {
    startIndex: number;
    endIndex: number;
};

/**
 * Resolve the sliced IS window inside the full series used by the persistent
 * Rust cache. Rust receives the full cached series plus these bounds; without
 * a start bound, a trailing evalLastBars window would be replayed from bar 0.
 */
function resolveRustDatasetWindow(
    fullData: OHLCVData[] | undefined,
    windowData: OHLCVData[],
): RustDatasetWindow | null {
    if (!fullData || windowData.length === 0 || windowData.length > fullData.length) return null;
    const first = windowData[0];
    const last = windowData[windowData.length - 1];
    if (!first || !last) return null;
    let lastIndex = fullData.lastIndexOf(last);
    if (lastIndex < 0) {
        const lastTimeKey = timeKey(last.time);
        for (let index = fullData.length - 1; index >= 0; index -= 1) {
            if (timeKey(fullData[index]!.time) === lastTimeKey) {
                lastIndex = index;
                break;
            }
        }
    }
    if (lastIndex < 0) return null;
    const endIndex = lastIndex + 1;
    const startIndex = endIndex - windowData.length;
    if (startIndex < 0) return null;
    const fullLast = fullData[endIndex - 1];
    const fullFirst = fullData[startIndex];
    if (
        !fullLast
        || !fullFirst
        || timeKey(fullLast.time) !== timeKey(last.time)
        || timeKey(fullFirst.time) !== timeKey(first.time)
    ) return null;
    return { startIndex, endIndex };
}

async function runServerAssetIsSearchWithRustBatch(
    args: RustBatchSearchInput,
): Promise<ServerAssetIsSearchOutput> {
    const { input, paramSets, preparedStrategy, preResolvedCapital, requiresFullAnalytics, parameterGenerationMs } = args;
    const { options, settings, capitalSettings, selectedStrategy } = input;
    const totalStartedAt = performance.now();
    const preparedCandidates: PreparedRustBatchCandidate[] = [];
    let candidateEvaluationsAttempted = 0;
    let candidateEvaluationsCompleted = 0;
    let candidateEvaluationFailures = 0;
    let signalCacheHits = 0;
    let signalCacheMisses = 0;
    let candidateBacktestMs = 0;
    let yieldingMs = 0;
    let evaluationsSinceYield = 0;
    let lastYieldAt = performance.now();
    const signalWindow = input.fullSignalData
        ? resolveSignalWindow(input.fullSignalData, input.ohlcvData)
        : null;
    const canReuseFullSignals = canReuseFullSignalsForWindow(input, signalWindow);

    for (let index = 0; index < paramSets.length; index += 1) {
        if (input.isCancelled()) break;
        candidateEvaluationsAttempted += 1;
        const entryParams = paramSets[index]!;
        const candidateId = `asset-opportunity:${index}`;
        const signalCacheKey = canReuseFullSignals
            ? buildSignalCacheKey(input, entryParams)
            : null;
        const cachedFullSignals = signalCacheKey ? input.signalCache!.get(signalCacheKey) : undefined;
        const preGeneratedSignals = cachedFullSignals
            ? resolveCachedSignalsForWindow(cachedFullSignals, signalWindow)
            : null;
        if (signalCacheKey) {
            if (preGeneratedSignals !== null) signalCacheHits += 1;
            else signalCacheMisses += 1;
        }

        try {
            let signals: Signal[];
            let backtestSettings: BacktestSettings;
            if (preGeneratedSignals !== null) {
                const output = await runAssetCandidateBacktest({
                    data: input.ohlcvData,
                    symbol: input.symbol,
                    interval: input.interval,
                    strategy: preparedStrategy,
                    strategyKey: selectedStrategy.key,
                    strategyParams: entryParams,
                    riskOverrideParams: entryParams,
                    settings,
                    capitalSettings,
                    options,
                    useRustEnginePreference: input.useRustEnginePreference,
                    closedCandleDataOverride: input.ohlcvData,
                    preGeneratedSignals,
                    needs: {
                        compact: false,
                        trades: false,
                        fullAnalytics: false,
                        signalsOnly: true,
                        endpointSelection: false,
                    },
                });
                signals = output.signals;
                backtestSettings = output.backtestSettings;
            } else if (canReuseFullSignals && signalCacheKey && input.fullSignalData) {
                const fullOutput = await runAssetCandidateBacktest({
                    data: input.fullSignalData,
                    symbol: input.symbol,
                    interval: input.interval,
                    strategy: preparedStrategy,
                    strategyKey: selectedStrategy.key,
                    strategyParams: entryParams,
                    riskOverrideParams: entryParams,
                    settings,
                    capitalSettings,
                    options,
                    useRustEnginePreference: input.useRustEnginePreference,
                    closedCandleDataOverride: input.fullSignalData,
                    needs: {
                        compact: false,
                        trades: false,
                        fullAnalytics: false,
                        signalsOnly: true,
                        endpointSelection: false,
                    },
                });
                const cachedSignals = resolveCachedSignalsForWindow(
                    fullOutput.signals,
                    signalWindow,
                );
                if (cachedSignals !== null) {
                    input.signalCache!.set(signalCacheKey, fullOutput.signals);
                    signals = cachedSignals;
                    backtestSettings = fullOutput.backtestSettings;
                } else {
                    const output = await runAssetCandidateBacktest({
                        data: input.ohlcvData,
                        symbol: input.symbol,
                        interval: input.interval,
                        strategy: preparedStrategy,
                        strategyKey: selectedStrategy.key,
                        strategyParams: entryParams,
                        riskOverrideParams: entryParams,
                        settings,
                        capitalSettings,
                        options,
                        useRustEnginePreference: input.useRustEnginePreference,
                        closedCandleDataOverride: input.ohlcvData,
                        needs: {
                            compact: false,
                            trades: false,
                            fullAnalytics: false,
                            signalsOnly: true,
                            endpointSelection: false,
                        },
                    });
                    signals = output.signals;
                    backtestSettings = output.backtestSettings;
                }
            } else {
                const output = await runAssetCandidateBacktest({
                    data: input.ohlcvData,
                    symbol: input.symbol,
                    interval: input.interval,
                    strategy: preparedStrategy,
                    strategyKey: selectedStrategy.key,
                    strategyParams: entryParams,
                    riskOverrideParams: entryParams,
                    settings,
                    capitalSettings,
                    options,
                    useRustEnginePreference: input.useRustEnginePreference,
                    closedCandleDataOverride: input.ohlcvData,
                    needs: {
                        compact: false,
                        trades: false,
                        fullAnalytics: false,
                        signalsOnly: true,
                        endpointSelection: false,
                    },
                });
                signals = output.signals;
                backtestSettings = output.backtestSettings;
            }
            args.setCurrentBacktestSettings(backtestSettings);
            preparedCandidates.push({ id: candidateId, entryParams, signals, backtestSettings });
        } catch {
            candidateEvaluationFailures += 1;
        }
        evaluationsSinceYield += 1;
        const now = performance.now();
        if (
            evaluationsSinceYield >= ASSET_IS_SEARCH_YIELD_EVERY_RUNS
            || now - lastYieldAt >= ASSET_IS_SEARCH_YIELD_MIN_MS
        ) {
            evaluationsSinceYield = 0;
            lastYieldAt = now;
            const yieldingStartedAt = performance.now();
            await input.yieldControl();
            yieldingMs += performance.now() - yieldingStartedAt;
        }
    }

    const topKRanker = new FinderResultRanker(Math.max(1, options.topN), options.sortPriority);
    const signalsByResult = new Map<FinderResult, Signal[]>();
    const typescriptReasonCounts = new Map<string, number>();
    let rustAttemptedRuns = 0;
    let rustCompletedRuns = 0;
    let rustFallbackRuns = 0;
    let typescriptCompletedRuns = 0;
    const offer = (candidate: FinderResult, signals: Signal[]): void => {
        if (!matchesFinderTradeCountFilter(candidate.selectionResult.totalTrades, options)) return;
        const retained = topKRanker.offer(candidate);
        if (input.retainSignals === true && retained) signalsByResult.set(candidate, signals);
    };
    const addTypescriptReason = (reason: string): void => {
        typescriptReasonCounts.set(reason, (typescriptReasonCounts.get(reason) ?? 0) + 1);
    };
    // Empty signal sets are valid scalar Rust workloads. Sending them through
    // the same validated batch avoids thousands of per-candidate TypeScript
    // executor calls while preserving the zero-trade result contract.

    if (preparedCandidates.length > 0 && !input.isCancelled()) {
        // `runAssetCandidateBacktest` intentionally sanitizes realism fields
        // before its generic executor call. The Asset Opportunity batch has
        // explicit parity implementations for execution timing, slippage, and
        // entry cooldown, so carry them into the Rust-only request without
        // changing the TypeScript fallback contract.
        const rustSettingsFor = (candidate: PreparedRustBatchCandidate): BacktestSettings => ({
            ...candidate.backtestSettings,
            executionModel: settings.executionModel,
            slippageBps: settings.slippageBps,
            riskCooldownEnabled: settings.riskCooldownEnabled,
            riskCooldownBars: settings.riskCooldownBars,
        });
        const baseSettings = rustSettingsFor(preparedCandidates[0]!);
        let cacheId: string | undefined;
        let cacheKey: string | undefined;
        const rustDatasetWindow = args.rustMultiAssetBatch
            ? resolveRustDatasetWindow(input.fullSignalData, input.ohlcvData)
            : null;
        const rustDataset = rustDatasetWindow && input.fullSignalData
            ? input.fullSignalData
            : input.ohlcvData;
        if (!args.rustMultiAssetBatch
            && args.rustBatchDatasetCache
            && args.rustBatchClient.cacheData
            && args.rustBatchClient.runCachedBatchBacktestWithStatus) {
            cacheKey = buildAssetOpportunityRustDatasetCacheKey({
                symbol: input.symbol,
                interval: input.interval,
                data: rustDataset,
                client: args.rustBatchClient,
            });
            let cachePromise = args.rustBatchDatasetCache.get(cacheKey);
            if (!cachePromise) {
                cachePromise = args.rustBatchClient.cacheData(rustDataset, {
                    signal: input.abortSignal,
                    maxRequestBytes: args.rustBatchFeatureConfig.maxRequestBytes,
                    maxResponseBytes: 1 * 1024 * 1024,
                }).catch(() => null);
                args.rustBatchDatasetCache.set(cacheKey, cachePromise);
            }
            cacheId = (await cachePromise) ?? undefined;
        }
        const dispatched = await (args.rustMultiAssetBatch
            ? args.rustMultiAssetBatch.dispatchCandidate
            : dispatchAssetOpportunityRustBatch)({
            client: args.rustBatchClient,
            data: input.ohlcvData,
            ...(rustDatasetWindow && input.fullSignalData
                ? {
                    cacheData: input.fullSignalData,
                    datasetStartIndex: rustDatasetWindow.startIndex,
                    datasetEndIndex: rustDatasetWindow.endIndex,
                }
                : {}),
            items: preparedCandidates.map<AssetOpportunityRustBatchItem>((candidate) => ({
                id: candidate.id,
                signals: candidate.signals,
                settings: rustSettingsFor(candidate),
            })),
            initialCapital: capitalSettings.initialCapital,
            positionSizePercent: capitalSettings.positionSize,
            commissionPercent: capitalSettings.commission,
            baseSettings,
            lastDataTime: input.ohlcvData[input.ohlcvData.length - 1]?.time ?? null,
            sizing: {
                mode: capitalSettings.sizingMode,
                fixedTradeAmount: capitalSettings.fixedTradeAmount,
                advancedSizing: capitalSettings.advancedSizing,
            },
            maxRequestBytes: args.rustBatchFeatureConfig.maxRequestBytes,
            maxResponseBytes: args.rustBatchFeatureConfig.maxResponseBytes,
            ...(cacheId ? { cacheId } : {}),
            signal: input.abortSignal,
        });

        if (dispatched.status === "completed") {
            candidateBacktestMs += dispatched.latencyMs;
            debugLogger.event("finder.asset_opportunity.rust_batch", {
                symbol: input.symbol,
                status: dispatched.status,
                requests: dispatched.requests,
                items: preparedCandidates.length,
                fallbackItems: 0,
                requestBytes: dispatched.requestBytes,
                latencyMs: Math.round(dispatched.latencyMs),
                cachedDataset: Boolean(cacheId),
            });
            rustAttemptedRuns += preparedCandidates.length;
            rustCompletedRuns += preparedCandidates.length;
            candidateEvaluationsCompleted += preparedCandidates.length;
            for (const candidate of preparedCandidates) {
                const batchResult = dispatched.results.get(candidate.id);
                if (!batchResult) continue;
                const compact = batchResult.selectionResult
                    ? {
                        result: batchResult.result,
                        selectionResult: batchResult.selectionResult,
                        endpointAdjusted: batchResult.endpointAdjusted === true,
                        endpointRemovedTrades: batchResult.endpointRemovedTrades ?? 0,
                    }
                    : normalizeAssetOpportunityRustCandidateResult(
                        batchResult.result,
                        input.ohlcvData[input.ohlcvData.length - 1]?.time ?? null,
                        preResolvedCapital.initialCapital,
                    );
                const finderResult: FinderResult = {
                    key: selectedStrategy.key,
                    name: selectedStrategy.name,
                    params: candidate.entryParams,
                    result: compact.result,
                    selectionResult: compact.selectionResult,
                    endpointAdjusted: compact.endpointAdjusted,
                    endpointRemovedTrades: compact.endpointRemovedTrades,
                };
                offer(finderResult, candidate.signals);
            }
        } else if (dispatched.status === "cancelled") {
            debugLogger.event("finder.asset_opportunity.rust_batch", {
                symbol: input.symbol,
                status: dispatched.status,
                requests: dispatched.requests,
                items: preparedCandidates.length,
                fallbackItems: 0,
                requestBytes: dispatched.requestBytes,
                latencyMs: Math.round(dispatched.latencyMs),
                reason: dispatched.reason,
                cachedDataset: Boolean(cacheId),
            });
        } else if (dispatched.status === "fallback") {
            candidateBacktestMs += dispatched.latencyMs;
            if (cacheKey && dispatched.reason === "http_error") {
                input.rustBatchDatasetCache?.delete(cacheKey);
            }
            debugLogger.event("finder.asset_opportunity.rust_batch", {
                symbol: input.symbol,
                status: dispatched.status,
                requests: dispatched.requests,
                items: preparedCandidates.length,
                fallbackItems: preparedCandidates.length,
                requestBytes: dispatched.requestBytes,
                latencyMs: Math.round(dispatched.latencyMs),
                reason: dispatched.reason,
                cachedDataset: Boolean(cacheId),
            });
            const reason = `Rust batch fallback: ${dispatched.reason}`;
            for (const candidate of preparedCandidates) {
                if (input.isCancelled()) break;
                rustAttemptedRuns += 1;
                rustFallbackRuns += 1;
                const startedAt = performance.now();
                try {
                    const output = await runAssetCandidateBacktest({
                        data: input.ohlcvData,
                        symbol: input.symbol,
                        interval: input.interval,
                        strategy: preparedStrategy,
                        strategyKey: selectedStrategy.key,
                        strategyParams: candidate.entryParams,
                        riskOverrideParams: candidate.entryParams,
                        settings,
                        capitalSettings,
                        options,
                        useRustEnginePreference: input.useRustEnginePreference,
                        closedCandleDataOverride: input.ohlcvData,
                        preGeneratedSignals: candidate.signals,
                        needs: {
                            compact: true,
                            trades: false,
                            fullAnalytics: requiresFullAnalytics,
                            endpointSelection: "auto",
                        },
                    });
                    const selection = output.endpointSelection ?? buildSelectionResult(
                        output.result,
                        input.ohlcvData[input.ohlcvData.length - 1]?.time ?? null,
                        preResolvedCapital.initialCapital,
                    );
                    offer({
                        key: selectedStrategy.key,
                        name: selectedStrategy.name,
                        params: candidate.entryParams,
                        result: output.result,
                        selectionResult: selection.result,
                        endpointAdjusted: selection.adjusted,
                        endpointRemovedTrades: selection.removedTrades,
                    }, candidate.signals);
                    candidateEvaluationsCompleted += 1;
                    typescriptCompletedRuns += 1;
                    addTypescriptReason(reason);
                } catch {
                    candidateEvaluationFailures += 1;
                }
                candidateBacktestMs += performance.now() - startedAt;
            }
        }
    }

    const topK = topKRanker.toSortedArray(Math.max(1, options.topN));
    return {
        results: topK,
        totalCandidatesEvaluated: paramSets.length,
        candidateEvaluationsAttempted,
        candidateEvaluationsCompleted,
        candidateEvaluationFailures,
        signalCacheHits,
        signalCacheMisses,
        ...(input.retainSignals === true
            ? { signalsByCandidate: topK.map((candidate) => signalsByResult.get(candidate) ?? []) }
            : {}),
        timingsMs: {
            total: performance.now() - totalStartedAt,
            parameterGeneration: parameterGenerationMs,
            backtest: candidateBacktestMs,
            yielding: yieldingMs,
        },
        engineUsage: {
            rustAttemptedRuns,
            rustCompletedRuns,
            rustFallbackRuns,
            typescriptCompletedRuns,
            typescriptReasons: [...typescriptReasonCounts.entries()]
                .map(([reason, runs]) => ({ reason, runs }))
                .sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason)),
        },
    };
}
