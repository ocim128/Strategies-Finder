import { state } from "./state";
import { uiManager } from "./ui-manager";
import { chartManager } from "./chart-manager";
import { dataManager } from "./data-manager";

import {
    runBacktest,
    StrategyParams,
    BacktestSettings,
    TradeFilterMode,
    buildEntryBacktestResult,
    BacktestResult,
    PostEntryPathStats,
    PostEntryPathBucketStats,
    PostEntryPathOpenTradeProbability,
    Trade,
    timeKey,
} from "./strategies/index";
import type { OHLCVData, Strategy } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { rustEngine } from "./rust-engine-client";
import { shouldUseRustEngine } from "./engine-preferences";
import { buildConfirmationStates, filterSignalsWithConfirmations, filterSignalsWithConfirmationsBoth, getConfirmationStrategyParams, getConfirmationStrategyValues } from "./confirmation-strategies";
import { calculateSharpeRatioFromReturns } from "./strategies/performance-metrics";
import { getIntervalSeconds } from "./dataProviders/utils";
import { getOptionalElement, getRequiredElement } from "./dom-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { sanitizeBacktestSettingsForRust } from "./rust-settings-sanitizer";
import {
    BACKTEST_DOM_SETTING_IDS,
    CAPITAL_DEFAULTS,
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw
} from "./backtest-settings-resolver";
import { readNumberInputValue } from "./dom-input-readers";

export class BacktestService {
    private warnedStrictEngine = false;

    private resolveTradeFilterMode(settings: BacktestSettings): TradeFilterMode {
        return (settings.tradeFilterMode ?? settings.entryConfirmation ?? 'none') as TradeFilterMode;
    }

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

            let result: BacktestResult;
            let engineUsed: 'rust' | 'typescript';
            let parityComparison: { odd: BacktestResult; even: BacktestResult; baseline: 'odd' | 'even' } | null = null;

            if (parityMode === 'both') {
                const baselineParity = this.inferBaselineParity(state.ohlcvData);
                const oddData = await this.getBacktestDataForParity('odd');
                const evenData = await this.getBacktestDataForParity('even');

                progressFill.style.width = '65%';
                progressText.textContent = 'Running odd + even backtests...';
                await this.sleep(80);

                const oddRun = await this.withTemporaryTwoHourParity('odd', async () => this.runBacktestForData(
                    oddData,
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
                    state.ohlcvData,
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
        const firstTime = Number(data[0].time);
        if (!Number.isFinite(firstTime)) return 'odd';
        const mod = ((firstTime % 7200) + 7200) % 7200;
        return mod === 3600 ? 'even' : 'odd';
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

    private async getBacktestDataForParity(parity: 'odd' | 'even'): Promise<OHLCVData[]> {
        if (getIntervalSeconds(state.currentInterval) !== 7200) {
            return state.ohlcvData;
        }
        return this.withTemporaryTwoHourParity(parity, async () => {
            const fetched = await dataManager.fetchData(state.currentSymbol, state.currentInterval);
            return fetched.length > 0 ? fetched : state.ohlcvData;
        });
    }

    private async runBacktestForData(
        ohlcvData: OHLCVData[],
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
        const signals = strategy.execute(ohlcvData, params);

        const confirmationStrategies = settings.confirmationStrategies ?? [];
        const tradeFilterMode = this.resolveTradeFilterMode(settings);
        const confirmationStates = confirmationStrategies.length > 0
            ? buildConfirmationStates(ohlcvData, confirmationStrategies, settings.confirmationStrategyParams)
            : [];
        const filteredSignals = confirmationStates.length > 0
            ? ((strategy.metadata?.role === 'entry' || settings.tradeDirection === 'both' || settings.tradeDirection === 'combined')
                ? filterSignalsWithConfirmationsBoth(
                    ohlcvData,
                    signals,
                    confirmationStates,
                    tradeFilterMode
                )
                : filterSignalsWithConfirmations(
                    ohlcvData,
                    signals,
                    confirmationStates,
                    tradeFilterMode,
                    settings.tradeDirection ?? 'long'
                ))
            : signals;

        let result: BacktestResult | undefined;
        let engineUsed: 'rust' | 'typescript' = 'typescript';

        const evaluation = strategy.evaluate?.(ohlcvData, params, filteredSignals);
        const entryStats = evaluation?.entryStats;

        if (strategy.metadata?.role === 'entry' && entryStats) {
            result = buildEntryBacktestResult(entryStats);
            engineUsed = 'typescript';
        }

        if (!result && shouldUseRustEngine() && !requiresTsEngine) {
            const rustResult = await rustEngine.runBacktest(
                ohlcvData,
                filteredSignals,
                initialCapital,
                positionSize,
                commission,
                this.buildRustCompatibleSettings(settings),
                { mode: sizingMode, fixedTradeAmount }
            );

            if (rustResult) {
                if (this.isResultConsistent(rustResult)) {
                    result = rustResult;
                    engineUsed = 'rust';
                    debugLogger.event('backtest.rust_used', { bars: ohlcvData.length });
                } else {
                    debugLogger.warn('[Backtest] Rust result failed consistency checks, falling back to TypeScript');
                    uiManager.showToast('Rust backtest result inconsistent, rerunning in TypeScript', 'info');
                }
            }
        }

        if (!result) {
            if (requiresTsEngine && shouldUseRustEngine() && !this.warnedStrictEngine) {
                this.warnedStrictEngine = true;
                uiManager.showToast('Realism or snapshot filter settings require TypeScript engine (Rust skipped).', 'info');
            }
            result = runBacktest(
                ohlcvData,
                filteredSignals,
                initialCapital,
                positionSize,
                commission,
                settings,
                { mode: sizingMode, fixedTradeAmount }
            );
            engineUsed = 'typescript';
        }

        if (!result.entryStats) {
            result.sharpeRatio = this.recomputeSharpeRatio(result, initialCapital);
        }
        result.postEntryPath = this.buildPostEntryPathStats(result, 5, ohlcvData);
        return { result, engineUsed };
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

        raw.confirmationStrategies = getConfirmationStrategyValues();
        raw.confirmationStrategyParams = getConfirmationStrategyParams();

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
        const horizonBars = Array.from({ length: horizonMaxBars }, (_, index) => index + 1);
        const createMoveBuckets = () => Array.from({ length: horizonMaxBars }, () => [] as number[]);
        const winMoves = createMoveBuckets();
        const loseMoves = createMoveBuckets();
        const allMoves = createMoveBuckets();

        const winDurationBars: number[] = [];
        const loseDurationBars: number[] = [];
        const allDurationBars: number[] = [];
        const winDurationMinutes: number[] = [];
        const loseDurationMinutes: number[] = [];
        const allDurationMinutes: number[] = [];

        const timeIndex = new Map<string, number>();
        for (let i = 0; i < ohlcvData.length; i++) {
            timeIndex.set(timeKey(ohlcvData[i].time), i);
        }

        for (const trade of result.trades) {
            const entryIndex = timeIndex.get(timeKey(trade.entryTime));
            if (entryIndex !== undefined && Number.isFinite(trade.entryPrice) && trade.entryPrice > 0) {
                for (let bar = 1; bar <= horizonMaxBars; bar++) {
                    const targetIndex = entryIndex + bar;
                    if (targetIndex >= ohlcvData.length) break;

                    const targetClose = ohlcvData[targetIndex].close;
                    if (!Number.isFinite(targetClose)) continue;

                    const rawMovePct = ((targetClose - trade.entryPrice) / trade.entryPrice) * 100;
                    const signedMovePct = trade.type === 'short' ? -rawMovePct : rawMovePct;
                    const bucketIndex = bar - 1;
                    allMoves[bucketIndex].push(signedMovePct);
                    if (trade.pnl > 0) {
                        winMoves[bucketIndex].push(signedMovePct);
                    } else {
                        loseMoves[bucketIndex].push(signedMovePct);
                    }
                }
            }

            this.collectTradeDuration(
                trade,
                timeIndex,
                winDurationBars,
                loseDurationBars,
                allDurationBars,
                winDurationMinutes,
                loseDurationMinutes,
                allDurationMinutes
            );
        }

        return {
            horizonBars,
            win: this.finalizePostEntryBucket(winMoves, winDurationBars, winDurationMinutes),
            lose: this.finalizePostEntryBucket(loseMoves, loseDurationBars, loseDurationMinutes),
            all: this.finalizePostEntryBucket(allMoves, allDurationBars, allDurationMinutes),
            openTradeProbability: this.estimateOpenTradeProbability(result.trades, timeIndex, horizonMaxBars, ohlcvData),
        };
    }

    private collectTradeDuration(
        trade: Trade,
        timeIndex: Map<string, number>,
        winDurationBars: number[],
        loseDurationBars: number[],
        allDurationBars: number[],
        winDurationMinutes: number[],
        loseDurationMinutes: number[],
        allDurationMinutes: number[]
    ): void {
        const entryIndex = timeIndex.get(timeKey(trade.entryTime));
        const exitIndex = timeIndex.get(timeKey(trade.exitTime));
        if (entryIndex !== undefined && exitIndex !== undefined && exitIndex >= entryIndex) {
            const durationBars = exitIndex - entryIndex;
            allDurationBars.push(durationBars);
            if (trade.pnl > 0) {
                winDurationBars.push(durationBars);
            } else {
                loseDurationBars.push(durationBars);
            }
        }

        const entryMs = this.toEpochMs(trade.entryTime);
        const exitMs = this.toEpochMs(trade.exitTime);
        if (entryMs === null || exitMs === null) return;
        const durationMinutes = (exitMs - entryMs) / 60000;
        if (!Number.isFinite(durationMinutes) || durationMinutes < 0) return;

        allDurationMinutes.push(durationMinutes);
        if (trade.pnl > 0) {
            winDurationMinutes.push(durationMinutes);
        } else {
            loseDurationMinutes.push(durationMinutes);
        }
    }

    private finalizePostEntryBucket(
        movesByBar: number[][],
        durationBars: number[],
        durationMinutes: number[]
    ): PostEntryPathBucketStats {
        return {
            avgSignedMovePctByBar: movesByBar.map((values) => this.average(values)),
            medianSignedMovePctByBar: movesByBar.map((values) => this.median(values)),
            maxSignedMovePctByBar: movesByBar.map((values) => this.maximum(values)),
            minSignedMovePctByBar: movesByBar.map((values) => this.minimum(values)),
            positiveRatePctByBar: movesByBar.map((values) => {
                if (values.length === 0) return null;
                const positiveCount = values.filter((value) => value > 0).length;
                return (positiveCount / values.length) * 100;
            }),
            sampleSizeByBar: movesByBar.map((values) => values.length),
            avgClosedTradeTimeBars: this.average(durationBars),
            avgClosedTradeTimeMinutes: this.average(durationMinutes),
        };
    }

    private estimateOpenTradeProbability(
        trades: Trade[],
        timeIndex: Map<string, number>,
        horizonMaxBars: number,
        ohlcvData: OHLCVData[]
    ): PostEntryPathOpenTradeProbability {
        const openTrade = [...trades].reverse().find((trade) => trade.exitReason === 'end_of_data');
        if (!openTrade) {
            return {
                hasOpenTrade: false,
                tradeType: null,
                barsHeld: null,
                basisBar: null,
                signedMovePct: null,
                winProbabilityPct: null,
                loseProbabilityPct: null,
                sampleSize: 0,
                matchedSampleSize: 0,
            };
        }

        const entryIndex = timeIndex.get(timeKey(openTrade.entryTime));
        const exitIndex = timeIndex.get(timeKey(openTrade.exitTime));
        if (entryIndex === undefined || exitIndex === undefined || exitIndex < entryIndex || openTrade.entryPrice <= 0) {
            return {
                hasOpenTrade: true,
                tradeType: openTrade.type,
                barsHeld: null,
                basisBar: null,
                signedMovePct: null,
                winProbabilityPct: null,
                loseProbabilityPct: null,
                sampleSize: 0,
                matchedSampleSize: 0,
            };
        }

        const barsHeld = exitIndex - entryIndex;
        if (barsHeld < 1) {
            return {
                hasOpenTrade: true,
                tradeType: openTrade.type,
                barsHeld,
                basisBar: null,
                signedMovePct: null,
                winProbabilityPct: null,
                loseProbabilityPct: null,
                sampleSize: 0,
                matchedSampleSize: 0,
            };
        }

        const basisBar = Math.min(horizonMaxBars, barsHeld);
        const probeIndex = entryIndex + basisBar;
        if (probeIndex >= ohlcvData.length || !Number.isFinite(ohlcvData[probeIndex].close)) {
            return {
                hasOpenTrade: true,
                tradeType: openTrade.type,
                barsHeld,
                basisBar,
                signedMovePct: null,
                winProbabilityPct: null,
                loseProbabilityPct: null,
                sampleSize: 0,
                matchedSampleSize: 0,
            };
        }

        const probeClose = ohlcvData[probeIndex].close;
        const rawProbeMovePct = ((probeClose - openTrade.entryPrice) / openTrade.entryPrice) * 100;
        const probeSignedMovePct = openTrade.type === 'short' ? -rawProbeMovePct : rawProbeMovePct;

        const comparableTrades: Array<{ signedMovePct: number; isWin: boolean }> = [];
        for (const trade of trades) {
            if (trade.id === openTrade.id) continue;
            if (trade.exitReason === 'end_of_data') continue;
            if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) continue;

            const historicalEntryIndex = timeIndex.get(timeKey(trade.entryTime));
            if (historicalEntryIndex === undefined) continue;
            const historicalProbeIndex = historicalEntryIndex + basisBar;
            if (historicalProbeIndex >= ohlcvData.length) continue;

            const historicalClose = ohlcvData[historicalProbeIndex].close;
            if (!Number.isFinite(historicalClose)) continue;

            const rawMovePct = ((historicalClose - trade.entryPrice) / trade.entryPrice) * 100;
            const signedMovePct = trade.type === 'short' ? -rawMovePct : rawMovePct;
            comparableTrades.push({ signedMovePct, isWin: trade.pnl > 0 });
        }

        if (comparableTrades.length === 0) {
            return {
                hasOpenTrade: true,
                tradeType: openTrade.type,
                barsHeld,
                basisBar,
                signedMovePct: probeSignedMovePct,
                winProbabilityPct: null,
                loseProbabilityPct: null,
                sampleSize: 0,
                matchedSampleSize: 0,
            };
        }

        const nearest = comparableTrades
            .map((sample) => ({
                ...sample,
                distance: Math.abs(sample.signedMovePct - probeSignedMovePct),
            }))
            .sort((a, b) => a.distance - b.distance);

        const matchedSampleSize = Math.max(8, Math.min(nearest.length, Math.round(nearest.length * 0.35)));
        const matched = nearest.slice(0, matchedSampleSize);
        const winCount = matched.filter((sample) => sample.isWin).length;
        const winProbabilityPct = matched.length > 0 ? (winCount / matched.length) * 100 : null;
        const loseProbabilityPct = winProbabilityPct === null ? null : 100 - winProbabilityPct;

        return {
            hasOpenTrade: true,
            tradeType: openTrade.type,
            barsHeld,
            basisBar,
            signedMovePct: probeSignedMovePct,
            winProbabilityPct,
            loseProbabilityPct,
            sampleSize: comparableTrades.length,
            matchedSampleSize: matched.length,
        };
    }

    private average(values: number[]): number | null {
        if (values.length === 0) return null;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    private median(values: number[]): number | null {
        if (values.length === 0) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return (sorted[mid - 1] + sorted[mid]) / 2;
        }
        return sorted[mid];
    }

    private maximum(values: number[]): number | null {
        if (values.length === 0) return null;
        return values.reduce((max, value) => (value > max ? value : max), values[0]);
    }

    private minimum(values: number[]): number | null {
        if (values.length === 0) return null;
        return values.reduce((min, value) => (value < min ? value : min), values[0]);
    }

    private toEpochMs(time: Trade['entryTime']): number | null {
        const unixSeconds = parseTimeToUnixSeconds(time);
        return unixSeconds === null ? null : unixSeconds * 1000;
    }

    public requiresTypescriptEngine(settings: BacktestSettings): boolean {
        const executionModel = settings.executionModel ?? 'signal_close';
        const allowSameBarExit = settings.allowSameBarExit ?? true;
        const slippageBps = settings.slippageBps ?? 0;
        const hasSnapshotFilters =
            (settings.snapshotAtrPercentMin ?? 0) > 0 ||
            (settings.snapshotAtrPercentMax ?? 0) > 0 ||
            (settings.snapshotVolumeRatioMin ?? 0) > 0 ||
            (settings.snapshotVolumeRatioMax ?? 0) > 0 ||
            (settings.snapshotAdxMin ?? 0) > 0 ||
            (settings.snapshotAdxMax ?? 0) > 0 ||
            (settings.snapshotEmaDistanceMin ?? 0) !== 0 ||
            (settings.snapshotEmaDistanceMax ?? 0) !== 0 ||
            (settings.snapshotRsiMin ?? 0) > 0 ||
            (settings.snapshotRsiMax ?? 0) > 0 ||
            (settings.snapshotPriceRangePosMin ?? 0) > 0 ||
            (settings.snapshotPriceRangePosMax ?? 0) > 0 ||
            (settings.snapshotBarsFromHighMax ?? 0) > 0 ||
            (settings.snapshotBarsFromLowMax ?? 0) > 0 ||
            (settings.snapshotTrendEfficiencyMin ?? 0) > 0 ||
            (settings.snapshotTrendEfficiencyMax ?? 0) > 0 ||
            (settings.snapshotAtrRegimeRatioMin ?? 0) > 0 ||
            (settings.snapshotAtrRegimeRatioMax ?? 0) > 0 ||
            (settings.snapshotBodyPercentMin ?? 0) > 0 ||
            (settings.snapshotBodyPercentMax ?? 0) > 0 ||
            (settings.snapshotWickSkewMin ?? 0) !== 0 ||
            (settings.snapshotWickSkewMax ?? 0) !== 0 ||
            (settings.snapshotVolumeTrendMin ?? 0) > 0 ||
            (settings.snapshotVolumeTrendMax ?? 0) > 0 ||
            (settings.snapshotVolumeBurstMin ?? 0) !== 0 ||
            (settings.snapshotVolumeBurstMax ?? 0) !== 0 ||
            (settings.snapshotVolumePriceDivergenceMin ?? 0) !== 0 ||
            (settings.snapshotVolumePriceDivergenceMax ?? 0) !== 0 ||
            (settings.snapshotVolumeConsistencyMin ?? 0) > 0 ||
            (settings.snapshotVolumeConsistencyMax ?? 0) > 0 ||
            (settings.snapshotCloseLocationMin ?? 0) > 0 ||
            (settings.snapshotCloseLocationMax ?? 0) > 0 ||
            (settings.snapshotOppositeWickMin ?? 0) > 0 ||
            (settings.snapshotOppositeWickMax ?? 0) > 0 ||
            (settings.snapshotRangeAtrMultipleMin ?? 0) > 0 ||
            (settings.snapshotRangeAtrMultipleMax ?? 0) > 0 ||
            (settings.snapshotMomentumConsistencyMin ?? 0) > 0 ||
            (settings.snapshotMomentumConsistencyMax ?? 0) > 0 ||
            (settings.snapshotBreakQualityMin ?? 0) > 0 ||
            (settings.snapshotBreakQualityMax ?? 0) > 0 ||
            (settings.snapshotTf60PerfMin ?? 0) !== 0 ||
            (settings.snapshotTf60PerfMax ?? 0) !== 0 ||
            (settings.snapshotTf90PerfMin ?? 0) !== 0 ||
            (settings.snapshotTf90PerfMax ?? 0) !== 0 ||
            (settings.snapshotTf120PerfMin ?? 0) !== 0 ||
            (settings.snapshotTf120PerfMax ?? 0) !== 0 ||
            (settings.snapshotTf480PerfMin ?? 0) !== 0 ||
            (settings.snapshotTf480PerfMax ?? 0) !== 0 ||
            (settings.snapshotTfConfluencePerfMin ?? 0) !== 0 ||
            (settings.snapshotTfConfluencePerfMax ?? 0) !== 0 ||
            (settings.snapshotEntryQualityScoreMin ?? 0) > 0 ||
            (settings.snapshotEntryQualityScoreMax ?? 0) > 0;
        return executionModel !== 'signal_close' || slippageBps > 0 || !allowSameBarExit || settings.tradeDirection === 'both' || settings.tradeDirection === 'combined' || hasSnapshotFilters;
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
        strategyKey: string,
        strategyParams: Record<string, number>,
        backtestSettings: BacktestSettings
    ): Promise<BacktestResult> {
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            throw new Error(`Strategy not found: ${strategyKey}`);
        }

        const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = this.getCapitalSettings();
        const requiresTsEngine = this.requiresTypescriptEngine(backtestSettings);

        // Run the backtest
        const runResult = await this.runBacktestForData(
            ohlcvData,
            strategy,
            strategyParams,
            backtestSettings,
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

