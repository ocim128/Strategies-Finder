import { state } from "../state";
import { debugLogger } from "../debug-logger";
import type { BacktestResult, ExpectancyBreakdownRow, ExpectancyBreakdownSection, Trade } from "../strategies/index";
import type { Time } from "lightweight-charts";
import { isPolymarketEventSymbol } from "../dataProviders/polymarket";
import {
    getEffectivePolymarket5mSeriesId,
    loadPolymarket5mOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
    supportsPolymarketOutcomeBridgeRun,
} from "../polymarket-btc5m";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    filterTradesByPreviousClosedTradeExitReason,
    summarizePolymarketTradesForRun,
} from "../polymarket-trade-annotations";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode } from "../polymarket-exit-mode";
import { evaluateSignalExitTrades, buildTradeAnnotationFromSignalExitResult } from "../polymarket-signal-exit-evaluator";
import { ensurePricePointsForOutcomes } from "../polymarket-price-points-ingest";
import { resolveBacktestResultMarketContext } from "../backtest-result-context";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { findContainingEvent } from "../polymarket-1m-5m-bridge";
import { resolvePolymarketDomSettings } from "../polymarket-dom-reader";
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


export type QuickViewPolymarketSummary = {
    wins: number;
    losses: number;
    neutralTrades: number;
    scoredTrades: number;
    missingTrades: number;
    unscoredTrades: number;
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
    timingProfile?: import("../types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry[];
    bestTimingProfile?: import("../types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry | null;
    evaluationMode?: "resolve_hold" | "signal_exit_same_event";
    missingPriceTrades?: number;
    signalExitedTrades?: number;
    resolvedTrades?: number;
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
        return Math.max(0, Math.min(4, Math.round(summaryOffset)));
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
} {
    const scoredTrades = getScoredPolymarketTrades(trades).length;
    const hasSignalExitAnnotations = trades.some((trade) => trade.polymarketOutcome?.evaluationMode === "signal_exit_same_event");
    const duplicateTradesIgnored = hasSignalExitAnnotations
        ? trades.filter((trade) => trade.polymarketOutcome?.marketExitSource === "duplicate").length
        : 0;
    const missingOutcomeTrades = hasSignalExitAnnotations
        ? trades.filter((trade) => trade.polymarketOutcome?.marketExitSource === "no_event").length
        : Math.max(0, totalTrades - scoredTrades);

    return {
        scoredTrades,
        missingOutcomeTrades,
        unscoredTrades: Math.max(0, totalTrades - scoredTrades),
        duplicateTradesIgnored: duplicateTradesIgnored > 0 ? duplicateTradesIgnored : undefined,
    };
}

function getPolymarketTradePayout(trade: Trade): number | null {
    const outcome = trade.polymarketOutcome;
    if (!outcome) {
        return null;
    }

    if (outcome.evaluationMode === "signal_exit_same_event") {
        if (typeof outcome.marketPnl === "number" && Number.isFinite(outcome.marketPnl)) {
            return outcome.marketPnl;
        }
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
    const minuteBuckets = Array.from({ length: 5 }, (_, minute) => ({
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
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs !== null) {
            const minuteOffset = Math.floor((((entryTs % 300) + 300) % 300) / 60);
            minuteBuckets[minuteOffset]?.trades.push(trade);
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
        sections.push({
            id: "session_minute",
            title: minuteRows.length === 1
                ? (selectedEntryOffset !== null
                    ? "Selected 5m Session Minute"
                    : (entrySelectionMode === "actual_entry_minute" ? "Observed 5m Session Minute (Auto)" : "Observed 5m Session Minute"))
                : "By 5m Session Minute",
            hint: minuteRows.length === 1
                ? (selectedEntryOffset !== null
                    ? `This run is filtered to minute ${selectedEntryOffset} inside each rolling 5m event, so this shows the scored subset for that selected offset only. Exp is shown in cents per $1 share.`
                    : (entrySelectionMode === "actual_entry_minute"
                        ? "Auto mode scores the first eligible trade in each rolling 5m event and prices it at that trade's actual minute. Exp is shown in cents per $1 share."
                        : "This run executes on the native 5m chart, so scored entries naturally land on minute 0 of each event. Exp is shown in cents per $1 share."))
                : "For 1m execution, this shows Polymarket payout expectancy by minute 0-4 inside each rolling 5m event. Exp is shown in cents per $1 share.",
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
            missingOutcomeTrades?: number;
            unscoredTrades?: number;
        } = {}
    ): BacktestResult {
        const totalTrades = result.totalTrades > 0 ? result.totalTrades : trades.length;
        const fallbackOutcomeRowsLoaded = options.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(trades);
        const existingSummary = result.polymarketTradeSummary;
        const inferredCounts = inferPolymarketSummaryCounts(trades, totalTrades);

        return {
            ...result,
            trades,
            polymarketTradeSummary: {
                seriesId: existingSummary?.seriesId || seriesId || "",
                outcomeSymbol: existingSummary?.outcomeSymbol ?? options.outcomeSymbol,
                outcomeRowsLoaded: existingSummary?.outcomeRowsLoaded && existingSummary.outcomeRowsLoaded > 0
                    ? existingSummary.outcomeRowsLoaded
                    : fallbackOutcomeRowsLoaded,
                scoredTrades: existingSummary?.scoredTrades ?? inferredCounts.scoredTrades,
                missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? options.missingOutcomeTrades ?? inferredCounts.missingOutcomeTrades,
                unscoredTrades: existingSummary?.unscoredTrades ?? options.unscoredTrades ?? inferredCounts.unscoredTrades,
                duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored ?? inferredCounts.duplicateTradesIgnored,
                entrySelectionMode: existingSummary?.entrySelectionMode ?? options.entrySelectionMode,
                entryOffset: existingSummary?.entryOffset ?? options.selectedOffset,
                timingProfile: existingSummary?.timingProfile,
                evaluationMode: existingSummary?.evaluationMode,
                profitableTrades: existingSummary?.profitableTrades,
                losingTrades: existingSummary?.losingTrades,
                neutralTrades: existingSummary?.neutralTrades,
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

    private readCurrentPolymarketExitMode(): "resolve_hold" | "signal_exit_same_event" | undefined {
        return resolvePolymarketDomSettings().exitMode;
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

    private async ensurePolymarketOutcomes(result: BacktestResult): Promise<BacktestResult> {
        const resultContext = resolveBacktestResultMarketContext(result);
        if (!resultContext) {
            return result;
        }

        const hasOutcomes = result.trades.some((trade) => trade.polymarketOutcome !== undefined && trade.polymarketOutcome !== null);
        const outcomeSymbol = this.resolveActivePolymarketOutcomeSymbol(result);
        const resolvedOutcomeSymbol = resolvePolymarketOutcomeSymbol(resultContext.symbol, outcomeSymbol);
        const seriesId = getEffectivePolymarket5mSeriesId(resultContext.symbol, outcomeSymbol);
        const shouldRetryEmptySignalExitSummary = result.polymarketTradeSummary?.evaluationMode === "signal_exit_same_event"
            && (result.polymarketTradeSummary.scoredTrades ?? 0) === 0
            && result.trades.length > 0;
        const shouldRepairFilteredActualMode = resultContext.interval === "1m"
            && isActualPolymarketEntryMinuteMode(this.resolveSelectedPolymarketEntrySelectionMode(result))
            && hasFilteredPolymarketTrades(result.trades);
        if (result.polymarketTradeSummary && !shouldRetryEmptySignalExitSummary && !shouldRepairFilteredActualMode) {
            return this.withPolymarketTradeSummary(result, result.trades, seriesId, {
                entrySelectionMode: result.polymarketTradeSummary.entrySelectionMode,
                selectedOffset: result.polymarketTradeSummary.entryOffset,
                outcomeSymbol: result.polymarketTradeSummary.outcomeSymbol ?? resolvedOutcomeSymbol ?? undefined,
            });
        }

        if (!supportsPolymarketOutcomeBridgeRun(resultContext.symbol, resultContext.interval, outcomeSymbol)) {
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

        const outcomes = await loadPolymarket5mOutcomesForTimeRange(resultContext.symbol, startTs, endTs, outcomeSymbol);
        if (outcomes.length === 0) {
            return hasOutcomes
                ? this.withPolymarketTradeSummary(result, result.trades, seriesId, {
                    outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
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

        if (isSignalExitSameEventMode(effectiveExitMode) && resultContext.interval === "1m") {
            try {
                const relevantOutcomeByStart = new Map<number, (typeof outcomes)[number]>();
                for (const trade of result.trades) {
                    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
                    if (entryTs === null) continue;
                    const outcome = findContainingEvent(entryTs, outcomes);
                    if (outcome) {
                        relevantOutcomeByStart.set(outcome.event_start_ts, outcome);
                    }
                }
                const pricePoints = await ensurePricePointsForOutcomes(
                    relevantOutcomeByStart.size > 0 ? [...relevantOutcomeByStart.values()] : outcomes,
                    seriesId,
                    {
                    startTs: startTs - 300,
                    endTs: endTs + 300,
                    }
                );
                const { results: exitResults, summary: exitSummary } = evaluateSignalExitTrades({
                    trades: result.trades,
                    outcomes,
                    pricePoints,
                });
                const exitResultByTrade = new Map(exitResults.map((exitResult) => [exitResult.trade, exitResult]));
                const annotatedTrades = result.trades.map((trade) => {
                    const exitResult = exitResultByTrade.get(trade);
                    if (!exitResult || exitResult.exitSource === "missing") return { ...trade, polymarketOutcome: null };
                    return { ...trade, polymarketOutcome: buildTradeAnnotationFromSignalExitResult(exitResult) };
                });

                return {
                    ...result,
                    trades: annotatedTrades,
                    polymarketTradeSummary: {
                        seriesId,
                        outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
                        outcomeRowsLoaded: outcomes.length,
                        scoredTrades: exitSummary.scoredTrades,
                        missingOutcomeTrades: exitSummary.missingOutcomeTrades,
                        unscoredTrades: exitSummary.unscoredTrades,
                        duplicateTradesIgnored: exitSummary.duplicateTradesIgnored > 0 ? exitSummary.duplicateTradesIgnored : undefined,
                        evaluationMode: "signal_exit_same_event",
                        profitableTrades: exitSummary.profitableTrades,
                        losingTrades: exitSummary.losingTrades,
                        neutralTrades: exitSummary.neutralTrades,
                        signalExitedTrades: exitSummary.signalExitedTrades,
                        resolvedTrades: exitSummary.resolvedTrades,
                        missingPriceTrades: exitSummary.missingPriceTrades,
                        netPnl: exitSummary.netPnl,
                        grossProfit: exitSummary.grossProfit,
                        grossLoss: exitSummary.grossLoss,
                        profitFactor: exitSummary.profitFactor,
                        expectancy: exitSummary.expectancy,
                        avgEntryPrice: exitSummary.avgEntryPrice,
                        avgExitPrice: exitSummary.avgExitPrice,
                    },
                };
            } catch (error) {
                debugLogger.warn("quick_view.polymarket_signal_exit_annotation_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const entrySelectionMode = resultContext.interval === "1m"
            ? this.resolveSelectedPolymarketEntrySelectionMode(result)
            : undefined;
        const selectedOffset = resultContext.interval === "1m"
            ? this.resolveSelectedPolymarketEntryOffset(result)
            : undefined;
        const trades = hasOutcomes
            ? result.trades
            : annotateTradesWithPolymarketOutcomesForRun(
                result.trades,
                outcomes,
                resultContext.interval,
                selectedOffset,
                entrySelectionMode ?? "fixed_offset"
            );
        const summary = summarizePolymarketTradesForRun({
            trades: result.trades,
            outcomes,
            interval: resultContext.interval,
            selectedOffset,
            entrySelectionMode,
        });

        return this.withPolymarketTradeSummary(result, trades, seriesId, {
            outcomeRowsLoaded: outcomes.length,
            entrySelectionMode,
            selectedOffset,
            outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
            missingOutcomeTrades: summary.missingOutcomeTrades,
            unscoredTrades: summary.unscoredTrades,
        });
    }

    async show(result: BacktestResult) {
        if (!this.overlay) return;
        const renderGeneration = ++this.overlayRenderGeneration;

        const enrichedResult = await this.ensurePolymarketOutcomes(result);
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

        const resultContext = resolveBacktestResultMarketContext(result);
        const isPolymarketMarket = Boolean(resultContext && isPolymarketEventSymbol(resultContext.symbol));
        const polymarketPayoutSummary = isPolymarketMarket ? summarizePolymarketPayoutDiagnostics(result.trades) : null;
        const polymarketSectionHtml = this.buildPolymarketSection(result);

        content.innerHTML = renderResultsHtml(result, {
            polymarketPayoutSummary,
            polymarketSectionHtml,
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
        const isSignalExit = summary?.evaluationMode === "signal_exit_same_event"
            && (summary.scoredTrades ?? 0) > 0;

        const wins = isSignalExit
            ? (summary?.profitableTrades ?? result.trades.filter((t) => t.polymarketOutcome?.isProfitable === true).length)
            : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
        const losses = isSignalExit
            ? (summary?.losingTrades ?? result.trades.filter((t) => t.polymarketOutcome?.isProfitable === false).length)
            : result.trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
        const neutralTrades = isSignalExit
            ? (summary?.neutralTrades ?? result.trades.filter((trade) => getPolymarketTradeOutcomeState(trade) === "neutral").length)
            : 0;
        const scoredTrades = isSignalExit ? (summary?.scoredTrades ?? wins + losses + neutralTrades) : wins + losses;

        if (scoredTrades === 0) return null;

        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const missingTrades = summary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades);
        const unscoredTrades = summary?.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades);
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

        return {
            wins, losses, neutralTrades, scoredTrades, missingTrades, unscoredTrades, coverage,
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
            bestBaselineWinRate,
            baselineDelta: isSignalExit ? 0 : (scoredTrades > 0 ? wins / scoredTrades : 0) - bestBaselineWinRate,
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
            timingProfile, bestTimingProfile,
            evaluationMode: isSignalExit ? "signal_exit_same_event" : undefined,
            missingPriceTrades: isSignalExit ? (summary?.missingPriceTrades ?? 0) : undefined,
            signalExitedTrades: isSignalExit ? (summary?.signalExitedTrades ?? 0) : undefined,
            resolvedTrades: isSignalExit ? (summary?.resolvedTrades ?? 0) : undefined,
        };
    }

    buildPolymarketSection(result: BacktestResult): string {
        const summary = this.getPolymarketSummary(result);
        if (!summary) return '';
        return buildPolymarketSectionHtml(summary);
    }
}

export const quickViewManager = new QuickViewManager();
