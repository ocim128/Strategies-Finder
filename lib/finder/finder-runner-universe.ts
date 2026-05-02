import { executeBacktest } from "../backtest-executor";
import { debugLogger } from "../debug-logger";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import type { CapitalSettings } from "../types/backtest";
import type {
    FinderOptions,
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
    Time,
} from "../types/strategies";
import {
    buildFinderSearchBaseParams,
    getPreparedFinderData,
    normalizeFinderCandidateParamSets,
    resolveFinderRiskOverrides,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import { buildFinderUniverseCandidate, passesFinderUniverseFilters, sortFinderUniverseCandidates } from "./finder-universe-metrics";
import type { FinderSelectedStrategy } from "./finder-runner";

interface FinderUniverseLoadedSymbol {
    symbol: string;
    data: OHLCVData[];
    barCount: number;
    firstTime?: Time;
    lastTime?: Time;
    maxPossibleTrades: number;
}

export interface FinderUniverseRunInput {
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategy: FinderSelectedStrategy;
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    generateParamSets: (defaultParams: Record<string, number>, options: FinderOptions) => Record<string, number>[];
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

function createPreparedStrategy(
    strategyKey: string,
    strategy: Strategy,
    cache: FinderPreparedDataCache,
    settings: BacktestSettings
): Strategy {
    if (!strategy.prepareFinderData || !strategy.executePrepared) {
        return strategy;
    }

    const wrapped = Object.create(Object.getPrototypeOf(strategy)) as Strategy;
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(strategy));
    wrapped.execute = (data, params, executionContext) => {
        const prepared = getPreparedFinderData(
            cache,
            strategyKey,
            strategy,
            data,
            settings,
            executionContext
        );
        return strategy.executePrepared!(prepared, params, data, executionContext);
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
        error,
    };
}

function buildUniverseSymbolMetrics(result: BacktestResult): NonNullable<FinderUniverseSymbolResult["result"]> {
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
    };
}

function buildSymbolResult(symbol: FinderUniverseLoadedSymbol, result: Awaited<ReturnType<typeof executeBacktest>>["result"]): FinderUniverseSymbolResult {
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
        result: buildUniverseSymbolMetrics(result),
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
    if (input.options.comboEnabled) {
        throw new Error("Symbol Universe mode does not support combo mode in v1.");
    }
    if (input.options.multiTimeframeEnabled) {
        throw new Error("Symbol Universe mode does not support multi-timeframe runs in v1.");
    }
    if (input.settings.strategyTimeframeEnabled) {
        throw new Error("Symbol Universe mode does not support strategy timeframe resampling in v1.");
    }
    if (input.selectedStrategy.strategy.crossSymbolConfig) {
        throw new Error(`Strategy "${input.selectedStrategy.name}" is cross-symbol and is not supported in Symbol Universe mode.`);
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
    const loadStart = performance.now();
    const loadedSymbols: FinderUniverseLoadedSymbol[] = [];
    const loadFailures = new Map<string, FinderUniverseSymbolResult>();
    const loadCache = new Map<string, Promise<OHLCVData[]>>();
    const datasetAbort = new AbortController();

    const getOrLoadDataset = (symbol: string): Promise<OHLCVData[]> => {
        const key = `${symbol}|${input.interval}`;
        const cached = loadCache.get(key);
        if (cached) {
            return cached;
        }
        const promise = input.loadDataset(symbol, input.interval, datasetAbort.signal);
        loadCache.set(key, promise);
        return promise;
    };

    callbacks.setProgress(0, "Preparing symbol universe...");
    callbacks.setStatus("Loading universe symbols...");

    for (let index = 0; index < normalizedSymbols.length; index += 1) {
        if (callbacks.isCancelled()) {
            datasetAbort.abort();
            break;
        }

        const symbol = normalizedSymbols[index];
        callbacks.setProgress((index / Math.max(1, normalizedSymbols.length)) * 15, `Loading ${symbol} (${index + 1}/${normalizedSymbols.length})...`);
        callbacks.setStatus(`Loading ${symbol} ${input.interval}...`);

        try {
            const data = await getOrLoadDataset(symbol);
            if (!Array.isArray(data) || data.length === 0) {
                loadFailures.set(symbol, buildLoadFailedResult(symbol, "No candles returned."));
                continue;
            }

            loadedSymbols.push({
                symbol,
                data,
                barCount: data.length,
                firstTime: data[0]?.time,
                lastTime: data[data.length - 1]?.time,
                maxPossibleTrades: data.length,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            loadFailures.set(symbol, buildLoadFailedResult(symbol, message));
        }

        await callbacks.yieldControl();
    }

    const loadMs = performance.now() - loadStart;
    if (callbacks.isCancelled()) {
        return {
            results: [],
            loadedSymbols: loadedSymbols.length,
            failedSymbols: [...loadFailures.keys()],
        };
    }

    if (loadedSymbols.length === 0) {
        throw new Error("No universe symbols could be loaded.");
    }

    const rustSettings = sanitizeBacktestSettingsForRust(input.settings);
    const baseParams = buildFinderSearchBaseParams(input.selectedStrategy.strategy, input.settings, input.options);
    const paramSets = normalizeFinderCandidateParamSets(
        input.selectedStrategy.strategy,
        input.generateParamSets(baseParams, input.options)
    );
    if (paramSets.length === 0) {
        callbacks.setStatus("No valid parameter combinations generated.");
        return {
            results: [],
            loadedSymbols: loadedSymbols.length,
            failedSymbols: [...loadFailures.keys()],
        };
    }

    const evaluationStart = performance.now();
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const maxStoredSurvivors = Math.max(input.options.topN, 50);
    const survivors: FinderUniverseCandidate[] = [];
    let keptCandidateCount = 0;
    const getSortedSurvivors = (limit: number): FinderUniverseCandidate[] =>
        sortFinderUniverseCandidates(survivors, universe.sortPriority)
            .slice(0, Math.max(1, limit));
    const offerSurvivor = (candidate: FinderUniverseCandidate): void => {
        survivors.push(candidate);
        keptCandidateCount += 1;
        if (survivors.length <= maxStoredSurvivors) {
            return;
        }
        const trimmed = getSortedSurvivors(maxStoredSurvivors);
        survivors.length = 0;
        survivors.push(...trimmed);
    };
    const totalPossibleTrades = loadedSymbols.reduce((sum, item) => sum + item.maxPossibleTrades, 0);

    for (let candidateIndex = 0; candidateIndex < paramSets.length; candidateIndex += 1) {
        if (callbacks.isCancelled()) {
            break;
        }

        const params = paramSets[candidateIndex];
        const { backtestSettings } = resolveFinderRiskOverrides(input.settings, rustSettings, params, input.options);
        const preparedStrategy = createPreparedStrategy(
            input.selectedStrategy.key,
            input.selectedStrategy.strategy,
            preparedDataCache,
            backtestSettings
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

        for (let symbolIndex = 0; symbolIndex < loadedSymbols.length; symbolIndex += 1) {
            if (callbacks.isCancelled()) {
                break;
            }

            const symbol = loadedSymbols[symbolIndex];
            const progressBase = candidateIndex / Math.max(1, paramSets.length);
            const progressWithin = symbolIndex / Math.max(1, loadedSymbols.length);
            const progress = 15 + ((progressBase + (progressWithin / Math.max(1, paramSets.length))) * 85);

            callbacks.setProgress(progress, `Testing ${input.selectedStrategy.name} on ${symbol.symbol} (${candidateIndex + 1}/${paramSets.length})...`);
            callbacks.setStatus(`Evaluating candidate ${candidateIndex + 1}/${paramSets.length} on ${symbol.symbol}...`);

            try {
                const output = await executeBacktest({
                    ohlcvData: symbol.data,
                    interval: input.interval,
                    primarySymbol: symbol.symbol,
                    strategyKey: input.selectedStrategy.key,
                    strategy: preparedStrategy,
                    strategyParams: params,
                    backtestSettings,
                    capitalSettings: input.capitalSettings,
                    context: {
                        blockRange: null,
                        annotatePolymarket: false,
                        engineMode: "auto",
                        nowSec: Math.floor(Date.now() / 1000),
                    },
                });
                const symbolResult = buildSymbolResult(symbol, output.result);
                symbolResults.set(symbol.symbol, symbolResult);
                accumulatePartialCounts(partialCounts, symbolResult);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                symbolResults.set(symbol.symbol, buildRunFailedResult(symbol, message));
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

            await callbacks.yieldControl();
        }

        if (callbacks.isCancelled()) {
            break;
        }

        if (evaluationStoppedEarly) {
            await callbacks.yieldControl();
            continue;
        }

        if (!passesUniverseFiltersFromCounts(partialCounts, universe)) {
            await callbacks.yieldControl();
            continue;
        }

        const mergedSymbols: FinderUniverseSymbolResult[] = normalizedSymbols
            .map((symbol) => symbolResults.get(symbol) ?? loadFailures.get(symbol))
            .filter((entry): entry is FinderUniverseSymbolResult => Boolean(entry));

        const candidate = buildFinderUniverseCandidate({
            strategyKey: input.selectedStrategy.key,
            strategyName: input.selectedStrategy.name,
            params,
            symbols: mergedSymbols,
            evaluationStoppedEarly,
            stoppedReason,
        });

        if (passesFinderUniverseFilters(candidate, universe)) {
            offerSurvivor(candidate);
            callbacks.onResultsUpdate?.(getSortedSurvivors(input.options.topN));
        }

        await callbacks.yieldControl();
    }

    const results = getSortedSurvivors(input.options.topN);
    const evaluationMs = performance.now() - evaluationStart;
    const timingSummary: FinderUniverseTimingSummary = {
        totalRunMs: performance.now() - totalRunStart,
        loadMs,
        evaluationMs,
        symbolCount: normalizedSymbols.length,
        loadedSymbolCount: loadedSymbols.length,
        candidateCount: paramSets.length,
        keptCandidateCount,
    };
    debugLogger.event("finder.universe.timing", timingSummary);

    return {
        results,
        loadedSymbols: loadedSymbols.length,
        failedSymbols: [...loadFailures.keys()],
    };
}
