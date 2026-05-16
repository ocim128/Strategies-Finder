import { state } from "../state";
import { debugLogger } from "../debug-logger";
import type { BacktestResult, ExpectancyBreakdownRow, ExpectancyBreakdownSection, Trade } from "../strategies/index";
import type { Time } from "lightweight-charts";
import {
    getEffectivePolymarketSeriesId,
    isSupportedPolymarketOutcomeRun,
    loadPolymarketOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
} from "../polymarket-btc5m";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    filterTradesByPreviousClosedTradeExitReason,
    summarizePolymarketTradesForRun,
} from "../polymarket-trade-annotations";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode } from "../polymarket-exit-mode";
import {
    buildSignalExitPolymarketTradeSummary,
    evaluateSignalExitTrades,
    buildTradeAnnotationFromSignalExitResult,
    indexSignalExitOutcomesForTrades,
} from "../polymarket-signal-exit-evaluator";
import { ensurePricePointsForOutcomes } from "../polymarket-price-points-ingest";
import { resolveBacktestResultMarketContext } from "../backtest-result-context";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { resolvePolymarketDomSettings } from "../polymarket-dom-reader";
import { getPolymarketOutcomeIntervalDurationSec, resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import {
    annotateBacktestResultWithSecondMarketClob,
    isSecondMarketPolymarketSupported,
} from "../second-market/evaluation";
import {
    hasFilteredPolymarketTrades,
    isActualPolymarketEntryMinuteMode,
    resolvePolymarketEntrySelectionModeForDisplay,
    type PolymarketEntrySelectionMode,
} from "../polymarket-entry-selection-mode";
import {
    getChartWrapper,
    getQuickViewBtn,
    getQvStatsContent,
    getQvEmpty,
    getQvTradesList,
    getQvTradesCount,
    getQvSortLabel,
    QV_IDS,
} from "./quick-view-dom";
import {
    buildShell,
    renderResultsHtml,
    renderTradeChunkHtml,
    renderTradesLimitNoticeHtml,
    renderEmptyTradesHtml,
    buildPolymarketSectionHtml,
} from "./quick-view-renderer";
import type { TradeSizingMode } from "../types/backtest";
import { applyPolymarketAlternativeSizing } from "../polymarket-alternative-sizing";
import { getAlternativeSizingEnabled, getBacktestSettings, getCapitalSettings } from "../backtest-settings-reader";


export type QuickViewPolymarketSummary = {
    wins: number;
    losses: number;
    neutralTrades: number;
    scoredTrades: number;
    missingTrades: number;
    unscoredTrades: number;
    duplicateTradesIgnored?: number;
    entryPriceFilteredTrades?: number;
    coverage: number;
    winRate: number;
    expectancy: number | null;
    profitFactor: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    avgEntryPrice: number | null;
    outcomeRowsLoaded: number;
    bestBaselineWinRate: number;
    baselineDelta: number;
    longestWinStreak: number;
    longestLossStreak: number;
    recentFormTrades: number;
    recentFormWins: number;
    recentFormLosses: number;
    recentFormFlats: number;
    recentFormWinRate: number;
    exitReasonWinRates: QuickViewPolymarketExitReasonWinRates;
    afterTakeProfitExpectancy: {
        pricedTrades: number;
        expectancy: number | null;
    };
    entrySelectionMode?: PolymarketEntrySelectionMode;
    entryOffset?: number;
    outcomeInterval?: PolymarketOutcomeInterval;
    timingProfile?: import("../types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry[];
    bestTimingProfile?: import("../types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry | null;
    evaluationMode?: "resolve_hold" | "signal_exit_same_event";
    missingPriceTrades?: number;
    targetExitedTrades?: number;
    signalExitedTrades?: number;
    resolvedTrades?: number;
    limitEntryEnabled?: boolean;
    limitEntryMode?: import("../polymarket-post-signal-limit-entry").PolymarketLimitEntryPriceMode;
    limitEntryPriceCents?: number;
    limitEntryOffsetCents?: number;
    limitEntryAttempts?: number;
    limitEntryFilledTrades?: number;
    limitEntryMissedTrades?: number;
    limitEntryNotTouchedTrades?: number;
    limitEntryLastMinuteOnlyTrades?: number;
    limitEntryMissingPriceTrades?: number;
    limitEntryFillRate?: number;
    avgLimitEntryWaitSec?: number;
    avgLimitEntryImprovement?: number;
    limitExitEnabled?: boolean;
    limitExitMode?: import("../polymarket-post-signal-limit-entry").PolymarketLimitExitPriceMode;
    limitExitPriceCents?: number;
    limitExitOffsetCents?: number;
    limitExitFilledTrades?: number;
    limitExitFallbackTrades?: number;
    limitExitUnreachableTrades?: number;
    sizedSizingMode?: TradeSizingMode;
    sizedInitialCapital?: number;
    sizedFinalEquity?: number;
    sizedNetProfit?: number;
    sizedNetProfitPercent?: number;
    sizedProfitFactor?: number;
    sizedExpectancy?: number;
    sizedMaxDrawdownPercent?: number;
    sizedTrades?: number;
    sizedSkippedTrades?: number;
    sizedNoCapitalTrades?: number;
    sizedCappedTrades?: number;
    sizedAvgStake?: number;
    sizedMaxStake?: number;
};

export type QuickViewPolymarketPayoutSummary = {
    pricedTrades: number;
    unpricedScoredTrades: number;
    winRate: number;
    expectancy: number;
    profitFactor: number | null;
    avgWin: number;
    avgLoss: number;
    avgEntryPrice: number;
    breakEvenWinRate: number;
    edgeVsBreakEven: number;
};

export type QuickViewPolymarketExecutionGap = {
    pricedTrades: number;
    unpricedScoredTrades: number;
    polymarketWinRate: number;
    polymarketExpectancy: number;
    avgEntryPrice: number;
    breakEvenWinRate: number;
    realizedWinRate: number;
    realizedExpectancy: number;
};

export type QuickViewPolymarketExitReasonSummary = {
    trades: number;
    wins: number;
    losses: number;
    neutralTrades: number;
    winRate: number;
};

export type QuickViewPolymarketExpectancySummary = {
    pricedTrades: number;
    expectancy: number | null;
};

export type QuickViewPolymarketExitReasonWinRates = {
    maxHold: QuickViewPolymarketExitReasonSummary;
    takeProfit: QuickViewPolymarketExitReasonSummary;
    signal: QuickViewPolymarketExitReasonSummary;
};

type PolymarketTradeOutcomeState = "positive" | "negative" | "neutral" | null;

export function summarizePolymarketStreaks(trades: Trade[]): {
    longestWinStreak: number;
    longestLossStreak: number;
} {
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let longestWinStreak = 0;
    let longestLossStreak = 0;

    for (const trade of trades) {
        const outcomeState = getPolymarketTradeOutcomeState(trade);
        if (outcomeState === "positive") {
            currentWinStreak++;
            currentLossStreak = 0;
            longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
            continue;
        }

        if (outcomeState === "negative") {
            currentLossStreak++;
            currentWinStreak = 0;
            longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
            continue;
        }

        currentWinStreak = 0;
        currentLossStreak = 0;
    }

    return {
        longestWinStreak,
        longestLossStreak,
    };
}

function buildPolymarketWinRateSummary(trades: readonly Trade[]): QuickViewPolymarketExitReasonSummary {
    const outcomeStates = trades
        .map((trade) => getPolymarketTradeOutcomeState(trade))
        .filter((state): state is NonNullable<PolymarketTradeOutcomeState> => state !== null);
    const wins = outcomeStates.filter((state) => state === "positive").length;
    const losses = outcomeStates.filter((state) => state === "negative").length;
    const neutralTrades = outcomeStates.filter((state) => state === "neutral").length;
    const tradeCount = outcomeStates.length;

    return {
        trades: tradeCount,
        wins,
        losses,
        neutralTrades,
        winRate: tradeCount > 0 ? wins / tradeCount : 0,
    };
}

export function summarizeRecentPolymarketForm(
    trades: Trade[],
    windowSize = 20
): {
    recentFormTrades: number;
    recentFormWins: number;
    recentFormLosses: number;
    recentFormFlats: number;
    recentFormWinRate: number;
} {
    const scoredTrades = trades.filter((trade) => getPolymarketTradeOutcomeState(trade) !== null);
    const recentTrades = scoredTrades.slice(-Math.max(0, windowSize));
    const recentFormStates = recentTrades
        .map((trade) => getPolymarketTradeOutcomeState(trade))
        .filter((state): state is NonNullable<PolymarketTradeOutcomeState> => state !== null);
    const recentFormWins = recentFormStates.filter((state) => state === "positive").length;
    const recentFormLosses = recentFormStates.filter((state) => state === "negative").length;
    const recentFormFlats = recentFormStates.filter((state) => state === "neutral").length;
    const recentFormTrades = recentFormStates.length;

    return {
        recentFormTrades,
        recentFormWins,
        recentFormLosses,
        recentFormFlats,
        recentFormWinRate: recentFormTrades > 0 ? recentFormWins / recentFormTrades : 0,
    };
}

export function summarizePolymarketExitReasonWinRates(
    trades: readonly Trade[]
): QuickViewPolymarketExitReasonWinRates {
    return {
        maxHold: buildPolymarketWinRateSummary(filterTradesByPreviousClosedTradeExitReason(trades, "time_stop")),
        takeProfit: buildPolymarketWinRateSummary(filterTradesByPreviousClosedTradeExitReason(trades, "take_profit")),
        signal: buildPolymarketWinRateSummary(filterTradesByPreviousClosedTradeExitReason(trades, "signal")),
    };
}

export function summarizePolymarketExpectancyAfterTakeProfit(
    trades: readonly Trade[]
): QuickViewPolymarketExpectancySummary {
    const afterTakeProfitTrades = filterTradesByPreviousClosedTradeExitReason(trades, "take_profit");
    const pricedTrades = getPolymarketPricedTrades(afterTakeProfitTrades);
    if (pricedTrades.length === 0) {
        return {
            pricedTrades: 0,
            expectancy: null,
        };
    }

    const summaryRow = buildPolymarketExpectancyRow("After TP", pricedTrades);
    return {
        pricedTrades: summaryRow.tradeCount,
        expectancy: summaryRow.expectancy,
    };
}

export function computePolymarketBestBaselineWinRate(trades: Trade[]): number {
    const scoredTrades = getScoredPolymarketTrades(trades);
    if (scoredTrades.length === 0) {
        return 0;
    }

    const alwaysYesWins = scoredTrades.filter((trade) => trade.polymarketOutcome?.actualOutcomeUp === 1).length;
    const alwaysYesWinRate = alwaysYesWins / scoredTrades.length;
    const alwaysNoWinRate = 1 - alwaysYesWinRate;
    return Math.max(alwaysYesWinRate, alwaysNoWinRate);
}

export function countDistinctPolymarketOutcomeRows(trades: Trade[]): number {
    const distinctEventStartTs = new Set<number>();
    for (const trade of trades) {
        const eventStartTs = trade.polymarketOutcome?.eventStartTs;
        if (typeof eventStartTs === "number" && Number.isFinite(eventStartTs) && eventStartTs > 0) {
            distinctEventStartTs.add(eventStartTs);
        }
    }
    return distinctEventStartTs.size;
}

export function getQuickViewDiagnosticSections(result: BacktestResult): ExpectancyBreakdownSection[] {
    const polymarketTrades = getPolymarketPricedTrades(result.trades);
    if (polymarketTrades.length > 0) {
        return buildPolymarketDiagnosticSections(result, polymarketTrades);
    }

    const sections = result.expectancyBreakdown?.sections ?? [];
    return sections.filter((section) => (
        section.id === "session_minute" || section.id === "price_range_position"
    ));
}

function resolvePolymarketSelectedEntryOffset(result: BacktestResult, _trades: readonly Trade[]): number | null {
    const summaryOffset = result.polymarketTradeSummary?.entryOffset;
    if (typeof summaryOffset === "number" && Number.isFinite(summaryOffset)) {
        return Math.max(0, Math.floor(summaryOffset));
    }
    return null;
}

function resolvePolymarketSummaryEntrySelectionMode(result: BacktestResult): PolymarketEntrySelectionMode | undefined {
    return result.polymarketTradeSummary?.entrySelectionMode;
}

function getPolymarketPricedTrades(trades: readonly Trade[]): Trade[] {
    return trades.filter((trade) => getPolymarketTradePayout(trade) !== null);
}

function getScoredPolymarketTrades(trades: readonly Trade[]): Trade[] {
    return trades.filter((trade) => (
        trade.polymarketOutcome !== null
        && trade.polymarketOutcome !== undefined
        && trade.polymarketOutcome.marketExitSource !== "duplicate"
        && trade.polymarketOutcome.marketExitSource !== "filtered"
        && trade.polymarketOutcome.marketExitSource !== "entry_price_filtered"
        && trade.polymarketOutcome.marketExitSource !== "no_event"
        && trade.polymarketOutcome.marketExitSource !== "missing"
    ));
}

function inferPolymarketSummaryCounts(
    trades: readonly Trade[],
    totalTrades: number
): {
    scoredTrades: number;
    missingOutcomeTrades: number;
    unscoredTrades: number;
    duplicateTradesIgnored?: number;
    entryPriceFilteredTrades?: number;
} {
    const scoredTrades = getScoredPolymarketTrades(trades).length;
    const hasSignalExitAnnotations = trades.some((trade) => trade.polymarketOutcome?.evaluationMode === "signal_exit_same_event");
    const duplicateTradesIgnored = hasSignalExitAnnotations
        ? trades.filter((trade) => trade.polymarketOutcome?.marketExitSource === "duplicate").length
        : 0;
    const entryPriceFilteredTrades = trades.filter(
        (trade) => trade.polymarketOutcome?.marketExitSource === "entry_price_filtered"
    ).length;
    const missingOutcomeTrades = hasSignalExitAnnotations
        ? trades.filter((trade) => trade.polymarketOutcome?.marketExitSource === "no_event").length
        : Math.max(0, totalTrades - scoredTrades - entryPriceFilteredTrades);

    return {
        scoredTrades,
        missingOutcomeTrades,
        unscoredTrades: Math.max(0, totalTrades - scoredTrades),
        duplicateTradesIgnored: duplicateTradesIgnored > 0 ? duplicateTradesIgnored : undefined,
        entryPriceFilteredTrades: entryPriceFilteredTrades > 0 ? entryPriceFilteredTrades : undefined,
    };
}

function getPolymarketTradePayout(trade: Trade): number | null {
    const outcome = trade.polymarketOutcome;
    if (!outcome) {
        return null;
    }

    if (typeof outcome.marketPnl === "number" && Number.isFinite(outcome.marketPnl)) {
        return outcome.marketPnl;
    }

    if (outcome.evaluationMode === "signal_exit_same_event") {
        if (
            typeof outcome.marketExitPrice === "number" && Number.isFinite(outcome.marketExitPrice)
            && typeof outcome.marketEntryPrice === "number" && Number.isFinite(outcome.marketEntryPrice)
        ) {
            return outcome.marketExitPrice - outcome.marketEntryPrice;
        }
        return null;
    }

    const price = outcome.marketEntryPrice;
    const isWin = outcome.isWin;
    if (typeof price !== "number" || !Number.isFinite(price) || typeof isWin !== "boolean") {
        return null;
    }
    return isWin ? (1 - price) : -price;
}

function getPolymarketTradeOutcomeState(trade: Trade): PolymarketTradeOutcomeState {
    const payout = getPolymarketTradePayout(trade);
    if (payout === null) {
        return null;
    }
    if (payout > 0) {
        return "positive";
    }
    if (payout < 0) {
        return "negative";
    }
    return "neutral";
}

function average(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildPolymarketExpectancyRow(label: string, trades: readonly Trade[]): ExpectancyBreakdownRow {
    const payouts = trades
        .map((trade) => getPolymarketTradePayout(trade))
        .filter((value): value is number => value !== null);
    const entryPrices = trades
        .map((trade) => trade.polymarketOutcome?.marketEntryPrice)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const winningPayouts = payouts.filter((value) => value > 0);
    const losingPayouts = payouts.filter((value) => value < 0);
    const totalProfit = winningPayouts.reduce((sum, value) => sum + value, 0);
    const totalLoss = Math.abs(losingPayouts.reduce((sum, value) => sum + value, 0));
    const netProfit = payouts.reduce((sum, value) => sum + value, 0);
    const tradeCount = payouts.length;
    const avgEntryPrice = entryPrices.length > 0 ? average(entryPrices) : 0;
    const breakEvenWinRate = avgEntryPrice * 100;
    const winRate = tradeCount > 0 ? (winningPayouts.length / tradeCount) * 100 : 0;

    return {
        label,
        tradeCount,
        winRate,
        netProfit,
        expectancy: tradeCount > 0 ? netProfit / tradeCount : 0,
        avgWin: winningPayouts.length > 0 ? totalProfit / winningPayouts.length : 0,
        avgLoss: losingPayouts.length > 0 ? totalLoss / losingPayouts.length : 0,
        profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0,
        avgEntryPrice,
        breakEvenWinRate,
        edgeVsBreakEven: winRate - breakEvenWinRate,
    };
}

function buildPolymarketDiagnosticSections(result: BacktestResult, trades: readonly Trade[]): ExpectancyBreakdownSection[] {
    const outcomeInterval = resolvePolymarketOutcomeInterval(result.polymarketTradeSummary?.outcomeInterval);
    const durationMinutes = Math.max(1, Math.round(getPolymarketOutcomeIntervalDurationSec(outcomeInterval) / 60));
    const minuteBuckets = Array.from({ length: durationMinutes }, (_, minute) => ({
        label: `Minute ${minute}`,
        trades: [] as Trade[],
    }));
    const rangeBuckets: Array<{ label: string; min: number; max: number; trades: Trade[] }> = [
        { label: "0-20%", min: 0, max: 0.2, trades: [] },
        { label: "20-40%", min: 0.2, max: 0.4, trades: [] },
        { label: "40-60%", min: 0.4, max: 0.6, trades: [] },
        { label: "60-80%", min: 0.6, max: 0.8, trades: [] },
        { label: "80-100%", min: 0.8, max: 1.0000001, trades: [] },
    ];

    for (const trade of trades) {
        const entryOffset = typeof trade.polymarketOutcome?.entryOffset === "number" && Number.isFinite(trade.polymarketOutcome.entryOffset)
            ? Math.max(0, Math.floor(Number(trade.polymarketOutcome.entryOffset)))
            : null;
        if (entryOffset !== null) {
            minuteBuckets[entryOffset]?.trades.push(trade);
        } else if (outcomeInterval === "5m") {
            const entryTs = parseTimeToUnixSeconds(trade.entryTime);
            if (entryTs !== null) {
                const minuteOffset = Math.floor((((entryTs % 300) + 300) % 300) / 60);
                minuteBuckets[minuteOffset]?.trades.push(trade);
            }
        }

        const rangePosition = null;
        if (typeof rangePosition === "number" && Number.isFinite(rangePosition)) {
            const clamped = Math.max(0, Math.min(1, rangePosition));
            rangeBuckets.find((bucket) => clamped >= bucket.min && clamped < bucket.max)?.trades.push(trade);
        }
    }

    const sections: ExpectancyBreakdownSection[] = [];
    const minuteRows = minuteBuckets
        .filter((bucket) => bucket.trades.length > 0)
        .map((bucket) => buildPolymarketExpectancyRow(bucket.label, bucket.trades));
    const selectedEntryOffset = resolvePolymarketSelectedEntryOffset(result, trades);
    const entrySelectionMode = resolvePolymarketSummaryEntrySelectionMode(result);
    if (minuteRows.length > 0) {
        const sessionLabel = outcomeInterval === "5m" ? "5m" : outcomeInterval;
        sections.push({
            id: "session_minute",
            title: minuteRows.length === 1
                ? (selectedEntryOffset !== null
                    ? `Selected ${sessionLabel} Session Minute`
                    : (entrySelectionMode === "actual_entry_minute" ? `Observed ${sessionLabel} Session Minute (Auto)` : `Observed ${sessionLabel} Session Minute`))
                : `By ${sessionLabel} Session Minute`,
            hint: minuteRows.length === 1
                ? (selectedEntryOffset !== null
                    ? `This run is filtered to minute ${selectedEntryOffset} inside each ${sessionLabel} event, so this shows the scored subset for that selected offset only. Exp is shown in cents per $1 share.`
                    : (entrySelectionMode === "actual_entry_minute"
                        ? `Auto mode scores the first eligible trade in each ${sessionLabel} event and prices it at that trade's actual minute. Exp is shown in cents per $1 share.`
                        : `This run uses native ${sessionLabel} Polymarket session scoring. Exp is shown in cents per $1 share.`))
                : `This shows Polymarket payout expectancy by minute inside each ${sessionLabel} event. Exp is shown in cents per $1 share.`,
            rows: minuteRows,
        });
    }

    const rangeRows = rangeBuckets
        .filter((bucket) => bucket.trades.length > 0)
        .map((bucket) => buildPolymarketExpectancyRow(bucket.label, bucket.trades));
    if (rangeRows.length > 0) {
        sections.push({
            id: "price_range_position",
            title: "By Entry Range Position",
            hint: "Higher buckets mean the entry fired closer to the top of the recent Binance range. Exp is Polymarket payout expectancy in cents per $1 share.",
            rows: rangeRows,
        });
    }

    return sections;
}

export function summarizePolymarketPayoutDiagnostics(trades: Trade[]): QuickViewPolymarketPayoutSummary | null {
    const scoredTrades = getScoredPolymarketTrades(trades);
    const pricedTrades = getPolymarketPricedTrades(trades);
    if (pricedTrades.length === 0) {
        return null;
    }

    const summaryRow = buildPolymarketExpectancyRow("All", pricedTrades);
    return {
        pricedTrades: summaryRow.tradeCount,
        unpricedScoredTrades: Math.max(0, scoredTrades.length - pricedTrades.length),
        winRate: summaryRow.winRate / 100,
        expectancy: summaryRow.expectancy,
        profitFactor: summaryRow.profitFactor,
        avgWin: summaryRow.avgWin,
        avgLoss: summaryRow.avgLoss,
        avgEntryPrice: summaryRow.avgEntryPrice ?? 0,
        breakEvenWinRate: (summaryRow.breakEvenWinRate ?? 0) / 100,
        edgeVsBreakEven: (summaryRow.edgeVsBreakEven ?? 0) / 100,
    };
}

export function summarizePolymarketExecutionGap(trades: Trade[]): QuickViewPolymarketExecutionGap | null {
    const scoredTrades = getScoredPolymarketTrades(trades);
    const pricedTrades = getPolymarketPricedTrades(trades);
    if (pricedTrades.length === 0) {
        return null;
    }

    const summaryRow = buildPolymarketExpectancyRow("All", pricedTrades);
    const realizedWins = pricedTrades.filter((trade) => trade.pnl > 0).length;
    const netPnl = pricedTrades.reduce((sum, trade) => sum + trade.pnl, 0);

    return {
        pricedTrades: summaryRow.tradeCount,
        unpricedScoredTrades: Math.max(0, scoredTrades.length - pricedTrades.length),
        polymarketWinRate: summaryRow.winRate / 100,
        polymarketExpectancy: summaryRow.expectancy,
        avgEntryPrice: (summaryRow.avgEntryPrice ?? 0),
        breakEvenWinRate: (summaryRow.breakEvenWinRate ?? 0) / 100,
        realizedWinRate: realizedWins / pricedTrades.length,
        realizedExpectancy: netPnl / pricedTrades.length,
    };
}

function summarizePolymarketPerformanceForResult(
    result: BacktestResult
): { expectancy: number; profitFactor: number | null } | null {
    const payoutSummary = summarizePolymarketPayoutDiagnostics(result.trades);
    if (payoutSummary) {
        return {
            expectancy: payoutSummary.expectancy,
            profitFactor: payoutSummary.profitFactor,
        };
    }

    const summary = result.polymarketTradeSummary;
    if (!summary || summary.scoredTrades <= 0 || typeof summary.expectancy !== "number" || !Number.isFinite(summary.expectancy)) {
        return null;
    }

    return {
        expectancy: summary.expectancy,
        profitFactor: typeof summary.profitFactor === "number" && Number.isFinite(summary.profitFactor)
            ? summary.profitFactor
            : null,
    };
}

class QuickViewManager {
    private static readonly MAX_RENDERED_TRADES = 100;
    private static readonly INITIAL_TRADE_BATCH_SIZE = 40;
    private static readonly DEFERRED_TRADE_BATCH_SIZE = 80;

    private overlay: HTMLElement | null = null;
    private enabled = true;
    private visible = false;
    private jumpToTrade: ((time: Time) => void) | null = null;
    private sortNewestFirst = true;
    private currentTrades: Trade[] = [];
    private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
    private tradeRenderGeneration = 0;
    private pendingDeferredRenderIds: number[] = [];
    private overlayRenderGeneration = 0;

    init() {
        this.injectOverlay();
        this.bindToolbarButton();
        this.bindKeyboard();
    }

    private injectOverlay() {
        const chartWrapper = getChartWrapper();
        if (!chartWrapper) return;

        const el = document.createElement('div');
        el.className = 'quick-view-overlay';
        el.id = QV_IDS.overlay;
        el.innerHTML = buildShell();
        chartWrapper.appendChild(el);
        this.overlay = el;

        el.querySelector('#' + QV_IDS.closeBtn)?.addEventListener('click', () => this.hide());

        el.querySelector('#' + QV_IDS.sortToggle)?.addEventListener('click', () => {
            this.sortNewestFirst = !this.sortNewestFirst;
            this.renderTrades(this.currentTrades);
        });

        const tradesList = el.querySelector<HTMLElement>('#' + QV_IDS.tradesList);
        tradesList?.addEventListener('click', (event) => {
            this.handleTradeItemActivation(event.target, tradesList);
        });
        tradesList?.addEventListener('keydown', (event) => {
            if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) {
                return;
            }

            event.preventDefault();
            this.handleTradeItemActivation(event.target, tradesList);
        });
    }

    private bindToolbarButton() {
        const btn = getQuickViewBtn();
        if (!btn) return;

        btn.classList.toggle('qv-active', this.enabled);

        btn.addEventListener('click', () => {
            if (this.visible) {
                this.hide();
            } else {
                if (state.currentBacktestResult) {
                    this.show(state.currentBacktestResult);
                } else {
                    this.enabled = !this.enabled;
                    btn.classList.toggle('qv-active', this.enabled);
                }
            }
        });
    }

    private bindKeyboard() {
        this.keyboardHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.visible) {
                e.preventDefault();
                e.stopPropagation();
                this.hide();
            }
        };

        window.addEventListener('keydown', this.keyboardHandler);
    }

    private withPolymarketTradeSummary(
        result: BacktestResult,
        trades: Trade[],
        seriesId: string | null,
        options: {
            outcomeRowsLoaded?: number;
            selectedOffset?: number;
            entrySelectionMode?: PolymarketEntrySelectionMode;
            outcomeSymbol?: string;
            outcomeInterval?: PolymarketOutcomeInterval;
            missingOutcomeTrades?: number;
            unscoredTrades?: number;
            summary?: ReturnType<typeof summarizePolymarketTradesForRun>;
        } = {}
    ): BacktestResult {
        const totalTrades = result.totalTrades > 0 ? result.totalTrades : trades.length;
        const fallbackOutcomeRowsLoaded = options.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(trades);
        const existingSummary = result.polymarketTradeSummary;
        const inferredCounts = inferPolymarketSummaryCounts(trades, totalTrades);
        const preserveSizedSummary = !options.summary;

        return {
            ...result,
            trades,
            polymarketTradeSummary: {
                seriesId: existingSummary?.seriesId || seriesId || "",
                outcomeSymbol: existingSummary?.outcomeSymbol ?? options.outcomeSymbol,
                outcomeInterval: existingSummary?.outcomeInterval ?? options.outcomeInterval,
                outcomeRowsLoaded: existingSummary?.outcomeRowsLoaded && existingSummary.outcomeRowsLoaded > 0
                    ? existingSummary.outcomeRowsLoaded
                    : fallbackOutcomeRowsLoaded,
                scoredTrades: existingSummary?.scoredTrades ?? inferredCounts.scoredTrades,
                missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? options.missingOutcomeTrades ?? inferredCounts.missingOutcomeTrades,
                unscoredTrades: existingSummary?.unscoredTrades ?? options.unscoredTrades ?? inferredCounts.unscoredTrades,
                duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored ?? inferredCounts.duplicateTradesIgnored,
                entryPriceFilteredTrades: existingSummary?.entryPriceFilteredTrades ?? options.summary?.entryPriceFilteredTrades ?? inferredCounts.entryPriceFilteredTrades,
                entrySelectionMode: existingSummary?.entrySelectionMode ?? options.entrySelectionMode,
                entryOffset: existingSummary?.entryOffset ?? options.selectedOffset,
                timingProfile: existingSummary?.timingProfile,
                evaluationMode: existingSummary?.evaluationMode,
                signalExitAllowMultipleTradesPerEvent: existingSummary?.signalExitAllowMultipleTradesPerEvent,
                profitableTrades: existingSummary?.profitableTrades,
                losingTrades: existingSummary?.losingTrades,
                neutralTrades: existingSummary?.neutralTrades,
                targetExitedTrades: existingSummary?.targetExitedTrades ?? options.summary?.targetExitedTrades,
                signalExitedTrades: existingSummary?.signalExitedTrades,
                resolvedTrades: existingSummary?.resolvedTrades,
                missingPriceTrades: existingSummary?.missingPriceTrades,
                netPnl: existingSummary?.netPnl,
                grossProfit: existingSummary?.grossProfit,
                grossLoss: existingSummary?.grossLoss,
                profitFactor: existingSummary?.profitFactor,
                expectancy: existingSummary?.expectancy,
                avgEntryPrice: existingSummary?.avgEntryPrice,
                avgExitPrice: existingSummary?.avgExitPrice,
                limitEntryEnabled: existingSummary?.limitEntryEnabled ?? options.summary?.limitEntryEnabled,
                limitEntryMode: existingSummary?.limitEntryMode ?? options.summary?.limitEntryMode,
                limitEntryPriceCents: existingSummary?.limitEntryPriceCents ?? options.summary?.limitEntryPriceCents,
                limitEntryOffsetCents: existingSummary?.limitEntryOffsetCents ?? options.summary?.limitEntryOffsetCents,
                limitEntryAttempts: existingSummary?.limitEntryAttempts ?? options.summary?.limitEntryAttempts,
                limitEntryFilledTrades: existingSummary?.limitEntryFilledTrades ?? options.summary?.limitEntryFilledTrades,
                limitEntryMissedTrades: existingSummary?.limitEntryMissedTrades ?? options.summary?.limitEntryMissedTrades,
                limitEntryNotTouchedTrades: existingSummary?.limitEntryNotTouchedTrades ?? options.summary?.limitEntryNotTouchedTrades,
                limitEntryLastMinuteOnlyTrades: existingSummary?.limitEntryLastMinuteOnlyTrades ?? options.summary?.limitEntryLastMinuteOnlyTrades,
                limitEntryMissingPriceTrades: existingSummary?.limitEntryMissingPriceTrades ?? options.summary?.limitEntryMissingPriceTrades,
                limitEntryInvalidWindowTrades: existingSummary?.limitEntryInvalidWindowTrades ?? options.summary?.limitEntryInvalidWindowTrades,
                limitEntryFillRate: existingSummary?.limitEntryFillRate ?? options.summary?.limitEntryFillRate,
                avgLimitEntryWaitSec: existingSummary?.avgLimitEntryWaitSec ?? options.summary?.avgLimitEntryWaitSec,
                avgLimitEntryImprovement: existingSummary?.avgLimitEntryImprovement ?? options.summary?.avgLimitEntryImprovement,
                limitExitEnabled: existingSummary?.limitExitEnabled ?? options.summary?.limitExitEnabled,
                limitExitMode: existingSummary?.limitExitMode ?? options.summary?.limitExitMode,
                limitExitPriceCents: existingSummary?.limitExitPriceCents ?? options.summary?.limitExitPriceCents,
                limitExitOffsetCents: existingSummary?.limitExitOffsetCents ?? options.summary?.limitExitOffsetCents,
                limitExitFilledTrades: existingSummary?.limitExitFilledTrades ?? options.summary?.limitExitFilledTrades,
                limitExitFallbackTrades: existingSummary?.limitExitFallbackTrades ?? options.summary?.limitExitFallbackTrades,
                limitExitUnreachableTrades: existingSummary?.limitExitUnreachableTrades ?? options.summary?.limitExitUnreachableTrades,
                sizedSizingMode: preserveSizedSummary ? existingSummary?.sizedSizingMode : undefined,
                sizedInitialCapital: preserveSizedSummary ? existingSummary?.sizedInitialCapital : undefined,
                sizedFinalEquity: preserveSizedSummary ? existingSummary?.sizedFinalEquity : undefined,
                sizedNetProfit: preserveSizedSummary ? existingSummary?.sizedNetProfit : undefined,
                sizedNetProfitPercent: preserveSizedSummary ? existingSummary?.sizedNetProfitPercent : undefined,
                sizedGrossProfit: preserveSizedSummary ? existingSummary?.sizedGrossProfit : undefined,
                sizedGrossLoss: preserveSizedSummary ? existingSummary?.sizedGrossLoss : undefined,
                sizedProfitFactor: preserveSizedSummary ? existingSummary?.sizedProfitFactor : undefined,
                sizedExpectancy: preserveSizedSummary ? existingSummary?.sizedExpectancy : undefined,
                sizedMaxDrawdown: preserveSizedSummary ? existingSummary?.sizedMaxDrawdown : undefined,
                sizedMaxDrawdownPercent: preserveSizedSummary ? existingSummary?.sizedMaxDrawdownPercent : undefined,
                sizedTrades: preserveSizedSummary ? existingSummary?.sizedTrades : undefined,
                sizedSkippedTrades: preserveSizedSummary ? existingSummary?.sizedSkippedTrades : undefined,
                sizedNoCapitalTrades: preserveSizedSummary ? existingSummary?.sizedNoCapitalTrades : undefined,
                sizedCappedTrades: preserveSizedSummary ? existingSummary?.sizedCappedTrades : undefined,
                sizedTotalStaked: preserveSizedSummary ? existingSummary?.sizedTotalStaked : undefined,
                sizedAvgStake: preserveSizedSummary ? existingSummary?.sizedAvgStake : undefined,
                sizedMaxStake: preserveSizedSummary ? existingSummary?.sizedMaxStake : undefined,
            },
        };
    }

    private resolveSelectedPolymarketEntrySelectionMode(result: BacktestResult): PolymarketEntrySelectionMode {
        return resolvePolymarketEntrySelectionModeForDisplay(
            resolvePolymarketSummaryEntrySelectionMode(result),
            resolvePolymarketDomSettings().entrySelectionMode,
            result.trades
        );
    }

    private resolveSelectedPolymarketEntryOffset(result: BacktestResult): number | undefined {
        if (this.resolveActivePolymarketOutcomeInterval(result) !== "5m") {
            return undefined;
        }
        if (isActualPolymarketEntryMinuteMode(this.resolveSelectedPolymarketEntrySelectionMode(result))) {
            return undefined;
        }

        const summaryOffset = result.polymarketTradeSummary?.entryOffset;
        if (typeof summaryOffset === "number" && Number.isFinite(summaryOffset)) {
            return Math.max(0, Math.min(4, Math.round(summaryOffset)));
        }

        return resolvePolymarketDomSettings().entryOffset ?? 0;
    }

    private readCurrentPolymarketOutcomeSymbol(): string | null {
        return resolvePolymarketDomSettings().outcomeSymbol;
    }

    private readCurrentPolymarketOutcomeInterval(): PolymarketOutcomeInterval {
        return resolvePolymarketDomSettings().outcomeInterval;
    }

    private readCurrentPolymarketExitMode(): "resolve_hold" | "signal_exit_same_event" | undefined {
        return resolvePolymarketDomSettings().exitMode;
    }

    private readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent(): boolean {
        return resolvePolymarketDomSettings().signalExitAllowMultipleTradesPerEvent;
    }

    private readCurrentPolymarketEntryPriceFilterCents(): number {
        return resolvePolymarketDomSettings().entryPriceFilterCents;
    }

    private readCurrentExecutionModel(): string | undefined {
        return resolvePolymarketDomSettings().executionModel;
    }

    private resolveActivePolymarketOutcomeSymbol(result: BacktestResult): string | null {
        const summarySymbol = result.polymarketTradeSummary?.outcomeSymbol;
        if (typeof summarySymbol === "string" && summarySymbol.trim().length > 0) {
            return summarySymbol.trim().toUpperCase();
        }
        return this.readCurrentPolymarketOutcomeSymbol();
    }

    private resolveActivePolymarketOutcomeInterval(result: BacktestResult): PolymarketOutcomeInterval {
        return resolvePolymarketOutcomeInterval(
            result.polymarketTradeSummary?.outcomeInterval ?? this.readCurrentPolymarketOutcomeInterval()
        );
    }

    private async ensurePolymarketOutcomes(result: BacktestResult): Promise<BacktestResult> {
        const resultContext = resolveBacktestResultMarketContext(result);
        if (!resultContext) {
            return result;
        }

        const hasOutcomes = result.trades.some((trade) => trade.polymarketOutcome !== undefined && trade.polymarketOutcome !== null);
        const outcomeSymbol = this.resolveActivePolymarketOutcomeSymbol(result);
        const outcomeInterval = this.resolveActivePolymarketOutcomeInterval(result);
        const resolvedOutcomeSymbol = resolvePolymarketOutcomeSymbol(resultContext.symbol, outcomeSymbol);
        const seriesId = getEffectivePolymarketSeriesId(resultContext.symbol, outcomeInterval, outcomeSymbol);
        const shouldRetryEmptySignalExitSummary = result.polymarketTradeSummary?.evaluationMode === "signal_exit_same_event"
            && (result.polymarketTradeSummary.scoredTrades ?? 0) === 0
            && result.trades.length > 0;
        const isSecondMarketRun = isSecondMarketPolymarketSupported(resultContext.symbol, resultContext.interval);
        const shouldRefreshSecondMarketPricing = isSecondMarketRun
            && result.polymarketTradeSummary !== undefined
            && (
                result.polymarketTradeSummary.evaluationMode !== "signal_exit_same_event"
                || summarizePolymarketPerformanceForResult(result) === null
            );
        const shouldRepairFilteredActualMode = resultContext.interval === "1m"
            && outcomeInterval === "5m"
            && isActualPolymarketEntryMinuteMode(this.resolveSelectedPolymarketEntrySelectionMode(result))
            && hasFilteredPolymarketTrades(result.trades);
        if (
            result.polymarketTradeSummary
            && hasOutcomes
            && !shouldRetryEmptySignalExitSummary
            && !shouldRepairFilteredActualMode
            && !shouldRefreshSecondMarketPricing
        ) {
            return this.withPolymarketTradeSummary(result, result.trades, seriesId, {
                entrySelectionMode: result.polymarketTradeSummary.entrySelectionMode,
                selectedOffset: result.polymarketTradeSummary.entryOffset,
                outcomeSymbol: result.polymarketTradeSummary.outcomeSymbol ?? resolvedOutcomeSymbol ?? undefined,
                outcomeInterval: result.polymarketTradeSummary.outcomeInterval ?? outcomeInterval,
            });
        }

        if (isSecondMarketRun) {
            try {
                const summaryEvaluationMode = result.polymarketTradeSummary?.evaluationMode;
                const effectiveExitMode = resolveEffectivePolymarketExitMode({
                    requestedMode: (
                        summaryEvaluationMode === "resolve_hold"
                        || summaryEvaluationMode === "signal_exit_same_event"
                    )
                        ? summaryEvaluationMode
                        : this.readCurrentPolymarketExitMode(),
                    interval: resultContext.interval,
                    executionModel: this.readCurrentExecutionModel(),
                    polymarketAnnotationEnabled: true,
                });
                const currentPolymarketSettings = resolvePolymarketDomSettings();
                const existingLimitSummary = result.polymarketTradeSummary?.limitEntryEnabled === true
                    ? result.polymarketTradeSummary
                    : null;
                const limitEntry = outcomeInterval === "5m"
                    && (
                        existingLimitSummary
                        || (!result.polymarketTradeSummary && currentPolymarketSettings.postSignalLimitEntryEnabled)
                    )
                    ? {
                        enabled: true,
                        priceMode: existingLimitSummary?.limitEntryMode
                            ?? currentPolymarketSettings.postSignalLimitEntryMode,
                        priceCents: existingLimitSummary?.limitEntryPriceCents
                            ?? currentPolymarketSettings.postSignalLimitEntryPriceCents,
                        offsetCents: existingLimitSummary?.limitEntryOffsetCents
                            ?? currentPolymarketSettings.postSignalLimitEntryOffsetCents,
                        exitEnabled: existingLimitSummary
                            ? existingLimitSummary.limitExitEnabled === true
                            : currentPolymarketSettings.postSignalLimitExitEnabled,
                        exitMode: existingLimitSummary?.limitExitMode
                            ?? currentPolymarketSettings.postSignalLimitExitMode,
                        exitPriceCents: existingLimitSummary?.limitExitPriceCents
                            ?? currentPolymarketSettings.postSignalLimitExitPriceCents,
                        exitOffsetCents: existingLimitSummary?.limitExitOffsetCents
                            ?? currentPolymarketSettings.postSignalLimitExitOffsetCents,
                    }
                    : undefined;
                return await annotateBacktestResultWithSecondMarketClob({
                    result,
                    symbol: resultContext.symbol,
                    interval: resultContext.interval,
                    outcomeSymbol: outcomeSymbol ?? undefined,
                    outcomeInterval,
                    executionModel: this.readCurrentExecutionModel(),
                    polymarketExitMode: effectiveExitMode,
                    polymarketSignalExitAllowMultipleTradesPerEvent: result.polymarketTradeSummary?.evaluationMode === "signal_exit_same_event"
                        ? result.polymarketTradeSummary.signalExitAllowMultipleTradesPerEvent === true
                        : this.readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent(),
                    entryPriceFilterCents: this.readCurrentPolymarketEntryPriceFilterCents(),
                    limitEntry,
                });
            } catch (error) {
                debugLogger.warn("quick_view.second_market_polymarket_annotation_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
                return result;
            }
        }

        if (!isSupportedPolymarketOutcomeRun(resultContext.symbol, resultContext.interval, outcomeInterval, outcomeSymbol)) {
            return result;
        }

        if (!seriesId) {
            return result;
        }

        const targetTimes = result.trades
            .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null);
        if (targetTimes.length === 0) {
            return result;
        }

        const startTs = Math.min(...targetTimes);
        const endTs = Math.max(...targetTimes);

        const outcomes = await loadPolymarketOutcomesForTimeRange(
            resultContext.symbol,
            startTs,
            endTs,
            outcomeSymbol,
            outcomeInterval
        );
        if (outcomes.length === 0) {
            return hasOutcomes
                ? this.withPolymarketTradeSummary(result, result.trades, seriesId, {
                    outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
                    outcomeInterval,
                })
                : result;
        }

        const effectiveExitMode = resolveEffectivePolymarketExitMode({
            requestedMode: state.currentBacktestResult?.polymarketTradeSummary?.evaluationMode
                ?? this.readCurrentPolymarketExitMode(),
            interval: resultContext.interval,
            executionModel: this.readCurrentExecutionModel(),
            polymarketAnnotationEnabled: true,
        });
        const currentPolymarketSettings = resolvePolymarketDomSettings();
        const allowMultipleTradesPerEvent = result.polymarketTradeSummary?.evaluationMode === "signal_exit_same_event"
            ? result.polymarketTradeSummary.signalExitAllowMultipleTradesPerEvent === true
            : currentPolymarketSettings.signalExitAllowMultipleTradesPerEvent;
        const existingLimitSummary = result.polymarketTradeSummary?.limitEntryEnabled === true
            ? result.polymarketTradeSummary
            : null;
        const limitEntry = outcomeInterval === "5m"
            && (
                existingLimitSummary
                || (!result.polymarketTradeSummary && currentPolymarketSettings.postSignalLimitEntryEnabled)
            )
            ? {
                enabled: true,
                priceMode: existingLimitSummary?.limitEntryMode
                    ?? currentPolymarketSettings.postSignalLimitEntryMode,
                priceCents: existingLimitSummary?.limitEntryPriceCents
                    ?? currentPolymarketSettings.postSignalLimitEntryPriceCents,
                offsetCents: existingLimitSummary?.limitEntryOffsetCents
                    ?? currentPolymarketSettings.postSignalLimitEntryOffsetCents,
                exitEnabled: existingLimitSummary
                    ? existingLimitSummary.limitExitEnabled === true
                    : currentPolymarketSettings.postSignalLimitExitEnabled,
                exitMode: existingLimitSummary?.limitExitMode
                    ?? currentPolymarketSettings.postSignalLimitExitMode,
                exitPriceCents: existingLimitSummary?.limitExitPriceCents
                    ?? currentPolymarketSettings.postSignalLimitExitPriceCents,
                exitOffsetCents: existingLimitSummary?.limitExitOffsetCents
                    ?? currentPolymarketSettings.postSignalLimitExitOffsetCents,
            }
            : undefined;

        if (isSignalExitSameEventMode(effectiveExitMode) && resultContext.interval === "1m") {
            try {
                const outcomeByEntryTs = indexSignalExitOutcomesForTrades(result.trades, outcomes);
                const relevantOutcomeByStart = new Map<number, (typeof outcomes)[number]>();
                for (const outcome of outcomeByEntryTs.values()) {
                    if (outcome) {
                        relevantOutcomeByStart.set(outcome.event_start_ts, outcome);
                    }
                }
                const pricePoints = await ensurePricePointsForOutcomes(
                    relevantOutcomeByStart.size > 0 ? [...relevantOutcomeByStart.values()] : outcomes,
                    seriesId
                );
                const { results: exitResults, summary: exitSummary } = evaluateSignalExitTrades({
                    trades: result.trades,
                    outcomes,
                    pricePoints,
                    outcomeByEntryTs,
                    allowMultipleTradesPerEvent,
                    entryPriceFilterCents: currentPolymarketSettings.entryPriceFilterCents,
                    limitEntry,
                });
                const exitResultByTrade = new Map(exitResults.map((exitResult) => [exitResult.trade, exitResult]));
                const annotatedTrades = result.trades.map((trade) => {
                    const exitResult = exitResultByTrade.get(trade);
                    if (!exitResult) return { ...trade, polymarketOutcome: null };
                    return { ...trade, polymarketOutcome: buildTradeAnnotationFromSignalExitResult(exitResult) };
                });

                return {
                    ...result,
                    trades: annotatedTrades,
                    polymarketTradeSummary: buildSignalExitPolymarketTradeSummary({
                        seriesId,
                        outcomeSymbol: resolvedOutcomeSymbol,
                        outcomeInterval,
                        outcomeRowsLoaded: outcomes.length,
                        summary: exitSummary,
                    }),
                };
            } catch (error) {
                debugLogger.warn("quick_view.polymarket_signal_exit_annotation_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const entrySelectionMode = resultContext.interval === "1m"
            && outcomeInterval === "5m"
            ? this.resolveSelectedPolymarketEntrySelectionMode(result)
            : undefined;
        const selectedOffset = resultContext.interval === "1m"
            && outcomeInterval === "5m"
            ? this.resolveSelectedPolymarketEntryOffset(result)
            : undefined;
        let limitEntryPricePoints: Awaited<ReturnType<typeof ensurePricePointsForOutcomes>> | undefined;
        if (limitEntry) {
            try {
                limitEntryPricePoints = await ensurePricePointsForOutcomes(outcomes, seriesId);
            } catch {
                limitEntryPricePoints = [];
            }
        }
        const trades = hasOutcomes
            ? result.trades
            : annotateTradesWithPolymarketOutcomesForRun(
                result.trades,
                outcomes,
                resultContext.interval,
                selectedOffset,
                entrySelectionMode ?? "fixed_offset",
                {
                    outcomeInterval,
                    pricePoints: limitEntryPricePoints,
                    entryPriceFilterCents: currentPolymarketSettings.entryPriceFilterCents,
                    limitEntry,
                }
            );
        const summary = summarizePolymarketTradesForRun({
            trades,
            outcomes,
            interval: resultContext.interval,
            selectedOffset,
            entrySelectionMode,
            outcomeInterval,
            limitEntry,
        });

        return this.withPolymarketTradeSummary(result, trades, seriesId, {
            outcomeRowsLoaded: outcomes.length,
            entrySelectionMode,
            selectedOffset,
            outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
            outcomeInterval,
            missingOutcomeTrades: summary.missingOutcomeTrades,
            unscoredTrades: summary.unscoredTrades,
            summary,
        });
    }

    async show(result: BacktestResult) {
        if (!this.overlay) return;
        const renderGeneration = ++this.overlayRenderGeneration;

        const enrichedResult = this.applyCurrentPolymarketAlternativeSizing(
            await this.ensurePolymarketOutcomes(result)
        );
        if (renderGeneration !== this.overlayRenderGeneration) {
            return;
        }

        this.renderResults(enrichedResult);
        this.renderTrades(enrichedResult.trades);

        this.overlay.style.display = 'flex';
        this.overlay.offsetHeight;
        this.overlay.classList.add('is-visible');
        this.visible = true;

        const btn = getQuickViewBtn();
        if (btn) btn.classList.add('qv-active');
    }

    hide() {
        if (!this.overlay) return;
        this.overlayRenderGeneration += 1;

        this.overlay.classList.remove('is-visible');
        setTimeout(() => {
            if (this.overlay && !this.overlay.classList.contains('is-visible')) {
                this.overlay.style.display = 'none';
            }
        }, 260);
        this.visible = false;

        const btn = getQuickViewBtn();
        if (btn) btn.classList.toggle('qv-active', this.enabled);
    }

    async onBacktestComplete(result: BacktestResult) {
        if (this.enabled) {
            await this.show(result);
        }
    }

    setJumpToTrade(fn: (time: Time) => void) {
        this.jumpToTrade = fn;
    }

    get isVisible() {
        return this.visible;
    }

    destroy() {
        this.cancelPendingDeferredRenders();
        this.tradeRenderGeneration += 1;
        this.overlayRenderGeneration += 1;
        if (this.keyboardHandler) {
            window.removeEventListener('keydown', this.keyboardHandler);
            this.keyboardHandler = null;
        }
        if (this.overlay?.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.visible = false;
    }

    private renderResults(result: BacktestResult) {
        const content = getQvStatsContent();
        const empty = getQvEmpty();
        if (!content || !empty) return;

        empty.style.display = 'none';
        content.style.display = 'block';

        const polymarketPayoutSummary = summarizePolymarketPerformanceForResult(result);
        const polymarketSectionHtml = this.buildPolymarketSection(result);

        content.innerHTML = renderResultsHtml(result, {
            polymarketPayoutSummary,
            polymarketSectionHtml,
        });
    }

    private applyCurrentPolymarketAlternativeSizing(result: BacktestResult): BacktestResult {
        if ((result.polymarketTradeSummary?.sizedTrades ?? 0) > 0) {
            return result;
        }
        if (!result.trades.some((trade) => trade.polymarketOutcome)) {
            return result;
        }
        if (state.ohlcvData.length === 0) {
            return result;
        }

        const resultContext = resolveBacktestResultMarketContext(result);
        const backtestSettings = {
            ...getBacktestSettings(),
            symbol: resultContext?.symbol,
            interval: resultContext?.interval,
        };

        return applyPolymarketAlternativeSizing({
            result,
            chartData: state.ohlcvData,
            backtestSettings,
            capitalSettings: getCapitalSettings(),
            alternativeSizingEnabled: getAlternativeSizingEnabled(),
        });
    }

    private renderTrades(trades: Trade[]) {
        this.currentTrades = trades;
        const list = getQvTradesList();
        const count = getQvTradesCount();
        const sortLabel = getQvSortLabel();
        if (!list) return;
        this.cancelPendingDeferredRenders();
        this.tradeRenderGeneration += 1;
        if (count) count.textContent = String(trades.length);
        if (sortLabel) sortLabel.textContent = this.sortNewestFirst ? 'Newest first' : 'Oldest first';

        if (trades.length === 0) {
            list.innerHTML = renderEmptyTradesHtml();
            return;
        }

        const sorted = this.sortNewestFirst ? [...trades].reverse() : trades;
        const toRender = sorted.slice(0, QuickViewManager.MAX_RENDERED_TRADES);
        const limitNotice = trades.length > QuickViewManager.MAX_RENDERED_TRADES
            ? renderTradesLimitNoticeHtml(trades.length, QuickViewManager.MAX_RENDERED_TRADES)
            : '';
        this.renderTradesProgressively(this.tradeRenderGeneration, list, toRender, limitNotice);
    }

    private renderTradesProgressively(
        renderGeneration: number,
        list: HTMLElement,
        trades: Trade[],
        limitNoticeHtml: string
    ): void {
        const initialCount = Math.min(trades.length, QuickViewManager.INITIAL_TRADE_BATCH_SIZE);
        list.innerHTML = renderTradeChunkHtml(trades, 0, initialCount);

        let offset = initialCount;
        const appendLimitNotice = () => {
            if (!limitNoticeHtml || renderGeneration !== this.tradeRenderGeneration) {
                return;
            }

            const fragment = document.createRange().createContextualFragment(limitNoticeHtml);
            list.appendChild(fragment);
        };

        if (offset >= trades.length) {
            appendLimitNotice();
            return;
        }

        const appendChunk = () => {
            if (renderGeneration !== this.tradeRenderGeneration) {
                return;
            }

            const nextOffset = Math.min(offset + QuickViewManager.DEFERRED_TRADE_BATCH_SIZE, trades.length);
            const fragment = document.createRange().createContextualFragment(
                renderTradeChunkHtml(trades, offset, nextOffset)
            );
            list.appendChild(fragment);
            offset = nextOffset;

            if (offset < trades.length) {
                this.scheduleDeferredRender(appendChunk);
                return;
            }

            appendLimitNotice();
        };

        this.scheduleDeferredRender(appendChunk);
    }

    private handleTradeItemActivation(target: EventTarget | null, list: HTMLElement): void {
        if (!(target instanceof Element)) {
            return;
        }

        const item = target.closest('.qv-trade-item');
        if (!(item instanceof HTMLElement) || !list.contains(item)) {
            return;
        }

        const raw = item.dataset.entryTime;
        if (!raw || !this.jumpToTrade) {
            return;
        }

        this.jumpToTrade(this.parseTradeTime(raw));
        this.hide();
    }

    private parseTradeTime(raw: string): Time {
        try {
            return JSON.parse(raw) as Time;
        } catch {
            return (isNaN(Number(raw)) ? raw : Number(raw)) as Time;
        }
    }

    private scheduleDeferredRender(callback: () => void): void {
        if (typeof window.requestIdleCallback === 'function') {
            const deferredId = window.requestIdleCallback(() => callback());
            this.pendingDeferredRenderIds.push(deferredId);
            return;
        }

        const deferredId = window.setTimeout(callback, 16);
        this.pendingDeferredRenderIds.push(deferredId);
    }

    private cancelPendingDeferredRenders(): void {
        for (const deferredId of this.pendingDeferredRenderIds) {
            if (typeof window.cancelIdleCallback === 'function') {
                window.cancelIdleCallback(deferredId);
            } else {
                window.clearTimeout(deferredId);
            }
        }
        this.pendingDeferredRenderIds = [];
    }

    private getBestTimingProfileEntry(
        timingProfile: readonly import("../types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry[]
    ): import("../types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry | null {
        if (timingProfile.length === 0) return null;
        const scoredEntries = timingProfile.filter((entry) => entry.scoredTrades > 0);
        if (scoredEntries.length === 0) return null;
        return [...scoredEntries].sort((left, right) => {
            if (right.winRate !== left.winRate) return right.winRate - left.winRate;
            if (right.scoredTrades !== left.scoredTrades) return right.scoredTrades - left.scoredTrades;
            return left.entryOffset - right.entryOffset;
        })[0] ?? null;
    }

    private getPolymarketSummary(result: BacktestResult): QuickViewPolymarketSummary | null {
        const summary = result.polymarketTradeSummary;
        const isSignalExit = summary?.evaluationMode === "signal_exit_same_event";
        const usesRealizedPnl = isSignalExit || summary?.limitExitEnabled === true;
        const hasLimitEntrySummary = summary?.limitEntryEnabled === true
            && (summary.limitEntryAttempts ?? 0) > 0;

        const wins = usesRealizedPnl
            ? (summary?.profitableTrades ?? result.trades.filter((t) => t.polymarketOutcome?.isProfitable === true).length)
            : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
        const losses = usesRealizedPnl
            ? (summary?.losingTrades ?? result.trades.filter((t) => t.polymarketOutcome?.isProfitable === false).length)
            : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
        const neutralTrades = usesRealizedPnl
            ? (summary?.neutralTrades ?? result.trades.filter((trade) => getPolymarketTradeOutcomeState(trade) === "neutral").length)
            : 0;
        const scoredTrades = usesRealizedPnl ? (summary?.scoredTrades ?? wins + losses + neutralTrades) : wins + losses;

        if (scoredTrades === 0 && !hasLimitEntrySummary) return null;

        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const missingTrades = summary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades);
        const unscoredTrades = summary?.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades);
        const derivedDuplicateTradesIgnored = result.trades.filter(
            (trade) => trade.polymarketOutcome?.marketExitSource === "duplicate"
        ).length;
        const duplicateTradesIgnored = summary?.duplicateTradesIgnored
            ?? (derivedDuplicateTradesIgnored > 0 ? derivedDuplicateTradesIgnored : undefined);
        const coverageBase = Math.max(0, scoredTrades + unscoredTrades);
        const coverage = coverageBase > 0 ? scoredTrades / coverageBase : 0;
        const bestBaselineWinRate = isSignalExit ? 0 : computePolymarketBestBaselineWinRate(result.trades);
        const timingProfile = summary?.timingProfile;
        const bestTimingProfile = timingProfile ? this.getBestTimingProfileEntry(timingProfile) : null;
        const payoutSummary = summarizePolymarketPayoutDiagnostics(result.trades);
        const streakSummary = summarizePolymarketStreaks(result.trades);
        const recentFormSummary = summarizeRecentPolymarketForm(result.trades, 50);
        const exitReasonWinRates = summarizePolymarketExitReasonWinRates(result.trades);
        const afterTakeProfitExpectancy = summarizePolymarketExpectancyAfterTakeProfit(result.trades);
        const hasSizedBankroll = (summary?.sizedTrades ?? 0) > 0
            && typeof summary?.sizedNetProfit === "number";

        return {
            wins, losses, neutralTrades, scoredTrades, missingTrades, unscoredTrades, coverage,
            duplicateTradesIgnored,
            entryPriceFilteredTrades: summary?.entryPriceFilteredTrades,
            winRate: scoredTrades > 0 ? wins / scoredTrades : 0,
            expectancy: isSignalExit
                ? (summary?.expectancy ?? payoutSummary?.expectancy ?? null)
                : payoutSummary?.expectancy ?? null,
            profitFactor: isSignalExit
                ? (summary?.profitFactor ?? payoutSummary?.profitFactor ?? null)
                : payoutSummary?.profitFactor ?? null,
            avgWin: payoutSummary?.avgWin ?? null,
            avgLoss: payoutSummary?.avgLoss ?? null,
            avgEntryPrice: payoutSummary?.avgEntryPrice ?? null,
            outcomeRowsLoaded: summary?.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(result.trades),
            bestBaselineWinRate: usesRealizedPnl ? 0 : bestBaselineWinRate,
            baselineDelta: usesRealizedPnl ? 0 : (scoredTrades > 0 ? wins / scoredTrades : 0) - bestBaselineWinRate,
            longestWinStreak: streakSummary.longestWinStreak,
            longestLossStreak: streakSummary.longestLossStreak,
            recentFormTrades: recentFormSummary.recentFormTrades,
            recentFormWins: recentFormSummary.recentFormWins,
            recentFormLosses: recentFormSummary.recentFormLosses,
            recentFormFlats: recentFormSummary.recentFormFlats,
            recentFormWinRate: recentFormSummary.recentFormWinRate,
            exitReasonWinRates, afterTakeProfitExpectancy,
            entrySelectionMode: summary?.entrySelectionMode,
            entryOffset: summary?.entryOffset,
            outcomeInterval: summary?.outcomeInterval,
            timingProfile, bestTimingProfile,
            evaluationMode: summary?.evaluationMode,
            missingPriceTrades: summary?.missingPriceTrades,
            targetExitedTrades: summary?.targetExitedTrades,
            signalExitedTrades: summary?.signalExitedTrades,
            resolvedTrades: summary?.resolvedTrades,
            limitEntryEnabled: summary?.limitEntryEnabled,
            limitEntryMode: summary?.limitEntryMode,
            limitEntryPriceCents: summary?.limitEntryPriceCents,
            limitEntryOffsetCents: summary?.limitEntryOffsetCents,
            limitEntryAttempts: summary?.limitEntryAttempts,
            limitEntryFilledTrades: summary?.limitEntryFilledTrades,
            limitEntryMissedTrades: summary?.limitEntryMissedTrades,
            limitEntryNotTouchedTrades: summary?.limitEntryNotTouchedTrades,
            limitEntryLastMinuteOnlyTrades: summary?.limitEntryLastMinuteOnlyTrades,
            limitEntryMissingPriceTrades: summary?.limitEntryMissingPriceTrades,
            limitEntryFillRate: summary?.limitEntryFillRate,
            avgLimitEntryWaitSec: summary?.avgLimitEntryWaitSec,
            avgLimitEntryImprovement: summary?.avgLimitEntryImprovement,
            limitExitEnabled: summary?.limitExitEnabled,
            limitExitMode: summary?.limitExitMode,
            limitExitPriceCents: summary?.limitExitPriceCents,
            limitExitOffsetCents: summary?.limitExitOffsetCents,
            limitExitFilledTrades: summary?.limitExitFilledTrades,
            limitExitFallbackTrades: summary?.limitExitFallbackTrades,
            limitExitUnreachableTrades: summary?.limitExitUnreachableTrades,
            sizedSizingMode: hasSizedBankroll ? summary?.sizedSizingMode : undefined,
            sizedInitialCapital: hasSizedBankroll ? summary?.sizedInitialCapital : undefined,
            sizedFinalEquity: hasSizedBankroll ? summary?.sizedFinalEquity : undefined,
            sizedNetProfit: hasSizedBankroll ? summary?.sizedNetProfit : undefined,
            sizedNetProfitPercent: hasSizedBankroll ? summary?.sizedNetProfitPercent : undefined,
            sizedProfitFactor: hasSizedBankroll ? summary?.sizedProfitFactor : undefined,
            sizedExpectancy: hasSizedBankroll ? summary?.sizedExpectancy : undefined,
            sizedMaxDrawdownPercent: hasSizedBankroll ? summary?.sizedMaxDrawdownPercent : undefined,
            sizedTrades: hasSizedBankroll ? summary?.sizedTrades : undefined,
            sizedSkippedTrades: hasSizedBankroll ? summary?.sizedSkippedTrades : undefined,
            sizedNoCapitalTrades: hasSizedBankroll ? summary?.sizedNoCapitalTrades : undefined,
            sizedCappedTrades: hasSizedBankroll ? summary?.sizedCappedTrades : undefined,
            sizedAvgStake: hasSizedBankroll ? summary?.sizedAvgStake : undefined,
            sizedMaxStake: hasSizedBankroll ? summary?.sizedMaxStake : undefined,
        };
    }

    buildPolymarketSection(result: BacktestResult): string {
        const summary = this.getPolymarketSummary(result);
        if (!summary) return '';
        return buildPolymarketSectionHtml(summary);
    }
}

export const quickViewManager = new QuickViewManager();
