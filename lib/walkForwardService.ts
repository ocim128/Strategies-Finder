import { state } from "./state";
import { chartManager } from "./chartManager";
import { uiManager } from "./uiManager";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./paramManager";
import { debugLogger } from "./debugLogger";
import { backtestService } from "./backtestService";
import {
    runWalkForwardAnalysis,
    quickWalkForward,
    formatWalkForwardSummary,
    WalkForwardConfig,
    WalkForwardResult,
    ParameterRange
} from "./strategies/walk-forward";

// ============================================================================
// Walk-Forward Service
// ============================================================================

class WalkForwardService {
    private lastResult: WalkForwardResult | null = null;

    /**
     * Run walk-forward analysis with current strategy and data
     */
    async runAnalysis(): Promise<WalkForwardResult | null> {
        const data = state.ohlcvData;
        if (!data || data.length === 0) {
            debugLogger.error('No data loaded for walk-forward analysis');
            return null;
        }

        const strategyKey = state.currentStrategyKey;
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            debugLogger.error(`Strategy not found: ${strategyKey}`);
            return null;
        }

        // Get current parameters
        const currentParams = paramManager.getValues(strategy);

        // Build parameter ranges from strategy defaults
        const parameterRanges = this.buildParameterRanges(strategy.defaultParams, currentParams);

        // Get config from UI
        const config = this.getConfigFromUI(parameterRanges);

        // Get capital settings from backtest service
        const capitalSettings = backtestService.getCapitalSettings();
        const backtestSettings = backtestService.getBacktestSettings();

        this.setLoading(true);
        this.updateStatus('Running walk-forward analysis...');

        try {
            const startTime = performance.now();

            const result = await runWalkForwardAnalysis(
                data,
                { ...strategy, defaultParams: currentParams },
                config,
                capitalSettings.initialCapital,
                capitalSettings.positionSize,
                capitalSettings.commission,
                backtestSettings
            );

            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            debugLogger.info(`Walk-forward analysis completed in ${elapsed}s`);
            debugLogger.info(`Windows: ${result.totalWindows}, Robustness: ${result.robustnessScore}/100`);

            this.lastResult = result;
            this.displayResults(result);
            this.updateStatus(`Completed: ${result.totalWindows} windows, Robustness: ${result.robustnessScore}/100`);

            return result;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            debugLogger.error(`Walk-forward analysis failed: ${msg}`);
            this.updateStatus(`Error: ${msg}`);
            return null;
        } finally {
            this.setLoading(false);
        }
    }

    /**
     * Quick analysis with auto-detected settings
     */
    async runQuickAnalysis(): Promise<WalkForwardResult | null> {
        const data = state.ohlcvData;
        if (!data || data.length === 0) {
            debugLogger.error('No data loaded for walk-forward analysis');
            return null;
        }

        const strategyKey = state.currentStrategyKey;
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            debugLogger.error(`Strategy not found: ${strategyKey}`);
            return null;
        }

        const capitalSettings = backtestService.getCapitalSettings();

        this.setLoading(true);
        this.updateStatus('Running quick walk-forward analysis...');

        try {
            const result = await quickWalkForward(
                data,
                strategy,
                capitalSettings.initialCapital,
                capitalSettings.positionSize,
                capitalSettings.commission
            );

            this.lastResult = result;
            this.displayResults(result);
            this.updateStatus(`Quick analysis: Robustness ${result.robustnessScore}/100`);

            return result;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            debugLogger.error(`Quick walk-forward failed: ${msg}`);
            this.updateStatus(`Error: ${msg}`);
            return null;
        } finally {
            this.setLoading(false);
        }
    }

    /**
     * Build parameter ranges from current params with reasonable bounds
     */
    private buildParameterRanges(defaults: Record<string, number>, current: Record<string, number>): ParameterRange[] {
        const ranges: ParameterRange[] = [];

        // Get custom ranges from UI if available
        const rangeInputs = document.querySelectorAll('[data-param-range]');
        const customRanges = new Map<string, { min: number; max: number; step: number }>();

        rangeInputs.forEach(input => {
            const el = input as HTMLInputElement;
            const paramName = el.dataset.paramRange;
            const rangeType = el.dataset.rangeType;
            if (paramName && rangeType) {
                if (!customRanges.has(paramName)) {
                    customRanges.set(paramName, { min: 0, max: 0, step: 1 });
                }
                const range = customRanges.get(paramName)!;
                if (rangeType === 'min') range.min = parseFloat(el.value) || 0;
                if (rangeType === 'max') range.max = parseFloat(el.value) || 0;
                if (rangeType === 'step') range.step = parseFloat(el.value) || 1;
            }
        });

        for (const [name, value] of Object.entries(current)) {
            if (customRanges.has(name)) {
                const custom = customRanges.get(name)!;
                if (custom.min < custom.max) {
                    ranges.push({ name, ...custom });
                    continue;
                }
            }

            // Auto-generate reasonable range around current value
            const baseValue = value || defaults[name] || 10;
            const min = Math.max(1, Math.floor(baseValue * 0.5));
            const max = Math.ceil(baseValue * 1.5);
            const step = Math.max(1, Math.floor((max - min) / 4));

            ranges.push({ name, min, max, step });
        }

        return ranges;
    }

    /**
     * Get walk-forward config from UI inputs
     */
    private getConfigFromUI(parameterRanges: ParameterRange[]): WalkForwardConfig {
        const data = state.ohlcvData || [];
        const totalBars = data.length;

        // Default: 70% optimization, 30% test, 5 windows
        const defaultOptWindow = Math.floor(totalBars * 0.14);  // ~14% per window IS
        const defaultTestWindow = Math.floor(totalBars * 0.06); // ~6% per window OOS

        const optimizationWindow = this.readNumberInput('wf-opt-window', defaultOptWindow);
        const testWindow = this.readNumberInput('wf-test-window', defaultTestWindow);
        const stepSize = this.readNumberInput('wf-step-size', testWindow);
        const topN = this.readNumberInput('wf-top-n', 3);
        const minTrades = this.readNumberInput('wf-min-trades', 5);

        return {
            optimizationWindow,
            testWindow,
            stepSize,
            parameterRanges,
            topN,
            minTrades
        };
    }

    private readNumberInput(id: string, fallback: number): number {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return fallback;
        const val = parseFloat(el.value);
        return Number.isFinite(val) ? val : fallback;
    }

    /**
     * Display results in the UI
     */
    private displayResults(result: WalkForwardResult): void {
        // Update summary panel
        this.updateSummaryPanel(result);

        // Update window breakdown table
        this.updateWindowTable(result);

        // Update robustness gauge
        this.updateRobustnessGauge(result.robustnessScore);

        // Plot combined OOS equity curve
        this.plotEquityCurve(result);

        // Log formatted summary to console
        console.log(formatWalkForwardSummary(result));
    }

    private updateSummaryPanel(result: WalkForwardResult): void {
        const panel = document.getElementById('wf-summary-panel');
        if (!panel) return;

        const oos = result.combinedOOSTrades;
        const wfePercent = (result.walkForwardEfficiency * 100).toFixed(1);
        const wfeClass = result.walkForwardEfficiency >= 0.7 ? 'positive' :
            result.walkForwardEfficiency >= 0.4 ? 'neutral' : 'negative';

        panel.innerHTML = `
            <div class="wf-stat">
                <span class="wf-label">Windows</span>
                <span class="wf-value">${result.totalWindows}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">IS Sharpe (avg)</span>
                <span class="wf-value">${result.avgInSampleSharpe.toFixed(3)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">OOS Sharpe (avg)</span>
                <span class="wf-value">${result.avgOutOfSampleSharpe.toFixed(3)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">WF Efficiency</span>
                <span class="wf-value ${wfeClass}">${wfePercent}%</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">OOS Net Profit</span>
                <span class="wf-value ${oos.netProfit >= 0 ? 'positive' : 'negative'}">
                    $${oos.netProfit.toFixed(2)} (${oos.netProfitPercent.toFixed(1)}%)
                </span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">OOS Win Rate</span>
                <span class="wf-value">${oos.winRate.toFixed(1)}%</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">OOS Profit Factor</span>
                <span class="wf-value">${oos.profitFactor.toFixed(2)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">OOS Max DD</span>
                <span class="wf-value negative">${oos.maxDrawdownPercent.toFixed(1)}%</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Param Stability</span>
                <span class="wf-value">${result.parameterStability.toFixed(0)}%</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Time</span>
                <span class="wf-value">${(result.optimizationTimeMs / 1000).toFixed(2)}s</span>
            </div>
        `;
    }

    private updateWindowTable(result: WalkForwardResult): void {
        const tbody = document.getElementById('wf-window-table-body');
        if (!tbody) return;

        tbody.innerHTML = result.windows.map(w => {
            const isProfit = w.outOfSampleResult.netProfit >= 0;
            const statusIcon = isProfit ? '✓' : '✗';
            const statusClass = isProfit ? 'positive' : 'negative';

            // Format optimized params (just show first 2)
            const paramKeys = Object.keys(w.optimizedParams).slice(0, 2);
            const paramsStr = paramKeys.map(k => `${k}:${w.optimizedParams[k]}`).join(', ');

            return `
                <tr class="${statusClass}">
                    <td>${w.windowIndex + 1}</td>
                    <td>${w.inSampleResult.netProfitPercent.toFixed(1)}%</td>
                    <td>${w.outOfSampleResult.netProfitPercent.toFixed(1)}%</td>
                    <td>${w.performanceDegradationPercent.toFixed(0)}%</td>
                    <td>${w.inSampleResult.sharpeRatio.toFixed(2)}</td>
                    <td>${w.outOfSampleResult.sharpeRatio.toFixed(2)}</td>
                    <td title="${JSON.stringify(w.optimizedParams)}">${paramsStr}</td>
                    <td class="${statusClass}">${statusIcon}</td>
                </tr>
            `;
        }).join('');
    }

    private updateRobustnessGauge(score: number): void {
        const gauge = document.getElementById('wf-robustness-gauge');
        const scoreEl = document.getElementById('wf-robustness-score');
        const descEl = document.getElementById('wf-robustness-desc');

        if (scoreEl) scoreEl.textContent = `${score}`;
        if (gauge) {
            gauge.style.setProperty('--score', `${score}`);
            // Color based on score
            if (score >= 80) gauge.className = 'wf-gauge excellent';
            else if (score >= 60) gauge.className = 'wf-gauge good';
            else if (score >= 40) gauge.className = 'wf-gauge moderate';
            else if (score >= 20) gauge.className = 'wf-gauge poor';
            else gauge.className = 'wf-gauge critical';
        }
        if (descEl) {
            if (score >= 80) descEl.textContent = 'Strong robustness. Low overfitting risk.';
            else if (score >= 60) descEl.textContent = 'Reasonably robust. Monitor for degradation.';
            else if (score >= 40) descEl.textContent = 'Some overfitting. Consider parameter constraints.';
            else if (score >= 20) descEl.textContent = 'Significant overfitting. May not perform forward.';
            else descEl.textContent = 'Severe overfitting. Strategy is curve-fitted.';
        }
    }

    private plotEquityCurve(result: WalkForwardResult): void {
        const oos = result.combinedOOSTrades;
        debugLogger.info(`Plotting OOS results: ${oos.trades.length} trades, ${oos.equityCurve.length} equity points`);

        // Clear previous backtest on chart
        chartManager.clearIndicators();

        // Show OOS results
        chartManager.displayTradeMarkers(oos.trades, (p) => p.toFixed(2));
        chartManager.displayEquityCurve(oos.equityCurve);

        // Update results tab as well so user can see detailed OOS stats
        uiManager.updateResultsUI(oos);
    }

    private setLoading(loading: boolean): void {
        const btn = document.getElementById('wf-run-btn') as HTMLButtonElement | null;
        const spinner = document.getElementById('wf-spinner');

        if (btn) {
            btn.disabled = loading;
            btn.textContent = loading ? 'Analyzing...' : 'Run Walk-Forward';
        }
        if (spinner) {
            spinner.style.display = loading ? 'inline-block' : 'none';
        }
    }

    private updateStatus(message: string): void {
        const statusEl = document.getElementById('wf-status');
        if (statusEl) statusEl.textContent = message;
        debugLogger.info(`[WalkForward] ${message}`);
    }

    /**
     * Get last analysis result
     */
    getLastResult(): WalkForwardResult | null {
        return this.lastResult;
    }

    /**
     * Initialize UI event listeners
     */
    initUI(): void {
        const runBtn = document.getElementById('wf-run-btn');
        const quickBtn = document.getElementById('wf-quick-btn');

        if (runBtn) {
            runBtn.addEventListener('click', () => this.runAnalysis());
        }
        if (quickBtn) {
            quickBtn.addEventListener('click', () => this.runQuickAnalysis());
        }

        debugLogger.info('Walk-Forward Service initialized');
    }
}

export const walkForwardService = new WalkForwardService();
