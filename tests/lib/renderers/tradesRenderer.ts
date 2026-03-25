import { Time } from "lightweight-charts";
import { OHLCVData, Trade } from "../strategies/index";
import { setVisible } from "../dom-utils";
import { state } from "../state";
import { resolveOpenTradeDisplayMetrics } from "../open-trade-display";
import { createTradesRendererDom, type TradesRendererDom } from "./trades-renderer-dom";

export class TradesRenderer {
    private dom: TradesRendererDom | null = null;
    private jumpToTrade: ((time: Time) => void) | null = null;
    private jumpHandlersBound = false;

    private getDom(): TradesRendererDom {
        return this.dom ??= createTradesRendererDom();
    }

    public render(
        trades: Trade[],
        jumpToTrade: (time: Time) => void,
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ) {
        const container = this.getDom().tradesList;
        this.jumpToTrade = jumpToTrade;
        this.ensureTradeJumpHandlersBound();
        container.classList.remove('trades-list-parity');

        if (trades.length === 0) {
            setVisible('emptyTrades', true);
            setVisible('tradesSummary', false);
            container.innerHTML = '';
            return;
        }

        setVisible('emptyTrades', false);
        setVisible('tradesSummary', true);
        this.updateSummary(trades);

        container.innerHTML = this.renderTradeItems(trades, formatPrice, formatDate);
    }

    public renderParity(
        oddTrades: Trade[],
        evenTrades: Trade[],
        jumpToTrade: (time: Time) => void,
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ): void {
        const container = this.getDom().tradesList;
        this.jumpToTrade = jumpToTrade;
        this.ensureTradeJumpHandlersBound();
        container.classList.add('trades-list-parity');

        const combined = [...oddTrades, ...evenTrades];
        if (combined.length === 0) {
            setVisible('emptyTrades', true);
            setVisible('tradesSummary', false);
            container.innerHTML = '';
            return;
        }

        setVisible('emptyTrades', false);
        setVisible('tradesSummary', true);
        this.updateSummary(combined);

        const renderParitySection = (label: 'odd' | 'even', trades: Trade[]): string => {
            const sectionBody = trades.length > 0
                ? this.renderTradeItems(trades, formatPrice, formatDate)
                : '<div class="trades-parity-empty">No trades</div>';
            return `
                <div class="trades-parity-column">
                    <div class="trades-parity-header">
                        <span>${label.toUpperCase()} Universe</span>
                        <span>${trades.length} trade${trades.length === 1 ? '' : 's'}</span>
                    </div>
                    <div class="trades-parity-list">
                        ${sectionBody}
                    </div>
                </div>
            `;
        };

        container.innerHTML = `
            <div class="trades-parity-grid">
                ${renderParitySection('odd', oddTrades)}
                ${renderParitySection('even', evenTrades)}
            </div>
        `;
    }

    private formatDuration(ms: number): string {
        if (ms < 0) return '-';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    private getExitReasonBadge(exitReason: Trade['exitReason']): string {
        if (!exitReason) return '';

        const reasonMap: Record<NonNullable<Trade['exitReason']>, { label: string; className: string; icon: string }> = {
            signal: { label: 'Signal', className: 'exit-reason-badge--signal', icon: 'SIG' },
            stop_loss: { label: 'SL', className: 'exit-reason-badge--stop-loss', icon: 'SL' },
            take_profit: { label: 'TP', className: 'exit-reason-badge--take-profit', icon: 'TP' },
            trailing_stop: { label: 'Trail', className: 'exit-reason-badge--trailing-stop', icon: 'TRL' },
            time_stop: { label: 'Time', className: 'exit-reason-badge--time-stop', icon: 'T' },
            partial: { label: 'Partial', className: 'exit-reason-badge--partial', icon: '1/2' },
            probation_fail: { label: 'Guard', className: 'exit-reason-badge--probation-fail', icon: 'GRD' },
            end_of_data: { label: 'EOD', className: 'exit-reason-badge--end-of-data', icon: 'EOD' },
        };

        const info = reasonMap[exitReason];
        if (!info) return '';

        return `<span class="exit-reason-badge ${info.className}" title="Exit: ${info.label}">${info.icon}</span>`;
    }

    private getPolymarketOutcomeBadge(trade: Trade): string {
        const outcome = trade.polymarketOutcome;
        if (!outcome) return '';

        const label = outcome.isWin ? 'Poly Win' : 'Poly Lose';
        const className = outcome.isWin
            ? 'exit-reason-badge--polymarket-win'
            : 'exit-reason-badge--polymarket-lose';
        const actual = outcome.actualOutcomeUp === 1 ? 'UP' : 'DOWN';
        const prediction = outcome.prediction.toUpperCase();
        const marketSlug = this.escapeHtml(outcome.marketSlug);
        const marketUrl = this.escapeHtml(this.buildPolymarketMarketUrl(outcome.marketSlug));
        return `<span class="exit-reason-badge trade-polymarket-link ${className}" role="button" tabindex="0" data-polymarket-url="${marketUrl}" title="Polymarket ${label}. Predicted ${prediction}, resolved ${actual}. Click to copy ${marketSlug}.">${label}</span>`;
    }

    private encodeTradeEntryTime(time: Time): string {
        return encodeURIComponent(JSON.stringify(time));
    }

    private renderTradeItems(trades: Trade[], formatPrice: (p: number) => string, formatDate: (t: Time) => string): string {
        return trades.slice().reverse().map((trade) => this.renderTradeItem(trade, formatPrice, formatDate)).join('');
    }

    private renderTradeItem(trade: Trade, formatPrice: (p: number) => string, formatDate: (t: Time) => string): string {
        const display = this.getDisplayTradeMetrics(trade);
        const isProfit = display.pnl >= 0;
        const statusClass = isProfit ? 'win' : 'loss';
        const duration = this.formatDuration(display.durationMs);
        const fees = trade.fees ? `Fees: $${trade.fees.toFixed(2)}` : '';
        const entryValue = trade.size * trade.entryPrice;
        const sizeLabel = Number.isFinite(entryValue) && entryValue > 0
            ? `Entry Value: $${entryValue.toFixed(2)} | Qty: ${trade.size.toFixed(4)}`
            : `Qty: ${trade.size.toFixed(4)}`;
        const exitReasonBadge = this.getExitReasonBadge(display.displayExitReason);
        const polymarketOutcomeBadge = this.getPolymarketOutcomeBadge(trade);
        const entryDate = formatDate(trade.entryTime);

        let targetRow = '';
        if (display.displayExitReason === 'end_of_data') {
            const targets: string[] = [];
            if (trade.takeProfitPrice != null && trade.takeProfitPrice > 0) {
                const tpPct = Math.abs((trade.takeProfitPrice - trade.entryPrice) / trade.entryPrice * 100);
                targets.push(`<span class="trade-target tp" title="Take Profit target">TP: ${formatPrice(trade.takeProfitPrice)} <span class="target-pct">(${tpPct.toFixed(2)}%)</span></span>`);
            }
            if (trade.stopLossPrice != null && trade.stopLossPrice > 0) {
                const slPct = Math.abs((trade.stopLossPrice - trade.entryPrice) / trade.entryPrice * 100);
                targets.push(`<span class="trade-target sl" title="Stop Loss target">SL: ${formatPrice(trade.stopLossPrice)} <span class="target-pct">(${slPct.toFixed(2)}%)</span></span>`);
            }
            if (targets.length > 0) {
                targetRow = `<div class="trade-targets-row">${targets.join('')}</div>`;
            }
        }

        return `
            <div class="trade-item ${statusClass}" data-entry-time="${this.encodeTradeEntryTime(trade.entryTime)}" role="button" tabindex="0">
                <div class="trade-main-row">
                    <div class="trade-left-group">
                        <div class="trade-icon ${trade.type === 'long' ? 'buy' : 'sell'}">
                            ${trade.type === 'long' ? 'B' : 'S'}
                        </div>
                        <div class="trade-price-info">
                            <div class="trade-price-flow">
                                <span class="price-val">${formatPrice(trade.entryPrice)}</span>
                                <span class="price-arrow">-></span>
                                <span class="price-val">${formatPrice(display.exitPrice)}</span>
                            </div>
                            <div class="trade-sub-info">
                                 <span class="trade-time">${entryDate}</span>
                                 <span class="separator">|</span>
                                 <span class="trade-duration">${duration}</span>
                                 ${exitReasonBadge}
                                 ${polymarketOutcomeBadge}
                                 ${fees ? `<span class="separator">|</span><span class="trade-fees">${fees}</span>` : ''}
                             </div>
                            <div class="trade-sub-info">
                                <span class="trade-size">${sizeLabel}</span>
                            </div>
                        </div>
                    </div>
                    <div class="trade-result-group">
                        <div class="trade-pnl">
                            ${isProfit ? '+' : ''}$${display.pnl.toFixed(2)}
                        </div>
                        <div class="trade-pct">
                            ${Math.abs(display.pnlPercent).toFixed(2)}%
                        </div>
                    </div>
                </div>
                ${targetRow}
            </div>
        `;
    }

    private getDisplayTradeMetrics(trade: Trade): {
        exitPrice: number;
        pnl: number;
        pnlPercent: number;
        durationMs: number;
        displayExitReason: Trade['exitReason'];
    } {
        const liveCandle: OHLCVData | null = state.ohlcvData.length > 0
            ? state.ohlcvData[state.ohlcvData.length - 1]
            : null;

        return resolveOpenTradeDisplayMetrics(trade, liveCandle);
    }

    private ensureTradeJumpHandlersBound(): void {
        if (this.jumpHandlersBound) {
            return;
        }

        const container = this.getDom().tradesList;
        container.addEventListener('click', (event) => {
            const copyTarget = this.resolvePolymarketCopyTarget(event.target, container);
            if (copyTarget) {
                event.preventDefault();
                void this.copyPolymarketUrl(copyTarget.dataset.polymarketUrl ?? '');
                return;
            }

            const item = this.resolveTradeItemTarget(event.target, container);
            if (!item) {
                return;
            }
            this.activateTradeItem(item);
        });
        container.addEventListener('keydown', (event) => {
            const copyTarget = this.resolvePolymarketCopyTarget(event.target, container);
            if (copyTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                void this.copyPolymarketUrl(copyTarget.dataset.polymarketUrl ?? '');
                return;
            }

            if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) {
                return;
            }

            const item = this.resolveTradeItemTarget(event.target, container);
            if (!item) {
                return;
            }

            event.preventDefault();
            this.activateTradeItem(item);
        });
        this.jumpHandlersBound = true;
    }

    private resolvePolymarketCopyTarget(target: EventTarget | null, container: HTMLElement): HTMLElement | null {
        if (!(target instanceof Element)) {
            return null;
        }

        const badge = target.closest('[data-polymarket-url]');
        if (!(badge instanceof HTMLElement) || !container.contains(badge)) {
            return null;
        }

        return badge;
    }

    private async copyPolymarketUrl(url: string): Promise<void> {
        if (!url || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
            return;
        }

        try {
            await navigator.clipboard.writeText(url);
        } catch {
            // Ignore clipboard failures to avoid breaking trade navigation.
        }
    }

    private resolveTradeItemTarget(target: EventTarget | null, container: HTMLElement): HTMLElement | null {
        if (!(target instanceof Element)) {
            return null;
        }

        const item = target.closest('.trade-item');
        if (!(item instanceof HTMLElement) || !container.contains(item)) {
            return null;
        }

        return item;
    }

    private activateTradeItem(item: HTMLElement): void {
        const encodedEntryTime = item.dataset.entryTime;
        if (!encodedEntryTime || !this.jumpToTrade) {
            return;
        }

        try {
            const entryTime = JSON.parse(decodeURIComponent(encodedEntryTime)) as Time;
            this.jumpToTrade(entryTime);
        } catch {
            // Ignore malformed attributes rather than breaking the trade list.
        }
    }

    private buildPolymarketMarketUrl(marketSlug: string): string {
        return `https://polymarket.com/event/${marketSlug}`;
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private updateSummary(trades: Trade[]) {
        const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
        const winners = trades.filter(t => t.pnl > 0).length;
        const winRate = (winners / trades.length) * 100;
        const dom = this.getDom();

        dom.tradesTotalPnL.textContent = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`;
        dom.tradesTotalPnL.className = `summary-value ${totalPnL >= 0 ? 'positive' : 'negative'}`;
        dom.tradesWinRate.textContent = `${winRate.toFixed(1)}%`;
        dom.tradesWinRate.className = `summary-value ${winRate >= 50 ? 'positive' : 'negative'}`;
    }

    public clear() {
        setVisible('emptyTrades', true);
        setVisible('tradesSummary', false);
        const container = this.getDom().tradesList;
        container.classList.remove('trades-list-parity');
        container.innerHTML = '';
    }
}

export const tradesRenderer = new TradesRenderer();
