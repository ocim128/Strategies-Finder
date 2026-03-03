import { state } from "./state";
import { dataManager } from "./data-manager";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { backtestService } from "./backtest-service";
import { rustEngine } from "./rust-engine-client";
import { shouldUseRustEngine } from "./engine-preferences";
import { sanitizeBacktestSettingsForRust } from "./rust-settings-sanitizer";
import { runBacktestCompact } from "./strategies/backtest";
import type { Strategy, StrategyParams, BacktestSettings, OHLCVData } from "./strategies/index";
import { sliceOhlcvByBlock } from "./block-selector";
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

const DEFAULT_CANDIDATE_VALIDATION_SEEDS = [1337, 7331, 2026, 4242, 9001];
const DEFAULT_MIN_SEED_PASSES = 3;
const DEFAULT_MAX_OOS_DD_PERCENT = 30;

type CandidateValidationDecisionReason =
    | "pass"
    | "net_loss"
    | "low_profit_factor"
    | "drawdown_breach"
    | "low_trades"
    | "run_error";

type CandidateSeedValidationRow = {
    seed: number;
    pass: boolean;
    decisionReason: CandidateValidationDecisionReason;
    netProfitPercent: number | null;
    profitFactor: number | null;
    maxDrawdownPercent: number | null;
    totalTrades: number | null;
    robustnessScore: number | null;
    testWindow: number;
    stepSize: number;
    commissionPercent: number;
    slippageBps: number;
    dataOffset: number;
    totalWindows: number | null;
    error?: string;
};

type CandidateValidationSummary = {
    seeds: number[];
    minPasses: number;
    passCount: number;
    failCount: number;
    decision: "PASS" | "FAIL";
    maxDrawdownLimit: number;
    minTrades: number;
    rows: CandidateSeedValidationRow[];
};

type CandidateSeedValidationProfile = {
    testWindow: number;
    stepSize: number;
    commissionPercent: number;
    slippageBps: number;
    dataOffset: number;
};

// ============================================================================
// Walk-Forward Service
// ============================================================================

class WalkForwardService {
    private lastResult: WalkForwardResult | null = null;
    private lastPreparedDataContext: string | null = null;

    private async ensureDataReadyForCurrentContext(): Promise<OHLCVData[]> {
        const contextKey = `${state.currentSymbol}|${state.currentInterval}`;
        const needsRefresh = state.ohlcvData.length === 0 || this.lastPreparedDataContext !== contextKey;
        if (!needsRefresh) {
            return sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
        }

        this.updateStatus('Syncing data for selected symbol/interval...');
        await dataManager.loadData(state.currentSymbol, state.currentInterval);
        this.lastPreparedDataContext = contextKey;
        return sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
    }

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
        const suggestion = this.suggestWindowsFromTradeFrequency(data.length, totalTrades, tradesPerBar);
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
            const applied = this.applyWindowSuggestion(suggestion, 'Auto window suggestion applied');
            if (applied) {
                debugLogger.info(
                    `[WalkForward] Auto-suggested windows | trades=${tradeStats.totalTrades} | opt=${suggestion.optimizationWindow} | test=${suggestion.testWindow} | step=${suggestion.stepSize} | windows=${suggestion.estimatedWindows}`
                );
            }
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
        const data = await this.ensureDataReadyForCurrentContext();
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

            let result: WalkForwardResult | null = null;
            const progressReporter = this.createProgressReporter();
            const baseConfig = this.getConfigFromUI(parameterRanges, tradeAwareThresholds);

            // Try Rust walk-forward first when compatible, then fallback to TypeScript.
            if (!useFixedParam && shouldUseRustEngine()) {
                const requiresTsEngine = backtestService.requiresTypescriptEngine(backtestSettings);
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
            } else if (!result) {
                // Use regular walk-forward with parameter optimization
                this.updateStatus('Running walk-forward analysis (optimizing parameters)...');
                debugLogger.info(`[WalkForward] Optimizing ${parameterRanges.length} parameters for: ${strategyKey}`);

                // Get config from UI
                const config: WalkForwardConfig = {
                    ...baseConfig,
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

            if (!result) {
                throw new Error('Walk-forward did not produce a result.');
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
        const data = await this.ensureDataReadyForCurrentContext();
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
                    fixedParams: currentParams,
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
                    backtestSettings,
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

    async runCandidateValidation(): Promise<CandidateValidationSummary | null> {
        const data = await this.ensureDataReadyForCurrentContext();
        if (!data || data.length === 0) {
            debugLogger.error("No data loaded for candidate validation");
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

        const fixedParams = paramManager.getValues(strategy);
        const seedInput = this.readStringInput("wf-validation-seeds", DEFAULT_CANDIDATE_VALIDATION_SEEDS.join(","));
        const seeds = this.parseSeedList(seedInput);
        if (seeds.length === 0) {
            this.updateStatus("Candidate validation needs at least one valid seed.");
            return null;
        }

        const minPassesRaw = Math.round(this.readNumberInput("wf-validation-min-passes", DEFAULT_MIN_SEED_PASSES));
        const minPasses = Math.max(1, Math.min(seeds.length, minPassesRaw));
        const maxDrawdownLimit = Math.max(
            1,
            this.readNumberInput("wf-validation-max-dd", DEFAULT_MAX_OOS_DD_PERCENT)
        );
        const baseMinTrades = Math.max(1, this.readNumberInput("wf-min-trades", 5));
        const baseTestWindow = Math.max(10, this.readNumberInput("wf-test-window", Math.floor(data.length * 0.2)));
        const baseStepSize = Math.max(10, this.readNumberInput("wf-step-size", baseTestWindow));
        const baseCommission = Math.max(0, capitalSettings.commission);
        const baseSlippageBps = Math.max(0, backtestSettings.slippageBps ?? 0);

        this.setLoading(true, "validation");
        this.updateStatus(`Validating candidate across ${seeds.length} seed(s)...`);

        try {
            const rows: CandidateSeedValidationRow[] = [];

            for (let i = 0; i < seeds.length; i++) {
                const seed = seeds[i];
                this.updateStatus(`Seed ${i + 1}/${seeds.length}: evaluating...`, false);

                const profile = this.buildCandidateValidationProfile(seed, {
                    dataLength: data.length,
                    baseTestWindow,
                    baseStepSize,
                    baseCommission,
                    baseSlippageBps
                });

                let runData = data.slice(profile.dataOffset);
                let testWindow = profile.testWindow;
                if (runData.length < testWindow * 2) {
                    runData = data;
                    testWindow = Math.max(10, Math.min(testWindow, Math.floor(runData.length / 3)));
                }

                if (runData.length < testWindow * 2) {
                    rows.push({
                        seed,
                        pass: false,
                        decisionReason: "run_error",
                        netProfitPercent: null,
                        profitFactor: null,
                        maxDrawdownPercent: null,
                        totalTrades: null,
                        robustnessScore: null,
                        testWindow,
                        stepSize: profile.stepSize,
                        commissionPercent: profile.commissionPercent,
                        slippageBps: profile.slippageBps,
                        dataOffset: profile.dataOffset,
                        totalWindows: null,
                        error: "insufficient_data"
                    });
                    await new Promise(resolve => setTimeout(resolve, 0));
                    continue;
                }

                const seedSettings: BacktestSettings = {
                    ...backtestSettings,
                    executionModel: "next_open",
                    allowSameBarExit: false,
                    slippageBps: Math.max(baseSlippageBps, profile.slippageBps)
                };

                try {
                    const result = await runFixedParamWalkForward(
                        runData,
                        { ...strategy, defaultParams: fixedParams },
                        {
                            testWindow,
                            stepSize: Math.max(10, Math.min(profile.stepSize, testWindow)),
                            fixedParams,
                            minTrades: baseMinTrades
                        },
                        capitalSettings.initialCapital,
                        capitalSettings.positionSize,
                        profile.commissionPercent,
                        seedSettings,
                        sizing
                    );

                    const decisionReason = this.resolveCandidateValidationDecisionReason(
                        result,
                        maxDrawdownLimit,
                        baseMinTrades
                    );

                    rows.push({
                        seed,
                        pass: decisionReason === "pass",
                        decisionReason,
                        netProfitPercent: result.combinedOOSTrades.netProfitPercent,
                        profitFactor: result.combinedOOSTrades.profitFactor,
                        maxDrawdownPercent: result.combinedOOSTrades.maxDrawdownPercent,
                        totalTrades: result.combinedOOSTrades.totalTrades,
                        robustnessScore: result.robustnessScore,
                        testWindow,
                        stepSize: Math.max(10, Math.min(profile.stepSize, testWindow)),
                        commissionPercent: profile.commissionPercent,
                        slippageBps: seedSettings.slippageBps ?? profile.slippageBps,
                        dataOffset: profile.dataOffset,
                        totalWindows: result.totalWindows
                    });
                } catch (error) {
                    rows.push({
                        seed,
                        pass: false,
                        decisionReason: "run_error",
                        netProfitPercent: null,
                        profitFactor: null,
                        maxDrawdownPercent: null,
                        totalTrades: null,
                        robustnessScore: null,
                        testWindow,
                        stepSize: profile.stepSize,
                        commissionPercent: profile.commissionPercent,
                        slippageBps: profile.slippageBps,
                        dataOffset: profile.dataOffset,
                        totalWindows: null,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }

                await new Promise(resolve => setTimeout(resolve, 0));
            }

            const passCount = rows.filter(row => row.pass).length;
            const summary: CandidateValidationSummary = {
                seeds,
                minPasses,
                passCount,
                failCount: rows.length - passCount,
                decision: passCount >= minPasses ? "PASS" : "FAIL",
                maxDrawdownLimit,
                minTrades: baseMinTrades,
                rows
            };

            this.renderCandidateValidationSummary(summary);
            this.updateStatus(
                `Candidate validation ${summary.decision}: ${summary.passCount}/${summary.seeds.length} seeds passed (required ${summary.minPasses}).`
            );
            debugLogger.info("[WalkForward] Candidate validation complete", {
                strategyKey,
                decision: summary.decision,
                passCount: summary.passCount,
                seedCount: summary.seeds.length,
                minPasses: summary.minPasses,
                maxDrawdownLimit: summary.maxDrawdownLimit
            });
            return summary;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            debugLogger.error(`Candidate validation failed: ${msg}`);
            this.updateStatus(`Candidate validation error: ${msg}`);
            return null;
        } finally {
            this.setLoading(false, "validation");
        }
    }

    private resolveCandidateValidationDecisionReason(
        result: WalkForwardResult,
        maxDrawdownLimit: number,
        minTrades: number
    ): CandidateValidationDecisionReason {
        const oos = result.combinedOOSTrades;
        if (oos.totalTrades < minTrades) return "low_trades";
        if (oos.netProfit <= 0) return "net_loss";
        if (!Number.isFinite(oos.profitFactor) || oos.profitFactor < 1) return "low_profit_factor";
        if (oos.maxDrawdownPercent > maxDrawdownLimit) return "drawdown_breach";
        return "pass";
    }

    private buildCandidateValidationProfile(
        seed: number,
        base: {
            dataLength: number;
            baseTestWindow: number;
            baseStepSize: number;
            baseCommission: number;
            baseSlippageBps: number;
        }
    ): CandidateSeedValidationProfile {
        const rand = this.createSeededRandom(seed);
        const maxTestWindow = Math.max(20, Math.floor(base.dataLength * 0.45));
        const testScale = 0.85 + rand() * 0.35; // 85%-120%
        const stepScale = 0.85 + rand() * 0.25; // 85%-110%

        const testWindow = Math.max(
            10,
            Math.min(maxTestWindow, Math.round(base.baseTestWindow * testScale))
        );
        const stepSize = Math.max(10, Math.round(base.baseStepSize * stepScale));

        const minRequiredBars = Math.max(40, testWindow * 2);
        const offsetBudget = Math.max(0, base.dataLength - minRequiredBars);
        const maxOffset = Math.min(offsetBudget, Math.max(0, base.baseStepSize * 3));
        const dataOffset = maxOffset > 0 ? Math.floor(rand() * (maxOffset + 1)) : 0;

        const stressedCommissionBase = Math.max(0.02, base.baseCommission);
        const commissionPercent = Number((stressedCommissionBase * (1.1 + rand() * 0.35)).toFixed(4));
        const slippageBps = Math.max(base.baseSlippageBps + 1, Math.round(base.baseSlippageBps + 1 + rand() * 6));

        return {
            testWindow,
            stepSize,
            commissionPercent,
            slippageBps,
            dataOffset
        };
    }

    private createSeededRandom(seed: number): () => number {
        let state = (Math.floor(seed) >>> 0) || 1;
        return () => {
            state += 0x6D2B79F5;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    private parseSeedList(raw: string): number[] {
        const source = raw.trim().length > 0 ? raw : DEFAULT_CANDIDATE_VALIDATION_SEEDS.join(",");
        const parsed = source
            .split(/[\s,]+/)
            .map(token => Number(token.trim()))
            .filter(value => Number.isFinite(value))
            .map(value => (Math.trunc(value) >>> 0) || 1);

        const unique: number[] = [];
        const seen = new Set<number>();
        for (const value of parsed) {
            if (seen.has(value)) continue;
            seen.add(value);
            unique.push(value);
        }

        return unique.length > 0 ? unique : [...DEFAULT_CANDIDATE_VALIDATION_SEEDS];
    }

    private readStringInput(id: string, fallback: string): string {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return fallback;
        const value = el.value.trim();
        return value.length > 0 ? value : fallback;
    }

    private formatCandidateValidationDecision(reason: CandidateValidationDecisionReason): string {
        if (reason === "pass") return "PASS";
        if (reason === "net_loss") return "FAIL(net)";
        if (reason === "low_profit_factor") return "FAIL(pf)";
        if (reason === "drawdown_breach") return "FAIL(dd)";
        if (reason === "low_trades") return "FAIL(trades)";
        return "FAIL(error)";
    }

    private formatSignedPercent(value: number | null): string {
        if (!Number.isFinite(value)) return "-";
        const n = Number(value);
        const sign = n >= 0 ? "+" : "";
        return `${sign}${n.toFixed(2)}%`;
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

    private renderCandidateValidationSummary(summary: CandidateValidationSummary | null): void {
        const panel = document.getElementById("wf-validation-panel");
        if (!panel) return;

        if (!summary) {
            panel.innerHTML = `
                <div class="empty-state">
                    <p>Run Validate Candidate to check 5-seed pass/fail status.</p>
                </div>
            `;
            return;
        }

        const decisionClass = summary.decision === "PASS" ? "positive" : "negative";
        const rowsHtml = summary.rows.map(row => `
            <tr class="${row.pass ? "positive" : "negative"}">
                <td>${row.seed}</td>
                <td class="${row.pass ? "positive" : "negative"}">${this.formatCandidateValidationDecision(row.decisionReason)}</td>
                <td>${this.formatSignedPercent(row.netProfitPercent)}</td>
                <td>${this.formatNumber(row.profitFactor, 2)}</td>
                <td>${this.formatPercent(row.maxDrawdownPercent, 2)}</td>
                <td>${row.totalTrades ?? "-"}</td>
                <td>${this.formatNumber(row.robustnessScore, 0)}</td>
                <td>${row.totalWindows ?? "-"}</td>
                <td>${row.testWindow}/${row.stepSize}</td>
                <td>${row.commissionPercent.toFixed(4)}%</td>
                <td>${row.slippageBps}</td>
            </tr>
        `).join("");

        panel.innerHTML = `
            <div class="wf-validation-header">
                <div class="wf-validation-title ${decisionClass}">
                    ${summary.decision} ${summary.passCount}/${summary.seeds.length} seeds
                </div>
                <div class="wf-validation-note">
                    Rule: pass if >= ${summary.minPasses}/${summary.seeds.length}. Per-seed checks:
                    net > 0, PF >= 1, DD <= ${summary.maxDrawdownLimit.toFixed(1)}%, trades >= ${summary.minTrades}.
                </div>
            </div>
            <div class="wf-summary">
                <div class="wf-stat">
                    <span class="wf-label">Seed Passes</span>
                    <span class="wf-value ${decisionClass}">${summary.passCount}/${summary.seeds.length}</span>
                </div>
                <div class="wf-stat">
                    <span class="wf-label">Required Passes</span>
                    <span class="wf-value">${summary.minPasses}</span>
                </div>
                <div class="wf-stat">
                    <span class="wf-label">Fail Count</span>
                    <span class="wf-value negative">${summary.failCount}</span>
                </div>
                <div class="wf-stat">
                    <span class="wf-label">DD Limit</span>
                    <span class="wf-value">${summary.maxDrawdownLimit.toFixed(1)}%</span>
                </div>
            </div>
            <div class="wf-table-wrapper wf-validation-table-wrap">
                <table class="wf-table wf-validation-table">
                    <thead>
                        <tr>
                            <th>Seed</th>
                            <th>Decision</th>
                            <th>OOS Net%</th>
                            <th>PF</th>
                            <th>Max DD%</th>
                            <th>Trades</th>
                            <th>Robust</th>
                            <th>Windows</th>
                            <th>T/S</th>
                            <th>Fee%</th>
                            <th>Slip</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        `;
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

        // Route OOS output through shared backtest state so Results and Trades stay in sync.
        state.set('twoHourParityBacktestResults', null);
        state.set('currentBacktestResultSource', 'walk_forward_oos');
        state.set('currentBacktestResult', oos);
    }

    private setLoading(loading: boolean, mode: "analysis" | "validation" = "analysis"): void {
        const runBtn = document.getElementById("wf-run-btn") as HTMLButtonElement | null;
        const quickBtn = document.getElementById("wf-quick-btn") as HTMLButtonElement | null;
        const validateBtn = document.getElementById("wf-validate-btn") as HTMLButtonElement | null;
        const spinner = document.getElementById("wf-spinner");

        if (runBtn) {
            runBtn.disabled = loading;
            runBtn.setAttribute("aria-busy", loading && mode === "analysis" ? "true" : "false");
        }
        if (quickBtn) {
            quickBtn.disabled = loading;
        }
        if (validateBtn) {
            validateBtn.disabled = loading;
            validateBtn.setAttribute("aria-busy", loading && mode === "validation" ? "true" : "false");
        }
        if (spinner) {
            spinner.style.display = loading ? "inline-block" : "none";
        }
    }

    private updateStatus(message: string, log: boolean = true): void {
        const statusEl = document.getElementById('wf-status');
        if (statusEl) statusEl.textContent = message;
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
        const validateBtn = document.getElementById('wf-validate-btn');
        const autoSuggestToggle = document.getElementById('wf-auto-suggest') as HTMLInputElement | null;

        if (runBtn) {
            runBtn.addEventListener('click', () => this.runAnalysis());
        }
        if (quickBtn) {
            quickBtn.addEventListener('click', () => this.runQuickAnalysis());
        }
        if (validateBtn) {
            validateBtn.addEventListener('click', () => this.runCandidateValidation());
        }
        if (autoSuggestToggle) {
            autoSuggestToggle.addEventListener('change', () => {
                if (autoSuggestToggle.checked) {
                    this.refreshAutoSuggestionFromCurrentResult();
                }
            });
        }

        state.subscribe('currentBacktestResult', (result) => {
            if (!result) return;
            this.refreshAutoSuggestionFromCurrentResult();
        });

        debugLogger.info('Walk-Forward Service initialized');
    }
}

export const walkForwardService = new WalkForwardService();
