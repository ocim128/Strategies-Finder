import { Time } from "lightweight-charts";
import { OHLCVData, BacktestResult, Trade, EntryPreview } from "./strategies/index";
import { state } from "./state";
import type { TwoHourParityBacktestResults } from "./state";
import { strategyRegistry, getStrategyList } from "../strategyRegistry";
import { getOptionalElement, getRequiredElement } from "./dom-utils";
import { resultsRenderer } from "./renderers/resultsRenderer";
import { tradesRenderer } from "./renderers/tradesRenderer";
import { paramManager } from "./param-manager";
import { formatJakartaTime, isBusinessDayTime } from "./timezone-utils";
import { formatDisplayPrice } from "./price-format";
import { createSettingsWorkspaceDom, createUiManagerDom, type UiManagerDom } from "./feature-dom-contracts";

export class UIManager {
    private dom: UiManagerDom | null = null;

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
            arrowEl.textContent = isPositive ? '^' : 'v';
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
            : source === 'finder_robust_oos'
                ? 'Robust OOS '
                : source === 'walk_forward_oos'
                    ? 'WFO OOS '
                    : source === 'ensemble_preview'
                        ? 'Ensemble '
                        : '';
        badge.textContent = `${sourcePrefix}${isPositive ? '+' : ''}${result.netProfitPercent.toFixed(2)}% ROI`;
        badge.className = `stat-badge ${isPositive ? 'positive' : 'negative'}`;
        badge.title = source === 'finder_selection'
            ? 'Showing Finder selection snapshot with endpoint-bias trade removed. Run Backtest for the raw result.'
            : source === 'finder_robust_oos'
                ? 'Showing Finder robust OOS walk-forward snapshot. Run Backtest for a full-history raw result.'
                : source === 'walk_forward_oos'
                    ? 'Showing walk-forward out-of-sample result snapshot.'
                    : source === 'ensemble_preview'
                        ? 'Showing strategy ensemble preview result.'
                        : 'Showing raw backtest result.';
        badge.classList.remove('is-hidden');
    }

    public updateParityComparisonUI(results: TwoHourParityBacktestResults): void {
        resultsRenderer.renderParityComparison(results);
    }

    public clearParityComparisonUI(): void {
        resultsRenderer.clearParityComparison();
    }

    public updateTradesList(trades: Trade[], jumpToTrade: (time: Time) => void) {
        tradesRenderer.render(trades, jumpToTrade, this.formatPrice, this.formatDate);
        this.updateTradeBadge(trades.length);
    }

    public updateParityTradesList(oddTrades: Trade[], evenTrades: Trade[], jumpToTrade: (time: Time) => void): void {
        tradesRenderer.renderParity(oddTrades, evenTrades, jumpToTrade, this.formatPrice, this.formatDate);
        this.updateTradeBadge(oddTrades.length + evenTrades.length);
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
        badge.innerHTML = `
			<div class="indicator-color" style="background: ${color};"></div>
			<span class="indicator-name">${type} ${period}</span>
		`;
        const preview = panel.querySelector('#entryPreviewPanel');
        if (preview) {
            panel.insertBefore(badge, preview);
        } else {
            panel.appendChild(badge);
        }
    }

    public updateStrategyParams(currentStrategyKey: string) {
        const strategy = strategyRegistry.get(currentStrategyKey);
        if (strategy) {
            this.updateStrategyWorkspaceContext(currentStrategyKey, strategy.name, strategy.description, Object.keys(strategy.defaultParams).length);
            paramManager.render(strategy);
        }
    }

    public updateStrategyDropdown(currentStrategyKey: string) {
        const { strategySelect } = this.getDom();
        const strategies = getStrategyList();
        const currentValue = strategyRegistry.has(currentStrategyKey)
            ? currentStrategyKey
            : strategySelect.value;

        strategySelect.innerHTML = '';
        strategies.forEach(({ key, name, description }) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = name;
            option.title = description;
            strategySelect.appendChild(option);
        });

        if (strategyRegistry.has(currentValue)) {
            strategySelect.value = currentValue;
        } else if (strategies.length > 0) {
            const fallbackKey = strategies[0].key;
            strategySelect.value = fallbackKey;
            state.set('currentStrategyKey', fallbackKey);
        }
    }

    private updateStrategyWorkspaceContext(strategyKey: string, name: string, description: string, paramCount: number): void {
        const workspaceExists = getOptionalElement('strategyMetaName')
            && getOptionalElement('strategyMetaDescription')
            && getOptionalElement('strategyMetaKey')
            && getOptionalElement('strategyParamCount');

        if (!workspaceExists) {
            return;
        }

        const workspace = createSettingsWorkspaceDom();
        workspace.strategyMetaName.textContent = name;
        workspace.strategyMetaDescription.textContent = description;
        workspace.strategyMetaKey.textContent = strategyKey.replace(/_/g, ' ');
        workspace.strategyParamCount.textContent = `${paramCount} param${paramCount === 1 ? '' : 's'}`;
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
        this.clearParityComparisonUI();
        this.updateTradeBadge(0);
        dom.strategyStatus.textContent = 'Ready';
        this.updateEntryPreview(null);
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

    public updateEntryPreview(preview: EntryPreview | null) {
        const panel = this.ensureEntryPreviewPanel();
        if (!panel) return;

        if (!preview) {
            panel.style.display = 'none';
            return;
        }

        panel.style.display = 'flex';

        const statusEl = panel.querySelector('#entryPreviewStatus') as HTMLElement | null;
        const modeEl = panel.querySelector('#entryPreviewMode') as HTMLElement | null;
        const directionEl = panel.querySelector('#entryPreviewDirection') as HTMLElement | null;
        const levelEl = panel.querySelector('#entryPreviewLevel') as HTMLElement | null;
        const priceEl = panel.querySelector('#entryPreviewPrice') as HTMLElement | null;
        const distanceEl = panel.querySelector('#entryPreviewDistance') as HTMLElement | null;
        const noteEl = panel.querySelector('#entryPreviewNote') as HTMLElement | null;

        if (statusEl) {
            statusEl.textContent = preview.status;
            statusEl.className = `entry-preview-status ${preview.status}`;
        }

        if (modeEl) {
            modeEl.textContent = this.formatEntryMode(preview.mode);
        }

        if (directionEl) {
            directionEl.textContent = preview.direction;
        }

        if (levelEl) {
            levelEl.textContent = preview.level.toFixed(3).replace(/\.?0+$/, '');
        }

        if (priceEl) {
            priceEl.textContent = preview.fanPrice !== null ? this.formatPrice(preview.fanPrice) : '-';
        }

        if (distanceEl) {
            if (preview.distance === null || preview.distancePct === null || preview.lastClose === null) {
                distanceEl.textContent = '-';
            } else {
                const sign = preview.distance >= 0 ? '+' : '-';
                const diff = Math.abs(preview.distance);
                const pct = Math.abs(preview.distancePct);
                distanceEl.textContent = `${sign}${this.formatPrice(diff)} (${sign}${pct.toFixed(2)}%)`;
            }
        }

        if (noteEl) {
            noteEl.textContent = preview.note ?? '';
        }
    }

    private ensureEntryPreviewPanel(): HTMLElement | null {
        let panel = document.getElementById('entryPreviewPanel');
        if (panel) return panel;

        const { indicatorsPanel: container } = this.getDom();

        panel = document.createElement('div');
        panel.id = 'entryPreviewPanel';
        panel.className = 'entry-preview-panel';
        panel.style.display = 'none';
        panel.innerHTML = `
            <div class="entry-preview-header">
                <span class="entry-preview-title">Next Potential Entry</span>
                <span class="entry-preview-status unavailable" id="entryPreviewStatus">-</span>
            </div>
            <div class="entry-preview-row">
                <span>Mode</span>
                <span id="entryPreviewMode">-</span>
            </div>
            <div class="entry-preview-row">
                <span>Direction</span>
                <span id="entryPreviewDirection">-</span>
            </div>
            <div class="entry-preview-row">
                <span>Level</span>
                <span id="entryPreviewLevel">-</span>
            </div>
            <div class="entry-preview-row">
                <span>Fan Price</span>
                <span id="entryPreviewPrice">-</span>
            </div>
            <div class="entry-preview-row">
                <span>Distance</span>
                <span id="entryPreviewDistance">-</span>
            </div>
            <div class="entry-preview-note" id="entryPreviewNote"></div>
        `;
        container.appendChild(panel);
        return panel;
    }

    private formatEntryMode(mode: number): string {
        if (mode === 0) return 'cross';
        if (mode === 1) return 'close';
        return 'touch';
    }
}

export const uiManager = new UIManager();

