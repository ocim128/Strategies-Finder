import { state } from "./state";
import { uiManager } from "./ui-manager";
import { chartManager } from "./chart-manager";
import { clearActiveBacktestRerunContext, getActiveBacktestRerunContext } from "./backtest-rerun-context";

import {
    runBacktest,
    StrategyParams,
    BacktestSettings,
    BacktestResult,
    Signal,
    applySignalPolarity,
} from "./strategies/index";
import type { OHLCVData, Strategy } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { rustEngine } from "./rust-engine-client";
import { shouldUseRustEngine } from "./engine-preferences";

import {
    calculateAdvancedPerformanceAnalyticsFromEquityCurve,
    calculateSharpeRatioFromEquityCurve,
    calculateSharpeRatioFromReturns,
} from "./strategies/performance-metrics";
import { computeEdgeStatistics } from "./strategies/backtest/edge-statistics";
import { getOptionalElement } from "./dom-utils";
import { sanitizeBacktestSettingsForRust, requiresTypescriptEngine as requiresTsEngine } from "./rust-settings-sanitizer";
import { sliceOhlcvByBlock } from "./block-selector";
import {
    selectExecutionAwareClosedCandles,
} from "./alert-evaluation-window";
import {
    BACKTEST_DOM_SETTING_IDS,
    CAPITAL_DEFAULTS,
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw
} from "./backtest-settings-resolver";
import { readNumberInputValue } from "./dom-input-readers";
import { settingsManager, type StrategyConfig } from "./settings-manager";
import { mergeStrategySignals } from "./signal-merge";
import { resolveSubscriptionExecutionBacktestSettings } from "./alert-subscription-utils";
import { isSmartTradeSizingMode, type CapitalSettings, type TradeSizingMode } from "./types/backtest";
import { ADVANCED_SIZING_DOM_IDS, ADVANCED_SIZING_FIELD_IDS } from "./advanced-sizing-dom";
import {
    resolveCapitalSettingsFromRaw,
    SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS,
} from "./backtest-capital-settings";
import {
    createDomBacktestRunHandle,
    delayBacktestUi,
    formatCompletedBacktestStatus,
    formatCompletedCombinedBacktestStatus,
    setReplayStartButtonDisabled,
    updateDomBacktestRunProgress,
    type BacktestRunHandle,
} from "./backtest-run-presenter";
import { commitBacktestResult } from "./state-actions";
import { annotateBacktestResultWithPolymarketOutcomes } from "./polymarket-trade-annotations";
import {
    buildBacktestEndpointCopyBundleFromSnapshot,
    computeBacktestEndpointDatasetFingerprint,
    getCurrentUiBacktestEndpointCandles,
    getCurrentUiBacktestEndpointSnapshot,
    hasCurrentUiBacktestEndpointCandles,
    hasCurrentUiBacktestEndpointSnapshot,
    matchesEndpointCapitalProfile,
    prepareBacktestEndpointCopyBundleFromSnapshot,
    type UiBacktestEndpointSnapshot,
} from "./backtest-endpoint-copy";
import { buildBacktestEndpointExecutorRequestFromSnapshot } from "./backtest-endpoint-execution";
import { toCompactMetrics } from "./backtest-endpoint-contract";
import { executeBacktest, executeBacktestFromSignals } from "./backtest-executor";

type CurrentBacktestExecution = {
    result: BacktestResult;
    engineUsed: 'rust' | 'typescript';
    requestContext: {
        nowSec: number;
        blockRange: { from: number; to: number } | null;
    };
};

export class BacktestService {
    private warnedStrictEngine = false;
    private timingBreakdownSampleCount = 0;
    private interactiveRunSequence = 0;

    private shouldCaptureTimingBreakdown(): boolean {
        return Boolean(import.meta.env?.DEV) || ((++this.timingBreakdownSampleCount & 31) === 0);
    }

    private beginInteractiveRun(): number {
        this.interactiveRunSequence += 1;
        return this.interactiveRunSequence;
    }

    private isLatestInteractiveRun(runId: number): boolean {
        return runId === this.interactiveRunSequence;
    }

    public async runCurrentBacktest() {
        const runId = this.beginInteractiveRun();
        const activePreviewRerun = state.currentBacktestResultSource === 'ensemble_preview'
            ? getActiveBacktestRerunContext()
            : null;
        if (activePreviewRerun?.source === 'ensemble_preview') {
            await activePreviewRerun.rerun();
            return;
        }

        clearActiveBacktestRerunContext();
        const startedAt = Date.now();
        debugLogger.event('backtest.start', {
            strategy: state.currentStrategyKey,
            candles: state.ohlcvData.length,
        });
        const runUi = createDomBacktestRunHandle('runBacktest', 'Running backtest...', true);
        let shouldDelayHide = false;

        try {
            await updateDomBacktestRunProgress(runUi, '20%', 'Calculating indicators...', 100);

            const strategy = strategyRegistry.get(state.currentStrategyKey);
            if (!strategy) {
                debugLogger.error("backtest.strategy_not_found", { strategyKey: state.currentStrategyKey });
                runUi.setStatus('Strategy not found');
                return;
            }

            const params = paramManager.getValues(strategy);
            const capitalSettings = this.getCapitalSettings();
            const settings = this.getBacktestSettings();
            const requiresTsEngine = this.requiresTypescriptEngine(settings) || this.requiresTypescriptSizingMode(capitalSettings.sizingMode);
            await updateDomBacktestRunProgress(runUi, '40%', 'Generating signals...', 100);

            let { result, engineUsed, requestContext } = await this.executeBacktest(
                runUi,
                strategy,
                params,
                settings,
                capitalSettings,
                requiresTsEngine
            );

            // Only annotate Polymarket outcomes when explicitly enabled
            const annotatePolymarket = settings.polymarketAnnotationEnabled ?? false;
            if (annotatePolymarket) {
                result = await this.annotatePolymarketResult(result, settings, state.ohlcvData);
            }

            if (!this.isLatestInteractiveRun(runId)) {
                debugLogger.event('backtest.stale_ignored', {
                    strategy: state.currentStrategyKey,
                    runId,
                    phase: 'commit',
                });
                return;
            }

            commitBacktestResult(result, 'backtest', {
                reason: 'manual_backtest',
                endpointCopySnapshot: this.createEndpointCopySnapshot(
                    params,
                    settings,
                    capitalSettings,
                    engineUsed,
                    requestContext.nowSec,
                    requestContext.blockRange,
                    annotatePolymarket
                ),
                endpointCopyCandles: state.ohlcvData,
            });

            await updateDomBacktestRunProgress(runUi, '100%', 'Complete!');
            runUi.setStatus(formatCompletedBacktestStatus(result, engineUsed));
            shouldDelayHide = true;
            debugLogger.event('backtest.success', {
                strategy: state.currentStrategyKey,
                trades: result.totalTrades,
                durationMs: Date.now() - startedAt,
                engine: engineUsed,
            });
            // Enable replay button if there are results
            setReplayStartButtonDisabled(result.totalTrades === 0);
        } catch (error) {
            if (!this.isLatestInteractiveRun(runId)) {
                debugLogger.event('backtest.stale_ignored', {
                    strategy: state.currentStrategyKey,
                    runId,
                    phase: 'error',
                });
                return;
            }
            debugLogger.error('backtest.error', {
                strategy: state.currentStrategyKey,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                durationMs: Date.now() - startedAt,
            });
            // Disable replay button on error
            setReplayStartButtonDisabled(true);

            throw error;
        } finally {
            if (shouldDelayHide && this.isLatestInteractiveRun(runId)) {
                await delayBacktestUi(500);
            }
            runUi.finish();
        }
    }

    public async previewCurrentBacktestWithSettings(settingsOverride: Partial<BacktestSettings>): Promise<BacktestResult | null> {
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy) {
            return null;
        }

        const params = paramManager.getValues(strategy);
        const capitalSettings = this.getCapitalSettings();
        const mergedSettings = resolveBacktestSettingsFromRaw(
            {
                ...this.getBacktestSettings(),
                ...settingsOverride,
            } as BacktestSettings,
            { coerceWithoutUiToggles: false,
            }
        );

        mergedSettings.tradeDirection = mergedSettings.tradeDirection ?? EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
        mergedSettings.executionModel = mergedSettings.executionModel ?? EFFECTIVE_BACKTEST_DEFAULTS.executionModel;

        const requiresTsEngine = this.requiresTypescriptEngine(mergedSettings) || this.requiresTypescriptSizingMode(capitalSettings.sizingMode);
        const run = await this.runBacktestForData(
            state.ohlcvData,
            state.currentInterval,
            strategy,
            params,
            mergedSettings,
            capitalSettings,
            requiresTsEngine
        );

        return run.result;
    }

    private async executeBacktest(
        runUi: BacktestRunHandle,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings,
        capitalSettings: CapitalSettings,
        requiresTsEngine: boolean
    ): Promise<CurrentBacktestExecution> {
        await updateDomBacktestRunProgress(runUi, '60%', 'Running backtest...', 100);
        const singleRun = await this.runBacktestForData(
            state.ohlcvData,
            state.currentInterval,
            strategy,
            params,
            settings,
            capitalSettings,
            requiresTsEngine
        );

        return {
            result: singleRun.result,
            engineUsed: singleRun.engineUsed,
            requestContext: singleRun.requestContext,
        };
    }

    // ========================================================================
    // Combined Strategy Backtest
    // ========================================================================

    /**
     * Run a combined backtest by merging signals from two saved configurations.
     * Primary config provides both signals AND backtest settings (risk, capital, execution).
     * Secondary config provides signals only.
     *
     * @param primaryConfig  Saved config providing signals + settings
     * @param secondaryConfig  Saved config providing signals only
     * @param mode  'and' = keep only where both agree (same bar + direction),
     *              'or'  = union of both (primary wins on same bar)
     */
    public async runCombinedStrategyBacktest(
        primaryConfig: StrategyConfig,
        secondaryConfig: StrategyConfig,
        mode: 'and' | 'or'
    ): Promise<void> {
        const runId = this.beginInteractiveRun();
        const startedAt = Date.now();
        debugLogger.event('backtest.combined.start', {
            primary: primaryConfig.strategyKey,
            secondary: secondaryConfig.strategyKey,
            mode,
        });

        const runUi = createDomBacktestRunHandle('runCombinedStrategyBtn', 'Running combined backtest...');

        try {
            // --- 1. Resolve both strategies from registry ---
            await updateDomBacktestRunProgress(runUi, '10%', 'Resolving strategies...', 50);

            const primaryStrategy = strategyRegistry.get(primaryConfig.strategyKey);
            const secondaryStrategy = strategyRegistry.get(secondaryConfig.strategyKey);

            if (!primaryStrategy) {
                runUi.setStatus(`Primary strategy "${primaryConfig.strategyKey}" not found`);
                return;
            }
            if (!secondaryStrategy) {
                runUi.setStatus(`Secondary strategy "${secondaryConfig.strategyKey}" not found`);
                return;
            }

            // --- 2. Prepare data ---
            await updateDomBacktestRunProgress(runUi, '20%', 'Preparing data...', 50);

            const primarySettings = resolveBacktestSettingsFromRaw(
                primaryConfig.backtestSettings as unknown as BacktestSettings,
                { coerceWithoutUiToggles: true }
            );
            const secondarySettings = resolveBacktestSettingsFromRaw(
                secondaryConfig.backtestSettings as unknown as BacktestSettings,
                { coerceWithoutUiToggles: true }
            );
            const backtestData = this.selectClosedCandleData(
                state.ohlcvData,
                state.currentInterval,
                primarySettings
            );

            // --- 3. Execute both strategies ---
            await updateDomBacktestRunProgress(runUi, '40%', 'Generating signals from both strategies...', 50);

            const primarySignals = applySignalPolarity(
                primaryStrategy.execute(backtestData, primaryConfig.strategyParams),
                primarySettings
            );
            const secondarySignals = applySignalPolarity(
                secondaryStrategy.execute(backtestData, secondaryConfig.strategyParams),
                secondarySettings
            );

            // --- 4. Merge signals ---
            await updateDomBacktestRunProgress(runUi, '60%', `Merging signals (${mode.toUpperCase()})...`, 50);

            const mergedSignals = mergeStrategySignals(primarySignals, secondarySignals, mode);

            // --- 5. Run backtest using primary config's settings + capital ---
            await updateDomBacktestRunProgress(runUi, '80%', 'Running backtest on merged signals...', 50);

            const capitalSettings = settingsManager.resolveCapitalFromConfig(primaryConfig);
            const requiresTsEngine =
                this.requiresTypescriptEngine(primarySettings) || this.requiresTypescriptSizingMode(capitalSettings.sizingMode);
            const { result, filteredSignalsCount } = await this.runBacktestForPreparedData(
                backtestData,
                mergedSignals,
                primarySettings,
                capitalSettings,
                requiresTsEngine
            );

            if (!this.isLatestInteractiveRun(runId)) {
                debugLogger.event('backtest.stale_ignored', {
                    primary: primaryConfig.strategyKey,
                    secondary: secondaryConfig.strategyKey,
                    mode,
                    runId,
                    phase: 'combined_commit',
                });
                return;
            }

            // --- 6. Update state and UI ---
            commitBacktestResult(result, 'backtest', {
                reason: 'combined_strategy_backtest',
            });

            await updateDomBacktestRunProgress(runUi, '100%', 'Complete!');
            runUi.setStatus(formatCompletedCombinedBacktestStatus(mode, result));

            debugLogger.event('backtest.combined.success', {
                primary: primaryConfig.strategyKey,
                secondary: secondaryConfig.strategyKey,
                mode,
                primarySignals: primarySignals.length,
                secondarySignals: secondarySignals.length,
                mergedSignals: filteredSignalsCount,
                trades: result.totalTrades,
                durationMs: Date.now() - startedAt,
            });

            await delayBacktestUi(500);
        } catch (error) {
            if (!this.isLatestInteractiveRun(runId)) {
                debugLogger.event('backtest.stale_ignored', {
                    primary: primaryConfig.strategyKey,
                    secondary: secondaryConfig.strategyKey,
                    mode,
                    runId,
                    phase: 'combined_error',
                });
                return;
            }
            debugLogger.error('backtest.combined.error', {
                primary: primaryConfig.strategyKey,
                secondary: secondaryConfig.strategyKey,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
            runUi.setStatus('Combined backtest failed');
            throw error;
        } finally {
            runUi.finish();
        }
    }

    private async runBacktestForData(
        ohlcvData: OHLCVData[],
        interval: string,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings,
        capitalSettings: CapitalSettings,
        requiresTsEngine: boolean
    ): Promise<{
        result: BacktestResult;
        engineUsed: 'rust' | 'typescript';
        requestContext: {
            nowSec: number;
            blockRange: { from: number; to: number } | null;
        };
    }> {
        const captureTiming = this.shouldCaptureTimingBreakdown();
        const runStart = captureTiming ? performance.now() : 0;
        if (requiresTsEngine && shouldUseRustEngine() && !this.warnedStrictEngine) {
            this.warnedStrictEngine = true;
            uiManager.showToast('Current sizing or realism settings require TypeScript engine (Rust skipped).', 'info');
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const blockRange = state.blockRange ? { ...state.blockRange } : null;
        const run = await executeBacktest({
            ohlcvData,
            interval,
            strategyKey: state.currentStrategyKey,
            strategy,
            strategyParams: params,
            backtestSettings: {
                ...settings,
                symbol: state.currentSymbol,
                interval,
            },
            capitalSettings,
            context: {
                nowSec,
                blockRange,
                annotatePolymarket: false,
                engineMode: requiresTsEngine ? 'typescript' : 'auto',
            },
        });

        if (captureTiming) {
            debugLogger.event('backtest.timing_breakdown', {
                engineUsed: run.engineUsed,
                bars: run.result.marketContext?.candleCount ?? 0,
                durations: {
                    total: performance.now() - runStart,
                },
            });
        }

        return {
            ...run,
            requestContext: {
                nowSec,
                blockRange,
            },
        };
    }

    private async runBacktestForPreparedSignals(
        ohlcvData: OHLCVData[],
        interval: string,
        signals: Signal[],
        settings: BacktestSettings,
        capitalSettings: CapitalSettings,
        requiresTsEngine: boolean
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        if (requiresTsEngine && shouldUseRustEngine() && !this.warnedStrictEngine) {
            this.warnedStrictEngine = true;
            uiManager.showToast('Current sizing or realism settings require TypeScript engine (Rust skipped).', 'info');
        }

        return executeBacktestFromSignals(
            ohlcvData,
            interval,
            signals,
            {
                ...settings,
                symbol: state.currentSymbol,
                interval,
            },
            capitalSettings,
            {
                nowSec: Math.floor(Date.now() / 1000),
                blockRange: state.blockRange,
                annotatePolymarket: false,
                engineMode: requiresTsEngine ? 'typescript' : 'auto',
            }
        );
    }

    private async runBacktestForPreparedData(
        backtestData: OHLCVData[],
        signals: Signal[],
        settings: BacktestSettings,
        capitalSettings: CapitalSettings,
        requiresTsEngine: boolean
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript'; filteredSignalsCount: number }> {
        const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = capitalSettings;
        const blockFilteredSignals = this.filterSignalsByBlockRange(signals);

        let result: BacktestResult | undefined;
        let engineUsed: 'rust' | 'typescript' = 'typescript';

        if (shouldUseRustEngine() && !requiresTsEngine) {
            const rustResult = await rustEngine.runBacktest(
                backtestData,
                blockFilteredSignals,
                initialCapital,
                positionSize,
                commission,
                sanitizeBacktestSettingsForRust(settings),
                { mode: sizingMode, fixedTradeAmount, advancedSizing: capitalSettings.advancedSizing }
            );

            if (rustResult && this.isResultConsistent(rustResult)) {
                result = rustResult;
                engineUsed = 'rust';
            }
        }

        if (!result) {
            result = runBacktest(
                backtestData,
                blockFilteredSignals,
                initialCapital,
                positionSize,
                commission,
                settings,
                { mode: sizingMode, fixedTradeAmount, advancedSizing: capitalSettings.advancedSizing }
            );
            engineUsed = 'typescript';
        }

        this.finalizeBacktestResult(result, initialCapital, backtestData);
        return { result, engineUsed, filteredSignalsCount: blockFilteredSignals.length };
    }

    private filterSignalsByBlockRange<T extends { time: Signal['time'] }>(signals: T[]): T[] {
        const block = state.blockRange;
        if (!block || block.from === block.to) {
            return signals;
        }
        return signals.filter(signal => {
            const t = typeof signal.time === 'number' ? signal.time : Number(signal.time);
            return t >= block.from && t <= block.to;
        });
    }

    private finalizeBacktestResult(
        result: BacktestResult,
        initialCapital: number,
        backtestData: OHLCVData[]
    ): void {
        result.marketContext = {
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            candleCount: backtestData.length,
            firstCandleTime: backtestData[0]?.time ?? null,
            lastCandleTime: backtestData[backtestData.length - 1]?.time ?? null,
        };
        if (!result.entryStats) {
            result.sharpeRatio = this.recomputeSharpeRatio(result, initialCapital);
            result.performanceAnalytics = this.recomputePerformanceAnalytics(result);
        }
        
        
        if (result.trades.length >= 3) {
            result.edgeStatistics = computeEdgeStatistics(result, backtestData);
        }
    }

    private async annotatePolymarketResult(
        result: BacktestResult,
        settings: BacktestSettings,
        chartData: OHLCVData[]
    ): Promise<BacktestResult> {
        try {
            return await annotateBacktestResultWithPolymarketOutcomes(result, {
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                executionModel: settings.executionModel,
                chartData,
            }, settings.polymarketEntryOffset);
        } catch (error) {
            debugLogger.error("backtest.polymarket_annotation_failed", {
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                error: error instanceof Error ? error.message : String(error),
            });
            return result;
        }
    }

    private selectClosedCandleData(
        ohlcvData: OHLCVData[],
        interval: string,
        settings: BacktestSettings
    ): OHLCVData[] {
        const executionAware = selectExecutionAwareClosedCandles(
            ohlcvData,
            interval,
            settings,
            {
                nowSec: Math.floor(Date.now() / 1000),
                minClosedCandles: 1,
                fallbackToTrimmedClosed: true,
            }
        );
        if (executionAware) {
            return sliceOhlcvByBlock(executionAware, state.blockRange);
        }
        return sliceOhlcvByBlock(ohlcvData, state.blockRange);
    }

    public getCapitalSettings(): CapitalSettings {
        const fixedTradeToggle = getOptionalElement<HTMLInputElement>('fixedTradeToggle');
        const tradeSizingMode = getOptionalElement<HTMLSelectElement>('tradeSizingMode');
        const raw: Record<string, unknown> = {
            initialCapital: readNumberInputValue('initialCapital', CAPITAL_DEFAULTS.initialCapital),
            positionSize: readNumberInputValue('positionSize', CAPITAL_DEFAULTS.positionSize),
            commission: readNumberInputValue('commission', CAPITAL_DEFAULTS.commission),
            fixedTradeAmount: readNumberInputValue('fixedTradeAmount', CAPITAL_DEFAULTS.fixedTradeAmount),
            fixedTradeToggle: fixedTradeToggle?.checked,
            sizingMode: tradeSizingMode?.value,
        };

        for (const key of ADVANCED_SIZING_FIELD_IDS) {
            const element = getOptionalElement<HTMLInputElement | HTMLSelectElement>(ADVANCED_SIZING_DOM_IDS[key]);
            if (!element) continue;
            raw[key] = element instanceof HTMLInputElement && element.type === "checkbox"
                ? element.checked
                : element.value;
        }

        return resolveCapitalSettingsFromRaw(raw);
    }

    public getBacktestSettings(): BacktestSettings {
        const raw: Record<string, unknown> = {};
        for (const id of BACKTEST_DOM_SETTING_IDS) {
            const value = this.readDomSettingValue(id);
            if (value !== undefined) {
                raw[id] = value;
            }
        }

        const settings = resolveBacktestSettingsFromRaw(raw as BacktestSettings, {
            coerceWithoutUiToggles: false,
        });

        settings.tradeDirection = settings.tradeDirection ?? EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
        settings.executionModel = settings.executionModel ?? EFFECTIVE_BACKTEST_DEFAULTS.executionModel;
        return settings;
    }

    private readDomSettingValue(id: string): unknown {
        const element = getOptionalElement<HTMLElement>(id);
        if (!element) return undefined;
        if (element instanceof HTMLInputElement) {
            if (element.type === 'checkbox' || element.type === 'radio') {
                return element.checked;
            }
            return element.value;
        }
        if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
            return element.value;
        }
        return undefined;
    }

    private requiresTypescriptSizingMode(sizingMode: TradeSizingMode): boolean {
        return isSmartTradeSizingMode(sizingMode);
    }

    private resolveSubscriptionCapitalSettings(backtestSettings: BacktestSettings): CapitalSettings {
        const raw = backtestSettings as Record<string, unknown>;
        return resolveCapitalSettingsFromRaw(raw, SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS);
    }

    private isResultConsistent(result: BacktestResult): boolean {
        const totalTrades = result.totalTrades;
        if (totalTrades !== result.winningTrades + result.losingTrades) return false;
        if (totalTrades <= 0) return true;

        const expectedWinRate = (result.winningTrades / totalTrades) * 100;
        if (Math.abs(expectedWinRate - result.winRate) > 1) return false;

        const expectedAvgTrade = result.netProfit / totalTrades;
        const tolerance = Math.max(0.01, Math.abs(expectedAvgTrade) * 0.15);
        if (Math.abs(expectedAvgTrade - result.avgTrade) > tolerance) return false;

        return true;
    }

    private recomputeSharpeRatio(result: BacktestResult, _initialCapital: number): number {
        if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
            return calculateSharpeRatioFromEquityCurve(result.equityCurve);
        }

        if (Array.isArray(result.trades) && result.trades.length > 0) {
            return calculateSharpeRatioFromReturns(result.trades.map(trade => trade.pnlPercent));
        }

        return Number.isFinite(result.sharpeRatio) ? result.sharpeRatio : 0;
    }

    private recomputePerformanceAnalytics(result: BacktestResult) {
        if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
            return calculateAdvancedPerformanceAnalyticsFromEquityCurve(result.equityCurve);
        }

        return undefined;
    }

    public requiresTypescriptEngine(settings: BacktestSettings): boolean {
        // Use shared helper for single-source-of-truth Rust eligibility
        return requiresTsEngine(settings);
    }

    private canUseCurrentChartForEndpointCopy(snapshot: UiBacktestEndpointSnapshot): boolean {
        return hasCurrentUiBacktestEndpointCandles()
            && snapshot.symbol === state.currentSymbol
            && snapshot.interval === state.currentInterval;
    }

    private compactMetricResultsMatch(left: BacktestResult, right: BacktestResult): boolean {
        const leftMetrics = toCompactMetrics(left);
        const rightMetrics = toCompactMetrics(right);
        const epsilon = 1e-9;
        const metricKeys = Object.keys(leftMetrics) as Array<keyof typeof leftMetrics>;

        return metricKeys.every((key) => {
            const leftValue = leftMetrics[key];
            const rightValue = rightMetrics[key];
            if (typeof leftValue === "number" && typeof rightValue === "number") {
                if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
                    return leftValue === rightValue;
                }
                return Math.abs(leftValue - rightValue) <= epsilon;
            }
            return leftValue === rightValue;
        });
    }

    public canCopyLatestUiBacktestEndpointRequest(): boolean {
        const snapshot = getCurrentUiBacktestEndpointSnapshot();
        if (!hasCurrentUiBacktestEndpointSnapshot() || !snapshot || !state.currentBacktestResult) {
            return false;
        }

        return this.canUseCurrentChartForEndpointCopy(snapshot);
    }

    public canRunLatestUiBacktestEndpointPreview(): boolean {
        return this.canCopyLatestUiBacktestEndpointRequest();
    }

    public async runLatestUiBacktestEndpointPreview(): Promise<{
        strategyKey: string;
        result: BacktestResult;
        engineUsed: "rust" | "typescript";
        matchesCurrentUiResult: boolean;
        previousUiMetrics: ReturnType<typeof toCompactMetrics>;
        endpointMetrics: ReturnType<typeof toCompactMetrics>;
    } | null> {
        const snapshot = getCurrentUiBacktestEndpointSnapshot();
        const candles = getCurrentUiBacktestEndpointCandles();
        const currentResult = state.currentBacktestResult;
        if (!snapshot || !candles || !currentResult || !this.canUseCurrentChartForEndpointCopy(snapshot)) {
            return null;
        }

        const endpointRun = await executeBacktest(
            buildBacktestEndpointExecutorRequestFromSnapshot(snapshot, candles)
        );
        const matchesCurrentUiResult = this.compactMetricResultsMatch(currentResult, endpointRun.result);

        commitBacktestResult(endpointRun.result, "endpoint_preview", {
            reason: "endpoint_preview",
            endpointCopySnapshot: snapshot,
            endpointCopyCandles: candles,
        });

        return {
            strategyKey: snapshot.strategyKey,
            result: endpointRun.result,
            engineUsed: endpointRun.engineUsed,
            matchesCurrentUiResult,
            previousUiMetrics: toCompactMetrics(currentResult),
            endpointMetrics: toCompactMetrics(endpointRun.result),
        };
    }

    public async buildLatestUiBacktestEndpointCopyBundle(baseUrl: string): Promise<{
        strategyKey: string;
        bundle: ReturnType<typeof buildBacktestEndpointCopyBundleFromSnapshot>;
        uiCapitalMatchesEndpoint: boolean;
        datasetRef: string;
        candleCount: number;
        datasetUploaded: boolean;
        datasetUploadError: string | null;
    } | null> {
        const snapshot = getCurrentUiBacktestEndpointSnapshot();
        const candles = getCurrentUiBacktestEndpointCandles();
        if (!snapshot || !candles || !state.currentBacktestResult || !this.canUseCurrentChartForEndpointCopy(snapshot)) {
            return null;
        }

        const preparedCopy = await prepareBacktestEndpointCopyBundleFromSnapshot(snapshot, baseUrl, candles);

        return {
            strategyKey: snapshot.strategyKey,
            bundle: preparedCopy.bundle,
            uiCapitalMatchesEndpoint: matchesEndpointCapitalProfile(snapshot.capitalSettings),
            datasetRef: preparedCopy.datasetRef,
            candleCount: preparedCopy.candleCount,
            datasetUploaded: preparedCopy.datasetUploaded,
            datasetUploadError: preparedCopy.datasetUploadError,
        };
    }

    public async evaluateStrategyOnData(
        ohlcvData: OHLCVData[],
        interval: string,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings = this.getBacktestSettings(),
        capitalSettings: CapitalSettings = this.getCapitalSettings()
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        return this.runBacktestForData(
            ohlcvData,
            interval,
            strategy,
            params,
            settings,
            capitalSettings,
            this.requiresTypescriptEngine(settings) || this.requiresTypescriptSizingMode(capitalSettings.sizingMode)
        );
    }

    public async evaluateSignalsOnData(
        ohlcvData: OHLCVData[],
        interval: string,
        signals: Signal[],
        settings: BacktestSettings = this.getBacktestSettings(),
        capitalSettings: CapitalSettings = this.getCapitalSettings()
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        return this.runBacktestForPreparedSignals(
            ohlcvData,
            interval,
            signals,
            settings,
            capitalSettings,
            this.requiresTypescriptEngine(settings) || this.requiresTypescriptSizingMode(capitalSettings.sizingMode)
        );
    }

    public addStrategyIndicators(params: StrategyParams) {
        chartManager.clearIndicators();
        const indicatorsPanel = getOptionalElement('indicatorsPanel');
        if (indicatorsPanel) indicatorsPanel.innerHTML = '';

        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy) {
            return;
        }

        const indicators = strategy.indicators ? strategy.indicators(state.ohlcvData, params) : [];
        const times = state.ohlcvData.map(d => d.time);

        indicators.forEach(ind => {
            if (Array.isArray(ind.values)) {
                const values = ind.values as (number | null)[];
                const color = ind.color || (ind.type === 'histogram' ? '#ef5350' : '#2962ff');
                this.addIndicatorToChart(ind.name, values, times, color, ind.type);
            }
        });
    }

    private addIndicatorToChart(
        name: string,
        values: (number | null)[],
        times: OHLCVData['time'][],
        color: string,
        type: 'line' | 'band' | 'histogram'
    ) {
        const lineData = values
            .map((v, i) => v !== null ? { time: times[i], value: v } : null)
            .filter(d => d !== null) as { time: OHLCVData['time']; value: number }[];

        if (type === 'histogram') {
            const id = chartManager.addIndicatorHistogram(name, 0, lineData, color);
            uiManager.addIndicatorBadge(id, name, 0, color);
        } else {
            const id = chartManager.addIndicatorLine(name, 0, lineData, color);
            uiManager.addIndicatorBadge(id, name, 0, color);
        }
    }

    /**
     * Run a backtest with custom strategy params and settings.
     * Used by alert handlers to show last trade for a subscription.
     */
    public async runBacktestForSubscription(
        ohlcvData: OHLCVData[],
        interval: string,
        strategyKey: string,
        strategyParams: Record<string, number>,
        backtestSettings: BacktestSettings
    ): Promise<BacktestResult> {
        const effectiveBacktestSettings = resolveSubscriptionExecutionBacktestSettings(backtestSettings);
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            throw new Error(`Strategy not found: ${strategyKey}`);
        }

        const capitalSettings = this.resolveSubscriptionCapitalSettings(effectiveBacktestSettings);
        // Keep Alerts "Last Trade" aligned with Worker evaluation (TypeScript engine path).
        const requiresTsEngine = true;

        // Run the backtest
        const runResult = await this.runBacktestForData(
            ohlcvData,
            interval,
            strategy,
            strategyParams,
            effectiveBacktestSettings,
            capitalSettings,
            requiresTsEngine
        );

        return runResult.result;
    }

    private createEndpointCopySnapshot(
        strategyParams: StrategyParams,
        backtestSettings: BacktestSettings,
        capitalSettings: CapitalSettings,
        engineUsed: 'rust' | 'typescript',
        nowSec: number,
        blockRange: { from: number; to: number } | null,
        annotatePolymarket: boolean
    ): UiBacktestEndpointSnapshot {
        return {
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            strategyKey: state.currentStrategyKey,
            strategyParams: { ...strategyParams },
            backtestSettings: { ...backtestSettings },
            capitalSettings: {
                ...capitalSettings,
                advancedSizing: capitalSettings.advancedSizing ? { ...capitalSettings.advancedSizing } : undefined,
            },
            nowSec,
            blockRange: blockRange ? { ...blockRange } : null,
            annotatePolymarket,
            engineUsed,
            datasetFingerprint: computeBacktestEndpointDatasetFingerprint(state.ohlcvData),
        };
    }
}

export const backtestService = new BacktestService();
