import type { Time } from "lightweight-charts";
import type { OHLCVData, BacktestResult, Trade } from "./strategies/index";
import { state } from "./state";
import { setCurrentStrategyKey } from "./state-actions";
import { strategyRegistry, getStrategyList, loadBuiltInStrategyByKey } from "../strategyRegistry";
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
    /**
     * In-flight strategy selection intent owned by the strategy selector.
     * Registry notifications re-render the dropdown from the last committed
     * state key; the intent keeps the option the user picked visible and
     * blocks superseded renders/commits until the loading request settles.
     */
    private pendingStrategySelection: { key: string; generation: number } | null = null;
    /** Monotonic render generation owning the strategy parameter form. */
    private strategyParamRenderGeneration = 0;

    private getDom(): UiManagerDom {
        return this.dom ??= createUiManagerDom();
    }

    /**
     * Record the selector's in-flight intent for `key` under the selector's
     * request generation. The intended option stays selected while loading.
     */
    public beginStrategySelection(key: string, generation: number): void {
        this.pendingStrategySelection = { key, generation };
        const { strategySelect } = this.getDom();
        if (strategySelect.value !== key) {
            strategySelect.value = key;
        }
    }

    /** True when this generation still owns the pending selection intent. */
    public ownsStrategySelection(generation: number): boolean {
        return this.pendingStrategySelection?.generation === generation;
    }

    /**
     * Clear the intent only when the settling request still owns it. Requests
     * superseded by a newer selection leave the newer intent untouched.
     */
    public settleStrategySelection(generation: number): void {
        if (this.pendingStrategySelection?.generation === generation) {
            this.pendingStrategySelection = null;
        }
    }

    /**
     * Boundary for external configuration application (settings restore,
     * strategy-config apply, live-position navigation): a pending user
     * selection must not commit over the externally applied setup, including
     * same-key restores.
     */
    public cancelPendingStrategySelection(): void {
        this.pendingStrategySelection = null;
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
        const arrowEl = dom.ohlcChangeArrow;
        const changeValueEl = dom.ohlcChangeValue;

        changeValueEl.textContent = `${isPositive ? '+' : ''}${change.toFixed(2)}%`;
        changeEl.className = `ohlc-change ${isPositive ? 'positive' : 'negative'}`;
        arrowEl.textContent = isPositive ? '▲' : '▼';
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
                        : '';
        badge.textContent = `${sourcePrefix}${isPositive ? '+' : ''}${result.netProfitPercent.toFixed(2)}% ROI`;
        badge.className = `stat-badge ${isPositive ? 'positive' : 'negative'}`;
        badge.title = source === 'finder_selection'
            ? 'Showing Finder selection snapshot with endpoint-bias trade removed. Run Backtest for the raw result.'
            : source === 'endpoint_preview'
                ? 'Showing a local preview of the exact HTTP backtest endpoint contract.'
            : source === 'walk_forward_oos'
                    ? 'Showing walk-forward out-of-sample result snapshot.'
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

    public async updateStrategyParams(requestedKey: string) {
        // Independent render ownership: every call starts a new render
        // generation. A render whose lazy-load settled after a newer render
        // started (newer commit, restore, or re-apply of the same key) is
        // stale and must not touch the form. Unlike the selection intent this
        // generation survives settlement and cancellation, because it only
        // advances when a newer parameter render actually starts.
        const renderGeneration = ++this.strategyParamRenderGeneration;
        let strategy = strategyRegistry.get(requestedKey);
        if (!strategy) {
            strategy = await loadBuiltInStrategyByKey(requestedKey);
        }
        if (renderGeneration !== this.strategyParamRenderGeneration) {
            return;
        }
        // The requested strategy must still own the UI: a Finder Apply or
        // external configuration application may have committed another key
        // while this render awaited its lazy load.
        if (state.currentStrategyKey !== requestedKey) {
            return;
        }
        // A newer selection intent supersedes renders whose await finished
        // late (e.g. a registry re-emission of the previously selected key,
        // or an external configuration application that claimed the UI).
        if (this.pendingStrategySelection !== null
            && this.pendingStrategySelection.key !== requestedKey) {
            return;
        }
        if (strategy) {
            this.updateStrategyWorkspaceContext(requestedKey, strategy.name, strategy.description, Object.keys(strategy.defaultParams).length);
            paramManager.render(strategy);
        }
    }

    public updateStrategyDropdown(currentStrategyKey: string) {
        const { strategySelect } = this.getDom();
        const strategies = getStrategyList();
        const signature = strategies
            .map(({ key, name, description }) => `${key}\u0000${name}\u0000${description}`)
            .join('\u0001');
        const pending = this.pendingStrategySelection;
        const currentValue = pending !== null && strategies.some(s => s.key === pending.key)
            ? pending.key
            : strategies.some(s => s.key === currentStrategyKey)
                ? currentStrategyKey
                : strategySelect.value;

        if (signature !== this.strategyDropdownSignature) {
            const fragment = document.createDocumentFragment();
            strategies.forEach(({ key, name, description }) => {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = name;
                option.title = description;
                fragment.appendChild(option);
            });
            strategySelect.replaceChildren(fragment);
            this.strategyDropdownSignature = signature;
        }

        const found = strategies.some(s => s.key === currentValue);
        if (found) {
            strategySelect.value = currentValue;
        } else if (pending !== null) {
            // A selection is in flight and its key is not listed yet (e.g. a
            // not-yet-registered custom strategy). Keep the user's intent;
            // the pending branch must not commit a dropdown fallback key.
            return;
        } else if (strategies.length > 0) {
            const fallbackKey = strategies[0].key;
            strategySelect.value = fallbackKey;
            setCurrentStrategyKey(fallbackKey);
        }
    }

    private updateStrategyWorkspaceContext(strategyKey: string, name: string, description: string, paramCount: number): void {
        const workspaceExists = getOptionalElement('strategyMetaName')
            && getOptionalElement('strategyMetaDescription')
            && getOptionalElement('strategyParamCount');

        if (!workspaceExists) {
            return;
        }

        const workspace = createSettingsWorkspaceDom();
        workspace.strategyMetaName.textContent = name;
        workspace.strategyMetaDescription.textContent = description;
        workspace.strategyParamCount.textContent = `${paramCount} param${paramCount === 1 ? '' : 's'}`;
        workspace.strategyMetaName.title = strategyKey;
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
