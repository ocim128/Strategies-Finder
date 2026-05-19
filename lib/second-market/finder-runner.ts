import {
    applySignalPolarity,
    precomputeIndicators,
    runBacktest,
} from "../strategies/index";
import {
    applyConfirmationStrategiesToSignals,
    ensureConfirmationStrategiesLoaded,
} from "../confirmation-signal-filter";
import type { BacktestResult, OHLCVData, StrategyExecutionContext } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { FinderResult } from "../types/finder";
import type { FinderRunCallbacks, FinderRunInput, FinderRunOutput } from "../finder/finder-runner";
import {
    buildFinderEvaluationData,
    buildFinderResult,
    runStrategyBacktest,
    type StrategyPlan,
} from "../finder/finder-runner-shared";
import {
    buildFinderSearchBaseParams,
    getPreparedFinderData,
    normalizeFinderCandidateParamSets,
    resolveFinderRiskOverrides,
    type FinderPreparedDataCache,
} from "../finder/finder-runner-core";
import { FinderResultRanker } from "../finder/finder-result-ranker";
import { isCrossSymbolStrategy, resolveCrossSymbolExecution } from "../cross-symbol-runtime";
import { debugLogger } from "../debug-logger";
import { applyPolymarketAlternativeSizing } from "../polymarket-alternative-sizing";
import { resolveEffectivePolymarketExitMode } from "../polymarket-exit-mode";
import { filterTradesByPreviousClosedTradeExitReason } from "../polymarket-trade-annotations";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import {
    isSecondMarketPolymarketScoringSupported,
    evaluateSecondMarketBacktest,
    loadSecondMarketEvaluationContext,
} from "./evaluation";
import { resolvePolymarketOutcomeInterval } from "../polymarket-outcome-interval";

function isAlternativeSizingMode(capitalSettings: CapitalSettings): boolean {
    return capitalSettings.sizingMode !== "percent";
}

function getDataRange(data: readonly OHLCVData[]): { startTs: number; endTs: number } | null {
    if (data.length === 0) return null;
    const first = Number(data[0]?.time);
    const last = Number(data[data.length - 1]?.time);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
    return {
        startTs: Math.floor(first),
        endTs: Math.floor(last),
    };
}

function withSecondMarketStrategyContext(
    baseContext: StrategyExecutionContext | undefined,
    context: NonNullable<Awaited<ReturnType<typeof loadSecondMarketEvaluationContext>>>
): StrategyExecutionContext {
    return {
        ...(baseContext ?? {}),
        polymarket1s: {
            symbol: context.symbol,
            outcomeSymbol: context.outcomeSymbol,
            seriesId: context.seriesId,
            outcomeInterval: context.outcomeInterval,
            quotes: context.quotes,
            gammaSnapshots: context.gammaSnapshots,
        },
    };
}

function applySizedNetToEvalResult(args: {
    enabled: boolean;
    evalResult: NonNullable<FinderResult["polymarketEval"]>;
    baseResult: BacktestResult;
    annotatedTrades: readonly BacktestResult["trades"][number][];
    chartData: OHLCVData[];
    input: FinderRunInput;
    summary: BacktestResult["polymarketTradeSummary"];
}): NonNullable<FinderResult["polymarketEval"]> {
    if (!args.enabled || !args.summary) {
        return args.evalResult;
    }

    const sizedResult = applyPolymarketAlternativeSizing({
        result: {
            ...args.baseResult,
            trades: [...args.annotatedTrades],
            polymarketTradeSummary: args.summary,
        },
        chartData: args.chartData,
        backtestSettings: args.input.settings,
        capitalSettings: args.input.capitalSettings,
        alternativeSizingEnabled: true,
    });
    const sizedSummary = sizedResult.polymarketTradeSummary;
    if (!sizedSummary || typeof sizedSummary.sizedNetProfit !== "number") {
        return args.evalResult;
    }

    return {
        ...args.evalResult,
        sizedNetProfit: sizedSummary.sizedNetProfit,
        sizedNetProfitPercent: sizedSummary.sizedNetProfitPercent,
        sizedTrades: sizedSummary.sizedTrades,
        sizedSkippedTrades: sizedSummary.sizedSkippedTrades,
        sizedSizingMode: sizedSummary.sizedSizingMode,
    };
}

export async function runSecondMarketFinder(
    input: FinderRunInput,
    callbacks: FinderRunCallbacks
): Promise<FinderRunOutput> {
    const { options, settings, selectedStrategies } = input;
    await ensureConfirmationStrategiesLoaded(settings);
    const rustSettings = sanitizeBacktestSettingsForRust(settings);

    if (options.multiTimeframeEnabled) {
        callbacks.setStatus("1s CLOB Polymarket Finder does not support multi-timeframe mode.");
        return { results: [] };
    }

    if (options.comboEnabled) {
        callbacks.setStatus("1s CLOB Polymarket Finder does not support combo mode.");
        return { results: [] };
    }

    if (options.mode !== "grid" && options.mode !== "random") {
        callbacks.setStatus(`1s CLOB Polymarket Finder supports grid or random mode, not "${options.mode}".`);
        return { results: [] };
    }

    if (!isSecondMarketPolymarketScoringSupported({
        symbol: input.symbol,
        interval: input.interval,
        executionModel: settings.executionModel,
    })) {
        callbacks.setStatus("1s CLOB Polymarket scoring requires signal_close, next_open, or next_close execution model.");
        return { results: [] };
    }

    const requiresSizedNetRank = options.sortPriority.includes("polySizedNet");
    if (requiresSizedNetRank && !isAlternativeSizingMode(input.capitalSettings)) {
        callbacks.setStatus("Sized Net rank mode requires Alternative Sizing mode other than percent.");
        return { results: [] };
    }

    const effectiveExitMode = resolveEffectivePolymarketExitMode({
        requestedMode: options.polymarketExitMode,
        interval: input.interval,
        executionModel: settings.executionModel,
        polymarketAnnotationEnabled: options.polymarketScoringEnabled,
    });
    const outcomeInterval = resolvePolymarketOutcomeInterval(settings.polymarketOutcomeInterval);
    const limitEntry = settings.polymarketPostSignalLimitEntryEnabled === true
        ? {
            enabled: true,
            priceMode: settings.polymarketPostSignalLimitEntryMode,
            priceCents: settings.polymarketPostSignalLimitEntryPriceCents ?? 50,
            offsetCents: settings.polymarketPostSignalLimitEntryOffsetCents,
            exitEnabled: settings.polymarketPostSignalLimitExitEnabled === true,
            exitMode: settings.polymarketPostSignalLimitExitMode,
            exitPriceCents: settings.polymarketPostSignalLimitExitPriceCents,
            exitOffsetCents: settings.polymarketPostSignalLimitExitOffsetCents,
        }
        : undefined;

    callbacks.setProgress(5, "Preparing 1s chart data...");
    const closedData = buildFinderEvaluationData(input.ohlcvData, input.interval, settings);
    if (closedData.length < 2) {
        callbacks.setStatus("Not enough 1s chart data for CLOB Polymarket Finder.");
        return { results: [] };
    }

    const range = getDataRange(closedData);
    if (!range) {
        callbacks.setStatus("1s chart data has invalid timestamps.");
        return { results: [] };
    }

    callbacks.setProgress(8, "Loading 1s CLOB quotes...");
    callbacks.setStatus("Loading 1s CLOB quotes and outcomes from local SQLite...");
    let context: Awaited<ReturnType<typeof loadSecondMarketEvaluationContext>>;
    try {
        context = await loadSecondMarketEvaluationContext({
            symbol: input.symbol,
            outcomeSymbol: settings.polymarketOutcomeSymbol,
            outcomeInterval,
            startTs: range.startTs - 300,
            endTs: range.endTs + 300,
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        callbacks.setStatus(`Failed to load 1s CLOB context. ${detail}`);
        return { results: [] };
    }

    if (!context) {
        callbacks.setStatus("1s CLOB Polymarket Finder supports BTCUSDT and XRPUSDT only.");
        return { results: [] };
    }
    if (context.quotes.length === 0) {
        callbacks.setStatus("No 1s CLOB quote rows found. Keep run-1s-miner.bat running, then reload 1s data.");
        return { results: [] };
    }
    const quoteCoveragePct = context.quoteStats?.exactSampleCoveragePct;
    const quoteCoverageText = typeof quoteCoveragePct === "number" && Number.isFinite(quoteCoveragePct)
        ? `${quoteCoveragePct.toFixed(1)}% exact CLOB coverage`
        : null;
    if (quoteCoverageText && typeof quoteCoveragePct === "number" && quoteCoveragePct < 95) {
        callbacks.setStatus(`Warning: ${quoteCoverageText}; results may under-score missing quote seconds.`);
    }

    const strategyPlans: StrategyPlan[] = [];
    let totalRuns = 0;
    for (const selection of selectedStrategies) {
        const extendedDefaults = buildFinderSearchBaseParams(selection.strategy, settings, options);
        const paramSets = normalizeFinderCandidateParamSets(
            selection.strategy,
            input.generateParamSets(extendedDefaults, options)
        );
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

    callbacks.setProgress(12, "Precomputing indicators...");
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const basePrecomputed = precomputeIndicators(closedData, settings);
    const ranker = new FinderResultRanker(Math.max(options.topN, 50), options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let failedCount = 0;
    let lastUiUpdateAt = 0;
    let lastResultsUpdateAt = 0;

    callbacks.setStatus(`Running ${totalRuns} 1s CLOB evaluations${quoteCoverageText ? ` (${quoteCoverageText})` : ""}...`);
    callbacks.setProgress(14, `0/${totalRuns} evaluations`);
    await callbacks.yieldControl();

    for (const plan of strategyPlans) {
        let strategyData = closedData;
        let executionContext: StrategyExecutionContext | undefined;
        let precomputed = basePrecomputed;
        if (isCrossSymbolStrategy(plan.strategy)) {
            try {
                const { dataManager } = await import("../data-manager");
                const resolved = await resolveCrossSymbolExecution({
                    strategy: plan.strategy,
                    primarySymbol: input.symbol,
                    interval: input.interval,
                    primaryData: closedData,
                    settings,
                    dataFetcher: dataManager,
                });
                strategyData = resolved.primaryData;
                executionContext = resolved.context;
                precomputed = precomputeIndicators(strategyData, settings);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                debugLogger.warn("[Finder][second-market] Cross-symbol resolution failed", {
                    strategyKey: plan.key,
                    error: detail,
                });
                failedCount += plan.paramSets.length;
                processedCount += plan.paramSets.length;
                continue;
            }
        }
        executionContext = withSecondMarketStrategyContext(executionContext, context);

        for (const params of plan.paramSets) {
            if (callbacks.isCancelled()) {
                callbacks.setStatus("Finder stopped by user.");
                const results = ranker.toSortedArray(options.topN);
                callbacks.onResultsUpdate(results);
                return { results };
            }

            try {
                const normalizedParams = plan.strategy.normalizeParams ? plan.strategy.normalizeParams(params) : { ...params };
                const { backtestSettings } = resolveFinderRiskOverrides(settings, rustSettings, normalizedParams, options);
                const candidatePrecomputed = backtestSettings === settings
                    ? precomputed
                    : precomputeIndicators(strategyData, backtestSettings);
                const rawSignals = plan.strategy.executePrepared
                    ? plan.strategy.executePrepared(
                        getPreparedFinderData(preparedDataCache, plan.key, plan.strategy, strategyData, backtestSettings, executionContext),
                        normalizedParams,
                        strategyData,
                        executionContext
                    )
                    : plan.strategy.execute(strategyData, normalizedParams, executionContext);
                const signals = applyConfirmationStrategiesToSignals({
                    data: strategyData,
                    baseSignals: applySignalPolarity(rawSignals, backtestSettings),
                    settings: backtestSettings,
                });
                const backtestResult = runStrategyBacktest({
                    strategy: plan.strategy,
                    data: strategyData,
                    signals,
                    params: normalizedParams,
                    capitalSettings: input.capitalSettings,
                    backtestSettings,
                    backtestFn: runBacktest,
                    precomputed: candidatePrecomputed,
                });
                signals.length = 0;

                if (options.tradeFilterEnabled) {
                    if (backtestResult.totalTrades < options.minTrades || backtestResult.totalTrades > options.maxTrades) {
                        processedCount++;
                        continue;
                    }
                }

                const tradesForPolymarket = options.polymarketAfterTakeProfitOnly
                    ? filterTradesByPreviousClosedTradeExitReason(backtestResult.trades, "take_profit")
                    : backtestResult.trades;
                const secondMarket = evaluateSecondMarketBacktest({
                    result: backtestResult,
                    context,
                    trades: tradesForPolymarket,
                    executionModel: settings.executionModel,
                    polymarketExitMode: effectiveExitMode,
                    polymarketSignalExitAllowMultipleTradesPerEvent: options.polymarketSignalExitAllowMultipleTradesPerEvent,
                    entryDelayBars: options.polymarketEntryDelayBars ?? settings.polymarketEntryDelayBars,
                    entryPriceFilterCents: options.polymarketEntryPriceFilterCents ?? settings.polymarketEntryPriceFilterCents,
                    entryCutoffEnabled: settings.polymarketEntryCutoffEnabled,
                    entryCutoffSeconds: settings.polymarketEntryCutoffSeconds,
                    limitEntry,
                });

                processedCount++;
                if (secondMarket.polymarketEval.scoredPredictions < (options.polymarketMinScoredPredictions ?? 0)) {
                    continue;
                }

                const evalResult = applySizedNetToEvalResult({
                    enabled: requiresSizedNetRank,
                    evalResult: secondMarket.polymarketEval,
                    baseResult: backtestResult,
                    annotatedTrades: secondMarket.annotatedTrades,
                    chartData: strategyData,
                    input,
                    summary: secondMarket.polymarketSummary,
                });
                const finderResult = buildFinderResult({
                    key: plan.key,
                    name: plan.name,
                    params: normalizedParams,
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
                    const progress = 14 + (processedCount / totalRuns) * 83;
                    callbacks.setProgress(progress, `${processedCount}/${totalRuns} evaluations`);
                    callbacks.setStatus(`Evaluating ${processedCount}/${totalRuns} candidates (${filteredCount} matched)...`);
                }
                if (now - lastResultsUpdateAt > 750 || processedCount === totalRuns) {
                    lastResultsUpdateAt = now;
                    callbacks.onResultsUpdate(ranker.toSortedArray(options.topN));
                }
                if (processedCount % 128 === 0 || processedCount === totalRuns) {
                    await callbacks.yieldControl();
                }
            } catch (error) {
                failedCount++;
                processedCount++;
                const detail = error instanceof Error ? error.message : String(error);
                debugLogger.warn("[Finder][second-market] Candidate evaluation failed", {
                    strategyKey: plan.key,
                    params,
                    error: detail,
                });
            }
        }
    }

    const results = ranker.toSortedArray(options.topN);
    callbacks.setProgress(100, `${processedCount}/${totalRuns} evaluations`);
    const statusParts = [`${processedCount} evaluations`, `${filteredCount} matched`, `${results.length} shown`];
    if (failedCount > 0) statusParts.push(`${failedCount} failed`);
    statusParts.push(`${context.quotes.length} CLOB quote rows`);
    if (quoteCoverageText) statusParts.push(quoteCoverageText);
    callbacks.setStatus(`Complete. ${statusParts.join(", ")}.`);
    callbacks.onResultsUpdate(results);
    return { results };
}
