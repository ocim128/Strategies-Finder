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
import {
    dispatchAssetOpportunityRustBatch,
    normalizeAssetOpportunityRustCandidateResult,
    resolveAssetOpportunityRustBatchEligibility,
    resolveAssetOpportunityRustBatchFeatureConfig,
    type AssetOpportunityRustBatchClient,
    type AssetOpportunityRustBatchItem,
} from "./finder-asset-opportunity-rust-batch";

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
    signalCache?: AssetOpportunitySignalCache;
    abortSignal?: AbortSignal;
    rustBatchClient?: AssetOpportunityRustBatchClient;
    /** Per-iteration cache of Rust dataset uploads, keyed by asset/window. */
    rustBatchDatasetCache?: Map<string, Promise<string | null>>;
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

function resolveCachedSignalsForWindow(
    signals: Signal[],
    data: OHLCVData[],
): Signal[] | null {
    if (!signals.every((signal) => Number.isInteger(signal.barIndex))) return null;
    const length = data.length;
    return signals.filter((signal) => {
        const barIndex = signal.barIndex!;
        return barIndex >= 0 && barIndex < length;
    });
}

function buildRustBatchDatasetCacheKey(
    input: Pick<ServerAssetIsSearchInput, "symbol" | "interval" | "ohlcvData">,
    client: AssetOpportunityRustBatchClient,
): string {
    const dataKey = client.getDataCacheKey?.(input.ohlcvData);
    if (dataKey) return JSON.stringify([input.symbol, input.interval, dataKey]);
    const first = input.ohlcvData[0];
    const last = input.ohlcvData[input.ohlcvData.length - 1];
    return JSON.stringify([
        input.symbol,
        input.interval,
        input.ohlcvData.length,
        first?.time ?? null,
        first?.open ?? null,
        first?.close ?? null,
        last?.time ?? null,
        last?.open ?? null,
        last?.close ?? null,
    ]);
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
    const generated = input.generateParamSets(entryDefaults, options);
    const normalized = normalizeFinderCandidateParamSets(selectedStrategy.strategy, generated);
    const paramSets = normalized.length > 0
        ? normalized
        : [{ ...selectedStrategy.strategy.defaultParams }];
    const parameterGenerationMs = performance.now() - parameterGenerationStartedAt;

    const rustBatchFeatureConfig = resolveAssetOpportunityRustBatchFeatureConfig();
    const rustBatchEligibility = resolveAssetOpportunityRustBatchEligibility({
        featureConfig: rustBatchFeatureConfig,
        useRustEnginePreference: input.useRustEnginePreference,
        settings,
        capitalSettings,
        selectedStrategy,
        exitStrategyCandidates: input.exitStrategyCandidates,
        dataFetcherPresent: input.dataFetcher !== undefined,
    });
    if (rustBatchEligibility.eligible) {
        return runServerAssetIsSearchWithRustBatch({
            input,
            paramSets,
            preparedStrategy,
            preResolvedCapital,
            requiresFullAnalytics,
            parameterGenerationMs,
            rustBatchClient: input.rustBatchClient ?? rustEngine,
            rustBatchFeatureConfig,
            ...(input.rustBatchDatasetCache ? { rustBatchDatasetCache: input.rustBatchDatasetCache } : {}),
            setCurrentBacktestSettings: (nextSettings) => {
                currentBacktestSettings = nextSettings;
            },
        });
    }

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
        const canReuseFullSignals = Boolean(
            input.signalCache
            && input.fullSignalData
            && input.fullSignalData.length >= input.ohlcvData.length
            && !input.exitStrategyCandidates?.length
            && (input.options.dataSlice ?? "all") === "all"
            && Number(input.options.assetOpportunity?.evalLastBars ?? 0) === 0
            && input.settings.strategyTimeframeEnabled !== true,
        );
        const signalCacheKey = canReuseFullSignals
            ? buildSignalCacheKey(input, entryParams)
            : null;
        const cachedFullSignals = signalCacheKey
            ? input.signalCache!.get(signalCacheKey)
            : undefined;
        const preGeneratedSignals = cachedFullSignals
            ? resolveCachedSignalsForWindow(cachedFullSignals, input.ohlcvData)
            : null;
        if (signalCacheKey) {
            if (preGeneratedSignals !== null) signalCacheHits += 1;
            else signalCacheMisses += 1;
        }
        const candidateStartedAt = performance.now();
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
                useRustEnginePreference: input.useRustEnginePreference,
                // The caller has already supplied the historical closed
                // window. Keep its array identity stable so prepared Finder
                // data and executor-side caches can be reused per asset.
                closedCandleDataOverride: input.ohlcvData,
                ...(preGeneratedSignals ? { preGeneratedSignals } : {}),
                needs: {
                    compact: true,
                    trades: false,
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
                    if (fullSignalOutput.signals.every((signal) => Number.isInteger(signal.barIndex))) {
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
            backtestMs += performance.now() - candidateStartedAt;
            candidateEvaluationsCompleted += 1;
            if (output.engineDiagnostics?.rustAttempted) rustAttemptedRuns += 1;
            if (output.engineUsed === "rust") rustCompletedRuns += 1;
            else {
                typescriptCompletedRuns += 1;
                const reason = output.engineDiagnostics?.typescriptReason ?? "TypeScript execution reason unavailable";
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
            if (!matchesFinderTradeCountFilter(candidate.selectionResult.totalTrades, options)) {
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

    const canReuseFullSignals = Boolean(
        input.signalCache
        && input.fullSignalData
        && input.fullSignalData.length >= input.ohlcvData.length
        && (input.options.dataSlice ?? "all") === "all"
        && Number(input.options.assetOpportunity?.evalLastBars ?? 0) === 0
        && input.settings.strategyTimeframeEnabled !== true,
    );

    for (let index = 0; index < paramSets.length; index += 1) {
        if (input.isCancelled()) break;
        candidateEvaluationsAttempted += 1;
        const entryParams = paramSets[index]!;
        const candidateId = `asset-opportunity:${index}`;
        const signalCacheKey = canReuseFullSignals
            ? buildSignalCacheKey(input, entryParams)
            : null;
        const cachedFullSignals = signalCacheKey ? input.signalCache!.get(signalCacheKey) : undefined;
        if (signalCacheKey) {
            if (cachedFullSignals) signalCacheHits += 1;
            else signalCacheMisses += 1;
        }

        try {
            let signals: Signal[];
            let backtestSettings: BacktestSettings;
            if (cachedFullSignals) {
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
                    preGeneratedSignals: resolveCachedSignalsForWindow(cachedFullSignals, input.ohlcvData) ?? [],
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
                if (fullOutput.signals.every((signal) => Number.isInteger(signal.barIndex))) {
                    input.signalCache!.set(signalCacheKey, fullOutput.signals);
                }
                signals = resolveCachedSignalsForWindow(fullOutput.signals, input.ohlcvData) ?? [];
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

    if (preparedCandidates.length > 0 && !input.isCancelled()) {
        const baseSettings = preparedCandidates[0]!.backtestSettings;
        let cacheId: string | undefined;
        let cacheKey: string | undefined;
        if (args.rustBatchDatasetCache && args.rustBatchClient.cacheData && args.rustBatchClient.runCachedBatchBacktestWithStatus) {
            cacheKey = buildRustBatchDatasetCacheKey(input, args.rustBatchClient);
            let cachePromise = args.rustBatchDatasetCache.get(cacheKey);
            if (!cachePromise) {
                cachePromise = args.rustBatchClient.cacheData(input.ohlcvData, {
                    signal: input.abortSignal,
                    maxRequestBytes: args.rustBatchFeatureConfig.maxRequestBytes,
                    maxResponseBytes: 1 * 1024 * 1024,
                }).catch(() => null);
                args.rustBatchDatasetCache.set(cacheKey, cachePromise);
            }
            cacheId = (await cachePromise) ?? undefined;
        }
        const dispatched = await dispatchAssetOpportunityRustBatch({
            client: args.rustBatchClient,
            data: input.ohlcvData,
            items: preparedCandidates.map<AssetOpportunityRustBatchItem>((candidate) => ({
                id: candidate.id,
                signals: candidate.signals,
                settings: candidate.backtestSettings,
            })),
            initialCapital: capitalSettings.initialCapital,
            positionSizePercent: capitalSettings.positionSize,
            commissionPercent: capitalSettings.commission,
            baseSettings,
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
                const compact = normalizeAssetOpportunityRustCandidateResult(
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
