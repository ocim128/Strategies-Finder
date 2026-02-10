
import { state } from './state';
import { analyzeTradePatterns, simulateFilter, findBestComboFilter, FeatureAnalysis } from './strategies/backtest/trade-analyzer';
import { Trade, TradeSnapshot } from './types/index';

/**
 * Analysis Panel — Trade pattern mining UI controller.
 * Reads trades from `state.currentBacktestResult`, runs analysis,
 * and renders results into the analysis tab.
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
        const analyses = analyzeTradePatterns(result.trades);
        this.lastResults = analyses;

        if (emptyEl) emptyEl.style.display = 'none';
        if (contentEl) contentEl.style.display = '';

        // Update summary
        const summaryEl = document.getElementById('analysisSummary');
        if (summaryEl) {
            const wins = result.trades.filter(t => t.pnl > 0).length;
            const total = result.trades.length;
            summaryEl.textContent = `${total} trades (${wins}W / ${total - wins}L) • ${tradesWithSnapshots.length} with snapshots`;
        }

        // Render table
        this.renderTable(analyses, result.trades);

        // Auto-compute and render combo filter
        this.renderComboFilter(analyses, result.trades);

        // Hide single-filter simulation initially
        const simEl = document.getElementById('analysisSimulation');
        if (simEl) simEl.style.display = 'none';
    }

    private renderTable(analyses: FeatureAnalysis[], trades: Trade[]) {
        const tbody = document.getElementById('analysisTableBody');
        if (!tbody) return;

        if (analyses.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-secondary);padding:20px;">
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
                ? `${a.suggestedFilter.direction === 'above' ? '≥' : '≤'} ${a.suggestedFilter.threshold}`
                : '—';
            const filterClass = a.suggestedFilter ? '' : 'no-filter';

            const wrText = a.suggestedFilter
                ? `${a.winRateIfFiltered.toFixed(1)}%`
                : '—';
            const removedText = a.suggestedFilter
                ? `${a.tradesRemovedPercent.toFixed(0)}%`
                : '—';

            const simBtn = a.suggestedFilter
                ? `<button class="btn-simulate" data-feature="${a.feature}" data-dir="${a.suggestedFilter.direction}" data-threshold="${a.suggestedFilter.threshold}">Test</button>`
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
                <td>${removedText}</td>
                <td>${simBtn}</td>
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
    }

    private renderComboFilter(analyses: FeatureAnalysis[], trades: Trade[]) {
        const comboEl = document.getElementById('comboFilterSection');
        if (!comboEl) return;

        const best = findBestComboFilter(trades, analyses);
        if (!best || best.winRateImprovement < 1) {
            comboEl.style.display = 'none';
            return;
        }

        comboEl.style.display = '';
        const comboGrid = document.getElementById('comboFilterGrid');
        if (!comboGrid) return;

        const filterDesc = best.filters
            .map(f => `<span class="filter-badge">${f.label} ${f.direction === 'above' ? '≥' : '≤'} ${f.threshold}</span>`)
            .join(' <span style="color:var(--text-secondary);font-size:10px;">AND</span> ');

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
                <div class="sim-card-label">Filtered Win Rate</div>
                <div class="sim-card-value ${best.winRateImprovement > 0 ? 'positive' : 'negative'}">
                    ${best.filteredWinRate.toFixed(1)}%
                </div>
                <div class="sim-card-delta ${best.winRateImprovement > 0 ? 'positive' : 'negative'}">
                    ${best.winRateImprovement > 0 ? '+' : ''}${best.winRateImprovement.toFixed(1)}% vs ${best.originalWinRate.toFixed(1)}%
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Filtered Net PnL</div>
                <div class="sim-card-value ${best.filteredNetPnl > 0 ? 'positive' : best.filteredNetPnl < 0 ? 'negative' : 'neutral'}">
                    $${best.filteredNetPnl.toFixed(2)}
                </div>
            </div>
        `;
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

        grid.innerHTML = `
            <div class="sim-card">
                <div class="sim-card-label">Filter</div>
                <div class="sim-card-value">${featureLabel} ${direction === 'above' ? '≥' : '≤'} ${threshold}</div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Trades Remaining</div>
                <div class="sim-card-value">${sim.remainingTrades} / ${sim.originalTrades}</div>
                <div class="sim-card-delta negative">-${sim.removedPercent.toFixed(1)}% removed</div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Original Win Rate</div>
                <div class="sim-card-value neutral">${sim.originalWinRate.toFixed(1)}%</div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Filtered Win Rate</div>
                <div class="sim-card-value ${sim.winRateImprovement > 0 ? 'positive' : sim.winRateImprovement < 0 ? 'negative' : 'neutral'}">
                    ${sim.filteredWinRate.toFixed(1)}%
                </div>
                <div class="sim-card-delta ${sim.winRateImprovement > 0 ? 'positive' : 'negative'}">
                    ${sim.winRateImprovement > 0 ? '+' : ''}${sim.winRateImprovement.toFixed(1)}%
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Filtered Net PnL</div>
                <div class="sim-card-value ${sim.filteredNetPnl > 0 ? 'positive' : sim.filteredNetPnl < 0 ? 'negative' : 'neutral'}">
                    $${sim.filteredNetPnl.toFixed(2)}
                </div>
            </div>
            <div class="sim-card">
                <div class="sim-card-label">Improvement</div>
                <div class="sim-card-value ${sim.winRateImprovement > 0 ? 'positive' : 'negative'}">
                    ${sim.winRateImprovement > 0 ? '↑' : '↓'} ${Math.abs(sim.winRateImprovement).toFixed(1)}%
                </div>
            </div>
        `;
    }

    private fmt(val: number): string {
        if (Math.abs(val) >= 1000) return val.toFixed(0);
        if (Math.abs(val) >= 10) return val.toFixed(1);
        return val.toFixed(2);
    }

    /** Wire button and auto-run on backtest completion. */
    init() {
        const btn = document.getElementById('runAnalysisBtn');
        if (btn) {
            btn.addEventListener('click', () => this.runAnalysis());
        }

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
