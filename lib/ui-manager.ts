import type { Time } from "lightweight-charts";
import type { OHLCVData, BacktestResult, Trade, Strategy } from "./strategies/index";
import { state } from "./state";
import { setCurrentStrategyKey } from "./state-actions";
import { strategyRegistry, getStrategyList, loadBuiltInStrategyByKey, getStrategyKind, getStrategyKindTitle } from "../strategyRegistry";
import { getOptionalElement, getRequiredElement } from "./dom-utils";
import { resultsRenderer } from "./renderers/resultsRenderer";
import { tradesRenderer } from "./renderers/tradesRenderer";
import { paramManager } from "./param-manager";
import { formatJakartaTime, isBusinessDayTime } from "./timezone-utils";
import { formatDisplayPrice } from "./price-format";
import { createSettingsWorkspaceDom, createUiManagerDom, type UiManagerDom } from "./ui-manager-dom";

export class UIManager {
    private dom: UiManagerDom | null = null;
    private strategyDropdownSignature: string | null = null;

    private getDom(): UiManagerDom {
        return this.dom ??= createUiManagerDom();
    }

    public updateSymbolDataSource(
        label: string,
        tone: 'live' | 'seed' | 'warning' | 'loading' = 'seed',
        title?: string
    ): void {
        const { symbolDataSource: el } = this.getDom();
        el.textContent = label;
        el.className = `symbol-source ${tone}`;
        el.title = title ?? label;
    }

    public formatPrice(price: number): string {
        return formatDisplayPrice(price);
    }

    public formatDate(timestamp: Time): string {
        if (isBusinessDayTime(timestamp)) {
            return formatJakartaTime(timestamp, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            });
        }

        return formatJakartaTime(timestamp, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    }

    public updateOHLCDisplay(data: OHLCVData) {
        const isPositive = data.close >= data.open;
        const colorClass = isPositive ? 'positive' : 'negative';
        const displayClass = `ohlc-value ${colorClass}`;
        const dom = this.getDom();

        dom.ohlcOpen.textContent = this.formatPrice(data.open);
        dom.ohlcOpen.className = displayClass;
        dom.ohlcHigh.textContent = this.formatPrice(data.high);
        dom.ohlcHigh.className = displayClass;
        dom.ohlcLow.textContent = this.formatPrice(data.low);
        dom.ohlcLow.className = displayClass;
        dom.ohlcClose.textContent = this.formatPrice(data.close);
        dom.ohlcClose.className = displayClass;

        // Volume display
        if (data.volume !== undefined) {
            dom.ohlcVolume.textContent = this.formatVolume(data.volume);
        }

        // Change percentage
        const change = ((data.close - data.open) / data.open) * 100;
        const changeEl = dom.ohlcChange;
        const changeValueEl = dom.ohlcChangeValue;
        const arrowEl = changeEl?.querySelector('.ohlc-change-arrow');

        changeValueEl.textContent = `${isPositive ? '+' : ''}${change.toFixed(2)}%`;
        changeEl.className = `ohlc-change ${isPositive ? 'positive' : 'negative'}`;
        if (arrowEl) {
            arrowEl.textContent = isPositive ? '▲' : '▼';
        }
    }

    private formatVolume(volume: number): string {
        if (volume >= 1e9) return (volume / 1e9).toFixed(2) + 'B';
        if (volume >= 1e6) return (volume / 1e6).toFixed(2) + 'M';
        if (volume >= 1e3) return (volume / 1e3).toFixed(2) + 'K';
        return volume.toFixed(2);
    }

    public updatePriceDisplay() {
        if (state.ohlcvData.length === 0) return;

        const latest = state.ohlcvData[state.ohlcvData.length - 1];
        const previous = state.ohlcvData[state.ohlcvData.length - 2] || latest;

        const change = ((latest.close - previous.close) / previous.close) * 100;
        const isPositive = change >= 0;
        const colorClass = isPositive ? '' : 'negative';
        const dom = this.getDom();

        dom.symbolPrice.textContent = this.formatPrice(latest.close);
        dom.symbolPrice.className = `symbol-price ${colorClass}`;
        dom.symbolChange.textContent = `${isPositive ? '+' : ''}${change.toFixed(2)}%`;
        dom.symbolChange.className = `symbol-change ${colorClass}`;

        this.updateOHLCDisplay(latest);
    }

    public updateResultsUI(result: BacktestResult) {
        resultsRenderer.render(result);

        // Update status bar badge
        const { lastBacktestResult: badge } = this.getDom();
        const isPositive = result.netProfit >= 0;
        const source = state.currentBacktestResultSource;
        const sourcePrefix = source === 'finder_selection'
            ? 'Finder Adj '
            : source === 'endpoint_preview'
                ? 'Endpoint '
            : source === 'walk_forward_oos'
                    ? 'WFO OOS '
                    : source === 'ensemble_preview'
                        ? 'Ensemble '
                        : '';
        badge.textContent = `${sourcePrefix}${isPositive ? '+' : ''}${result.netProfitPercent.toFixed(2)}% ROI`;
        badge.className = `stat-badge ${isPositive ? 'positive' : 'negative'}`;
        badge.title = source === 'finder_selection'
            ? 'Showing Finder selection snapshot with endpoint-bias trade removed. Run Backtest for the raw result.'
            : source === 'endpoint_preview'
                ? 'Showing a local preview of the exact HTTP backtest endpoint contract.'
            : source === 'walk_forward_oos'
                    ? 'Showing walk-forward out-of-sample result snapshot.'
                    : source === 'ensemble_preview'
                        ? 'Showing strategy ensemble preview result.'
                        : 'Showing raw backtest result.';
        badge.classList.remove('is-hidden');
    }

    public async updateTradesList(trades: Trade[], jumpToTrade: (time: Time) => void) {
        const didRender = await tradesRenderer.render(trades, jumpToTrade, this.formatPrice, this.formatDate);
        if (didRender) {
            this.updateTradeBadge(trades.length);
        }
    }

    public updateTradeBadge(count: number) {
        const { tradeBadge: badge } = this.getDom();
        badge.textContent = count.toString();
        badge.classList.toggle('active', count > 0);
    }

    public addIndicatorBadge(id: string, type: string, period: number, color: string) {
        const panel = getRequiredElement('indicatorsPanel');
        const badge = document.createElement('div');
        badge.className = 'indicator-badge';
        badge.id = `indicator-${id}`;
        const colorDot = document.createElement('div');
        colorDot.className = 'indicator-color';
        colorDot.style.background = color;
        const name = document.createElement('span');
        name.className = 'indicator-name';
        name.textContent = `${type} ${period}`;
        badge.append(colorDot, name);
        panel.appendChild(badge);
    }

    public async updateStrategyParams(currentStrategyKey: string) {
        let strategy = strategyRegistry.get(currentStrategyKey);
        if (!strategy) {
            strategy = await loadBuiltInStrategyByKey(currentStrategyKey);
        }
        if (strategy) {
            this.updateStrategyWorkspaceContext(currentStrategyKey, strategy.name, strategy.description, Object.keys(strategy.defaultParams).length, strategy);
            paramManager.render(strategy);
        }
    }

    public updateStrategyDropdown(currentStrategyKey: string) {
        const { strategySelect } = this.getDom();
        const strategies = getStrategyList();
        const strategyRows = strategies.map(({ key, name, description }) => {
            const strategy = strategyRegistry.get(key);
            const kind = getStrategyKind(key, strategy);
            return { key, name, description, kind };
        });
        const signature = strategyRows
            .map(({ key, name, description, kind }) => `${key}\u0000${name}\u0000${description}\u0000${kind}`)
            .join('\u0001');
        const currentValue = strategies.some(s => s.key === currentStrategyKey)
            ? currentStrategyKey
            : strategySelect.value;

        if (signature !== this.strategyDropdownSignature) {
            const fragment = document.createDocumentFragment();
            strategyRows.forEach(({ key, name, description, kind }) => {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = name;
                option.title = kind === "standard" ? description : `${description} (${getStrategyKindTitle(kind)})`;
                option.dataset.strategyKind = kind;
                option.className = `strategy-option--${kind}`;
                fragment.appendChild(option);
            });
            strategySelect.replaceChildren(fragment);
            this.strategyDropdownSignature = signature;
        }

        const found = strategyRows.some(s => s.key === currentValue);
        if (found) {
            strategySelect.value = currentValue;
        } else if (strategyRows.length > 0) {
            const fallbackKey = strategyRows[0].key;
            strategySelect.value = fallbackKey;
            setCurrentStrategyKey(fallbackKey);
        }
    }

    private updateStrategyWorkspaceContext(strategyKey: string, name: string, description: string, paramCount: number, strategy: Strategy): void {
        const workspaceExists = getOptionalElement('strategyMetaName')
            && getOptionalElement('strategyMetaDescription')
            && getOptionalElement('strategyMetaKey')
            && getOptionalElement('strategyParamCount');

        if (!workspaceExists) {
            return;
        }

        const workspace = createSettingsWorkspaceDom();
        const kind = getStrategyKind(strategyKey, strategy);
        workspace.strategyMetaName.textContent = name;
        workspace.strategyMetaDescription.textContent = description;
        workspace.strategyMetaKey.textContent = strategyKey.replace(/_/g, ' ');
        workspace.strategyParamCount.textContent = `${paramCount} param${paramCount === 1 ? '' : 's'}`;
        workspace.strategyMetaName.dataset.strategyKind = kind;
        workspace.strategyMetaKey.dataset.strategyKind = kind;
        workspace.strategyMetaKey.title = getStrategyKindTitle(kind);
        this.getDom().strategySelect.dataset.strategyKind = kind;
    }

    public updateTimeframeUI(interval: string) {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.timeframe-tab'));
        let matchedTab = false;

        tabs.forEach(tab => {
            const isActive = tab.dataset.interval === interval;
            tab.classList.toggle('active', isActive);
            if (isActive) matchedTab = true;
        });

        const { timeframeCustom: customContainer, timeframeMinutesInput: customInput } = this.getDom();
        const isCustom = !matchedTab;

        customContainer.classList.toggle('active', isCustom);

        if (interval.endsWith('m')) {
            const minutes = parseInt(interval.slice(0, -1), 10);
            if (Number.isFinite(minutes)) {
                customInput.value = String(minutes);
                return;
            }
        }
        customInput.value = '';
    }

    public clearUI() {
        const dom = this.getDom();
        dom.indicatorsPanel.innerHTML = '';
        resultsRenderer.clear();
        tradesRenderer.clear();
        this.updateTradeBadge(0);
        dom.strategyStatus.textContent = 'Ready';
    }

    public showToast(message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') {
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
