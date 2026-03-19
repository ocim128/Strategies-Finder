
import { BacktestResult, BacktestSettings, OHLCVData, Signal, Time, Trade } from '../../types/index';
import { ensureCleanData } from '../strategy-helpers';
import { NormalizedSettings, PositionState, PrecomputedIndicators, TradeSizingConfig } from '../../types/backtest';
import { applySlippage, compareTime, directionFactorFor, exitSideForDirection, getExecutionShift, getTimeIndex, isLossStreakFlipTradeDirection, needsSnapshotIndicators, normalizeBacktestSettings, normalizeTradeDirection, signalToPositionDirection, timeKey } from './backtest-utils';
import { calculateSharpeRatioFromEquitySamples } from '../performance-metrics';

import { prepareSignals } from './signal-preparation';
import { calculateTradeExitDetails, createEmptyBacktestResult, finalizeBacktestMetrics, calculateBacktestStats, calculateMaxDrawdown } from './position-stats';
import { precomputeIndicators, resolveIndicators } from './indicator-precompute';
import { buildPositionFromSignal } from './position-builder';
import { processPositionExits, updatePositionState } from './exit-handlers';
import { captureTradeSnapshot, computeSnapshotIndicators, SnapshotIndicators } from './snapshot-capture';
import {
    createAdaptiveTakeProfitState,
    registerAdaptiveTakeProfitPosition,
    resolveAdaptiveTakeProfitOverrides,
    updateAdaptiveTakeProfitPosition,
    updateAdaptiveTakeProfitHistory,
} from './adaptive-take-profit';
import { TradeSnapshot } from '../../types/index';

type AdaptiveTakeProfitHistoryUpdate = {
    position: PositionState;
    exitPrice: number;
    exitReason: NonNullable<Trade['exitReason']>;
    candle: OHLCVData;
    closedCapital: number;
};

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

type WinStreakRiskState = {
    consecutiveWins: number;
};

type FlipLossDirectionState = {
    longConsecutiveLosses: number;
    shortConsecutiveLosses: number;
    activeDirection: 'long' | 'short' | null;
    totalClosedTrades: number;
    flipCooldownTradesRemaining: number;
    hasFlipped: boolean;
};

function createWinStreakRiskState(): WinStreakRiskState {
    return {
        consecutiveWins: 0,
    };
}

type SmartSizingState = {
    recentVelocityScores: number[];
};

type SmartSizingPositionState = {
    initialTargetPercent: number | null;
    fastProgressHit: boolean;
};

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

function updateWinStreakRiskState(state: WinStreakRiskState, tradePnl: number): void {
    state.consecutiveWins = tradePnl > 0 ? state.consecutiveWins + 1 : 0;
}

function resolveWinStreakStopLossPercent(
    config: NormalizedSettings,
    state: WinStreakRiskState
): number | null {
    if (config.riskMode !== 'percentage') return null;
    if (config.riskWinStreakStopLossEnabled !== true) return null;
    if (config.riskWinStreakStopLossAfterWins <= 0) return null;
    if (config.riskWinStreakStopLossPercent <= 0) return null;
    if (state.consecutiveWins < config.riskWinStreakStopLossAfterWins) return null;
    return config.riskWinStreakStopLossPercent;
}

function buildPositionRiskOverrides(config: NormalizedSettings, state: WinStreakRiskState) {
    const overrideStopLossPercent = resolveWinStreakStopLossPercent(config, state);
    return {
        effectiveStopLossPercent: overrideStopLossPercent ?? config.stopLossPercent,
        enablePercentageStopLoss: config.riskMode === 'percentage'
            ? (config.stopLossEnabled || (overrideStopLossPercent ?? 0) > 0)
            : undefined,
    };
}

function createSmartSizingState(_initialCapital: number): SmartSizingState {
    return {
        recentVelocityScores: [],
    };
}

function pushRollingScore(target: number[], score: number | null, maxLength = 12): void {
    if (score === null || !Number.isFinite(score)) return;
    target.push(score);
    if (target.length > maxLength) {
        target.shift();
    }
}

function updateSmartSizingState(state: SmartSizingState, velocityScore: number | null): void {
    pushRollingScore(state.recentVelocityScores, velocityScore);
}

function greaterThanOrNearlyEqual(left: number, right: number): boolean {
    const tolerance = Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right), 1) * 1e-12);
    return left > right || Math.abs(left - right) <= tolerance;
}

function resolveInitialTargetPercent(position: PositionState): number | null {
    if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0) return null;
    if (!Number.isFinite(position.takeProfitPrice) || position.takeProfitPrice === null) return null;
    return Math.abs(((position.takeProfitPrice - position.entryPrice) / position.entryPrice) * 100);
}

function createSmartSizingPositionState(): WeakMap<PositionState, SmartSizingPositionState> {
    return new WeakMap<PositionState, SmartSizingPositionState>();
}

function registerSmartSizingPosition(
    smartSizingPositionState: WeakMap<PositionState, SmartSizingPositionState>,
    position: PositionState
): void {
    smartSizingPositionState.set(position, {
        initialTargetPercent: resolveInitialTargetPercent(position),
        fastProgressHit: false,
    });
}

function updateSmartSizingPosition(
    config: NormalizedSettings,
    smartSizingPositionState: WeakMap<PositionState, SmartSizingPositionState>,
    position: PositionState,
    candle: OHLCVData
): void {
    const state = smartSizingPositionState.get(position);
    if (!state) return;

    const fastWindow = Math.max(1, config.takeProfitVelocityFastBars);
    if (state.fastProgressHit || state.initialTargetPercent === null || state.initialTargetPercent <= 0 || position.barsInTrade > fastWindow) return;

    const favorablePrice = position.direction === 'short'
        ? Math.min(position.extremePrice, candle.low)
        : Math.max(position.extremePrice, candle.high);
    const favorableMovePercent = directionFactorFor(position.direction) * ((favorablePrice - position.entryPrice) / position.entryPrice) * 100;
    const progressPercent = (Math.max(0, favorableMovePercent) / state.initialTargetPercent) * 100;
    if (greaterThanOrNearlyEqual(progressPercent, config.takeProfitVelocityProgressPercent)) {
        state.fastProgressHit = true;
    }
}

function resolveVelocitySizingScore(
    smartSizingPositionState: WeakMap<PositionState, SmartSizingPositionState>,
    position: PositionState
): number | null {
    const state = smartSizingPositionState.get(position);
    smartSizingPositionState.delete(position);
    if (!state || state.initialTargetPercent === null || state.initialTargetPercent <= 0) {
        return null;
    }
    if (position.realizedPnl > 0) {
        return state.fastProgressHit ? 1 : 0.35;
    }
    return state.fastProgressHit ? -0.15 : -0.75;
}

function buildPercentageTakeProfitOverrides(
    config: NormalizedSettings,
    positionDirection: 'long' | 'short',
    entryPrice: number,
    entryBarIndex: number,
    adaptiveTakeProfitState: ReturnType<typeof createAdaptiveTakeProfitState>
) {
    const resolved = resolveAdaptiveTakeProfitOverrides(
        config,
        adaptiveTakeProfitState,
        positionDirection,
        entryPrice,
        entryBarIndex
    );

    if (!resolved) {
        return {};
    }

    return {
        effectiveTakeProfitPercent: resolved.takeProfitPercent,
    };
}

function combineCompactResults(
    data: OHLCVData[],
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

    const sharpeRatio = calculateSharpeRatioFromEquitySamples(data, combinedEquity, len);

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

    // Allocate per-bar equity buffers for proper combined drawdown calculation
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

    return combineCompactResults(data, initialCapital, longResult, shortResult, longEquity, shortEquity);
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
    return calculateBacktestStats(
        mergedTrades,
        equityCurve,
        initialCapital,
        finalCapital,
        maxDrawdown,
        maxDrawdownPercent
    );
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
    equityOut?: Float64Array,
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
    const positions: PositionState[] = [];
    const maxOpenTrades = config.maxOpenTrades;
    let totalTrades = 0, winningTrades = 0, totalProfit = 0, totalLoss = 0;
    let peakEquity = initialCapital, maxDrawdown = 0, maxDrawdownPercent = 0;
    let signalIdx = 0;
    const compactEquity = equityOut ?? new Float64Array(data.length);

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    const winStreakRisk = createWinStreakRiskState();
    const flipLossDirection = createFlipLossDirectionState();
    const smartSizingState = createSmartSizingState(initialCapital);
    const smartSizingPositionState = createSmartSizingPositionState();
    const warmUpEnabled = config.warmUpEntryEnabled;
    let pendingEntry: Signal | null = null;
    const adaptiveTakeProfitState = createAdaptiveTakeProfitState(data, config, indicatorSeries, initialCapital);
    const pendingAdaptiveTakeProfitUpdates: AdaptiveTakeProfitHistoryUpdate[] = [];
    const pendingAdaptiveTakeProfitExits = new Map<PositionState, NonNullable<Trade['exitReason']>>();

    const queueAdaptiveTakeProfitUpdate = (
        position: PositionState,
        exitPrice: number,
        exitReason: NonNullable<Trade['exitReason']>,
        candle: OHLCVData,
        closedCapital: number
    ) => {
        pendingAdaptiveTakeProfitUpdates.push({ position, exitPrice, exitReason, candle, closedCapital });
    };

    const finalizeClosedPosition = (
        position: PositionState,
        candle: OHLCVData,
        exitPrice: number,
        exitReason: NonNullable<Trade['exitReason']>
    ) => {
        queueAdaptiveTakeProfitUpdate(position, exitPrice, exitReason, candle, capital);
        updateWinStreakRiskState(winStreakRisk, position.realizedPnl);
        updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, position.direction, position.realizedPnl);
        updateSmartSizingState(smartSizingState, resolveVelocitySizingScore(smartSizingPositionState, position));
    };

    const flushAdaptiveTakeProfitUpdates = () => {
        while (pendingAdaptiveTakeProfitUpdates.length > 0) {
            const update = pendingAdaptiveTakeProfitUpdates.shift()!;
            updateAdaptiveTakeProfitHistory(
                config,
                adaptiveTakeProfitState,
                update.position,
                update.exitPrice,
                update.exitReason,
                update.candle,
                update.closedCapital
            );
        }
    };

    const applyAdaptiveTakeProfitAfterBar = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        const adaptiveExit = updateAdaptiveTakeProfitPosition(config, adaptiveTakeProfitState, pos, candle, barIndex);
        if (!adaptiveExit || positions.indexOf(pos) < 0) {
            return;
        }

        if (adaptiveExit.deferExecutionToNextBarOpen) {
            pendingAdaptiveTakeProfitExits.set(pos, adaptiveExit.exitReason);
            return;
        }

        const exitPrice = applySlippage(adaptiveExit.exitPrice, exitSideForDirection(pos.direction), slippageRate);
        recordExit(pos, exitPrice, pos.size);
        if (positions.indexOf(pos) < 0) {
            finalizeClosedPosition(pos, candle, exitPrice, adaptiveExit.exitReason);
        }
    };

    const recordExit = (pos: PositionState, exitPrice: number, exitSize: number) => {
        const details = calculateTradeExitDetails(pos, exitPrice, exitSize, commissionRate);
        capital += details.rawPnl - details.commission;
        totalTrades++;
        if (details.totalPnl > 0) { winningTrades++; totalProfit += details.totalPnl; } else { totalLoss += Math.abs(details.totalPnl); }
        pos.realizedPnl += details.totalPnl;
        pos.size -= details.size;
        if (pos.size <= 0) {
            const idx = positions.indexOf(pos);
            if (idx >= 0) positions.splice(idx, 1);
            pendingAdaptiveTakeProfitExits.delete(pos);
        }
        return details;
    };

    const tryProcessExitsAfterEntry = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
        const exitTrigger = processPositionExits(candle, pos, config, slippageRate);
        if (exitTrigger) {
            recordExit(pos, exitTrigger.exitPrice, exitTrigger.exitSize);
            if (positions.indexOf(pos) < 0) {
                finalizeClosedPosition(pos, candle, exitTrigger.exitPrice, exitTrigger.exitReason);
            }
        }
        if (positions.indexOf(pos) >= 0) {
            updatePositionState(candle, pos, config, indicatorSeries.atr[barIndex]);
            applyAdaptiveTakeProfitAfterBar(pos, candle, barIndex);
        }
    };

    const finalizeEntryBarState = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        if (config.executionModel !== 'next_open') return;
        if (config.allowSameBarExit) {
            tryProcessExitsAfterEntry(pos, candle, barIndex);
            return;
        }

        const stopLossTrigger = processPositionExits(candle, pos, config, slippageRate, { stopLossOnly: true });
        if (stopLossTrigger) {
            recordExit(pos, stopLossTrigger.exitPrice, stopLossTrigger.exitSize);
            if (positions.indexOf(pos) < 0) {
                finalizeClosedPosition(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
            }
        }
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const pendingReason = pendingAdaptiveTakeProfitExits.get(pos);
            if (!pendingReason) continue;

            pendingAdaptiveTakeProfitExits.delete(pos);
            const exitPrice = applySlippage(candle.open, exitSideForDirection(pos.direction), slippageRate);
            recordExit(pos, exitPrice, pos.size);
            if (positions.indexOf(pos) < 0) {
                finalizeClosedPosition(pos, candle, exitPrice, pendingReason);
            }
        }

        // Process exits for ALL open positions (iterate backwards for safe splice)
        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            pos.barsInTrade += 1;
            updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
            const exitTrigger = processPositionExits(candle, pos, config, slippageRate);
            if (exitTrigger) {
                recordExit(pos, exitTrigger.exitPrice, exitTrigger.exitSize);
                if (positions.indexOf(pos) < 0) {
                    finalizeClosedPosition(pos, candle, exitTrigger.exitPrice, exitTrigger.exitReason);
                }
            }
            if (positions.indexOf(pos) >= 0) {
                updatePositionState(candle, pos, config, indicatorSeries.atr[i]);
                applyAdaptiveTakeProfitAfterBar(pos, candle, i);
            }
        }

        // Warm-up: if a position just closed and we have a pending entry, execute it now
        if (warmUpEnabled && pendingEntry && positions.length < maxOpenTrades) {
            const warmUpSignal: Signal = Object.assign({}, pendingEntry, { price: candle.open, time: candle.time });
            if (canEnterLossFlipDirection(tradeDirection, flipLossDirection, warmUpSignal)) {
                const opened = buildPositionFromSignal({
                    signal: warmUpSignal,
                    barIndex: i,
                    capital,
                    initialCapital,
                    positionSizePercent,
                    commissionRate,
                    slippageRate,
                    settings: config,
                    data,
                    atrArray: indicatorSeries.atr,
                    tradeDirection,
                    sizingMode,
                    fixedTradeAmount,
                    smartSizingState,
                    ...buildPositionRiskOverrides(config, winStreakRisk),
                    ...buildPercentageTakeProfitOverrides(
                        config,
                        signalToPositionDirection(warmUpSignal.type),
                        warmUpSignal.price,
                        i,
                        adaptiveTakeProfitState
                    ),
                });
                if (opened) {
                    positions.push(opened.nextPosition);
                    registerSmartSizingPosition(smartSizingPositionState, opened.nextPosition);
                    registerAdaptiveTakeProfitPosition(config, adaptiveTakeProfitState, opened.nextPosition, i);
                    if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                        flipLossDirection.activeDirection = opened.nextPosition.direction;
                    }
                    capital -= opened.entryCommission;
                    finalizeEntryBarState(opened.nextPosition, candle, i);
                }
            }
            pendingEntry = null;
        } else if (warmUpEnabled) {
            pendingEntry = null; // Expire after 1 bar even if not used
        }

        while (signalIdx < preparedSignals.length && preparedSignalBarIndexes[signalIdx] <= i) {
            const signalBarIndex = preparedSignalBarIndexes[signalIdx];
            const signal = preparedSignals[signalIdx++];
            if (signalBarIndex === i) {
                // Check for signal exit: does this signal close an existing opposite-direction position?
                const signalDir = signalToPositionDirection(signal.type);
                const oppositeDir: 'long' | 'short' = signalDir === 'long' ? 'short' : 'long';
                const exitTarget = positions.find(p => p.direction === oppositeDir && (config.allowSameBarExit || compareTime(signal.time, p.entryTime) !== 0));

                if (!exitTarget && positions.length < maxOpenTrades) {
                    // New entry (no opposite position to close, and we have room)
                    if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                        continue;
                    }
                    const opened = buildPositionFromSignal({
                        signal,
                        barIndex: i,
                        capital,
                        initialCapital,
                        positionSizePercent,
                        commissionRate,
                        slippageRate,
                        settings: config,
                        data,
                        atrArray: indicatorSeries.atr,
                        tradeDirection,
                        sizingMode,
                        fixedTradeAmount,
                        smartSizingState,
                        ...buildPositionRiskOverrides(config, winStreakRisk),
                        ...buildPercentageTakeProfitOverrides(
                            config,
                            signalToPositionDirection(signal.type),
                            signal.price,
                            i,
                            adaptiveTakeProfitState
                        ),
                    });
                    if (opened) {
                        positions.push(opened.nextPosition);
                        registerSmartSizingPosition(smartSizingPositionState, opened.nextPosition);
                        registerAdaptiveTakeProfitPosition(config, adaptiveTakeProfitState, opened.nextPosition, i);
                        if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                            flipLossDirection.activeDirection = opened.nextPosition.direction;
                        }
                        capital -= opened.entryCommission;
                        finalizeEntryBarState(opened.nextPosition, candle, i);
                    }
                } else if (!exitTarget && positions.length >= maxOpenTrades && warmUpEnabled) {
                    // Capacity full and no exit target — queue as pending warm-up entry
                    pendingEntry = signal;
                } else if (exitTarget) {
                    // Signal exit: close the opposite-direction position
                    const exitFractionRaw = Number.isFinite(signal.sizeFraction as number) ? Number(signal.sizeFraction) : 1;
                    const exitFraction = Math.max(0, Math.min(1, exitFractionRaw));
                    const exitSize = exitTarget.size * exitFraction;
                    if (exitSize <= 0) {
                        continue;
                    }
                    const wasPartial = exitFraction < 1;
                    recordExit(exitTarget, signal.price, exitSize);
                    if (positions.indexOf(exitTarget) < 0) {
                        finalizeClosedPosition(exitTarget, candle, signal.price, 'signal');
                    }
                    const fullyClosed = positions.indexOf(exitTarget) < 0;
                    const immediateReentryAllowed = fullyClosed && !wasPartial && (
                        tradeDirection === 'both'
                        || (
                            isLossStreakFlipTradeDirection(tradeDirection)
                            && flipLossDirection.activeDirection !== null
                            && signalToPositionDirection(signal.type) === flipLossDirection.activeDirection
                        )
                    );
                    if (immediateReentryAllowed && positions.length < maxOpenTrades) {
                        const opened = buildPositionFromSignal({
                            signal,
                            barIndex: i,
                            capital,
                            initialCapital,
                            positionSizePercent,
                            commissionRate,
                            slippageRate,
                            settings: config,
                            data,
                            atrArray: indicatorSeries.atr,
                            tradeDirection,
                            sizingMode,
                            fixedTradeAmount,
                            smartSizingState,
                            ...buildPositionRiskOverrides(config, winStreakRisk),
                            ...buildPercentageTakeProfitOverrides(
                                config,
                                signalToPositionDirection(signal.type),
                                signal.price,
                                i,
                                adaptiveTakeProfitState
                            ),
                        });
                        if (opened) {
                            positions.push(opened.nextPosition);
                            registerSmartSizingPosition(smartSizingPositionState, opened.nextPosition);
                            registerAdaptiveTakeProfitPosition(config, adaptiveTakeProfitState, opened.nextPosition, i);
                            if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                                flipLossDirection.activeDirection = opened.nextPosition.direction;
                            }
                            capital -= opened.entryCommission;
                            finalizeEntryBarState(opened.nextPosition, candle, i);
                        }
                    }
                }
            }
        }

        flushAdaptiveTakeProfitUpdates();

        // Equity: capital + sum of unrealized PnL across all open positions
        let unrealizedPnl = 0;
        for (let p = 0; p < positions.length; p++) {
            unrealizedPnl += (candle.close - positions[p].entryPrice) * positions[p].size * directionFactorFor(positions[p].direction);
        }
        const equity = capital + unrealizedPnl;
        compactEquity[i] = equity;
        if (equity > peakEquity) peakEquity = equity; else {
            const dd = peakEquity - equity;
            if (dd > maxDrawdown) { maxDrawdown = dd; maxDrawdownPercent = (dd / peakEquity) * 100; }
        }
    }

    // Match full backtest behavior: close any remaining positions at the final close.
    if (positions.length > 0 && data.length > 0) {
        const finalCandle = data[data.length - 1];
        while (positions.length > 0) {
            recordExit(positions[0], finalCandle.close, positions[0].size);
        }
        const finalEquity = capital;
        compactEquity[data.length - 1] = finalEquity;
        if (finalEquity > peakEquity) peakEquity = finalEquity; else {
            const dd = peakEquity - finalEquity;
            if (dd > maxDrawdown) { maxDrawdown = dd; maxDrawdownPercent = (dd / peakEquity) * 100; }
        }
    }

    const sharpeRatio = calculateSharpeRatioFromEquitySamples(data, compactEquity, data.length);
    return finalizeBacktestMetrics(initialCapital, capital, totalTrades, winningTrades, totalProfit, totalLoss, sharpeRatio, maxDrawdown, maxDrawdownPercent) as BacktestResult;
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

    let capital = initialCapital, tradeId = 0, signalIdx = 0;
    const positions: PositionState[] = [];
    const snapshots = new Map<PositionState, TradeSnapshot | null>();
    const maxOpenTrades = config.maxOpenTrades;
    const trades: Trade[] = [];
    const equityCurve: { time: Time; value: number }[] = [];
    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    const winStreakRisk = createWinStreakRiskState();
    const flipLossDirection = createFlipLossDirectionState();
    const smartSizingState = createSmartSizingState(initialCapital);
    const smartSizingPositionState = createSmartSizingPositionState();
    const warmUpEnabled = config.warmUpEntryEnabled;
    let pendingEntry: Signal | null = null;
    const adaptiveTakeProfitState = createAdaptiveTakeProfitState(data, config, indicatorSeries, initialCapital);
    const pendingAdaptiveTakeProfitUpdates: AdaptiveTakeProfitHistoryUpdate[] = [];
    const pendingAdaptiveTakeProfitExits = new Map<PositionState, NonNullable<Trade['exitReason']>>();

    const queueAdaptiveTakeProfitUpdate = (
        position: PositionState,
        exitPrice: number,
        exitReason: NonNullable<Trade['exitReason']>,
        candle: OHLCVData,
        closedCapital: number
    ) => {
        pendingAdaptiveTakeProfitUpdates.push({ position, exitPrice, exitReason, candle, closedCapital });
    };

    const finalizeClosedPositionFull = (
        position: PositionState,
        candle: OHLCVData,
        exitPrice: number,
        exitReason: NonNullable<Trade['exitReason']>
    ) => {
        queueAdaptiveTakeProfitUpdate(position, exitPrice, exitReason, candle, capital);
        updateWinStreakRiskState(winStreakRisk, position.realizedPnl);
        updateLossFlipDirectionAfterClose(tradeDirection, config, flipLossDirection, position.direction, position.realizedPnl);
        updateSmartSizingState(smartSizingState, resolveVelocitySizingScore(smartSizingPositionState, position));
    };

    const flushAdaptiveTakeProfitUpdates = () => {
        while (pendingAdaptiveTakeProfitUpdates.length > 0) {
            const update = pendingAdaptiveTakeProfitUpdates.shift()!;
            updateAdaptiveTakeProfitHistory(
                config,
                adaptiveTakeProfitState,
                update.position,
                update.exitPrice,
                update.exitReason,
                update.candle,
                update.closedCapital
            );
        }
    };

    const applyAdaptiveTakeProfitAfterBarFull = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        const adaptiveExit = updateAdaptiveTakeProfitPosition(config, adaptiveTakeProfitState, pos, candle, barIndex);
        if (!adaptiveExit || positions.indexOf(pos) < 0) {
            return;
        }

        if (adaptiveExit.deferExecutionToNextBarOpen) {
            pendingAdaptiveTakeProfitExits.set(pos, adaptiveExit.exitReason);
            return;
        }

        const exitPrice = applySlippage(adaptiveExit.exitPrice, exitSideForDirection(pos.direction), slippageRate);
        recordExitFull(pos, candle, exitPrice, pos.size, adaptiveExit.exitReason);
        if (positions.indexOf(pos) < 0) {
            finalizeClosedPositionFull(pos, candle, exitPrice, adaptiveExit.exitReason);
        }
    };

    const recordExitFull = (pos: PositionState, candle: OHLCVData, exitPrice: number, exitSize: number, reason: Trade['exitReason']) => {
        const d = calculateTradeExitDetails(pos, exitPrice, exitSize, commissionRate);
        capital += d.rawPnl - d.commission;
        const snap = snapshots.get(pos) ?? null;
        const trade: Trade = {
            id: ++tradeId,
            type: pos.direction,
            entryTime: pos.entryTime,
            entryPrice: pos.entryPrice,
            exitTime: candle.time,
            exitPrice,
            pnl: d.totalPnl,
            pnlPercent: d.pnlPercent,
            size: d.size,
            fees: d.fees,
            exitReason: reason,
            stopLossPrice: pos.stopLossPrice,
            takeProfitPrice: pos.takeProfitPrice,
        };
        if (pos.warmUpEntry) trade.entryMode = 'warm_up';
        if (snap) trade.entrySnapshot = snap;
        trades.push(trade);
        pos.realizedPnl += d.totalPnl;
        pos.size -= d.size;
        if (pos.size <= 0) {
            const idx = positions.indexOf(pos);
            if (idx >= 0) positions.splice(idx, 1);
            snapshots.delete(pos);
            pendingAdaptiveTakeProfitExits.delete(pos);
        }
        return d;
    };

    const captureSnapshotForPosition = (pos: PositionState, barIndex: number, signal: Signal) => {
        if (doSnapshot && snapshotIndicators) {
            const snapshotBarIndex = Math.max(0, barIndex - executionShift);
            snapshots.set(pos, captureTradeSnapshot(data, snapshotBarIndex, indicatorSeries, snapshotIndicators, pos.direction, signal.triggerPrice ?? signal.price));
        }
    };

    const tryProcessExitsAfterEntryFull = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
        const exitTrigger = processPositionExits(candle, pos, config, slippageRate);
        if (exitTrigger) {
            recordExitFull(pos, candle, exitTrigger.exitPrice, exitTrigger.exitSize, exitTrigger.exitReason);
            if (positions.indexOf(pos) < 0) {
                finalizeClosedPositionFull(pos, candle, exitTrigger.exitPrice, exitTrigger.exitReason);
            }
        }
        if (positions.indexOf(pos) >= 0) {
            updatePositionState(candle, pos, config, indicatorSeries.atr[barIndex]);
            applyAdaptiveTakeProfitAfterBarFull(pos, candle, barIndex);
        }
    };

    const finalizeEntryBarStateFull = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        if (config.executionModel !== 'next_open') return;
        if (config.allowSameBarExit) {
            tryProcessExitsAfterEntryFull(pos, candle, barIndex);
            return;
        }

        const stopLossTrigger = processPositionExits(candle, pos, config, slippageRate, { stopLossOnly: true });
        if (stopLossTrigger) {
            recordExitFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitSize, stopLossTrigger.exitReason);
            if (positions.indexOf(pos) < 0) {
                finalizeClosedPositionFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
            }
        }
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const pendingReason = pendingAdaptiveTakeProfitExits.get(pos);
            if (!pendingReason) continue;

            pendingAdaptiveTakeProfitExits.delete(pos);
            const exitPrice = applySlippage(candle.open, exitSideForDirection(pos.direction), slippageRate);
            recordExitFull(pos, candle, exitPrice, pos.size, pendingReason);
            if (positions.indexOf(pos) < 0) {
                finalizeClosedPositionFull(pos, candle, exitPrice, pendingReason);
            }
        }

        // Process exits for ALL open positions
        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            pos.barsInTrade += 1;
            updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
            const exitTrigger = processPositionExits(candle, pos, config, slippageRate);
            if (exitTrigger) {
                recordExitFull(pos, candle, exitTrigger.exitPrice, exitTrigger.exitSize, exitTrigger.exitReason);
                if (positions.indexOf(pos) < 0) {
                    finalizeClosedPositionFull(pos, candle, exitTrigger.exitPrice, exitTrigger.exitReason);
                }
            }
            if (positions.indexOf(pos) >= 0) {
                updatePositionState(candle, pos, config, indicatorSeries.atr[i]);
                applyAdaptiveTakeProfitAfterBarFull(pos, candle, i);
            }
        }

        // Warm-up: if a position just closed and we have a pending entry, execute it now
        if (warmUpEnabled && pendingEntry && positions.length < maxOpenTrades) {
            const warmUpSignal: Signal = Object.assign({}, pendingEntry, { price: candle.open, time: candle.time });
            if (canEnterLossFlipDirection(tradeDirection, flipLossDirection, warmUpSignal)) {
                const opened = buildPositionFromSignal({
                    signal: warmUpSignal,
                    barIndex: i,
                    capital,
                    initialCapital,
                    positionSizePercent,
                    commissionRate,
                    slippageRate,
                    settings: config,
                    data,
                    atrArray: indicatorSeries.atr,
                    tradeDirection,
                    sizingMode,
                    fixedTradeAmount,
                    smartSizingState,
                    ...buildPositionRiskOverrides(config, winStreakRisk),
                    ...buildPercentageTakeProfitOverrides(
                        config,
                        signalToPositionDirection(warmUpSignal.type),
                        warmUpSignal.price,
                        i,
                        adaptiveTakeProfitState
                    ),
                });
                if (opened) {
                    positions.push(opened.nextPosition);
                    registerSmartSizingPosition(smartSizingPositionState, opened.nextPosition);
                    registerAdaptiveTakeProfitPosition(config, adaptiveTakeProfitState, opened.nextPosition, i);
                    opened.nextPosition.warmUpEntry = true;
                    if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                        flipLossDirection.activeDirection = opened.nextPosition.direction;
                    }
                    capital -= opened.entryCommission;
                    captureSnapshotForPosition(opened.nextPosition, i, warmUpSignal);
                    finalizeEntryBarStateFull(opened.nextPosition, candle, i);
                }
            }
            pendingEntry = null;
        } else if (warmUpEnabled) {
            pendingEntry = null;
        }

        while (signalIdx < preparedSignals.length && preparedSignalBarIndexes[signalIdx] <= i) {
            const signalBarIndex = preparedSignalBarIndexes[signalIdx];
            const signal = preparedSignals[signalIdx++];
            if (signalBarIndex === i) {
                const signalDir = signalToPositionDirection(signal.type);
                const oppositeDir: 'long' | 'short' = signalDir === 'long' ? 'short' : 'long';
                const exitTarget = positions.find(p => p.direction === oppositeDir && (config.allowSameBarExit || compareTime(signal.time, p.entryTime) !== 0));

                if (!exitTarget && positions.length < maxOpenTrades) {
                    // New entry
                    if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                        continue;
                    }
                    const opened = buildPositionFromSignal({
                        signal,
                        barIndex: i,
                        capital,
                        initialCapital,
                        positionSizePercent,
                        commissionRate,
                        slippageRate,
                        settings: config,
                        data,
                        atrArray: indicatorSeries.atr,
                        tradeDirection,
                        sizingMode,
                        fixedTradeAmount,
                        smartSizingState,
                        ...buildPositionRiskOverrides(config, winStreakRisk),
                        ...buildPercentageTakeProfitOverrides(
                            config,
                            signalToPositionDirection(signal.type),
                            signal.price,
                            i,
                            adaptiveTakeProfitState
                        ),
                    });
                    if (opened) {
                        positions.push(opened.nextPosition);
                        registerSmartSizingPosition(smartSizingPositionState, opened.nextPosition);
                        registerAdaptiveTakeProfitPosition(config, adaptiveTakeProfitState, opened.nextPosition, i);
                        if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                            flipLossDirection.activeDirection = opened.nextPosition.direction;
                        }
                        capital -= opened.entryCommission;
                        captureSnapshotForPosition(opened.nextPosition, i, signal);
                        finalizeEntryBarStateFull(opened.nextPosition, candle, i);
                    }
                } else if (!exitTarget && positions.length >= maxOpenTrades && warmUpEnabled) {
                    pendingEntry = signal;
                } else if (exitTarget) {
                    // Signal exit
                    const exitFractionRaw = Number.isFinite(signal.sizeFraction as number) ? Number(signal.sizeFraction) : 1;
                    const exitFraction = Math.max(0, Math.min(1, exitFractionRaw));
                    const exitSize = exitTarget.size * exitFraction;
                    if (exitSize <= 0) continue;

                    recordExitFull(exitTarget, candle, signal.price, exitSize, 'signal');
                    const fullyClosed = positions.indexOf(exitTarget) < 0;
                    if (fullyClosed) {
                        finalizeClosedPositionFull(exitTarget, candle, signal.price, 'signal');
                    }
                    const immediateReentryAllowed = fullyClosed && exitFraction >= 1 && (
                        tradeDirection === 'both'
                        || (
                            isLossStreakFlipTradeDirection(tradeDirection)
                            && flipLossDirection.activeDirection !== null
                            && signalToPositionDirection(signal.type) === flipLossDirection.activeDirection
                        )
                    );
                    if (immediateReentryAllowed && positions.length < maxOpenTrades) {
                        const opened = buildPositionFromSignal({
                            signal,
                            barIndex: i,
                            capital,
                            initialCapital,
                            positionSizePercent,
                            commissionRate,
                            slippageRate,
                            settings: config,
                            data,
                            atrArray: indicatorSeries.atr,
                            tradeDirection,
                            sizingMode,
                            fixedTradeAmount,
                            smartSizingState,
                            ...buildPositionRiskOverrides(config, winStreakRisk),
                            ...buildPercentageTakeProfitOverrides(
                                config,
                                signalToPositionDirection(signal.type),
                                signal.price,
                                i,
                                adaptiveTakeProfitState
                            ),
                        });
                        if (opened) {
                            positions.push(opened.nextPosition);
                            registerSmartSizingPosition(smartSizingPositionState, opened.nextPosition);
                            registerAdaptiveTakeProfitPosition(config, adaptiveTakeProfitState, opened.nextPosition, i);
                            if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
                                flipLossDirection.activeDirection = opened.nextPosition.direction;
                            }
                            capital -= opened.entryCommission;
                            captureSnapshotForPosition(opened.nextPosition, i, signal);
                            finalizeEntryBarStateFull(opened.nextPosition, candle, i);
                        }
                    }
                }
            }
        }

        flushAdaptiveTakeProfitUpdates();

        let unrealizedPnl = 0;
        for (let p = 0; p < positions.length; p++) {
            unrealizedPnl += (candle.close - positions[p].entryPrice) * positions[p].size * directionFactorFor(positions[p].direction);
        }
        equityCurve.push({ time: candle.time, value: capital + unrealizedPnl });
    }

    if (positions.length > 0 && data.length > 0) {
        const candle = data[data.length - 1];
        while (positions.length > 0) {
            const pos = positions[0];
            const d = calculateTradeExitDetails(pos, candle.close, pos.size, commissionRate);
            capital += d.rawPnl - d.commission;
            const snap = snapshots.get(pos) ?? null;
            const eodTrade: Trade = { id: ++tradeId, type: pos.direction, entryTime: pos.entryTime, entryPrice: pos.entryPrice, exitTime: candle.time, exitPrice: candle.close, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: 'end_of_data', stopLossPrice: pos.stopLossPrice, takeProfitPrice: pos.takeProfitPrice };
            if (pos.warmUpEntry) eodTrade.entryMode = 'warm_up';
            if (snap) eodTrade.entrySnapshot = snap;
            trades.push(eodTrade);
            positions.splice(0, 1);
            snapshots.delete(pos);
        }
        if (equityCurve.length > 0) {
            equityCurve[equityCurve.length - 1] = { time: candle.time, value: capital };
        }
    }


    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);
    return calculateBacktestStats(trades, equityCurve, initialCapital, capital, maxDrawdown, maxDrawdownPercent);
}
