
import { state } from './state';
import { analyzeTradePatterns, simulateFilter, findBestComboFilter, FeatureAnalysis, AnalysisOptions } from './strategies/backtest/trade-analyzer';
import { Trade, TradeSnapshot } from './types/index';
import { uiManager } from './ui-manager';

/**
 * Maps TradeSnapshot feature keys â†’ settings UI element IDs.
 * Each entry defines the toggle checkbox ID and one or two value input IDs.
 * "direction" controls how above/below maps to min vs max inputs.
 */
const FEATURE_TO_SETTINGS: Record<keyof TradeSnapshot, {
    toggleId: string;
    /** For simple single-value filters (e.g. barsFromHigh only has max) */
    inputId?: string;
    /** Direction that this single-value input supports. */
    inputKind?: 'min' | 'max';
    /** For range filters â€” aboveâ†’min, belowâ†’max */
    minInputId?: string;
    maxInputId?: string;
} | null> = {
    rsi: { toggleId: 'snapshotRsiFilterToggle', minInputId: 'snapshotRsiMin', maxInputId: 'snapshotRsiMax' },
    adx: { toggleId: 'snapshotAdxFilterToggle', minInputId: 'snapshotAdxMin', maxInputId: 'snapshotAdxMax' },
    atrPercent: { toggleId: 'snapshotAtrFilterToggle', minInputId: 'snapshotAtrPercentMin', maxInputId: 'snapshotAtrPercentMax' },
    emaDistance: { toggleId: 'snapshotEmaFilterToggle', minInputId: 'snapshotEmaDistanceMin', maxInputId: 'snapshotEmaDistanceMax' },
    volumeRatio: { toggleId: 'snapshotVolumeFilterToggle', minInputId: 'snapshotVolumeRatioMin', maxInputId: 'snapshotVolumeRatioMax' },
    priceRangePos: { toggleId: 'snapshotPriceRangePosFilterToggle', minInputId: 'snapshotPriceRangePosMin', maxInputId: 'snapshotPriceRangePosMax' },
    barsFromHigh: { toggleId: 'snapshotBarsFromHighFilterToggle', inputId: 'snapshotBarsFromHighMax', inputKind: 'max' },
    barsFromLow: { toggleId: 'snapshotBarsFromLowFilterToggle', inputId: 'snapshotBarsFromLowMax', inputKind: 'max' },
    trendEfficiency: { toggleId: 'snapshotTrendEfficiencyFilterToggle', minInputId: 'snapshotTrendEfficiencyMin', maxInputId: 'snapshotTrendEfficiencyMax' },
    atrRegimeRatio: { toggleId: 'snapshotAtrRegimeFilterToggle', minInputId: 'snapshotAtrRegimeRatioMin', maxInputId: 'snapshotAtrRegimeRatioMax' },
    bodyPercent: { toggleId: 'snapshotBodyPercentFilterToggle', minInputId: 'snapshotBodyPercentMin', maxInputId: 'snapshotBodyPercentMax' },
    wickSkew: { toggleId: 'snapshotWickSkewFilterToggle', minInputId: 'snapshotWickSkewMin', maxInputId: 'snapshotWickSkewMax' },
    volumeTrend: { toggleId: 'snapshotVolumeTrendFilterToggle', minInputId: 'snapshotVolumeTrendMin', maxInputId: 'snapshotVolumeTrendMax' },
    volumeBurst: { toggleId: 'snapshotVolumeBurstFilterToggle', minInputId: 'snapshotVolumeBurstMin', maxInputId: 'snapshotVolumeBurstMax' },
    volumePriceDivergence: { toggleId: 'snapshotVolumePriceDivergenceFilterToggle', minInputId: 'snapshotVolumePriceDivergenceMin', maxInputId: 'snapshotVolumePriceDivergenceMax' },
    volumeConsistency: { toggleId: 'snapshotVolumeConsistencyFilterToggle', minInputId: 'snapshotVolumeConsistencyMin', maxInputId: 'snapshotVolumeConsistencyMax' },
};

/**
 * Analysis Panel â€” Trade pattern mining UI controller.
 * Reads trades from `state.currentBacktestResult`, runs analysis,
 * and renders results into the analysis tab.
 *
 * Optimized for **expectancy** (average edge per trade) rather than
 * pure win rate, so filters don't remove profitable-but-lossy trades.
 */
class AnalysisPanel {
    private lastResults: FeatureAnalysis[] = [];


    /** Run analysis on the current backtest result and render results. */
    runAnalysis() {
        const result = state.currentBacktestResult;
        const emptyEl = document.getElementById('emptyAnalysis');
        const contentEl = document.getElementById('analysisContent');

        if (!result || result.trades.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            if (contentEl) contentEl.style.display = 'none';
            return;
        }

        // Check if trades have snapshots
        const tradesWithSnapshots = result.trades.filter(t => t.entrySnapshot);
        if (tradesWithSnapshots.length < 4) {
            if (emptyEl) {
                emptyEl.style.display = '';
                const desc = emptyEl.querySelector('.empty-state-description');
                if (desc) desc.textContent = 'Not enough trades with indicator snapshots. Re-run the backtest to capture snapshots.';
            }
            if (contentEl) contentEl.style.display = 'none';
            return;
        }

        // Run analysis
        const options = this.readAnalysisOptions();
        const analyses = analyzeTradePatterns(result.trades, options);
        this.lastResults = analyses;

        if (emptyEl) emptyEl.style.display = 'none';
        if (contentEl) contentEl.style.display = '';

        // Update summary
        const summaryEl = document.getElementById('analysisSummary');
        if (summaryEl) {
            const wins = result.trades.filter(t => t.pnl > 0).length;
            const total = result.trades.length;
            const netPnl = result.trades.reduce((s, t) => s + t.pnl, 0);
            const avgExp = total > 0 ? netPnl / total : 0;
            summaryEl.textContent = `${total} trades (${wins}W / ${total - wins}L) â€¢ Exp $${avgExp.toFixed(2)}/trade â€¢ ${tradesWithSnapshots.length} with snapshots`;
        }

        // Render table
        this.renderTable(analyses, result.trades);

        // Auto-compute and render combo filter
        this.renderComboFilter(analyses, result.trades, options);

        // Hide single-filter simulation initially
        const simEl = document.getElementById('analysisSimulation');
        if (simEl) simEl.style.display = 'none';
    }

    private renderTable(analyses: FeatureAnalysis[], trades: Trade[]) {
        const tbody = document.getElementById('analysisTableBody');
        if (!tbody) return;

        if (analyses.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-secondary);padding:20px;">
                No discriminating features found. Win/loss distributions are similar across all indicators.
            </td></tr>`;
            return;
        }

        tbody.innerHTML = analyses.map(a => {
            const scorePercent = Math.round(a.separationScore * 100);
            const scoreClass = scorePercent >= 50 ? 'score-high'
                : scorePercent >= 25 ? 'score-medium'
                    : 'score-low';
            const rowClass = scorePercent >= 40 ? 'high-score' : '';

            const filterText = a.suggestedFilter
                ? `${a.suggestedFilter.direction === 'above' ? 'â‰¥' : 'â‰¤'} ${this.fmtThreshold(a.suggestedFilter.threshold)}`
                : 'â€”';
            const filterClass = a.suggestedFilter ? '' : 'no-filter';

            const wrText = a.suggestedFilter
                ? `${a.winRateIfFiltered.toFixed(1)}%`
                : 'â€”';
            const expText = a.suggestedFilter
                ? `$${a.expectancyIfFiltered >= 0 ? '+' : ''}${a.expectancyIfFiltered.toFixed(2)}`
                : 'â€”';
            const expClass = a.suggestedFilter
                ? (a.expectancyIfFiltered > 0 ? 'positive' : a.expectancyIfFiltered < 0 ? 'negative' : '')
                : '';
            const removedText = a.suggestedFilter
                ? `${a.tradesRemovedPercent.toFixed(0)}%`
                : 'â€”';

            const simBtn = a.suggestedFilter
                ? `<button class="btn-simulate" data-feature="${a.feature}" data-dir="${a.suggestedFilter.direction}" data-threshold="${a.suggestedFilter.threshold}">Test</button>`
                : '';

            const applyBtn = a.suggestedFilter
                ? `<button class="btn-apply-filter" data-feature="${a.feature}" data-dir="${a.suggestedFilter.direction}" data-threshold="${a.suggestedFilter.threshold}" title="Apply to Entry Quality Filters in Settings">Apply</button>`
                : '';

            return `<tr class="${rowClass}">
                <td><strong>${a.label}</strong></td>
                <td>${this.fmt(a.winStats.mean)}</td>
                <td>${this.fmt(a.lossStats.mean)}</td>
                <td>
                    <span class="score-bar">
                        <span class="score-bar-fill ${scoreClass}" style="width:${Math.max(2, scorePercent / 2)}px"></span>
                        ${scorePercent}%
                    </span>
                </td>
                <td><span class="filter-badge ${filterClass}">${filterText}</span></td>
                <td>${wrText}</td>
                <td class="${expClass}">${expText}</td>
                <td>${removedText}</td>
                <td style="display:flex;gap:4px;">${simBtn}${applyBtn}</td>
            </tr>`;
        }).join('');

        // Bind simulate buttons
        tbody.querySelectorAll('.btn-simulate').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const el = e.currentTarget as HTMLElement;
                const feature = el.dataset.feature as keyof TradeSnapshot;
                const dir = el.dataset.dir as 'above' | 'below';
                const threshold = parseFloat(el.dataset.threshold!);
                this.runSimulation(trades, feature, dir, threshold);
            });
        });

        // Bind apply buttons
        tbody.querySelectorAll('.btn-apply-filter').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const el = e.currentTarget as HTMLElement;
                const feature = el.dataset.feature as keyof TradeSnapshot;
                const dir = el.dataset.dir as 'above' | 'below';
                const threshold = parseFloat(el.dataset.threshold!);
                this.applyFilterToSettings(feature, dir, threshold, el);
            });
        });
    }

    private renderComboFilter(analyses: FeatureAnalysis[], trades: Trade[], options: AnalysisOptions) {
        const comboEl = document.getElementById('comboFilterSection');
        if (!comboEl) return;

        const comboMaxRemoval = this.resolveComboMaxRemoval(options);
        const best = findBestComboFilter(trades, analyses, comboMaxRemoval);
        if (!best || best.expectancyImprovement <= 0) {
            comboEl.style.display = 'none';
            return;
        }

        comboEl.style.display = '';
        const comboGrid = document.getElementById('comboFilterGrid');
        if (!comboGrid) return;

        const filterDesc = best.filters
            .map(f => `<span class="filter-badge">${f.label} ${f.direction === 'above' ? 'â‰¥' : 'â‰¤'} ${this.fmtThreshold(f.threshold)}</span>`)
            .join(' <span style="color:var(--text-secondary);font-size:10px;">AND</span> ');

        const expSign = best.filteredExpectancy >= 0 ? '+' : '';
        const expImpSign = best.expectancyImprovement >= 0 ? '+' : '';
        const pfText = best.filteredProfitFactor === Infinity ? 'âˆž' : best.filteredProfitFactor.toFixed(2);

        comboGrid.innerHTML = `
            <div class="sim-card" style="grid-column: 1 / -1;">
                <div class="sim-card-label">Combined Filter (AND)</div>
                <div class="sim-card-value" style="font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${filterDesc}</div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Trades Remaining</div>
                <div class="sim-card-value">${best.remainingTrades} / ${best.originalTrades}</div>
                <div class="sim-card-delta negative">-${best.removedPercent.toFixed(1)}% removed</div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Filtered Expectancy</div>
                <div class="sim-card-value ${best.filteredExpectancy > 0 ? 'positive' : 'negative'}">
                    $${expSign}${best.filteredExpectancy.toFixed(2)}/trade
                </div>
                <div class="sim-card-delta ${best.expectancyImprovement > 0 ? 'positive' : 'negative'}">
                    ${expImpSign}$${best.expectancyImprovement.toFixed(2)} vs $${best.originalExpectancy.toFixed(2)}
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Win Rate</div>
                <div class="sim-card-value ${best.winRateImprovement > 0 ? 'positive' : best.winRateImprovement < 0 ? 'negative' : 'neutral'}">
                    ${best.filteredWinRate.toFixed(1)}%
                </div>
                <div class="sim-card-delta" style="color:var(--text-secondary);">
                    ${best.winRateImprovement > 0 ? '+' : ''}${best.winRateImprovement.toFixed(1)}%
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Profit Factor</div>
                <div class="sim-card-value ${best.filteredProfitFactor > 1 ? 'positive' : 'negative'}">
                    ${pfText}
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Net PnL</div>
                <div class="sim-card-value ${best.filteredNetPnl > 0 ? 'positive' : best.filteredNetPnl < 0 ? 'negative' : 'neutral'}">
                    $${best.filteredNetPnl.toFixed(2)}
                </div>
            </div>
            <div class="sim-card" style="grid-column: 1 / -1; display: flex; justify-content: center; padding: 8px;">
                <button class="btn-apply-combo" title="Apply all combo filters to Entry Quality Filters in Settings">Apply All to Settings</button>
            </div>
        `;

        // Bind the Apply All button
        const applyComboBtn = comboGrid.querySelector('.btn-apply-combo');
        if (applyComboBtn && best) {
            const comboFilters = best.filters;
            applyComboBtn.addEventListener('click', () => {
                let allApplied = true;
                for (const f of comboFilters) {
                    const applied = this.applyFilterToSettings(f.feature as keyof TradeSnapshot, f.direction, f.threshold);
                    if (!applied) allApplied = false;
                }
                (applyComboBtn as HTMLElement).textContent = allApplied ? '\u2713 Applied!' : 'Partial';
                setTimeout(() => { (applyComboBtn as HTMLElement).textContent = 'Apply All to Settings'; }, 1500);
            });
        }
    }

    private runSimulation(
        trades: Trade[],
        feature: keyof TradeSnapshot,
        direction: 'above' | 'below',
        threshold: number
    ) {
        const sim = simulateFilter(trades, feature, direction, threshold);
        const simEl = document.getElementById('analysisSimulation');
        const grid = document.getElementById('simulationGrid');
        if (!simEl || !grid) return;

        simEl.style.display = '';

        const featureLabel = this.lastResults.find(r => r.feature === feature)?.label ?? feature;
        const expSign = sim.filteredExpectancy >= 0 ? '+' : '';
        const expImpSign = sim.expectancyImprovement >= 0 ? '+' : '';
        const pfText = sim.filteredProfitFactor === Infinity ? 'âˆž' : sim.filteredProfitFactor.toFixed(2);

        grid.innerHTML = `
            <div class="sim-card">
                <div class="sim-card-label">Filter</div>
                <div class="sim-card-value">${featureLabel} ${direction === 'above' ? 'â‰¥' : 'â‰¤'} ${this.fmtThreshold(threshold)}</div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Trades Remaining</div>
                <div class="sim-card-value">${sim.remainingTrades} / ${sim.originalTrades}</div>
                <div class="sim-card-delta negative">-${sim.removedPercent.toFixed(1)}% removed</div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Filtered Expectancy</div>
                <div class="sim-card-value ${sim.filteredExpectancy > 0 ? 'positive' : sim.filteredExpectancy < 0 ? 'negative' : 'neutral'}">
                    $${expSign}${sim.filteredExpectancy.toFixed(2)}/trade
                </div>
                <div class="sim-card-delta ${sim.expectancyImprovement > 0 ? 'positive' : 'negative'}">
                    ${expImpSign}$${sim.expectancyImprovement.toFixed(2)} vs $${sim.originalExpectancy.toFixed(2)}
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Win Rate</div>
                <div class="sim-card-value ${sim.winRateImprovement > 0 ? 'positive' : sim.winRateImprovement < 0 ? 'negative' : 'neutral'}">
                    ${sim.filteredWinRate.toFixed(1)}%
                </div>
                <div class="sim-card-delta" style="color:var(--text-secondary);">
                    ${sim.winRateImprovement > 0 ? '+' : ''}${sim.winRateImprovement.toFixed(1)}% from ${sim.originalWinRate.toFixed(1)}%
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Profit Factor</div>
                <div class="sim-card-value ${sim.filteredProfitFactor > 1 ? 'positive' : 'negative'}">
                    ${pfText}
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Net PnL</div>
                <div class="sim-card-value ${sim.filteredNetPnl > 0 ? 'positive' : sim.filteredNetPnl < 0 ? 'negative' : 'neutral'}">
                    $${sim.filteredNetPnl.toFixed(2)}
                </div>
            </div>
        `;
    }

    private fmt(val: number): string {
        if (Math.abs(val) >= 1000) return val.toFixed(0);
        if (Math.abs(val) >= 10) return val.toFixed(1);
        return val.toFixed(2);
    }

    private fmtThreshold(val: number): string {
        const abs = Math.abs(val);
        const decimals = abs >= 100 ? 2
            : abs >= 1 ? 3
                : abs >= 0.1 ? 4
                    : abs >= 0.01 ? 5
                        : 6;
        return val.toFixed(decimals).replace(/\.?0+$/, '');
    }

    private readAnalysisOptions(): AnalysisOptions {
        const relaxToggle = document.getElementById('analysisRelaxModeToggle') as HTMLInputElement | null;
        const maxRemovalInput = document.getElementById('analysisMaxRemovalPercent') as HTMLInputElement | null;

        if (!relaxToggle?.checked) {
            return { mode: 'quality' };
        }

        const parsed = maxRemovalInput ? parseFloat(maxRemovalInput.value) : NaN;
        const maxSingleRemoval = Number.isFinite(parsed) ? Math.max(5, Math.min(90, parsed)) : 20;
        return {
            mode: 'relax_aware',
            maxSingleRemoval,
            relaxExpectancyTolerancePct: 0.1
        };
    }

    private resolveComboMaxRemoval(options: AnalysisOptions): number {
        if (options.mode !== 'relax_aware') return 40;
        const base = options.maxSingleRemoval ?? 20;
        return Math.max(base, Math.min(50, base + 10));
    }

    private applyRelaxModeControlState() {
        const relaxToggle = document.getElementById('analysisRelaxModeToggle') as HTMLInputElement | null;
        const maxRemovalInput = document.getElementById('analysisMaxRemovalPercent') as HTMLInputElement | null;
        if (!relaxToggle || !maxRemovalInput) return;
        maxRemovalInput.disabled = !relaxToggle.checked;
    }

    /**
     * Apply a suggested filter threshold to the Entry Quality Filters in settings.
     * Sets the value in the corresponding input and enables its toggle.
     */
    private applyFilterToSettings(
        feature: keyof TradeSnapshot,
        direction: 'above' | 'below',
        threshold: number,
        buttonEl?: HTMLElement
    ): boolean {
        const mapping = FEATURE_TO_SETTINGS[feature];
        if (!mapping) {
            uiManager.showToast(`No settings mapping found for feature: ${String(feature)}`, 'warning');
            return false;
        }

        // Set the value
        if (mapping.inputId) {
            const inputKind = mapping.inputKind ?? 'max';
            const unsupportedDirection = (inputKind === 'max' && direction === 'above')
                || (inputKind === 'min' && direction === 'below');
            if (unsupportedDirection) {
                const label = this.lastResults.find(r => r.feature === feature)?.label ?? String(feature);
                uiManager.showToast(
                    `Cannot apply ${label} ${direction === 'above' ? '≥' : '≤'} ${this.fmtThreshold(threshold)}: this filter supports only ${inputKind}.`,
                    'warning'
                );
                return false;
            }
            this.setInputValue(mapping.inputId, threshold);
        } else if (mapping.minInputId && mapping.maxInputId) {
            // Range filters: above -> set min, below -> set max.
            // Keep bounds valid to avoid accidental min > max conflicts.
            if (direction === 'above') {
                this.setInputValue(mapping.minInputId, threshold);
                const currentMax = this.readInputValue(mapping.maxInputId);
                if (currentMax !== null && currentMax !== 0 && currentMax < threshold) {
                    this.setInputValue(mapping.maxInputId, threshold);
                }
            } else {
                this.setInputValue(mapping.maxInputId, threshold);
                const currentMin = this.readInputValue(mapping.minInputId);
                if (currentMin !== null && currentMin !== 0 && currentMin > threshold) {
                    this.setInputValue(mapping.minInputId, threshold);
                }
            }
        }

        // Enable the toggle only after a successful value application.
        const toggle = document.getElementById(mapping.toggleId) as HTMLInputElement | null;
        if (toggle) {
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Visual feedback on the button
        if (buttonEl) {
            const origText = buttonEl.textContent;
            buttonEl.textContent = '\u2713';
            buttonEl.classList.add('applied');
            setTimeout(() => {
                buttonEl.textContent = origText;
                buttonEl.classList.remove('applied');
            }, 1200);
        }
        return true;
    }

    private setInputValue(inputId: string, value: number) {
        const input = document.getElementById(inputId) as HTMLInputElement | null;
        if (!input) return;
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    private readInputValue(inputId: string): number | null {
        const input = document.getElementById(inputId) as HTMLInputElement | null;
        if (!input) return null;
        const parsed = parseFloat(input.value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** Wire button and auto-run on backtest completion. */
    init() {
        const btn = document.getElementById('runAnalysisBtn');
        if (btn) {
            btn.addEventListener('click', () => this.runAnalysis());
        }

        const relaxToggle = document.getElementById('analysisRelaxModeToggle') as HTMLInputElement | null;
        const maxRemovalInput = document.getElementById('analysisMaxRemovalPercent') as HTMLInputElement | null;
        if (relaxToggle) {
            relaxToggle.addEventListener('change', () => {
                this.applyRelaxModeControlState();
                this.runAnalysis();
            });
        }
        if (maxRemovalInput) {
            maxRemovalInput.addEventListener('input', () => {
                if ((document.getElementById('analysisRelaxModeToggle') as HTMLInputElement | null)?.checked) {
                    this.runAnalysis();
                }
            });
        }
        this.applyRelaxModeControlState();

        // Auto-run analysis when backtest completes
        state.subscribe('currentBacktestResult', () => {
            // Only auto-analyze if the analysis tab is visible
            const tab = document.getElementById('analysisTab');
            if (tab && tab.style.display !== 'none') {
                this.runAnalysis();
            }
        });

        // Also run when switching to the analysis tab
        const analysisTabBtn = document.querySelector('.panel-tab[data-tab="analysis"]');
        if (analysisTabBtn) {
            analysisTabBtn.addEventListener('click', () => {
                setTimeout(() => this.runAnalysis(), 50);
            });
        }
    }
}

export const analysisPanel = new AnalysisPanel();

