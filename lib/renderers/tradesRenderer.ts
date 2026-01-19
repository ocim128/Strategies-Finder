import { Time } from "lightweight-charts";
import { Trade } from "../strategies/index";
import { getRequiredElement, setVisible } from "../domUtils";

export class TradesRenderer {
    public render(trades: Trade[], jumpToTrade: (time: Time) => void, formatPrice: (p: number) => string, formatDate: (t: Time) => string) {
        const container = getRequiredElement('tradesList');

        if (trades.length === 0) {
            setVisible('emptyTrades', true);
            container.innerHTML = '';
            return;
        }

        setVisible('emptyTrades', false);

        container.innerHTML = trades.slice().reverse().map(trade => {
            const isProfit = trade.pnl >= 0;
            return `
				<div class="trade-item" data-entry-time="${trade.entryTime}" role="button" tabindex="0">
					<div class="trade-icon ${trade.type === 'long' ? 'buy' : 'sell'}">
						${trade.type === 'long' ? 'L' : 'S'}
					</div>
					<div class="trade-info">
						<div class="trade-date">${formatDate(trade.entryTime)} → ${formatDate(trade.exitTime)}</div>
						<div class="trade-prices">${formatPrice(trade.entryPrice)} → ${formatPrice(trade.exitPrice)}</div>
					</div>
					<div class="trade-result">
						<div class="trade-pnl ${isProfit ? 'positive' : 'negative'}">
							${isProfit ? '+' : ''}$${trade.pnl.toFixed(2)}
						</div>
						<div class="trade-pct">${isProfit ? '+' : ''}${trade.pnlPercent.toFixed(2)}%</div>
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

    public clear() {
        setVisible('emptyTrades', true);
        const container = document.getElementById('tradesList');
        if (container) container.innerHTML = '';
    }
}

export const tradesRenderer = new TradesRenderer();
