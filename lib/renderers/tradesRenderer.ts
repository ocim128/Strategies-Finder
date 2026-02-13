import { Time } from "lightweight-charts";
import { Trade } from "../strategies/index";
import { getRequiredElement, setVisible } from "../dom-utils";

export class TradesRenderer {
    public render(
        trades: Trade[],
        jumpToTrade: (time: Time) => void,
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ) {
        const container = getRequiredElement('tradesList');
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
        this.bindTradeJumpHandlers(container, jumpToTrade);
    }

    public renderParity(
        oddTrades: Trade[],
        evenTrades: Trade[],
        jumpToTrade: (time: Time) => void,
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ): void {
        const container = getRequiredElement('tradesList');
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

        this.bindTradeJumpHandlers(container, jumpToTrade);
    }

    private getTimestamp(time: Time): number {
        if (typeof time === 'number') {
            if (time < 1e11) return time * 1000;
            return time;
        }
        if (typeof time === 'string') {
            return new Date(time).getTime();
        }
        if (typeof time === 'object' && 'year' in time) {
            return Date.UTC(time.year, time.month - 1, time.day);
        }
        return 0;
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

        const reasonMap: Record<NonNullable<Trade['exitReason']>, { label: string; color: string; icon: string }> = {
            signal: { label: 'Signal', color: '#3b82f6', icon: 'SIG' },
            stop_loss: { label: 'SL', color: '#ef4444', icon: 'SL' },
            take_profit: { label: 'TP', color: '#22c55e', icon: 'TP' },
            trailing_stop: { label: 'Trail', color: '#f59e0b', icon: 'TRL' },
            time_stop: { label: 'Time', color: '#8b5cf6', icon: 'T' },
            partial: { label: 'Partial', color: '#06b6d4', icon: '1/2' },
            end_of_data: { label: 'EOD', color: '#f97316', icon: 'EOD' },
        };

        const info = reasonMap[exitReason];
        if (!info) return '';

        return `<span class="exit-reason-badge" style="background: ${info.color}20; color: ${info.color}; border: 1px solid ${info.color}40;" title="Exit: ${info.label}">${info.icon}</span>`;
    }

    private renderTradeItems(trades: Trade[], formatPrice: (p: number) => string, formatDate: (t: Time) => string): string {
        return trades.slice().reverse().map((trade) => this.renderTradeItem(trade, formatPrice, formatDate)).join('');
    }

    private renderTradeItem(trade: Trade, formatPrice: (p: number) => string, formatDate: (t: Time) => string): string {
        const isProfit = trade.pnl >= 0;
        const statusClass = isProfit ? 'win' : 'loss';
        const duration = this.formatDuration(this.getTimestamp(trade.exitTime) - this.getTimestamp(trade.entryTime));
        const fees = trade.fees ? `Fees: $${trade.fees.toFixed(2)}` : '';
        const exitReasonBadge = this.getExitReasonBadge(trade.exitReason);
        const entryDate = formatDate(trade.entryTime);

        let targetRow = '';
        if (trade.exitReason === 'end_of_data') {
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
            <div class="trade-item ${statusClass}" data-entry-time="${trade.entryTime}" role="button" tabindex="0">
                <div class="trade-main-row">
                    <div class="trade-left-group">
                        <div class="trade-icon ${trade.type === 'long' ? 'buy' : 'sell'}">
                            ${trade.type === 'long' ? 'B' : 'S'}
                        </div>
                        <div class="trade-price-info">
                            <div class="trade-price-flow">
                                <span class="price-val">${formatPrice(trade.entryPrice)}</span>
                                <span class="price-arrow">-></span>
                                <span class="price-val">${formatPrice(trade.exitPrice)}</span>
                            </div>
                            <div class="trade-sub-info">
                                <span class="trade-time">${entryDate}</span>
                                <span class="separator">|</span>
                                <span class="trade-duration">${duration}</span>
                                ${exitReasonBadge}
                                ${fees ? `<span class="separator">|</span><span class="trade-fees">${fees}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="trade-result-group">
                        <div class="trade-pnl">
                            ${isProfit ? '+' : ''}$${trade.pnl.toFixed(2)}
                        </div>
                        <div class="trade-pct">
                            ${Math.abs(trade.pnlPercent).toFixed(2)}%
                        </div>
                    </div>
                </div>
                ${targetRow}
            </div>
        `;
    }

    private bindTradeJumpHandlers(container: HTMLElement, jumpToTrade: (time: Time) => void): void {
        container.querySelectorAll('.trade-item').forEach(item => {
            const activate = () => {
                const entryTime = parseInt(item.getAttribute('data-entry-time')!) as Time;
                jumpToTrade(entryTime);
            };

            item.addEventListener('click', activate);
            item.addEventListener('keydown', (event) => {
                if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') {
                    event.preventDefault();
                    activate();
                }
            });
        });
    }

    private updateSummary(trades: Trade[]) {
        const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
        const winners = trades.filter(t => t.pnl > 0).length;
        const winRate = (winners / trades.length) * 100;

        const pnlEl = document.getElementById('tradesTotalPnL');
        const wrEl = document.getElementById('tradesWinRate');

        if (pnlEl) {
            pnlEl.textContent = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`;
            pnlEl.className = `summary-value ${totalPnL >= 0 ? 'positive' : 'negative'}`;
        }
        if (wrEl) {
            wrEl.textContent = `${winRate.toFixed(1)}%`;
            wrEl.className = `summary-value ${winRate >= 50 ? 'positive' : 'negative'}`;
        }
    }

    public clear() {
        setVisible('emptyTrades', true);
        setVisible('tradesSummary', false);
        const container = document.getElementById('tradesList');
        if (container) {
            container.classList.remove('trades-list-parity');
            container.innerHTML = '';
        }
    }
}

export const tradesRenderer = new TradesRenderer();
