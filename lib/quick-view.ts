/**
 * Quick View — an overlay that shows Results + Trades directly over the chart.
 *
 * Toggle button lives in the toolbar (next to "Copy Chart").
 * When enabled, every backtest completion auto-shows the overlay.
 * Press Esc or click the close button to dismiss.
 * Click the toolbar button anytime to manually toggle.
 */

import { state } from "./state";
import type { BacktestResult, ExpectancyBreakdownRow, ExpectancyBreakdownSection, Trade } from "./strategies/index";
import { Time } from "lightweight-charts";
import { formatDisplayPrice } from "./price-format";
import { isPolymarketEventSymbol } from "./dataProviders/polymarket";
import {
    getPolymarket5mSeriesIdForSymbol,
    loadPolymarket5mOutcomesForTimeRange,
    supportsPolymarketOutcomeBridgeRun,
} from "./polymarket-btc5m";
import {
    annotateTradesWithPolymarketOutcomesForRun,
    filterTradesByPreviousClosedTradeExitReason,
    summarizePolymarketTradesForRun,
} from "./polymarket-trade-annotations";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import { parseTimeToUnixSeconds } from "./time-normalization";


type QuickViewPolymarketSummary = {
    wins: number;
    losses: number;
    scoredTrades: number;
    missingTrades: number;
    unscoredTrades: number;
    coverage: number;
    winRate: number;
    expectancy: number | null;
    outcomeRowsLoaded: number;
    bestBaselineWinRate: number;
    baselineDelta: number;
    longestWinStreak: number;
    longestLossStreak: number;
    recentFormTrades: number;
    recentFormWins: number;
    recentFormLosses: number;
    recentFormWinRate: number;
    exitReasonWinRates: {
        maxHold: { trades: number; wins: number; losses: number; winRate: number; };
        takeProfit: { trades: number; wins: number; losses: number; winRate: number; };
        signal: { trades: number; wins: number; losses: number; winRate: number; };
    };
    afterTakeProfitExpectancy: {
        pricedTrades: number;
        expectancy: number | null;
    };
    entryOffset?: number;
    timingProfile?: import("./types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry[];
    bestTimingProfile?: import("./types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry | null;
};

type QuickViewPolymarketPayoutSummary = {
    pricedTrades: number;
    unpricedScoredTrades: number;
    winRate: number;
    expectancy: number;
    avgEntryPrice: number;
    breakEvenWinRate: number;
    edgeVsBreakEven: number;
};

type QuickViewPolymarketExecutionGap = {
    pricedTrades: number;
    unpricedScoredTrades: number;
    polymarketWinRate: number;
    polymarketExpectancy: number;
    avgEntryPrice: number;
    breakEvenWinRate: number;
    realizedWinRate: number;
    realizedExpectancy: number;
};

type QuickViewPolymarketExitReasonSummary = {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
};

type QuickViewPolymarketExpectancySummary = {
    pricedTrades: number;
    expectancy: number | null;
};

type QuickViewPolymarketExitReasonWinRates = {
    maxHold: QuickViewPolymarketExitReasonSummary;
    takeProfit: QuickViewPolymarketExitReasonSummary;
    signal: QuickViewPolymarketExitReasonSummary;
};

export function summarizePolymarketStreaks(trades: Trade[]): {
    longestWinStreak: number;
    longestLossStreak: number;
} {
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let longestWinStreak = 0;
    let longestLossStreak = 0;

    for (const trade of trades) {
        const isWin = trade.polymarketOutcome?.isWin;
        if (isWin === true) {
            currentWinStreak++;
            currentLossStreak = 0;
            longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
            continue;
        }

        if (isWin === false) {
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
    const wins = trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
    const losses = trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
    const tradeCount = wins + losses;

    return {
        trades: tradeCount,
        wins,
        losses,
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
    recentFormWinRate: number;
} {
    const scoredTrades = trades.filter((trade) => trade.polymarketOutcome !== null && trade.polymarketOutcome !== undefined);
    const recentTrades = scoredTrades.slice(-Math.max(0, windowSize));
    const recentFormWins = recentTrades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
    const recentFormLosses = recentTrades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
    const recentFormTrades = recentTrades.length;

    return {
        recentFormTrades,
        recentFormWins,
        recentFormLosses,
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
    const scoredTrades = trades.filter((trade) => trade.polymarketOutcome !== null && trade.polymarketOutcome !== undefined);
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
        if (typeof eventStartTs === "number" && Number.isFinite(eventStartTs)) {
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

function getPolymarketPricedTrades(trades: readonly Trade[]): Trade[] {
    return trades.filter((trade) => (
        trade.polymarketOutcome !== null
        && trade.polymarketOutcome !== undefined
        && typeof trade.polymarketOutcome.marketEntryPrice === "number"
        && Number.isFinite(trade.polymarketOutcome.marketEntryPrice)
    ));
}

function getScoredPolymarketTrades(trades: readonly Trade[]): Trade[] {
    return trades.filter((trade) => (
        trade.polymarketOutcome !== null
        && trade.polymarketOutcome !== undefined
    ));
}

function getPolymarketTradePayout(trade: Trade): number | null {
    const price = trade.polymarketOutcome?.marketEntryPrice;
    const isWin = trade.polymarketOutcome?.isWin;
    if (typeof price !== "number" || !Number.isFinite(price) || typeof isWin !== "boolean") {
        return null;
    }
    return isWin ? (1 - price) : -price;
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
    const wins = trades.filter((trade) => trade.polymarketOutcome?.isWin === true);
    const losses = trades.filter((trade) => trade.polymarketOutcome?.isWin === false);
    const totalProfit = wins.reduce((sum, trade) => sum + Math.max(0, getPolymarketTradePayout(trade) ?? 0), 0);
    const totalLoss = Math.abs(losses.reduce((sum, trade) => sum + Math.min(0, getPolymarketTradePayout(trade) ?? 0), 0));
    const netProfit = payouts.reduce((sum, value) => sum + value, 0);
    const tradeCount = payouts.length;
    const avgEntryPrice = entryPrices.length > 0 ? average(entryPrices) : 0;
    const breakEvenWinRate = avgEntryPrice * 100;
    const winRate = tradeCount > 0 ? (wins.length / tradeCount) * 100 : 0;

    return {
        label,
        tradeCount,
        winRate,
        netProfit,
        expectancy: tradeCount > 0 ? netProfit / tradeCount : 0,
        avgWin: wins.length > 0 ? totalProfit / wins.length : 0,
        avgLoss: losses.length > 0 ? totalLoss / losses.length : 0,
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

        const rangePosition = null; // trade.entrySnapshot?.priceRangePos;
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
    if (minuteRows.length > 0) {
        sections.push({
            id: "session_minute",
            title: minuteRows.length === 1
                ? (selectedEntryOffset !== null ? "Selected 5m Session Minute" : "Observed 5m Session Minute")
                : "By 5m Session Minute",
            hint: minuteRows.length === 1
                ? (selectedEntryOffset !== null
                    ? `This run is filtered to minute ${selectedEntryOffset} inside each rolling 5m event, so this shows the scored subset for that selected offset only. Exp is shown in cents per $1 share.`
                    : "This run executes on the native 5m chart, so scored entries naturally land on minute 0 of each event. Exp is shown in cents per $1 share.")
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
    private enabled = true;          // auto-show after backtest
    private visible = false;
    private jumpToTrade: ((time: Time) => void) | null = null;
    private sortNewestFirst = true;  // default: most recent trade on top
    private currentTrades: Trade[] = [];  // cached for re-sorting
    private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
    private tradeRenderGeneration = 0;
    private pendingDeferredRenderIds: number[] = [];
    private overlayRenderGeneration = 0;

    // ── Initialisation ─────────────────────────────────────

    init() {
        this.injectOverlay();
        this.bindToolbarButton();
        this.bindKeyboard();
    }

    /** Inject the overlay element inside .chart-wrapper */
    private injectOverlay() {
        const chartWrapper = document.querySelector('.chart-wrapper');
        if (!chartWrapper) return;

        const el = document.createElement('div');
        el.className = 'quick-view-overlay';
        el.id = 'quickViewOverlay';
        el.innerHTML = this.buildShell();
        chartWrapper.appendChild(el);
        this.overlay = el;

        // Close button
        el.querySelector('#qvCloseBtn')?.addEventListener('click', () => this.hide());

        // Sort toggle button
        el.querySelector('#qvSortToggle')?.addEventListener('click', () => {
            this.sortNewestFirst = !this.sortNewestFirst;
            this.renderTrades(this.currentTrades);
        });

        const tradesList = el.querySelector<HTMLElement>('#qvTradesList');
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

    private buildShell(): string {
        return `
            <div class="qv-header">
                <div class="qv-title">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                    </svg>
                    Quick View
                </div>
                <div style="display:flex;align-items:center;gap:12px;">
                    <span class="qv-hint">
                        <kbd>Esc</kbd> or click to close
                    </span>
                    <button class="qv-close-btn" id="qvCloseBtn" title="Close Quick View">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="qv-body">
                <div class="qv-results-pane" id="qvResultsPane">
                    <div class="qv-empty" id="qvEmpty">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                        </svg>
                        Run a backtest to see results
                    </div>
                    <div id="qvStatsContent" style="display:none;"></div>
                </div>
                <div class="qv-trades-pane">
                    <div class="qv-trades-header">
                        <span class="qv-trades-title">
                            Trades
                            <span class="qv-trades-count" id="qvTradesCount">0</span>
                        </span>
                        <button class="qv-sort-btn" id="qvSortToggle" title="Toggle sort order">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                                <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/>
                            </svg>
                            <span id="qvSortLabel">Newest first</span>
                        </button>
                    </div>
                    <div class="qv-trades-list" id="qvTradesList"></div>
                </div>
            </div>
        `;
    }

    // ── Toolbar button ─────────────────────────────────────

    private bindToolbarButton() {
        const btn = document.getElementById('quickViewBtn');
        if (!btn) return;

        // Sync initial state
        btn.classList.toggle('qv-active', this.enabled);

        btn.addEventListener('click', () => {
            if (this.visible) {
                this.hide();
            } else {
                // If we have results, show them; otherwise just toggle the auto-show flag
                if (state.currentBacktestResult) {
                    this.show(state.currentBacktestResult);
                } else {
                    this.enabled = !this.enabled;
                    btn.classList.toggle('qv-active', this.enabled);
                }
            }
        });
    }

    // ── Keyboard ───────────────────────────────────────────

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

    // ── Polymarket On-Demand Loading ───────────────────────

    private withPolymarketTradeSummary(
        result: BacktestResult,
        trades: Trade[],
        seriesId: string | null,
        options: {
            outcomeRowsLoaded?: number;
            selectedOffset?: number;
            missingOutcomeTrades?: number;
            unscoredTrades?: number;
        } = {}
    ): BacktestResult {
        const scoredTrades = trades.filter((trade) => trade.polymarketOutcome !== undefined && trade.polymarketOutcome !== null).length;
        const totalTrades = result.totalTrades > 0 ? result.totalTrades : trades.length;
        const fallbackOutcomeRowsLoaded = options.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(trades);
        const existingSummary = result.polymarketTradeSummary;

        return {
            ...result,
            trades,
            polymarketTradeSummary: {
                seriesId: existingSummary?.seriesId || seriesId || "",
                outcomeRowsLoaded: existingSummary?.outcomeRowsLoaded && existingSummary.outcomeRowsLoaded > 0
                    ? existingSummary.outcomeRowsLoaded
                    : fallbackOutcomeRowsLoaded,
                scoredTrades: existingSummary?.scoredTrades ?? scoredTrades,
                missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? options.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades),
                unscoredTrades: existingSummary?.unscoredTrades ?? options.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades),
                duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored,
                entryOffset: existingSummary?.entryOffset ?? options.selectedOffset,
                timingProfile: existingSummary?.timingProfile,
            },
        };
    }

    private resolveSelectedPolymarketEntryOffset(_result: BacktestResult): number {
        const element = document.getElementById("polymarketEntryOffset");
        const fallbackOffset = element instanceof HTMLSelectElement ? Number(element.value) : null;
        return fallbackOffset ?? 0;
    }

    private async ensurePolymarketOutcomes(result: BacktestResult): Promise<BacktestResult> {
        const resultContext = resolveBacktestResultMarketContext(result);
        if (!resultContext) {
            return result;
        }

        const hasOutcomes = result.trades.some((trade) => trade.polymarketOutcome !== undefined && trade.polymarketOutcome !== null);
        const seriesId = getPolymarket5mSeriesIdForSymbol(resultContext.symbol);
        if (result.polymarketTradeSummary) {
            return this.withPolymarketTradeSummary(result, result.trades, seriesId, {
                selectedOffset: result.polymarketTradeSummary.entryOffset,
            });
        }

        if (!supportsPolymarketOutcomeBridgeRun(resultContext.symbol, resultContext.interval)) {
            return result;
        }

        if (!seriesId) {
            return result;
        }

        // Collect entry times from trades
        const targetTimes = result.trades
            .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null);
        if (targetTimes.length === 0) {
            return result;
        }

        const startTs = Math.min(...targetTimes);
        const endTs = Math.max(...targetTimes);

        // Load outcomes from SQLite (uses in-memory cache)
        const outcomes = await loadPolymarket5mOutcomesForTimeRange(resultContext.symbol, startTs, endTs);
        if (outcomes.length === 0) {
            return hasOutcomes
                ? this.withPolymarketTradeSummary(result, result.trades, seriesId)
                : result;
        }

        const selectedOffset = resultContext.interval === "1m"
            ? this.resolveSelectedPolymarketEntryOffset(result)
            : undefined;
        const trades = hasOutcomes
            ? result.trades
            : annotateTradesWithPolymarketOutcomesForRun(
                result.trades,
                outcomes,
                resultContext.interval,
                selectedOffset
            );
        const summary = summarizePolymarketTradesForRun({
            trades: result.trades,
            outcomes,
            interval: resultContext.interval,
            selectedOffset,
        });

        return this.withPolymarketTradeSummary(result, trades, seriesId, {
            outcomeRowsLoaded: outcomes.length,
            selectedOffset,
            missingOutcomeTrades: summary.missingOutcomeTrades,
            unscoredTrades: summary.unscoredTrades,
        });
    }

    // ── Show / Hide ────────────────────────────────────────

    async show(result: BacktestResult) {
        if (!this.overlay) return;
        const renderGeneration = ++this.overlayRenderGeneration;

        // Load Polymarket outcomes on-demand for Quick View display
        // This keeps backtests fast by default while still enabling Polymarket analysis in Quick View
        const enrichedResult = await this.ensurePolymarketOutcomes(result);
        if (renderGeneration !== this.overlayRenderGeneration) {
            return;
        }

        this.renderResults(enrichedResult);
        this.renderTrades(enrichedResult.trades);

        // Force a reflow before adding the visible class for CSS transition
        this.overlay.style.display = 'flex';
        this.overlay.offsetHeight; // trigger reflow
        this.overlay.classList.add('is-visible');
        this.visible = true;

        const btn = document.getElementById('quickViewBtn');
        if (btn) btn.classList.add('qv-active');
    }

    hide() {
        if (!this.overlay) return;
        this.overlayRenderGeneration += 1;

        this.overlay.classList.remove('is-visible');
        // Wait for transition to finish before hiding
        setTimeout(() => {
            if (this.overlay && !this.overlay.classList.contains('is-visible')) {
                this.overlay.style.display = 'none';
            }
        }, 260);
        this.visible = false;

        const btn = document.getElementById('quickViewBtn');
        // Keep the button active if auto-show is still enabled
        if (btn) btn.classList.toggle('qv-active', this.enabled);
    }

    /** Called from state subscription when backtest finishes */
    async onBacktestComplete(result: BacktestResult) {
        if (this.enabled) {
            await this.show(result);
        }
    }

    /** Provide the jump-to-trade callback so clicking trades works */
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

    // ── Rendering ──────────────────────────────────────────

    private renderResults(result: BacktestResult) {
        const content = document.getElementById('qvStatsContent');
        const empty = document.getElementById('qvEmpty');
        if (!content || !empty) return;

        empty.style.display = 'none';
        content.style.display = 'block';

        const resultContext = resolveBacktestResultMarketContext(result);
        const isPolymarketMarket = Boolean(resultContext && isPolymarketEventSymbol(resultContext.symbol));
        const polymarketPayoutSummary = isPolymarketMarket ? summarizePolymarketPayoutDiagnostics(result.trades) : null;
        const performanceExpectancyLabel = polymarketPayoutSummary ? 'Polymarket Exp / Trade' : 'Expectancy';
        const performanceExpectancyValue = polymarketPayoutSummary
            ? this.formatPolymarketCents(polymarketPayoutSummary.expectancy)
            : `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`;
        const performanceExpectancyTone = polymarketPayoutSummary
            ? polymarketPayoutSummary.expectancy
            : result.expectancy;
        const isPositive = result.netProfit >= 0;
        const pfText = result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2);
        const polymarketSection = this.buildPolymarketSection(result);

        content.innerHTML = `
            <div class="qv-section-title">Performance</div>
            <div class="qv-stats-grid">
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Net Profit</div>
                    <div class="qv-stat-value ${isPositive ? 'positive' : 'negative'}">
                        $${result.netProfit.toFixed(2)}
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Net Profit %</div>
                    <div class="qv-stat-value ${isPositive ? 'positive' : 'negative'}">
                        ${result.netProfitPercent.toFixed(2)}%
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Win Rate</div>
                    <div class="qv-stat-value">${result.winRate.toFixed(1)}%</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Profit Factor</div>
                    <div class="qv-stat-value">${pfText}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">${performanceExpectancyLabel}</div>
                    <div class="qv-stat-value ${performanceExpectancyTone >= 0 ? 'positive' : 'negative'}">
                        ${performanceExpectancyValue}
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Max Drawdown</div>
                    <div class="qv-stat-value negative">${result.maxDrawdownPercent.toFixed(2)}%</div>
                </div>
            </div>

            <div class="qv-section-title">Trade Stats</div>
            <div class="qv-stats-grid">
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Total Trades</div>
                    <div class="qv-stat-value">${result.totalTrades}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Avg Trade</div>
                    <div class="qv-stat-value ${result.avgTrade >= 0 ? 'positive' : 'negative'}">
                        $${result.avgTrade.toFixed(2)}
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Winning</div>
                    <div class="qv-stat-value positive">${result.winningTrades}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Losing</div>
                    <div class="qv-stat-value negative">${result.losingTrades}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Avg Win</div>
                    <div class="qv-stat-value positive">$${result.avgWin.toFixed(2)}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Avg Loss</div>
                    <div class="qv-stat-value negative">$${result.avgLoss.toFixed(2)}</div>
                </div>
                <div class="qv-stat-card full-width">
                    <div class="qv-stat-label">Sharpe Ratio</div>
                    <div class="qv-stat-value">${result.sharpeRatio.toFixed(2)}</div>
                </div>
            </div>
            ${polymarketSection}
        `;
    }

    private renderTrades(trades: Trade[]) {
        this.currentTrades = trades;
        const list = document.getElementById('qvTradesList') as HTMLElement;
        const count = document.getElementById('qvTradesCount');
        const sortLabel = document.getElementById('qvSortLabel');
        if (!list) return;
        this.cancelPendingDeferredRenders();
        this.tradeRenderGeneration += 1;
        if (count) count.textContent = String(trades.length);
        if (sortLabel) sortLabel.textContent = this.sortNewestFirst ? 'Newest first' : 'Oldest first';

        if (trades.length === 0) {
            list.innerHTML = `
                <div class="qv-empty">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6h-6z"/>
                    </svg>
                    No trades
                </div>
            `;
            return;
        }

        // Sort: newest first (reversed) or oldest first (original order)
        const sorted = this.sortNewestFirst ? [...trades].reverse() : trades;
        const toRender = sorted.slice(0, QuickViewManager.MAX_RENDERED_TRADES);
        const limitNotice = trades.length > QuickViewManager.MAX_RENDERED_TRADES
            ? this.renderTradesLimitNotice(trades.length)
            : '';
        this.renderTradesProgressively(this.tradeRenderGeneration, list, toRender, limitNotice);
        return;

        list.innerHTML = sorted.map(trade => {
            const isWin = trade.pnl > 0;
            const pnlClass = isWin ? 'positive' : 'negative';
            const pnlSign = isWin ? '+' : '';
            const entryDate = this.formatTradeTime(trade.entryTime);
            const exitReason = trade.exitReason ? this.formatExitReason(trade.exitReason) : '';

            return `
                <div class="qv-trade-item" data-entry-time="${typeof trade.entryTime === 'object' ? JSON.stringify(trade.entryTime) : trade.entryTime}">
                    <span class="qv-trade-type ${trade.type}">${trade.type}</span>
                    <span class="qv-trade-prices">
                        ${this.fmtPrice(trade.entryPrice)} → ${this.fmtPrice(trade.exitPrice)}
                    </span>
                    <span class="qv-trade-date">
                        ${entryDate}
                        ${exitReason}
                    </span>
                    <span class="qv-trade-pnl ${pnlClass}">
                        ${pnlSign}$${trade.pnl.toFixed(2)} (${pnlSign}${trade.pnlPercent.toFixed(2)}%)
                    </span>
                </div>
            `;
        }).join('');

        // Bind click handlers for jumping to trade on chart
        list.querySelectorAll('.qv-trade-item').forEach((item) => {
            item.addEventListener('click', () => {
                const raw = (item as HTMLElement).dataset.entryTime;
                if (!raw || !this.jumpToTrade) return;

                let time: Time;
                try {
                    time = JSON.parse(raw) as Time;
                } catch {
                    time = (isNaN(Number(raw)) ? raw : Number(raw)) as Time;
                }

                this.jumpToTrade(time);
                this.hide();
            });
        });
    }

    // ── Helpers ─────────────────────────────────────────────

    private renderTradesProgressively(
        renderGeneration: number,
        list: HTMLElement,
        trades: Trade[],
        limitNoticeHtml: string
    ): void {
        const initialCount = Math.min(trades.length, QuickViewManager.INITIAL_TRADE_BATCH_SIZE);
        list.innerHTML = this.renderTradeChunk(trades, 0, initialCount);

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
                this.renderTradeChunk(trades, offset, nextOffset)
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

    private renderTradeChunk(trades: Trade[], startIndex: number, endIndex: number): string {
        let html = '';
        for (let index = startIndex; index < endIndex; index += 1) {
            html += this.renderTradeItem(trades[index]);
        }
        return html;
    }

    private renderTradeItem(trade: Trade): string {
        const isWin = trade.pnl > 0;
        const pnlClass = isWin ? 'positive' : 'negative';
        const pnlSign = isWin ? '+' : '';
        const entryDate = this.formatTradeTime(trade.entryTime);
        const exitReason = trade.exitReason ? this.formatExitReason(trade.exitReason) : '';

        return `
            <div class="qv-trade-item" data-entry-time="${typeof trade.entryTime === 'object' ? JSON.stringify(trade.entryTime) : trade.entryTime}" role="button" tabindex="0">
                <span class="qv-trade-type ${trade.type}">${trade.type}</span>
                <span class="qv-trade-prices">
                    ${this.fmtPrice(trade.entryPrice)} -> ${this.fmtPrice(trade.exitPrice)}
                </span>
                <span class="qv-trade-date">
                    ${entryDate}
                    ${exitReason}
                </span>
                <span class="qv-trade-pnl ${pnlClass}">
                    ${pnlSign}$${trade.pnl.toFixed(2)} (${pnlSign}${trade.pnlPercent.toFixed(2)}%)
                </span>
            </div>
        `;
    }

    private renderTradesLimitNotice(totalTrades: number): string {
        return `<div class="qv-empty">Showing ${QuickViewManager.MAX_RENDERED_TRADES} of ${totalTrades} trades</div>`;
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

    

    private buildPolymarketTimingProfileSection(summary: QuickViewPolymarketSummary): string {
        const timingProfile = summary.timingProfile ?? [];
        if (timingProfile.length === 0) return '';
        const bestOffset = summary.bestTimingProfile?.entryOffset;
        const rows = timingProfile.map((entry) => `
            <div class="qv-poly-profile-row ${entry.entryOffset === bestOffset ? 'is-best' : ''} ${entry.entryOffset === summary.entryOffset ? 'is-selected' : ''}">
                <div class="qv-poly-profile-cell qv-poly-profile-cell--offset">Minute ${entry.entryOffset}</div>
                <div class="qv-poly-profile-cell">${(entry.winRate * 100).toFixed(1)}%</div>
                <div class="qv-poly-profile-cell">${entry.scoredTrades}</div>
                <div class="qv-poly-profile-cell">${(entry.coverage * 100).toFixed(1)}%</div>
                <div class="qv-poly-profile-cell">${entry.duplicateTradesIgnored}</div>
            </div>
        `).join('');
        return `
            <div class="qv-stat-card full-width qv-poly-meta-card">
                <div class="qv-stat-label">Entry Timing Profile (1m -> 5m)</div>
                <div class="qv-poly-profile-grid">
                    <div class="qv-poly-profile-row qv-poly-profile-row--header">
                        <div class="qv-poly-profile-cell qv-poly-profile-cell--offset">Offset</div>
                        <div class="qv-poly-profile-cell">Win Rate</div>
                        <div class="qv-poly-profile-cell">Scored</div>
                        <div class="qv-poly-profile-cell">Coverage</div>
                        <div class="qv-poly-profile-cell">Dupes</div>
                    </div>
                    ${rows}
                </div>
            </div>
        `;
    }

    private getBestTimingProfileEntry(
        timingProfile: readonly import("./types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry[]
    ): import("./types/polymarket-outcomes").BacktestPolymarketTimingProfileEntry | null {
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
        const wins = result.trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
        const losses = result.trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
        const scoredTrades = wins + losses;
        const summary = result.polymarketTradeSummary;

        if (!summary && scoredTrades === 0) return null;

        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const missingTrades = summary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades);
        const unscoredTrades = summary?.unscoredTrades ?? Math.max(0, totalTrades - scoredTrades);
        const coverageBase = Math.max(0, scoredTrades + unscoredTrades);
        const coverage = coverageBase > 0 ? scoredTrades / coverageBase : 0;
        const bestBaselineWinRate = computePolymarketBestBaselineWinRate(result.trades);
        const timingProfile = summary?.timingProfile;
        const bestTimingProfile = timingProfile ? this.getBestTimingProfileEntry(timingProfile) : null;
        const payoutSummary = summarizePolymarketPayoutDiagnostics(result.trades);
        const streakSummary = summarizePolymarketStreaks(result.trades);
        const recentFormSummary = summarizeRecentPolymarketForm(result.trades, 50);
        const exitReasonWinRates = summarizePolymarketExitReasonWinRates(result.trades);
        const afterTakeProfitExpectancy = summarizePolymarketExpectancyAfterTakeProfit(result.trades);

        return {
            wins, losses, scoredTrades, missingTrades, unscoredTrades, coverage,
            winRate: scoredTrades > 0 ? wins / scoredTrades : 0,
            expectancy: payoutSummary?.expectancy ?? null,
            outcomeRowsLoaded: summary?.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(result.trades),
            bestBaselineWinRate,
            baselineDelta: (scoredTrades > 0 ? wins / scoredTrades : 0) - bestBaselineWinRate,
            longestWinStreak: streakSummary.longestWinStreak,
            longestLossStreak: streakSummary.longestLossStreak,
            recentFormTrades: recentFormSummary.recentFormTrades,
            recentFormWins: recentFormSummary.recentFormWins,
            recentFormLosses: recentFormSummary.recentFormLosses,
            recentFormWinRate: recentFormSummary.recentFormWinRate,
            exitReasonWinRates, afterTakeProfitExpectancy,
            entryOffset: summary?.entryOffset,
            timingProfile, bestTimingProfile,
        };
    }



    private renderPolymarketExitReasonWinRateCard(
        label: string,
        summary: QuickViewPolymarketExitReasonSummary
    ): string {
        const value = summary.trades > 0
            ? `${(summary.winRate * 100).toFixed(1)}% | ${summary.trades}t`
            : 'n/a';
        const toneClass = summary.trades > 0
            ? (summary.winRate >= 0.5 ? 'positive' : 'negative')
            : '';

        return `
            <div class="qv-stat-card">
                <div class="qv-stat-label">${label}</div>
                <div class="qv-stat-value ${toneClass}">${value}</div>
            </div>
        `;
    }

    private renderPolymarketExpectancyCard(
        label: string,
        summary: QuickViewPolymarketExpectancySummary
    ): string {
        const expectancyValue = summary.expectancy;
        const hasData = summary.pricedTrades > 0 && expectancyValue !== null;
        const value = hasData
            ? `${this.formatPolymarketCents(expectancyValue)} | ${summary.pricedTrades}t`
            : "n/a";
        const toneClass = hasData
            ? (expectancyValue >= 0 ? "positive" : "negative")
            : "";

        return `
            <div class="qv-stat-card">
                <div class="qv-stat-label">${label}</div>
                <div class="qv-stat-value ${toneClass}">${value}</div>
            </div>
        `;
    }

    private buildPolymarketSection(result: BacktestResult): string {
        const summary = this.getPolymarketSummary(result);
        if (!summary) return '';
        const offsetSummary = typeof summary.entryOffset === 'number'
            ? `Selected Offset: Minute ${summary.entryOffset}`
            : 'Run Mode: Native 5m scoring';
        const timingProfileSection = summary.timingProfile && summary.timingProfile.length > 0
            ? this.buildPolymarketTimingProfileSection(summary)
            : '';
        const diagnosticsNote = `
            <div class="qv-stat-card full-width qv-poly-meta-card">
                <div class="qv-stat-label">Detailed Diagnostics</div>
                <div class="qv-diagnostic-hint">Payout summary, timing buckets, snapshot profile, and PM filter suggestions now live in the Polymarket tab for readability.</div>
            </div>
        `;

        return `
            <div class="qv-section-title">Polymarket</div>
            <div class="qv-stats-grid">
                <div class="qv-stat-card full-width qv-poly-meta-card">
                    <div class="qv-stat-label">${offsetSummary}</div>
                    <div class="qv-stat-value">${summary.bestTimingProfile ? `Best Minute ${summary.bestTimingProfile.entryOffset} (${(summary.bestTimingProfile.winRate * 100).toFixed(1)}%)` : 'See Polymarket tab for full diagnostics'}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Win Rate</div>
                    <div class="qv-stat-value ${summary.winRate >= 0.5 ? 'positive' : 'negative'}">
                        ${(summary.winRate * 100).toFixed(1)}%
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Exp / Trade</div>
                    <div class="qv-stat-value ${summary.expectancy === null ? '' : (summary.expectancy >= 0 ? 'positive' : 'negative')}">
                        ${summary.expectancy === null ? 'n/a' : this.formatPolymarketCents(summary.expectancy)}
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Scored Trade Share</div>
                    <div class="qv-stat-value">${(summary.coverage * 100).toFixed(1)}%</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Wins</div>
                    <div class="qv-stat-value positive">${summary.wins}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Losses</div>
                    <div class="qv-stat-value negative">${summary.losses}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Baseline Delta</div>
                    <div class="qv-stat-value ${summary.baselineDelta >= 0 ? 'positive' : 'negative'}">
                        ${summary.baselineDelta >= 0 ? '+' : ''}${(summary.baselineDelta * 100).toFixed(1)}pp
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Max Win Streak</div>
                    <div class="qv-stat-value positive">${summary.longestWinStreak}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Max Loss Streak</div>
                    <div class="qv-stat-value negative">${summary.longestLossStreak}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Last 50 W/L</div>
                    <div class="qv-stat-value ${summary.recentFormTrades === 0 ? '' : (summary.recentFormWinRate >= 0.5 ? 'positive' : 'negative')}">
                        ${summary.recentFormTrades === 0 ? 'n/a' : `${summary.recentFormWins} win - ${summary.recentFormLosses} lose`}
                    </div>
                </div>
                ${this.renderPolymarketExitReasonWinRateCard('Entry Win % | After Max Hold', summary.exitReasonWinRates.maxHold)}
                ${this.renderPolymarketExitReasonWinRateCard('Entry Win % | After TP', summary.exitReasonWinRates.takeProfit)}
                ${this.renderPolymarketExpectancyCard('Entry Exp / Trade | After TP', summary.afterTakeProfitExpectancy)}
                ${this.renderPolymarketExitReasonWinRateCard('Entry Win % | After Signal', summary.exitReasonWinRates.signal)}
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Scored Trades</div>
                    <div class="qv-stat-value">${summary.scoredTrades}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Unscored Trades</div>
                    <div class="qv-stat-value">${summary.unscoredTrades}</div>
                </div>
                ${summary.missingTrades > 0 ? `
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Missing Outcome Rows</div>
                    <div class="qv-stat-value">${summary.missingTrades}</div>
                </div>
                ` : ''}
                <div class="qv-stat-card full-width qv-poly-meta-card">
                    <div class="qv-stat-label">Outcome Rows Fetched</div>
                    <div class="qv-stat-value">${summary.outcomeRowsLoaded}</div>
                </div>
                ${diagnosticsNote}
                ${timingProfileSection}
            </div>
        `;
    }

    private fmtPrice(price: number): string {
        return formatDisplayPrice(price);
    }

    private formatPolymarketCents(value: number): string {
        const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
        return `${prefix}${(Math.abs(value) * 100).toFixed(1)}c`;
    }

    private formatTradeTime(time: Time): string {
        if (typeof time === 'number') {
            const d = new Date(time * 1000);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
        }
        if (typeof time === 'string') {
            return time;
        }
        // BusinessDay
        const bd = time as { year: number; month: number; day: number };
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[bd.month - 1]} ${bd.day}, ${String(bd.year).slice(-2)}`;
    }

    private formatExitReason(reason: string): string {
        const labels: Record<string, string> = {
            'stop_loss': 'SL',
            'take_profit': 'TP',
            'trailing_stop': 'TS',
            'end_of_data': 'EOD',
            'signal': 'SIG',
            'timeout': 'TO',
        };
        const label = labels[reason] || reason.slice(0, 4).toUpperCase();
        return `<span class="qv-exit-badge">${label}</span>`;
    }
}

export const quickViewManager = new QuickViewManager();
