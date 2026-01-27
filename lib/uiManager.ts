import { Time } from "lightweight-charts";
import { OHLCVData, BacktestResult, Trade, EntryPreview } from "./strategies/index";
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
        let date: Date;
        if (typeof timestamp === 'number') {
            // Assume seconds if small enough, otherwise ms? 
            // lightweight-charts usually uses seconds.
            date = new Date(timestamp * 1000);
        } else if (typeof timestamp === 'string') {
            date = new Date(timestamp);
        } else if (typeof timestamp === 'object' && 'year' in timestamp) {
            date = new Date(Date.UTC(timestamp.year, timestamp.month - 1, timestamp.day));
        } else {
            return '';
        }

        if (isNaN(date.getTime())) return String(timestamp);

        // If time is 00:00, return just date
        if (date.getHours() === 0 && date.getMinutes() === 0) {
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    public updateOHLCDisplay(data: OHLCVData) {
        const isPositive = data.close >= data.open;
        const colorClass = isPositive ? 'positive' : 'negative';
        const displayClass = `ohlc-value ${colorClass}`;

        updateTextContent('ohlcOpen', this.formatPrice(data.open), displayClass);
        updateTextContent('ohlcHigh', this.formatPrice(data.high), displayClass);
        updateTextContent('ohlcLow', this.formatPrice(data.low), displayClass);
        updateTextContent('ohlcClose', this.formatPrice(data.close), displayClass);

        // Volume display
        if (data.volume !== undefined) {
            const volumeEl = document.getElementById('ohlcVolume');
            if (volumeEl) {
                volumeEl.textContent = this.formatVolume(data.volume);
            }
        }

        // Change percentage
        const change = ((data.close - data.open) / data.open) * 100;
        const changeEl = document.getElementById('ohlcChange');
        const changeValueEl = document.getElementById('ohlcChangeValue');
        const arrowEl = changeEl?.querySelector('.ohlc-change-arrow');

        if (changeEl && changeValueEl) {
            changeValueEl.textContent = `${isPositive ? '+' : ''}${change.toFixed(2)}%`;
            changeEl.className = `ohlc-change ${isPositive ? 'positive' : 'negative'}`;
            if (arrowEl) {
                arrowEl.textContent = isPositive ? '▲' : '▼';
            }
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
            const fallbackKey = strategies[0].key;
            strategySelect.value = fallbackKey;
            state.set('currentStrategyKey', fallbackKey);
        }
    }

    public updateTimeframeUI(interval: string) {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.timeframe-tab'));
        let matchedTab = false;

        tabs.forEach(tab => {
            const isActive = tab.dataset.interval === interval;
            tab.classList.toggle('active', isActive);
            if (isActive) matchedTab = true;
        });

        const customContainer = document.getElementById('timeframeCustom');
        const customInput = document.getElementById('timeframeMinutesInput') as HTMLInputElement | null;
        const isCustom = !matchedTab;

        if (customContainer) {
            customContainer.classList.toggle('active', isCustom);
        }

        if (customInput) {
            if (interval.endsWith('m')) {
                const minutes = parseInt(interval.slice(0, -1), 10);
                if (Number.isFinite(minutes)) {
                    customInput.value = String(minutes);
                    return;
                }
            }
            customInput.value = '';
        }
    }

    public clearUI() {
        getRequiredElement('indicatorsPanel').innerHTML = '';
        resultsRenderer.clear();
        tradesRenderer.clear();
        this.updateTradeBadge(0);
        updateTextContent('strategyStatus', 'Ready');
        this.updateEntryPreview(null);
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

        const container = document.getElementById('indicatorsPanel');
        if (!container) return null;

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
