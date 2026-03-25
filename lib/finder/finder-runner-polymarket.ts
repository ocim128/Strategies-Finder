/**
 * Polymarket-mode Finder runner.
 *
 * Uses actual backtest trades and ranks parameter sets by Polymarket
 * outcome accuracy for those executed trades.
 */
import { applySignalPolarity, precomputeIndicators, runBacktest } from "../strategies/index";
import type { FinderResult } from "../types/finder";
import {
    getPolymarket5mSeriesIdForSymbol,
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarket5mRun,
    loadPolymarket5mOutcomesForChart,
} from "../polymarket-btc5m";
import {
    createPolymarketTradeEvaluationContext,
    evaluatePolymarketBacktestTrades,
} from "../polymarket-trade-annotations";
import { FinderResultRanker } from "./finder-result-ranker";
import {
    buildFinderEvaluationData,
    buildFinderResult,
    runStrategyBacktest,
    type StrategyPlan,
} from "./finder-runner-shared";
import {
    buildFinderSearchBaseParams,
    getPreparedFinderData,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import type { FinderRunInput, FinderRunCallbacks, FinderRunOutput } from "./finder-runner";

export async function runPolymarketFinder(
    input: FinderRunInput,
    callbacks: FinderRunCallbacks
): Promise<FinderRunOutput> {
    const { options, settings, selectedStrategies } = input;

    if (input.interval !== "5m") {
        callbacks.setStatus("Polymarket scoring requires 5m interval.");
        return { results: [] };
    }

    if (!isSupportedPolymarket5mRun(input.symbol, input.interval)) {
        callbacks.setStatus(`Polymarket scoring currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 5m.`);
        return { results: [] };
    }

    if (options.multiTimeframeEnabled) {
        callbacks.setStatus("Multi-timeframe is not supported in Polymarket mode.");
        return { results: [] };
    }

    if (options.comboEnabled) {
        callbacks.setStatus("Combo mode is not supported in Polymarket mode.");
        return { results: [] };
    }

    if (options.mode !== "grid" && options.mode !== "random") {
        callbacks.setStatus(`"${options.mode}" mode is not supported in Polymarket mode. Use grid or random.`);
        return { results: [] };
    }

    callbacks.setProgress(5, "Loading Polymarket outcome data...");
    callbacks.setStatus("Loading Polymarket outcomes from SQLite...");

    const closedData = buildFinderEvaluationData(input.ohlcvData, input.interval, settings);
    if (closedData.length < 2) {
        callbacks.setStatus("Not enough chart data for Polymarket evaluation.");
        return { results: [] };
    }

    const seriesId = getPolymarket5mSeriesIdForSymbol(input.symbol);
    if (!seriesId) {
        callbacks.setStatus(`Polymarket scoring currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 5m.`);
        return { results: [] };
    }

    let outcomes: Awaited<ReturnType<typeof loadPolymarket5mOutcomesForChart>>;
    try {
        outcomes = await loadPolymarket5mOutcomesForChart(input.symbol, closedData);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        callbacks.setStatus(`Failed to load Polymarket outcomes from SQLite. ${detail}`);
        return { results: [] };
    }

    if (outcomes.length === 0) {
        callbacks.setStatus(`No Polymarket outcome rows available for series ${seriesId}. Run poly:sync-outcomes first.`);
        return { results: [] };
    }

    callbacks.setStatus(`Loaded ${outcomes.length} outcome rows. Preparing strategies...`);
    callbacks.setProgress(10, "Preparing parameter sets...");

    const strategyPlans: StrategyPlan[] = [];
    let totalRuns = 0;
    for (const selection of selectedStrategies) {
        const extendedDefaults = buildFinderSearchBaseParams(selection.strategy, settings, options);
        const paramSets = input.generateParamSets(extendedDefaults, options);
        if (paramSets.length === 0) continue;
        totalRuns += paramSets.length;
        strategyPlans.push({
            key: selection.key,
            name: selection.name,
            strategy: selection.strategy,
            paramSets,
        });
    }

    if (totalRuns === 0) {
        callbacks.setStatus("No valid parameter combinations generated.");
        return { results: [] };
    }

    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const precomputed = precomputeIndicators(closedData, settings);
    const polymarketContext = createPolymarketTradeEvaluationContext(closedData, outcomes);
    const ranker = new FinderResultRanker(Math.max(options.topN, 50), options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let lastUiUpdateAt = 0;

    for (const plan of strategyPlans) {
        for (const params of plan.paramSets) {
            const normalizedParams = plan.strategy.normalizeParams ? plan.strategy.normalizeParams(params) : { ...params };
            const rawSignals = plan.strategy.executePrepared
                ? plan.strategy.executePrepared(
                    getPreparedFinderData(preparedDataCache, plan.key, plan.strategy, closedData, settings),
                    normalizedParams,
                    closedData
                )
                : plan.strategy.execute(closedData, normalizedParams);
            const signals = applySignalPolarity(rawSignals, settings);
            const backtestResult = runStrategyBacktest({
                strategy: plan.strategy,
                data: closedData,
                signals,
                params: normalizedParams,
                capitalSettings: input.capitalSettings,
                backtestSettings: settings,
                backtestFn: runBacktest,
                precomputed,
            });
            signals.length = 0;

            processedCount++;

            if (options.tradeFilterEnabled) {
                if (backtestResult.totalTrades < options.minTrades) {
                    const now = performance.now();
                    if (now - lastUiUpdateAt > 250 || processedCount === totalRuns) {
                        lastUiUpdateAt = now;
                        const progress = 10 + (processedCount / totalRuns) * 85;
                        callbacks.setProgress(progress, `${processedCount}/${totalRuns} evaluations`);
                        callbacks.setStatus(`Evaluating ${processedCount}/${totalRuns} candidates (${filteredCount} matched)...`);
                    }
                    if (processedCount % 64 === 0 || processedCount === totalRuns) {
                        await callbacks.yieldControl();
                    }
                    continue;
                }
                if (backtestResult.totalTrades > options.maxTrades) {
                    const now = performance.now();
                    if (now - lastUiUpdateAt > 250 || processedCount === totalRuns) {
                        lastUiUpdateAt = now;
                        const progress = 10 + (processedCount / totalRuns) * 85;
                        callbacks.setProgress(progress, `${processedCount}/${totalRuns} evaluations`);
                        callbacks.setStatus(`Evaluating ${processedCount}/${totalRuns} candidates (${filteredCount} matched)...`);
                    }
                    if (processedCount % 64 === 0 || processedCount === totalRuns) {
                        await callbacks.yieldControl();
                    }
                    continue;
                }
            }

            const evalResult = evaluatePolymarketBacktestTrades({
                chartData: closedData,
                trades: backtestResult.trades,
                outcomes,
                strategyKey: plan.key,
                context: polymarketContext,
                includeRows: false,
            });
            if (evalResult.scoredPredictions < (options.polymarketMinScoredPredictions ?? 0)) {
                const now = performance.now();
                if (now - lastUiUpdateAt > 250 || processedCount === totalRuns) {
                    lastUiUpdateAt = now;
                    const progress = 10 + (processedCount / totalRuns) * 85;
                    callbacks.setProgress(progress, `${processedCount}/${totalRuns} evaluations`);
                    callbacks.setStatus(`Evaluating ${processedCount}/${totalRuns} candidates (${filteredCount} matched)...`);
                }

                if (processedCount % 64 === 0 || processedCount === totalRuns) {
                    await callbacks.yieldControl();
                }
                continue;
            }
            const finderResult: FinderResult = buildFinderResult({
                key: plan.key,
                name: plan.name,
                params,
                result: backtestResult,
                selectionResult: backtestResult,
                endpointAdjusted: false,
                endpointRemovedTrades: 0,
            });
            finderResult.polymarketEval = evalResult;

            filteredCount++;
            ranker.offer(finderResult);

            const now = performance.now();
            if (now - lastUiUpdateAt > 250 || processedCount === totalRuns) {
                lastUiUpdateAt = now;
                const progress = 10 + (processedCount / totalRuns) * 85;
                callbacks.setProgress(progress, `${processedCount}/${totalRuns} evaluations`);
                callbacks.setStatus(`Evaluating ${processedCount}/${totalRuns} candidates (${filteredCount} matched)...`);
            }

            if (processedCount % 64 === 0 || processedCount === totalRuns) {
                await callbacks.yieldControl();
            }
        }
    }

    const results = ranker.toSortedArray(options.topN);
    callbacks.setProgress(100, `${totalRuns}/${totalRuns} evaluations`);
    const statusParts = [`${processedCount} evaluations`];
    if (options.tradeFilterEnabled) {
        statusParts.push(`${filteredCount} matched`);
    }
    statusParts.push(`${results.length} shown`);
    statusParts.push(`${outcomes.length} outcome rows`);
    callbacks.setStatus(`Complete. ${statusParts.join(", ")}.`);

    return { results };
}
