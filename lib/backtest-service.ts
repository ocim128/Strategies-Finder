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
    applySignalPolarity,
} from "./strategies/index";
import type { OHLCVData, Strategy } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { rustEngine } from "./rust-engine-client";
import { shouldUseRustEngine } from "./engine-preferences";

import { calculateSharpeRatioFromReturns } from "./strategies/performance-metrics";
import { computeEdgeStatistics } from "./strategies/backtest/edge-statistics";
import { getIntervalSeconds } from "./dataProviders/utils";
import { getOptionalElement, getRequiredElement } from "./dom-utils";
import { sanitizeBacktestSettingsForRust, requiresTypescriptEngine as requiresTsEngine } from "./rust-settings-sanitizer";
import { trimToClosedCandles } from "./closed-candle-utils";
import { sliceOhlcvByBlock } from "./block-selector";
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

import { resolveTwoHourParityFromTime } from "./two-hour-parity";
import { buildPostEntryPathStats as analyzeBacktestResult } from "./backtest-result-analysis";

const SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS = Object.freeze({
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: 'percent' as const,
    fixedTradeAmount: 0,
});

export class BacktestService {
    private warnedStrictEngine = false;

    public async runCurrentBacktest() {
        const startedAt = Date.now();
        debugLogger.event('backtest.start', {
            strategy: state.currentStrategyKey,
            candles: state.ohlcvData.length,
        });
        const progressContainer = getRequiredElement('progressContainer');
        const progressFill = getRequiredElement('progressFill');
        const progressText = getRequiredElement('progressText');
        const statusEl = getRequiredElement('strategyStatus');
        const runButton = getOptionalElement<HTMLButtonElement>('runBacktest');

        const setLoading = (loading: boolean) => {
            if (!runButton) return;
            runButton.disabled = loading;
            runButton.classList.toggle('is-loading', loading);
            runButton.setAttribute('aria-busy', loading ? 'true' : 'false');
        };

        setLoading(true);
        progressContainer.classList.add('active');
        statusEl.textContent = 'Running backtest...';
        let shouldDelayHide = false;

        try {
            progressFill.style.width = '20%';
            progressText.textContent = 'Calculating indicators...';
            await this.sleep(100);

            const strategy = strategyRegistry.get(state.currentStrategyKey);
            if (!strategy) {
                debugLogger.error("backtest.strategy_not_found", { strategyKey: state.currentStrategyKey });
                statusEl.textContent = 'Strategy not found';
                return;
            }

            const params = paramManager.getValues(strategy);
            const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = this.getCapitalSettings();
            const settings = this.getBacktestSettings();
            const requiresTsEngine = this.requiresTypescriptEngine(settings);
            const parityMode = this.getTwoHourCloseParityMode();

            progressFill.style.width = '40%';
            progressText.textContent = parityMode === 'both' ? 'Preparing parity runs...' : 'Generating signals...';
            await this.sleep(100);

            state.set('twoHourParityBacktestResults', null);
            // Data normalization (closed candles + block range) is applied inside runBacktestForData.
            const baseData = state.ohlcvData;

            let result: BacktestResult;
            let engineUsed: 'rust' | 'typescript';
            let parityComparison: { odd: BacktestResult; even: BacktestResult; baseline: 'odd' | 'even' } | null = null;

            if (parityMode === 'both') {
                const baselineParity = this.inferBaselineParity(baseData);
                const oddData = await this.getBacktestDataForParity('odd', baseData);
                const evenData = await this.getBacktestDataForParity('even', baseData);

                progressFill.style.width = '65%';
                progressText.textContent = 'Running odd + even backtests...';
                await this.sleep(80);

                const oddRun = await this.withTemporaryTwoHourParity('odd', async () => this.runBacktestForData(
                    oddData,
                    state.currentInterval,
                    strategy,
                    params,
                    settings,
                    initialCapital,
                    positionSize,
                    commission,
                    sizingMode,
                    fixedTradeAmount,
                    requiresTsEngine
                ));
                const evenRun = await this.withTemporaryTwoHourParity('even', async () => this.runBacktestForData(
                    evenData,
                    state.currentInterval,
                    strategy,
                    params,
                    settings,
                    initialCapital,
                    positionSize,
                    commission,
                    sizingMode,
                    fixedTradeAmount,
                    requiresTsEngine
                ));

                parityComparison = { odd: oddRun.result, even: evenRun.result, baseline: baselineParity };
                state.set('twoHourParityBacktestResults', parityComparison);

                if (baselineParity === 'even') {
                    result = evenRun.result;
                    engineUsed = evenRun.engineUsed;
                } else {
                    result = oddRun.result;
                    engineUsed = oddRun.engineUsed;
                }

                debugLogger.event('backtest.parity_compare', {
                    strategy: state.currentStrategyKey,
                    oddTrades: oddRun.result.totalTrades,
                    evenTrades: evenRun.result.totalTrades,
                    baseline: baselineParity,
                });
            } else {
                progressFill.style.width = '60%';
                progressText.textContent = 'Running backtest...';
                await this.sleep(100);

                const singleRun = await this.withTemporaryTwoHourParity(parityMode, async () => this.runBacktestForData(
                    baseData,
                    state.currentInterval,
                    strategy,
                    params,
                    settings,
                    initialCapital,
                    positionSize,
                    commission,
                    sizingMode,
                    fixedTradeAmount,
                    requiresTsEngine
                ));
                result = singleRun.result;
                engineUsed = singleRun.engineUsed;
            }

            state.set('currentBacktestResultSource', 'backtest');
            state.set('currentBacktestResult', result);

            progressFill.style.width = '100%';
            progressText.textContent = 'Complete!';
            if (parityComparison && !result.entryStats) {
                statusEl.textContent = `2H compare | Odd ${parityComparison.odd.netProfitPercent.toFixed(2)}% | Even ${parityComparison.even.netProfitPercent.toFixed(2)}%`;
            } else if (result.entryStats) {
                const entryWin = result.entryStats.winRate.toFixed(1);
                const useTarget = result.entryStats.winDefinition === 'target' && (result.entryStats.targetPct ?? 0) > 0;
                const avgBars = useTarget
                    ? (result.entryStats.avgTargetBars ?? result.entryStats.avgRetestBars)
                    : result.entryStats.avgRetestBars;
                const label = useTarget ? 'Avg Target' : 'Avg Retest';
                statusEl.textContent = `${result.entryStats.totalEntries} entries | Win ${entryWin}% | ${label} ${avgBars.toFixed(1)} bars`;
            } else {
                const expectancyText = `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`;
                const pfText = result.profitFactor === Infinity ? 'Inf' : result.profitFactor.toFixed(2);
                const engineBadge = engineUsed === 'rust' ? ' ⚡' : '';
                statusEl.textContent = `${result.totalTrades} trades | Exp ${expectancyText} | PF ${pfText}${engineBadge}`;
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
            progressContainer.classList.remove('active');
            progressFill.style.width = '0%';
            setLoading(false);
        }
    }

    private getTwoHourCloseParityMode(): 'odd' | 'even' | 'both' {
        if (getIntervalSeconds(state.currentInterval) !== 7200) {
            return 'odd';
        }
        const select = getOptionalElement<HTMLSelectElement>('twoHourCloseParity');
        if (select?.value === 'even' || select?.value === 'both') {
            return select.value;
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
        const select = getOptionalElement<HTMLSelectElement>('twoHourCloseParity');
        if (!select) return run();

        const previous = select.value;
        if (previous === parity) return run();

        select.value = parity;
        try {
            return await run();
        } finally {
            select.value = previous;
        }
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

        const statusEl = getRequiredElement('strategyStatus');
        const progressContainer = getRequiredElement('progressContainer');
        const progressFill = getRequiredElement('progressFill');
        const progressText = getRequiredElement('progressText');
        const runButton = getOptionalElement<HTMLButtonElement>('runCombinedStrategyBtn');

        const setLoading = (loading: boolean) => {
            if (runButton) {
                runButton.disabled = loading;
                runButton.classList.toggle('is-loading', loading);
            }
        };

        setLoading(true);
        progressContainer.classList.add('active');
        statusEl.textContent = 'Running combined backtest...';

        try {
            // --- 1. Resolve both strategies from registry ---
            progressFill.style.width = '10%';
            progressText.textContent = 'Resolving strategies...';
            await this.sleep(50);

            const primaryStrategy = strategyRegistry.get(primaryConfig.strategyKey);
            const secondaryStrategy = strategyRegistry.get(secondaryConfig.strategyKey);

            if (!primaryStrategy) {
                statusEl.textContent = `Primary strategy "${primaryConfig.strategyKey}" not found`;
                return;
            }
            if (!secondaryStrategy) {
                statusEl.textContent = `Secondary strategy "${secondaryConfig.strategyKey}" not found`;
                return;
            }

            // --- 2. Prepare data ---
            progressFill.style.width = '20%';
            progressText.textContent = 'Preparing data...';
            await this.sleep(50);

            const backtestData = this.selectClosedCandleData(state.ohlcvData, state.currentInterval);

            // --- 3. Execute both strategies ---
            progressFill.style.width = '40%';
            progressText.textContent = 'Generating signals from both strategies...';
            await this.sleep(50);

            const primarySettings = resolveBacktestSettingsFromRaw(
                primaryConfig.backtestSettings as unknown as BacktestSettings,
                { captureSnapshots: true, coerceWithoutUiToggles: true }
            );
            const secondarySettings = resolveBacktestSettingsFromRaw(
                secondaryConfig.backtestSettings as unknown as BacktestSettings,
                { captureSnapshots: false, coerceWithoutUiToggles: true }
            );

            const primarySignals = applySignalPolarity(
                primaryStrategy.execute(backtestData, primaryConfig.strategyParams),
                primarySettings
            );
            const secondarySignals = applySignalPolarity(
                secondaryStrategy.execute(backtestData, secondaryConfig.strategyParams),
                secondarySettings
            );

            // --- 4. Merge signals ---
            progressFill.style.width = '60%';
            progressText.textContent = `Merging signals (${mode.toUpperCase()})...`;
            await this.sleep(50);

            const mergedSignals = this.mergeSignals(primarySignals, secondarySignals, mode);

            // --- 5. Apply block-range filter ---
            const block = state.blockRange;
            const blockFilteredSignals = (block && block.from !== block.to)
                ? mergedSignals.filter(s => {
                    const t = typeof s.time === 'number' ? s.time : Number(s.time);
                    return t >= block.from && t <= block.to;
                })
                : mergedSignals;

            // --- 6. Run backtest using primary config's settings + capital ---
            progressFill.style.width = '80%';
            progressText.textContent = 'Running backtest on merged signals...';
            await this.sleep(50);

            const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } =
                settingsManager.resolveCapitalFromConfig(primaryConfig);

            let result: BacktestResult = runBacktest(
                backtestData,
                blockFilteredSignals,
                initialCapital,
                positionSize,
                commission,
                primarySettings,
                { mode: sizingMode, fixedTradeAmount }
            );

            // --- 7. Post-process ---
            result.sharpeRatio = this.recomputeSharpeRatio(result, initialCapital);
            result.postEntryPath = this.buildPostEntryPathStats(result, 5, backtestData);
            if (result.trades.length >= 3) {
                result.edgeStatistics = computeEdgeStatistics(result, backtestData);
            }

            // --- 8. Update state and UI ---
            state.set('currentBacktestResultSource', 'backtest');
            state.set('currentBacktestResult', result);

            progressFill.style.width = '100%';
            progressText.textContent = 'Complete!';
            const expectancyText = `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`;
            const pfText = result.profitFactor === Infinity ? 'Inf' : result.profitFactor.toFixed(2);
            statusEl.textContent = `Combined (${mode.toUpperCase()}) | ${result.totalTrades} trades | Exp ${expectancyText} | PF ${pfText}`;

            debugLogger.event('backtest.combined.success', {
                primary: primaryConfig.strategyKey,
                secondary: secondaryConfig.strategyKey,
                mode,
                primarySignals: primarySignals.length,
                secondarySignals: secondarySignals.length,
                mergedSignals: blockFilteredSignals.length,
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
            statusEl.textContent = 'Combined backtest failed';
            throw error;
        } finally {
            progressContainer.classList.remove('active');
            progressFill.style.width = '0%';
            setLoading(false);
        }
    }

    /** Delegates to the standalone mergeStrategySignals utility. */
    private mergeSignals(
        primarySignals: { time: any; type: 'buy' | 'sell'; price: number; triggerPrice?: number; reason?: string; barIndex?: number; sizeFraction?: number }[],
        secondarySignals: { time: any; type: 'buy' | 'sell'; price: number; triggerPrice?: number; reason?: string; barIndex?: number; sizeFraction?: number }[],
        mode: 'and' | 'or'
    ): { time: any; type: 'buy' | 'sell'; price: number; triggerPrice?: number; reason?: string; barIndex?: number; sizeFraction?: number }[] {
        return mergeStrategySignals(primarySignals, secondarySignals, mode);
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
        sizingMode: 'percent' | 'fixed',
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
        const backtestData = this.selectClosedCandleData(ohlcvData, interval);
        timing.selectClosedCandleData = performance.now() - t1;

        const t2 = performance.now();
        const signals = applySignalPolarity(strategy.execute(backtestData, params), settings);
        timing.strategyExecute = performance.now() - t2;

        const filteredSignals = signals;

        // Block range signal filter (defensive): selectClosedCandleData already slices data.
        // Keep this to guard against any non-sliced signals when data sources change.
        const block = state.blockRange;
        const blockFilteredSignals = (block && block.from !== block.to)
            ? filteredSignals.filter(s => {
                const t = typeof s.time === 'number' ? s.time : Number(s.time);
                return t >= block.from && t <= block.to;
            })
            : filteredSignals;

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
                uiManager.showToast('Realism or snapshot filter settings require TypeScript engine (Rust skipped).', 'info');
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
        if (!result.entryStats) {
            result.sharpeRatio = this.recomputeSharpeRatio(result, initialCapital);
        }
        result.postEntryPath = this.buildPostEntryPathStats(result, 5, backtestData);
        if (result.trades.length >= 3) {
            result.edgeStatistics = computeEdgeStatistics(result, backtestData);
        }
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

    private selectClosedCandleData(ohlcvData: OHLCVData[], interval: string): OHLCVData[] {
        const closed = trimToClosedCandles(ohlcvData, interval);
        return sliceOhlcvByBlock(closed, state.blockRange);
    }

    private buildRustCompatibleSettings(settings: BacktestSettings): BacktestSettings {
        return sanitizeBacktestSettingsForRust(settings);
    }



    public getCapitalSettings(): {
        initialCapital: number;
        positionSize: number;
        commission: number;
        sizingMode: 'percent' | 'fixed';
        fixedTradeAmount: number;
    } {
        const initialCapital = Math.max(0, this.readNumberInput('initialCapital', CAPITAL_DEFAULTS.initialCapital));
        const positionSize = Math.max(0, this.readNumberInput('positionSize', CAPITAL_DEFAULTS.positionSize));
        const commission = Math.max(0, this.readNumberInput('commission', CAPITAL_DEFAULTS.commission));
        const fixedTradeAmount = Math.max(0, this.readNumberInput('fixedTradeAmount', CAPITAL_DEFAULTS.fixedTradeAmount));
        const fixedTradeToggle = getOptionalElement<HTMLInputElement>('fixedTradeToggle');
        const sizingMode: 'percent' | 'fixed' = fixedTradeToggle?.checked ? 'fixed' : 'percent';
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

    private readSizingMode(value: unknown): 'percent' | 'fixed' | null {
        if (value === 'percent' || value === 'fixed') return value;
        return null;
    }

    private resolveSubscriptionCapitalSettings(backtestSettings: BacktestSettings): {
        initialCapital: number;
        positionSize: number;
        commission: number;
        sizingMode: 'percent' | 'fixed';
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
        const sizingMode: 'percent' | 'fixed' = explicitSizingMode
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

    private recomputeSharpeRatio(result: BacktestResult, initialCapital: number): number {
        if (Array.isArray(result.trades) && result.trades.length > 0) {
            return calculateSharpeRatioFromReturns(result.trades.map(trade => trade.pnlPercent));
        }

        if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
            const returns: number[] = [];
            let prevEquity = initialCapital;
            for (const point of result.equityCurve) {
                if (prevEquity > 0) {
                    returns.push((point.value - prevEquity) / prevEquity);
                }
                prevEquity = point.value;
            }
            return calculateSharpeRatioFromReturns(returns);
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

    private addIndicatorToChart(name: string, values: (number | null)[], times: any[], color: string, type: 'line' | 'band' | 'histogram') {
        const lineData = values
            .map((v, i) => v !== null ? { time: times[i], value: v } : null)
            .filter(d => d !== null) as { time: any; value: number }[];

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

