import { state } from "./state";
import { dataManager } from "./data-manager";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { backtestService } from "./backtest-service";
import { rustEngine } from "./rust-engine-client";
import { shouldUseRustEngine } from "./engine-preferences";
import { sanitizeBacktestSettingsForRust } from "./rust-settings-sanitizer";
import { applySignalPolarity, runBacktestCompact } from "./strategies/backtest";
import { parseInputNumber } from "./dom-input-readers";
import type { Strategy, StrategyParams, BacktestSettings, OHLCVData, BacktestResult } from "./strategies/index";
import { sliceOhlcvByBlock } from "./block-selector";
import {
    resolveWalkForwardAutoSuggestedThresholds,
    suggestWalkForwardWindowsFromTradeFrequency,
} from "./walk-forward-auto-suggest";
import {
    formatWalkForwardBaseParamsSummary,
    formatWalkForwardSignedPercent,
    formatWalkForwardWindowParams,
} from "./walk-forward-formatters";
import {
    deriveAutoWalkForwardRange,
    resolveFiniteRangeReferenceValue,
    shouldTreatParamAsWholeNumber
} from "./walk-forward-range-utils";
import { snapValueToStepRange } from "./param-math-utils";
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
import { withWalkForwardDecayMonitoring } from "./strategies/walk-forward-decay";
import {
    createWalkForwardServiceDom,
    type WalkForwardServiceDom
} from "./walk-forward-dom";
import {
    renderWalkForwardDecayPanel,
    setWalkForwardLoading,
    updateWalkForwardRobustnessGauge,
    updateWalkForwardSummaryPanel,
    updateWalkForwardWindowTable,
} from "./walk-forward-ui";
import { commitBacktestResult } from "./state-actions";

type WalkForwardRunMode = "analysis" | "quick";

type WalkForwardRunContext = {
    signal: AbortSignal;
    data: OHLCVData[];
    strategyKey: string;
    strategy: Strategy;
};

type WalkForwardNumberInputId =
    | "wf-opt-window"
    | "wf-test-window"
    | "wf-step-size"
    | "wf-min-trades"
    | "wf-top-n";

type PreviousBacktestSnapshot = {
    result: BacktestResult | null;
    source: string | null;
};

// ============================================================================
// Walk-Forward Service
// ============================================================================

class WalkForwardService {
    private lastResult: WalkForwardResult | null = null;
    private isRunning = false;
    private abortController: AbortController | null = null;
    private previousBacktestSnapshot: PreviousBacktestSnapshot | null = null;
    private lastRunBaseParams: { strategyKey: string; params: StrategyParams } | null = null;
    private dom: WalkForwardServiceDom | null = null;
    private numberInputs: Record<WalkForwardNumberInputId, HTMLInputElement> | null = null;
    private readonly uiHost = {
        formatSignedPercent: formatWalkForwardSignedPercent,
        formatNumber: (value: number | null, digits?: number) => this.formatNumber(value, digits),
        formatPercent: (value: number | null, digits?: number) => this.formatPercent(value, digits),
        formatBaseParamsSummary: () => formatWalkForwardBaseParamsSummary(this.lastRunBaseParams),
        formatWindowParams: formatWalkForwardWindowParams,
    };

    private getDom(): WalkForwardServiceDom {
        return this.dom ??= createWalkForwardServiceDom();
    }

    private getNumberInputs(): Record<WalkForwardNumberInputId, HTMLInputElement> {
        if (this.numberInputs) {
            return this.numberInputs;
        }

        const dom = this.getDom();
        this.numberInputs = {
            "wf-opt-window": dom.wfOptWindow,
            "wf-test-window": dom.wfTestWindow,
            "wf-step-size": dom.wfStepSize,
            "wf-min-trades": dom.wfMinTrades,
            "wf-top-n": dom.wfTopN,
        };
        return this.numberInputs;
    }

    private async withRunGuard<T>(
        mode: WalkForwardRunMode,
        noDataMessage: string,
        fn: (ctx: WalkForwardRunContext) => Promise<T | null>
    ): Promise<T | null> {
        if (this.isRunning) {
            this.updateStatus("Analysis already running.");
            return null;
        }

        this.isRunning = true;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            const data = await this.ensureDataReadyForCurrentContext();
            if (!data || data.length === 0) {
                debugLogger.error(noDataMessage);
                return null;
            }

            const strategyKey = state.currentStrategyKey;
            const strategy = strategyRegistry.get(strategyKey);
            if (!strategy) {
                debugLogger.error(`Strategy not found: ${strategyKey}`);
                return null;
            }

            return await fn({ signal, data, strategyKey, strategy });
        } finally {
            this.isRunning = false;
            this.abortController = null;
            this.setLoading(false, mode);
        }
    }

    private normalizeStrategyParams(strategy: Strategy, params: StrategyParams): StrategyParams {
        const nextParams = { ...params };
        return strategy.normalizeParams ? strategy.normalizeParams(nextParams) : nextParams;
    }

    private captureLastRunBaseParams(strategy: Strategy, params: StrategyParams): void {
        const allowedParams = strategy.metadata?.walkForwardParams;
        const source = allowedParams && allowedParams.length > 0
            ? allowedParams
            : Object.keys(params);

        const filtered: StrategyParams = {};
        for (const key of source) {
            if (params[key] !== undefined) {
                filtered[key] = params[key];
            }
        }

        this.lastRunBaseParams = {
            strategyKey: state.currentStrategyKey,
            params: filtered
        };
    }

    private snapValueToRange(range: ParameterRange, value: number): number {
        if (!Number.isFinite(value)) return range.min;
        if (!Number.isFinite(range.step) || range.step <= 0 || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
            return value;
        }

        const span = range.max - range.min;
        if (span <= 0) return range.min;

        return snapValueToStepRange(range, value);
    }

    private snapParamsToRanges(params: StrategyParams, ranges: ParameterRange[]): StrategyParams {
        if (ranges.length === 0) return { ...params };

        const snapped: StrategyParams = { ...params };
        for (const range of ranges) {
            const currentValue = params[range.name];
            if (!Number.isFinite(currentValue)) continue;
            snapped[range.name] = this.snapValueToRange(range, Number(currentValue));
        }

        return snapped;
    }

    private async ensureDataReadyForCurrentContext(): Promise<OHLCVData[]> {
        const contextKey = `${state.currentSymbol}|${state.currentInterval}|${state.binanceMarketType}`;
        const loadedContextKey = dataManager.getLoadedContextKey();
        const canReuseCurrentData = state.ohlcvData.length > 0 && loadedContextKey === contextKey;

        if (canReuseCurrentData) {
            return sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
        }

        this.updateStatus('Syncing data for selected symbol/interval...');
        await dataManager.loadData(state.currentSymbol, state.currentInterval);
        return sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
    }

    private setNumberInput(id: string, value: number): void {
        const el = this.getNumberInputs()[id as WalkForwardNumberInputId];
        if (!el) return;
        el.value = String(Math.max(1, Math.round(value)));
    }

    private applyWindowSuggestion(
        suggestion: {
            optimizationWindow: number;
            testWindow: number;
            stepSize: number;
            estimatedWindows: number;
            expectedOOSTradesPerWindow: number;
            minTrades: number;
        },
        statusPrefix: string
    ): boolean {
        const nextOptWindow = Math.max(1, Math.round(suggestion.optimizationWindow));
        const nextTestWindow = Math.max(1, Math.round(suggestion.testWindow));
        const nextStepSize = Math.max(1, Math.round(suggestion.stepSize));
        const nextMinTrades = Math.max(1, Math.round(suggestion.minTrades));

        const currentOptWindow = this.readNumberInput('wf-opt-window', nextOptWindow);
        const currentTestWindow = this.readNumberInput('wf-test-window', nextTestWindow);
        const currentStepSize = this.readNumberInput('wf-step-size', nextStepSize);
        const currentMinTrades = this.readNumberInput('wf-min-trades', nextMinTrades);

        const changed =
            currentOptWindow !== nextOptWindow ||
            currentTestWindow !== nextTestWindow ||
            currentStepSize !== nextStepSize ||
            currentMinTrades !== nextMinTrades;

        if (!changed) {
            return false;
        }

        this.setNumberInput('wf-opt-window', nextOptWindow);
        this.setNumberInput('wf-test-window', nextTestWindow);
        this.setNumberInput('wf-step-size', nextStepSize);
        this.setNumberInput('wf-min-trades', nextMinTrades);

        this.updateStatus(
            `${statusPrefix}: ${suggestion.estimatedWindows} windows, ~${suggestion.expectedOOSTradesPerWindow.toFixed(1)} OOS trades/window`
        );
        return true;
    }

    private normalizeRangeForParam(
        name: string,
        min: number,
        max: number,
        step: number,
        referenceValue: number
    ): ParameterRange {
        if (shouldTreatParamAsWholeNumber(name, referenceValue)) {
            const normalizedMin = Math.max(1, Math.round(min));
            const normalizedMax = Math.max(normalizedMin + 1, Math.round(max));
            const normalizedStep = Math.max(1, Math.round(step));
            return { name, min: normalizedMin, max: normalizedMax, step: normalizedStep };
        }

        return {
            name,
            min: Math.round(min * 1000) / 1000,
            max: Math.round(max * 1000) / 1000,
            step: Math.round(step * 1000) / 1000
        };
    }

    private refreshAutoSuggestionFromCurrentResult(): void {
        if (!this.isToggleEnabled('wf-auto-suggest', false)) {
            return;
        }
        if (!state.currentBacktestResult) {
            return;
        }
        // Ignore walk-forward OOS snapshots to prevent self-feedback updates.
        if (state.currentBacktestResultSource === 'walk_forward_oos') {
            return;
        }

        const data = sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
        if (data.length === 0) {
            return;
        }

        const totalTrades = Math.max(0, state.currentBacktestResult.totalTrades);
        const tradesPerBar = totalTrades / Math.max(1, data.length);
        const suggestion = suggestWalkForwardWindowsFromTradeFrequency(data.length, totalTrades, tradesPerBar);
        const applied = this.applyWindowSuggestion(suggestion, 'Auto window suggestion updated');
        if (!applied) {
            return;
        }

        debugLogger.info(
            `[WalkForward] Auto-suggest refreshed from backtest result | source=${state.currentBacktestResultSource} | trades=${totalTrades} | opt=${suggestion.optimizationWindow} | test=${suggestion.testWindow} | step=${suggestion.stepSize} | windows=${suggestion.estimatedWindows}`
        );
    }

    private estimateTradeFrequency(
        data: OHLCVData[],
        strategy: Strategy,
        params: StrategyParams,
        capitalSettings: ReturnType<typeof backtestService.getCapitalSettings>,
        backtestSettings: BacktestSettings
    ): { totalTrades: number; tradesPerBar: number } | null {
        try {
            const signals = applySignalPolarity(strategy.execute(data, params), backtestSettings);
            const result = runBacktestCompact(
                data,
                signals,
                capitalSettings.initialCapital,
                capitalSettings.positionSize,
                capitalSettings.commission,
                backtestSettings,
                {
                    mode: capitalSettings.sizingMode,
                    fixedTradeAmount: capitalSettings.fixedTradeAmount,
                    advancedSizing: capitalSettings.advancedSizing,
                }
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

        const autoApply = this.isToggleEnabled('wf-auto-suggest', false);
        return resolveWalkForwardAutoSuggestedThresholds({
            totalBars: data.length,
            totalTrades: tradeStats.totalTrades,
            tradesPerBar: tradeStats.tradesPerBar,
            currentOptimizationWindow: currentOptWindow,
            currentTestWindow,
            currentStepSize: currentStep,
            autoApply,
            applySuggestion: (suggestion, statusPrefix) => this.applyWindowSuggestion(suggestion, statusPrefix),
            onAutoApplied: (suggestion) => {
                debugLogger.info(
                    `[WalkForward] Auto-suggested windows | trades=${tradeStats.totalTrades} | opt=${suggestion.optimizationWindow} | test=${suggestion.testWindow} | step=${suggestion.stepSize} | windows=${suggestion.estimatedWindows}`
                );
            },
            onSuggestionAvailable: (suggestion) => {
                debugLogger.info(
                    `[WalkForward] Auto-suggest available (disabled) | trades=${tradeStats.totalTrades} | suggested opt=${suggestion.optimizationWindow} | test=${suggestion.testWindow} | step=${suggestion.stepSize} | windows=${suggestion.estimatedWindows}`
                );
            },
        });
    }

    /**
     * Run walk-forward analysis with current strategy and data
     */
    async runAnalysis(): Promise<WalkForwardResult | null> {
        return this.withRunGuard("analysis", "No data loaded for walk-forward analysis", async ({ signal, data, strategyKey, strategy }) => {
            const capitalSettings = backtestService.getCapitalSettings();
            const backtestSettings = backtestService.getBacktestSettings();
            const sizing = {
                mode: capitalSettings.sizingMode,
                fixedTradeAmount: capitalSettings.fixedTradeAmount,
                advancedSizing: capitalSettings.advancedSizing,
            };

            this.setLoading(true);

            try {
                const startTime = performance.now();

            // Get current parameters
            const currentParams = this.normalizeStrategyParams(strategy, paramManager.getValues(strategy));
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
            this.captureLastRunBaseParams(strategy, this.snapParamsToRanges(currentParams, parameterRanges));

            // Determine if we should use fixed-param walk-forward:
            // - No parameters at all, OR  
            // - No valid parameter ranges could be built
            const useFixedParam =
                Object.keys(strategy.defaultParams).length === 0 ||
                parameterRanges.length === 0;

            let result: WalkForwardResult | null = null;
            const progressReporter = this.createProgressReporter();
            const baseConfig = this.getConfigFromUI(parameterRanges, tradeAwareThresholds);

            // Try Rust walk-forward first when compatible, then fallback to TypeScript.
            if (!useFixedParam && shouldUseRustEngine()) {
                const requiresTsEngine = backtestService.requiresTypescriptEngine(backtestSettings) || isSmartTradeSizingMode(capitalSettings.sizingMode);
                if (!requiresTsEngine && await rustEngine.checkHealth()) {
                    const rustConfig = this.toRustWalkForwardConfig(baseConfig);
                    const rustSettings = this.toRustBacktestSettings(backtestSettings);
                    this.updateStatus('Running walk-forward analysis on Rust backend...');
                    const rustResult = await rustEngine.runWalkForward(
                        data,
                        strategyKey,
                        currentParams,
                        capitalSettings.initialCapital,
                        capitalSettings.positionSize,
                        capitalSettings.commission,
                        rustSettings,
                        rustConfig,
                        (update) => {
                            const percent = Number.isFinite(update.percent) ? `${Math.round(update.percent)}%` : '';
                            const status = update.status?.trim() || 'Optimizing';
                            this.updateStatus(percent ? `[Rust ${percent}] ${status}` : `[Rust] ${status}`, false);
                        }
                    );
                    if (this.isWalkForwardResult(rustResult)) {
                        result = rustResult;
                        debugLogger.info('[WalkForward] Rust backend result accepted');
                    } else {
                        debugLogger.warn('[WalkForward] Rust walk-forward unavailable or incompatible result; falling back to TypeScript.');
                    }
                } else if (requiresTsEngine) {
                    debugLogger.info('[WalkForward] Realism or snapshot filter settings require TypeScript engine.');
                }
            }

            if (!result && useFixedParam) {
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
                    fixedParams: currentParams,
                    minTrades,
                    onProgress: progressReporter,
                    signal
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
            } else if (!result) {
                // Use regular walk-forward with parameter optimization
                this.updateStatus('Running walk-forward analysis (optimizing parameters)...');
                debugLogger.info(`[WalkForward] Optimizing ${parameterRanges.length} parameters for: ${strategyKey}`);

                // Get config from UI
                const config: WalkForwardConfig = {
                    ...baseConfig,
                    onProgress: progressReporter,
                    signal
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

            if (!result) {
                throw new Error('Walk-forward did not produce a result.');
            }
            result = withWalkForwardDecayMonitoring(result, useFixedParam ? [] : parameterRanges);

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
            }
        });
    }



    /**
     * Quick analysis with auto-detected settings
     */
    async runQuickAnalysis(): Promise<WalkForwardResult | null> {
        return this.withRunGuard("quick", "No data loaded for walk-forward analysis", async ({ signal, data, strategyKey, strategy }) => {
            const capitalSettings = backtestService.getCapitalSettings();
            const backtestSettings = backtestService.getBacktestSettings();
            const sizing = {
                mode: capitalSettings.sizingMode,
                fixedTradeAmount: capitalSettings.fixedTradeAmount,
                advancedSizing: capitalSettings.advancedSizing,
            };

            this.setLoading(true, "quick");

            try {
                const currentParams = this.normalizeStrategyParams(strategy, paramManager.getValues(strategy));
            const parameterRanges = this.buildParameterRanges(
                strategy.defaultParams,
                currentParams,
                strategy.metadata?.walkForwardParams
            );
            this.captureLastRunBaseParams(strategy, this.snapParamsToRanges(currentParams, parameterRanges));
            const useFixedParam =
                Object.keys(strategy.defaultParams).length === 0 ||
                parameterRanges.length === 0;

            let result: WalkForwardResult | null = null;
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
                    fixedParams: currentParams,
                    minTrades: 1,
                    onProgress: progressReporter,
                    signal
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
                    backtestSettings,
                    sizing,
                    progressReporter,
                    signal
                );
            }

            if (!result) {
                throw new Error('Walk-forward did not produce a result.');
            }
            result = withWalkForwardDecayMonitoring(result, useFixedParam ? [] : parameterRanges);

            this.lastResult = result;
            this.displayResults(result);
            this.updateStatus(`Quick analysis: Robustness ${result.robustnessScore}/100`);

                return result;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                debugLogger.error(`Quick walk-forward failed: ${msg}`);
                this.updateStatus(`Error: ${msg}`);
                return null;
            }
        });
    }

    private formatNumber(value: number | null, digits: number = 2): string {
        if (value === Infinity) return "Inf";
        if (!Number.isFinite(value)) return "-";
        return Number(value).toFixed(digits);
    }

    private formatPercent(value: number | null, digits: number = 2): string {
        if (!Number.isFinite(value)) return "-";
        return `${Number(value).toFixed(digits)}%`;
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
                if (rangeType === 'min') range.min = parseInputNumber(el.value) ?? 0;
                if (rangeType === 'max') range.max = parseInputNumber(el.value) ?? 0;
                if (rangeType === 'step') range.step = parseInputNumber(el.value) ?? 1;
            }
        });

        for (const [name, value] of Object.entries(current)) {
            if (allowSet && !allowSet.has(name)) {
                continue;
            }
            if (customRanges.has(name)) {
                const custom = customRanges.get(name)!;
                if (custom.min < custom.max && Number.isFinite(custom.step) && custom.step > 0) {
                    const referenceValue = resolveFiniteRangeReferenceValue(value, defaults[name], 10);
                    ranges.push(this.normalizeRangeForParam(name, custom.min, custom.max, custom.step, referenceValue));
                    continue;
                }
            }

            // Toggle params (use*) get [0, 1] range for walk-forward testing
            const isToggle = /^use[A-Z]/.test(name) && (value === 0 || value === 1);
            if (isToggle) {
                ranges.push({ name, min: 0, max: 1, step: 1 });
                continue;
            }

            const baseValue = resolveFiniteRangeReferenceValue(value, defaults[name], 10);
            const { min, max, step } = deriveAutoWalkForwardRange(name, baseValue);

            // Only add range if it's valid (min < max)
            if (min < max) {
                ranges.push(this.normalizeRangeForParam(name, min, max, step, baseValue));
            }
        }

        return ranges;
    }


    private toRustBacktestSettings(settings: BacktestSettings): BacktestSettings {
        // Sanitize settings for Rust - do not re-add removed fields
        // to maintain sanitizer contract consistency.
        return sanitizeBacktestSettingsForRust(settings);
    }

    private toRustWalkForwardConfig(config: WalkForwardConfig): {
        optimizationWindow: number;
        testWindow: number;
        stepSize: number;
        parameterRanges: Array<{ name: string; min: number; max: number; step: number }>;
        topN?: number;
        minTrades?: number;
    } {
        return {
            optimizationWindow: config.optimizationWindow,
            testWindow: config.testWindow,
            stepSize: config.stepSize,
            parameterRanges: config.parameterRanges.map(range => ({
                name: range.name,
                min: range.min,
                max: range.max,
                step: range.step
            })),
            topN: config.topN,
            minTrades: config.minTrades
        };
    }

    private isWalkForwardResult(value: unknown): value is WalkForwardResult {
        if (!value || typeof value !== 'object') return false;
        const result = value as Partial<WalkForwardResult>;
        return (
            typeof result.totalWindows === 'number' &&
            typeof result.robustnessScore === 'number' &&
            typeof result.walkForwardEfficiency === 'number' &&
            typeof result.parameterStability === 'number' &&
            typeof result.optimizationTimeMs === 'number' &&
            Array.isArray(result.windows) &&
            typeof result.combinedOOSTrades === 'object' &&
            result.combinedOOSTrades !== null
        );
    }

    /**
     * Get walk-forward config from UI inputs
     */
    private getConfigFromUI(
        parameterRanges: ParameterRange[],
        tradeAwareThresholds?: { minOOSTradesPerWindow: number; minTotalOOSTrades: number } | null
    ): WalkForwardConfig {
        const data = sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
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
        const el = this.getNumberInputs()[id as WalkForwardNumberInputId];
        if (!el) return fallback;
        const val = parseInputNumber(el.value);
        return val ?? fallback;
    }

    private isToggleEnabled(id: string, fallback: boolean): boolean {
        const { wfAutoSuggest } = this.getDom();
        const toggleMap: Record<string, HTMLInputElement> = {
            "wf-auto-suggest": wfAutoSuggest,
        };
        const toggle = toggleMap[id];
        return toggle ? toggle.checked : fallback;
    }

    /**
     * Display results in the UI
     */
    private displayResults(result: WalkForwardResult): void {
        // Update summary panel
        this.updateSummaryPanel(result);

        // Update decay-monitoring panel
        this.updateDecayPanel(result);

        // Update window breakdown table
        this.updateWindowTable(result);

        // Update robustness gauge
        this.updateRobustnessGauge(result.robustnessScore);

        // Plot combined OOS equity curve
        this.plotEquityCurve(result);

        debugLogger.info(`[WalkForward] Summary\n${formatWalkForwardSummary(result)}`);
    }

    private updateSummaryPanel(result: WalkForwardResult): void {
        updateWalkForwardSummaryPanel(this.getDom(), this.uiHost, result);
    }

    private updateDecayPanel(result: WalkForwardResult): void {
        renderWalkForwardDecayPanel(this.getDom(), this.uiHost, result);
    }

    private updateWindowTable(result: WalkForwardResult): void {
        updateWalkForwardWindowTable(this.getDom(), this.uiHost, result);
    }

    private updateRobustnessGauge(score: number): void {
        updateWalkForwardRobustnessGauge(this.getDom(), score);
    }

    private plotEquityCurve(result: WalkForwardResult): void {
        const oos = result.combinedOOSTrades;
        debugLogger.info(`Plotting OOS results: ${oos.trades.length} trades, ${oos.equityCurve.length} equity points`);

        // Preserve previous backtest state so it is not silently lost.
        if (state.currentBacktestResultSource !== 'walk_forward_oos') {
            this.previousBacktestSnapshot = {
                result: state.currentBacktestResult,
                source: state.currentBacktestResultSource ?? null
            };
        }

        // Route OOS output through shared backtest state so Results and Trades stay in sync.
        commitBacktestResult(oos, 'walk_forward_oos', {
            parityResults: null,
            reason: 'walk_forward_oos_plot',
        });
    }

    private setLoading(loading: boolean, mode: "analysis" | "quick" = "analysis"): void {
        setWalkForwardLoading(this.getDom(), loading, mode);
    }

    private updateStatus(message: string, log: boolean = true): void {
        this.getDom().wfStatus.textContent = message;
        if (log) {
            debugLogger.info(`[WalkForward] ${message}`);
        }
    }

    private createProgressReporter(): (progress: WalkForwardProgress) => void {
        let lastUpdate = 0;
        const minIntervalMs = 600;

        return (progress: WalkForwardProgress) => {
            const now = performance.now();
            if (progress.phase === 'optimize' && now - lastUpdate < minIntervalMs) return;
            lastUpdate = now;

            const windowLabel = `${progress.windowIndex + 1}/${progress.totalWindows}`;
            if (progress.phase === 'optimize') {
                const comboLabel = progress.comboTotal
                    ? ` (${progress.comboIndex}/${progress.comboTotal})`
                    : '';
                this.updateStatus(`Optimizing window ${windowLabel}${comboLabel}...`, false);
                return;
            }
            if (progress.phase === 'test') {
                this.updateStatus(`Running OOS for window ${windowLabel}...`, false);
                return;
            }
            if (progress.phase === 'window') {
                this.updateStatus(`Completed window ${windowLabel}.`, false);
                return;
            }
            if (progress.phase === 'complete') {
                this.updateStatus('Finalizing results...', false);
            }
        };
    }

    /**
     * Get the backtest state that was active before WFA overwrote it.
     */
    getPreviousBacktestSnapshot(): PreviousBacktestSnapshot | null {
        return this.previousBacktestSnapshot;
    }

    /**
     * Get last analysis result
     */
    getLastResult(): WalkForwardResult | null {
        return this.lastResult;
    }

    getLastRunBaseParams(): { strategyKey: string; params: StrategyParams } | null {
        if (!this.lastRunBaseParams) return null;
        return {
            strategyKey: this.lastRunBaseParams.strategyKey,
            params: { ...this.lastRunBaseParams.params }
        };
    }

    /**
     * Cancel a running analysis
     */
    cancelRun(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.updateStatus('Cancelling...');
        }
    }

    /**
     * Initialize UI event listeners
     */
    initUI(): void {
        const {
            wfRunBtn: runBtn,
            wfQuickBtn: quickBtn,
            wfCancelBtn: cancelBtn,
            wfAutoSuggest: autoSuggestToggle,
        } = this.getDom();

        runBtn.addEventListener('click', () => this.runAnalysis());
        quickBtn.addEventListener('click', () => this.runQuickAnalysis());
        cancelBtn.addEventListener('click', () => this.cancelRun());
        autoSuggestToggle.addEventListener('change', () => {
            if (autoSuggestToggle.checked) {
                this.refreshAutoSuggestionFromCurrentResult();
            }
        });

        this.setLoading(false);

        state.subscribe('currentBacktestResult', (result) => {
            if (!result) return;
            this.refreshAutoSuggestionFromCurrentResult();
        });

        debugLogger.info('Walk-Forward Service initialized');
    }
}

export const walkForwardService = new WalkForwardService();

import { isSmartTradeSizingMode } from "./types/backtest";
