import { state } from "./state";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { backtestService } from "./backtest-service";
import {
    runMonteCarloAnalysis,
    quickMonteCarlo,
    MonteCarloConfig,
    MonteCarloResult
} from "./strategies/monte-carlo";

// ============================================================================
// Monte-Carlo Robustness Lab Service
// ============================================================================

class MonteCarloService {
    private lastResult: MonteCarloResult | null = null;

    // Run full Monte-Carlo analysis with current strategy and data
    async runAnalysis(): Promise<MonteCarloResult | null> {
        this.setLoading(true);
        this.updateStatus("Initializing Monte-Carlo simulation...");

        try {
            const data = state.ohlcvData;
            if (!data || data.length === 0) {
                this.updateStatus("Error: No data loaded");
                return null;
            }

            const strategyKey = state.currentStrategyKey;
            const strategy = strategyRegistry.get(strategyKey);
            if (!strategy) {
                this.updateStatus("Error: No strategy selected");
                return null;
            }

            // Get current backtest result first
            if (!state.currentBacktestResult) {
                this.updateStatus("Running initial backtest...");
                await backtestService.runCurrentBacktest();
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const originalResult = state.currentBacktestResult;
            if (!originalResult || originalResult.totalTrades < 3) {
                this.updateStatus("Error: Need at least 3 trades for Monte-Carlo analysis");
                return null;
            }

            const params = paramManager.getValues(strategy);
            const config = this.getConfigFromUI();
            const capitalSettings = backtestService.getCapitalSettings();
            const backtestSettings = backtestService.getBacktestSettings();

            this.updateStatus(`Running ${config.simulations} simulations...`);

            const result = await runMonteCarloAnalysis(
                data,
                strategy,
                params,
                originalResult,
                capitalSettings.initialCapital,
                capitalSettings.positionSize,
                capitalSettings.commission,
                backtestSettings,
                config
            );

            this.lastResult = result;
            this.displayResults(result);
            this.updateStatus(`Completed ${result.totalSimulations} simulations in ${(result.simulationTimeMs / 1000).toFixed(2)}s`);

            return result;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.updateStatus(`Error: ${msg}`);
            console.error('[MonteCarloService] Error:', err);
            return null;
        } finally {
            this.setLoading(false);
        }
    }

    // Quick analysis with auto-detected settings
    async runQuickAnalysis(): Promise<MonteCarloResult | null> {
        this.setLoading(true);
        this.updateStatus("Running quick Monte-Carlo analysis...");

        try {
            const data = state.ohlcvData;
            if (!data || data.length === 0) {
                this.updateStatus("Error: No data loaded");
                return null;
            }

            const strategyKey = state.currentStrategyKey;
            const strategy = strategyRegistry.get(strategyKey);
            if (!strategy) {
                this.updateStatus("Error: No strategy selected");
                return null;
            }

            // Get current backtest result
            if (!state.currentBacktestResult) {
                await backtestService.runCurrentBacktest();
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const originalResult = state.currentBacktestResult;
            if (!originalResult || originalResult.totalTrades < 3) {
                this.updateStatus("Error: Need at least 3 trades for Monte-Carlo analysis");
                return null;
            }

            const params = paramManager.getValues(strategy);
            const capitalSettings = backtestService.getCapitalSettings();

            const result = await quickMonteCarlo(
                data,
                strategy,
                params,
                originalResult,
                capitalSettings.initialCapital,
                capitalSettings.positionSize,
                capitalSettings.commission
            );

            this.lastResult = result;
            this.displayResults(result);
            this.updateStatus(`Quick analysis completed in ${(result.simulationTimeMs / 1000).toFixed(2)}s`);

            return result;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.updateStatus(`Error: ${msg}`);
            console.error('[MonteCarloService] Quick analysis error:', err);
            return null;
        } finally {
            this.setLoading(false);
        }
    }

    // Get config from UI inputs
    private getConfigFromUI(): Partial<MonteCarloConfig> {
        return {
            simulations: this.readNumberInput('mc-simulations', 500),
            blockSize: this.readNumberInput('mc-block-size', 0),
            slippageBps: this.readNumberInput('mc-slippage', 5),
            spreadBps: this.readNumberInput('mc-spread', 2),
            latencyBars: this.readNumberInput('mc-latency', 0),
            minTrades: this.readNumberInput('mc-min-trades', 5)
        };
    }

    private readNumberInput(id: string, fallback: number): number {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return fallback;
        const value = parseFloat(el.value);
        return Number.isFinite(value) ? value : fallback;
    }

    // Display results in the UI
    private displayResults(result: MonteCarloResult): void {
        this.updateRobustnessGauge(result.robustnessScore, result.fragilityIndex);
        this.updateSummaryPanel(result);
        this.updateDistributionTable(result);
        this.plotDistributionChart(result);
    }

    private updateRobustnessGauge(robustness: number, fragility: number): void {
        const gauge = document.getElementById('mc-robustness-gauge');
        const scoreEl = document.getElementById('mc-robustness-score');
        const descEl = document.getElementById('mc-robustness-desc');
        const fragilityEl = document.getElementById('mc-fragility-score');

        if (gauge) {
            gauge.style.setProperty('--score', String(robustness));

            // Remove all state classes
            gauge.classList.remove('excellent', 'good', 'moderate', 'poor', 'critical');

            // Add appropriate class
            if (robustness >= 80) gauge.classList.add('excellent');
            else if (robustness >= 60) gauge.classList.add('good');
            else if (robustness >= 40) gauge.classList.add('moderate');
            else if (robustness >= 20) gauge.classList.add('poor');
            else gauge.classList.add('critical');
        }

        if (scoreEl) scoreEl.textContent = String(robustness);
        if (fragilityEl) fragilityEl.textContent = String(fragility);

        if (descEl) {
            if (robustness >= 80 && fragility <= 20) {
                descEl.textContent = '🟢 Excellent - Highly robust, low noise sensitivity';
            } else if (robustness >= 60) {
                descEl.textContent = '🟡 Good - Reasonably robust, some sensitivity';
            } else if (robustness >= 40) {
                descEl.textContent = '🟠 Moderate - Mixed robustness, review params';
            } else if (robustness >= 20) {
                descEl.textContent = '🔴 Poor - Fragile strategy, high sensitivity';
            } else {
                descEl.textContent = '⛔ Critical - Likely curve-fitted';
            }
        }
    }

    private updateSummaryPanel(result: MonteCarloResult): void {
        const panel = document.getElementById('mc-summary-panel');
        if (!panel) return;

        const formatCurrency = (n: number) => {
            const sign = n >= 0 ? '+' : '';
            return `${sign}$${n.toFixed(2)}`;
        };

        const formatPercent = (n: number) => `${n.toFixed(1)}%`;

        // Create stat items
        const stats = [
            { label: 'P(Profit)', value: formatPercent(result.probabilityOfProfit), positive: result.probabilityOfProfit > 50 },
            { label: 'PSR', value: formatPercent(result.probabilisticSharpeRatio), positive: result.probabilisticSharpeRatio > 50 },
            { label: '5% Profit', value: formatCurrency(result.netProfit5th), positive: result.netProfit5th > 0 },
            { label: '50% Profit', value: formatCurrency(result.netProfit50th), positive: result.netProfit50th > 0 },
            { label: '95% Profit', value: formatCurrency(result.netProfit95th), positive: result.netProfit95th > 0 },
            { label: 'Mean Profit', value: formatCurrency(result.netProfitMean), positive: result.netProfitMean > 0 },
            { label: '50% MaxDD', value: formatPercent(result.maxDD50th), positive: result.maxDD50th < 15 },
            { label: '95% MaxDD', value: formatPercent(result.maxDD95th), positive: result.maxDD95th < 30 },
            { label: 'Deflated SR', value: result.deflatedSharpeRatio.toFixed(3), positive: result.deflatedSharpeRatio > 0 },
            { label: 'Fragility', value: String(result.fragilityIndex), positive: result.fragilityIndex < 40 }
        ];

        panel.innerHTML = stats.map(stat => `
            <div class="mc-stat">
                <div class="mc-label">${stat.label}</div>
                <div class="mc-value ${stat.positive ? 'positive' : 'negative'}">${stat.value}</div>
            </div>
        `).join('');
    }

    private updateDistributionTable(result: MonteCarloResult): void {
        const tbody = document.getElementById('mc-dist-table-body');
        if (!tbody) return;

        const rows = [
            {
                metric: 'Net Profit',
                p5: `$${result.netProfit5th.toFixed(0)}`,
                p25: `$${result.netProfit25th.toFixed(0)}`,
                p50: `$${result.netProfit50th.toFixed(0)}`,
                p75: `$${result.netProfit75th.toFixed(0)}`,
                p95: `$${result.netProfit95th.toFixed(0)}`,
                original: `$${result.originalResult.netProfit.toFixed(0)}`,
                class: result.netProfit50th > 0 ? 'positive' : 'negative'
            },
            {
                metric: 'Max DD %',
                p5: `${result.maxDD5th.toFixed(1)}%`,
                p25: '-',
                p50: `${result.maxDD50th.toFixed(1)}%`,
                p75: '-',
                p95: `${result.maxDD95th.toFixed(1)}%`,
                original: `${result.originalResult.maxDrawdownPercent.toFixed(1)}%`,
                class: result.maxDD50th < 20 ? 'positive' : 'negative'
            },
            {
                metric: 'Sharpe',
                p5: result.sharpe5th.toFixed(2),
                p25: '-',
                p50: result.sharpe50th.toFixed(2),
                p75: '-',
                p95: result.sharpe95th.toFixed(2),
                original: result.originalResult.sharpeRatio.toFixed(2),
                class: result.sharpe50th > 0 ? 'positive' : 'negative'
            }
        ];

        tbody.innerHTML = rows.map(row => `
            <tr class="${row.class}">
                <td>${row.metric}</td>
                <td>${row.p5}</td>
                <td>${row.p25}</td>
                <td>${row.p50}</td>
                <td>${row.p75}</td>
                <td>${row.p95}</td>
                <td><strong>${row.original}</strong></td>
            </tr>
        `).join('');
    }

    private plotDistributionChart(result: MonteCarloResult): void {
        // Simple histogram visualization using CSS bars
        const chartContainer = document.getElementById('mc-histogram');
        if (!chartContainer) return;

        // Create histogram buckets for net profit
        const profits = result.simulations.map(s => s.netProfit).sort((a, b) => a - b);
        const min = profits[0];
        const max = profits[profits.length - 1];
        const range = max - min || 1;
        const bucketCount = 20;
        const bucketSize = range / bucketCount;

        const buckets: number[] = Array(bucketCount).fill(0);
        for (const profit of profits) {
            const bucketIndex = Math.min(
                bucketCount - 1,
                Math.floor((profit - min) / bucketSize)
            );
            buckets[bucketIndex]++;
        }

        const maxBucket = Math.max(...buckets);

        // Find which bucket the original result falls into
        const originalBucket = Math.min(
            bucketCount - 1,
            Math.floor((result.originalResult.netProfit - min) / bucketSize)
        );

        chartContainer.innerHTML = `
            <div class="mc-histogram-chart">
                ${buckets.map((count, i) => {
            const height = maxBucket > 0 ? (count / maxBucket) * 100 : 0;
            const isPositive = min + (i + 0.5) * bucketSize >= 0;
            const isOriginal = i === originalBucket;
            return `
                        <div class="mc-bar-wrapper" title="${count} simulations">
                            <div class="mc-bar ${isPositive ? 'positive' : 'negative'} ${isOriginal ? 'original' : ''}"
                                 style="height: ${height}%">
                            </div>
                        </div>
                    `;
        }).join('')}
            </div>
            <div class="mc-histogram-labels">
                <span>$${min.toFixed(0)}</span>
                <span class="mc-histogram-title">Net Profit Distribution</span>
                <span>$${max.toFixed(0)}</span>
            </div>
        `;
    }

    private setLoading(loading: boolean): void {
        const spinner = document.getElementById('mc-spinner');
        const runBtn = document.getElementById('mc-run-btn') as HTMLButtonElement | null;

        if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
        if (runBtn) runBtn.disabled = loading;
    }

    private updateStatus(message: string): void {
        const statusEl = document.getElementById('mc-status');
        if (statusEl) statusEl.textContent = message;
    }

    // Get last analysis result
    getLastResult(): MonteCarloResult | null {
        return this.lastResult;
    }

    // Initialize UI event listeners
    initUI(): void {
        const runBtn = document.getElementById('mc-run-btn');
        const quickBtn = document.getElementById('mc-quick-btn');

        if (runBtn) {
            runBtn.addEventListener('click', () => this.runAnalysis());
        }

        if (quickBtn) {
            quickBtn.addEventListener('click', () => this.runQuickAnalysis());
        }
    }
}

export const monteCarloService = new MonteCarloService();
