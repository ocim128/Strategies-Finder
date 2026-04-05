/**
 * Polymarket-mode Finder runner.
 *
 * Uses actual backtest trades and ranks parameter sets by Polymarket
 * outcome accuracy for those executed trades.
 *
 * Supports:
 * - 5m chart runs: exact timestamp matching (legacy behavior)
 * - 1m chart runs: 1m -> 5m bridge with minute entry offset (0..4) scoring
 * - 15m chart runs: groups 3x 5m events, entry offset (0..2)
 * - 1h chart runs: groups 12x 5m events, entry offset (0..11)
 * - 4h chart runs: groups 48x 5m events, entry offset (0..47)
 */
import { applySignalPolarity, precomputeIndicators, runBacktest } from "../strategies/index";
import { debugLogger } from "../debug-logger";
import type { FinderResult } from "../types/finder";
import {
    getPolymarket5mSeriesIdForSymbol,
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarketMultiIntervalRun,
    loadPolymarket5mOutcomesForChart,
} from "../polymarket-btc5m";
import {
    createPolymarketBridgeEvaluationContext,
    createPolymarketTradeEvaluationContext,
    evaluatePolymarketBacktestTrades,
    evaluateMappedPolymarketBacktestTrades1mBridge,
    filterTradesByPreviousClosedTradeExitReason,
    getTradeMarketEntryPrice,
} from "../polymarket-trade-annotations";
import { mapTradesToEvents as mapTradesToLegacyEvents, type MappedPolymarketTrade as LegacyMappedPolymarketTrade } from "../polymarket-1m-5m-bridge";
import {
    mapTradesToSuperEvents,
    getIntervalConfig,
    type MappedPolymarketTrade,
    type PolymarketInterval,
} from "../polymarket-interval-bridge";
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

/**
 * Evaluate mapped trades for multi-interval Polymarket runs (15m, 1h, 4h).
 * Uses the same evaluation logic as 1m bridge but with different offset semantics.
 */
function evaluateMultiIntervalPolymarketTrades(options: {
    mappedTrades: readonly MappedPolymarketTrade[];
    strategyKey: string;
    selectedOffset: number;
    includeRows: boolean;
    predictionsTaken: number;
    context: ReturnType<typeof createPolymarketBridgeEvaluationContext>;
}): import("../types/polymarket-outcomes").PolymarketEvalResult {
    const {
        mappedTrades,
        strategyKey,
        selectedOffset,
        includeRows,
        predictionsTaken,
        context,
    } = options;

    // Filter trades by selected offset
    const offsetTrades = mappedTrades.filter((mt) => mt.entryOffset === selectedOffset);
    const longOffsetTrades = offsetTrades.filter((mt) => mt.trade.type === "long");
    const shortOffsetTrades = offsetTrades.filter((mt) => mt.trade.type === "short");
    const longWins = longOffsetTrades.filter((mt) => mt.baseOutcome.resolved_outcome_up === 1).length;
    const shortWins = shortOffsetTrades.filter((mt) => mt.baseOutcome.resolved_outcome_up === 0).length;

    // Build evaluation rows
    const rows: import("../types/polymarket-outcomes").PolymarketEvalRow[] = [];
    let wins = 0;
    let losses = 0;
    const seenEvents = new Set<number>();
    let pricedPredictions = 0;
    let totalEntryPrice = 0;
    let totalPayout = 0;

    for (const mt of offsetTrades) {
        const eventKey = mt.superEventStartTs;
        if (seenEvents.has(eventKey)) {
            continue; // Skip duplicates
        }
        seenEvents.add(eventKey);

        // Find the signal bar index from the cached timestamp map
        const executionBarIndex = context.executionBarIndexByTs.get(mt.entryTs);
        const signalBarIndex = executionBarIndex === undefined ? -1 : Math.max(0, executionBarIndex - 1);

        // Determine prediction direction based on trade type
        const prediction: 'yes' | 'no' = mt.trade.type === 'long' ? 'yes' : 'no';
        const actualOutcomeUp: 0 | 1 = mt.baseOutcome.resolved_outcome_up;
        const isWin = (prediction === 'yes' && actualOutcomeUp === 1) ||
                      (prediction === 'no' && actualOutcomeUp === 0);
        const marketEntryPrice = getTradeMarketEntryPrice(mt.baseOutcome, prediction);

        if (isWin) wins++;
        else losses++;
        if (marketEntryPrice !== null) {
            pricedPredictions++;
            totalEntryPrice += marketEntryPrice;
            totalPayout += isWin ? (1 - marketEntryPrice) : -marketEntryPrice;
        }

        if (includeRows) {
            rows.push({
                eventStartTs: mt.superEventStartTs,
                eventEndTs: mt.superEventEndTs,
                eventSlug: mt.baseOutcome.event_slug,
                signalBarIndex,
                signalTime: mt.entryTs,
                prediction,
                actualOutcomeUp,
                isWin,
                signalReason: undefined,
                strategyKey,
                entryOffset: mt.entryOffset,
            });
        }
    }

    const scoredPredictions = wins + losses;
    const skips = Math.max(0, predictionsTaken - scoredPredictions);
    const avgEntryPrice = pricedPredictions > 0 ? totalEntryPrice / pricedPredictions : 0;
    const breakEvenWinRate = avgEntryPrice;
    const expectancy = pricedPredictions > 0 ? totalPayout / pricedPredictions : 0;
    const evaluatedEvents = context.evaluatedEvents;
    const resolvedUpCount = context.resolvedUpCount;

    return {
        evaluatedEvents,
        predictionsTaken,
        scoredPredictions,
        pricedPredictions,
        wins,
        losses,
        skips,
        winRate: scoredPredictions > 0 ? wins / scoredPredictions : 0,
        coverage: evaluatedEvents > 0 ? scoredPredictions / evaluatedEvents : 0,
        longPredictions: longOffsetTrades.length,
        shortPredictions: shortOffsetTrades.length,
        longWins,
        shortWins,
        longWinRate: longOffsetTrades.length > 0 ? longWins / longOffsetTrades.length : 0,
        shortWinRate: shortOffsetTrades.length > 0 ? shortWins / shortOffsetTrades.length : 0,
        alwaysYesBaselineWinRate: evaluatedEvents > 0 ? resolvedUpCount / evaluatedEvents : 0,
        alwaysNoBaselineWinRate: evaluatedEvents > 0 ? (evaluatedEvents - resolvedUpCount) / evaluatedEvents : 0,
        avgEntryPrice,
        breakEvenWinRate,
        expectancy,
        edgeVsBreakEven: (scoredPredictions > 0 ? wins / scoredPredictions : 0) - breakEvenWinRate,
        missingOutcomeRows: 0,
        ignoredSignals: 0,
        entryOffset: selectedOffset,
        rows,
    };
}

export async function runPolymarketFinder(
    input: FinderRunInput,
    callbacks: FinderRunCallbacks
): Promise<FinderRunOutput> {
    const { options, settings, selectedStrategies } = input;
    const interval = input.interval as PolymarketInterval;
    const intervalConfig = getIntervalConfig(interval);

    // Validate interval
    if (!intervalConfig) {
        callbacks.setStatus("Polymarket scoring requires 1m, 5m, 15m, 1h, or 4h interval.");
        return { results: [] };
    }

    // Validate symbol support
    if (!isSupportedPolymarketMultiIntervalRun(input.symbol, interval)) {
        callbacks.setStatus(`Polymarket scoring currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 1m, 5m, 15m, 1h, 4h.`);
        return { results: [] };
    }

    const is5mRun = interval === "5m";
    const isMultiSubEventRun = !is5mRun;

    // Determine offsets to evaluate
    const lockedOffset = (
        isMultiSubEventRun
        && options.mode === "random"
        && options.polymarketLockOffset
    )
        ? Math.max(
              intervalConfig.minOffset,
              Math.min(intervalConfig.maxOffset, Math.round(Number(settings.polymarketEntryOffset ?? 0)))
          )
        : null;

    const bridgeOffsetsToEvaluate = isMultiSubEventRun
        ? (lockedOffset === null
              ? Array.from({ length: intervalConfig.maxOffset - intervalConfig.minOffset + 1 }, (_, i) => i + intervalConfig.minOffset)
              : [lockedOffset])
        : [];

    const evaluationCountPerParamSet = isMultiSubEventRun ? bridgeOffsetsToEvaluate.length : 1;

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

    callbacks.setStatus(`Loaded ${outcomes.length} outcome rows. Preparing parameter sets...`);
    callbacks.setProgress(10, "Preparing parameter sets...");
    await callbacks.yieldControl();

    // Build strategy plans from selections
    const baseStrategyPlans: StrategyPlan[] = [];
    for (const selection of selectedStrategies) {
        const extendedDefaults = buildFinderSearchBaseParams(selection.strategy, settings, options);
        const paramSets = input.generateParamSets(extendedDefaults, options);
        if (paramSets.length === 0) continue;
        baseStrategyPlans.push({
            key: selection.key,
            name: selection.name,
            strategy: selection.strategy,
            paramSets,
        });
    }

    const totalRuns = baseStrategyPlans.reduce((sum, plan) => (
        sum + plan.paramSets.length * evaluationCountPerParamSet
    ), 0);

    if (totalRuns === 0) {
        callbacks.setStatus("No valid parameter combinations generated.");
        return { results: [] };
    }

    callbacks.setStatus(`Loaded ${outcomes.length} outcome rows. Precomputing indicators...`);
    callbacks.setProgress(12, "Precomputing indicators...");
    await callbacks.yieldControl();

    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const precomputed = precomputeIndicators(closedData, settings);
    const polymarketContext = createPolymarketTradeEvaluationContext(closedData, outcomes);
    const polymarketBridgeContext = isMultiSubEventRun
        ? createPolymarketBridgeEvaluationContext(closedData, outcomes)
        : undefined;
    const ranker = new FinderResultRanker(Math.max(options.topN, 50), options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let failedCount = 0;
    let lastUiUpdateAt = 0;

    callbacks.setStatus(`Running ${totalRuns} Polymarket evaluations...`);
    callbacks.setProgress(14, `${processedCount}/${totalRuns} evaluations`);
    await callbacks.yieldControl();

    for (const plan of baseStrategyPlans) {
        for (const params of plan.paramSets) {
            try {
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
                const tradesForPolymarketEvaluation = options.polymarketAfterTakeProfitOnly
                    ? filterTradesByPreviousClosedTradeExitReason(backtestResult.trades, "take_profit")
                    : backtestResult.trades;
                const legacyMappedTrades: readonly LegacyMappedPolymarketTrade[] | undefined = isMultiSubEventRun && interval === "1m"
                    ? mapTradesToLegacyEvents(tradesForPolymarketEvaluation, outcomes)
                    : undefined;
                const superMappedTrades: readonly MappedPolymarketTrade[] | undefined = isMultiSubEventRun && interval !== "1m"
                    ? mapTradesToSuperEvents(tradesForPolymarketEvaluation, outcomes, interval)
                    : undefined;

                // Evaluate trades based on interval type
                const evaluations = isMultiSubEventRun
                    ? bridgeOffsetsToEvaluate.map((offset) => ({
                        offset,
                        evalResult: interval === "1m"
                            ? evaluateMappedPolymarketBacktestTrades1mBridge({
                                chartData: closedData,
                                mappedTrades: legacyMappedTrades ?? [],
                                outcomes,
                                strategyKey: plan.key,
                                selectedOffset: offset,
                                includeRows: false,
                                predictionsTaken: tradesForPolymarketEvaluation.length,
                                context: polymarketBridgeContext,
                            })
                            : evaluateMultiIntervalPolymarketTrades({
                                mappedTrades: superMappedTrades ?? [],
                                strategyKey: plan.key,
                                selectedOffset: offset,
                                includeRows: false,
                                predictionsTaken: tradesForPolymarketEvaluation.length,
                                context: polymarketBridgeContext!,
                            }),
                    }))
                    : [{
                        offset: undefined,
                        evalResult: evaluatePolymarketBacktestTrades({
                            chartData: closedData,
                            trades: tradesForPolymarketEvaluation,
                            outcomes,
                            strategyKey: plan.key,
                            context: polymarketContext,
                            includeRows: false,
                        }),
                    }];

                for (const evaluation of evaluations) {
                    processedCount++;
                    const { offset, evalResult } = evaluation;
                    if (evalResult.scoredPredictions < (options.polymarketMinScoredPredictions ?? 0)) {
                        const now = performance.now();
                        if (now - lastUiUpdateAt > 250 || processedCount === totalRuns) {
                            lastUiUpdateAt = now;
                            const progress = 10 + (processedCount / totalRuns) * 85;
                            callbacks.setProgress(progress, `${processedCount}/${totalRuns} evaluations`);
                            callbacks.setStatus(`Evaluating ${processedCount}/${totalRuns} candidates (${filteredCount} matched)...`);
                        }

                        if (processedCount % 1024 === 0 || processedCount === totalRuns) {
                            await callbacks.yieldControl();
                        }
                        continue;
                    }

                    const finderResult: FinderResult = buildFinderResult({
                        key: plan.key,
                        name: plan.name,
                        params: offset !== undefined ? { ...params, polymarketEntryOffset: offset } : params,
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

                    if (processedCount % 1024 === 0 || processedCount === totalRuns) {
                        await callbacks.yieldControl();
                    }
                }
            } catch (error) {
                failedCount += evaluationCountPerParamSet;
                processedCount += evaluationCountPerParamSet;
                const detail = error instanceof Error ? error.message : String(error);
                debugLogger.warn("[Finder][polymarket] Candidate evaluation failed", {
                    strategyKey: plan.key,
                    params,
                    error: detail,
                });
            }

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
    if (failedCount > 0) {
        statusParts.push(`${failedCount} failed`);
    }
    statusParts.push(`${results.length} shown`);
    statusParts.push(`${outcomes.length} outcome rows`);
    callbacks.setStatus(`Complete. ${statusParts.join(", ")}.`);

    return { results };
}
