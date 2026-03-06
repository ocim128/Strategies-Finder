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
    applySignalPolarity,
} from "./strategies/index";
import type {
    OHLCVData, Strategy, TradeSnapshot,
    SnapshotProfileStats, SnapshotProfileRow,
    ExitReasonBreakdown, ExitReasonRow,
} from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { rustEngine } from "./rust-engine-client";
import { shouldUseRustEngine } from "./engine-preferences";

import { calculateSharpeRatioFromReturns } from "./strategies/performance-metrics";
import { computeEdgeStatistics } from "./strategies/backtest/edge-statistics";
import { getIntervalSeconds } from "./dataProviders/utils";
import { getOptionalElement, getRequiredElement } from "./dom-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { sanitizeBacktestSettingsForRust, requiresTypescriptEngine as requiresTsEngine } from "./rust-settings-sanitizer";
import {
    BACKTEST_DOM_SETTING_IDS,
    CAPITAL_DEFAULTS,
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw
} from "./backtest-settings-resolver";
import { readNumberInputValue } from "./dom-input-readers";

import { resolveTwoHourParityFromTime } from "./two-hour-parity";

const SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS = Object.freeze({
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: 'percent' as const,
    fixedTradeAmount: 0,
});

export class BacktestService {
    private warnedStrictEngine = false;

    private resolveTradeFilterMode(settings: BacktestSettings): TradeFilterMode {
        return settings.tradeFilterMode ?? 'none';
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

            // Use the FULL dataset — signals are generated with complete indicator history.
            // Block range is applied as a signal-time filter inside runBacktestForData.
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
                // Return full fetched data — block filtering happens at signal level
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

        // ── Block range signal filter ──────────────────────────────────────────
        // If a block is active, remove signals outside [from, to] so only trades
        // that ORIGINATE within the block are executed.  The strategy still ran on
        // the full dataset, so all indicators have their proper warmup history.
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

    private selectClosedCandleData(ohlcvData: OHLCVData[], _interval: string): OHLCVData[] {
        return ohlcvData;
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
            snapshotProfile: this.buildSnapshotProfile(result.trades),
            exitReasonBreakdown: this.buildExitReasonBreakdown(result.trades),
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

    // ── Snapshot Profile: Win vs Lose indicator averages ──

    private static readonly SNAPSHOT_METRIC_DEFS: Array<{ key: keyof TradeSnapshot; label: string }> = [
        { key: 'rsi', label: 'RSI' },
        { key: 'adx', label: 'ADX' },
        { key: 'atrPercent', label: 'ATR %' },
        { key: 'emaDistance', label: 'EMA Distance %' },
        { key: 'volumeRatio', label: 'Volume Ratio' },
        { key: 'priceRangePos', label: 'Price Range Pos' },
        { key: 'barsFromHigh', label: 'Bars From High' },
        { key: 'barsFromLow', label: 'Bars From Low' },
        { key: 'trendEfficiency', label: 'Trend Efficiency' },
        { key: 'atrRegimeRatio', label: 'ATR Regime Ratio' },
        { key: 'bodyPercent', label: 'Body %' },
        { key: 'wickSkew', label: 'Wick Skew' },
        { key: 'closeLocation', label: 'Close Location' },
        { key: 'oppositeWickPercent', label: 'Opposite Wick %' },
        { key: 'rangeAtrMultiple', label: 'Range/ATR Multiple' },
        { key: 'momentumConsistency', label: 'Momentum Consistency' },
        { key: 'breakQuality', label: 'Break Quality' },
        { key: 'entryQualityScore', label: 'Entry Quality Score' },
        { key: 'volumeTrend', label: 'Volume Trend' },
        { key: 'volumeBurst', label: 'Volume Burst' },
        { key: 'volumePriceDivergence', label: 'Vol-Price Divergence' },
        { key: 'volumeConsistency', label: 'Volume Consistency' },
        { key: 'tf60Perf', label: '60m Perf %' },
        { key: 'tf90Perf', label: '90m Perf %' },
        { key: 'tf120Perf', label: '120m Perf %' },
        { key: 'tf480Perf', label: '480m Perf %' },
        { key: 'tfConfluencePerf', label: 'TF Confluence %' },
    ];

    private buildSnapshotProfile(trades: Trade[]): SnapshotProfileStats | undefined {
        const withSnapshots = trades.filter((t) => t.entrySnapshot);
        if (withSnapshots.length === 0) return undefined;

        const winTrades = withSnapshots.filter((t) => t.pnl > 0);
        const loseTrades = withSnapshots.filter((t) => t.pnl <= 0);

        const rows: SnapshotProfileRow[] = [];

        for (const def of BacktestService.SNAPSHOT_METRIC_DEFS) {
            const winValues = this.extractSnapshotValues(winTrades, def.key);
            const loseValues = this.extractSnapshotValues(loseTrades, def.key);
            const allValues = this.extractSnapshotValues(withSnapshots, def.key);

            // Skip metrics where we have no data at all
            if (allValues.length === 0) continue;

            const winAvg = this.average(winValues);
            const loseAvg = this.average(loseValues);
            const allAvg = this.average(allValues);
            const delta = (winAvg !== null && loseAvg !== null) ? winAvg - loseAvg : null;

            // Compute significance: |delta| / stddev(all)
            let significance: number | null = null;
            if (delta !== null && allValues.length >= 3) {
                const stddev = this.stddev(allValues);
                if (stddev !== null && stddev > 0) {
                    significance = Math.abs(delta) / stddev;
                }
            }

            rows.push({
                key: def.key,
                label: def.label,
                winAvg,
                loseAvg,
                allAvg,
                delta,
                significance,
            });
        }

        // Sort by significance descending (most discriminating first)
        rows.sort((a, b) => {
            const sa = a.significance ?? -1;
            const sb = b.significance ?? -1;
            return sb - sa;
        });

        return {
            rows,
            winSampleSize: winTrades.length,
            loseSampleSize: loseTrades.length,
        };
    }

    private extractSnapshotValues(trades: Trade[], key: keyof TradeSnapshot): number[] {
        const values: number[] = [];
        for (const trade of trades) {
            const snap = trade.entrySnapshot;
            if (!snap) continue;
            const val = snap[key];
            if (typeof val === 'number' && Number.isFinite(val)) {
                values.push(val);
            }
        }
        return values;
    }

    private stddev(values: number[]): number | null {
        if (values.length < 2) return null;
        const avg = values.reduce((s, v) => s + v, 0) / values.length;
        const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
        return Math.sqrt(variance);
    }

    // ── Exit Reason Breakdown ──

    private static readonly EXIT_REASON_LABELS: Record<string, string> = {
        signal: 'Signal',
        stop_loss: 'Stop Loss',
        take_profit: 'Take Profit',
        trailing_stop: 'Trailing Stop',
        time_stop: 'Time Stop',
        partial: 'Partial',
        probation_fail: 'Weak-Start Guard',
        end_of_data: 'End of Data',
    };

    private buildExitReasonBreakdown(trades: Trade[]): ExitReasonBreakdown | undefined {
        if (trades.length === 0) return undefined;

        const winTrades = trades.filter((t) => t.pnl > 0);
        const loseTrades = trades.filter((t) => t.pnl <= 0);

        // Collect all unique exit reasons
        const reasonCounts = new Map<string, { win: number; lose: number }>();
        for (const trade of trades) {
            const reason = trade.exitReason ?? 'signal';
            if (!reasonCounts.has(reason)) {
                reasonCounts.set(reason, { win: 0, lose: 0 });
            }
            const entry = reasonCounts.get(reason)!;
            if (trade.pnl > 0) {
                entry.win++;
            } else {
                entry.lose++;
            }
        }

        const totalWins = winTrades.length;
        const totalLosses = loseTrades.length;

        const rows: ExitReasonRow[] = [];
        for (const [reason, counts] of reasonCounts) {
            const totalCount = counts.win + counts.lose;
            rows.push({
                reason: BacktestService.EXIT_REASON_LABELS[reason] ?? reason,
                winCount: counts.win,
                winPct: totalWins > 0 ? (counts.win / totalWins) * 100 : 0,
                loseCount: counts.lose,
                losePct: totalLosses > 0 ? (counts.lose / totalLosses) * 100 : 0,
                totalCount,
                totalPct: trades.length > 0 ? (totalCount / trades.length) * 100 : 0,
            });
        }

        // Sort by total count descending
        rows.sort((a, b) => b.totalCount - a.totalCount);

        return { rows, totalWins, totalLosses };
    }

    private toEpochMs(time: Trade['entryTime']): number | null {
        const unixSeconds = parseTimeToUnixSeconds(time);
        return unixSeconds === null ? null : unixSeconds * 1000;
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
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            throw new Error(`Strategy not found: ${strategyKey}`);
        }

        const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } =
            this.resolveSubscriptionCapitalSettings(backtestSettings);
        // Keep Alerts "Last Trade" aligned with Worker evaluation (TypeScript engine path).
        const requiresTsEngine = true;

        // Run the backtest
        const runResult = await this.runBacktestForData(
            ohlcvData,
            interval,
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

