import { trimToClosedCandles } from "../closed-candle-utils";
import { debugLogger } from "../debug-logger";
import { FinderResultRanker } from "./finder-result-ranker";
import { runGeneticOptimization } from "./genetic-optimizer";
import {
    buildSelection,
    deriveStrategySeed,
    normalizeResultSharpe,
} from "./finder-runner-shared";
import { computeFinderCompositeEdgeRatio, finderSortRequiresCompositeEdgeRatio } from "./finder-runner-core";
import type { CapitalSettings } from "../types/backtest";
import type { FinderResult } from "../types/finder";
import type { FinderRunCallbacks, FinderRunInput, FinderRunOutput } from "./finder-runner";

export interface GeneticFinderRunParams {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    capitalSettings: CapitalSettings;
}

export async function runGeneticFinder(params: GeneticFinderRunParams): Promise<FinderRunOutput> {
    const { input, callbacks, capitalSettings } = params;
    const { initialCapital } = capitalSettings;

    if (input.options.multiTimeframeEnabled) {
        callbacks.setStatus("Genetic search is currently single-timeframe only.");
        return { results: [] };
    }

    if (input.comboPrimarySignals) {
        callbacks.setStatus("Genetic search is currently unavailable in combo mode.");
        return { results: [] };
    }

    const closedData = trimToClosedCandles(input.ohlcvData, input.interval);
    if (closedData.length === 0) {
        callbacks.setStatus("No closed candles available for genetic finder run.");
        return { results: [] };
    }

    const lastDataTime = closedData[closedData.length - 1]?.time ?? null;
    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    let filteredCount = 0;
    let endpointAdjustedCount = 0;

    const populationSize = Math.max(16, Math.min(48, Math.round(Math.sqrt(Math.max(1, input.options.maxRuns)) * 4)));
    const generations = Math.max(2, Math.floor(Math.max(1, input.options.maxRuns) / populationSize));

    for (let index = 0; index < input.selectedStrategies.length; index++) {
        const selection = input.selectedStrategies[index];
        const progressBase = (index / Math.max(1, input.selectedStrategies.length)) * 90;
        callbacks.setProgress(progressBase, `Genetic ${selection.name}: preparing...`);

        let optimization;
        try {
            optimization = await runGeneticOptimization({
                strategyKey: selection.key,
                strategy: selection.strategy,
                data: closedData,
                backtestSettings: input.settings,
                config: {
                    populationSize,
                    generations,
                    eliteCount: Math.max(1, Math.floor(populationSize * 0.15)),
                    mutationRate: 0.2,
                    mutationSigma: 0.18,
                    rangePercent: input.options.rangePercent,
                    seed: deriveStrategySeed(input.options.robustSeed ?? 1337, selection.key),
                    tournamentSize: 4,
                    adaptiveMutation: {
                        enabled: true,
                        stagnationGenerations: 2,
                        increaseFactor: 1.3,
                        decayFactor: 0.92,
                        minRate: 0.08,
                        maxRate: 0.45,
                    },
                    backtest: {
                        ...capitalSettings,
                        minTrades: input.options.tradeFilterEnabled ? input.options.minTrades : 0,
                    },
                },
                onGeneration: (stats) => {
                    const perStrategyProgress = ((stats.generation + 1) / Math.max(1, generations)) * (90 / Math.max(1, input.selectedStrategies.length));
                    callbacks.setProgress(
                        Math.min(95, progressBase + perStrategyProgress),
                        `Genetic ${selection.name}: gen ${stats.generation + 1}/${generations}`
                    );
                    callbacks.setStatus(
                        `Genetic ${selection.name}: best ${stats.bestNetProfitPercent.toFixed(2)}%, Sharpe ${stats.bestSharpeRatio.toFixed(2)}, DD ${stats.bestDrawdownPercent.toFixed(2)}%`
                    );
                },
            });
        } catch (error) {
            debugLogger.warn(`[Finder] Genetic optimization skipped for ${selection.key}`, error);
            continue;
        }

        const normalizedResult = normalizeResultSharpe(optimization.bestGenome.result, initialCapital);
        const adjustment = buildSelection(normalizedResult, lastDataTime, initialCapital);
        const candidate: FinderResult = {
            key: selection.key,
            name: selection.name,
            params: optimization.bestGenome.params,
            result: normalizedResult,
            selectionResult: adjustment.result,
            compositeEdgeRatio: finderSortRequiresCompositeEdgeRatio(input.options.sortPriority)
                ? computeFinderCompositeEdgeRatio(normalizedResult, closedData)
                : undefined,
            endpointAdjusted: adjustment.adjusted,
            endpointRemovedTrades: adjustment.removedTrades,
        };

        if (input.options.tradeFilterEnabled) {
            if (candidate.result.totalTrades < input.options.minTrades || candidate.result.totalTrades > input.options.maxTrades) {
                continue;
            }
        }

        filteredCount++;
        if (candidate.endpointAdjusted) {
            endpointAdjustedCount++;
        }
        ranker.offer(candidate);
        await callbacks.yieldControl();
    }

    const results = ranker.toSortedArray(input.options.topN);
    callbacks.setProgress(100, "Genetic search complete");
    callbacks.setStatus(`Complete. ${input.selectedStrategies.length} strategies searched, ${filteredCount} matched, ${endpointAdjustedCount} endpoint-adjusted, ${results.length} shown.`);
    return { results };
}
