import { state } from "./state";
import { uiManager } from "./ui-manager";
import { chartManager } from "./chart-manager";
import { dataManager } from "./data-manager";

import {
    runBacktest,
    StrategyParams,
    BacktestSettings,
    buildEntryBacktestResult,
    BacktestResult,
    PostEntryPathStats,
    Signal,
    applySignalPolarity,
} from "./strategies/index";
import type { OHLCVData, Strategy } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { rustEngine } from "./rust-engine-client";
import { shouldUseRustEngine } from "./engine-preferences";

import { calculateSharpeRatioFromEquityCurve, calculateSharpeRatioFromReturns } from "./strategies/performance-metrics";
import { computeEdgeStatistics } from "./strategies/backtest/edge-statistics";
import { getIntervalSeconds } from "./dataProviders/utils";
import { getOptionalElement } from "./dom-utils";
import { sanitizeBacktestSettingsForRust, requiresTypescriptEngine as requiresTsEngine } from "./rust-settings-sanitizer";
import { trimToClosedCandles } from "./closed-candle-utils";
import { sliceOhlcvByBlock } from "./block-selector";
import {
    buildExecutionAwareCandleWindow,
    selectClosedCandleWindow,
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
import { isSmartTradeSizingMode, isTradeSizingMode, type TradeSizingMode } from "./types/backtest";
import { createDomBacktestRunHandle, type BacktestRunHandle } from "./backtest-run-presenter";
import { commitBacktestResult, commitParityBacktestResults } from "./state-actions";

import { resolveTwoHourParityFromTime } from "./two-hour-parity";
import { buildPostEntryPathStats as analyzeBacktestResult } from "./backtest-result-analysis";

const SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS = Object.freeze({
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: 'percent' as const,
    fixedTradeAmount: 0,
});

type BacktestCapitalSettings = {
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: TradeSizingMode;
    fixedTradeAmount: number;
};

type CurrentBacktestExecution = {
    result: BacktestResult;
    engineUsed: 'rust' | 'typescript';
    parityComparison: { odd: BacktestResult; even: BacktestResult; baseline: 'odd' | 'even' } | null;
};

export class BacktestService {
    private warnedStrictEngine = false;

    public async runCurrentBacktest() {
        const startedAt = Date.now();
        debugLogger.event('backtest.start', {
            strategy: state.currentStrategyKey,
            candles: state.ohlcvData.length,
        });
        const runUi = this.beginBacktestRun('runBacktest', 'Running backtest...', true);
        let shouldDelayHide = false;

        try {
            await this.updateBacktestProgress(runUi, '20%', 'Calculating indicators...', 100);

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
            const parityMode = this.getTwoHourCloseParityMode();

            await this.updateBacktestProgress(
                runUi,
                '40%',
                parityMode === 'both' ? 'Preparing parity runs...' : 'Generating signals...',
                100
            );

            const { result, engineUsed, parityComparison } = await this.executeBacktestForParityMode(
                runUi,
                strategy,
                params,
                settings,
                capitalSettings,
                requiresTsEngine,
                parityMode
            );

            commitBacktestResult(result, 'backtest', {
                parityResults: parityComparison,
                reason: 'manual_backtest',
            });

            await this.updateBacktestProgress(runUi, '100%', 'Complete!');
            if (parityComparison && !result.entryStats) {
                runUi.setStatus(`2H compare | Odd ${parityComparison.odd.netProfitPercent.toFixed(2)}% | Even ${parityComparison.even.netProfitPercent.toFixed(2)}%`);
            } else if (result.entryStats) {
                const entryWin = result.entryStats.winRate.toFixed(1);
                const useTarget = result.entryStats.winDefinition === 'target' && (result.entryStats.targetPct ?? 0) > 0;
                const avgBars = useTarget
                    ? (result.entryStats.avgTargetBars ?? result.entryStats.avgRetestBars)
                    : result.entryStats.avgRetestBars;
                const label = useTarget ? 'Avg Target' : 'Avg Retest';
                runUi.setStatus(`${result.entryStats.totalEntries} entries | Win ${entryWin}% | ${label} ${avgBars.toFixed(1)} bars`);
            } else {
                const expectancyText = `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`;
                const pfText = result.profitFactor === Infinity ? 'Inf' : result.profitFactor.toFixed(2);
                const engineBadge = engineUsed === 'rust' ? ' [rust]' : '';
                runUi.setStatus(`${result.totalTrades} trades | Exp ${expectancyText} | PF ${pfText}${engineBadge}`);
            }
            shouldDelayHide = true;
            debugLogger.event('backtest.success', {
                strategy: state.currentStrategyKey,
                trades: result.totalTrades,
                durationMs: Date.now() - startedAt,
                engine: engineUsed,
                parityMode,
            });
            // Enable replay button if there are results
            const replayStartBtn = getOptionalElement<HTMLButtonElement>('replayStartBtn');
            if (replayStartBtn) {
                replayStartBtn.disabled = result.totalTrades === 0;
            }
        } catch (error) {
            debugLogger.error('backtest.error', {
                strategy: state.currentStrategyKey,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                durationMs: Date.now() - startedAt,
            });
            // Disable replay button on error
            const replayStartBtn = getOptionalElement<HTMLButtonElement>('replayStartBtn');
            if (replayStartBtn) {
                replayStartBtn.disabled = true;
            }

            throw error;
        } finally {
            if (shouldDelayHide) {
                await this.sleep(500);
            }
            runUi.finish();
        }
    }

    private getTwoHourCloseParityMode(): 'odd' | 'even' | 'both' {
        if (getIntervalSeconds(state.currentInterval) !== 7200) {
            return 'odd';
        }
        if (state.twoHourCloseParity === 'even' || state.twoHourCloseParity === 'both') {
            return state.twoHourCloseParity;
        }
        return 'odd';
    }

    private inferBaselineParity(data: OHLCVData[]): 'odd' | 'even' {
        if (getIntervalSeconds(state.currentInterval) !== 7200 || data.length === 0) {
            return 'odd';
        }
        return resolveTwoHourParityFromTime(data[0].time) ?? 'odd';
    }

    private async withTemporaryTwoHourParity<T>(parity: 'odd' | 'even', run: () => Promise<T>): Promise<T> {
        const previous = state.twoHourCloseParity;
        if (previous === parity) return run();

        state.set('twoHourCloseParity', parity);
        try {
            return await run();
        } finally {
            state.set('twoHourCloseParity', previous);
        }
    }

    private async executeBacktestForParityMode(
        runUi: BacktestRunHandle,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings,
        capitalSettings: BacktestCapitalSettings,
        requiresTsEngine: boolean,
        parityMode: 'odd' | 'even' | 'both'
    ): Promise<CurrentBacktestExecution> {
        commitParityBacktestResults(null, 'backtest_run_start');
        const baseData = state.ohlcvData;

        if (parityMode === 'both') {
            return this.executeParityComparison(
                runUi,
                baseData,
                strategy,
                params,
                settings,
                capitalSettings,
                requiresTsEngine
            );
        }

        await this.updateBacktestProgress(runUi, '60%', 'Running backtest...', 100);
        const singleRun = await this.withTemporaryTwoHourParity(parityMode, async () => this.runBacktestForData(
            baseData,
            state.currentInterval,
            strategy,
            params,
            settings,
            capitalSettings.initialCapital,
            capitalSettings.positionSize,
            capitalSettings.commission,
            capitalSettings.sizingMode,
            capitalSettings.fixedTradeAmount,
            requiresTsEngine
        ));

        return {
            result: singleRun.result,
            engineUsed: singleRun.engineUsed,
            parityComparison: null,
        };
    }

    private async executeParityComparison(
        runUi: BacktestRunHandle,
        baseData: OHLCVData[],
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings,
        capitalSettings: BacktestCapitalSettings,
        requiresTsEngine: boolean
    ): Promise<CurrentBacktestExecution> {
        const baselineParity = this.inferBaselineParity(baseData);
        const oddData = await this.getBacktestDataForParity('odd', baseData);
        const evenData = await this.getBacktestDataForParity('even', baseData);

        await this.updateBacktestProgress(runUi, '65%', 'Running odd + even backtests...', 80);

        const oddRun = await this.withTemporaryTwoHourParity('odd', async () => this.runBacktestForData(
            oddData,
            state.currentInterval,
            strategy,
            params,
            settings,
            capitalSettings.initialCapital,
            capitalSettings.positionSize,
            capitalSettings.commission,
            capitalSettings.sizingMode,
            capitalSettings.fixedTradeAmount,
            requiresTsEngine
        ));
        const evenRun = await this.withTemporaryTwoHourParity('even', async () => this.runBacktestForData(
            evenData,
            state.currentInterval,
            strategy,
            params,
            settings,
            capitalSettings.initialCapital,
            capitalSettings.positionSize,
            capitalSettings.commission,
            capitalSettings.sizingMode,
            capitalSettings.fixedTradeAmount,
            requiresTsEngine
        ));

        const parityComparison = { odd: oddRun.result, even: evenRun.result, baseline: baselineParity };

        debugLogger.event('backtest.parity_compare', {
            strategy: state.currentStrategyKey,
            oddTrades: oddRun.result.totalTrades,
            evenTrades: evenRun.result.totalTrades,
            baseline: baselineParity,
        });

        const baselineRun = baselineParity === 'even' ? evenRun : oddRun;
        return {
            result: baselineRun.result,
            engineUsed: baselineRun.engineUsed,
            parityComparison,
        };
    }

    private async getBacktestDataForParity(parity: 'odd' | 'even', baseData?: OHLCVData[]): Promise<OHLCVData[]> {
        if (getIntervalSeconds(state.currentInterval) !== 7200) {
            return baseData ?? state.ohlcvData;
        }
        return this.withTemporaryTwoHourParity(parity, async () => {
            try {
                const fetched = await dataManager.fetchData(state.currentSymbol, state.currentInterval);
                // Return full fetched data; normalization/slicing is applied in runBacktestForData.
                return fetched.length > 0 ? fetched : state.ohlcvData;
            } catch (error) {
                debugLogger.warn('[Backtest] Failed to fetch parity data, falling back to current chart candles', {
                    parity,
                    symbol: state.currentSymbol,
                    interval: state.currentInterval,
                    error: error instanceof Error ? error.message : String(error),
                });
                return baseData ?? state.ohlcvData;
            }
        });
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
        const startedAt = Date.now();
        debugLogger.event('backtest.combined.start', {
            primary: primaryConfig.strategyKey,
            secondary: secondaryConfig.strategyKey,
            mode,
        });

        const runUi = this.beginBacktestRun('runCombinedStrategyBtn', 'Running combined backtest...');

        try {
            // --- 1. Resolve both strategies from registry ---
            await this.updateBacktestProgress(runUi, '10%', 'Resolving strategies...', 50);

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
            await this.updateBacktestProgress(runUi, '20%', 'Preparing data...', 50);

            const primarySettings = resolveBacktestSettingsFromRaw(
                primaryConfig.backtestSettings as unknown as BacktestSettings,
                { captureSnapshots: true, coerceWithoutUiToggles: true }
            );
            const secondarySettings = resolveBacktestSettingsFromRaw(
                secondaryConfig.backtestSettings as unknown as BacktestSettings,
                { captureSnapshots: false, coerceWithoutUiToggles: true }
            );
            const backtestData = this.selectClosedCandleData(
                state.ohlcvData,
                state.currentInterval,
                primarySettings
            );

            // --- 3. Execute both strategies ---
            await this.updateBacktestProgress(runUi, '40%', 'Generating signals from both strategies...', 50);

            const primarySignals = applySignalPolarity(
                primaryStrategy.execute(backtestData, primaryConfig.strategyParams),
                primarySettings
            );
            const secondarySignals = applySignalPolarity(
                secondaryStrategy.execute(backtestData, secondaryConfig.strategyParams),
                secondarySettings
            );

            // --- 4. Merge signals ---
            await this.updateBacktestProgress(runUi, '60%', `Merging signals (${mode.toUpperCase()})...`, 50);

            const mergedSignals = this.mergeSignals(primarySignals, secondarySignals, mode);

            // --- 5. Run backtest using primary config's settings + capital ---
            await this.updateBacktestProgress(runUi, '80%', 'Running backtest on merged signals...', 50);

            const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } =
                settingsManager.resolveCapitalFromConfig(primaryConfig);
            const requiresTsEngine =
                this.requiresTypescriptEngine(primarySettings) || this.requiresTypescriptSizingMode(sizingMode);
            const { result, filteredSignalsCount } = await this.runBacktestForPreparedData(
                backtestData,
                mergedSignals,
                primarySettings,
                initialCapital,
                positionSize,
                commission,
                sizingMode,
                fixedTradeAmount,
                requiresTsEngine
            );

            // --- 6. Update state and UI ---
            commitBacktestResult(result, 'backtest', {
                parityResults: null,
                reason: 'combined_strategy_backtest',
            });

            await this.updateBacktestProgress(runUi, '100%', 'Complete!');
            const expectancyText = `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`;
            const pfText = result.profitFactor === Infinity ? 'Inf' : result.profitFactor.toFixed(2);
            runUi.setStatus(`Combined (${mode.toUpperCase()}) | ${result.totalTrades} trades | Exp ${expectancyText} | PF ${pfText}`);

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

            await this.sleep(500);
        } catch (error) {
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

    /** Delegates to the standalone mergeStrategySignals utility. */
    private mergeSignals(
        primarySignals: Signal[],
        secondarySignals: Signal[],
        mode: 'and' | 'or'
    ): Signal[] {
        return mergeStrategySignals(primarySignals, secondarySignals, mode);
    }

    private beginBacktestRun(buttonId: string, initialStatus: string, manageAriaBusy = false): BacktestRunHandle {
        return createDomBacktestRunHandle(buttonId, initialStatus, manageAriaBusy);
    }

    private async updateBacktestProgress(
        runUi: BacktestRunHandle,
        width: string,
        text: string,
        delayMs = 0
    ): Promise<void> {
        runUi.setProgress(width, text);
        if (delayMs > 0) {
            await this.sleep(delayMs);
        }
    }


    private async runBacktestForData(
        ohlcvData: OHLCVData[],
        interval: string,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings,
        initialCapital: number,
        positionSize: number,
        commission: number,
        sizingMode: TradeSizingMode,
        fixedTradeAmount: number,
        requiresTsEngine: boolean
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        // Stage-level timing instrumentation
        const timing = {
            selectClosedCandleData: 0,
            strategyExecute: 0,
            rustRequest: 0,
            tsBacktest: 0,
            postProcessing: 0,
            total: 0,
        };
        const runStart = performance.now();

        const t1 = performance.now();
        const backtestData = this.selectClosedCandleData(ohlcvData, interval, settings);
        timing.selectClosedCandleData = performance.now() - t1;
        const t2 = performance.now();
        const signals = applySignalPolarity(strategy.execute(backtestData, params), settings);
        timing.strategyExecute = performance.now() - t2;

        const filteredSignals = signals;

        // Block range signal filter (defensive): selectClosedCandleData already slices data.
        // Keep this to guard against any non-sliced signals when data sources change.
        const blockFilteredSignals = this.filterSignalsByBlockRange(filteredSignals);

        let result: BacktestResult | undefined;
        let engineUsed: 'rust' | 'typescript' = 'typescript';

        const evaluation = strategy.evaluate?.(backtestData, params, blockFilteredSignals);
        const entryStats = evaluation?.entryStats;

        if (strategy.metadata?.role === 'entry' && entryStats) {
            result = buildEntryBacktestResult(entryStats);
            engineUsed = 'typescript';
        }

        if (!result && shouldUseRustEngine() && !requiresTsEngine) {
            const tRust = performance.now();
            const rustResult = await rustEngine.runBacktest(
                backtestData,
                blockFilteredSignals,
                initialCapital,
                positionSize,
                commission,
                this.buildRustCompatibleSettings(settings),
                { mode: sizingMode, fixedTradeAmount }
            );
            timing.rustRequest = performance.now() - tRust;

            if (rustResult) {
                if (this.isResultConsistent(rustResult)) {
                    result = rustResult;
                    engineUsed = 'rust';
                    debugLogger.event('backtest.rust_used', { bars: backtestData.length });
                } else {
                    debugLogger.warn('[Backtest] Rust result failed consistency checks, falling back to TypeScript');
                    uiManager.showToast('Rust backtest result inconsistent, rerunning in TypeScript', 'info');
                }
            }
        }

        if (!result) {
            const tTs = performance.now();
            if (requiresTsEngine && shouldUseRustEngine() && !this.warnedStrictEngine) {
                this.warnedStrictEngine = true;
                uiManager.showToast('Current sizing or realism settings require TypeScript engine (Rust skipped).', 'info');
            }
            result = runBacktest(
                backtestData,
                blockFilteredSignals,
                initialCapital,
                positionSize,
                commission,
                settings,
                { mode: sizingMode, fixedTradeAmount }
            );
            engineUsed = 'typescript';
            timing.tsBacktest = performance.now() - tTs;
        }

        const tPost = performance.now();
        this.finalizeBacktestResult(result, initialCapital, backtestData);
        timing.postProcessing = performance.now() - tPost;

        timing.total = performance.now() - runStart;

        // Emit structured timing breakdown event
        debugLogger.event('backtest.timing_breakdown', {
            engineUsed,
            bars: backtestData.length,
            signalsCount: signals.length,
            filteredSignalsCount: filteredSignals.length,
            durations: {
                selectClosedCandleData: timing.selectClosedCandleData,
                strategyExecute: timing.strategyExecute,

                rustRequest: timing.rustRequest,
                tsBacktest: timing.tsBacktest,
                postProcessing: timing.postProcessing,
                total: timing.total,
            },
        });

        return { result, engineUsed };
    }

    private async runBacktestForPreparedSignals(
        ohlcvData: OHLCVData[],
        interval: string,
        signals: Signal[],
        settings: BacktestSettings,
        initialCapital: number,
        positionSize: number,
        commission: number,
        sizingMode: TradeSizingMode,
        fixedTradeAmount: number,
        requiresTsEngine: boolean
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        const backtestData = this.selectClosedCandleData(ohlcvData, interval, settings);
        const { result, engineUsed } = await this.runBacktestForPreparedData(
            backtestData,
            signals,
            settings,
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
            requiresTsEngine
        );
        return { result, engineUsed };
    }

    private async runBacktestForPreparedData(
        backtestData: OHLCVData[],
        signals: Signal[],
        settings: BacktestSettings,
        initialCapital: number,
        positionSize: number,
        commission: number,
        sizingMode: TradeSizingMode,
        fixedTradeAmount: number,
        requiresTsEngine: boolean
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript'; filteredSignalsCount: number }> {
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
                this.buildRustCompatibleSettings(settings),
                { mode: sizingMode, fixedTradeAmount }
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
                { mode: sizingMode, fixedTradeAmount }
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
        if (!result.entryStats) {
            result.sharpeRatio = this.recomputeSharpeRatio(result, initialCapital);
        }
        result.postEntryPath = this.buildPostEntryPathStats(result, 5, backtestData);
        if (result.trades.length >= 3) {
            result.edgeStatistics = computeEdgeStatistics(result, backtestData);
        }
    }

    private selectClosedCandleData(
        ohlcvData: OHLCVData[],
        interval: string,
        settings: BacktestSettings
    ): OHLCVData[] {
        const closedWindow = selectClosedCandleWindow(
            ohlcvData,
            interval,
            Math.floor(Date.now() / 1000),
            1
        );

        if (closedWindow) {
            const executionAware = buildExecutionAwareCandleWindow(
                closedWindow.candles,
                closedWindow.nextOpenCandle,
                settings
            );
            return sliceOhlcvByBlock(executionAware, state.blockRange);
        }

        const closed = trimToClosedCandles(ohlcvData, interval);
        const executionAware = buildExecutionAwareCandleWindow(closed, null, settings);
        return sliceOhlcvByBlock(executionAware, state.blockRange);
    }

    private buildRustCompatibleSettings(settings: BacktestSettings): BacktestSettings {
        return sanitizeBacktestSettingsForRust(settings);
    }
    public getCapitalSettings(): BacktestCapitalSettings {
        const initialCapital = Math.max(0, this.readNumberInput('initialCapital', CAPITAL_DEFAULTS.initialCapital));
        const positionSize = Math.max(0, this.readNumberInput('positionSize', CAPITAL_DEFAULTS.positionSize));
        const commission = Math.max(0, this.readNumberInput('commission', CAPITAL_DEFAULTS.commission));
        const fixedTradeAmount = Math.max(0, this.readNumberInput('fixedTradeAmount', CAPITAL_DEFAULTS.fixedTradeAmount));
        const fixedTradeToggle = getOptionalElement<HTMLInputElement>('fixedTradeToggle');
        const tradeSizingMode = getOptionalElement<HTMLSelectElement>('tradeSizingMode');
        const sizingMode: TradeSizingMode = fixedTradeToggle?.checked
            ? (this.readSizingMode(tradeSizingMode?.value) ?? 'fixed')
            : 'percent';
        return { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount };
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
            captureSnapshots: true,
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

    private readNumberInput(id: string, fallback: number): number {
        return readNumberInputValue(id, fallback);
    }

    private readFiniteNumber(value: unknown): number | null {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }

    private readBooleanLike(value: unknown): boolean | null {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
            if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
        }
        return null;
    }

    private readSizingMode(value: unknown): TradeSizingMode | null {
        if (value === 'smart_fixed') return 'smart_fixed_velocity_memory';
        if (
            value === 'smart_fixed_early_heat_filter'
            || value === 'smart_fixed_adverse_memory'
            || value === 'smart_fixed_mfe_ancestor'
            || value === 'smart_fixed_tp_distance_fit'
        ) {
            return 'smart_fixed_quality_x_velocity';
        }
        return isTradeSizingMode(value) ? value : null;
    }

    private requiresTypescriptSizingMode(sizingMode: TradeSizingMode): boolean {
        return isSmartTradeSizingMode(sizingMode);
    }

    private resolveSubscriptionCapitalSettings(backtestSettings: BacktestSettings): {
        initialCapital: number;
        positionSize: number;
        commission: number;
        sizingMode: TradeSizingMode;
        fixedTradeAmount: number;
    } {
        const raw = backtestSettings as Record<string, unknown>;

        const initialCapital = Math.max(
            0,
            this.readFiniteNumber(raw.initialCapital) ?? SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS.initialCapital
        );
        const positionSize = Math.max(
            0,
            this.readFiniteNumber(raw.positionSize) ?? SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS.positionSize
        );
        const commission = Math.max(
            0,
            this.readFiniteNumber(raw.commission) ?? SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS.commission
        );
        const fixedTradeAmount = Math.max(
            0,
            this.readFiniteNumber(raw.fixedTradeAmount) ?? SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS.fixedTradeAmount
        );

        const explicitSizingMode = this.readSizingMode(raw.sizingMode);
        const fixedTradeToggle = this.readBooleanLike(raw.fixedTradeToggle);
        const sizingMode: TradeSizingMode = explicitSizingMode
            ?? (fixedTradeToggle === true ? 'fixed' : SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS.sizingMode);

        return { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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

    private buildPostEntryPathStats(result: BacktestResult, horizonMaxBars: number, ohlcvData: OHLCVData[]): PostEntryPathStats {
        return analyzeBacktestResult(result, horizonMaxBars, ohlcvData);
    }


    public requiresTypescriptEngine(settings: BacktestSettings): boolean {
        // Use shared helper for single-source-of-truth Rust eligibility
        return requiresTsEngine(settings);
    }

    public async evaluateStrategyOnData(
        ohlcvData: OHLCVData[],
        interval: string,
        strategy: Strategy,
        params: StrategyParams,
        settings: BacktestSettings = this.getBacktestSettings(),
        capitalSettings: {
            initialCapital: number;
            positionSize: number;
            commission: number;
            sizingMode: TradeSizingMode;
            fixedTradeAmount: number;
        } = this.getCapitalSettings()
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        const {
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
        } = capitalSettings;

        return this.runBacktestForData(
            ohlcvData,
            interval,
            strategy,
            params,
            settings,
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
            this.requiresTypescriptEngine(settings) || this.requiresTypescriptSizingMode(sizingMode)
        );
    }

    public async evaluateSignalsOnData(
        ohlcvData: OHLCVData[],
        interval: string,
        signals: Signal[],
        settings: BacktestSettings = this.getBacktestSettings(),
        capitalSettings: {
            initialCapital: number;
            positionSize: number;
            commission: number;
            sizingMode: TradeSizingMode;
            fixedTradeAmount: number;
        } = this.getCapitalSettings()
    ): Promise<{ result: BacktestResult; engineUsed: 'rust' | 'typescript' }> {
        const {
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
        } = capitalSettings;

        return this.runBacktestForPreparedSignals(
            ohlcvData,
            interval,
            signals,
            settings,
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
            this.requiresTypescriptEngine(settings) || this.requiresTypescriptSizingMode(sizingMode)
        );
    }

    public addStrategyIndicators(params: StrategyParams) {
        chartManager.clearIndicators();
        const indicatorsPanel = getOptionalElement('indicatorsPanel');
        if (indicatorsPanel) indicatorsPanel.innerHTML = '';

        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy) {
            uiManager.updateEntryPreview(null);
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

        const preview = strategy.entryPreview ? strategy.entryPreview(state.ohlcvData, params) : null;
        uiManager.updateEntryPreview(preview);
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

        const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } =
            this.resolveSubscriptionCapitalSettings(effectiveBacktestSettings);
        // Keep Alerts "Last Trade" aligned with Worker evaluation (TypeScript engine path).
        const requiresTsEngine = true;

        // Run the backtest
        const runResult = await this.runBacktestForData(
            ohlcvData,
            interval,
            strategy,
            strategyParams,
            effectiveBacktestSettings,
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
            requiresTsEngine
        );

        return runResult.result;
    }
}

export const backtestService = new BacktestService();

