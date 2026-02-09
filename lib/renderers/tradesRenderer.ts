import { Time } from "lightweight-charts";
import { Trade } from "../strategies/index";
import { getRequiredElement, setVisible } from "../domUtils";

export class TradesRenderer {
    public render(trades: Trade[], jumpToTrade: (time: Time) => void, formatPrice: (p: number) => string, formatDate: (t: Time) => string) {
        const container = getRequiredElement('tradesList');

        if (trades.length === 0) {
            setVisible('emptyTrades', true);
            setVisible('tradesSummary', false);
            container.innerHTML = '';
            return;
        }

        setVisible('emptyTrades', false);
        setVisible('tradesSummary', true);
        this.updateSummary(trades);

        container.innerHTML = trades.slice().reverse().map(trade => {
            const isProfit = trade.pnl >= 0;
            const statusClass = isProfit ? 'win' : 'loss';
            const duration = this.formatDuration(this.getTimestamp(trade.exitTime) - this.getTimestamp(trade.entryTime));
            const fees = trade.fees ? `Fees: $${trade.fees.toFixed(2)}` : '';
            const exitReasonBadge = this.getExitReasonBadge(trade.exitReason);

            // Format precise dates for tooltip or subtitle
            const entryDate = formatDate(trade.entryTime);

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
                                    <span class="price-arrow">➜</span>
                                    <span class="price-val">${formatPrice(trade.exitPrice)}</span>
                                </div>
                                <div class="trade-sub-info">
                                    <span class="trade-time">${entryDate}</span>
                                    <span class="separator">•</span>
                                    <span class="trade-duration">${duration}</span>
                                    ${exitReasonBadge}
                                    ${fees ? `<span class="separator">•</span><span class="trade-fees">${fees}</span>` : ''}
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
				</div>
			`;
        }).join('');

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
            'signal': { label: 'Signal', color: '#3b82f6', icon: '📊' },
            'stop_loss': { label: 'SL', color: '#ef4444', icon: '🛑' },
            'take_profit': { label: 'TP', color: '#22c55e', icon: '🎯' },
            'trailing_stop': { label: 'Trail', color: '#f59e0b', icon: '📈' },
            'time_stop': { label: 'Time', color: '#8b5cf6', icon: '⏰' },
            'partial': { label: 'Partial', color: '#06b6d4', icon: '½' },
            'end_of_data': { label: 'EOD', color: '#f97316', icon: '⚠️' },
        };

        const info = reasonMap[exitReason];
        if (!info) return '';

        return `<span class="exit-reason-badge" style="background: ${info.color}20; color: ${info.color}; border: 1px solid ${info.color}40;" title="Exit: ${info.label}">${info.icon}</span>`;
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
        if (container) container.innerHTML = '';
    }
}

export const tradesRenderer = new TradesRenderer();
