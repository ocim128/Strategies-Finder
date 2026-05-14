
import { BacktestResult, BacktestSettings, OHLCVData, Signal, Time, Trade } from '../../types/index';
import { ensureCleanData } from '../strategy-helpers';
import { NormalizedSettings, PositionState, PrecomputedIndicators, TradeSizingConfig, TradeSizingMode } from '../../types/backtest';
import { applySlippage, compareTime, directionFactorFor, exitSideForDirection, getTimeIndex, isLossStreakFlipTradeDirection, normalizeBacktestSettings, normalizeTradeDirection, signalToPositionDirection, timeKey } from './backtest-utils';
import { calculateSharpeRatioFromEquitySamples } from '../performance-metrics';

import { prepareSignals } from './signal-preparation';
import { calculateTradeExitDetails, createEmptyBacktestResult, finalizeBacktestMetrics, calculateBacktestStats, calculateMaxDrawdown } from './position-stats';
import { precomputeIndicators, resolveIndicators } from './indicator-precompute';
import { buildPositionFromSignal, type SmartSizingState } from './position-builder';
import { canExitAfterMinimumHold, processPositionExits, updatePositionState } from './exit-handlers';
import {
    createAdaptiveTakeProfitState,
    registerAdaptiveTakeProfitPosition,
    resolveAdaptiveTakeProfitOverrides,
    updateAdaptiveTakeProfitPosition,
    updateAdaptiveTakeProfitHistory,
} from './adaptive-take-profit';
import { createKellySizingState, updateKellyState } from '../sizing/kelly-criterion';
import { createMartingaleState, updateMartingaleState } from '../sizing/martingale';
import { createOptimalFState, updateOptimalFState } from '../sizing/optimal-f';

type AdaptiveTakeProfitHistoryUpdate = {
    position: PositionState;
    exitPrice: number;
    exitReason: NonNullable<Trade['exitReason']>;
    candle: OHLCVData;
    closedCapital: number;
};

export { precomputeIndicators };

type EntryBuildContext = {
    initialCapital: number;
    positionSizePercent: number;
    commissionRate: number;
    slippageRate: number;
    settings: NormalizedSettings;
    data: OHLCVData[];
    atrArray: (number | null)[];
    tradeDirection: ReturnType<typeof normalizeTradeDirection>;
    sizingMode: TradeSizingMode;
    fixedTradeAmount: number;
    advancedSizing: TradeSizingConfig["advancedSizing"];
    smartSizingState: SmartSizingState;
    winStreakRisk: WinStreakRiskState;
    adaptiveTakeProfitState: ReturnType<typeof createAdaptiveTakeProfitState>;
};

function buildEntryPosition(
    context: EntryBuildContext,
    signal: Signal,
    barIndex: number,
    capital: number
) {
    return buildPositionFromSignal({
        signal,
        barIndex,
        capital,
        initialCapital: context.initialCapital,
        positionSizePercent: context.positionSizePercent,
        commissionRate: context.commissionRate,
        slippageRate: context.slippageRate,
        settings: context.settings,
        data: context.data,
        atrArray: context.atrArray,
        tradeDirection: context.tradeDirection,
        sizingMode: context.sizingMode,
        fixedTradeAmount: context.fixedTradeAmount,
        advancedSizing: context.advancedSizing,
        smartSizingState: context.smartSizingState,
        ...buildPositionRiskOverrides(context.settings, context.winStreakRisk),
        ...buildPercentageTakeProfitOverrides(
            context.settings,
            signalToPositionDirection(signal.type),
            signal.price,
            // For next_open, the execution bar's full candle is not yet known at entry.
            // Use the last closed bar (barIndex - 1) to match position-builder's ATR source.
            context.settings.executionModel === 'next_open' ? barIndex - 1 : barIndex,
            context.adaptiveTakeProfitState
        ),
    });
}

function registerOpenedPosition(args: {
    position: PositionState;
    positions: PositionState[];
    currentBarOpenedPositions?: Set<PositionState>;
    smartSizingPositionState: WeakMap<PositionState, SmartSizingPositionState>;
    settings: NormalizedSettings;
    adaptiveTakeProfitState: ReturnType<typeof createAdaptiveTakeProfitState>;
    tradeDirection: ReturnType<typeof normalizeTradeDirection>;
    flipLossDirection: FlipLossDirectionState;
    barIndex: number;
}): void {
    const {
        position,
        positions,
        currentBarOpenedPositions,
        smartSizingPositionState,
        settings,
        adaptiveTakeProfitState,
        tradeDirection,
        flipLossDirection,
        barIndex,
    } = args;
    positions.push(position);
    currentBarOpenedPositions?.add(position);
    registerSmartSizingPosition(smartSizingPositionState, position);
    registerAdaptiveTakeProfitPosition(settings, adaptiveTakeProfitState, position, barIndex);
    if (isLossStreakFlipTradeDirection(tradeDirection) && flipLossDirection.activeDirection === null) {
        flipLossDirection.activeDirection = position.direction;
    }
}

function openPositionFromSignal(args: {
    entryBuildContext: EntryBuildContext;
    signal: Signal;
    barIndex: number;
    capital: number;
    positions: PositionState[];
    currentBarOpenedPositions?: Set<PositionState>;
    smartSizingPositionState: WeakMap<PositionState, SmartSizingPositionState>;
    config: NormalizedSettings;
    adaptiveTakeProfitState: ReturnType<typeof createAdaptiveTakeProfitState>;
    tradeDirection: ReturnType<typeof normalizeTradeDirection>;
    flipLossDirection: FlipLossDirectionState;
}): { position: PositionState; entryCommission: number } | null {
    const opened = buildEntryPosition(args.entryBuildContext, args.signal, args.barIndex, args.capital);
    if (!opened) return null;

    registerOpenedPosition({
        position: opened.nextPosition,
        positions: args.positions,
        currentBarOpenedPositions: args.currentBarOpenedPositions,
        smartSizingPositionState: args.smartSizingPositionState,
        settings: args.config,
        adaptiveTakeProfitState: args.adaptiveTakeProfitState,
        tradeDirection: args.tradeDirection,
        flipLossDirection: args.flipLossDirection,
        barIndex: args.barIndex,
    });
    return {
        position: opened.nextPosition,
        entryCommission: opened.entryCommission,
    };
}

function resolveSignalExitOrder(position: PositionState, signal: Signal): {
    exitFraction: number;
    exitSize: number;
    wasPartial: boolean;
} | null {
    const exitFractionRaw = Number.isFinite(signal.sizeFraction as number) ? Number(signal.sizeFraction) : 1;
    const exitFraction = Math.max(0, Math.min(1, exitFractionRaw));
    const exitSize = position.size * exitFraction;
    if (exitSize <= 0) return null;
    return {
        exitFraction,
        exitSize,
        wasPartial: exitFraction < 1,
    };
}

function findSignalExitTarget(
    positions: PositionState[],
    signal: Signal,
    allowSameBarExit: boolean
): PositionState | undefined {
    const signalDir = signalToPositionDirection(signal.type);
    const oppositeDir = getOppositeDirection(signalDir);
    return positions.find((position) =>
        position.direction === oppositeDir
        && (allowSameBarExit || compareTime(signal.time, position.entryTime) !== 0)
    );
}

function canImmediatelyReenterAfterSignalExit(args: {
    fullyClosed: boolean;
    wasPartial: boolean;
    tradeDirection: ReturnType<typeof normalizeTradeDirection>;
    flipLossDirection: FlipLossDirectionState;
    signal: Signal;
    positions: PositionState[];
    maxOpenTrades: number;
    signalExitReentryCooldownUntilBarIndex?: number;
    barIndex?: number;
}): boolean {
    if (!args.fullyClosed || args.wasPartial || args.positions.length >= args.maxOpenTrades) return false;
    if (
        args.signalExitReentryCooldownUntilBarIndex !== undefined
        && args.barIndex !== undefined
        && isSignalExitReentryCooldownActive(args.signalExitReentryCooldownUntilBarIndex, args.barIndex)
    ) {
        return false;
    }
    return args.tradeDirection === 'both'
        || (
            isLossStreakFlipTradeDirection(args.tradeDirection)
            && args.flipLossDirection.activeDirection !== null
            && signalToPositionDirection(args.signal.type) === args.flipLossDirection.activeDirection
        );
}

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

type SmartSizingPositionState = {
    initialTargetPercent: number | null;
    fastProgressHit: boolean;
};

const SMART_SIZING_FAST_PROGRESS_BARS = 2;
const SMART_SIZING_PROGRESS_PERCENT = 50;
const SIGNAL_EXIT_REENTRY_COOLDOWN_BARS = 1;

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

function armSignalExitReentryCooldown(barIndex: number): number {
    return barIndex + SIGNAL_EXIT_REENTRY_COOLDOWN_BARS - 1;
}

function isSignalExitReentryCooldownActive(cooldownUntilBarIndex: number, barIndex: number): boolean {
    return cooldownUntilBarIndex >= barIndex;
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
        kellyState: createKellySizingState(),
        martingaleState: createMartingaleState(),
        optimalFState: createOptimalFState(),
    };
}

function pushRollingScore(target: number[], score: number | null, maxLength = 12): void {
    if (score === null || !Number.isFinite(score)) return;
    target.push(score);
    if (target.length > maxLength) {
        target.shift();
    }
}

function updateSmartSizingState(
    state: SmartSizingState,
    velocityScore: number | null,
    tradePnl?: number,
    sizingMode?: TradeSizingMode,
    advancedSizing?: TradeSizingConfig["advancedSizing"]
): void {
    pushRollingScore(state.recentVelocityScores, velocityScore);
    if (typeof tradePnl !== "number" || !Number.isFinite(tradePnl) || !sizingMode) {
        return;
    }

    updateKellyState(state.kellyState ?? createKellySizingState(), { pnl: tradePnl, isWin: tradePnl > 0 });
    if (sizingMode === "martingale" || sizingMode === "anti_martingale") {
        updateMartingaleState(
            state.martingaleState ?? createMartingaleState(),
            { pnl: tradePnl, isWin: tradePnl > 0 },
            advancedSizing,
            sizingMode === "anti_martingale"
        );
    }
    if (sizingMode === "optimal_f" || sizingMode === "secure_f") {
        updateOptimalFState(state.optimalFState ?? createOptimalFState(), tradePnl, advancedSizing);
    }
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
    _config: NormalizedSettings,
    smartSizingPositionState: WeakMap<PositionState, SmartSizingPositionState>,
    position: PositionState,
    candle: OHLCVData
): void {
    const state = smartSizingPositionState.get(position);
    if (!state) return;

    const fastWindow = SMART_SIZING_FAST_PROGRESS_BARS;
    if (state.fastProgressHit || state.initialTargetPercent === null || state.initialTargetPercent <= 0 || position.barsInTrade > fastWindow) return;

    const favorablePrice = position.direction === 'short'
        ? Math.min(position.extremePrice, candle.low)
        : Math.max(position.extremePrice, candle.high);
    const favorableMovePercent = directionFactorFor(position.direction) * ((favorablePrice - position.entryPrice) / position.entryPrice) * 100;
    const progressPercent = (Math.max(0, favorableMovePercent) / state.initialTargetPercent) * 100;
    if (greaterThanOrNearlyEqual(progressPercent, SMART_SIZING_PROGRESS_PERCENT)) {
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
        advancedSizing: sizing?.advancedSizing,
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
        advancedSizing: sizing?.advancedSizing,
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
    const advancedSizing = sizing?.advancedSizing;
    const indicatorSeries = resolveIndicators(data, settings, precomputed);

    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection);
    const preparedSignalBarIndexes = resolvePreparedSignalBarIndexes(data, preparedSignals);

    let capital = initialCapital;
    const positions: PositionState[] = [];
    const maxOpenTrades = config.maxOpenTrades;
    let totalTrades = 0, winningTrades = 0, totalProfit = 0, totalLoss = 0;
    let peakEquity = initialCapital, maxDrawdown = 0, maxDrawdownPercent = 0;
    let signalIdx = 0;
    let signalExitReentryCooldownUntilBarIndex = -1;
    const compactEquity = equityOut ?? new Float64Array(data.length);

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    const winStreakRisk = createWinStreakRiskState();
    const flipLossDirection = createFlipLossDirectionState();
    const smartSizingState = createSmartSizingState(initialCapital);
    const smartSizingPositionState = createSmartSizingPositionState();
    const adaptiveTakeProfitState = createAdaptiveTakeProfitState(data, config, indicatorSeries, initialCapital);
    const entryBuildContext: EntryBuildContext = {
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
        advancedSizing,
        smartSizingState,
        winStreakRisk,
        adaptiveTakeProfitState,
    };
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
        updateSmartSizingState(
            smartSizingState,
            resolveVelocitySizingScore(smartSizingPositionState, position),
            position.realizedPnl,
            sizingMode,
            advancedSizing
        );
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
        if (!adaptiveExit) {
            return;
        }

        if (adaptiveExit.deferExecutionToNextBarOpen) {
            pendingAdaptiveTakeProfitExits.set(pos, adaptiveExit.exitReason);
            return;
        }

        const exitPrice = applySlippage(adaptiveExit.exitPrice, exitSideForDirection(pos.direction), slippageRate);
        const { fullyClosed } = recordExit(pos, exitPrice, pos.size);
        if (fullyClosed) {
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
        let fullyClosed = false;
        if (pos.size <= 0) {
            const idx = positions.indexOf(pos);
            if (idx >= 0) positions.splice(idx, 1);
            pendingAdaptiveTakeProfitExits.delete(pos);
            fullyClosed = true;
        }
        return { details, fullyClosed };
    };

    const tryProcessExitsAfterEntry = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
        const exitTrigger = processPositionExits(candle, pos, config, slippageRate);
        let fullyClosed = false;
        if (exitTrigger) {
            ({ fullyClosed } = recordExit(pos, exitTrigger.exitPrice, exitTrigger.exitSize));
            if (fullyClosed) {
                finalizeClosedPosition(pos, candle, exitTrigger.exitPrice, exitTrigger.exitReason);
            }
        }
        if (!fullyClosed) {
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
            const { fullyClosed } = recordExit(pos, stopLossTrigger.exitPrice, stopLossTrigger.exitSize);
            if (fullyClosed) {
                finalizeClosedPosition(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
            }
        }
    };

    const openSignalPosition = (
        signal: Signal,
        barIndex: number,
        currentBarOpenedPositions?: Set<PositionState>
    ) => {
        const opened = openPositionFromSignal({
            entryBuildContext,
            signal,
            barIndex,
            capital,
            positions,
            currentBarOpenedPositions,
            smartSizingPositionState,
            config,
            adaptiveTakeProfitState,
            tradeDirection,
            flipLossDirection,
        });
        if (opened) {
            capital -= opened.entryCommission;
        }
        return opened;
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];
        const currentBarOpenedPositions = new Set<PositionState>();

        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const pendingReason = pendingAdaptiveTakeProfitExits.get(pos);
            if (!pendingReason) continue;

            pendingAdaptiveTakeProfitExits.delete(pos);
            const exitPrice = applySlippage(candle.open, exitSideForDirection(pos.direction), slippageRate);
            const { fullyClosed } = recordExit(pos, exitPrice, pos.size);
            if (fullyClosed) {
                finalizeClosedPosition(pos, candle, exitPrice, pendingReason);
            }
        }

        if (config.executionModel === 'next_open') {
            for (let p = positions.length - 1; p >= 0; p--) {
                const pos = positions[p];
                const openExitTrigger = processPositionExits(candle, pos, config, slippageRate, { openOnly: true });
                if (!openExitTrigger) {
                    continue;
                }

                const { fullyClosed } = recordExit(pos, openExitTrigger.exitPrice, openExitTrigger.exitSize);
                if (fullyClosed) {
                    finalizeClosedPosition(pos, candle, openExitTrigger.exitPrice, openExitTrigger.exitReason);
                }
            }

            while (signalIdx < preparedSignals.length && preparedSignalBarIndexes[signalIdx] <= i) {
                const signalBarIndex = preparedSignalBarIndexes[signalIdx];
                const signal = preparedSignals[signalIdx++];
                if (signalBarIndex !== i) {
                    continue;
                }

                const exitTarget = findSignalExitTarget(positions, signal, config.allowSameBarExit);

                if (!exitTarget && positions.length < maxOpenTrades) {
                    if (isSignalExitReentryCooldownActive(signalExitReentryCooldownUntilBarIndex, i)) {
                        continue;
                    }
                    if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                        continue;
                    }
                    openSignalPosition(signal, i, currentBarOpenedPositions);
                } else if (exitTarget) {
                    if (!canExitAfterMinimumHold(exitTarget, config)) {
                        continue;
                    }
                    const exitOrder = resolveSignalExitOrder(exitTarget, signal);
                    if (!exitOrder) continue;

                    const { fullyClosed } = recordExit(exitTarget, signal.price, exitOrder.exitSize);
                    if (fullyClosed) {
                        finalizeClosedPosition(exitTarget, candle, signal.price, 'signal');
                        if (!exitOrder.wasPartial) {
                            signalExitReentryCooldownUntilBarIndex = armSignalExitReentryCooldown(i);
                        }
                    }
                    if (canImmediatelyReenterAfterSignalExit({
                        fullyClosed,
                        wasPartial: exitOrder.wasPartial,
                        tradeDirection,
                        flipLossDirection,
                        signal,
                        positions,
                        maxOpenTrades,
                        signalExitReentryCooldownUntilBarIndex,
                        barIndex: i,
                    })) {
                        openSignalPosition(signal, i, currentBarOpenedPositions);
                    }
                }
            }
        }

        // Process exits for ALL open positions (iterate backwards for safe splice)
        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const openedThisBar = currentBarOpenedPositions.has(pos);
            if (!openedThisBar) {
                pos.barsInTrade += 1;
            }

            if (config.executionModel === 'next_open' && openedThisBar && !config.allowSameBarExit) {
                const stopLossTrigger = processPositionExits(candle, pos, config, slippageRate, { stopLossOnly: true });
                if (stopLossTrigger) {
                    const { fullyClosed } = recordExit(pos, stopLossTrigger.exitPrice, stopLossTrigger.exitSize);
                    if (fullyClosed) {
                        finalizeClosedPosition(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
                    }
                }
                continue;
            }

            updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
            const exitTrigger = processPositionExits(candle, pos, config, slippageRate);
            let fullyClosed = false;
            if (exitTrigger) {
                ({ fullyClosed } = recordExit(pos, exitTrigger.exitPrice, exitTrigger.exitSize));
                if (fullyClosed) {
                    finalizeClosedPosition(pos, candle, exitTrigger.exitPrice, exitTrigger.exitReason);
                }
            }
            if (!fullyClosed) {
                updatePositionState(candle, pos, config, indicatorSeries.atr[i]);
                applyAdaptiveTakeProfitAfterBar(pos, candle, i);
            }
        }

        if (config.executionModel !== 'next_open') {
            while (signalIdx < preparedSignals.length && preparedSignalBarIndexes[signalIdx] <= i) {
                const signalBarIndex = preparedSignalBarIndexes[signalIdx];
                const signal = preparedSignals[signalIdx++];
                if (signalBarIndex === i) {
                    // Check for signal exit: does this signal close an existing opposite-direction position?
                    const exitTarget = findSignalExitTarget(positions, signal, config.allowSameBarExit);

                    if (!exitTarget && positions.length < maxOpenTrades) {
                        // New entry (no opposite position to close, and we have room)
                        if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                            continue;
                        }
                        const opened = openSignalPosition(signal, i);
                        if (opened) {
                            finalizeEntryBarState(opened.position, candle, i);
                        }
                    } else if (exitTarget) {
                        // Signal exit: close the opposite-direction position
                        if (!canExitAfterMinimumHold(exitTarget, config)) {
                            continue;
                        }
                        const exitOrder = resolveSignalExitOrder(exitTarget, signal);
                        if (!exitOrder) continue;

                        const { fullyClosed } = recordExit(exitTarget, signal.price, exitOrder.exitSize);
                        if (fullyClosed) {
                            finalizeClosedPosition(exitTarget, candle, signal.price, 'signal');
                        }
                        if (canImmediatelyReenterAfterSignalExit({
                            fullyClosed,
                            wasPartial: exitOrder.wasPartial,
                            tradeDirection,
                            flipLossDirection,
                            signal,
                            positions,
                            maxOpenTrades,
                        })) {
                            const opened = openSignalPosition(signal, i);
                            if (opened) {
                                finalizeEntryBarState(opened.position, candle, i);
                            }
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
    const advancedSizing = sizing?.advancedSizing;
    const indicatorSeries = resolveIndicators(data, settings, precomputed);

    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection);
    const preparedSignalBarIndexes = resolvePreparedSignalBarIndexes(data, preparedSignals);

    let capital = initialCapital, tradeId = 0, signalIdx = 0;
    const positions: PositionState[] = [];
    const maxOpenTrades = config.maxOpenTrades;
    const trades: Trade[] = [];
    const equityCurve: { time: Time; value: number }[] = [];
    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    const winStreakRisk = createWinStreakRiskState();
    const flipLossDirection = createFlipLossDirectionState();
    const smartSizingState = createSmartSizingState(initialCapital);
    const smartSizingPositionState = createSmartSizingPositionState();
    const adaptiveTakeProfitState = createAdaptiveTakeProfitState(data, config, indicatorSeries, initialCapital);
    const entryBuildContext: EntryBuildContext = {
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
        advancedSizing,
        smartSizingState,
        winStreakRisk,
        adaptiveTakeProfitState,
    };
    const pendingAdaptiveTakeProfitUpdates: AdaptiveTakeProfitHistoryUpdate[] = [];
    const pendingAdaptiveTakeProfitExits = new Map<PositionState, NonNullable<Trade['exitReason']>>();
    let signalExitReentryCooldownUntilBarIndex = -1;

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
        updateSmartSizingState(
            smartSizingState,
            resolveVelocitySizingScore(smartSizingPositionState, position),
            position.realizedPnl,
            sizingMode,
            advancedSizing
        );
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
        if (!adaptiveExit) {
            return;
        }

        if (adaptiveExit.deferExecutionToNextBarOpen) {
            pendingAdaptiveTakeProfitExits.set(pos, adaptiveExit.exitReason);
            return;
        }

        const exitPrice = applySlippage(adaptiveExit.exitPrice, exitSideForDirection(pos.direction), slippageRate);
        const { fullyClosed } = recordExitFull(pos, candle, exitPrice, pos.size, adaptiveExit.exitReason);
        if (fullyClosed) {
            finalizeClosedPositionFull(pos, candle, exitPrice, adaptiveExit.exitReason);
        }
    };

    const recordExitFull = (pos: PositionState, candle: OHLCVData, exitPrice: number, exitSize: number, reason: Trade['exitReason']) => {
        const d = calculateTradeExitDetails(pos, exitPrice, exitSize, commissionRate);
        capital += d.rawPnl - d.commission;
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
        trades.push(trade);
        pos.realizedPnl += d.totalPnl;
        pos.size -= d.size;
        let fullyClosed = false;
        if (pos.size <= 0) {
            const idx = positions.indexOf(pos);
            if (idx >= 0) positions.splice(idx, 1);
            pendingAdaptiveTakeProfitExits.delete(pos);
            fullyClosed = true;
        }
        return { details: d, fullyClosed };
    };

    const tryProcessExitsAfterEntryFull = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
        const exitTrigger = processPositionExits(candle, pos, config, slippageRate);
        let fullyClosed = false;
        if (exitTrigger) {
            ({ fullyClosed } = recordExitFull(pos, candle, exitTrigger.exitPrice, exitTrigger.exitSize, exitTrigger.exitReason));
            if (fullyClosed) {
                finalizeClosedPositionFull(pos, candle, exitTrigger.exitPrice, exitTrigger.exitReason);
            }
        }
        if (!fullyClosed) {
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
            const { fullyClosed } = recordExitFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitSize, stopLossTrigger.exitReason);
            if (fullyClosed) {
                finalizeClosedPositionFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
            }
        }
    };

    const openSignalPosition = (
        signal: Signal,
        barIndex: number,
        currentBarOpenedPositions?: Set<PositionState>
    ) => {
        const opened = openPositionFromSignal({
            entryBuildContext,
            signal,
            barIndex,
            capital,
            positions,
            currentBarOpenedPositions,
            smartSizingPositionState,
            config,
            adaptiveTakeProfitState,
            tradeDirection,
            flipLossDirection,
        });
        if (opened) {
            capital -= opened.entryCommission;
        }
        return opened;
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];
        const currentBarOpenedPositions = new Set<PositionState>();

        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const pendingReason = pendingAdaptiveTakeProfitExits.get(pos);
            if (!pendingReason) continue;

            pendingAdaptiveTakeProfitExits.delete(pos);
            const exitPrice = applySlippage(candle.open, exitSideForDirection(pos.direction), slippageRate);
            const { fullyClosed } = recordExitFull(pos, candle, exitPrice, pos.size, pendingReason);
            if (fullyClosed) {
                finalizeClosedPositionFull(pos, candle, exitPrice, pendingReason);
            }
        }

        if (config.executionModel === 'next_open') {
            for (let p = positions.length - 1; p >= 0; p--) {
                const pos = positions[p];
                const openExitTrigger = processPositionExits(candle, pos, config, slippageRate, { openOnly: true });
                if (!openExitTrigger) {
                    continue;
                }

                const { fullyClosed } = recordExitFull(pos, candle, openExitTrigger.exitPrice, openExitTrigger.exitSize, openExitTrigger.exitReason);
                if (fullyClosed) {
                    finalizeClosedPositionFull(pos, candle, openExitTrigger.exitPrice, openExitTrigger.exitReason);
                }
            }

            while (signalIdx < preparedSignals.length && preparedSignalBarIndexes[signalIdx] <= i) {
                const signalBarIndex = preparedSignalBarIndexes[signalIdx];
                const signal = preparedSignals[signalIdx++];
                if (signalBarIndex !== i) {
                    continue;
                }

                const exitTarget = findSignalExitTarget(positions, signal, config.allowSameBarExit);

                if (!exitTarget && positions.length < maxOpenTrades) {
                    // New entry
                    if (isSignalExitReentryCooldownActive(signalExitReentryCooldownUntilBarIndex, i)) {
                        continue;
                    }
                    if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                        continue;
                    }
                    openSignalPosition(signal, i, currentBarOpenedPositions);
                } else if (exitTarget) {
                    // Signal exit
                    if (!canExitAfterMinimumHold(exitTarget, config)) {
                        continue;
                    }
                    const exitOrder = resolveSignalExitOrder(exitTarget, signal);
                    if (!exitOrder) continue;

                    const { fullyClosed } = recordExitFull(exitTarget, candle, signal.price, exitOrder.exitSize, 'signal');
                    if (fullyClosed) {
                        finalizeClosedPositionFull(exitTarget, candle, signal.price, 'signal');
                        if (!exitOrder.wasPartial) {
                            signalExitReentryCooldownUntilBarIndex = armSignalExitReentryCooldown(i);
                        }
                    }
                    if (canImmediatelyReenterAfterSignalExit({
                        fullyClosed,
                        wasPartial: exitOrder.wasPartial,
                        tradeDirection,
                        flipLossDirection,
                        signal,
                        positions,
                        maxOpenTrades,
                        signalExitReentryCooldownUntilBarIndex,
                        barIndex: i,
                    })) {
                        openSignalPosition(signal, i, currentBarOpenedPositions);
                    }
                }
            }
        }

        // Process exits for ALL open positions
        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const openedThisBar = currentBarOpenedPositions.has(pos);
            if (!openedThisBar) {
                pos.barsInTrade += 1;
            }

            if (config.executionModel === 'next_open' && openedThisBar && !config.allowSameBarExit) {
                const stopLossTrigger = processPositionExits(candle, pos, config, slippageRate, { stopLossOnly: true });
                if (stopLossTrigger) {
                    const { fullyClosed } = recordExitFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitSize, stopLossTrigger.exitReason);
                    if (fullyClosed) {
                        finalizeClosedPositionFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
                    }
                }
                continue;
            }

            updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
            const exitTrigger = processPositionExits(candle, pos, config, slippageRate);
            let fullyClosed = false;
            if (exitTrigger) {
                ({ fullyClosed } = recordExitFull(pos, candle, exitTrigger.exitPrice, exitTrigger.exitSize, exitTrigger.exitReason));
                if (fullyClosed) {
                    finalizeClosedPositionFull(pos, candle, exitTrigger.exitPrice, exitTrigger.exitReason);
                }
            }
            if (!fullyClosed) {
                updatePositionState(candle, pos, config, indicatorSeries.atr[i]);
                applyAdaptiveTakeProfitAfterBarFull(pos, candle, i);
            }
        }

        if (config.executionModel !== 'next_open') {
            while (signalIdx < preparedSignals.length && preparedSignalBarIndexes[signalIdx] <= i) {
                const signalBarIndex = preparedSignalBarIndexes[signalIdx];
                const signal = preparedSignals[signalIdx++];
                if (signalBarIndex === i) {
                    const exitTarget = findSignalExitTarget(positions, signal, config.allowSameBarExit);

                    if (!exitTarget && positions.length < maxOpenTrades) {
                        // New entry
                        if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                            continue;
                        }
                        const opened = openSignalPosition(signal, i);
                        if (opened) {
                            finalizeEntryBarStateFull(opened.position, candle, i);
                        }
                    } else if (exitTarget) {
                        // Signal exit
                        if (!canExitAfterMinimumHold(exitTarget, config)) {
                            continue;
                        }
                        const exitOrder = resolveSignalExitOrder(exitTarget, signal);
                        if (!exitOrder) continue;

                        const { fullyClosed } = recordExitFull(exitTarget, candle, signal.price, exitOrder.exitSize, 'signal');
                        if (fullyClosed) {
                            finalizeClosedPositionFull(exitTarget, candle, signal.price, 'signal');
                        }
                        if (canImmediatelyReenterAfterSignalExit({
                            fullyClosed,
                            wasPartial: exitOrder.wasPartial,
                            tradeDirection,
                            flipLossDirection,
                            signal,
                            positions,
                            maxOpenTrades,
                        })) {
                            const opened = openSignalPosition(signal, i);
                            if (opened) {
                                finalizeEntryBarStateFull(opened.position, candle, i);
                            }
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
            const eodTrade: Trade = { id: ++tradeId, type: pos.direction, entryTime: pos.entryTime, entryPrice: pos.entryPrice, exitTime: candle.time, exitPrice: candle.close, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: 'end_of_data', stopLossPrice: pos.stopLossPrice, takeProfitPrice: pos.takeProfitPrice };
            trades.push(eodTrade);
            positions.splice(0, 1);
        }
        if (equityCurve.length > 0) {
            equityCurve[equityCurve.length - 1] = { time: candle.time, value: capital };
        }
    }


    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);
    return calculateBacktestStats(trades, equityCurve, initialCapital, capital, maxDrawdown, maxDrawdownPercent);
}
