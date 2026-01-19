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
            const pnlClass = isProfit ? 'positive' : 'negative';

            return `
				<div class="trade-item" data-entry-time="${trade.entryTime}" role="button" tabindex="0">
					<div class="trade-icon ${trade.type === 'long' ? 'buy' : 'sell'}">
						${trade.type === 'long' ? 'BUY' : 'SELL'}
					</div>
					<div class="trade-info">
						<div class="trade-date">${formatDate(trade.entryTime)}</div>
						<div class="trade-prices">
                            <span>${formatPrice(trade.entryPrice)}</span>
                            <span class="price-arrow">→</span>
                            <span>${formatPrice(trade.exitPrice)}</span>
                        </div>
					</div>
					<div class="trade-result">
						<div class="trade-pnl ${pnlClass}">
							${isProfit ? '+' : ''}$${trade.pnl.toFixed(2)}
						</div>
						<div class="trade-pct ${pnlClass}">
                            ${isProfit ? '▲' : '▼'} ${Math.abs(trade.pnlPercent).toFixed(2)}%
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
