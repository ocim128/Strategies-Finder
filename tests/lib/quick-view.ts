/**
 * Quick View — an overlay that shows Results + Trades directly over the chart.
 *
 * Toggle button lives in the toolbar (next to "Copy Chart").
 * When enabled, every backtest completion auto-shows the overlay.
 * Press Esc or click the close button to dismiss.
 * Click the toolbar button anytime to manually toggle.
 */

import { state } from "./state";
import type { BacktestResult, Trade } from "./strategies/index";
import { Time } from "lightweight-charts";
import { formatDisplayPrice } from "./price-format";
import type { BacktestPolymarketTimingProfileEntry } from "./types/polymarket-outcomes";
import {
    getPolymarket5mSeriesIdForSymbol,
    loadPolymarket5mOutcomesForTimeRange,
    supportsPolymarketOutcomeBridgeRun,
} from "./polymarket-btc5m";
import {
    annotateTradesWithPolymarketOutcomesForRun,
} from "./polymarket-trade-annotations";
import { resolveBacktestResultMarketContext } from "./backtest-result-context";
import { parseTimeToUnixSeconds } from "./time-normalization";

type QuickViewPolymarketSummary = {
    wins: number;
    losses: number;
    scoredTrades: number;
    missingTrades: number;
    coverage: number;
    winRate: number;
    outcomeRowsLoaded: number;
    longestWinStreak: number;
    longestLossStreak: number;
    recentFormTrades: number;
    recentFormWins: number;
    recentFormLosses: number;
    recentFormWinRate: number;
    bestBaselineWinRate: number;
    baselineDelta: number;
    bestWinStreakLast100Trades: number;
    entryOffset?: number;
    timingProfile?: BacktestPolymarketTimingProfileEntry[];
    bestTimingProfile?: BacktestPolymarketTimingProfileEntry | null;
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
        outcomeRowsLoaded?: number,
        selectedOffset?: number
    ): BacktestResult {
        const scoredTrades = trades.filter((trade) => trade.polymarketOutcome !== undefined && trade.polymarketOutcome !== null).length;
        const totalTrades = result.totalTrades > 0 ? result.totalTrades : trades.length;
        const fallbackOutcomeRowsLoaded = outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(trades);
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
                missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades),
                duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored,
                entryOffset: existingSummary?.entryOffset ?? selectedOffset,
                timingProfile: existingSummary?.timingProfile,
            },
        };
    }

    private resolveSelectedPolymarketEntryOffset(result: BacktestResult): number {
        const summaryOffset = result.polymarketTradeSummary?.entryOffset;
        if (typeof summaryOffset === "number" && Number.isFinite(summaryOffset)) {
            return Math.max(0, Math.min(4, Math.floor(summaryOffset)));
        }

        const element = document.getElementById("polymarketEntryOffset");
        if (element instanceof HTMLSelectElement) {
            const value = Number(element.value);
            if (Number.isFinite(value)) {
                return Math.max(0, Math.min(4, Math.floor(value)));
            }
        }

        return 0;
    }

    private async ensurePolymarketOutcomes(result: BacktestResult): Promise<BacktestResult> {
        const resultContext = resolveBacktestResultMarketContext(result);
        if (!resultContext) {
            return result;
        }

        // Check if already annotated
        const hasOutcomes = result.trades.some((trade) => trade.polymarketOutcome !== undefined && trade.polymarketOutcome !== null);
        const seriesId = getPolymarket5mSeriesIdForSymbol(resultContext.symbol);
        if (hasOutcomes || result.polymarketTradeSummary) {
            return this.withPolymarketTradeSummary(result, result.trades, seriesId, undefined, result.polymarketTradeSummary?.entryOffset);
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
            return result;
        }

        const selectedOffset = resultContext.interval === "1m"
            ? this.resolveSelectedPolymarketEntryOffset(result)
            : undefined;
        const trades = annotateTradesWithPolymarketOutcomesForRun(
            result.trades,
            outcomes,
            resultContext.interval,
            selectedOffset
        );

        return this.withPolymarketTradeSummary(result, trades, seriesId, outcomes.length, selectedOffset);
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

        const isPositive = result.netProfit >= 0;
        const pfText = result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2);
        const expectancySign = result.expectancy >= 0 ? '+' : '';
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
                    <div class="qv-stat-label">Expectancy</div>
                    <div class="qv-stat-value ${result.expectancy >= 0 ? 'positive' : 'negative'}">
                        ${expectancySign}$${result.expectancy.toFixed(2)}
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

    private buildPolymarketSection(result: BacktestResult): string {
        const summary = this.getPolymarketSummary(result);
        if (!summary) return '';
        const offsetSummary = typeof summary.entryOffset === 'number'
            ? `Selected Offset: Minute ${summary.entryOffset}`
            : 'Selected Offset: n/a';
        const timingProfileSection = summary.timingProfile && summary.timingProfile.length > 0
            ? this.buildPolymarketTimingProfileSection(summary)
            : '';

        return `
            <div class="qv-section-title">Polymarket</div>
            <div class="qv-stats-grid">
                <div class="qv-stat-card full-width qv-poly-meta-card">
                    <div class="qv-stat-label">${offsetSummary}</div>
                    <div class="qv-stat-value">${summary.bestTimingProfile ? `Best Minute ${summary.bestTimingProfile.entryOffset} (${(summary.bestTimingProfile.winRate * 100).toFixed(1)}%)` : 'Single-offset summary'}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Poly Win Rate</div>
                    <div class="qv-stat-value ${summary.winRate >= 0.5 ? 'positive' : 'negative'}">
                        ${(summary.winRate * 100).toFixed(1)}%
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Trade Coverage</div>
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
                    <div class="qv-stat-label">Longest Win Streak</div>
                    <div class="qv-stat-value positive">${summary.longestWinStreak}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Longest Loss Streak</div>
                    <div class="qv-stat-value negative">${summary.longestLossStreak}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Recent Form (Last ${summary.recentFormTrades})</div>
                    <div class="qv-stat-value ${summary.recentFormWinRate >= 0.5 ? 'positive' : 'negative'}">
                        ${summary.recentFormWins}-${summary.recentFormLosses} (${(summary.recentFormWinRate * 100).toFixed(1)}%)
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Baseline Delta</div>
                    <div class="qv-stat-value ${summary.baselineDelta >= 0 ? 'positive' : 'negative'}">
                        ${summary.baselineDelta >= 0 ? '+' : ''}${(summary.baselineDelta * 100).toFixed(1)}pp
                    </div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Best Win Streak (Last 100)</div>
                    <div class="qv-stat-value positive">${summary.bestWinStreakLast100Trades}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Scored Trades</div>
                    <div class="qv-stat-value">${summary.scoredTrades}</div>
                </div>
                <div class="qv-stat-card">
                    <div class="qv-stat-label">Missing Rows</div>
                    <div class="qv-stat-value">${summary.missingTrades}</div>
                </div>
                <div class="qv-stat-card full-width qv-poly-meta-card">
                    <div class="qv-stat-label">Outcome Rows Loaded</div>
                    <div class="qv-stat-value">${summary.outcomeRowsLoaded}</div>
                </div>
                ${timingProfileSection}
            </div>
        `;
    }

    private buildPolymarketTimingProfileSection(summary: QuickViewPolymarketSummary): string {
        const timingProfile = summary.timingProfile ?? [];
        if (timingProfile.length === 0) {
            return '';
        }

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
        timingProfile: readonly BacktestPolymarketTimingProfileEntry[]
    ): BacktestPolymarketTimingProfileEntry | null {
        if (timingProfile.length === 0) {
            return null;
        }

        const scoredEntries = timingProfile.filter((entry) => entry.scoredTrades > 0);
        if (scoredEntries.length === 0) {
            return null;
        }

        return [...scoredEntries].sort((left, right) => {
            if (right.winRate !== left.winRate) {
                return right.winRate - left.winRate;
            }
            if (right.scoredTrades !== left.scoredTrades) {
                return right.scoredTrades - left.scoredTrades;
            }
            return left.entryOffset - right.entryOffset;
        })[0] ?? null;
    }

    private getPolymarketSummary(result: BacktestResult): QuickViewPolymarketSummary | null {
        const wins = result.trades.filter((trade) => trade.polymarketOutcome?.isWin === true).length;
        const losses = result.trades.filter((trade) => trade.polymarketOutcome?.isWin === false).length;
        const scoredTrades = wins + losses;
        const summary = result.polymarketTradeSummary;

        if (!summary && scoredTrades === 0) {
            return null;
        }

        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const missingTrades = summary?.missingOutcomeTrades ?? Math.max(0, totalTrades - scoredTrades);
        const coverageBase = Math.max(0, scoredTrades + missingTrades);
        const coverage = coverageBase > 0 ? scoredTrades / coverageBase : 0;
        const { longestWinStreak, longestLossStreak } = summarizePolymarketStreaks(result.trades);
        const recentForm = summarizeRecentPolymarketForm(result.trades, 20);
        const bestBaselineWinRate = computePolymarketBestBaselineWinRate(result.trades);
        const bestWinStreakLast100Trades = summarizePolymarketStreaks(result.trades.slice(-100)).longestWinStreak;
        const timingProfile = summary?.timingProfile;
        const bestTimingProfile = timingProfile ? this.getBestTimingProfileEntry(timingProfile) : null;

        return {
            wins,
            losses,
            scoredTrades,
            missingTrades,
            coverage,
            winRate: scoredTrades > 0 ? wins / scoredTrades : 0,
            outcomeRowsLoaded: summary?.outcomeRowsLoaded ?? countDistinctPolymarketOutcomeRows(result.trades),
            longestWinStreak,
            longestLossStreak,
            recentFormTrades: recentForm.recentFormTrades,
            recentFormWins: recentForm.recentFormWins,
            recentFormLosses: recentForm.recentFormLosses,
            recentFormWinRate: recentForm.recentFormWinRate,
            bestBaselineWinRate,
            baselineDelta: (scoredTrades > 0 ? wins / scoredTrades : 0) - bestBaselineWinRate,
            bestWinStreakLast100Trades,
            entryOffset: summary?.entryOffset,
            timingProfile,
            bestTimingProfile,
        };
    }

    private fmtPrice(price: number): string {
        return formatDisplayPrice(price);
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
