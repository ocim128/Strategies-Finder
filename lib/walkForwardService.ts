import { state } from "./state";
import { chartManager } from "./chartManager";
import { uiManager } from "./uiManager";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./paramManager";
import { debugLogger } from "./debugLogger";
import { backtestService } from "./backtestService";
import { rustEngine } from "./rustEngineClient";
import { shouldUseRustEngine } from "./enginePreferences";
import { runBacktestCompact } from "./strategies/backtest";
import type { Strategy, StrategyParams, BacktestSettings, OHLCVData } from "./strategies/index";
import {
    runWalkForwardAnalysis,
    runFixedParamWalkForward,
    quickWalkForward,
    formatWalkForwardSummary,
    WalkForwardConfig,
    WalkForwardResult,
    ParameterRange,
    FixedParamWalkForwardConfig,
    WalkForwardProgress
} from "./strategies/walk-forward";

// ============================================================================
// Walk-Forward Service
// ============================================================================

class WalkForwardService {
    private lastResult: WalkForwardResult | null = null;

    private estimateWindowCount(totalBars: number, optimizationWindow: number, testWindow: number, stepSize: number): number {
        if (totalBars <= 0 || optimizationWindow <= 0 || testWindow <= 0 || stepSize <= 0) return 0;
        const windowSize = optimizationWindow + testWindow;
        if (windowSize > totalBars) return 0;
        return Math.floor((totalBars - windowSize) / stepSize) + 1;
    }

    private setNumberInput(id: string, value: number): void {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return;
        el.value = String(Math.max(1, Math.round(value)));
    }

    private estimateTradeFrequency(
        data: OHLCVData[],
        strategy: Strategy,
        params: StrategyParams,
        capitalSettings: ReturnType<typeof backtestService.getCapitalSettings>,
        backtestSettings: BacktestSettings
    ): { totalTrades: number; tradesPerBar: number } | null {
        try {
            const signals = strategy.execute(data, params);
            const result = runBacktestCompact(
                data,
                signals,
                capitalSettings.initialCapital,
                capitalSettings.positionSize,
                capitalSettings.commission,
                backtestSettings,
                { mode: capitalSettings.sizingMode, fixedTradeAmount: capitalSettings.fixedTradeAmount }
            );
            const totalTrades = Math.max(0, result.totalTrades);
            return {
                totalTrades,
                tradesPerBar: totalTrades / Math.max(1, data.length)
            };
        } catch (error) {
            debugLogger.warn(`[WalkForward] Trade frequency estimation failed: ${error}`);
            return null;
        }
    }

    private suggestWindowsFromTradeFrequency(
        totalBars: number,
        totalTrades: number,
        tradesPerBar: number
    ): {
        optimizationWindow: number;
        testWindow: number;
        stepSize: number;
        estimatedWindows: number;
        expectedOOSTradesPerWindow: number;
        minTrades: number;
        minOOSTradesPerWindow: number;
        minTotalOOSTrades: number;
    } {
        const minWindows = 8;
        const maxWindows = 60;
        const minTestByWindows = Math.max(20, Math.floor(totalBars / maxWindows));
        const maxTestByWindows = Math.max(minTestByWindows, Math.floor(totalBars / minWindows));
        const desiredOOSTradesPerWindow = 8;

        let testWindow = tradesPerBar > 0
            ? Math.ceil(desiredOOSTradesPerWindow / tradesPerBar)
            : maxTestByWindows;
        testWindow = Math.max(minTestByWindows, Math.min(maxTestByWindows, testWindow));

        let optimizationWindow = Math.max(testWindow * 2, Math.floor(testWindow * 3));
        optimizationWindow = Math.min(totalBars - testWindow, optimizationWindow);
        if (optimizationWindow < testWindow) {
            optimizationWindow = testWindow;
        }

        let stepSize = testWindow;
        let estimatedWindows = this.estimateWindowCount(totalBars, optimizationWindow, testWindow, stepSize);

        if (estimatedWindows > maxWindows) {
            const scale = Math.ceil(estimatedWindows / maxWindows);
            testWindow = Math.min(maxTestByWindows, testWindow * scale);
            stepSize = testWindow;
            optimizationWindow = Math.min(totalBars - testWindow, Math.max(testWindow * 2, optimizationWindow * scale));
            estimatedWindows = this.estimateWindowCount(totalBars, optimizationWindow, testWindow, stepSize);
        }

        if (estimatedWindows < 3 && totalBars >= 3) {
            testWindow = Math.max(minTestByWindows, Math.floor(totalBars / 5));
            stepSize = testWindow;
            optimizationWindow = Math.min(totalBars - testWindow, Math.max(testWindow * 2, Math.floor(totalBars / 2)));
            estimatedWindows = this.estimateWindowCount(totalBars, optimizationWindow, testWindow, stepSize);
        }

        const expectedOOSTradesPerWindow = tradesPerBar * testWindow;
        const minOOSTradesPerWindow = Math.max(1, Math.floor(expectedOOSTradesPerWindow * 0.5));
        const minTotalOOSTrades = Math.max(20, Math.min(totalTrades, Math.floor(minOOSTradesPerWindow * Math.max(5, estimatedWindows * 0.5))));

        return {
            optimizationWindow,
            testWindow,
            stepSize,
            estimatedWindows,
            expectedOOSTradesPerWindow,
            minTrades: Math.max(1, minOOSTradesPerWindow),
            minOOSTradesPerWindow,
            minTotalOOSTrades
        };
    }

    private autoSuggestWindowSettings(
        data: OHLCVData[],
        strategy: Strategy,
        params: StrategyParams,
        capitalSettings: ReturnType<typeof backtestService.getCapitalSettings>,
        backtestSettings: BacktestSettings
    ): {
        minOOSTradesPerWindow: number;
        minTotalOOSTrades: number;
    } | null {
        const tradeStats = this.estimateTradeFrequency(data, strategy, params, capitalSettings, backtestSettings);
        if (!tradeStats) return null;

        const currentOptWindow = this.readNumberInput('wf-opt-window', Math.max(50, Math.floor(data.length * 0.2)));
        const currentTestWindow = this.readNumberInput('wf-test-window', Math.max(20, Math.floor(data.length * 0.1)));
        const currentStep = this.readNumberInput('wf-step-size', currentTestWindow);

        const currentWindows = this.estimateWindowCount(data.length, currentOptWindow, currentTestWindow, currentStep);
        const currentExpectedOOSTrades = tradeStats.tradesPerBar * currentTestWindow;

        const suggestion = this.suggestWindowsFromTradeFrequency(data.length, tradeStats.totalTrades, tradeStats.tradesPerBar);
        const shouldAdjust = currentWindows > 120 || currentExpectedOOSTrades < 2 || currentWindows < 3;

        const autoApply = this.isToggleEnabled('wf-auto-suggest', false);
        if (shouldAdjust && autoApply) {
            this.setNumberInput('wf-opt-window', suggestion.optimizationWindow);
            this.setNumberInput('wf-test-window', suggestion.testWindow);
            this.setNumberInput('wf-step-size', suggestion.stepSize);
            this.setNumberInput('wf-min-trades', suggestion.minTrades);

            this.updateStatus(
                `Auto window suggestion applied: ${suggestion.estimatedWindows} windows, ~${suggestion.expectedOOSTradesPerWindow.toFixed(1)} OOS trades/window`
            );
            debugLogger.info(
                `[WalkForward] Auto-suggested windows | trades=${tradeStats.totalTrades} | opt=${suggestion.optimizationWindow} | test=${suggestion.testWindow} | step=${suggestion.stepSize} | windows=${suggestion.estimatedWindows}`
            );
        } else if (shouldAdjust && !autoApply) {
            debugLogger.info(
                `[WalkForward] Auto-suggest available (disabled) | trades=${tradeStats.totalTrades} | suggested opt=${suggestion.optimizationWindow} | test=${suggestion.testWindow} | step=${suggestion.stepSize} | windows=${suggestion.estimatedWindows}`
            );
        }

        return {
            minOOSTradesPerWindow: suggestion.minOOSTradesPerWindow,
            minTotalOOSTrades: suggestion.minTotalOOSTrades
        };
    }

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

        // Get capital settings from backtest service
        const capitalSettings = backtestService.getCapitalSettings();
        const backtestSettings = backtestService.getBacktestSettings();
        const sizing = { mode: capitalSettings.sizingMode, fixedTradeAmount: capitalSettings.fixedTradeAmount };

        this.setLoading(true);

        try {
            const startTime = performance.now();

            // Check Rust engine availability for future optimization
            // Currently using TypeScript for full walk-forward since strategies are in TS
            if (shouldUseRustEngine() && await rustEngine.checkHealth()) {
                debugLogger.info('[WalkForward] Rust engine available - will use for inner backtests');
            }

            // Get current parameters
            const currentParams = paramManager.getValues(strategy);
            const tradeAwareThresholds = this.autoSuggestWindowSettings(
                data,
                strategy,
                currentParams,
                capitalSettings,
                backtestSettings
            );

            // Build parameter ranges from strategy defaults
            const parameterRanges = this.buildParameterRanges(
                strategy.defaultParams,
                currentParams,
                strategy.metadata?.walkForwardParams
            );

            // Determine if we should use fixed-param walk-forward:
            // - No parameters at all, OR  
            // - No valid parameter ranges could be built
            const useFixedParam =
                Object.keys(strategy.defaultParams).length === 0 ||
                parameterRanges.length === 0;

            let result: WalkForwardResult;
            const progressReporter = this.createProgressReporter();

            if (useFixedParam) {
                // Use fixed-parameter walk-forward (no optimization)
                this.updateStatus('Running walk-forward analysis (fixed parameters)...');
                debugLogger.info(`[WalkForward] Using fixed-param mode for: ${strategyKey}`);

                // Get window config from UI
                const testWindow = this.readNumberInput('wf-test-window', Math.floor(data.length * 0.2));
                const stepSize = this.readNumberInput('wf-step-size', testWindow);
                const minTrades = this.readNumberInput('wf-min-trades', tradeAwareThresholds?.minOOSTradesPerWindow ?? 3);

                const fixedConfig: FixedParamWalkForwardConfig = {
                    testWindow,
                    stepSize,
                    minTrades,
                    onProgress: progressReporter
                };

                result = await runFixedParamWalkForward(
                    data,
                    { ...strategy, defaultParams: currentParams },
                    fixedConfig,
                    capitalSettings.initialCapital,
                    capitalSettings.positionSize,
                    capitalSettings.commission,
                    backtestSettings,
                    sizing
                );
            } else {
                // Use regular walk-forward with parameter optimization
                this.updateStatus('Running walk-forward analysis (optimizing parameters)...');
                debugLogger.info(`[WalkForward] Optimizing ${parameterRanges.length} parameters for: ${strategyKey}`);

                // Get config from UI
                const config: WalkForwardConfig = {
                    ...this.getConfigFromUI(parameterRanges, tradeAwareThresholds),
                    onProgress: progressReporter
                };

                result = await runWalkForwardAnalysis(
                    data,
                    { ...strategy, defaultParams: currentParams },
                    config,
                    capitalSettings.initialCapital,
                    capitalSettings.positionSize,
                    capitalSettings.commission,
                    backtestSettings,
                    sizing
                );
            }

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
        const backtestSettings = backtestService.getBacktestSettings();
        const sizing = { mode: capitalSettings.sizingMode, fixedTradeAmount: capitalSettings.fixedTradeAmount };

        this.setLoading(true);

        try {
            // Check if has no tunable parameters
            const currentParams = paramManager.getValues(strategy);
            const parameterRanges = this.buildParameterRanges(
                strategy.defaultParams,
                currentParams,
                strategy.metadata?.walkForwardParams
            );
            const useFixedParam =
                Object.keys(strategy.defaultParams).length === 0 ||
                parameterRanges.length === 0;

            let result: WalkForwardResult;
            const progressReporter = this.createProgressReporter();

            if (useFixedParam) {
                // Use fixed-param walk-forward for strategies without tunable parameters
                this.updateStatus('Running quick analysis (fixed-param)...');
                debugLogger.info(`[WalkForward] Quick analysis using fixed-param mode for: ${strategyKey}`);

                // Auto-detect window settings: aim for ~5 windows
                const totalBars = data.length;
                const targetWindows = 5;
                const testWindow = Math.max(20, Math.floor(totalBars / targetWindows));
                const stepSize = testWindow; // Non-overlapping

                const fixedConfig: FixedParamWalkForwardConfig = {
                    testWindow,
                    stepSize,
                    minTrades: 1,
                    onProgress: progressReporter
                };

                result = await runFixedParamWalkForward(
                    data,
                    { ...strategy, defaultParams: currentParams },
                    fixedConfig,
                    capitalSettings.initialCapital,
                    capitalSettings.positionSize,
                    capitalSettings.commission,
                    backtestSettings,
                    sizing
                );
            } else {
                // Use regular quick walk-forward with parameter optimization
                this.updateStatus('Running quick walk-forward analysis...');

                result = await quickWalkForward(
                    data,
                    { ...strategy, defaultParams: currentParams },
                    capitalSettings.initialCapital,
                    capitalSettings.positionSize,
                    capitalSettings.commission,
                    sizing,
                    progressReporter
                );
            }

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
    private buildParameterRanges(
        defaults: Record<string, number>,
        current: Record<string, number>,
        allowedParams?: string[]
    ): ParameterRange[] {
        const ranges: ParameterRange[] = [];
        const allowSet = allowedParams ? new Set(allowedParams) : null;

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
            if (allowSet && !allowSet.has(name)) {
                continue;
            }
            if (customRanges.has(name)) {
                const custom = customRanges.get(name)!;
                if (custom.min < custom.max && Number.isFinite(custom.step) && custom.step > 0) {
                    ranges.push({ name, ...custom });
                    continue;
                }
            }

            // Toggle params (use*) get [0, 1] range for walk-forward testing
            const isToggle = /^use[A-Z]/.test(name) && (value === 0 || value === 1);
            if (isToggle) {
                ranges.push({ name, min: 0, max: 1, step: 1 });
                continue;
            }

            const baseValue = value || defaults[name] || 10;

            // Handle decimal parameters (like Fib levels 0.618, 0.382) differently
            const isSmallDecimal = !Number.isInteger(baseValue) && Math.abs(baseValue) < 2;

            let min: number;
            let max: number;
            let step: number;

            if (isSmallDecimal) {
                // For small decimal params, use proportional range with decimal precision
                min = Math.max(0.1, baseValue * 0.5);
                max = Math.max(min + 0.1, baseValue * 1.5);
                // Ensure at least 2-3 steps
                const rawStep = (max - min) / 3;
                step = Math.max(0.05, rawStep);
            } else {
                // For integer-like params
                min = Math.max(1, Math.floor(baseValue * 0.5));
                max = Math.max(min + 1, Math.ceil(baseValue * 1.5));
                const rawStep = (max - min) / 4;
                step = Math.max(1, Math.floor(rawStep));
            }

            // Only add range if it's valid (min < max)
            if (min < max) {
                ranges.push({ name, min, max, step });
            }
        }

        return ranges;
    }


    /**
     * Get walk-forward config from UI inputs
     */
    private getConfigFromUI(
        parameterRanges: ParameterRange[],
        tradeAwareThresholds?: { minOOSTradesPerWindow: number; minTotalOOSTrades: number } | null
    ): WalkForwardConfig {
        const data = state.ohlcvData || [];
        const totalBars = data.length;

        // Default: 70% optimization, 30% test, 5 windows
        const defaultOptWindow = Math.floor(totalBars * 0.14);  // ~14% per window IS
        const defaultTestWindow = Math.floor(totalBars * 0.06); // ~6% per window OOS

        const optimizationWindow = Math.max(1, this.readNumberInput('wf-opt-window', defaultOptWindow));
        const testWindow = Math.max(1, this.readNumberInput('wf-test-window', defaultTestWindow));
        const stepSize = Math.max(1, this.readNumberInput('wf-step-size', testWindow));
        const topN = Math.max(1, this.readNumberInput('wf-top-n', 3));
        const minTradesFallback = tradeAwareThresholds?.minOOSTradesPerWindow ?? 5;
        const minTrades = Math.max(0, this.readNumberInput('wf-min-trades', minTradesFallback));

        return {
            optimizationWindow,
            testWindow,
            stepSize,
            parameterRanges,
            topN,
            minTrades,
            minOOSTradesPerWindow: tradeAwareThresholds?.minOOSTradesPerWindow ?? 1,
            minTotalOOSTrades: tradeAwareThresholds?.minTotalOOSTrades ?? 50
        };
    }

    private readNumberInput(id: string, fallback: number): number {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return fallback;
        const val = parseFloat(el.value);
        return Number.isFinite(val) ? val : fallback;
    }

    private isToggleEnabled(id: string, fallback: boolean): boolean {
        const toggle = document.getElementById(id) as HTMLInputElement | null;
        return toggle ? toggle.checked : fallback;
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

    private createProgressReporter(): (progress: WalkForwardProgress) => void {
        let lastUpdate = 0;
        const minIntervalMs = 350;

        return (progress: WalkForwardProgress) => {
            const now = performance.now();
            if (progress.phase === 'optimize' && now - lastUpdate < minIntervalMs) return;
            lastUpdate = now;

            const windowLabel = `${progress.windowIndex + 1}/${progress.totalWindows}`;
            if (progress.phase === 'optimize') {
                const comboLabel = progress.comboTotal
                    ? ` (${progress.comboIndex}/${progress.comboTotal})`
                    : '';
                this.updateStatus(`Optimizing window ${windowLabel}${comboLabel}...`);
                return;
            }
            if (progress.phase === 'test') {
                this.updateStatus(`Running OOS for window ${windowLabel}...`);
                return;
            }
            if (progress.phase === 'window') {
                this.updateStatus(`Completed window ${windowLabel}.`);
                return;
            }
            if (progress.phase === 'complete') {
                this.updateStatus('Finalizing results...');
            }
        };
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
