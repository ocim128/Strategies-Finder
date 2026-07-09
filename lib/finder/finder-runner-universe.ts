import { executeBacktest, prepareClosedCandleData, resolveExecutorBacktestSettings } from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { mapWithConcurrencyLimit } from "../async-pool";
import type { CrossSymbolDataFetcher } from "../cross-symbol-runtime";
import { debugLogger } from "../debug-logger";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import { createSeededRandom } from "../param-math-utils";
import type { CapitalSettings } from "../types/backtest";
import type {
    FinderOptions,
    FinderDiagnostics,
    FinderUniverseCandidate,
    FinderUniverseEarlyStopReason,
    FinderUniverseOptions,
    FinderUniverseSymbolResult,
} from "../types/finder";
import type {
    BacktestSettings,
    BacktestResult,
    OHLCVData,
    Strategy,
    StrategyParams,
    Time,
} from "../types/strategies";
import {
    buildFinderSearchBaseParams,
    computeFinderCompositeEdgeRatio,
    getPreparedFinderData,
    normalizeFinderCandidateParamSets,
    resolveFinderRiskOverrides,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import { withExitStrategyBaseParams, splitExitStrategyParams } from "./exit-strategy-param-prefix";
import {
    addElapsed,
    buildFinderDiagnostics,
    buildCompactFinderDiagnostics,
    createEmptyFinderDiagnosticsTimings,
    createFinderRunId,
    getFinderStrategyDiagnosticsStats,
    recordFinderStrategyFailure,
    recordFinderStrategyNoSignals,
    recordFinderStrategySkipped,
    toFinderFailureDiagnostics,
    toFinderStrategyDiagnostics,
    type FinderStrategyDiagnosticsStats,
} from "./finder-diagnostics";
import { buildFinderUniverseCandidate, passesFinderUniverseFilters, FinderUniverseSurvivorRanker } from "./finder-universe-metrics";
import type { FinderSelectedStrategy } from "./finder-runner";

const UNIVERSE_DATA_LOAD_CONCURRENCY = 12;
const UNIVERSE_DATA_LOAD_YIELD_EVERY = 8;
const UNIVERSE_EVALUATION_YIELD_EVERY_RUNS = 256;
const UNIVERSE_EVALUATION_YIELD_MIN_MS = 1000;
const UNIVERSE_UI_UPDATE_MIN_MS = 250;
/**
 * Minimum interval between `onResultsUpdate` dispatches during the candidate
 * loop. The previous path fired onResultsUpdate (which re-sorted and re-rendered)
 * once per surviving candidate — on a 100-symbol × 1000-candidate run that was
 * hundreds of full re-sorts + DOM rebuilds of the survivor table. Throttling
 * matches the current-chart Finder's 750ms results-update cadence; the final
 * getSortedSurvivors(topN) at loop end is still the source of truth for ranking.
 */
const UNIVERSE_RESULTS_UPDATE_MIN_MS = 750;
const UNIVERSE_ZERO_SIGNAL_BAIL_THRESHOLD = 5;
const DIRECTIONAL_LOOKBACK_BARS = 96;

interface FinderUniverseLoadedSymbol {
    symbol: string;
    data: OHLCVData[];
    barCount: number;
    firstTime?: Time;
    lastTime?: Time;
    firstClose?: number;
    lastClose?: number;
    directionalLookbackClose?: number;
    directionalLookbackBars?: number;
    maxPossibleTrades: number;
}

export interface FinderUniverseRunInput {
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategy: FinderSelectedStrategy;
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    getProvider?: (symbol: string) => string;
    generateParamSets: (defaultParams: Record<string, number>, options: FinderOptions) => Record<string, number>[];
    /** Candidate exit strategies Finder may sample for Exit Strategy Override. */
    exitStrategyCandidates?: FinderSelectedStrategy[];
    /**
     * Mirrors the user's Rust-engine UI toggle for the server-side path. In the
     * browser, `shouldAttemptRust` reads the DOM directly and ignores this; in
     * Node (server-side plugin) there is no DOM, so an explicit `true` here is
     * the only way Rust is attempted — the documented "Rust-engine trap" fix
     * (see `shouldAttemptRust` in `lib/backtest-executor.ts`). Left undefined by
     * the browser caller; set by the server plugin from the request body.
     */
    useRustEnginePreference?: boolean;
}

export interface FinderUniverseRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    yieldControl: () => Promise<void>;
    isCancelled: () => boolean;
    onResultsUpdate?: (results: FinderUniverseCandidate[]) => void;
}

export interface FinderUniverseRunOutput {
    results: FinderUniverseCandidate[];
    loadedSymbols: number;
    failedSymbols: string[];
    diagnostics?: FinderDiagnostics;
}

type FinderUniverseTimingSummary = {
    totalRunMs: number;
    loadMs: number;
    evaluationMs: number;
    symbolCount: number;
    loadedSymbolCount: number;
    candidateCount: number;
    keptCandidateCount: number;
};

type FinderUniversePartialCounts = {
    activeSymbols: number;
    profitableSymbols: number;
    totalTrades: number;
};

type FinderUniverseLoadOutcome =
    | { status: "loaded"; symbol: FinderUniverseLoadedSymbol }
    | { status: "failed"; symbol: string; result: FinderUniverseSymbolResult }
    | { status: "cancelled"; symbol: string };

function createPreparedStrategy(
    strategyKey: string,
    strategy: Strategy,
    cache: FinderPreparedDataCache,
    getSettings: () => BacktestSettings,
    onTiming?: (timing: { preparedDataMs: number; signalExecutionMs: number; totalMs: number; signalCount: number; usedPreparedData: boolean }) => void
): Strategy {
    const canUsePreparedData = Boolean(strategy.prepareFinderData && strategy.executePrepared);

    const wrapped = Object.create(Object.getPrototypeOf(strategy)) as Strategy;
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(strategy));
    wrapped.execute = (data, params, executionContext) => {
        const startedAt = performance.now();
        let preparedDataMs = 0;
        let signalExecutionMs = 0;
        let signals: ReturnType<Strategy["execute"]> | undefined;
        try {
            if (canUsePreparedData) {
                let prepared: unknown;
                const preparedStartedAt = performance.now();
                try {
                    prepared = getPreparedFinderData(
                        cache,
                        strategyKey,
                        strategy,
                        data,
                        getSettings(),
                        executionContext
                    );
                } finally {
                    preparedDataMs = performance.now() - preparedStartedAt;
                }

                const signalStartedAt = performance.now();
                try {
                    signals = strategy.executePrepared!(prepared, params, data, executionContext);
                } finally {
                    signalExecutionMs = performance.now() - signalStartedAt;
                }
            } else {
                const signalStartedAt = performance.now();
                try {
                    signals = strategy.execute(data, params, executionContext);
                } finally {
                    signalExecutionMs = performance.now() - signalStartedAt;
                }
            }
            return signals ?? [];
        } finally {
            onTiming?.({
                preparedDataMs,
                signalExecutionMs,
                totalMs: performance.now() - startedAt,
                signalCount: signals?.length ?? -1,
                usedPreparedData: canUsePreparedData,
            });
        }
    };
    return wrapped;
}

function normalizeUniverseSymbols(symbols: readonly string[]): string[] {
    const unique = new Set<string>();
    for (const symbol of symbols) {
        const normalized = symbol.trim().toUpperCase();
        if (normalized) {
            unique.add(normalized);
        }
    }
    return [...unique];
}

function buildLoadFailedResult(symbol: string, error: string): FinderUniverseSymbolResult {
    return {
        symbol,
        status: "load_failed",
        barCount: 0,
        error,
    };
}

function buildRunFailedResult(symbol: FinderUniverseLoadedSymbol, error: string): FinderUniverseSymbolResult {
    return {
        symbol: symbol.symbol,
        status: "run_failed",
        barCount: symbol.barCount,
        firstTime: symbol.firstTime,
        lastTime: symbol.lastTime,
        firstClose: symbol.firstClose,
        lastClose: symbol.lastClose,
        directionalLookbackClose: symbol.directionalLookbackClose,
        directionalLookbackBars: symbol.directionalLookbackBars,
        error,
    };
}

function buildUniverseSymbolMetrics(
    result: BacktestResult,
    options: {
        compositeEdgeRatio?: number;
        sharpeRatioAvailable?: boolean;
        drawdownAvailable?: boolean;
    } = {}
): NonNullable<FinderUniverseSymbolResult["result"]> {
    return {
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        expectancy: result.expectancy,
        avgTrade: result.avgTrade,
        winRate: result.winRate,
        profitFactor: result.profitFactor,
        totalTrades: result.totalTrades,
        maxDrawdownPercent: result.maxDrawdownPercent,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
        sharpeRatio: result.sharpeRatio,
        sharpeRatioAvailable: options.sharpeRatioAvailable === true,
        drawdownAvailable: options.drawdownAvailable === true,
        ...(typeof options.compositeEdgeRatio === "number" && Number.isFinite(options.compositeEdgeRatio)
            ? { compositeEdgeRatio: options.compositeEdgeRatio }
            : {}),
    };
}

function buildSymbolResult(
    symbol: FinderUniverseLoadedSymbol,
    result: Awaited<ReturnType<typeof executeBacktest>>["result"],
    options: Parameters<typeof buildUniverseSymbolMetrics>[1] = {}
): FinderUniverseSymbolResult {
    let status: FinderUniverseSymbolResult["status"];
    if (result.totalTrades <= 0) {
        status = "no_trades";
    } else if (result.netProfit > 0.0001) {
        status = "profitable";
    } else if (result.netProfit < -0.0001) {
        status = "losing";
    } else {
        status = "flat";
    }

    return {
        symbol: symbol.symbol,
        status,
        barCount: symbol.barCount,
        firstTime: symbol.firstTime,
        lastTime: symbol.lastTime,
        firstClose: symbol.firstClose,
        lastClose: symbol.lastClose,
        directionalLookbackClose: symbol.directionalLookbackClose,
        directionalLookbackBars: symbol.directionalLookbackBars,
        result: buildUniverseSymbolMetrics(result, options),
    };
}

function resolveEarlyStopReason(args: {
    counts: FinderUniversePartialCounts;
    remainingSymbols: number;
    remainingMaxTrades: number;
    universe: FinderUniverseOptions;
}): FinderUniverseEarlyStopReason | null {
    const { counts, remainingSymbols, remainingMaxTrades, universe } = args;

    if ((counts.activeSymbols + remainingSymbols) < universe.minActiveSymbols) {
        return "unreachable_active_symbols";
    }

    if ((counts.totalTrades + remainingMaxTrades) < universe.minTotalTrades) {
        return "unreachable_total_trades";
    }

    const maxProfitableRatio = (counts.profitableSymbols + remainingSymbols)
        / Math.max(1, counts.activeSymbols + remainingSymbols);
    if (maxProfitableRatio + 0.0001 < universe.minProfitableActiveRatio) {
        return "unreachable_profitable_ratio";
    }

    return null;
}

function accumulatePartialCounts(counts: FinderUniversePartialCounts, result: FinderUniverseSymbolResult): void {
    if (!result.result || result.result.totalTrades <= 0) {
        return;
    }

    counts.activeSymbols += 1;
    counts.totalTrades += result.result.totalTrades;

    if (result.result.netProfit > 0.0001) {
        counts.profitableSymbols += 1;
    }
}

function passesUniverseFiltersFromCounts(
    counts: FinderUniversePartialCounts,
    universe: FinderUniverseOptions
): boolean {
    if (counts.activeSymbols < universe.minActiveSymbols) {
        return false;
    }
    if (counts.totalTrades < universe.minTotalTrades) {
        return false;
    }
    const profitableActiveRatio = counts.activeSymbols > 0
        ? counts.profitableSymbols / counts.activeSymbols
        : 0;
    return profitableActiveRatio >= universe.minProfitableActiveRatio;
}

/**
 * A single universe evaluation plan: the combined entry+exit params to feed into
 * `executeBacktest`, plus the sampled exit-strategy identity (when Exit Strategy
 * Override is active) so the survivor row can show which lib was used.
 */
interface UniverseCandidatePlan {
    params: StrategyParams;
    exitStrategyKey?: string;
    exitStrategyName?: string;
    exitStrategyParams?: StrategyParams;
}

/**
 * Build the per-candidate plan list for one selected entry strategy.
 *
 * When Exit Strategy Override is off (no candidates), this is just the entry
 * strategy's normalized param sets wrapped in plans with no exit identity.
 *
 * When override is on, mirrors the current-chart Finder: each entry param set
 * is paired with one randomly-sampled exit strategy lib + one of its param
 * sets, merged via the `_exit__` prefix. The exit half is split back out so
 * `executeBacktest` receives clean entry params and a separate exit descriptor.
 */
function buildUniverseCandidatePlans(args: {
    selectedStrategy: FinderSelectedStrategy;
    exitStrategyCandidates: readonly FinderSelectedStrategy[];
    settings: BacktestSettings;
    options: FinderOptions;
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
}): UniverseCandidatePlan[] {
    const { selectedStrategy, exitStrategyCandidates, settings, options, generateParamSets } = args;
    const exitActive = exitStrategyCandidates.length > 0;

    if (!exitActive) {
        const baseParams = buildFinderSearchBaseParams(selectedStrategy.strategy, settings, options);
        const paramSets = normalizeFinderCandidateParamSets(
            selectedStrategy.strategy,
            generateParamSets(baseParams, options),
        );
        return paramSets.map((params) => ({ params }));
    }

    // Entry space excludes exit params; exit space is sampled per entry param set.
    const entryOptions: FinderOptions = { ...options, exitStrategyBaseParams: undefined };
    const entryBaseParams = buildFinderSearchBaseParams(selectedStrategy.strategy, settings, entryOptions);
    const entryParamSets = normalizeFinderCandidateParamSets(
        selectedStrategy.strategy,
        generateParamSets(entryBaseParams, options),
    );
    if (entryParamSets.length === 0) return [];

    const randomFn = options.mode === "random" && Number.isFinite(options.randomSeed)
        ? createSeededRandom(Number(options.randomSeed) + 0x9e3779b9)
        : Math.random;

    // Cache each exit lib's normalized param space so we don't regenerate it per entry set.
    const exitParamSetsByKey = new Map<string, StrategyParams[]>();
    const getExitParamSets = (selection: FinderSelectedStrategy): StrategyParams[] => {
        const cached = exitParamSetsByKey.get(selection.key);
        if (cached) return cached;
        const generated = generateParamSets(selection.strategy.defaultParams, options);
        const normalized = normalizeFinderCandidateParamSets(selection.strategy, generated);
        const paramSets = normalized.length > 0
            ? normalized
            : [{ ...selection.strategy.defaultParams }];
        exitParamSetsByKey.set(selection.key, paramSets);
        return paramSets;
    };

    const plans: UniverseCandidatePlan[] = [];
    for (const entryParams of entryParamSets) {
        const exitSelection = exitStrategyCandidates[Math.floor(randomFn() * exitStrategyCandidates.length)]!;
        const exitParamSets = getExitParamSets(exitSelection);
        const sampledExitParams = exitParamSets[Math.floor(randomFn() * exitParamSets.length)]
            ?? exitSelection.strategy.defaultParams;
        const combinedParams: StrategyParams = {
            ...entryParams,
            ...withExitStrategyBaseParams({}, sampledExitParams),
        };
        plans.push({
            params: combinedParams,
            exitStrategyKey: exitSelection.key,
            exitStrategyName: exitSelection.name,
            exitStrategyParams: { ...sampledExitParams },
        });
    }
    return plans;
}

function assertUniverseRunSupported(input: FinderUniverseRunInput): FinderUniverseOptions {
    const universe = input.options.universe;
    if (!universe) {
        throw new Error("Universe options are missing.");
    }
    if (input.options.mode !== "random") {
        throw new Error("Symbol Universe mode supports Random Search only in v1.");
    }
    if (input.options.polymarketScoringEnabled) {
        throw new Error("Symbol Universe mode does not support Polymarket scoring in v1.");
    }
    if (input.selectedStrategy.strategy.polymarket1sConfig) {
        throw new Error("Symbol Universe mode does not support 1s Polymarket context strategies in v1.");
    }
    if (input.options.comboEnabled) {
        throw new Error("Symbol Universe mode does not support combo mode in v1.");
    }
    if (input.options.multiTimeframeEnabled) {
        throw new Error("Symbol Universe mode does not support multi-timeframe runs in v1.");
    }
    if (input.settings.strategyTimeframeEnabled) {
        throw new Error("Symbol Universe mode does not support strategy timeframe resampling in v1.");
    }
    if (universe.symbols.length === 0) {
        throw new Error("Add at least one symbol for Symbol Universe mode.");
    }
    return universe;
}

export async function runFinderUniverseExecution(
    input: FinderUniverseRunInput,
    callbacks: FinderUniverseRunCallbacks
): Promise<FinderUniverseRunOutput> {
    const universe = assertUniverseRunSupported(input);
    const normalizedSymbols = normalizeUniverseSymbols(universe.symbols);
    if (normalizedSymbols.length === 0) {
        throw new Error("Add at least one valid symbol for Symbol Universe mode.");
    }

    const totalRunStart = performance.now();
    const runId = createFinderRunId("finder-universe");
    const timings = createEmptyFinderDiagnosticsTimings();
    const strategyStatsByKey = new Map<string, FinderStrategyDiagnosticsStats>();
    const strategyStats = getFinderStrategyDiagnosticsStats(strategyStatsByKey, input.selectedStrategy);
    const signalTimingByRun = {
        preparedDataMs: 0,
        signalMs: 0,
        totalMs: 0,
        observed: false,
    };
    let processedRuns = 0;
    let failedRuns = 0;
    let skippedRuns = 0;
    const measuredYield = async (): Promise<void> => {
        const startedAt = performance.now();
        await callbacks.yieldControl();
        addElapsed(timings, "yielding", startedAt);
    };
    let loadYieldCount = 0;
    const maybeYieldDuringLoad = async (): Promise<void> => {
        loadYieldCount += 1;
        if (loadYieldCount % UNIVERSE_DATA_LOAD_YIELD_EVERY === 0) {
            await measuredYield();
        }
    };
    let evaluationsSinceYield = 0;
    let lastEvaluationYieldAt = performance.now();
    const maybeYieldDuringEvaluation = async (): Promise<void> => {
        evaluationsSinceYield += 1;
        const now = performance.now();
        if (
            evaluationsSinceYield < UNIVERSE_EVALUATION_YIELD_EVERY_RUNS
            && now - lastEvaluationYieldAt < UNIVERSE_EVALUATION_YIELD_MIN_MS
        ) {
            return;
        }

        evaluationsSinceYield = 0;
        lastEvaluationYieldAt = now;
        await measuredYield();
    };
    const loadStart = performance.now();
    const loadedSymbols: FinderUniverseLoadedSymbol[] = [];
    const loadFailures = new Map<string, FinderUniverseSymbolResult>();
    const loadCache = new Map<string, Promise<OHLCVData[]>>();
    const datasetAbort = new AbortController();

    const getOrLoadDataset = (symbol: string, interval = input.interval): Promise<OHLCVData[]> => {
        const key = `${symbol}|${interval}`;
        const cached = loadCache.get(key);
        if (cached) {
            return cached;
        }
        const promise = input.loadDataset(symbol, interval, datasetAbort.signal);
        loadCache.set(key, promise);
        return promise;
    };
    let crossSymbolDataFetcher: CrossSymbolDataFetcher | undefined;
    if (input.selectedStrategy.strategy.crossSymbolConfig) {
        if (!input.getProvider) {
            throw new Error("Symbol Universe cross-symbol runs require a provider lookup.");
        }
        crossSymbolDataFetcher = {
            getProvider: input.getProvider,
            fetchDataDetached: (symbol, interval) => getOrLoadDataset(symbol, interval),
        };
    }

    callbacks.setProgress(0, "Preparing symbol universe...");
    callbacks.setStatus("Loading universe symbols...");

    let completedLoads = 0;
    const loadOutcomes = await mapWithConcurrencyLimit(
        normalizedSymbols,
        UNIVERSE_DATA_LOAD_CONCURRENCY,
        async (symbol, index): Promise<FinderUniverseLoadOutcome> => {
            if (callbacks.isCancelled()) {
                datasetAbort.abort();
                return { status: "cancelled", symbol };
            }

            callbacks.setProgress((completedLoads / Math.max(1, normalizedSymbols.length)) * 15, `Loading ${symbol} (${index + 1}/${normalizedSymbols.length})...`);
            callbacks.setStatus(`Loading ${symbol} ${input.interval}...`);

            try {
                const data = await getOrLoadDataset(symbol, input.interval);
                if (!Array.isArray(data) || data.length === 0) {
                    return { status: "failed", symbol, result: buildLoadFailedResult(symbol, "No candles returned.") };
                }
                const directionalLookbackBars = Math.min(DIRECTIONAL_LOOKBACK_BARS, Math.max(0, data.length - 1));
                const directionalLookbackIndex = Math.max(0, data.length - 1 - directionalLookbackBars);

                return {
                    status: "loaded",
                    symbol: {
                        symbol,
                        data,
                        barCount: data.length,
                        firstTime: data[0]?.time,
                        lastTime: data[data.length - 1]?.time,
                        firstClose: data[0]?.close,
                        lastClose: data[data.length - 1]?.close,
                        directionalLookbackClose: data[directionalLookbackIndex]?.close,
                        directionalLookbackBars,
                        maxPossibleTrades: data.length,
                    },
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { status: "failed", symbol, result: buildLoadFailedResult(symbol, message) };
            } finally {
                completedLoads += 1;
                callbacks.setProgress((completedLoads / Math.max(1, normalizedSymbols.length)) * 15, `Loaded ${completedLoads}/${normalizedSymbols.length} symbols...`);
                await maybeYieldDuringLoad();
            }
        }
    );

    for (const outcome of loadOutcomes) {
        if (outcome.status === "loaded") {
            loadedSymbols.push(outcome.symbol);
        } else if (outcome.status === "failed") {
            loadFailures.set(outcome.symbol, outcome.result);
        }
        if (callbacks.isCancelled()) {
            datasetAbort.abort();
            break;
        }
    }

    const loadMs = performance.now() - loadStart;
    timings.dataLoading = loadMs;
    if (callbacks.isCancelled()) {
        return {
            results: [],
            loadedSymbols: loadedSymbols.length,
            failedSymbols: [...loadFailures.keys()],
        };
    }

    if (loadedSymbols.length === 0) {
        // Surface per-symbol load failures so the caller (and the user via
        // Copy Diagnostics) can see WHY every symbol failed instead of just
        // "No universe symbols could be loaded." This is the only signal the
        // user gets when the universe is empty; without it, debugging offline
        // data sources like stock_market_data is guesswork.
        const failureDetail = [...loadFailures.entries()]
            .slice(0, 20)
            .map(([symbol, result]) => `${symbol}: ${result.error ?? "unknown error"}`)
            .join("; ");
        const err = new Error(
            failureDetail
                ? `No universe symbols could be loaded. Failures: ${failureDetail}`
                : "No universe symbols could be loaded."
        );
        (err as Error & { loadFailures?: typeof loadFailures }).loadFailures = loadFailures;
        throw err;
    }

    const rustSettings = sanitizeBacktestSettingsForRust(input.settings);
    const paramGenerationStartedAt = performance.now();
    const candidatePlans = buildUniverseCandidatePlans({
        selectedStrategy: input.selectedStrategy,
        exitStrategyCandidates: input.options.exitStrategyOverrideEnabled
            ? (input.exitStrategyCandidates ?? [])
            : [],
        settings: input.settings,
        options: input.options,
        generateParamSets: input.generateParamSets,
    });
    addElapsed(timings, "paramGeneration", paramGenerationStartedAt);
    if (candidatePlans.length === 0) {
        callbacks.setStatus("No valid parameter combinations generated.");
        return {
            results: [],
            loadedSymbols: loadedSymbols.length,
            failedSymbols: [...loadFailures.keys()],
        };
    }

    const closedDataPrecomputeStart = performance.now();
    const runNowSec = Math.floor(Date.now() / 1000);
    const hasCrossSymbol = Boolean(input.selectedStrategy.strategy.crossSymbolConfig);
    const closedDataBySymbol = new Map<string, OHLCVData[]>();
    if (!hasCrossSymbol) {
        for (const sym of loadedSymbols) {
            closedDataBySymbol.set(
                sym.symbol,
                prepareClosedCandleData(sym.data, input.interval, input.settings, runNowSec),
            );
        }
    }
    addElapsed(timings, "closedDataSelection", closedDataPrecomputeStart);

    const preResolvedCapital = resolveCapitalSettingsFromRaw(input.capitalSettings as unknown as Record<string, unknown>);

    // Warm confirmation strategy cache once so per-run executeBacktest calls can skip it
    {
        const warmSettings = resolveExecutorBacktestSettings(
            { ...(input.settings as Record<string, unknown>), interval: input.interval } as BacktestSettings,
            input.interval,
        );
        const { ensureConfirmationStrategiesLoaded } = await import("../confirmation-signal-filter");
        await ensureConfirmationStrategiesLoaded(warmSettings);
    }

    const evaluationStart = performance.now();
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const requiresSharpeRatio = universe.sortPriority.includes("medianSharpe");
    // Composite Edge Ratio needs per-trade OHLCV lookups; only compute when the
    // active sort requests it, and only for non-cross-symbol runs where we have
    // a clean closed-candle series matching what the backtest ran on.
    const requiresCompositeEdgeRatio = !hasCrossSymbol
        && universe.sortPriority.includes("medianCompositeEdgeRatio");
    const maxStoredSurvivors = Math.max(input.options.topN, 50);
    // Bounded top-K survivor store (see FinderUniverseSurvivorRanker). Replaces
    // the push-then-full-sort-and-trim buffer: every passing candidate used to
    // trigger getSortedSurvivors(topN) (a full sort of up to maxStoredSurvivors
    // entries) on onResultsUpdate. The ranker keeps survivor SET parity with the
    // old path via an explicit insertion-order tie-breaker.
    const survivorRanker = new FinderUniverseSurvivorRanker(maxStoredSurvivors, universe.sortPriority);
    let keptCandidateCount = 0;
    // -Infinity so the FIRST surviving candidate always fires onResultsUpdate
    // immediately (now - (-Infinity) >= throttle is always true). Subsequent
    // fires respect UNIVERSE_RESULTS_UPDATE_MIN_MS. The final render at loop
    // end (caller does setLatestResults + renderLatestResults) is the source of
    // truth, so a stale mid-run view between throttle windows is acceptable.
    let lastResultsUpdateAt = Number.NEGATIVE_INFINITY;
    const getSortedSurvivors = (limit: number): FinderUniverseCandidate[] =>
        survivorRanker.toSortedArray(limit);
    const offerSurvivor = (candidate: FinderUniverseCandidate): void => {
        survivorRanker.offer(candidate);
        keptCandidateCount += 1;
    };
    const totalPossibleTrades = loadedSymbols.reduce((sum, item) => sum + item.maxPossibleTrades, 0);
    const totalInputBars = loadedSymbols.reduce((sum, item) => sum + item.barCount, 0);
    let lastEvaluationUiUpdateAt = 0;
    const updateEvaluationProgress = (percent: number, text: string, status: string, force = false): void => {
        const now = performance.now();
        if (!force && now - lastEvaluationUiUpdateAt < UNIVERSE_UI_UPDATE_MIN_MS) return;
        lastEvaluationUiUpdateAt = now;
        callbacks.setProgress(percent, text);
        callbacks.setStatus(status);
    };
    // Build the timing-instrumented strategy wrapper ONCE per (strategy, run).
    // The wrapper is identical for every param set; only the per-candidate
    // `backtestSettings` varies, and it is read through `currentBacktestSettings`
    // at execute time so the closure stays valid across iterations. Avoids
    // M-1 proto-clone + property-descriptor allocations per symbol per run.
    let currentBacktestSettings: BacktestSettings = input.settings;
    const preparedStrategy = createPreparedStrategy(
        input.selectedStrategy.key,
        input.selectedStrategy.strategy,
        preparedDataCache,
        () => currentBacktestSettings,
        (signalTiming) => {
            signalTimingByRun.observed = true;
            signalTimingByRun.preparedDataMs += signalTiming.preparedDataMs;
            signalTimingByRun.signalMs += signalTiming.signalExecutionMs;
            signalTimingByRun.totalMs += signalTiming.totalMs;
            strategyStats.signalMs += signalTiming.signalExecutionMs;
            strategyStats.usedPreparedData = strategyStats.usedPreparedData || signalTiming.usedPreparedData;
            if (signalTiming.signalCount === 0) {
                recordFinderStrategyNoSignals(strategyStats);
            }
        }
    );
    for (let candidateIndex = 0; candidateIndex < candidatePlans.length; candidateIndex += 1) {
        if (callbacks.isCancelled()) {
            break;
        }

        const plan = candidatePlans[candidateIndex];
        const params = plan.params;
        // When Exit Strategy Override is active, split the `_exit__`-prefixed half
        // out so the entry strategy sees only its own params, and inject the sampled
        // exit descriptor into per-candidate backtest settings for executeBacktest.
        const { entryParams, exitParams } = plan.exitStrategyKey
            ? splitExitStrategyParams(params)
            : { entryParams: params, exitParams: undefined };
        const { backtestSettings: riskAdjustedSettings } = resolveFinderRiskOverrides(input.settings, rustSettings, params, input.options);
        const backtestSettings: BacktestSettings = plan.exitStrategyKey
            ? {
                ...riskAdjustedSettings,
                disableSignalExits: true,
                exitStrategyOverrideEnabled: true,
                exitStrategyKey: plan.exitStrategyKey,
                exitStrategyParams: { ...(exitParams ?? {}) },
            }
            : riskAdjustedSettings;
        currentBacktestSettings = backtestSettings;
        const preResolvedSettings = resolveExecutorBacktestSettings(
            { ...(backtestSettings as Record<string, unknown>), interval: input.interval } as BacktestSettings,
            input.interval,
        );

        const symbolResults = new Map<string, FinderUniverseSymbolResult>();
        let evaluationStoppedEarly = false;
        let stoppedReason: FinderUniverseEarlyStopReason | undefined;
        const partialCounts: FinderUniversePartialCounts = {
            activeSymbols: 0,
            profitableSymbols: 0,
            totalTrades: 0,
        };
        let remainingSymbols = loadedSymbols.length;
        let remainingMaxTrades = totalPossibleTrades;
        let consecutiveZeroSignalSymbols = 0;

        for (let symbolIndex = 0; symbolIndex < loadedSymbols.length; symbolIndex += 1) {
            if (callbacks.isCancelled()) {
                break;
            }

            const symbol = loadedSymbols[symbolIndex];
            const progressBase = candidateIndex / Math.max(1, candidatePlans.length);
            const progressWithin = symbolIndex / Math.max(1, loadedSymbols.length);
            const progress = 15 + ((progressBase + (progressWithin / Math.max(1, candidatePlans.length))) * 85);

            updateEvaluationProgress(
                progress,
                `Testing ${input.selectedStrategy.name} on ${symbol.symbol} (${candidateIndex + 1}/${candidatePlans.length})...`,
                `Evaluating candidate ${candidateIndex + 1}/${candidatePlans.length} on ${symbol.symbol}...`,
                candidateIndex === 0 && symbolIndex === 0,
            );

            let zeroSignals = false;
            const runStartedAt = performance.now();
            try {
                signalTimingByRun.preparedDataMs = 0;
                signalTimingByRun.signalMs = 0;
                signalTimingByRun.totalMs = 0;
                signalTimingByRun.observed = false;
                const output = await executeBacktest({
                    ohlcvData: symbol.data,
                    closedCandleDataOverride: hasCrossSymbol ? undefined : closedDataBySymbol.get(symbol.symbol),
                    interval: input.interval,
                    primarySymbol: symbol.symbol,
                    strategyKey: input.selectedStrategy.key,
                    strategy: preparedStrategy,
                    strategyParams: entryParams,
                    backtestSettings,
                    capitalSettings: input.capitalSettings,
                    preResolvedSettings,
                    preResolvedCapital,
                    dataFetcher: crossSymbolDataFetcher,
                    context: {
                        blockRange: null,
                        annotatePolymarket: false,
                        engineMode: "auto",
                        // Thread the server-side Rust preference through. In the
                        // browser this is undefined (shouldAttemptRust reads the
                        // DOM); in Node it's the only signal that opts in to
                        // Rust (the documented Rust-engine trap fix).
                        useRustEnginePreference: input.useRustEnginePreference,
                        nowSec: runNowSec,
                    },
                    backtestRunOptions: {
                        includeAdvancedAnalytics: false,
                        includeSharpeRatio: requiresSharpeRatio,
                        omitEquityCurve: !requiresSharpeRatio,
                        skipDrawdown: true,
                        skipResultPostProcessing: true,
                    },
                });
                zeroSignals = output.signals.length === 0;
                const runMs = performance.now() - runStartedAt;
                processedRuns += 1;
                strategyStats.runs += 1;
                strategyStats.totalMs += runMs;
                strategyStats.backtestMs += Math.max(0, runMs - signalTimingByRun.totalMs);
                timings.preparedData += signalTimingByRun.preparedDataMs;
                timings.signalGeneration += signalTimingByRun.signalMs;
                timings.backtest += Math.max(0, runMs - signalTimingByRun.totalMs);
                if (zeroSignals && !signalTimingByRun.observed) {
                    recordFinderStrategyNoSignals(strategyStats);
                }
                const symbolEdgeRatio = requiresCompositeEdgeRatio
                    ? computeFinderCompositeEdgeRatio(output.result, closedDataBySymbol.get(symbol.symbol) ?? symbol.data)
                    : undefined;
                const symbolResult = buildSymbolResult(symbol, output.result, {
                    compositeEdgeRatio: symbolEdgeRatio,
                    sharpeRatioAvailable: requiresSharpeRatio,
                    drawdownAvailable: false,
                });
                symbolResults.set(symbol.symbol, symbolResult);
                accumulatePartialCounts(partialCounts, symbolResult);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const runMs = performance.now() - runStartedAt;
                processedRuns += 1;
                failedRuns += 1;
                strategyStats.runs += 1;
                strategyStats.failedRuns += 1;
                strategyStats.totalMs += runMs;
                strategyStats.backtestMs += Math.max(0, runMs - signalTimingByRun.totalMs);
                timings.preparedData += signalTimingByRun.preparedDataMs;
                timings.signalGeneration += signalTimingByRun.signalMs;
                timings.backtest += Math.max(0, runMs - signalTimingByRun.totalMs);
                recordFinderStrategyFailure(strategyStats, error);
                symbolResults.set(symbol.symbol, buildRunFailedResult(symbol, message));
            }

            if (zeroSignals) {
                consecutiveZeroSignalSymbols += 1;
                if (consecutiveZeroSignalSymbols >= UNIVERSE_ZERO_SIGNAL_BAIL_THRESHOLD) {
                    const remainingSkipped = loadedSymbols.length - symbolIndex - 1;
                    skippedRuns += remainingSkipped;
                    recordFinderStrategySkipped(strategyStats, remainingSkipped);
                    break;
                }
            } else {
                consecutiveZeroSignalSymbols = 0;
            }

            remainingSymbols -= 1;
            remainingMaxTrades -= symbol.maxPossibleTrades;

            const earlyStopReason = resolveEarlyStopReason({
                counts: partialCounts,
                remainingSymbols,
                remainingMaxTrades,
                universe,
            });
            if (earlyStopReason) {
                evaluationStoppedEarly = true;
                stoppedReason = earlyStopReason;
                break;
            }

            await maybeYieldDuringEvaluation();
        }

        if (callbacks.isCancelled()) {
            break;
        }

        if (evaluationStoppedEarly) {
            await maybeYieldDuringEvaluation();
            continue;
        }

        if (!passesUniverseFiltersFromCounts(partialCounts, universe)) {
            await maybeYieldDuringEvaluation();
            continue;
        }

        const mergedSymbols: FinderUniverseSymbolResult[] = normalizedSymbols
            .map((symbol) => symbolResults.get(symbol) ?? loadFailures.get(symbol))
            .filter((entry): entry is FinderUniverseSymbolResult => Boolean(entry));

        const candidate = buildFinderUniverseCandidate({
            strategyKey: input.selectedStrategy.key,
            strategyName: input.selectedStrategy.name,
            params: entryParams,
            symbols: mergedSymbols,
            evaluationStoppedEarly,
            stoppedReason,
            exitStrategyKey: plan.exitStrategyKey,
            exitStrategyName: plan.exitStrategyName,
            exitStrategyParams: plan.exitStrategyParams,
        });

        if (passesFinderUniverseFilters(candidate, universe)) {
            const rankingStartedAt = performance.now();
            offerSurvivor(candidate);
            addElapsed(timings, "resultRanking", rankingStartedAt);
            // Throttle the (re-sort + render) callback to a time budget instead
            // of firing once per surviving candidate. The final
            // getSortedSurvivors(topN) at loop end is still the source of truth
            // for ranking, so a stale mid-run view is acceptable. The sort
            // itself only happens inside onResultsUpdate when it actually fires.
            if (callbacks.onResultsUpdate) {
                const now = performance.now();
                if (now - lastResultsUpdateAt >= UNIVERSE_RESULTS_UPDATE_MIN_MS) {
                    lastResultsUpdateAt = now;
                    const uiStartedAt = performance.now();
                    callbacks.onResultsUpdate(getSortedSurvivors(input.options.topN));
                    addElapsed(timings, "uiUpdates", uiStartedAt);
                }
            }
        }

        await maybeYieldDuringEvaluation();
    }

    // All candidate plans have finished consuming per-symbol OHLCV data.
    // Release the loaded datasets and the prepared closed-candle map so the
    // final ranking, diagnostics, and the caller's downstream work (Apply,
    // OOS pass, next strategy iteration) don't carry N full symbol arrays.
    // The survivor candidates in `results` only retain scalar metrics, so
    // nothing past this point reads `loadedSymbols[i].data` or the closed map.
    for (const sym of loadedSymbols) {
        sym.data = [] as OHLCVData[];
    }
    closedDataBySymbol.clear();

    const finalRankingStartedAt = performance.now();
    const results = getSortedSurvivors(input.options.topN);
    addElapsed(timings, "resultRanking", finalRankingStartedAt);
    const evaluationMs = performance.now() - evaluationStart;
    timings.total = performance.now() - totalRunStart;
    const diagnostics = buildFinderDiagnostics({
        runId,
        symbol: "SYMBOL_UNIVERSE",
        interval: input.interval,
        mode: input.options.mode,
        engineMode: "symbol_universe",
        inputBars: totalInputBars,
        evaluationBars: totalInputBars,
        selectedStrategies: 1,
        totalParamRuns: candidatePlans.length * normalizedSymbols.length,
        batchSize: 1,
        processedRuns,
        filteredRuns: keptCandidateCount,
        shownResults: results.length,
        endpointAdjusted: 0,
        failedRuns,
        skippedRuns,
        timings,
        strategyBreakdown: toFinderStrategyDiagnostics(strategyStatsByKey),
        failureBreakdown: toFinderFailureDiagnostics(strategyStatsByKey),
        universeDiagnostics: {
            totalSymbols: normalizedSymbols.length,
            loadedSymbols: loadedSymbols.length,
            failedSymbols: [...loadFailures.values()]
                .map((failure) => ({
                    symbol: failure.symbol,
                    reason: failure.error ?? "unknown load failure",
                }))
                .sort((a, b) => a.symbol.localeCompare(b.symbol)),
        },
    });
    const timingSummary: FinderUniverseTimingSummary = {
        totalRunMs: performance.now() - totalRunStart,
        loadMs,
        evaluationMs,
        symbolCount: normalizedSymbols.length,
        loadedSymbolCount: loadedSymbols.length,
        candidateCount: candidatePlans.length,
        keptCandidateCount,
    };
    debugLogger.event("finder.universe.timing", timingSummary);
    debugLogger.event("finder.diagnostics", buildCompactFinderDiagnostics(diagnostics));

    return {
        results,
        loadedSymbols: loadedSymbols.length,
        failedSymbols: [...loadFailures.keys()],
        diagnostics,
    };
}
