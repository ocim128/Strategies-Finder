/**
 * Scanner Panel UI
 * Displays scanner controls and results
 */

import { scannerManager } from './scanner-manager';
import { settingsManager } from '../settings-manager';
import { alertService } from '../alert-service';
import { uiManager } from '../ui-manager';
import type { ScanResult, ScanProgress, StrategyConfigEntry } from '../types/scanner';

// ============================================================================
// Scanner Panel Class
// ============================================================================

export class ScannerPanel {
    private container: HTMLElement;
    private isVisible = false;
    private unsubscribe: (() => void) | null = null;

    // Drag state
    private isDragging = false;
    private dragOffsetX = 0;
    private dragOffsetY = 0;

    constructor() {
        this.container = this.createContainer();
        this.setupEventListeners();
        this.setupDragListeners();
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Toggle panel visibility
     */
    toggle(): void {
        this.isVisible ? this.hide() : this.show();
    }

    /**
     * Show the panel
     */
    show(): void {
        if (this.isVisible) return;
        this.isVisible = true;
        document.body.appendChild(this.container);
        this.container.classList.add('scanner-panel--visible');
        this.render();
    }

    /**
     * Hide the panel
     */
    hide(): void {
        if (!this.isVisible) return;
        this.isVisible = false;
        this.container.classList.remove('scanner-panel--visible');
        setTimeout(() => {
            if (!this.isVisible && this.container.parentNode) {
                this.container.parentNode.removeChild(this.container);
            }
        }, 300);
    }

    /**
     * Destroy the panel
     */
    destroy(): void {
        this.unsubscribe?.();
        this.hide();
    }

    // ========================================================================
    // Private Methods - UI Creation
    // ========================================================================

    private createContainer(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'scanner-panel';
        container.innerHTML = `
            <div class="scanner-panel__header">
                <h2 class="scanner-panel__title">Multi-Pair Scanner</h2>
                <button class="scanner-panel__close" title="Close">x</button>
            </div>
            <div class="scanner-panel__controls">
                <div class="scanner-panel__control-row">
                    <label>Strategies:</label>
                    <select class="scanner-panel__strategy-select" multiple></select>
                </div>
                <div class="scanner-panel__control-row">
                    <label>Interval:</label>
                    <select class="scanner-panel__interval-select">
                        <option value="15m">15m</option>
                        <option value="1h">1h</option>
                        <option value="2h" selected>2h</option>
                        <option value="4h">4h</option>
                        <option value="1d">1D</option>
                    </select>
                </div>
                <div class="scanner-panel__control-row">
                    <label>Max Pairs:</label>
                    <input type="number" class="scanner-panel__max-pairs" value="120" min="10" max="200">
                </div>
                <div class="scanner-panel__control-row">
                    <label>Freshness (bars):</label>
                    <input type="number" class="scanner-panel__freshness" value="3" min="1" max="10">
                </div>
                <div class="scanner-panel__control-row">
                    <label>Lookback (bars):</label>
                    <input type="number" class="scanner-panel__lookback" value="1000" min="200" max="50000">
                </div>
                <button class="scanner-panel__scan-btn">Start Scan</button>
            </div>
            <div class="scanner-panel__progress" style="display: none;">
                <div class="scanner-panel__progress-bar">
                    <div class="scanner-panel__progress-fill"></div>
                </div>
                <span class="scanner-panel__progress-text">Scanning...</span>
            </div>
            <div class="scanner-panel__results">
                <div class="scanner-panel__results-header">
                    <span>Results (0)</span>
                    <span class="scanner-panel__last-scan"></span>
                </div>
                <div class="scanner-panel__results-table">
                    <table>
                        <thead>
                            <tr>
                                <th>Pair</th>
                                <th>Dir</th>
                                <th>Strategy</th>
                                <th>Entry $</th>
                                <th>Now $</th>
                                <th>Target $</th>
                                <th>uPnL</th>
                                <th>Age</th>
                                <th>Alert</th>
                            </tr>
                        </thead>
                        <tbody class="scanner-panel__results-body"></tbody>
                    </table>
                </div>
                <div class="scanner-panel__empty">No signals found. Run a scan to see results.</div>
            </div>
        `;
        return container;
    }

    private setupEventListeners(): void {
        // Close button
        this.container.querySelector('.scanner-panel__close')?.addEventListener('click', () => {
            this.hide();
        });

        // Scan button
        this.container.querySelector('.scanner-panel__scan-btn')?.addEventListener('click', () => {
            this.handleScanClick();
        });

        // Subscribe to scanner events
        this.unsubscribe = scannerManager.subscribe((event) => {
            switch (event.type) {
                case 'scan-started':
                    this.showProgress();
                    break;
                case 'scan-progress':
                    this.updateProgress(event.progress!);
                    break;
                case 'scan-completed':
                    this.hideProgress();
                    this.renderResults(event.results!);
                    break;
                case 'scan-error':
                    this.hideProgress();
                    this.showError(event.error!);
                    break;
                case 'scan-cancelled':
                    this.hideProgress();
                    break;
            }
        });

        // Populate strategy select
        this.populateStrategySelect();
    }

    private setupDragListeners(): void {
        const header = this.container.querySelector('.scanner-panel__header') as HTMLElement;
        if (!header) return;

        header.style.cursor = 'grab';

        header.addEventListener('mousedown', (e: MouseEvent) => {
            // Ignore clicks on the close button
            if ((e.target as HTMLElement).closest('.scanner-panel__close')) return;

            this.isDragging = true;
            header.style.cursor = 'grabbing';

            const rect = this.container.getBoundingClientRect();
            this.dragOffsetX = e.clientX - rect.left;
            this.dragOffsetY = e.clientY - rect.top;

            // Prevent text selection during drag
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e: MouseEvent) => {
            if (!this.isDragging) return;

            const newLeft = e.clientX - this.dragOffsetX;
            const newTop = e.clientY - this.dragOffsetY;

            // Clamp within viewport
            const maxLeft = window.innerWidth - this.container.offsetWidth;
            const maxTop = window.innerHeight - this.container.offsetHeight;

            this.container.style.left = `${Math.max(0, Math.min(newLeft, maxLeft))}px`;
            this.container.style.top = `${Math.max(0, Math.min(newTop, maxTop))}px`;
            this.container.style.right = 'auto'; // Override default right positioning
        });

        document.addEventListener('mouseup', () => {
            if (this.isDragging) {
                this.isDragging = false;
                header.style.cursor = 'grab';
            }
        });
    }

    private populateStrategySelect(): void {
        const select = this.container.querySelector('.scanner-panel__strategy-select') as HTMLSelectElement;
        if (!select) return;

        // Load saved strategy configurations from settingsManager
        const savedConfigs = settingsManager.loadAllStrategyConfigs();

        if (savedConfigs.length === 0) {
            select.innerHTML = '<option value="" disabled>No saved configurations</option>';
            return;
        }

        select.innerHTML = savedConfigs
            .map((config) => `<option value="${config.name}" data-strategy-key="${config.strategyKey}">${config.name}</option>`)
            .join('');

        // Pre-select first config
        if (savedConfigs.length > 0) {
            select.selectedIndex = 0;
        }
    }

    // ========================================================================
    // Private Methods - Event Handlers
    // ========================================================================

    private handleScanClick(): void {
        const state = scannerManager.getState();

        if (state.isScanning) {
            scannerManager.cancelScan();
            this.updateScanButton(false);
        } else {
            // Update config from UI
            this.updateConfigFromUI();
            scannerManager.startScan();
            this.updateScanButton(true);
        }
    }

    private updateConfigFromUI(): void {
        const strategySelect = this.container.querySelector('.scanner-panel__strategy-select') as HTMLSelectElement;
        const intervalSelect = this.container.querySelector('.scanner-panel__interval-select') as HTMLSelectElement;
        const maxPairsInput = this.container.querySelector('.scanner-panel__max-pairs') as HTMLInputElement;
        const freshnessInput = this.container.querySelector('.scanner-panel__freshness') as HTMLInputElement;
        const lookbackInput = this.container.querySelector('.scanner-panel__lookback') as HTMLInputElement;

        // Get selected config names and build strategy config entries
        const selectedNames = Array.from(strategySelect.selectedOptions).map((opt) => opt.value);
        const savedConfigs = settingsManager.loadAllStrategyConfigs();

        const strategyConfigs = selectedNames
            .map(name => {
                const config = savedConfigs.find(c => c.name === name);
                if (!config) return null;
                return {
                    name: config.name,
                    strategyKey: config.strategyKey,
                    strategyParams: config.strategyParams,
                    // Cast to BacktestSettings to handle looser string types in BacktestSettingsData
                    backtestSettings: config.backtestSettings as StrategyConfigEntry['backtestSettings'],
                };
            })
            .filter((c): c is NonNullable<typeof c> => c !== null);

        scannerManager.updateConfig({
            strategyConfigs,
            interval: intervalSelect.value,
            maxPairs: parseInt(maxPairsInput.value, 10) || 120,
            signalFreshnessBars: parseInt(freshnessInput.value, 10) || 3,
            scanLookbackBars: parseInt(lookbackInput.value, 10) || 1000,
        });
    }

    // ========================================================================
    // Private Methods - UI Updates
    // ========================================================================

    private render(): void {
        const state = scannerManager.getState();
        this.renderResults(state.results);
        this.updateLastScanTime(state.lastScanTime);
    }

    private showProgress(): void {
        const progressEl = this.container.querySelector('.scanner-panel__progress') as HTMLElement;
        if (progressEl) progressEl.style.display = 'block';
        this.updateScanButton(true);
    }

    private hideProgress(): void {
        const progressEl = this.container.querySelector('.scanner-panel__progress') as HTMLElement;
        if (progressEl) progressEl.style.display = 'none';
        this.updateScanButton(false);
    }

    private updateProgress(progress: ScanProgress): void {
        const fill = this.container.querySelector('.scanner-panel__progress-fill') as HTMLElement;
        const text = this.container.querySelector('.scanner-panel__progress-text') as HTMLElement;

        if (fill) {
            const pct = (progress.current / progress.total) * 100;
            fill.style.width = `${pct}%`;
        }

        if (text) {
            const eta = Math.ceil(progress.estimatedRemainingMs / 1000);
            text.textContent = `Scanning ${progress.currentSymbol}... (${progress.current}/${progress.total}) ~${eta}s remaining`;
        }
    }

    private updateScanButton(isScanning: boolean): void {
        const btn = this.container.querySelector('.scanner-panel__scan-btn') as HTMLButtonElement;
        if (btn) {
            btn.textContent = isScanning ? 'Cancel Scan' : 'Start Scan';
            btn.classList.toggle('scanner-panel__scan-btn--cancel', isScanning);
        }
    }

    /**
     * Calculate unrealized PnL percentage
     */
    private calculateUnrealizedPnL(result: ScanResult): number {
        const entryPrice = result.signal.price;
        const currentPrice = result.currentPrice;

        if (result.direction === 'long') {
            // Long: profit if price goes up
            return ((currentPrice - entryPrice) / entryPrice) * 100;
        } else {
            // Short: profit if price goes down
            return ((entryPrice - currentPrice) / entryPrice) * 100;
        }
    }

    /**
     * Returns directional progress to target in percent.
     * 0 = at entry, 100 = at target, >100 = overshot, <0 = moving away.
     */
    private calculateTargetProgress(result: ScanResult): number | null {
        if (result.targetPrice === null) return null;
        const entryPrice = result.signal.price;
        const targetPrice = result.targetPrice;
        if (!Number.isFinite(entryPrice) || !Number.isFinite(targetPrice)) return null;

        const directionFactor = result.direction === 'long' ? 1 : -1;
        const targetMove = directionFactor * (targetPrice - entryPrice);
        if (targetMove <= 0) return null;

        const currentMove = directionFactor * (result.currentPrice - entryPrice);
        return (currentMove / targetMove) * 100;
    }

    /**
     * Sort results by:
     * 1. Signal freshness (ascending - nearest first)
     * 2. Unrealized PnL (ascending - losing positions first, they're better entries)
     */
    private sortResults(results: ScanResult[]): ScanResult[] {
        return [...results].sort((a, b) => {
            // First: sort by signal age (fresher signals first)
            if (a.signalAge !== b.signalAge) {
                return a.signalAge - b.signalAge;
            }

            // Second: sort by unrealized PnL (losing positions first - better entry opportunity)
            const pnlA = this.calculateUnrealizedPnL(a);
            const pnlB = this.calculateUnrealizedPnL(b);
            return pnlA - pnlB; // Ascending: negative (loss) comes first
        });
    }

    private renderResults(results: ScanResult[]): void {
        const tbody = this.container.querySelector('.scanner-panel__results-body') as HTMLTableSectionElement;
        const emptyEl = this.container.querySelector('.scanner-panel__empty') as HTMLElement;
        const headerSpan = this.container.querySelector('.scanner-panel__results-header span') as HTMLElement;

        if (!tbody) return;

        headerSpan.textContent = `Results (${results.length})`;

        if (results.length === 0) {
            tbody.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }

        emptyEl.style.display = 'none';

        // Sort results by freshness and unrealized PnL
        const sortedResults = this.sortResults(results);

        tbody.innerHTML = sortedResults
            .map((r) => {
                const pnl = this.calculateUnrealizedPnL(r);
                const pnlClass = pnl >= 0 ? 'scanner-panel__cell-pnl--profit' : 'scanner-panel__cell-pnl--loss';
                const pnlSign = pnl >= 0 ? '+' : '';

                // Format target price with appropriate styling
                let targetHtml = '<span class="scanner-panel__cell-target--none">-</span>';
                if (r.targetPrice !== null) {
                    const progressPercent = this.calculateTargetProgress(r);

                    // Color gradient: wrong-way/early = dimmer, closer = brighter green
                    const targetClass = progressPercent !== null && progressPercent >= 75 ? 'scanner-panel__cell-target--close' :
                        progressPercent !== null && progressPercent >= 50 ? 'scanner-panel__cell-target--mid' :
                            'scanner-panel__cell-target--far';
                    targetHtml = `<span class="${targetClass}">${r.targetPrice.toFixed(4)}</span>`;
                }

                return `
                <tr class="scanner-panel__result-row" data-symbol="${r.symbol}">
                    <td class="scanner-panel__cell-pair">${r.displayName}</td>
                    <td class="scanner-panel__cell-dir scanner-panel__cell-dir--${r.direction}">
                        ${r.direction.toUpperCase()}
                    </td>
                    <td class="scanner-panel__cell-strategy">${r.strategy.replace(/_/g, ' ')}</td>
                    <td class="scanner-panel__cell-price">${r.signal.price.toFixed(4)}</td>
                    <td class="scanner-panel__cell-price">${r.currentPrice.toFixed(4)}</td>
                    <td class="scanner-panel__cell-target">${targetHtml}</td>
                    <td class="scanner-panel__cell-pnl ${pnlClass}">${pnlSign}${pnl.toFixed(2)}%</td>
                    <td class="scanner-panel__cell-age">${r.signalAge} bar${r.signalAge !== 1 ? 's' : ''}</td>
                    <td class="scanner-panel__cell-alert"><button class="scanner-panel__alert-btn" data-symbol="${r.symbol}" data-strategy-key="${r.strategyKey}" data-config-name="${encodeURIComponent(r.strategy)}" title="Subscribe to alerts">Alert</button></td>
                </tr>
            `;
            })
            .join('');

        // Add click handlers to rows
        tbody.querySelectorAll('.scanner-panel__result-row').forEach((row) => {
            row.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.scanner-panel__alert-btn')) return;
                const symbol = (row as HTMLElement).dataset.symbol;
                if (symbol) this.handleResultClick(symbol);
            });
        });

        // Add click handlers to alert buttons
        tbody.querySelectorAll('.scanner-panel__alert-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const el = e.currentTarget as HTMLElement;
                const encodedName = el.dataset.configName;
                const configName = encodedName ? decodeURIComponent(encodedName) : undefined;
                this.handleAlertSubscribe(el.dataset.symbol!, el.dataset.strategyKey!, configName);
            });
        });
    }

    private handleResultClick(symbol: string): void {
        // Dispatch custom event to load this symbol in the main chart
        window.dispatchEvent(
            new CustomEvent('scanner:load-symbol', {
                detail: { symbol },
            })
        );
    }

    private updateLastScanTime(time: Date | null): void {
        const el = this.container.querySelector('.scanner-panel__last-scan') as HTMLElement;
        if (el && time) {
            el.textContent = `Last scan: ${time.toLocaleTimeString()}`;
        }
    }

    private async handleAlertSubscribe(symbol: string, strategyKey: string, configName?: string): Promise<void> {
        const config = scannerManager.getConfig();
        const matched = config.strategyConfigs.find(c => c.strategyKey === strategyKey && (!configName || c.name === configName))
            ?? config.strategyConfigs.find(c => c.strategyKey === strategyKey);

        try {
            await alertService.upsertSubscription({
                symbol,
                interval: config.interval,
                strategyKey,
                strategyParams: matched?.strategyParams,
                backtestSettings: matched?.backtestSettings,
                freshnessBars: config.signalFreshnessBars,
                notifyTelegram: true,
                notifyExit: true,
                enabled: true,
            });
            uiManager.showToast(`Alert subscribed: ${symbol} ${config.interval}`, 'success');
        } catch (err) {
            uiManager.showToast(`Alert failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
    }

    private showError(message: string): void {
        const tbody = this.container.querySelector('.scanner-panel__results-body') as HTMLTableSectionElement;
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="9" class="scanner-panel__error">Error: ${message}</td></tr>`;
        }
    }
}

// Export singleton instance
export const scannerPanel = new ScannerPanel();


