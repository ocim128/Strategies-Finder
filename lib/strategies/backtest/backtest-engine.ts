
import { BacktestResult, BacktestSettings, OHLCVData, Signal, Time, Trade } from '../../types/index';
import { ensureCleanData } from '../strategy-helpers';
import { NormalizedSettings, PositionState, PrecomputedIndicators, TradeSizingConfig } from '../../types/backtest';
import { compareTime, directionFactorFor, directionToSignalType, getExecutionShift, getTimeIndex, isLossStreakFlipTradeDirection, needsSnapshotIndicators, normalizeBacktestSettings, normalizeTradeDirection, signalToPositionDirection, timeKey } from './backtest-utils';
import { calculateSharpeRatioFromReturns } from '../performance-metrics';

import { prepareSignals } from './signal-preparation';
import { calculateTradeExitDetails, createEmptyBacktestResult, finalizeBacktestMetrics, calculateBacktestStats, calculateMaxDrawdown } from './position-stats';
import { precomputeIndicators, resolveIndicators } from './indicator-precompute';
import { buildPositionFromSignal } from './position-builder';
import { processPositionExits, updatePositionState } from './exit-handlers';
import { captureTradeSnapshot, computeSnapshotIndicators, SnapshotIndicators } from './snapshot-capture';
import { TradeSnapshot } from '../../types/index';

export { precomputeIndicators };

function getConflictingEntryTimes(signals: Signal[]): Set<string> {
    const buyTimes = new Set<string>();
    const sellTimes = new Set<string>();

    for (const signal of signals) {
        const key = timeKey(signal.time);
        if (signal.type === 'buy') buyTimes.add(key);
        else sellTimes.add(key);
    }

    const conflicts = new Set<string>();
    for (const key of buyTimes) {
        if (sellTimes.has(key)) {
            conflicts.add(key);
        }
    }
    return conflicts;
}

function filterSignalsForCombinedSide(
    signals: Signal[],
    side: 'long' | 'short',
    conflictTimes: Set<string>
): Signal[] {
    if (conflictTimes.size === 0) return signals;
    const entryType: Signal['type'] = side === 'short' ? 'sell' : 'buy';
    return signals.filter((signal) => !(signal.type === entryType && conflictTimes.has(timeKey(signal.time))));
}

function buildCombinedEquityCurve(
    data: OHLCVData[],
    longCurve: { time: Time; value: number }[],
    shortCurve: { time: Time; value: number }[],
    longInitialCapital: number,
    shortInitialCapital: number
): { time: Time; value: number }[] {
    if (data.length === 0) return [];

    // Build time-indexed lookups for safety against index misalignment
    const longMap = new Map<string, number>();
    for (const point of longCurve) longMap.set(timeKey(point.time), point.value);
    const shortMap = new Map<string, number>();
    for (const point of shortCurve) shortMap.set(timeKey(point.time), point.value);

    const curve: { time: Time; value: number }[] = [];
    for (let i = 0; i < data.length; i++) {
        const key = timeKey(data[i].time);
        const longValue = longMap.get(key) ?? longInitialCapital;
        const shortValue = shortMap.get(key) ?? shortInitialCapital;
        curve.push({ time: data[i].time, value: longValue + shortValue });
    }

    return curve;
}

function collectReturnsFromEquityArray(
    equityValues: ArrayLike<number>,
    initialCapital: number
): number[] {
    const returns: number[] = [];
    let prevEquity = initialCapital;

    for (let i = 0; i < equityValues.length; i++) {
        const equity = equityValues[i];
        if (prevEquity > 0) {
            returns.push((equity - prevEquity) / prevEquity);
        }
        prevEquity = equity;
    }

    return returns;
}

function collectReturnsFromEquityCurve(
    equityCurve: { time: Time; value: number }[],
    initialCapital: number
): number[] {
    const returns: number[] = [];
    let prevEquity = initialCapital;

    for (const point of equityCurve) {
        const equity = point.value;
        if (prevEquity > 0) {
            returns.push((equity - prevEquity) / prevEquity);
        }
        prevEquity = equity;
    }

    return returns;
}

function resolvePreparedSignalBarIndexes(data: OHLCVData[], preparedSignals: Signal[]): Int32Array {
    const indexes = new Int32Array(preparedSignals.length);
    let fallbackTimeIndex: Map<string, number> | null = null;

    for (let i = 0; i < preparedSignals.length; i++) {
        const signal = preparedSignals[i];
        if (Number.isFinite(signal.barIndex as number)) {
            const barIndex = Math.trunc(signal.barIndex as number);
            indexes[i] = barIndex >= 0 && barIndex < data.length ? barIndex : -1;
            continue;
        }

        if (!fallbackTimeIndex) {
            fallbackTimeIndex = getTimeIndex(data);
        }
        const mappedIndex = fallbackTimeIndex.get(timeKey(signal.time));
        indexes[i] = mappedIndex === undefined ? -1 : mappedIndex;
    }

    return indexes;
}

type CooldownState = {
    longUntilBar: number;
    shortUntilBar: number;
};

type DirectionLossState = {
    consecutiveLosses: number;
    recentLosses: boolean[];
};

type LossStreakState = {
    long: DirectionLossState;
    short: DirectionLossState;
};

type FlipLossDirectionState = {
    longConsecutiveLosses: number;
    shortConsecutiveLosses: number;
    activeDirection: 'long' | 'short' | null;
    totalClosedTrades: number;
    flipCooldownTradesRemaining: number;
    hasFlipped: boolean;
};

function createCooldownState(): CooldownState {
    return {
        longUntilBar: -1,
        shortUntilBar: -1,
    };
}

function createLossStreakState(): LossStreakState {
    return {
        long: { consecutiveLosses: 0, recentLosses: [] },
        short: { consecutiveLosses: 0, recentLosses: [] },
    };
}

function createFlipLossDirectionState(): FlipLossDirectionState {
    return {
        longConsecutiveLosses: 0,
        shortConsecutiveLosses: 0,
        activeDirection: null,
        totalClosedTrades: 0,
        flipCooldownTradesRemaining: 0,
        hasFlipped: false,
    };
}

function getOppositeDirection(direction: 'long' | 'short'): 'long' | 'short' {
    return direction === 'long' ? 'short' : 'long';
}

function getDirectionLossStreakCount(state: FlipLossDirectionState, direction: 'long' | 'short'): number {
    return direction === 'long' ? state.longConsecutiveLosses : state.shortConsecutiveLosses;
}

function setDirectionLossStreakCount(state: FlipLossDirectionState, direction: 'long' | 'short', nextValue: number): void {
    if (direction === 'long') {
        state.longConsecutiveLosses = nextValue;
        return;
    }
    state.shortConsecutiveLosses = nextValue;
}

function canEnterLossFlipDirection(
    tradeDirection: BacktestSettings['tradeDirection'],
    state: FlipLossDirectionState,
    signal: Signal
): boolean {
    if (!isLossStreakFlipTradeDirection(tradeDirection ?? 'long')) return true;
    if (state.activeDirection === null) return true;
    return signalToPositionDirection(signal.type) === state.activeDirection;
}

function updateLossFlipDirectionAfterClose(
    tradeDirection: BacktestSettings['tradeDirection'],
    config: NormalizedSettings,
    state: FlipLossDirectionState,
    direction: 'long' | 'short',
    tradePnl: number
): void {
    if (!isLossStreakFlipTradeDirection(tradeDirection ?? 'long')) return;

    state.totalClosedTrades += 1;
    const wasOnFlipCooldown = state.flipCooldownTradesRemaining > 0;
    if (state.flipCooldownTradesRemaining > 0) {
        state.flipCooldownTradesRemaining -= 1;
    }

    const isLoss = tradePnl <= 0;
    if (isLoss) {
        const nextCount = getDirectionLossStreakCount(state, direction) + 1;
        setDirectionLossStreakCount(state, direction, nextCount);
        if (nextCount >= config.flipAfterConsecutiveLosses) {
            if (wasOnFlipCooldown) return;
            if (!state.hasFlipped && state.totalClosedTrades < config.minTradesBeforeFirstFlip) return;
            state.activeDirection = getOppositeDirection(direction);
            state.hasFlipped = true;
            state.flipCooldownTradesRemaining = config.flipCooldownTrades;
            setDirectionLossStreakCount(state, direction, 0);
        }
        return;
    }

    setDirectionLossStreakCount(state, direction, 0);
}

function shouldApplyProbationCooldown(config: BacktestSettings): boolean {
    return config.riskMode === 'percentage'
        && config.riskProbationEnabled === true
        && (config.riskProbationCooldownBars ?? 0) > 0;
}

function shouldApplyLossStreakGuard(config: BacktestSettings): boolean {
    if (config.riskMode !== 'percentage' || config.riskLossStreakEnabled !== true) return false;
    const cooldownBars = config.riskLossStreakCooldownBars ?? 0;
    const consecutive = config.riskLossStreakConsecutive ?? 0;
    const windowSize = config.riskLossStreakWindowSize ?? 0;
    const windowLosses = config.riskLossStreakWindowLosses ?? 0;
    if (cooldownBars <= 0) return false;
    return consecutive > 0 || (windowSize > 0 && windowLosses > 0);
}

function isDirectionOnCooldown(cooldown: CooldownState, direction: 'long' | 'short', barIndex: number): boolean {
    const blockedUntil = direction === 'long' ? cooldown.longUntilBar : cooldown.shortUntilBar;
    return barIndex <= blockedUntil;
}

function armDirectionCooldown(
    cooldown: CooldownState,
    direction: 'long' | 'short',
    barIndex: number,
    cooldownBars: number
): void {
    if (cooldownBars <= 0) return;
    const nextBlockedUntil = barIndex + cooldownBars;
    if (direction === 'long') {
        cooldown.longUntilBar = Math.max(cooldown.longUntilBar, nextBlockedUntil);
        return;
    }
    cooldown.shortUntilBar = Math.max(cooldown.shortUntilBar, nextBlockedUntil);
}

function updateLossStreakCooldown(
    lossStreak: LossStreakState,
    cooldown: CooldownState,
    direction: 'long' | 'short',
    tradePnl: number,
    barIndex: number,
    settings: BacktestSettings
): void {
    const state = direction === 'long' ? lossStreak.long : lossStreak.short;
    const isLoss = tradePnl <= 0;
    state.consecutiveLosses = isLoss ? state.consecutiveLosses + 1 : 0;

    const windowSize = Math.max(0, settings.riskLossStreakWindowSize ?? 0);
    if (windowSize > 0) {
        state.recentLosses.push(isLoss);
        while (state.recentLosses.length > windowSize) {
            state.recentLosses.shift();
        }
    }

    const consecutiveTarget = Math.max(0, settings.riskLossStreakConsecutive ?? 0);
    const windowLossTarget = Math.max(0, settings.riskLossStreakWindowLosses ?? 0);
    const windowLossCount = windowSize > 0
        ? state.recentLosses.reduce((count, loss) => count + (loss ? 1 : 0), 0)
        : 0;

    const consecutiveTriggered = consecutiveTarget > 0 && state.consecutiveLosses >= consecutiveTarget;
    const windowTriggered = windowSize > 0 && windowLossTarget > 0 && windowLossCount >= windowLossTarget;

    if (consecutiveTriggered || windowTriggered) {
        armDirectionCooldown(cooldown, direction, barIndex, settings.riskLossStreakCooldownBars ?? 0);
    }
}

function combineCompactResults(
    initialCapital: number,
    longResult: BacktestResult,
    shortResult: BacktestResult,
    longEquity: Float64Array,
    shortEquity: Float64Array,
): BacktestResult {
    const totalTrades = longResult.totalTrades + shortResult.totalTrades;
    const winningTrades = longResult.winningTrades + shortResult.winningTrades;
    const losingTrades = longResult.losingTrades + shortResult.losingTrades;
    const netProfit = longResult.netProfit + shortResult.netProfit;
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;

    const totalProfit =
        (longResult.avgWin * longResult.winningTrades) +
        (shortResult.avgWin * shortResult.winningTrades);
    const totalLoss =
        (longResult.avgLoss * longResult.losingTrades) +
        (shortResult.avgLoss * shortResult.losingTrades);

    const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const lossRate = totalTrades > 0 ? (losingTrades / totalTrades) : 0;
    const expectancy = ((winRate / 100) * avgWin) - (lossRate * avgLoss);
    const avgTrade = totalTrades > 0 ? netProfit / totalTrades : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    // Compute proper combined max drawdown from the per-bar equity buffers
    let peakEquity = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    const len = Math.min(longEquity.length, shortEquity.length);
    const combinedEquity = new Float64Array(len);

    for (let i = 0; i < len; i++) {
        const combined = longEquity[i] + shortEquity[i];
        combinedEquity[i] = combined;
        if (combined > peakEquity) {
            peakEquity = combined;
        } else {
            const dd = peakEquity - combined;
            if (dd > maxDrawdown) {
                maxDrawdown = dd;
                maxDrawdownPercent = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
            }
        }
    }

    const combinedReturns = collectReturnsFromEquityArray(combinedEquity, initialCapital);
    const sharpeRatio = calculateSharpeRatioFromReturns(combinedReturns);

    return {
        trades: [],
        netProfit,
        netProfitPercent,
        winRate,
        expectancy,
        avgTrade,
        profitFactor,
        maxDrawdown,
        maxDrawdownPercent,
        totalTrades,
        winningTrades,
        losingTrades,
        avgWin,
        avgLoss,
        sharpeRatio,
        equityCurve: []
    };
}

function runCombinedBacktestCompact(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>,
    precomputed?: PrecomputedIndicators
): BacktestResult {
    // "Combined" runs long/short books independently and skips bars where both entry directions fire.
    const conflictTimes = getConflictingEntryTimes(signals);
    const longSignals = filterSignalsForCombinedSide(signals, 'long', conflictTimes);
    const shortSignals = filterSignalsForCombinedSide(signals, 'short', conflictTimes);

    // Split capital to keep total account exposure bounded to the configured initial capital.
    const longInitialCapital = initialCapital / 2;
    const shortInitialCapital = initialCapital - longInitialCapital;
    const splitSizing: Partial<TradeSizingConfig> = {
        mode: sizing?.mode ?? 'percent',
        fixedTradeAmount: sizing?.fixedTradeAmount ?? 0,
    };

    // Allocate per-bar equity buffers for proper combined drawdown/Sharpe calculation
    const longEquity = new Float64Array(data.length);
    const shortEquity = new Float64Array(data.length);

    const longResult = runBacktestCompact(
        data,
        longSignals,
        longInitialCapital,
        positionSizePercent,
        commissionPercent,
        { ...settings, tradeDirection: 'long' },
        splitSizing,
        precomputed,
        longEquity
    );
    const shortResult = runBacktestCompact(
        data,
        shortSignals,
        shortInitialCapital,
        positionSizePercent,
        commissionPercent,
        { ...settings, tradeDirection: 'short' },
        splitSizing,
        precomputed,
        shortEquity
    );

    return combineCompactResults(initialCapital, longResult, shortResult, longEquity, shortEquity);
}

function runCombinedBacktest(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>,
    precomputed?: PrecomputedIndicators
): BacktestResult {
    // "Combined" runs long/short books independently and skips bars where both entry directions fire.
    const conflictTimes = getConflictingEntryTimes(signals);
    const longSignals = filterSignalsForCombinedSide(signals, 'long', conflictTimes);
    const shortSignals = filterSignalsForCombinedSide(signals, 'short', conflictTimes);

    // Split capital to keep total account exposure bounded to the configured initial capital.
    const longInitialCapital = initialCapital / 2;
    const shortInitialCapital = initialCapital - longInitialCapital;
    const splitSizing: Partial<TradeSizingConfig> = {
        mode: sizing?.mode ?? 'percent',
        fixedTradeAmount: sizing?.fixedTradeAmount ?? 0,
    };

    const longResult = runBacktest(
        data,
        longSignals,
        longInitialCapital,
        positionSizePercent,
        commissionPercent,
        { ...settings, tradeDirection: 'long' },
        splitSizing,
        precomputed
    );
    const shortResult = runBacktest(
        data,
        shortSignals,
        shortInitialCapital,
        positionSizePercent,
        commissionPercent,
        { ...settings, tradeDirection: 'short' },
        splitSizing,
        precomputed
    );

    const mergedTrades = [...longResult.trades, ...shortResult.trades]
        .slice()
        .sort((a, b) => compareTime(a.exitTime, b.exitTime) || compareTime(a.entryTime, b.entryTime))
        .map((trade, index) => ({ ...trade, id: index + 1 }));

    const equityCurve = buildCombinedEquityCurve(
        data,
        longResult.equityCurve,
        shortResult.equityCurve,
        longInitialCapital,
        shortInitialCapital
    );
    const finalCapital = initialCapital + longResult.netProfit + shortResult.netProfit;
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);
    const combinedReturns = collectReturnsFromEquityCurve(equityCurve, initialCapital);
    const combinedSharpe = calculateSharpeRatioFromReturns(combinedReturns);
    const result = calculateBacktestStats(
        mergedTrades,
        equityCurve,
        initialCapital,
        finalCapital,
        maxDrawdown,
        maxDrawdownPercent
    );
    result.sharpeRatio = combinedSharpe;
    return result;
}

/**
 * Compact version optimized for speed and memory (for finder).
 */
export function runBacktestCompact(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>,
    precomputed?: PrecomputedIndicators,
    equityOut?: Float64Array
): BacktestResult {
    if (signals.length === 0) return createEmptyBacktestResult();

    const tradeDirection = normalizeTradeDirection(settings);
    if (tradeDirection === 'combined') {
        return runCombinedBacktestCompact(
            data,
            signals,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            settings,
            sizing,
            precomputed
        );
    }

    const config = normalizeBacktestSettings(settings);
    const sizingMode = sizing?.mode ?? 'percent';
    const fixedTradeAmount = Math.max(0, sizing?.fixedTradeAmount ?? 0);
    const indicatorSeries = resolveIndicators(data, settings, precomputed);

    const snapshotIndicators: SnapshotIndicators | null = needsSnapshotIndicators(config)
        ? computeSnapshotIndicators(data, indicatorSeries)
        : null;

    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection, snapshotIndicators);
    const preparedSignalBarIndexes = resolvePreparedSignalBarIndexes(data, preparedSignals);

    let capital = initialCapital;
    let position: PositionState | null = null;
    let totalTrades = 0, winningTrades = 0, totalProfit = 0, totalLoss = 0;
    let avgReturn = 0, returnM2 = 0, peakEquity = initialCapital, maxDrawdown = 0, maxDrawdownPercent = 0;
    let signalIdx = 0;

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    const probationCooldownActive = shouldApplyProbationCooldown(config);
    const lossStreakGuardActive = shouldApplyLossStreakGuard(config);
    const entryCooldownActive = probationCooldownActive || lossStreakGuardActive;
    const cooldown = createCooldownState();
    const lossStreak = createLossStreakState();
    const flipLossDirection = createFlipLossDirectionState();

    const recordExit = (exitPrice: number, exitSize: number) => {
        const details = calculateTradeExitDetails(position!, exitPrice, exitSize, commissionRate);
        capital += details.rawPnl - details.commission;
        totalTrades++;
        if (details.totalPnl > 0) { winningTrades++; totalProfit += details.totalPnl; } else { totalLoss += Math.abs(details.totalPnl); }
        const delta = details.pnlPercent - avgReturn;
        avgReturn += delta / totalTrades;
        returnM2 += delta * (details.pnlPercent - avgReturn);
        position!.size -= details.size;
        if (position!.size <= 0) position = null;
        return details;
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        if (position) {
            position.barsInTrade += 1;
            processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize, reason) => {
                const exitDirection = position!.direction;
                const details = recordExit(exitPrice, exitSize);
                if (probationCooldownActive && reason === 'probation_fail') {
                    armDirectionCooldown(cooldown, exitDirection, i, config.riskProbationCooldownBars);
                }
                if (lossStreakGuardActive && !position) {
                    updateLossStreakCooldown(lossStreak, cooldown, exitDirection, details.totalPnl, i, config);
                }
                if (!position) {
                    updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, exitDirection, details.totalPnl);
                }
            });
            if (position) updatePositionState(candle, position, config, indicatorSeries.atr[i]);
        }

        while (signalIdx < preparedSignals.length && preparedSignalBarIndexes[signalIdx] <= i) {
            const signalBarIndex = preparedSignalBarIndexes[signalIdx];
            const signal = preparedSignals[signalIdx++];
            if (signalBarIndex === i) {
                if (!position) {
                    if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                        continue;
                    }
                    const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                    if (opened) {
                        if (entryCooldownActive && isDirectionOnCooldown(cooldown, opened.nextPosition.direction, i)) {
                            continue;
                        }
                        position = opened.nextPosition;
                        if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                            flipLossDirection.activeDirection = opened.nextPosition.direction;
                        }
                        capital -= opened.entryCommission;
                        if (config.executionModel === 'next_open') {
                            processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize, reason) => {
                                const exitDirection = position!.direction;
                                const details = recordExit(exitPrice, exitSize);
                                if (probationCooldownActive && reason === 'probation_fail') {
                                    armDirectionCooldown(cooldown, exitDirection, i, config.riskProbationCooldownBars);
                                }
                                if (lossStreakGuardActive && !position) {
                                    updateLossStreakCooldown(lossStreak, cooldown, exitDirection, details.totalPnl, i, config);
                                }
                                if (!position) {
                                    updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, exitDirection, details.totalPnl);
                                }
                            });
                            if (position) updatePositionState(candle, position, config, indicatorSeries.atr[i]);
                        }
                    }
                } else if (signal.type === directionToSignalType(position.direction === 'long' ? 'short' : 'long') && (config.allowSameBarExit || compareTime(signal.time, position.entryTime) !== 0)) {
                    // Signal exit
                    const exitPrice = signal.price;
                    const exitFractionRaw = Number.isFinite(signal.sizeFraction as number) ? Number(signal.sizeFraction) : 1;
                    const exitFraction = Math.max(0, Math.min(1, exitFractionRaw));
                    const exitSize = position.size * exitFraction;
                    if (exitSize <= 0) {
                        continue;
                    }
                    const wasPartial = exitFraction < 1;
                    const exitDirection = position.direction;
                    const details = recordExit(exitPrice, exitSize);
                    if (lossStreakGuardActive && !position) {
                        updateLossStreakCooldown(lossStreak, cooldown, exitDirection, details.totalPnl, i, config);
                    }
                    if (!position) {
                        updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, exitDirection, details.totalPnl);
                    }
                    const immediateReentryAllowed = !wasPartial && (
                        tradeDirection === 'both'
                        || (
                            isLossStreakFlipTradeDirection(tradeDirection)
                            && flipLossDirection.activeDirection !== null
                            && signalToPositionDirection(signal.type) === flipLossDirection.activeDirection
                        )
                    );
                    if (!position && immediateReentryAllowed) {
                        const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                        if (opened) {
                            if (entryCooldownActive && isDirectionOnCooldown(cooldown, opened.nextPosition.direction, i)) {
                                continue;
                            }
                            position = opened.nextPosition;
                            if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                                flipLossDirection.activeDirection = opened.nextPosition.direction;
                            }
                            capital -= opened.entryCommission;
                            if (config.executionModel === 'next_open') {
                                processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize, reason) => {
                                    const exitDirection = position!.direction;
                                    const details = recordExit(exitPrice, exitSize);
                                    if (probationCooldownActive && reason === 'probation_fail') {
                                        armDirectionCooldown(cooldown, exitDirection, i, config.riskProbationCooldownBars);
                                    }
                                    if (lossStreakGuardActive && !position) {
                                        updateLossStreakCooldown(lossStreak, cooldown, exitDirection, details.totalPnl, i, config);
                                    }
                                    if (!position) {
                                        updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, exitDirection, details.totalPnl);
                                    }
                                });
                                if (position) updatePositionState(candle, position, config, indicatorSeries.atr[i]);
                            }
                        }
                    }
                }
            }
        }

        const equity = capital + (position ? (candle.close - position.entryPrice) * position.size * directionFactorFor(position.direction) : 0);
        if (equityOut) equityOut[i] = equity;
        if (equity > peakEquity) peakEquity = equity; else {
            const dd = peakEquity - equity;
            if (dd > maxDrawdown) { maxDrawdown = dd; maxDrawdownPercent = (dd / peakEquity) * 100; }
        }
    }

    // Match full backtest behavior: close any remaining position at the final close.
    if (position && data.length > 0) {
        const finalCandle = data[data.length - 1];
        recordExit(finalCandle.close, position.size);
        const finalEquity = capital;
        if (equityOut) equityOut[data.length - 1] = finalEquity;
        if (finalEquity > peakEquity) peakEquity = finalEquity; else {
            const dd = peakEquity - finalEquity;
            if (dd > maxDrawdown) { maxDrawdown = dd; maxDrawdownPercent = (dd / peakEquity) * 100; }
        }
    }

    return finalizeBacktestMetrics(initialCapital, capital, totalTrades, winningTrades, totalProfit, totalLoss, avgReturn, returnM2, maxDrawdown, maxDrawdownPercent) as BacktestResult;
}

/**
 * Standard version with full trade history and equity curve.
 */
export function runBacktest(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>,
    precomputed?: PrecomputedIndicators
): BacktestResult {
    if (signals.length === 0) return createEmptyBacktestResult();
    data = ensureCleanData(data);

    const tradeDirection = normalizeTradeDirection(settings);
    if (tradeDirection === 'combined') {
        return runCombinedBacktest(
            data,
            signals,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            settings,
            sizing,
            precomputed
        );
    }

    const config = normalizeBacktestSettings(settings);
    const sizingMode = sizing?.mode ?? 'percent';
    const fixedTradeAmount = Math.max(0, sizing?.fixedTradeAmount ?? 0);
    const indicatorSeries = resolveIndicators(data, settings, precomputed);

    const snapshotIndicators: SnapshotIndicators | null = needsSnapshotIndicators(config, !!settings.captureSnapshots)
        ? computeSnapshotIndicators(data, indicatorSeries)
        : null;

    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection, snapshotIndicators);
    const preparedSignalBarIndexes = resolvePreparedSignalBarIndexes(data, preparedSignals);

    const doSnapshot = !!settings.captureSnapshots;
    const executionShift = getExecutionShift(config);

    let capital = initialCapital, position: PositionState | null = null, tradeId = 0, signalIdx = 0;
    let currentSnapshot: TradeSnapshot | null = null;
    const trades: Trade[] = [];
    const equityCurve: { time: Time; value: number }[] = [];
    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    const probationCooldownActive = shouldApplyProbationCooldown(config);
    const lossStreakGuardActive = shouldApplyLossStreakGuard(config);
    const entryCooldownActive = probationCooldownActive || lossStreakGuardActive;
    const cooldown = createCooldownState();
    const lossStreak = createLossStreakState();
    const flipLossDirection = createFlipLossDirectionState();

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];
        if (position) {
            position.barsInTrade += 1;
            processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize, reason) => {
                const exitDirection = position!.direction;
                const d = calculateTradeExitDetails(position!, exitPrice, exitSize, commissionRate);
                capital += d.rawPnl - d.commission;
                const trade: Trade = { id: ++tradeId, type: position!.direction, entryTime: position!.entryTime, entryPrice: position!.entryPrice, exitTime: candle.time, exitPrice, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: reason };
                if (currentSnapshot) trade.entrySnapshot = currentSnapshot;
                trades.push(trade);
                position!.size -= d.size;
                if (position!.size <= 0) { position = null; currentSnapshot = null; }
                if (probationCooldownActive && reason === 'probation_fail') {
                    armDirectionCooldown(cooldown, exitDirection, i, config.riskProbationCooldownBars);
                }
                if (lossStreakGuardActive && !position) {
                    updateLossStreakCooldown(lossStreak, cooldown, exitDirection, d.totalPnl, i, config);
                }
                if (!position) {
                    updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, exitDirection, d.totalPnl);
                }
            });
            if (position) updatePositionState(candle, position, config, indicatorSeries.atr[i]);
        }

        while (signalIdx < preparedSignals.length && preparedSignalBarIndexes[signalIdx] <= i) {
            const signalBarIndex = preparedSignalBarIndexes[signalIdx];
            const signal = preparedSignals[signalIdx++];
            if (signalBarIndex === i) {
                if (!position) {
                    if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                        continue;
                    }
                    const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                    if (opened) {
                        if (entryCooldownActive && isDirectionOnCooldown(cooldown, opened.nextPosition.direction, i)) {
                            continue;
                        }
                        position = opened.nextPosition;
                        if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                            flipLossDirection.activeDirection = opened.nextPosition.direction;
                        }
                        capital -= opened.entryCommission;
                        if (doSnapshot && snapshotIndicators) {
                            const snapshotBarIndex = Math.max(0, i - executionShift);
                            currentSnapshot = captureTradeSnapshot(
                                data,
                                snapshotBarIndex,
                                indicatorSeries,
                                snapshotIndicators,
                                opened.nextPosition.direction,
                                signal.triggerPrice ?? signal.price
                            );
                        }
                        if (config.executionModel === 'next_open') {
                            processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize, reason) => {
                                const exitDirection = position!.direction;
                                const d = calculateTradeExitDetails(position!, exitPrice, exitSize, commissionRate);
                                capital += d.rawPnl - d.commission;
                                const trade: Trade = { id: ++tradeId, type: position!.direction, entryTime: position!.entryTime, entryPrice: position!.entryPrice, exitTime: candle.time, exitPrice, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: reason };
                                if (currentSnapshot) trade.entrySnapshot = currentSnapshot;
                                trades.push(trade);
                                position!.size -= d.size;
                                if (position!.size <= 0) { position = null; currentSnapshot = null; }
                                if (probationCooldownActive && reason === 'probation_fail') {
                                    armDirectionCooldown(cooldown, exitDirection, i, config.riskProbationCooldownBars);
                                }
                                if (lossStreakGuardActive && !position) {
                                    updateLossStreakCooldown(lossStreak, cooldown, exitDirection, d.totalPnl, i, config);
                                }
                                if (!position) {
                                    updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, exitDirection, d.totalPnl);
                                }
                            });
                            if (position) updatePositionState(candle, position, config, indicatorSeries.atr[i]);
                        }
                    }
                } else if (signal.type === directionToSignalType(position.direction === 'long' ? 'short' : 'long') && (config.allowSameBarExit || compareTime(signal.time, position.entryTime) !== 0)) {
                    const exitFractionRaw = Number.isFinite(signal.sizeFraction as number) ? Number(signal.sizeFraction) : 1;
                    const exitFraction = Math.max(0, Math.min(1, exitFractionRaw));
                    const exitSize = position.size * exitFraction;
                    if (exitSize <= 0) {
                        continue;
                    }
                    const details = calculateTradeExitDetails(position, signal.price, exitSize, commissionRate);
                    capital += details.rawPnl - details.commission;
                    const exitDirection = position.direction;
                    const sigTrade: Trade = { id: ++tradeId, type: position.direction, entryTime: position.entryTime, entryPrice: position.entryPrice, exitTime: candle.time, exitPrice: signal.price, pnl: details.totalPnl, pnlPercent: details.pnlPercent, size: details.size, fees: details.fees, exitReason: 'signal' };
                    if (currentSnapshot) sigTrade.entrySnapshot = currentSnapshot;
                    trades.push(sigTrade);
                    position.size -= details.size;
                    const fullyClosed = position.size <= 0;
                    if (fullyClosed) {
                        position = null;
                        currentSnapshot = null;
                        if (lossStreakGuardActive) {
                            updateLossStreakCooldown(lossStreak, cooldown, exitDirection, details.totalPnl, i, config);
                        }
                        updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, exitDirection, details.totalPnl);
                    }
                    const immediateReentryAllowed = fullyClosed && exitFraction >= 1 && (
                        tradeDirection === 'both'
                        || (
                            isLossStreakFlipTradeDirection(tradeDirection)
                            && flipLossDirection.activeDirection !== null
                            && signalToPositionDirection(signal.type) === flipLossDirection.activeDirection
                        )
                    );
                    if (immediateReentryAllowed) {
                        const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                        if (opened) {
                            if (entryCooldownActive && isDirectionOnCooldown(cooldown, opened.nextPosition.direction, i)) {
                                continue;
                            }
                            position = opened.nextPosition;
                            if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                                flipLossDirection.activeDirection = opened.nextPosition.direction;
                            }
                            capital -= opened.entryCommission;
                            if (doSnapshot && snapshotIndicators) {
                                const snapshotBarIndex = Math.max(0, i - executionShift);
                                currentSnapshot = captureTradeSnapshot(
                                    data,
                                    snapshotBarIndex,
                                    indicatorSeries,
                                    snapshotIndicators,
                                    opened.nextPosition.direction,
                                    signal.triggerPrice ?? signal.price
                                );
                            }
                            if (config.executionModel === 'next_open') {
                                processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize, reason) => {
                                    const exitDirection = position!.direction;
                                    const d = calculateTradeExitDetails(position!, exitPrice, exitSize, commissionRate);
                                    capital += d.rawPnl - d.commission;
                                    const trade: Trade = { id: ++tradeId, type: position!.direction, entryTime: position!.entryTime, entryPrice: position!.entryPrice, exitTime: candle.time, exitPrice, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: reason };
                                    if (currentSnapshot) trade.entrySnapshot = currentSnapshot;
                                    trades.push(trade);
                                    position!.size -= d.size;
                                    if (position!.size <= 0) { position = null; currentSnapshot = null; }
                                    if (probationCooldownActive && reason === 'probation_fail') {
                                        armDirectionCooldown(cooldown, exitDirection, i, config.riskProbationCooldownBars);
                                    }
                                    if (lossStreakGuardActive && !position) {
                                        updateLossStreakCooldown(lossStreak, cooldown, exitDirection, d.totalPnl, i, config);
                                    }
                                    if (!position) {
                                        updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, exitDirection, d.totalPnl);
                                    }
                                });
                                if (position) updatePositionState(candle, position, config, indicatorSeries.atr[i]);
                            }
                        }
                    }
                }
            }
        }
        equityCurve.push({ time: candle.time, value: capital + (position ? (candle.close - position.entryPrice) * position.size * directionFactorFor(position.direction) : 0) });
    }

    if (position && data.length > 0) {
        const candle = data[data.length - 1];
        const d = calculateTradeExitDetails(position, candle.close, position.size, commissionRate);
        capital += d.rawPnl - d.commission;
        const eodTrade: Trade = { id: ++tradeId, type: position.direction, entryTime: position.entryTime, entryPrice: position.entryPrice, exitTime: candle.time, exitPrice: candle.close, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: 'end_of_data', stopLossPrice: position.stopLossPrice, takeProfitPrice: position.takeProfitPrice };
        if (currentSnapshot) eodTrade.entrySnapshot = currentSnapshot;
        trades.push(eodTrade);
        if (equityCurve.length > 0) {
            equityCurve[equityCurve.length - 1] = { time: candle.time, value: capital };
        }
    }

    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);
    return calculateBacktestStats(trades, equityCurve, initialCapital, capital, maxDrawdown, maxDrawdownPercent);
}
