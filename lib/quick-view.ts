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

class QuickViewManager {
    private overlay: HTMLElement | null = null;
    private enabled = true;          // auto-show after backtest
    private visible = false;
    private jumpToTrade: ((time: Time) => void) | null = null;
    private sortNewestFirst = true;  // default: most recent trade on top
    private currentTrades: Trade[] = [];  // cached for re-sorting

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
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.visible) {
                e.preventDefault();
                e.stopPropagation();
                this.hide();
            }
        });
    }

    // ── Show / Hide ────────────────────────────────────────

    show(result: BacktestResult) {
        if (!this.overlay) return;

        this.renderResults(result);
        this.renderTrades(result.trades);

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
    onBacktestComplete(result: BacktestResult) {
        if (this.enabled) {
            this.show(result);
        }
    }

    /** Provide the jump-to-trade callback so clicking trades works */
    setJumpToTrade(fn: (time: Time) => void) {
        this.jumpToTrade = fn;
    }

    get isVisible() {
        return this.visible;
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
        `;
    }

    private renderTrades(trades: Trade[]) {
        this.currentTrades = trades;
        const list = document.getElementById('qvTradesList');
        const count = document.getElementById('qvTradesCount');
        const sortLabel = document.getElementById('qvSortLabel');
        if (!list) return;
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

    private fmtPrice(price: number): string {
        if (price >= 1000) return price.toFixed(2);
        if (price >= 1) return price.toFixed(4);
        return price.toFixed(6);
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
