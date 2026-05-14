import { state } from "./state";
import { uiManager } from "./ui-manager";
import { clearActiveBacktestRerunContext, getActiveBacktestRerunContext } from "./backtest-rerun-context";
import { dataManager } from "./data-manager";

import {
    runBacktest,
    StrategyParams,
    BacktestSettings,
    BacktestResult,
    Signal,
    applySignalPolarity,
} from "./strategies/index";
import type { OHLCVData, Strategy } from "./strategies/index";
import { ensureStrategyKeysLoaded, loadBuiltInStrategyByKey, strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { rustEngine } from "./rust-engine-client";
import { shouldUseRustEngine } from "./engine-preferences";

import {
    calculateAdvancedPerformanceAnalyticsFromEquityCurve,
    calculateSharpeRatioFromEquityCurve,
    calculateSharpeRatioFromReturns,
} from "./strategies/performance-metrics";
import { sanitizeBacktestSettingsForRust, requiresTypescriptEngine as requiresTsEngine } from "./rust-settings-sanitizer";
import { sliceOhlcvByBlock } from "./block-selector";
import {
    selectExecutionAwareClosedCandles,
} from "./alert-evaluation-window";
import {
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw
} from "./backtest-settings-resolver";
import { settingsManager, type StrategyConfig } from "./settings-manager";
import { mergeStrategySignals } from "./signal-merge";
import { resolveSubscriptionExecutionBacktestSettings } from "./alert-subscription-utils";
import { isSmartTradeSizingMode, type CapitalSettings, type TradeSizingMode } from "./types/backtest";
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
import { applyPolymarketAlternativeSizing } from "./polymarket-alternative-sizing";
import { resolveEffectivePolymarketExitMode } from "./polymarket-exit-mode";
import { resolvePolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import { executeBacktest, executeBacktestFromSignals } from "./backtest-executor";
import {
    getCapitalSettings as readCapitalSettings,
    getAlternativeSizingEnabled as readAlternativeSizingEnabled,
    getBacktestSettings as readBacktestSettings,
    resolveSubscriptionCapitalSettings as resolveSubCapitalSettings,
} from "./backtest-settings-reader";
import {
    createEndpointCopySnapshot,
    canCopyLatestUiBacktestEndpointRequest as canCopyEndpoint,
    canRunLatestUiBacktestEndpointPreview as canPreviewEndpoint,
    runLatestUiBacktestEndpointPreview as runEndpointPreview,
    buildLatestUiBacktestEndpointCopyBundle as buildEndpointBundle,
} from "./backtest-endpoint-facade";
import { addStrategyIndicators as renderStrategyIndicators } from "./backtest-chart-renderer";
import { filterSignalsByBlockRange as filterSignalsBySelectedBlockRange } from "./signal-block-filter";
import { markAppTiming, getMark } from "./app-timing";
import {
    registerBacktestEdgeAnalysisInput,
    transferBacktestEdgeAnalysisInput,
} from "./backtest-edge-analysis";
import { attachTradeTimingQuality } from "./trade-timing-quality";
import {
    annotateBacktestResultWithSecondMarketClob,
    isSecondMarketPolymarketSupported,
} from "./second-market/evaluation";

type CurrentBacktestExecution = {
    result: BacktestResult;
    engineUsed: 'rust' | 'typescript';
    requestContext: {
        nowSec: number;
        blockRange: { from: number; to: number } | null;
    };
};

type RunCurrentBacktestOptions = {
    dataOverride?: OHLCVData[];
    reason?: string;
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

    public async runCurrentBacktest(options: RunCurrentBacktestOptions = {}) {
        const runId = this.beginInteractiveRun();
        const activePreviewRerun = !options.dataOverride && state.currentBacktestResultSource === 'ensemble_preview'
            ? getActiveBacktestRerunContext()
            : null;
        if (activePreviewRerun?.source === 'ensemble_preview') {
            await activePreviewRerun.rerun();
            return;
        }

        clearActiveBacktestRerunContext();
        const startedAt = Date.now();
        if (getMark("firstBacktestStart") === undefined) {
            markAppTiming("firstBacktestStart");
        }
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
            const alternativeSizingEnabled = this.getAlternativeSizingEnabled();
            const settings = this.getBacktestSettings();
            const sourceData = options.dataOverride ?? state.ohlcvData;
            const requiresTsEngine = this.requiresTypescriptEngine(settings) || this.requiresTypescriptSizingMode(capitalSettings.sizingMode);
            await updateDomBacktestRunProgress(runUi, '40%', 'Generating signals...', 100);

            let { result, engineUsed, requestContext } = await this.executeBacktest(
                runUi,
                strategy,
                params,
                settings,
                capitalSettings,
                requiresTsEngine,
                sourceData
            );

            // Only annotate Polymarket outcomes when explicitly enabled
            const annotatePolymarket = settings.polymarketAnnotationEnabled ?? false;
            if (annotatePolymarket) {
                const annotatedResult = await this.annotatePolymarketResult(result, settings, sourceData);
                const sizedResult = applyPolymarketAlternativeSizing({
                    result: annotatedResult,
                    chartData: this.selectClosedCandleData(
                        sourceData,
                        state.currentInterval,
                        settings,
                        requestContext.nowSec,
                        requestContext.blockRange
                    ),
                    backtestSettings: settings,
                    capitalSettings,
                    alternativeSizingEnabled,
                });
                transferBacktestEdgeAnalysisInput(result, sizedResult);
                result = sizedResult;
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
                reason: options.reason ?? 'manual_backtest',
                endpointCopySnapshot: this.createEndpointCopySnapshot(
                    params,
                    settings,
                    capitalSettings,
                    engineUsed,
                    requestContext.nowSec,
                    requestContext.blockRange,
                    annotatePolymarket,
                    sourceData
                ),
                endpointCopyCandles: sourceData,
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
            if (getMark("firstBacktestEnd") === undefined) {
                markAppTiming("firstBacktestEnd");
            }
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
        requiresTsEngine: boolean,
        ohlcvData: OHLCVData[] = state.ohlcvData
    ): Promise<CurrentBacktestExecution> {
        await updateDomBacktestRunProgress(runUi, '60%', 'Running backtest...', 100);
        const singleRun = await this.runBacktestForData(
            ohlcvData,
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
            await ensureStrategyKeysLoaded([primaryConfig.strategyKey, secondaryConfig.strategyKey]);

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
            if (primaryStrategy.crossSymbolConfig) {
                runUi.setStatus(`"${primaryStrategy.name}" is a cross-symbol strategy and is not supported in combined backtest.`);
                return;
            }
            if (primaryStrategy.polymarket1sConfig) {
                runUi.setStatus(`"${primaryStrategy.name}" uses 1s Polymarket context and is not supported in combined backtest.`);
                return;
            }
            if (secondaryStrategy.crossSymbolConfig) {
                runUi.setStatus(`"${secondaryStrategy.name}" is a cross-symbol strategy and is not supported in combined backtest.`);
                return;
            }
            if (secondaryStrategy.polymarket1sConfig) {
                runUi.setStatus(`"${secondaryStrategy.name}" uses 1s Polymarket context and is not supported in combined backtest.`);
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
            primarySymbol: state.currentSymbol,
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
            dataFetcher: dataManager,
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
        return filterSignalsBySelectedBlockRange(signals, state.blockRange);
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
        attachTradeTimingQuality(result, backtestData);
        registerBacktestEdgeAnalysisInput(result, backtestData);
    }

    private async annotatePolymarketResult(
        result: BacktestResult,
        settings: BacktestSettings,
        chartData: OHLCVData[]
    ): Promise<BacktestResult> {
        try {
            const effectiveExitMode = resolveEffectivePolymarketExitMode({
                requestedMode: settings.polymarketExitMode,
                interval: state.currentInterval,
                executionModel: settings.executionModel,
                polymarketAnnotationEnabled: settings.polymarketAnnotationEnabled,
            });
            const outcomeInterval = resolvePolymarketOutcomeInterval(settings.polymarketOutcomeInterval);
            if (isSecondMarketPolymarketSupported(state.currentSymbol, state.currentInterval)) {
                return await annotateBacktestResultWithSecondMarketClob({
                    result,
                    symbol: state.currentSymbol,
                    interval: state.currentInterval,
                    outcomeSymbol: settings.polymarketOutcomeSymbol,
                    outcomeInterval,
                    executionModel: settings.executionModel,
                    polymarketExitMode: effectiveExitMode,
                    polymarketSignalExitAllowMultipleTradesPerEvent: settings.polymarketSignalExitAllowMultipleTradesPerEvent,
                    entryPriceFilterCents: settings.polymarketEntryPriceFilterCents,
                });
            }

            return await annotateBacktestResultWithPolymarketOutcomes(result, {
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                executionModel: settings.executionModel,
                chartData,
                outcomeSymbol: settings.polymarketOutcomeSymbol,
                outcomeInterval,
                polymarketExitMode: effectiveExitMode,
                polymarketSignalExitAllowMultipleTradesPerEvent: settings.polymarketSignalExitAllowMultipleTradesPerEvent,
            }, {
                selectedOffset: settings.polymarketEntryOffset,
                entrySelectionMode: settings.polymarketEntrySelectionMode,
                entryPriceFilterCents: settings.polymarketEntryPriceFilterCents,
                limitEntry: {
                    enabled: settings.polymarketPostSignalLimitEntryEnabled === true,
                    priceMode: settings.polymarketPostSignalLimitEntryMode,
                    priceCents: settings.polymarketPostSignalLimitEntryPriceCents ?? 50,
                    offsetCents: settings.polymarketPostSignalLimitEntryOffsetCents,
                    exitEnabled: settings.polymarketPostSignalLimitExitEnabled === true,
                    exitMode: settings.polymarketPostSignalLimitExitMode,
                    exitPriceCents: settings.polymarketPostSignalLimitExitPriceCents,
                    exitOffsetCents: settings.polymarketPostSignalLimitExitOffsetCents,
                },
            });
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
        settings: BacktestSettings,
        nowSec = Math.floor(Date.now() / 1000),
        blockRange = state.blockRange
    ): OHLCVData[] {
        const executionAware = selectExecutionAwareClosedCandles(
            ohlcvData,
            interval,
            settings,
            {
                nowSec,
                minClosedCandles: 1,
                fallbackToTrimmedClosed: true,
            }
        );
        if (executionAware) {
            return sliceOhlcvByBlock(executionAware, blockRange);
        }
        return sliceOhlcvByBlock(ohlcvData, blockRange);
    }

    public getCapitalSettings(): CapitalSettings {
        return readCapitalSettings();
    }

    private getAlternativeSizingEnabled(): boolean {
        return readAlternativeSizingEnabled();
    }

    public getBacktestSettings(): BacktestSettings {
        return readBacktestSettings();
    }

    private requiresTypescriptSizingMode(sizingMode: TradeSizingMode): boolean {
        return isSmartTradeSizingMode(sizingMode);
    }

    private resolveSubscriptionCapitalSettings(backtestSettings: BacktestSettings): CapitalSettings {
        return resolveSubCapitalSettings(backtestSettings);
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

    public canCopyLatestUiBacktestEndpointRequest(): boolean {
        return canCopyEndpoint();
    }

    public canRunLatestUiBacktestEndpointPreview(): boolean {
        return canPreviewEndpoint();
    }

    public async runLatestUiBacktestEndpointPreview() {
        return runEndpointPreview();
    }

    public async buildLatestUiBacktestEndpointCopyBundle(baseUrl: string) {
        return buildEndpointBundle(baseUrl);
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
        renderStrategyIndicators(params);
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
        const strategy = strategyRegistry.get(strategyKey) ?? await loadBuiltInStrategyByKey(strategyKey);
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
        annotatePolymarket: boolean,
        datasetForFingerprint?: OHLCVData[]
    ) {
        return createEndpointCopySnapshot(strategyParams, backtestSettings, capitalSettings, engineUsed, nowSec, blockRange, annotatePolymarket, datasetForFingerprint);
    }
}

export const backtestService = new BacktestService();
