import type { BacktestResult } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import type { PolymarketDomSettings } from "./polymarket-dom-reader";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import {
    getEffectivePolymarketSeriesId,
    isSupportedPolymarketOutcomeRun,
    loadPolymarketOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
} from "./polymarket-btc5m";
import {
    resolvePolymarketOutcomeInterval,
} from "./polymarket-outcome-interval";
import {
    resolveEffectivePolymarketExitMode,
    isSameEventPolymarketExitMode,
    type PolymarketExitMode,
} from "./polymarket-exit-mode";
import { parseTimeToUnixSeconds } from "./time-normalization";
import {
    isActualPolymarketEntryMinuteMode,
    resolvePolymarketEntrySelectionModeForDisplay,
} from "./polymarket-entry-selection-mode";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    summarizePolymarketTradesForRun,
} from "./polymarket-trade-annotations";
import {
    buildSignalExitPolymarketTradeSummary,
    evaluateSignalExitTrades,
    buildTradeAnnotationFromSignalExitResult,
    indexSignalExitOutcomesForTrades,
} from "./polymarket-signal-exit-evaluator";
import { ensurePricePointsForOutcomes } from "./polymarket-price-points-ingest";
import {
    annotateBacktestResultWithSecondMarketClob,
    isSecondMarketPolymarketSupported,
} from "./second-market/evaluation";
import { debugLogger } from "./debug-logger";
import { hasFilteredPolymarketTrades } from "./polymarket-entry-selection-mode";

export interface PolymarketRebuildInput {
    result: BacktestResult;
    marketContext?: { symbol: string; interval: string };
    settingsSnapshot: PolymarketDomSettings;
    executionModel?: string;
    preferStoredSummary: boolean;
    allowSecondMarket: boolean;
    caller: "panel" | "quick_view" | "trades";
    outcomes?: readonly PolymarketOutcomeRow[];
}

export interface PolymarketRebuildOutput {
    result: BacktestResult;
    outcomesLoaded: number;
    pricePointsLoaded: number;
    effectiveExitMode: PolymarketExitMode;
    usedSecondMarket: boolean;
    usedPricePointEnsure: boolean;
    usedFallback: boolean;
    durationMs: number;
}

export async function rebuildPolymarketAnnotations(input: PolymarketRebuildInput): Promise<PolymarketRebuildOutput> {
    const startTime = performance.now();
    const {
        result,
        marketContext,
        settingsSnapshot,
        preferStoredSummary,
        allowSecondMarket,
        caller,
    } = input;

    let pricePointsLoaded = 0;
    let usedPricePointEnsure = false;
    let usedFallback = false;
    let usedSecondMarketVar = false;
    let outcomesLoadedCount = 0;

    const resultContext = marketContext || resolveBacktestResultMarketContext(result);
    if (!resultContext) {
        return {
            result,
            outcomesLoaded: 0,
            pricePointsLoaded: 0,
            effectiveExitMode: "resolve_hold",
            usedSecondMarket: false,
            usedPricePointEnsure: false,
            usedFallback: false,
            durationMs: performance.now() - startTime,
        };
    }

    const symbol = resultContext.symbol;
    const interval = resultContext.interval;

    const existingSummary = result.polymarketTradeSummary;
    const outcomeSymbol = existingSummary?.outcomeSymbol || settingsSnapshot.outcomeSymbol;
    const outcomeInterval = resolvePolymarketOutcomeInterval(
        existingSummary?.outcomeInterval || settingsSnapshot.outcomeInterval
    );
    const resolvedOutcomeSymbol = resolvePolymarketOutcomeSymbol(symbol, outcomeSymbol);
    const seriesId = getEffectivePolymarketSeriesId(symbol, outcomeInterval, outcomeSymbol);

    const entrySelectionMode = resolvePolymarketEntrySelectionModeForDisplay(
        existingSummary?.entrySelectionMode,
        settingsSnapshot.entrySelectionMode,
        result.trades
    );

    const hasOutcomes = result.trades.some(
        (trade) => trade.polymarketOutcome !== undefined && trade.polymarketOutcome !== null
    );
    const shouldRetryEmptySignalExitSummary = existingSummary
        && isSameEventPolymarketExitMode(existingSummary.evaluationMode)
        && (existingSummary.scoredTrades ?? 0) === 0
        && result.trades.length > 0;
    const isSecondMarketRun = allowSecondMarket && isSecondMarketPolymarketSupported(symbol, interval);
    const hasPolymarketPerformance = existingSummary?.expectancy !== undefined && existingSummary?.expectancy !== null;
    const shouldRefreshSecondMarketPricing = isSecondMarketRun
        && existingSummary !== undefined
        && !hasPolymarketPerformance;
    const shouldRepairFilteredActualMode = interval === "1m"
        && outcomeInterval === "5m"
        && isActualPolymarketEntryMinuteMode(entrySelectionMode)
        && hasFilteredPolymarketTrades(result.trades);

    const canUseStored = preferStoredSummary
        && existingSummary
        && hasOutcomes
        && !shouldRetryEmptySignalExitSummary
        && !shouldRepairFilteredActualMode
        && !shouldRefreshSecondMarketPricing;

    if (canUseStored && seriesId) {
        const durationMs = performance.now() - startTime;
        return {
            result: {
                ...result,
                polymarketTradeSummary: {
                    ...existingSummary,
                    seriesId: existingSummary.seriesId || seriesId,
                    outcomeSymbol: existingSummary.outcomeSymbol ?? resolvedOutcomeSymbol ?? undefined,
                    outcomeInterval: existingSummary.outcomeInterval ?? outcomeInterval,
                },
            },
            outcomesLoaded: existingSummary.outcomeRowsLoaded || 0,
            pricePointsLoaded: 0,
            effectiveExitMode: existingSummary.evaluationMode || "resolve_hold",
            usedSecondMarket: isSecondMarketRun,
            usedPricePointEnsure: false,
            usedFallback: false,
            durationMs,
        };
    }

    const effectiveExitMode = resolveEffectivePolymarketExitMode({
        requestedMode: existingSummary?.evaluationMode || settingsSnapshot.exitMode,
        interval,
        executionModel: input.executionModel || settingsSnapshot.executionModel,
        polymarketAnnotationEnabled: true,
    });

    let finalResult: BacktestResult = result;

    if (isSecondMarketRun) {
        try {
            usedSecondMarketVar = true;
            const limitEntry = outcomeInterval === "5m"
                && (existingSummary?.limitEntryEnabled === true || (!existingSummary && settingsSnapshot.postSignalLimitEntryEnabled))
                ? {
                    enabled: true,
                    priceMode: existingSummary?.limitEntryMode ?? settingsSnapshot.postSignalLimitEntryMode,
                    priceCents: existingSummary?.limitEntryPriceCents ?? settingsSnapshot.postSignalLimitEntryPriceCents,
                    offsetCents: existingSummary?.limitEntryOffsetCents ?? settingsSnapshot.postSignalLimitEntryOffsetCents,
                    exitEnabled: existingSummary ? existingSummary.limitExitEnabled === true : settingsSnapshot.postSignalLimitExitEnabled,
                    exitMode: existingSummary?.limitExitMode ?? settingsSnapshot.postSignalLimitExitMode,
                    exitPriceCents: existingSummary?.limitExitPriceCents ?? settingsSnapshot.postSignalLimitExitPriceCents,
                    exitOffsetCents: existingSummary?.limitExitOffsetCents ?? settingsSnapshot.postSignalLimitExitOffsetCents,
                }
                : undefined;

            finalResult = await annotateBacktestResultWithSecondMarketClob({
                result,
                symbol,
                interval,
                outcomeSymbol: outcomeSymbol ?? undefined,
                outcomeInterval,
                executionModel: input.executionModel || settingsSnapshot.executionModel,
                polymarketExitMode: effectiveExitMode,
                polymarketSignalExitAllowMultipleTradesPerEvent: existingSummary
                    && isSameEventPolymarketExitMode(existingSummary.evaluationMode)
                    ? existingSummary.signalExitAllowMultipleTradesPerEvent === true
                    : settingsSnapshot.signalExitAllowMultipleTradesPerEvent,
                entryPriceFilterCents: settingsSnapshot.entryPriceFilterCents,
                backtestSlippageCents: settingsSnapshot.backtestSlippageCents,
                entryCutoffEnabled: settingsSnapshot.entryCutoffEnabled,
                entryCutoffSeconds: settingsSnapshot.entryCutoffSeconds,
                entryDelayBars: existingSummary?.entryDelayBars ?? settingsSnapshot.entryDelayBars,
                limitEntry,
                protection: {
                    polymarketProtectionTakeProfitEnabled: settingsSnapshot.protectionTakeProfitEnabled,
                    polymarketProtectionTakeProfitCents: settingsSnapshot.protectionTakeProfitCents,
                    polymarketProtectionStopLossEnabled: settingsSnapshot.protectionStopLossEnabled,
                    polymarketProtectionStopLossCents: settingsSnapshot.protectionStopLossCents,
                },
            });
        } catch (error) {
            debugLogger.warn(`${caller}.second_market_polymarket_annotation_failed`, {
                error: error instanceof Error ? error.message : String(error),
            });
            usedFallback = true;
            finalResult = result;
        }
    } else if (!isSupportedPolymarketOutcomeRun(symbol, interval, outcomeInterval, outcomeSymbol) || !seriesId) {
        finalResult = result;
    } else {
        const targetTimes = result.trades
            .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null);

        if (targetTimes.length > 0) {
            const startTs = Math.min(...targetTimes);
            const endTs = Math.max(...targetTimes);

            const outcomes = input.outcomes || await loadPolymarketOutcomesForTimeRange(
                symbol,
                startTs,
                endTs,
                outcomeSymbol,
                outcomeInterval
            );
            outcomesLoadedCount = outcomes.length;

            if (outcomes.length === 0) {
                finalResult = hasOutcomes
                    ? {
                        ...result,
                        polymarketTradeSummary: {
                            ...existingSummary,
                            seriesId: existingSummary?.seriesId || seriesId || "",
                            outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
                            outcomeInterval,
                            outcomeRowsLoaded: 0,
                            scoredTrades: existingSummary?.scoredTrades ?? 0,
                            missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? result.trades.length,
                            unscoredTrades: existingSummary?.unscoredTrades ?? result.trades.length,
                            evaluationMode: effectiveExitMode,
                        },
                    }
                    : result;
            } else {
                const allowMultipleTradesPerEvent = existingSummary && isSameEventPolymarketExitMode(existingSummary.evaluationMode)
                    ? existingSummary.signalExitAllowMultipleTradesPerEvent === true
                    : settingsSnapshot.signalExitAllowMultipleTradesPerEvent;

                const limitEntry = outcomeInterval === "5m"
                    && (existingSummary?.limitEntryEnabled === true || (!existingSummary && settingsSnapshot.postSignalLimitEntryEnabled))
                    ? {
                        enabled: true,
                        priceMode: existingSummary?.limitEntryMode ?? settingsSnapshot.postSignalLimitEntryMode,
                        priceCents: existingSummary?.limitEntryPriceCents ?? settingsSnapshot.postSignalLimitEntryPriceCents,
                        offsetCents: existingSummary?.limitEntryOffsetCents ?? settingsSnapshot.postSignalLimitEntryOffsetCents,
                        exitEnabled: existingSummary ? existingSummary.limitExitEnabled === true : settingsSnapshot.postSignalLimitExitEnabled,
                        exitMode: existingSummary?.limitExitMode ?? settingsSnapshot.postSignalLimitExitMode,
                        exitPriceCents: existingSummary?.limitExitPriceCents ?? settingsSnapshot.postSignalLimitExitPriceCents,
                        exitOffsetCents: existingSummary?.limitExitOffsetCents ?? settingsSnapshot.postSignalLimitExitOffsetCents,
                    }
                    : undefined;

                if (isSameEventPolymarketExitMode(effectiveExitMode) && interval === "1m") {
                    try {
                        const outcomeByEntryTs = indexSignalExitOutcomesForTrades(result.trades, outcomes);
                        const relevantOutcomeByStart = new Map<number, PolymarketOutcomeRow>();
                        for (const outcome of outcomeByEntryTs.values()) {
                            if (outcome) {
                                relevantOutcomeByStart.set(outcome.event_start_ts, outcome);
                            }
                        }
                        usedPricePointEnsure = true;
                        const pricePoints = await ensurePricePointsForOutcomes(
                            relevantOutcomeByStart.size > 0 ? [...relevantOutcomeByStart.values()] : outcomes,
                            seriesId
                        );
                        pricePointsLoaded = pricePoints.length;

                        const { results: exitResults, summary: exitSummary } = evaluateSignalExitTrades({
                            trades: result.trades,
                            outcomes,
                            pricePoints,
                            outcomeByEntryTs,
                            allowMultipleTradesPerEvent,
                            entryPriceFilterCents: settingsSnapshot.entryPriceFilterCents,
                            backtestSlippageCents: settingsSnapshot.backtestSlippageCents,
                            entryCutoffEnabled: settingsSnapshot.entryCutoffEnabled,
                            entryCutoffSeconds: settingsSnapshot.entryCutoffSeconds,
                            limitEntry,
                            evaluationMode: effectiveExitMode,
                        });

                        const exitResultMap = new Map(exitResults.map((r) => [r.trade, r]));
                        const annotatedTrades = result.trades.map((trade) => {
                            const exitResult = exitResultMap.get(trade);
                            if (!exitResult) return { ...trade, polymarketOutcome: null };
                            return { ...trade, polymarketOutcome: buildTradeAnnotationFromSignalExitResult(exitResult, effectiveExitMode) };
                        });

                        finalResult = {
                            ...result,
                            trades: annotatedTrades,
                            polymarketTradeSummary: buildSignalExitPolymarketTradeSummary({
                                seriesId,
                                outcomeSymbol: resolvedOutcomeSymbol,
                                outcomeInterval,
                                outcomeRowsLoaded: outcomes.length,
                                summary: exitSummary,
                                evaluationMode: effectiveExitMode,
                            }),
                        };
                    } catch (error) {
                        debugLogger.warn(`${caller}.polymarket_signal_exit_annotation_failed`, {
                            error: error instanceof Error ? error.message : String(error),
                        });
                        usedFallback = true;
                        finalResult = result;
                    }
                } else {
                    const selectedOffset = interval === "1m" && outcomeInterval === "5m"
                        && !isActualPolymarketEntryMinuteMode(entrySelectionMode)
                        ? (existingSummary?.entryOffset ?? settingsSnapshot.entryOffset ?? 0)
                        : undefined;

                    let limitEntryPricePoints: Awaited<ReturnType<typeof ensurePricePointsForOutcomes>> | undefined;
                    if (limitEntry) {
                        try {
                            usedPricePointEnsure = true;
                            limitEntryPricePoints = await ensurePricePointsForOutcomes(outcomes, seriesId);
                            pricePointsLoaded = limitEntryPricePoints.length;
                        } catch {
                            limitEntryPricePoints = [];
                            usedFallback = true;
                        }
                    }

                    const annotatedTrades = annotateTradesWithPolymarketOutcomesForRun(
                        result.trades,
                        outcomes,
                        interval,
                        selectedOffset,
                        entrySelectionMode ?? "fixed_offset",
                        {
                            outcomeInterval,
                            pricePoints: limitEntryPricePoints,
                            entryPriceFilterCents: settingsSnapshot.entryPriceFilterCents,
                            backtestSlippageCents: settingsSnapshot.backtestSlippageCents,
                            entryCutoffEnabled: settingsSnapshot.entryCutoffEnabled,
                            entryCutoffSeconds: settingsSnapshot.entryCutoffSeconds,
                            limitEntry,
                        }
                    );

                    const summary = summarizePolymarketTradesForRun({
                        trades: annotatedTrades,
                        outcomes,
                        interval,
                        selectedOffset,
                        entrySelectionMode,
                        timingProfile: existingSummary?.timingProfile,
                        outcomeInterval,
                        backtestSlippageCents: settingsSnapshot.backtestSlippageCents,
                        limitEntry,
                    });

                    const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;

                    finalResult = {
                        ...result,
                        trades: annotatedTrades,
                        polymarketTradeSummary: {
                            seriesId,
                            outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
                            outcomeInterval,
                            outcomeRowsLoaded: outcomes.length,
                            scoredTrades: existingSummary?.scoredTrades ?? summary.scoredTrades,
                            missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? summary.missingOutcomeTrades,
                            unscoredTrades: existingSummary?.unscoredTrades ?? summary.unscoredTrades ?? Math.max(0, totalTrades - summary.scoredTrades),
                            duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored ?? summary.duplicateTradesIgnored,
                            entryPriceFilteredTrades: existingSummary?.entryPriceFilteredTrades ?? summary.entryPriceFilteredTrades,
                            entryTimeFilteredTrades: existingSummary?.entryTimeFilteredTrades ?? summary.entryTimeFilteredTrades,
                            entrySelectionMode: existingSummary?.entrySelectionMode ?? summary.entrySelectionMode,
                            entryOffset: existingSummary?.entryOffset ?? summary.entryOffset,
                            timingProfile: existingSummary?.timingProfile ?? summary.timingProfile,
                            evaluationMode: "resolve_hold",
                            backtestSlippageCents: existingSummary?.backtestSlippageCents ?? summary.backtestSlippageCents,
                            targetExitedTrades: existingSummary?.targetExitedTrades ?? summary.targetExitedTrades,
                            limitEntryEnabled: existingSummary?.limitEntryEnabled ?? summary.limitEntryEnabled,
                            limitEntryMode: existingSummary?.limitEntryMode ?? summary.limitEntryMode,
                            limitEntryPriceCents: existingSummary?.limitEntryPriceCents ?? summary.limitEntryPriceCents,
                            limitEntryOffsetCents: existingSummary?.limitEntryOffsetCents ?? summary.limitEntryOffsetCents,
                            limitEntryAttempts: existingSummary?.limitEntryAttempts ?? summary.limitEntryAttempts,
                            limitEntryFilledTrades: existingSummary?.limitEntryFilledTrades ?? summary.limitEntryFilledTrades,
                            limitEntryMissedTrades: existingSummary?.limitEntryMissedTrades ?? summary.limitEntryMissedTrades,
                            limitEntryNotTouchedTrades: existingSummary?.limitEntryNotTouchedTrades ?? summary.limitEntryNotTouchedTrades,
                            limitEntryLastMinuteOnlyTrades: existingSummary?.limitEntryLastMinuteOnlyTrades ?? summary.limitEntryLastMinuteOnlyTrades,
                            limitEntryMissingPriceTrades: existingSummary?.limitEntryMissingPriceTrades ?? summary.limitEntryMissingPriceTrades,
                            limitEntryInvalidWindowTrades: existingSummary?.limitEntryInvalidWindowTrades ?? summary.limitEntryInvalidWindowTrades,
                            limitEntryFillRate: existingSummary?.limitEntryFillRate ?? summary.limitEntryFillRate,
                            avgLimitEntryWaitSec: existingSummary?.avgLimitEntryWaitSec ?? summary.avgLimitEntryWaitSec,
                            avgLimitEntryImprovement: existingSummary?.avgLimitEntryImprovement ?? summary.avgLimitEntryImprovement,
                            limitExitEnabled: existingSummary?.limitExitEnabled ?? summary.limitExitEnabled,
                            limitExitMode: existingSummary?.limitExitMode ?? summary.limitExitMode,
                            limitExitPriceCents: existingSummary?.limitExitPriceCents ?? summary.limitExitPriceCents,
                            limitExitOffsetCents: existingSummary?.limitExitOffsetCents ?? summary.limitExitOffsetCents,
                            limitExitFilledTrades: existingSummary?.limitExitFilledTrades ?? summary.limitExitFilledTrades,
                            limitExitFallbackTrades: existingSummary?.limitExitFallbackTrades ?? summary.limitExitFallbackTrades,
                            limitExitUnreachableTrades: existingSummary?.limitExitUnreachableTrades ?? summary.limitExitUnreachableTrades,
                        },
                    };
                }
            }
        }
    }

    const durationMs = performance.now() - startTime;
    return {
        result: finalResult,
        outcomesLoaded: outcomesLoadedCount,
        pricePointsLoaded,
        effectiveExitMode,
        usedSecondMarket: isSecondMarketRun || usedSecondMarketVar,
        usedPricePointEnsure,
        usedFallback,
        durationMs,
    };
}
