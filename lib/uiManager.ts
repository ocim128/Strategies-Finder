import { Time } from "lightweight-charts";
import { OHLCVData, BacktestResult, Trade } from "./strategies/index";
import { state } from "./state";
import { strategyRegistry, getStrategyList } from "../strategyRegistry";
import { getRequiredElement, updateTextContent } from "./domUtils";
import { resultsRenderer } from "./renderers/resultsRenderer";
import { tradesRenderer } from "./renderers/tradesRenderer";
import { paramManager } from "./paramManager";

export class UIManager {
    public formatPrice(price: number): string {
        if (price >= 1000) return price.toFixed(2);
        if (price >= 1) return price.toFixed(4);
        return price.toFixed(6);
    }

    public formatDate(timestamp: Time): string {
        const date = new Date((timestamp as number) * 1000);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    public updateOHLCDisplay(data: OHLCVData) {
        const isPositive = data.close >= data.open;
        const colorClass = isPositive ? 'positive' : 'negative';
        const displayClass = `ohlc-value ${colorClass}`;

        updateTextContent('ohlcOpen', this.formatPrice(data.open), displayClass);
        updateTextContent('ohlcHigh', this.formatPrice(data.high), displayClass);
        updateTextContent('ohlcLow', this.formatPrice(data.low), displayClass);
        updateTextContent('ohlcClose', this.formatPrice(data.close), displayClass);
    }

    public updatePriceDisplay() {
        if (state.ohlcvData.length === 0) return;

        const latest = state.ohlcvData[state.ohlcvData.length - 1];
        const previous = state.ohlcvData[state.ohlcvData.length - 2] || latest;

        const change = ((latest.close - previous.close) / previous.close) * 100;
        const isPositive = change >= 0;
        const colorClass = isPositive ? '' : 'negative';

        updateTextContent('symbolPrice', this.formatPrice(latest.close), `symbol-price ${colorClass}`);
        updateTextContent('symbolChange', `${isPositive ? '+' : ''}${change.toFixed(2)}%`, `symbol-change ${colorClass}`);

        this.updateOHLCDisplay(latest);
    }

    public updateResultsUI(result: BacktestResult) {
        resultsRenderer.render(result);

        // Update status bar badge
        const badge = document.getElementById('lastBacktestResult');
        if (badge) {
            const isPositive = result.netProfit >= 0;
            badge.textContent = `${isPositive ? '+' : ''}${result.netProfitPercent.toFixed(2)}% ROI`;
            badge.className = `stat-badge ${isPositive ? 'positive' : 'negative'}`;
            badge.classList.remove('is-hidden');
        }
    }

    public updateTradesList(trades: Trade[], jumpToTrade: (time: Time) => void) {
        tradesRenderer.render(trades, jumpToTrade, this.formatPrice, this.formatDate);
        this.updateTradeBadge(trades.length);
    }

    public updateTradeBadge(count: number) {
        const badge = document.getElementById('tradeBadge');
        if (badge) {
            badge.textContent = count.toString();
            badge.classList.toggle('active', count > 0);
        }
    }

    public addIndicatorBadge(id: string, type: string, period: number, color: string) {
        const panel = getRequiredElement('indicatorsPanel');
        const badge = document.createElement('div');
        badge.className = 'indicator-badge';
        badge.id = `indicator-${id}`;
        badge.innerHTML = `
			<div class="indicator-color" style="background: ${color};"></div>
			<span class="indicator-name">${type} ${period}</span>
		`;
        panel.appendChild(badge);
    }

    public updateStrategyParams(currentStrategyKey: string) {
        const strategy = strategyRegistry.get(currentStrategyKey);
        if (strategy) {
            paramManager.render(strategy);
        }
    }

    public updateStrategyDropdown(currentStrategyKey: string) {
        const strategySelect = getRequiredElement<HTMLSelectElement>('strategySelect');
        const strategies = getStrategyList();
        const currentValue = strategySelect.value || currentStrategyKey;

        strategySelect.innerHTML = '';
        strategies.forEach(({ key, name }) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = name;
            strategySelect.appendChild(option);
        });

        if (strategyRegistry.has(currentValue)) {
            strategySelect.value = currentValue;
        } else if (strategies.length > 0) {
            strategySelect.value = strategies[0].key;
            state.currentStrategyKey = strategies[0].key;
        }
    }

    public clearUI() {
        getRequiredElement('indicatorsPanel').innerHTML = '';
        resultsRenderer.clear();
        tradesRenderer.clear();
        this.updateTradeBadge(0);
        updateTextContent('strategyStatus', 'Ready');
    }

    public showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;

        container.appendChild(toast);

        // Remove after 3 seconds
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.parentElement.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }
}

export const uiManager = new UIManager();
