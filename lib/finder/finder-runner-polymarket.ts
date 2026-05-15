/**
 * Polymarket-mode Finder runner.
 *
 * Uses actual backtest trades and ranks parameter sets by Polymarket
 * outcome accuracy for those executed trades.
 *
 * Supports:
 * - native 5m / 15m / 1h outcome-session runs: direct session scoring
 * - 1m signal-exit runs: same-event Polymarket entry/exit pricing
 * - default 5m bridge runs: 1m -> 5m offset scoring
 * - default 5m multi-interval bridge runs: 15m / 1h / 4h group 5m events by offset
 */
import { applySignalPolarity, precomputeIndicators, runBacktest } from "../strategies/index";
import {
    applyConfirmationStrategiesToSignals,
    ensureConfirmationStrategiesLoaded,
} from "../confirmation-signal-filter";
import { debugLogger } from "../debug-logger";
import type { FinderResult } from "../types/finder";
import {
    getEffectivePolymarketSeriesId,
    getEffectivePolymarket5mSeriesId,
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarketOutcomeRun,
    isSupportedPolymarketMultiIntervalRun,
    loadPolymarketOutcomesForChart,
    loadPolymarket5mOutcomesForChart,
    resolvePolymarketOutcomeSymbol,
} from "../polymarket-btc5m";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    createPolymarketBridgeEvaluationContext,
    createPolymarketTradeEvaluationContext,
    evaluatePolymarketBacktestTrades,
    evaluateMappedPolymarketBacktestTrades1mBridge,
    filterTradesByPreviousClosedTradeExitReason,
    getTradeMarketEntryPrice,
    summarizePolymarketTradesForRun,
    type PolymarketTradeEvaluationContext,
} from "../polymarket-trade-annotations";
import {
    deduplicateByEvent as deduplicateLegacyMappedTradesByEvent,
    filterByEntryOffset as filterLegacyMappedTradesByEntryOffset,
    mapTradesToEvents as mapTradesToLegacyEvents,
    type MappedPolymarketTrade as LegacyMappedPolymarketTrade,
} from "../polymarket-1m-5m-bridge";
import {
    deduplicateBySuperEvent,
    filterByEntryOffset as filterSuperMappedTradesByEntryOffset,
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
    normalizeFinderCandidateParamSets,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import type { FinderRunInput, FinderRunCallbacks, FinderRunOutput } from "./finder-runner";
import type { BacktestResult, BacktestSettings, OHLCVData, StrategyExecutionContext, Trade } from "../types/strategies";
import { resolveCrossSymbolExecution, isCrossSymbolStrategy } from "../cross-symbol-runtime";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode, SIGNAL_EXIT_SUPPORTED_RANK_MODES } from "../polymarket-exit-mode";
import {
    buildTradeAnnotationFromSignalExitResult,
    evaluateSignalExitTrades,
    indexSignalExitOutcomesByEntryTs,
} from "../polymarket-signal-exit-evaluator";
import type { PolymarketPricePoint } from "../local-sqlite-polymarket-api";
import { ensurePricePointsForOutcomes } from "../polymarket-price-points-ingest";
import { indexPricePointsByEvent, type EventPriceIndex } from "../polymarket-price-points";
import {
    clampPolymarketPostSignalLimitEntryPriceCents,
    clampPolymarketPostSignalLimitExitPriceCents,
    clampPolymarketPostSignalLimitOffsetCents,
    resolvePolymarketPostSignalLimitEntryMode,
    resolvePolymarketPostSignalLimitExitMode,
    type PolymarketPostSignalLimitEntrySettings,
} from "../polymarket-post-signal-limit-entry";
import { parseTimeToUnixSeconds } from "../time-normalization";
import {
    DEFAULT_POLYMARKET_OUTCOME_INTERVAL,
    getPolymarketOutcomeIntervalDurationSec,
    resolvePolymarketOutcomeInterval,
} from "../polymarket-outcome-interval";
import { applyPolymarketAlternativeSizing } from "../polymarket-alternative-sizing";
import type { CapitalSettings } from "../types/backtest";
import type { BacktestPolymarketTradeSummary, PolymarketEvalResult, TradePolymarketOutcome } from "../types/polymarket-outcomes";
import { PolymarketEvalAccumulator } from "../polymarket-eval-accumulator";
import { clampPolymarketEntryPriceFilterCents, isPolymarketEntryPriceFiltered } from "../polymarket-entry-price-filter";

type FinderPolymarketEvaluation = {
    offset?: number;
    evalResult: PolymarketEvalResult;
    annotatedTrades?: readonly Trade[];
    buildAnnotatedTrades?: () => Trade[];
};

function getProfitFactorFromTotals(grossProfit: number, grossLoss: number): number {
    if (!Number.isFinite(grossProfit) || grossProfit <= 0) {
        return 0;
    }
    if (!Number.isFinite(grossLoss) || grossLoss <= 0) {
        return Infinity;
    }
    return grossProfit / grossLoss;
}

function isAlternativeSizingMode(capitalSettings: CapitalSettings): boolean {
    return capitalSettings.sizingMode !== "fixed" && capitalSettings.sizingMode !== "percent";
}

function buildMappedTradeOutcome(args: {
    trade: Trade;
    outcome: import("../types/polymarket-outcomes").PolymarketOutcomeRow;
    entryOffset?: number;
    marketPriceOffset?: number;
    eventStartTs?: number;
    eventEndTs?: number;
}): TradePolymarketOutcome {
    const { trade, outcome, entryOffset } = args;
    const prediction = trade.type === "long" ? "yes" : "no";
    const isWin = prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;
    const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction, args.marketPriceOffset ?? entryOffset);

    return {
        eventStartTs: args.eventStartTs ?? outcome.event_start_ts,
        eventEndTs: args.eventEndTs ?? outcome.event_end_ts,
        eventSlug: outcome.event_slug,
        marketSlug: outcome.market_slug || outcome.event_slug,
        prediction,
        actualOutcomeUp: outcome.resolved_outcome_up,
        isWin,
        marketEntryPrice,
        entryOffset,
        evaluationMode: "resolve_hold",
    };
}

function buildLegacyBridgeSizedTrades(
    mappedTrades: readonly LegacyMappedPolymarketTrade[],
    selectedOffset: number,
    entryPriceFilterCents?: number
): Trade[] {
    const priceEligibleTrades = filterLegacyMappedTradesByEntryOffset(mappedTrades, selectedOffset).filter((mapped) => {
        const prediction = mapped.trade.type === "long" ? "yes" : "no";
        return !isPolymarketEntryPriceFiltered(
            getTradeMarketEntryPrice(mapped.outcome, prediction, mapped.entryOffset),
            entryPriceFilterCents
        );
    });
    return deduplicateLegacyMappedTradesByEvent(
        priceEligibleTrades
    ).map((mapped) => {
        const polymarketOutcome = buildMappedTradeOutcome({
            trade: mapped.trade,
            outcome: mapped.outcome,
            entryOffset: mapped.entryOffset,
        });
        return {
            ...mapped.trade,
            polymarketOutcome,
        };
    });
}

function buildMultiIntervalSizedTrades(
    mappedTrades: readonly MappedPolymarketTrade[],
    selectedOffset: number,
    entryPriceFilterCents?: number
): Trade[] {
    const priceEligibleTrades = filterSuperMappedTradesByEntryOffset(mappedTrades, selectedOffset).filter((mapped) => {
        const prediction = mapped.trade.type === "long" ? "yes" : "no";
        return !isPolymarketEntryPriceFiltered(
            getTradeMarketEntryPrice(mapped.baseOutcome, prediction),
            entryPriceFilterCents
        );
    });
    return deduplicateBySuperEvent(
        priceEligibleTrades
    ).map((mapped) => {
        const polymarketOutcome = buildMappedTradeOutcome({
            trade: mapped.trade,
            outcome: mapped.baseOutcome,
            eventStartTs: mapped.superEventStartTs,
            eventEndTs: mapped.superEventEndTs,
            entryOffset: mapped.entryOffset,
            marketPriceOffset: 0,
        });
        return {
            ...mapped.trade,
            polymarketOutcome,
        };
    });
}

function buildSignalExitSizedTrades(
    results: ReturnType<typeof evaluateSignalExitTrades>["results"]
): Trade[] {
    return results.map((result) => ({
        ...result.trade,
        polymarketOutcome: buildTradeAnnotationFromSignalExitResult(result),
    }));
}

function applySizedNetToEvalResult(args: {
    enabled: boolean;
    evalResult: PolymarketEvalResult;
    baseResult: BacktestResult;
    annotatedTrades?: readonly Trade[];
    chartData: OHLCVData[];
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    summary?: Partial<BacktestPolymarketTradeSummary>;
}): PolymarketEvalResult {
    if (!args.enabled || !args.annotatedTrades || args.annotatedTrades.length === 0) {
        return args.evalResult;
    }

    const sizedResult = applyPolymarketAlternativeSizing({
        result: {
            ...args.baseResult,
            trades: [...args.annotatedTrades],
            polymarketTradeSummary: {
                seriesId: args.summary?.seriesId ?? "",
                outcomeRowsLoaded: args.summary?.outcomeRowsLoaded ?? 0,
                scoredTrades: args.evalResult.scoredPredictions,
                missingOutcomeTrades: args.evalResult.missingOutcomeRows,
                ...args.summary,
            },
        },
        chartData: args.chartData,
        backtestSettings: args.backtestSettings,
        capitalSettings: args.capitalSettings,
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

function buildNativeSessionResolveHoldEvalResult(args: {
    trades: readonly Trade[];
    annotatedTrades: readonly Trade[];
    summary: ReturnType<typeof summarizePolymarketTradesForRun>;
    context: PolymarketTradeEvaluationContext;
}): import("../types/polymarket-outcomes").PolymarketEvalResult {
    const { trades, annotatedTrades, summary, context } = args;
    let wins = 0;
    let losses = 0;
    let longPredictions = 0;
    let shortPredictions = 0;
    let scoredLongPredictions = 0;
    let scoredShortPredictions = 0;
    let longWins = 0;
    let shortWins = 0;
    let pricedPredictions = 0;
    let totalEntryPrice = 0;
    let totalPayout = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let missingPriceTrades = 0;
    let entryPriceFilteredPredictions = 0;
    const useRealizedPnl = summary.limitExitEnabled === true;

    for (let index = 0; index < annotatedTrades.length; index += 1) {
        const trade = trades[index];
        const annotatedTrade = annotatedTrades[index];
        if (trade?.type === "long") {
            longPredictions++;
        } else {
            shortPredictions++;
        }

        const outcome = annotatedTrade?.polymarketOutcome;
        if (outcome?.marketExitSource === "entry_price_filtered") {
            entryPriceFilteredPredictions++;
            continue;
        }
        if (!outcome || outcome.isWin === null) {
            continue;
        }

        if (trade?.type === "long") {
            scoredLongPredictions++;
        } else {
            scoredShortPredictions++;
        }

        const marketEntryPrice = typeof outcome.marketEntryPrice === "number" && Number.isFinite(outcome.marketEntryPrice)
            ? outcome.marketEntryPrice
            : null;
        if (marketEntryPrice === null) {
            missingPriceTrades++;
            continue;
        }

        pricedPredictions++;
        totalEntryPrice += marketEntryPrice;
        const payout = useRealizedPnl && typeof outcome.marketPnl === "number" && Number.isFinite(outcome.marketPnl)
            ? outcome.marketPnl
            : outcome.isWin ? (1 - marketEntryPrice) : -marketEntryPrice;
        const isProfitable = useRealizedPnl
            ? payout > 0
                ? true
                : payout < 0
                    ? false
                    : null
            : outcome.isWin;
        if (isProfitable === true) {
            wins++;
            if (trade?.type === "long") {
                longWins++;
            } else {
                shortWins++;
            }
        } else if (isProfitable === false) {
            losses++;
        }
        totalPayout += payout;
        if (payout > 0) {
            grossProfit += payout;
        } else if (payout < 0) {
            grossLoss += Math.abs(payout);
        }
    }

    const scoredPredictions = summary.scoredTrades;
    const avgEntryPrice = pricedPredictions > 0 ? totalEntryPrice / pricedPredictions : 0;
    const breakEvenWinRate = avgEntryPrice;

    return {
        evaluatedEvents: context.evaluatedEvents,
        predictionsTaken: trades.length,
        scoredPredictions,
        pricedPredictions,
        profitFactor: getProfitFactorFromTotals(grossProfit, grossLoss),
        grossProfit,
        grossLoss,
        wins,
        losses,
        skips: summary.unscoredTrades ?? Math.max(0, trades.length - scoredPredictions),
        winRate: scoredPredictions > 0 ? wins / scoredPredictions : 0,
        coverage: context.evaluatedEvents > 0 ? scoredPredictions / context.evaluatedEvents : 0,
        longPredictions,
        shortPredictions,
        longWins,
        shortWins,
        longWinRate: scoredLongPredictions > 0 ? longWins / scoredLongPredictions : 0,
        shortWinRate: scoredShortPredictions > 0 ? shortWins / scoredShortPredictions : 0,
        alwaysYesBaselineWinRate: context.evaluatedEvents > 0 ? context.resolvedUpCount / context.evaluatedEvents : 0,
        alwaysNoBaselineWinRate: context.evaluatedEvents > 0 ? (context.evaluatedEvents - context.resolvedUpCount) / context.evaluatedEvents : 0,
        avgEntryPrice,
        breakEvenWinRate,
        expectancy: pricedPredictions > 0 ? totalPayout / pricedPredictions : 0,
        edgeVsBreakEven: (scoredPredictions > 0 ? wins / scoredPredictions : 0) - breakEvenWinRate,
        missingOutcomeRows: summary.missingOutcomeTrades,
        ignoredSignals: 0,
        duplicateTradesIgnored: summary.duplicateTradesIgnored ?? 0,
        entryPriceFilteredPredictions: entryPriceFilteredPredictions > 0 ? entryPriceFilteredPredictions : undefined,
        missingPriceTrades: (missingPriceTrades + (summary.limitEntryMissingPriceTrades ?? 0)) > 0
            ? missingPriceTrades + (summary.limitEntryMissingPriceTrades ?? 0)
            : undefined,
        evaluationMode: "resolve_hold",
        targetExitedTrades: summary.targetExitedTrades,
        limitEntryEnabled: summary.limitEntryEnabled,
        limitEntryMode: summary.limitEntryMode,
        limitEntryPriceCents: summary.limitEntryPriceCents,
        limitEntryOffsetCents: summary.limitEntryOffsetCents,
        limitEntryAttempts: summary.limitEntryAttempts,
        limitEntryFilledTrades: summary.limitEntryFilledTrades,
        limitEntryMissedTrades: summary.limitEntryMissedTrades,
        limitEntryNotTouchedTrades: summary.limitEntryNotTouchedTrades,
        limitEntryLastMinuteOnlyTrades: summary.limitEntryLastMinuteOnlyTrades,
        limitEntryMissingPriceTrades: summary.limitEntryMissingPriceTrades,
        limitEntryInvalidWindowTrades: summary.limitEntryInvalidWindowTrades,
        limitEntryFillRate: summary.limitEntryFillRate,
        avgLimitEntryWaitSec: summary.avgLimitEntryWaitSec,
        avgLimitEntryImprovement: summary.avgLimitEntryImprovement,
        limitExitEnabled: summary.limitExitEnabled,
        limitExitMode: summary.limitExitMode,
        limitExitPriceCents: summary.limitExitPriceCents,
        limitExitOffsetCents: summary.limitExitOffsetCents,
        limitExitFilledTrades: summary.limitExitFilledTrades,
        limitExitFallbackTrades: summary.limitExitFallbackTrades,
        limitExitUnreachableTrades: summary.limitExitUnreachableTrades,
        rows: [],
    };
}

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
    entryPriceFilterCents?: number;
}): import("../types/polymarket-outcomes").PolymarketEvalResult {
    const {
        mappedTrades,
        strategyKey,
        selectedOffset,
        includeRows,
        predictionsTaken,
        context,
    } = options;

    const offsetTrades = mappedTrades.filter((mt) => mt.entryOffset === selectedOffset);
    const priceEligibleTrades: MappedPolymarketTrade[] = [];
    let entryPriceFilteredPredictions = 0;
    for (const mt of offsetTrades) {
        const prediction = mt.trade.type === "long" ? "yes" : "no";
        const marketEntryPrice = getTradeMarketEntryPrice(mt.baseOutcome, prediction);
        if (isPolymarketEntryPriceFiltered(marketEntryPrice, options.entryPriceFilterCents)) {
            entryPriceFilteredPredictions++;
            continue;
        }
        priceEligibleTrades.push(mt);
    }
    const seenEvents = new Set<number>();
    const selected: MappedPolymarketTrade[] = [];
    for (const mt of priceEligibleTrades) {
        const eventKey = mt.superEventStartTs;
        if (seenEvents.has(eventKey)) continue;
        seenEvents.add(eventKey);
        selected.push(mt);
    }

    const accumulator = new PolymarketEvalAccumulator({
        evaluatedEvents: context.evaluatedEvents,
        predictionsTaken,
        resolvedUpCount: context.resolvedUpCount,
        includeRows,
        strategyKey,
        entryOffset: selectedOffset,
        skipBasis: "predictionsTaken",
    });
    for (let index = 0; index < entryPriceFilteredPredictions; index += 1) {
        accumulator.recordEntryPriceFiltered();
    }

    for (const mt of selected) {
        const executionBarIndex = context.executionBarIndexByTs.get(mt.entryTs);
        const signalBarIndex = executionBarIndex === undefined ? -1 : Math.max(0, executionBarIndex - 1);
        const prediction = mt.trade.type === "long" ? "yes" : "no";
        const marketEntryPrice = getTradeMarketEntryPrice(mt.baseOutcome, prediction);

        accumulator.recordPrediction(mt.trade.type);
        accumulator.recordScoredPrediction({
            tradeType: mt.trade.type,
            eventStartTs: mt.superEventStartTs,
            eventEndTs: mt.superEventEndTs,
            eventSlug: mt.baseOutcome.event_slug,
            actualOutcomeUp: mt.baseOutcome.resolved_outcome_up,
            marketEntryPrice,
            signalBarIndex,
            signalTime: mt.entryTs,
            entryOffset: mt.entryOffset,
        });
    }

    return accumulator.toResult();
}

export async function runPolymarketFinder(
    input: FinderRunInput,
    callbacks: FinderRunCallbacks
): Promise<FinderRunOutput> {
    const { options, settings, selectedStrategies } = input;
    await ensureConfirmationStrategiesLoaded(settings);
    const interval = input.interval as PolymarketInterval;
    const intervalConfig = getIntervalConfig(interval);
    const outcomeSymbol = resolvePolymarketOutcomeSymbol(input.symbol, settings.polymarketOutcomeSymbol);
    const resolvedOutcomeInterval = resolvePolymarketOutcomeInterval(settings.polymarketOutcomeInterval);
    const entryPriceFilterCents = clampPolymarketEntryPriceFilterCents(
        options.polymarketEntryPriceFilterCents ?? settings.polymarketEntryPriceFilterCents
    );
    const isNativeOutcomeSession = resolvedOutcomeInterval !== DEFAULT_POLYMARKET_OUTCOME_INTERVAL;
    const limitEntrySettings: PolymarketPostSignalLimitEntrySettings | undefined =
        (
            resolvedOutcomeInterval === "5m"
            && (
                options.polymarketPostSignalLimitEntryEnabled === true
                || settings.polymarketPostSignalLimitEntryEnabled === true
            )
        )
            ? {
                enabled: true,
                priceMode: resolvePolymarketPostSignalLimitEntryMode(
                    options.polymarketPostSignalLimitEntryMode
                        ?? settings.polymarketPostSignalLimitEntryMode
                ),
                priceCents: clampPolymarketPostSignalLimitEntryPriceCents(
                    options.polymarketPostSignalLimitEntryPriceCents
                        ?? settings.polymarketPostSignalLimitEntryPriceCents
                ),
                offsetCents: clampPolymarketPostSignalLimitOffsetCents(
                    options.polymarketPostSignalLimitEntryOffsetCents
                        ?? settings.polymarketPostSignalLimitEntryOffsetCents
                ),
                exitEnabled: options.polymarketPostSignalLimitExitEnabled === true
                    || settings.polymarketPostSignalLimitExitEnabled === true,
                exitMode: resolvePolymarketPostSignalLimitExitMode(
                    options.polymarketPostSignalLimitExitMode
                        ?? settings.polymarketPostSignalLimitExitMode
                ),
                exitPriceCents: clampPolymarketPostSignalLimitExitPriceCents(
                    options.polymarketPostSignalLimitExitPriceCents
                        ?? settings.polymarketPostSignalLimitExitPriceCents
                ),
                exitOffsetCents: clampPolymarketPostSignalLimitOffsetCents(
                    options.polymarketPostSignalLimitExitOffsetCents
                        ?? settings.polymarketPostSignalLimitExitOffsetCents
                ),
            }
            : undefined;

    // Validate interval
    if (!intervalConfig) {
        callbacks.setStatus("Polymarket scoring requires 1m, 5m, 15m, 1h, or 4h interval.");
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

    const effectiveExitMode = resolveEffectivePolymarketExitMode({
        requestedMode: options.polymarketExitMode,
        interval,
        executionModel: settings.executionModel,
        polymarketAnnotationEnabled: true,
    });
    const isSignalExitMode = isSignalExitSameEventMode(effectiveExitMode);
    const is5mRun = interval === "5m";
    const isLimitEntryMode = limitEntrySettings?.enabled === true;
    const isMultiSubEventRun = !isNativeOutcomeSession && !is5mRun && !isSignalExitMode && !isLimitEntryMode;
    const requiresSizedNetRank = options.sortPriority.includes("polySizedNet");
    if (requiresSizedNetRank && !isAlternativeSizingMode(input.capitalSettings)) {
        callbacks.setStatus("Sized Net rank mode requires Alternative Sizing mode other than fixed or percent.");
        return { results: [] };
    }

    // Validate symbol support
    if (
        isNativeOutcomeSession
            ? !isSupportedPolymarketOutcomeRun(input.symbol, interval, resolvedOutcomeInterval, outcomeSymbol)
            : !isSupportedPolymarketMultiIntervalRun(input.symbol, interval, outcomeSymbol)
    ) {
        callbacks.setStatus(`Polymarket scoring currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 1m, 5m, 15m, 1h, 4h.`);
        return { results: [] };
    }

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

    if (isSignalExitMode) {
        if (interval !== "1m") {
            callbacks.setStatus("signal_exit_same_event mode requires 1m interval.");
            return { results: [] };
        }
        if (settings.executionModel !== "next_open") {
            callbacks.setStatus("signal_exit_same_event mode requires next_open execution model.");
            return { results: [] };
        }
        const rankMode = options.polymarketRankMode ?? "balanced";
        if (!SIGNAL_EXIT_SUPPORTED_RANK_MODES.has(rankMode as any)) {
            callbacks.setStatus(`signal_exit_same_event does not support rank mode "${rankMode}". Use expectancy, profitFactor, or sized net variants.`);
            return { results: [] };
        }
    }

    callbacks.setProgress(5, "Loading Polymarket outcome data...");
    callbacks.setStatus("Loading Polymarket outcomes from SQLite...");

    const closedData = buildFinderEvaluationData(input.ohlcvData, input.interval, settings);
    if (closedData.length < 2) {
        callbacks.setStatus("Not enough chart data for Polymarket evaluation.");
        return { results: [] };
    }

    const seriesId = isNativeOutcomeSession
        ? getEffectivePolymarketSeriesId(input.symbol, resolvedOutcomeInterval, outcomeSymbol)
        : getEffectivePolymarket5mSeriesId(input.symbol, outcomeSymbol);
    if (!seriesId) {
        callbacks.setStatus(`Polymarket scoring currently supports ${getSupportedPolymarket5mSymbolsLabel()} on ${resolvedOutcomeInterval}.`);
        return { results: [] };
    }

    let outcomes: Awaited<ReturnType<typeof loadPolymarketOutcomesForChart>>;
    try {
        outcomes = isNativeOutcomeSession
            ? await loadPolymarketOutcomesForChart(input.symbol, closedData, outcomeSymbol, resolvedOutcomeInterval)
            : await loadPolymarket5mOutcomesForChart(input.symbol, closedData, outcomeSymbol);
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

    let pricePoints: PolymarketPricePoint[] = [];
    let priceIndex: EventPriceIndex | undefined;
    let outcomeByEntryTs: ReadonlyMap<number, import("../types/polymarket-outcomes").PolymarketOutcomeRow | null> | undefined;
    if (isSignalExitMode || isNativeOutcomeSession || isLimitEntryMode) {
        try {
            const rawFirst = closedData.length > 0 ? closedData[0].time : 0;
            const rawLast = closedData.length > 0 ? closedData[closedData.length - 1].time : 0;
            const firstTs = typeof rawFirst === 'number' ? rawFirst : 0;
            const lastTs = typeof rawLast === 'number' ? rawLast : 0;
            const paddingSec = getPolymarketOutcomeIntervalDurationSec(resolvedOutcomeInterval);
            callbacks.setStatus(`Ensuring Polymarket price points for ${outcomes.length} events...`);
            pricePoints = await ensurePricePointsForOutcomes(outcomes, seriesId, {
                startTs: firstTs > 0 ? firstTs - paddingSec : undefined,
                endTs: lastTs > 0 ? lastTs + paddingSec : undefined,
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            callbacks.setStatus(`Failed to ensure Polymarket price points: ${detail}`);
            return { results: [] };
        }
        if (pricePoints.length === 0) {
            callbacks.setStatus(`No Polymarket price points available for series ${seriesId} after ingestion.`);
            return { results: [] };
        }
        if (isSignalExitMode) {
            priceIndex = indexPricePointsByEvent(pricePoints);
            outcomeByEntryTs = indexSignalExitOutcomesByEntryTs(
                closedData
                    .map((bar) => parseTimeToUnixSeconds(bar.time))
                    .filter((value): value is number => value !== null),
                outcomes
            );
        }
    }

    // Build strategy plans from selections
    const baseStrategyPlans: StrategyPlan[] = [];
    for (const selection of selectedStrategies) {
        const extendedDefaults = buildFinderSearchBaseParams(selection.strategy, settings, options);
        const paramSets = normalizeFinderCandidateParamSets(
            selection.strategy,
            input.generateParamSets(extendedDefaults, options)
        );
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
    const computeSizedNet = requiresSizedNetRank;
    const ranker = new FinderResultRanker(Math.max(options.topN, 50), options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let failedCount = 0;
    let lastUiUpdateAt = 0;
    let lastResultsUpdateAt = 0;

    callbacks.setStatus(`Running ${totalRuns} Polymarket evaluations...`);
    callbacks.setProgress(14, `${processedCount}/${totalRuns} evaluations`);
    await callbacks.yieldControl();

    for (const plan of baseStrategyPlans) {
        // Resolve cross-symbol context once per strategy plan (not per candidate)
        let strategyData = closedData;
        let crossSymbolCtx: StrategyExecutionContext | undefined;
        if (isCrossSymbolStrategy(plan.strategy)) {
            try {
                const { dataManager } = await import("../data-manager");
                const resolved = await resolveCrossSymbolExecution({
                    strategy: plan.strategy,
                    primarySymbol: input.symbol,
                    interval,
                    primaryData: closedData,
                    settings,
                    dataFetcher: dataManager,
                });
                strategyData = resolved.primaryData;
                crossSymbolCtx = resolved.context;
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                debugLogger.warn("[Finder][polymarket] Cross-symbol resolution failed", {
                    strategyKey: plan.key,
                    error: detail,
                });
                processedCount += plan.paramSets.length * evaluationCountPerParamSet;
                failedCount += plan.paramSets.length * evaluationCountPerParamSet;
                continue;
            }
        }

        for (const params of plan.paramSets) {
            if (callbacks.isCancelled()) {
                callbacks.setStatus("Finder stopped by user.");
                const results = ranker.toSortedArray(options.topN);
                callbacks.onResultsUpdate(results);
                return { results };
            }

            try {
                const normalizedParams = plan.strategy.normalizeParams ? plan.strategy.normalizeParams(params) : { ...params };
                const rawSignals = plan.strategy.executePrepared
                    ? plan.strategy.executePrepared(
                        getPreparedFinderData(preparedDataCache, plan.key, plan.strategy, strategyData, settings, crossSymbolCtx),
                        normalizedParams,
                        strategyData,
                        crossSymbolCtx
                    )
                    : plan.strategy.execute(strategyData, normalizedParams, crossSymbolCtx);
                const signals = applyConfirmationStrategiesToSignals({
                    data: strategyData,
                    baseSignals: applySignalPolarity(rawSignals, settings),
                    settings,
                });
                const backtestResult = runStrategyBacktest({
                    strategy: plan.strategy,
                    data: strategyData,
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

                if (isSignalExitMode) {
                    const signalExitEvaluation = evaluateSignalExitTrades({
                        trades: tradesForPolymarketEvaluation,
                        outcomes,
                        priceIndex,
                        outcomeByEntryTs,
                        allowMultipleTradesPerEvent: options.polymarketSignalExitAllowMultipleTradesPerEvent,
                        entryPriceFilterCents,
                        limitEntry: limitEntrySettings,
                    });
                    const exitSummary = signalExitEvaluation.summary;

                    const evalResultBase: PolymarketEvalResult = {
                        evaluatedEvents: polymarketContext.evaluatedEvents,
                        predictionsTaken: tradesForPolymarketEvaluation.length,
                        scoredPredictions: exitSummary.scoredTrades,
                        pricedPredictions: exitSummary.scoredTrades,
                        profitFactor: exitSummary.profitFactor,
                        grossProfit: exitSummary.grossProfit,
                        grossLoss: exitSummary.grossLoss,
                        wins: exitSummary.profitableTrades,
                        losses: exitSummary.losingTrades,
                        skips: exitSummary.unscoredTrades,
                        winRate: exitSummary.scoredTrades > 0 ? exitSummary.profitableTrades / exitSummary.scoredTrades : 0,
                        coverage: polymarketContext.evaluatedEvents > 0 ? exitSummary.scoredTrades / polymarketContext.evaluatedEvents : 0,
                        longPredictions: 0,
                        shortPredictions: 0,
                        longWins: 0,
                        shortWins: 0,
                        longWinRate: 0,
                        shortWinRate: 0,
                        alwaysYesBaselineWinRate: polymarketContext.evaluatedEvents > 0 ? polymarketContext.resolvedUpCount / polymarketContext.evaluatedEvents : 0,
                        alwaysNoBaselineWinRate: polymarketContext.evaluatedEvents > 0 ? (polymarketContext.evaluatedEvents - polymarketContext.resolvedUpCount) / polymarketContext.evaluatedEvents : 0,
                        avgEntryPrice: exitSummary.avgEntryPrice,
                        // Break-even win rate is a resolve_hold concept; signal-exit
                        // scoring uses realized PnL instead of binary payout odds.
                        breakEvenWinRate: 0,
                        expectancy: exitSummary.expectancy,
                        edgeVsBreakEven: 0,
                        missingOutcomeRows: exitSummary.missingOutcomeTrades + exitSummary.missingPriceTrades,
                        ignoredSignals: exitSummary.duplicateTradesIgnored,
                        entryPriceFilteredPredictions: exitSummary.entryPriceFilteredTrades > 0 ? exitSummary.entryPriceFilteredTrades : undefined,
                        evaluationMode: "signal_exit_same_event",
                        signalExitAllowMultipleTradesPerEvent: exitSummary.allowMultipleTradesPerEvent,
                        targetExitedTrades: exitSummary.targetExitedTrades,
                        signalExitedTrades: exitSummary.signalExitedTrades,
                        resolvedTrades: exitSummary.resolvedTrades,
                        missingPriceTrades: exitSummary.missingPriceTrades,
                        netPnl: exitSummary.netPnl,
                        avgExitPrice: exitSummary.avgExitPrice,
                        limitEntryEnabled: exitSummary.limitEntryEnabled,
                        limitEntryMode: exitSummary.limitEntryMode,
                        limitEntryPriceCents: exitSummary.limitEntryPriceCents,
                        limitEntryOffsetCents: exitSummary.limitEntryOffsetCents,
                        limitEntryAttempts: exitSummary.limitEntryAttempts,
                        limitEntryFilledTrades: exitSummary.limitEntryFilledTrades,
                        limitEntryMissedTrades: exitSummary.limitEntryMissedTrades,
                        limitEntryNotTouchedTrades: exitSummary.limitEntryNotTouchedTrades,
                        limitEntryLastMinuteOnlyTrades: exitSummary.limitEntryLastMinuteOnlyTrades,
                        limitEntryMissingPriceTrades: exitSummary.limitEntryMissingPriceTrades,
                        limitEntryInvalidWindowTrades: exitSummary.limitEntryInvalidWindowTrades,
                        limitEntryFillRate: exitSummary.limitEntryFillRate,
                        avgLimitEntryWaitSec: exitSummary.avgLimitEntryWaitSec,
                        avgLimitEntryImprovement: exitSummary.avgLimitEntryImprovement,
                        limitExitEnabled: exitSummary.limitExitEnabled,
                        limitExitMode: exitSummary.limitExitMode,
                        limitExitPriceCents: exitSummary.limitExitPriceCents,
                        limitExitOffsetCents: exitSummary.limitExitOffsetCents,
                        limitExitFilledTrades: exitSummary.limitExitFilledTrades,
                        limitExitFallbackTrades: exitSummary.limitExitFallbackTrades,
                        limitExitUnreachableTrades: exitSummary.limitExitUnreachableTrades,
                        rows: [],
                    };

                    processedCount++;
                    if (evalResultBase.scoredPredictions < (options.polymarketMinScoredPredictions ?? 0)) {
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

                    const evalResult = applySizedNetToEvalResult({
                        enabled: computeSizedNet,
                        evalResult: evalResultBase,
                        baseResult: backtestResult,
                        annotatedTrades: computeSizedNet
                            ? buildSignalExitSizedTrades(signalExitEvaluation.results)
                            : undefined,
                        chartData: closedData,
                        backtestSettings: settings,
                        capitalSettings: input.capitalSettings,
                        summary: {
                            seriesId,
                            outcomeRowsLoaded: outcomes.length,
                            scoredTrades: exitSummary.scoredTrades,
                            missingOutcomeTrades: exitSummary.missingOutcomeTrades,
                            evaluationMode: "signal_exit_same_event",
                            signalExitAllowMultipleTradesPerEvent: exitSummary.allowMultipleTradesPerEvent,
                        },
                    });

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
                    if (now - lastResultsUpdateAt > 750 || processedCount === totalRuns) {
                        lastResultsUpdateAt = now;
                        callbacks.onResultsUpdate(ranker.toSortedArray(options.topN));
                    }
                    if (processedCount % 1024 === 0 || processedCount === totalRuns) {
                        await callbacks.yieldControl();
                    }
                } else {
                    const evaluations: FinderPolymarketEvaluation[] = (isNativeOutcomeSession || isLimitEntryMode)
                        ? (() => {
                            const annotatedTrades = annotateTradesWithPolymarketOutcomesForRun(
                                tradesForPolymarketEvaluation,
                                outcomes,
                                interval,
                                undefined,
                                "fixed_offset",
                                {
                                    outcomeInterval: resolvedOutcomeInterval,
                                    pricePoints,
                                    entryPriceFilterCents,
                                    limitEntry: limitEntrySettings,
                                }
                            );
                            const summary = summarizePolymarketTradesForRun({
                                trades: annotatedTrades,
                                outcomes,
                                interval,
                                outcomeInterval: resolvedOutcomeInterval,
                                limitEntry: limitEntrySettings,
                            });
                            return [{
                                offset: undefined,
                                evalResult: buildNativeSessionResolveHoldEvalResult({
                                    trades: tradesForPolymarketEvaluation,
                                    annotatedTrades,
                                    summary,
                                    context: polymarketContext,
                                }),
                                annotatedTrades: computeSizedNet ? annotatedTrades : undefined,
                            }];
                        })()
                        : (() => {
                            const legacyMappedTrades: readonly LegacyMappedPolymarketTrade[] | undefined = isMultiSubEventRun && interval === "1m"
                                ? mapTradesToLegacyEvents(tradesForPolymarketEvaluation, outcomes)
                                : undefined;
                            const superMappedTrades: readonly MappedPolymarketTrade[] | undefined = isMultiSubEventRun && interval !== "1m"
                                ? mapTradesToSuperEvents(tradesForPolymarketEvaluation, outcomes, interval)
                                : undefined;

                            return isMultiSubEventRun
                                ? bridgeOffsetsToEvaluate.map((offset) => {
                                    const evalResult = interval === "1m"
                                        ? evaluateMappedPolymarketBacktestTrades1mBridge({
                                            chartData: closedData,
                                            mappedTrades: legacyMappedTrades ?? [],
                                            outcomes,
                                            strategyKey: plan.key,
                                            selectedOffset: offset,
                                            includeRows: false,
                                            predictionsTaken: tradesForPolymarketEvaluation.length,
                                            context: polymarketBridgeContext,
                                            entryPriceFilterCents,
                                        })
                                        : evaluateMultiIntervalPolymarketTrades({
                                            mappedTrades: superMappedTrades ?? [],
                                            strategyKey: plan.key,
                                            selectedOffset: offset,
                                            includeRows: false,
                                            predictionsTaken: tradesForPolymarketEvaluation.length,
                                            context: polymarketBridgeContext!,
                                            entryPriceFilterCents,
                                        });
                                    return {
                                        offset,
                                        evalResult,
                                        buildAnnotatedTrades: computeSizedNet
                                            ? () => interval === "1m"
                                                ? buildLegacyBridgeSizedTrades(legacyMappedTrades ?? [], offset, entryPriceFilterCents)
                                                : buildMultiIntervalSizedTrades(superMappedTrades ?? [], offset, entryPriceFilterCents)
                                            : undefined,
                                    };
                                })
                                : [{
                                    offset: undefined,
                                    evalResult: evaluatePolymarketBacktestTrades({
                                        chartData: closedData,
                                        trades: tradesForPolymarketEvaluation,
                                        outcomes,
                                        strategyKey: plan.key,
                                        context: polymarketContext,
                                        includeRows: false,
                                        entryPriceFilterCents,
                                    }),
                                    buildAnnotatedTrades: computeSizedNet
                                        ? () => annotateTradesWithPolymarketOutcomesForRun(
                                            tradesForPolymarketEvaluation,
                                            outcomes,
                                            interval,
                                            undefined,
                                            "fixed_offset",
                                            { entryPriceFilterCents }
                                        )
                                        : undefined,
                                }];
                        })();

                    for (const evaluation of evaluations) {
                        processedCount++;
                        const { offset } = evaluation;
                        const evalResultBase = evaluation.evalResult;
                        if (evalResultBase.scoredPredictions < (options.polymarketMinScoredPredictions ?? 0)) {
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

                        const evalResult = applySizedNetToEvalResult({
                            enabled: computeSizedNet,
                            evalResult: evalResultBase,
                            baseResult: backtestResult,
                            annotatedTrades: evaluation.annotatedTrades ?? evaluation.buildAnnotatedTrades?.(),
                            chartData: closedData,
                            backtestSettings: settings,
                            capitalSettings: input.capitalSettings,
                            summary: {
                                seriesId,
                                outcomeRowsLoaded: outcomes.length,
                                scoredTrades: evaluation.evalResult.scoredPredictions,
                                missingOutcomeTrades: evaluation.evalResult.missingOutcomeRows,
                                entryOffset: offset,
                                evaluationMode: evaluation.evalResult.evaluationMode,
                            },
                        });

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

                        if (now - lastResultsUpdateAt > 750 || processedCount === totalRuns) {
                            lastResultsUpdateAt = now;
                            callbacks.onResultsUpdate(ranker.toSortedArray(options.topN));
                        }

                        if (processedCount % 1024 === 0 || processedCount === totalRuns) {
                            await callbacks.yieldControl();
                        }
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
