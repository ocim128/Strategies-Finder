
import { BacktestDiagnostics, BacktestResult, BacktestSettings, OHLCVData, Signal, Time, Trade } from '../../types/index';
import { ensureCleanData } from '../strategy-helpers';
import { IndicatorSeries, NormalizedSettings, PositionState, PrecomputedIndicators, TradeSizingConfig, TradeSizingMode } from '../../types/backtest';
import { applySlippage, compareTime, directionFactorFor, exitSideForDirection, getExecutionShift, getTimeIndex, getTimeIndexValue, isLossStreakFlipTradeDirection, normalizeBacktestSettings, normalizeTradeDirection, resolveExecutionPrice, signalToPositionDirection, timeKey } from './backtest-utils';
import {
    calculateSharpeRatioFromEquitySamples,
    calculateSharpeRatioFromReturns,
} from '../performance-metrics';

import { prepareSignals } from './signal-preparation';
import { calculateTradeExitDetails, createEmptyBacktestResult, finalizeBacktestMetrics, calculateBacktestStats, calculateMaxDrawdown } from './position-stats';
import { precomputeIndicators, resolveIndicatorsFromConfig } from './indicator-precompute';
import { buildPositionFromSignal, type SmartSizingState } from './position-builder';
import {
    canExitAfterMinimumHold,
    OPEN_ONLY_POSITION_EXIT_OPTIONS,
    processPositionExits,
    STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS,
    updatePositionState,
} from './exit-handlers';
import {
    createAdaptiveTakeProfitState,
    registerAdaptiveTakeProfitPosition,
    resolveAdaptiveTakeProfitOverrides,
    updateAdaptiveTakeProfitPosition,
    updateAdaptiveTakeProfitHistory,
} from './adaptive-take-profit';
import { PathExitEvaluationContext, PathExitLearningState, learnFromClosedTrade } from './path-exit-rules';
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

type BacktestRunOptions = {
    includeAdvancedAnalytics?: boolean;
    includeSharpeRatio?: boolean;
    collectDiagnostics?: boolean;
    omitEquityCurve?: boolean;
    skipDrawdown?: boolean;
    requireTradeHistory?: boolean;
    /** Build endpoint-adjusted selection metrics without allocating Trade objects. */
    endpointSelectionLastDataTime?: Time | null;
    endpointSelectionInitialCapital?: number;
};

export interface BacktestEndpointSelection {
    result: BacktestResult;
    adjusted: boolean;
    removedTrades: number;
}

export type BacktestResultWithEndpointSelection = BacktestResult & {
    endpointSelection?: BacktestEndpointSelection;
};

function createBacktestDiagnostics(inputBars: number, inputSignals: number): BacktestDiagnostics {
    return {
        counts: {
            inputBars,
            evaluationBars: inputBars,
            inputSignals,
            preparedSignals: 0,
            barsScanned: 0,
            barsWithPosition: 0,
            entriesAttempted: 0,
            tradesOpened: 0,
            tradesClosed: 0,
            signalExitOrders: 0,
            forcedEndOfDataExits: 0,
            fastPathRuns: 0,
            maxOpenPositions: 0,
        },
        timingsMs: {
            total: 0,
            dataClean: 0,
            indicatorResolution: 0,
            signalPreparation: 0,
            signalIndexing: 0,
            entryEvaluation: 0,
            tradeSimulation: 0,
            forcedClose: 0,
            drawdown: 0,
            metrics: 0,
        },
    };
}

function roundBacktestDiagnosticMs(value: number): number {
    return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function addBacktestDiagnosticElapsed(
    diagnostics: BacktestDiagnostics | undefined,
    key: keyof BacktestDiagnostics["timingsMs"],
    startedAt: number
): void {
    if (!diagnostics) return;
    diagnostics.timingsMs[key] += performance.now() - startedAt;
}

function finalizeBacktestDiagnostics(
    diagnostics: BacktestDiagnostics | undefined,
    result: BacktestResult,
    startedAt: number
): BacktestResult {
    if (!diagnostics) return result;
    diagnostics.timingsMs.total = performance.now() - startedAt;
    for (const key of Object.keys(diagnostics.timingsMs) as Array<keyof BacktestDiagnostics["timingsMs"]>) {
        diagnostics.timingsMs[key] = roundBacktestDiagnosticMs(diagnostics.timingsMs[key]);
    }
    result.diagnostics = diagnostics;
    return result;
}

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
        smartSizingPositionState,
        settings,
        adaptiveTakeProfitState,
        tradeDirection,
        flipLossDirection,
        barIndex,
    } = args;
    const existingSameDirectionPosition = positions.find((existing) => existing.direction === position.direction);
    const maxHoldGroupEntryBarIndex = existingSameDirectionPosition?.maxHoldGroupEntryBarIndex
        ?? existingSameDirectionPosition?.openedBarIndex
        ?? barIndex;
    positions.push(position);
    position.openedBarIndex = barIndex;
    position.maxHoldGroupEntryBarIndex = maxHoldGroupEntryBarIndex;
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

function resolveSignalExitPrice(position: PositionState, signal: Signal, slippageRate: number): number {
    return applySlippage(signal.price, exitSideForDirection(position.direction), slippageRate);
}

function findSignalExitTargets(
    positions: PositionState[],
    signal: Signal,
    allowSameBarExit: boolean
): PositionState[] {
    const signalDir = signalToPositionDirection(signal.type);
    const oppositeDir = getOppositeDirection(signalDir);
    return positions.filter((position) =>
        position.direction === oppositeDir
        && (allowSameBarExit || compareTime(signal.time, position.entryTime) !== 0)
    );
}

function hasOppositePositionForSignal(positions: PositionState[], signal: Signal): boolean {
    const signalDir = signalToPositionDirection(signal.type);
    const oppositeDir = getOppositeDirection(signalDir);
    return positions.some((position) => position.direction === oppositeDir);
}

function getForcedPolymarketSignalExitReason(signal: Signal): Extract<NonNullable<Trade["exitReason"]>, "polymarket_take_profit" | "polymarket_stop_loss"> | null {
    return signal.reason === "polymarket_take_profit" || signal.reason === "polymarket_stop_loss"
        ? signal.reason
        : null;
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
        if (signal.exitOnly === true) continue;
        if (signal.type === 'buy') buyTimes.add(key);
        else if (signal.type === 'sell') sellTimes.add(key);
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
        const mappedIndex = getTimeIndexValue(fallbackTimeIndex, signal.time);
        indexes[i] = mappedIndex === undefined ? -1 : mappedIndex;
    }

    return indexes;
}

type IndexedFinderSignals = {
    sourceIndexes: Int32Array;
    barIndexes: Int32Array;
    count: number;
};

function hasActiveSignalRegimeFilters(config: NormalizedSettings): boolean {
    return config.marketMode !== 'all'
        || config.trendEmaPeriod > 0
        || config.atrPercentMin > 0
        || config.atrPercentMax > 0
        || config.adxMin > 0
        || config.adxMax > 0;
}

/**
 * Finder strategies normally emit sorted signals with an explicit barIndex.
 * Keep those source objects and prepare only two integer indexes so the dense
 * state-signal path does not clone one object per bar. Unusual inputs fall
 * back to the general object preparation path.
 */
function prepareIndexedFinderSignals(
    data: OHLCVData[],
    signals: Signal[],
    config: NormalizedSettings,
    tradeDirection: ReturnType<typeof normalizeTradeDirection>
): IndexedFinderSignals | null {
    if (hasActiveSignalRegimeFilters(config)) return null;

    const sourceIndexes = new Int32Array(signals.length);
    const barIndexes = new Int32Array(signals.length);
    const executionShift = getExecutionShift(config);
    const isBothLikeDirection = tradeDirection === "both";
    const entryType: Signal["type"] = tradeDirection === "short" ? "sell" : "buy";
    const exitType: Signal["type"] = tradeDirection === "short" ? "buy" : "sell";
    let count = 0;
    let lastBarIndex = -1;

    for (let sourceIndex = 0; sourceIndex < signals.length; sourceIndex += 1) {
        const signal = signals[sourceIndex];
        if (!Number.isFinite(signal.barIndex as number)) return null;
        const decisionIndex = Math.trunc(signal.barIndex as number);
        if (decisionIndex < 0 || decisionIndex >= data.length) continue;

        if (isBothLikeDirection) {
            if (signal.type !== "buy" && signal.type !== "sell") continue;
        } else if (signal.type !== entryType && signal.type !== exitType) {
            continue;
        }

        const executionIndex = decisionIndex + executionShift;
        if (executionIndex < 0 || executionIndex >= data.length) continue;
        if (executionIndex < lastBarIndex) return null;

        sourceIndexes[count] = sourceIndex;
        barIndexes[count] = executionIndex;
        lastBarIndex = executionIndex;
        count += 1;
    }

    return { sourceIndexes, barIndexes, count };
}

function getSinglePositionFinderFastPathBlockers(
    config: NormalizedSettings,
    tradeDirection: ReturnType<typeof normalizeTradeDirection>,
    sizingMode: TradeSizingMode,
    options: BacktestRunOptions | undefined
): string[] {
    const blockers: string[] = [];
    if (options?.omitEquityCurve !== true) blockers.push("equity_curve_required");
    if (config.maxOpenTrades !== 1) blockers.push("max_open_trades");
    if (tradeDirection !== "long" && tradeDirection !== "short" && tradeDirection !== "both") blockers.push(`trade_direction_${tradeDirection}`);
    if (sizingMode !== "percent" && sizingMode !== "fixed") blockers.push(`sizing_${sizingMode}`);
    if (hasActivePercentageTakeProfit(config) && config.takeProfitMode !== "fixed") blockers.push(`take_profit_mode_${config.takeProfitMode}`);
    if (config.trailingAtr !== 0) blockers.push("trailing_atr");
    if (config.partialTakeProfitAtR !== 0) blockers.push("partial_take_profit");
    if (config.breakEvenAtR !== 0) blockers.push("break_even_atr");
    if (config.breakEvenPercent !== 0) blockers.push("break_even_percent");
    if (config.riskWinStreakStopLossEnabled) blockers.push("win_streak_stop_loss");
    return blockers;
}

function hasActivePercentageTakeProfit(config: NormalizedSettings): boolean {
    return config.riskMode === "percentage"
        && config.takeProfitEnabled
        && config.takeProfitPercent > 0;
}

function hasBarBasedExitRules(config: NormalizedSettings): boolean {
    const hasPercentageStopLoss = config.riskMode === "percentage"
        && config.stopLossEnabled
        && config.stopLossPercent > 0;
    const hasRiskMaxHold = config.riskMaxHoldEnabled
        && config.riskMaxHoldBars > 0;
    return config.stopLossAtr > 0
        || config.takeProfitAtr > 0
        || hasPercentageStopLoss
        || hasActivePercentageTakeProfit(config)
        || config.trailingAtr > 0
        || config.partialTakeProfitAtR > 0
        || config.breakEvenAtR > 0
        || config.breakEvenPercent > 0
        || hasRiskMaxHold
        || config.timeStopBars > 0
        || (config.pathExitEnabled && config.pathExitMode !== 'off');
}

function canUseSignalOnlyFinderFastPath(
    config: NormalizedSettings,
    options: BacktestRunOptions | undefined
): boolean {
    return options?.skipDrawdown === true
        && options.includeSharpeRatio === false
        && !hasBarBasedExitRules(config);
}

type EndpointSelectionAccumulator = {
    totalTrades: number;
    winningTrades: number;
    totalProfit: number;
    totalLoss: number;
    netProfit: number;
    removedTrades: number;
    finitePnlExitTimes: Time[];
    finitePnl: number[];
    pnlPercent: number[];
};

function createEndpointSelectionAccumulator(): EndpointSelectionAccumulator {
    return {
        totalTrades: 0,
        winningTrades: 0,
        totalProfit: 0,
        totalLoss: 0,
        netProfit: 0,
        removedTrades: 0,
        finitePnlExitTimes: [],
        finitePnl: [],
        pnlPercent: [],
    };
}

function buildEndpointSelection(
    raw: BacktestResult,
    accumulator: EndpointSelectionAccumulator,
    initialCapital: number,
    endpointEnabled: boolean,
): BacktestEndpointSelection | undefined {
    if (!endpointEnabled) return undefined;

    if (accumulator.removedTrades <= 0) {
        return { result: raw, adjusted: false, removedTrades: 0 };
    }

    const { totalTrades, winningTrades, totalProfit, totalLoss, netProfit } = accumulator;
    const losingTrades = totalTrades - winningTrades;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
    const lossRate = totalTrades > 0 ? losingTrades / totalTrades : 0;
    const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
    const finitePnlCount = accumulator.finitePnl.length;
    let sharpeRatio: number;

    if (finitePnlCount > 1) {
        const equityValues = new Float64Array(finitePnlCount);
        let equity = initialCapital;
        for (let i = 0; i < finitePnlCount; i += 1) {
            equity += accumulator.finitePnl[i]!;
            equityValues[i] = equity;
        }
        sharpeRatio = calculateSharpeRatioFromEquitySamples(
            accumulator.finitePnlExitTimes,
            equityValues,
            finitePnlCount,
        );
    } else {
        sharpeRatio = calculateSharpeRatioFromReturns(accumulator.pnlPercent);
    }

    return {
        result: {
            ...raw,
            // Server-side Asset Opportunity consumes scalar selection metrics;
            // avoid rebuilding filtered Trade objects after the compact pass.
            trades: [],
            netProfit,
            netProfitPercent: initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0,
            winRate: winRate * 100,
            expectancy: (winRate * avgWin) - (lossRate * avgLoss),
            avgTrade: totalTrades > 0 ? netProfit / totalTrades : 0,
            profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0,
            totalTrades,
            winningTrades,
            losingTrades,
            avgWin,
            avgLoss,
            sharpeRatio,
        },
        adjusted: true,
        removedTrades: accumulator.removedTrades,
    };
}

function runSinglePositionFinderFastPath(args: {
    data: OHLCVData[];
    preparedSignals: Signal[];
    preparedSignalBarIndexes: Int32Array;
    indexedSignals?: IndexedFinderSignals;
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    config: NormalizedSettings;
    tradeDirection: ReturnType<typeof normalizeTradeDirection>;
    sizingMode: TradeSizingMode;
    fixedTradeAmount: number;
    advancedSizing?: TradeSizingConfig["advancedSizing"];
    indicatorSeries: IndicatorSeries;
    diagnostics?: BacktestDiagnostics;
    options?: BacktestRunOptions;
    equityOut?: Float64Array;
}): BacktestResultWithEndpointSelection {
    const {
        data,
        preparedSignals,
        preparedSignalBarIndexes,
        indexedSignals,
        initialCapital,
        positionSizePercent,
        commissionPercent,
        config,
        tradeDirection,
        sizingMode,
        fixedTradeAmount,
        advancedSizing,
        indicatorSeries,
        diagnostics,
        options,
        equityOut,
    } = args;
    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    const retainTradeHistory = options?.requireTradeHistory === true;
    const endpointEnabled = options?.endpointSelectionLastDataTime !== undefined;
    const endpointLastDataTime = options?.endpointSelectionLastDataTime ?? null;
    const endpointAccumulator = endpointEnabled ? createEndpointSelectionAccumulator() : undefined;
    const trades: Trade[] = [];
    const learningState: PathExitLearningState = {
        hazardSamples: new Map(),
        barrierSamples: new Map(),
    };
    diagnostics && (diagnostics.counts.fastPathRuns = 1);
    let capital = initialCapital;
    let peakEquity = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let tradeId = 0;
    let totalTrades = 0;
    let winningTrades = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    let signalIdx = 0;
    let position = null as PositionState | null;
    let positionEntryBarIndex = -1;
    let signalExitReentryCooldownUntilBarIndex = -1;
    let currentBarIndex = 0;
    const skipDrawdown = options?.skipDrawdown === true;
    const preparedSignalCount = indexedSignals?.count ?? preparedSignals.length;
    const indexedSignalView: Signal = {
        time: data[0]?.time ?? 0 as Time,
        type: "buy",
        price: 0,
    };
    const executionShift = getExecutionShift(config);

    const getPreparedSignal = (index: number, barIndex: number): Signal => {
        if (!indexedSignals) return preparedSignals[index];
        const source = preparedSignals[indexedSignals.sourceIndexes[index]];
        indexedSignalView.time = data[barIndex].time;
        indexedSignalView.type = source.type;
        indexedSignalView.price = resolveExecutionPrice(
            data,
            source,
            barIndex - executionShift,
            barIndex,
            config
        );
        indexedSignalView.triggerPrice = source.price;
        indexedSignalView.reason = source.reason;
        indexedSignalView.barIndex = barIndex;
        indexedSignalView.sizeFraction = source.sizeFraction;
        indexedSignalView.exitOnly = source.exitOnly;
        return indexedSignalView;
    };

    const recordExit = (
        pos: PositionState,
        candle: OHLCVData,
        exitPrice: number,
        exitSize: number,
        reason: Trade["exitReason"]
    ): { fullyClosed: boolean } => {
        const d = calculateTradeExitDetails(pos, exitPrice, exitSize, commissionRate);
        capital += d.rawPnl - d.commission;
        totalTrades += 1;
        if (d.totalPnl > 0) {
            winningTrades += 1;
            totalProfit += d.totalPnl;
        } else {
            totalLoss += Math.abs(d.totalPnl);
        }
        if (retainTradeHistory) {
            trades.push({
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
            });
        }
        if (endpointAccumulator) {
            const beforeEndpoint = endpointLastDataTime === null
                || compareTime(candle.time, endpointLastDataTime) < 0;
            if (beforeEndpoint) {
                endpointAccumulator.totalTrades += 1;
                endpointAccumulator.netProfit += d.totalPnl;
                endpointAccumulator.pnlPercent.push(d.pnlPercent);
                if (d.totalPnl > 0) {
                    endpointAccumulator.winningTrades += 1;
                    endpointAccumulator.totalProfit += d.totalPnl;
                } else {
                    endpointAccumulator.totalLoss += Math.abs(d.totalPnl);
                }
                if (Number.isFinite(d.totalPnl)) {
                    endpointAccumulator.finitePnlExitTimes.push(candle.time);
                    endpointAccumulator.finitePnl.push(d.totalPnl);
                }
            } else {
                endpointAccumulator.removedTrades += 1;
            }
        }
        diagnostics && diagnostics.counts.tradesClosed++;
        pos.realizedPnl += d.totalPnl;
        pos.size -= d.size;
        const fullyClosed = pos.size <= 0;
        if (fullyClosed) {
            if (isEntryCooldownEnabled(config)) {
                signalExitReentryCooldownUntilBarIndex = armSignalExitReentryCooldown(currentBarIndex, config.riskCooldownBars);
            }
            if (config.pathExitEnabled && (config.pathExitMode === 'conditional_hazard' || config.pathExitMode === 'triple_barrier_meta')) {
                learnFromClosedTrade(
                    pos,
                    pos.openedBarIndex ?? positionEntryBarIndex ?? 0,
                    currentBarIndex,
                    exitPrice,
                    data,
                    learningState,
                    config
                );
            }
            if (position === pos) {
                position = null;
                positionEntryBarIndex = -1;
            }
        }
        return { fullyClosed };
    };

    const openSignalPosition = (signal: Signal, barIndex: number): PositionState | null => {
        diagnostics && diagnostics.counts.entriesAttempted++;
        const opened = buildPositionFromSignal({
            signal,
            barIndex,
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
            advancedSizing,
        });
        if (!opened) return null;
        position = opened.nextPosition;
        positionEntryBarIndex = barIndex;
        capital -= opened.entryCommission;
        if (diagnostics) {
            diagnostics.counts.tradesOpened++;
            diagnostics.counts.maxOpenPositions = 1;
        }
        return position;
    };

    const processCurrentPositionExit = (
        candle: OHLCVData,
        barIndex: number,
        options?: Parameters<typeof processPositionExits>[4]
    ): boolean => {
        if (!position) return false;
        const pathExitContext: PathExitEvaluationContext | undefined = config.pathExitEnabled ? {
            data,
            barIndex,
            atrValue: indicatorSeries.atr ? indicatorSeries.atr[barIndex] : null,
            learningState,
        } : undefined;
        const exitTrigger = processPositionExits(candle, position, config, slippageRate, options, pathExitContext, barIndex);
        if (!exitTrigger) return false;
        return recordExit(position, candle, exitTrigger.exitPrice, exitTrigger.exitSize, exitTrigger.exitReason).fullyClosed;
    };

    const handleSignal = (signal: Signal, barIndex: number, candle: OHLCVData): PositionState | null => {
        const forcedExitReason = getForcedPolymarketSignalExitReason(signal);
        const isExitOnly = signal.exitOnly === true;
        const signalDir = signalToPositionDirection(signal.type);
        const oppositeDir = getOppositeDirection(signalDir);
        const exitTarget = position
            && position.direction === oppositeDir
            && (config.allowSameBarExit || compareTime(signal.time, position.entryTime) !== 0)
            && (!config.disableSignalExits || forcedExitReason !== null || isExitOnly)
            ? position
            : null;

        if (!exitTarget && !position) {
            if (forcedExitReason !== null || isExitOnly) return null;
            if (
                (
                    config.executionModel === "next_open"
                    || isEntryCooldownEnabled(config)
                )
                && isSignalExitReentryCooldownActive(signalExitReentryCooldownUntilBarIndex, barIndex)
            ) {
                return null;
            }
            return openSignalPosition(signal, barIndex);
        }

        if (!exitTarget || !canExitAfterMinimumHold(exitTarget, config)) {
            return null;
        }
        const exitOrder = resolveSignalExitOrder(exitTarget, signal);
        if (!exitOrder) return null;

        diagnostics && diagnostics.counts.signalExitOrders++;
        const exitPrice = resolveSignalExitPrice(exitTarget, signal, slippageRate);
        const { fullyClosed } = recordExit(exitTarget, candle, exitPrice, exitOrder.exitSize, forcedExitReason ?? "signal");
        if (
            forcedExitReason === null
            && !isExitOnly
            && tradeDirection === "both"
            && fullyClosed
            && !exitOrder.wasPartial
            && config.executionModel !== "next_open"
        ) {
            // Same-bar direction flip: the cooldown applies to LATER bars, not the
            // immediate opposite-direction re-entry the "both" mode allows here.
            return openSignalPosition(signal, barIndex);
        }
        return null;
    };

    const updateDrawdown = (candle: OHLCVData, barIndex: number): void => {
        if (skipDrawdown && !equityOut) {
            return;
        }
        const unrealizedPnl = position
            ? (candle.close - position.entryPrice) * position.size * directionFactorFor(position.direction)
            : 0;
        const equity = capital + unrealizedPnl;
        if (equityOut) {
            equityOut[barIndex] = equity;
        }
        if (skipDrawdown) {
            return;
        }
        if (equity > peakEquity) {
            peakEquity = equity;
            return;
        }
        const drawdown = peakEquity - equity;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
        }
    };

    const syncSparseBarsInTrade = (barIndex: number): void => {
        if (!position || positionEntryBarIndex < 0) return;
        position.barsInTrade = Math.max(position.barsInTrade, barIndex - positionEntryBarIndex);
    };

    const tradeSimulationStartedAt = performance.now();
    if (canUseSignalOnlyFinderFastPath(config, options)) {
        for (let i = 0; i < preparedSignalCount; i++) {
            const barIndex = preparedSignalBarIndexes[i];
            if (barIndex < 0 || barIndex >= data.length) continue;
            const candle = data[barIndex];
            if (!candle) continue;

            syncSparseBarsInTrade(barIndex);
            diagnostics && diagnostics.counts.barsScanned++;
            handleSignal(getPreparedSignal(i, barIndex), barIndex, candle);
            if (diagnostics && position) {
                diagnostics.counts.barsWithPosition++;
                diagnostics.counts.maxOpenPositions = 1;
            }
        }
        addBacktestDiagnosticElapsed(diagnostics, "tradeSimulation", tradeSimulationStartedAt);

        const forcedCloseStartedAt = performance.now();
        if (position && data.length > 0) {
            const candle = data[data.length - 1];
            recordExit(position, candle, candle.close, position.size, "end_of_data");
            diagnostics && diagnostics.counts.forcedEndOfDataExits++;
        }
        addBacktestDiagnosticElapsed(diagnostics, "forcedClose", forcedCloseStartedAt);

        const metricsStartedAt = performance.now();
        const result = (retainTradeHistory
            ? calculateBacktestStats(trades, [], initialCapital, capital, 0, 0, options)
            : finalizeBacktestMetrics(
                initialCapital,
                capital,
                totalTrades,
                winningTrades,
                totalProfit,
                totalLoss,
                0,
                0,
                0,
            ) as BacktestResult) as BacktestResultWithEndpointSelection;
        const endpointAdjustment = buildEndpointSelection(
            result,
            endpointAccumulator ?? createEndpointSelectionAccumulator(),
            options?.endpointSelectionInitialCapital ?? initialCapital,
            endpointEnabled,
        );
        if (endpointAdjustment) {
            result.endpointSelection = endpointAdjustment;
        }
        addBacktestDiagnosticElapsed(diagnostics, "metrics", metricsStartedAt);
        return result;
    }

    for (let i = 0; i < data.length; i++) {
        currentBarIndex = i;
        if (!position) {
            const nextSignalBarIndex = preparedSignalBarIndexes[signalIdx];
            if (nextSignalBarIndex === undefined) {
                if (equityOut) {
                    equityOut.fill(capital, i);
                }
                break;
            }
            if (nextSignalBarIndex > i) {
                if (equityOut) {
                    equityOut.fill(capital, i, nextSignalBarIndex);
                }
                i = nextSignalBarIndex - 1;
                continue;
            }
        }

        diagnostics && diagnostics.counts.barsScanned++;
        const candle = data[i];
        let openedThisBar: PositionState | null = null;

        if (config.executionModel === "next_open") {
            processCurrentPositionExit(candle, i, OPEN_ONLY_POSITION_EXIT_OPTIONS);

            while (signalIdx < preparedSignalCount && preparedSignalBarIndexes[signalIdx] <= i) {
                const signalBarIndex = preparedSignalBarIndexes[signalIdx];
                const signal = getPreparedSignal(signalIdx++, signalBarIndex);
                if (signalBarIndex !== i) continue;
                openedThisBar = handleSignal(signal, i, candle) ?? openedThisBar;
            }
        }

        if (position) {
            if (position !== openedThisBar) {
                position.barsInTrade += 1;
            }
            if (config.executionModel === "next_open" && position === openedThisBar && !config.allowSameBarExit) {
                processCurrentPositionExit(candle, i, STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS);
            } else {
                processCurrentPositionExit(candle, i);
            }
        }

        if (config.executionModel !== "next_open") {
            while (signalIdx < preparedSignalCount && preparedSignalBarIndexes[signalIdx] <= i) {
                const signalBarIndex = preparedSignalBarIndexes[signalIdx];
                const signal = getPreparedSignal(signalIdx++, signalBarIndex);
                if (signalBarIndex !== i) continue;
                openedThisBar = handleSignal(signal, i, candle) ?? openedThisBar;
            }
        }

        if (diagnostics && position) {
            diagnostics.counts.barsWithPosition++;
            diagnostics.counts.maxOpenPositions = 1;
        }
        updateDrawdown(candle, i);
    }
    addBacktestDiagnosticElapsed(diagnostics, "tradeSimulation", tradeSimulationStartedAt);

    const forcedCloseStartedAt = performance.now();
    if (position && data.length > 0) {
        const candle = data[data.length - 1];
        recordExit(position, candle, candle.close, position.size, "end_of_data");
        if (equityOut) {
            equityOut[data.length - 1] = capital;
        }
        diagnostics && diagnostics.counts.forcedEndOfDataExits++;
        if (!skipDrawdown) {
            if (capital > peakEquity) {
                peakEquity = capital;
            } else {
                const drawdown = peakEquity - capital;
                if (drawdown > maxDrawdown) {
                    maxDrawdown = drawdown;
                    maxDrawdownPercent = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
                }
            }
        }
    }
    addBacktestDiagnosticElapsed(diagnostics, "forcedClose", forcedCloseStartedAt);

    const metricsStartedAt = performance.now();
    const statsOptions = options?.includeSharpeRatio === false
        ? options
        : { ...options, includeSharpeRatio: false };
    const result = (retainTradeHistory
        ? calculateBacktestStats(
            trades,
            [],
            initialCapital,
            capital,
            skipDrawdown ? 0 : maxDrawdown,
            skipDrawdown ? 0 : maxDrawdownPercent,
            statsOptions
        )
        : finalizeBacktestMetrics(
            initialCapital,
            capital,
            totalTrades,
            winningTrades,
            totalProfit,
            totalLoss,
            0,
            skipDrawdown ? 0 : maxDrawdown,
            skipDrawdown ? 0 : maxDrawdownPercent,
        ) as BacktestResult) as BacktestResultWithEndpointSelection;
    if (options?.includeSharpeRatio !== false && equityOut) {
        result.sharpeRatio = calculateSharpeRatioFromEquitySamples(data, equityOut, data.length);
    }
    const endpointAdjustment = buildEndpointSelection(
        result,
        endpointAccumulator ?? createEndpointSelectionAccumulator(),
        options?.endpointSelectionInitialCapital ?? initialCapital,
        endpointEnabled,
    );
    if (endpointAdjustment) {
        result.endpointSelection = endpointAdjustment;
    }
    addBacktestDiagnosticElapsed(diagnostics, "metrics", metricsStartedAt);
    return result;
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

function armSignalExitReentryCooldown(barIndex: number, cooldownBars: number): number {
    return barIndex + Math.max(0, cooldownBars) - 1;
}

function isSignalExitReentryCooldownActive(cooldownUntilBarIndex: number, barIndex: number): boolean {
    return cooldownUntilBarIndex >= barIndex;
}

/** Whether the configurable post-exit entry cooldown is active under the current settings. */
function isEntryCooldownEnabled(config: NormalizedSettings): boolean {
    return config.riskCooldownEnabled && config.riskCooldownBars > 0;
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
    longEquity?: Float64Array,
    shortEquity?: Float64Array,
    options?: BacktestRunOptions,
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
    const skipDrawdown = options?.skipDrawdown === true;
    const len = longEquity && shortEquity ? Math.min(longEquity.length, shortEquity.length) : 0;
    const needsCombinedEquity = !skipDrawdown || options?.includeSharpeRatio !== false;
    const combinedEquity = needsCombinedEquity && longEquity && shortEquity
        ? new Float64Array(len)
        : undefined;

    if (combinedEquity && longEquity && shortEquity) {
        for (let i = 0; i < len; i++) {
            const combined = longEquity[i] + shortEquity[i];
            combinedEquity[i] = combined;
            if (!skipDrawdown) {
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
        }
    }

    const sharpeRatio = options?.includeSharpeRatio === false || !combinedEquity
        ? 0
        : calculateSharpeRatioFromEquitySamples(data, combinedEquity, len);

    const trades = options?.requireTradeHistory === true
        ? [...longResult.trades, ...shortResult.trades]
            .sort((a, b) => compareTime(a.exitTime, b.exitTime) || compareTime(a.entryTime, b.entryTime))
            .map((trade, index) => ({ ...trade, id: index + 1 }))
        : [];

    return {
        trades,
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

function canUseNoEquityCombinedSideFastPath(options?: BacktestRunOptions): boolean {
    return options?.omitEquityCurve === true
        && options.includeSharpeRatio === false
        && options.skipDrawdown === true;
}

function mergeCombinedSideDiagnostics(
    target: BacktestDiagnostics | undefined,
    longDiagnostics: BacktestDiagnostics | undefined,
    shortDiagnostics: BacktestDiagnostics | undefined,
    input: {
        inputBars: number;
        inputSignals: number;
    }
): void {
    if (!target || !longDiagnostics || !shortDiagnostics) return;
    target.counts.inputBars = input.inputBars;
    target.counts.evaluationBars = input.inputBars;
    target.counts.inputSignals = input.inputSignals;
    target.counts.preparedSignals = longDiagnostics.counts.preparedSignals + shortDiagnostics.counts.preparedSignals;
    target.counts.barsScanned = longDiagnostics.counts.barsScanned + shortDiagnostics.counts.barsScanned;
    target.counts.barsWithPosition = longDiagnostics.counts.barsWithPosition + shortDiagnostics.counts.barsWithPosition;
    target.counts.entriesAttempted = longDiagnostics.counts.entriesAttempted + shortDiagnostics.counts.entriesAttempted;
    target.counts.tradesOpened = longDiagnostics.counts.tradesOpened + shortDiagnostics.counts.tradesOpened;
    target.counts.tradesClosed = longDiagnostics.counts.tradesClosed + shortDiagnostics.counts.tradesClosed;
    target.counts.signalExitOrders = longDiagnostics.counts.signalExitOrders + shortDiagnostics.counts.signalExitOrders;
    target.counts.forcedEndOfDataExits = longDiagnostics.counts.forcedEndOfDataExits + shortDiagnostics.counts.forcedEndOfDataExits;
    target.counts.maxOpenPositions = Math.max(longDiagnostics.counts.maxOpenPositions, shortDiagnostics.counts.maxOpenPositions);

    const longFastPathUsed = longDiagnostics.fastPath?.used === true;
    const shortFastPathUsed = shortDiagnostics.fastPath?.used === true;
    target.counts.fastPathRuns = longFastPathUsed && shortFastPathUsed ? 1 : 0;
    const blockers = [
        ...(longDiagnostics.fastPath?.blockers ?? []),
        ...(shortDiagnostics.fastPath?.blockers ?? []),
    ];
    target.fastPath = {
        used: longFastPathUsed && shortFastPathUsed,
        blockers: [...new Set(blockers)],
    };

    for (const key of Object.keys(target.timingsMs) as Array<keyof BacktestDiagnostics["timingsMs"]>) {
        if (key === "total" || key === "dataClean") continue;
        target.timingsMs[key] += (longDiagnostics.timingsMs[key] ?? 0) + (shortDiagnostics.timingsMs[key] ?? 0);
    }
}

function runCombinedBacktestCompact(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>,
    precomputed?: PrecomputedIndicators,
    options?: BacktestRunOptions,
    diagnostics?: BacktestDiagnostics
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

    // Allocate per-bar equity buffers only when combined drawdown/Sharpe needs them.
    const needsEquity = options?.skipDrawdown !== true || options?.includeSharpeRatio !== false;
    const longEquity = needsEquity ? new Float64Array(data.length) : undefined;
    const shortEquity = needsEquity ? new Float64Array(data.length) : undefined;
    const runSide = (
        sideSignals: Signal[],
        sideInitialCapital: number,
        side: 'long' | 'short',
        equity?: Float64Array
    ) => equity
        ? runBacktestCompact(
            data,
            sideSignals,
            sideInitialCapital,
            positionSizePercent,
            commissionPercent,
            { ...settings, tradeDirection: side },
            splitSizing,
            precomputed,
            equity,
            options
        )
        : runBacktestCompact(
            data,
            sideSignals,
            sideInitialCapital,
            positionSizePercent,
            commissionPercent,
            { ...settings, tradeDirection: side },
            splitSizing,
            precomputed,
            options
        );
    const longResult = runSide(longSignals, longInitialCapital, 'long', longEquity);
    const shortResult = runSide(shortSignals, shortInitialCapital, 'short', shortEquity);

    mergeCombinedSideDiagnostics(diagnostics, longResult.diagnostics, shortResult.diagnostics, {
        inputBars: data.length,
        inputSignals: signals.length,
    });

    return combineCompactResults(data, initialCapital, longResult, shortResult, longEquity, shortEquity, options);
}

function runCombinedBacktest(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>,
    precomputed?: PrecomputedIndicators,
    options?: BacktestRunOptions,
    diagnostics?: BacktestDiagnostics
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
    const noEquityCombinedResult = canUseNoEquityCombinedSideFastPath(options);
    const sideOptions = options === undefined
        ? undefined
        : noEquityCombinedResult
            ? options
            : { ...options, omitEquityCurve: false, skipDrawdown: false };

    const longResult = runBacktest(
        data,
        longSignals,
        longInitialCapital,
        positionSizePercent,
        commissionPercent,
        { ...settings, tradeDirection: 'long' },
        splitSizing,
        precomputed,
        sideOptions
    );
    const shortResult = runBacktest(
        data,
        shortSignals,
        shortInitialCapital,
        positionSizePercent,
        commissionPercent,
        { ...settings, tradeDirection: 'short' },
        splitSizing,
        precomputed,
        sideOptions
    );

    mergeCombinedSideDiagnostics(diagnostics, longResult.diagnostics, shortResult.diagnostics, {
        inputBars: data.length,
        inputSignals: signals.length,
    });

    const mergedTrades = [...longResult.trades, ...shortResult.trades]
        .slice()
        .sort((a, b) => compareTime(a.exitTime, b.exitTime) || compareTime(a.entryTime, b.entryTime))
        .map((trade, index) => ({ ...trade, id: index + 1 }));

    const finalCapital = initialCapital + longResult.netProfit + shortResult.netProfit;
    if (noEquityCombinedResult) {
        return calculateBacktestStats(
            mergedTrades,
            [],
            initialCapital,
            finalCapital,
            0,
            0,
            options,
        );
    }

    const equityCurve = buildCombinedEquityCurve(
        data,
        longResult.equityCurve,
        shortResult.equityCurve,
        longInitialCapital,
        shortInitialCapital
    );
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);
    return calculateBacktestStats(
        mergedTrades,
        equityCurve,
        initialCapital,
        finalCapital,
        maxDrawdown,
        maxDrawdownPercent,
        options
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
    optionsOrEquityOut?: BacktestRunOptions | Float64Array,
    maybeOptions?: BacktestRunOptions,
): BacktestResultWithEndpointSelection {
    const equityOut = optionsOrEquityOut instanceof Float64Array ? optionsOrEquityOut : undefined;
    const options = optionsOrEquityOut instanceof Float64Array ? maybeOptions : optionsOrEquityOut;
    const runStartedAt = performance.now();
    const diagnostics = options?.collectDiagnostics
        ? createBacktestDiagnostics(data.length, signals.length)
        : undefined;
    if (signals.length === 0) {
        if (equityOut && options?.skipDrawdown !== true) {
            equityOut.fill(initialCapital);
        }
        return finalizeBacktestDiagnostics(diagnostics, createEmptyBacktestResult(), runStartedAt);
    }

    const tradeDirection = normalizeTradeDirection(settings);
    if (tradeDirection === 'combined') {
        return finalizeBacktestDiagnostics(diagnostics, runCombinedBacktestCompact(
            data,
            signals,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            settings,
            sizing,
            precomputed,
            options,
            diagnostics
        ), runStartedAt);
    }

    const config = normalizeBacktestSettings(settings);
    const omitEquityCurve = options?.omitEquityCurve === true && options?.includeSharpeRatio === false;
    const learningState: PathExitLearningState = {
        hazardSamples: new Map(),
        barrierSamples: new Map(),
    };
    let currentBarIndex = 0;
    const skipDrawdown = options?.skipDrawdown === true;
    const shouldTrackEquity = !skipDrawdown || options?.includeSharpeRatio !== false;
    const sizingMode = sizing?.mode ?? 'percent';
    const fixedTradeAmount = Math.max(0, sizing?.fixedTradeAmount ?? 0);
    const advancedSizing = sizing?.advancedSizing;
    const indicatorStartedAt = performance.now();
    const indicatorSeries = resolveIndicatorsFromConfig(data, config, precomputed);
    addBacktestDiagnosticElapsed(diagnostics, "indicatorResolution", indicatorStartedAt);

    const fastPathBlockers = getSinglePositionFinderFastPathBlockers(config, tradeDirection, sizingMode, options);
    const signalPreparationStartedAt = performance.now();
    const indexedSignals = fastPathBlockers.length === 0
        ? prepareIndexedFinderSignals(data, signals, config, tradeDirection)
        : null;
    const preparedSignals = indexedSignals
        ? signals
        : prepareSignals(data, signals, config, indicatorSeries, tradeDirection);
    diagnostics && (diagnostics.counts.preparedSignals = indexedSignals?.count ?? preparedSignals.length);
    addBacktestDiagnosticElapsed(diagnostics, "signalPreparation", signalPreparationStartedAt);
    const signalIndexingStartedAt = performance.now();
    const preparedSignalBarIndexes = indexedSignals?.barIndexes
        ?? resolvePreparedSignalBarIndexes(data, preparedSignals);
    addBacktestDiagnosticElapsed(diagnostics, "signalIndexing", signalIndexingStartedAt);

    if (diagnostics) {
        diagnostics.fastPath = {
            used: fastPathBlockers.length === 0,
            blockers: fastPathBlockers,
            signalPreparation: indexedSignals ? "indexed" : "objects",
        };
    }

    if (fastPathBlockers.length === 0) {
        const fastPathEquity = options?.includeSharpeRatio !== false
            ? (equityOut ?? new Float64Array(data.length))
            : equityOut;
        const result = runSinglePositionFinderFastPath({
            data,
            preparedSignals,
            preparedSignalBarIndexes,
            indexedSignals: indexedSignals ?? undefined,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            config,
            tradeDirection,
            sizingMode,
            fixedTradeAmount,
            advancedSizing,
            indicatorSeries,
            diagnostics,
            options,
            equityOut: fastPathEquity,
        });
        if (options?.requireTradeHistory !== true) {
            result.trades = [];
        }
        return finalizeBacktestDiagnostics(diagnostics, result, runStartedAt);
    }

    let capital = initialCapital;
    const positions: PositionState[] = [];
    const maxOpenTrades = config.maxOpenTrades;
    let totalTrades = 0, winningTrades = 0, totalProfit = 0, totalLoss = 0;
    let peakEquity = initialCapital, maxDrawdown = 0, maxDrawdownPercent = 0;
    let signalIdx = 0;
    let signalExitReentryCooldownUntilBarIndex = -1;
    const compactEquity = shouldTrackEquity ? (equityOut ?? new Float64Array(data.length)) : undefined;

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
    const trades: Trade[] = [];
    let tradeId = 0;

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
        if (config.pathExitEnabled && (config.pathExitMode === 'conditional_hazard' || config.pathExitMode === 'triple_barrier_meta')) {
            learnFromClosedTrade(
                position,
                position.openedBarIndex ?? 0,
                currentBarIndex,
                exitPrice,
                data,
                learningState,
                config
            );
        }
    };

    const flushAdaptiveTakeProfitUpdates = () => {
        for (let i = 0; i < pendingAdaptiveTakeProfitUpdates.length; i++) {
            const update = pendingAdaptiveTakeProfitUpdates[i];
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
        pendingAdaptiveTakeProfitUpdates.length = 0;
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
        const { fullyClosed } = recordExit(pos, exitPrice, pos.size, adaptiveExit.exitReason);
        if (fullyClosed) {
            finalizeClosedPosition(pos, candle, exitPrice, adaptiveExit.exitReason);
        }
    };

    const recordExit = (
        pos: PositionState,
        exitPrice: number,
        exitSize: number,
        exitReason: Trade['exitReason'] = 'signal',
    ) => {
        const details = calculateTradeExitDetails(pos, exitPrice, exitSize, commissionRate);
        capital += details.rawPnl - details.commission;
        totalTrades++;
        if (details.totalPnl > 0) { winningTrades++; totalProfit += details.totalPnl; } else { totalLoss += Math.abs(details.totalPnl); }
        if (options?.requireTradeHistory === true) {
            trades.push({
                id: ++tradeId,
                type: pos.direction,
                entryTime: pos.entryTime,
                entryPrice: pos.entryPrice,
                exitTime: data[currentBarIndex]?.time ?? pos.entryTime,
                exitPrice,
                pnl: details.totalPnl,
                pnlPercent: details.pnlPercent,
                size: details.size,
                fees: details.fees,
                exitReason,
                stopLossPrice: pos.stopLossPrice,
                takeProfitPrice: pos.takeProfitPrice,
            });
        }
        pos.realizedPnl += details.totalPnl;
        pos.size -= details.size;
        let fullyClosed = false;
        if (pos.size <= 0) {
            const idx = positions.indexOf(pos);
            if (idx >= 0) positions.splice(idx, 1);
            pendingAdaptiveTakeProfitExits.delete(pos);
            if (isEntryCooldownEnabled(config)) {
                signalExitReentryCooldownUntilBarIndex = armSignalExitReentryCooldown(currentBarIndex, config.riskCooldownBars);
            }
            fullyClosed = true;
        }
        return { details, fullyClosed };
    };

    const tryProcessExitsAfterEntry = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
        const pathExitContext: PathExitEvaluationContext | undefined = config.pathExitEnabled ? {
            data,
            barIndex,
            atrValue: indicatorSeries.atr[barIndex],
            learningState,
        } : undefined;
        const exitTrigger = processPositionExits(candle, pos, config, slippageRate, undefined, pathExitContext, barIndex);
        let fullyClosed = false;
        if (exitTrigger) {
            ({ fullyClosed } = recordExit(pos, exitTrigger.exitPrice, exitTrigger.exitSize, exitTrigger.exitReason));
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

        const stopLossTrigger = processPositionExits(candle, pos, config, slippageRate, STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS, undefined, barIndex);
        if (stopLossTrigger) {
            const { fullyClosed } = recordExit(pos, stopLossTrigger.exitPrice, stopLossTrigger.exitSize, stopLossTrigger.exitReason);
            if (fullyClosed) {
                finalizeClosedPosition(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
            }
        }
    };

    const openSignalPosition = (
        signal: Signal,
        barIndex: number
    ) => {
        if (diagnostics) {
            diagnostics.counts.entriesAttempted++;
        }
        const opened = openPositionFromSignal({
            entryBuildContext,
            signal,
            barIndex,
            capital,
            positions,
            smartSizingPositionState,
            config,
            adaptiveTakeProfitState,
            tradeDirection,
            flipLossDirection,
        });
        if (opened) {
            capital -= opened.entryCommission;
            if (diagnostics) {
                diagnostics.counts.tradesOpened++;
                diagnostics.counts.maxOpenPositions = Math.max(diagnostics.counts.maxOpenPositions, positions.length);
            }
        }
        return opened;
    };

    const tradeSimulationStartedAt = performance.now();
    for (let i = 0; i < data.length; i++) {
        currentBarIndex = i;
        if (omitEquityCurve && positions.length === 0 && pendingAdaptiveTakeProfitExits.size === 0) {
            const nextSignalBarIndex = preparedSignalBarIndexes[signalIdx];
            if (nextSignalBarIndex === undefined) {
                if (equityOut && compactEquity) {
                    compactEquity.fill(capital, i);
                }
                break;
            }
            if (nextSignalBarIndex > i) {
                if (equityOut && compactEquity) {
                    compactEquity.fill(capital, i, nextSignalBarIndex);
                }
                i = nextSignalBarIndex - 1;
                continue;
            }
        }
        diagnostics && diagnostics.counts.barsScanned++;
        const candle = data[i];

        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const pendingReason = pendingAdaptiveTakeProfitExits.get(pos);
            if (!pendingReason) continue;

            pendingAdaptiveTakeProfitExits.delete(pos);
            const exitPrice = applySlippage(candle.open, exitSideForDirection(pos.direction), slippageRate);
            const { fullyClosed } = recordExit(pos, exitPrice, pos.size, pendingReason);
            if (fullyClosed) {
                finalizeClosedPosition(pos, candle, exitPrice, pendingReason);
            }
        }

        if (config.executionModel === 'next_open') {
            for (let p = positions.length - 1; p >= 0; p--) {
                const pos = positions[p];
                const openExitTrigger = processPositionExits(candle, pos, config, slippageRate, OPEN_ONLY_POSITION_EXIT_OPTIONS, undefined, i);
                if (!openExitTrigger) {
                    continue;
                }

                const { fullyClosed } = recordExit(pos, openExitTrigger.exitPrice, openExitTrigger.exitSize, openExitTrigger.exitReason);
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

                const forcedExitReason = getForcedPolymarketSignalExitReason(signal);
                const isExitOnly = signal.exitOnly === true;
                const exitTargets = config.disableSignalExits && forcedExitReason === null && !isExitOnly
                    ? undefined
                    : findSignalExitTargets(positions, signal, config.allowSameBarExit);

                if ((!exitTargets || exitTargets.length === 0) && positions.length < maxOpenTrades) {
                    if (forcedExitReason !== null || isExitOnly) {
                        continue;
                    }
                    if (config.disableSignalExits && hasOppositePositionForSignal(positions, signal)) {
                        continue;
                    }
                    if (isSignalExitReentryCooldownActive(signalExitReentryCooldownUntilBarIndex, i)) {
                        continue;
                    }
                    if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                        continue;
                    }
                    openSignalPosition(signal, i);
                } else if (exitTargets && exitTargets.length > 0) {
                    let allTargetsFullyClosed = true;
                    let allExitOrdersFull = true;
                    for (const exitTarget of exitTargets) {
                        if (!canExitAfterMinimumHold(exitTarget, config)) {
                            allTargetsFullyClosed = false;
                            continue;
                        }
                        const exitOrder = resolveSignalExitOrder(exitTarget, signal);
                        if (!exitOrder) {
                            allTargetsFullyClosed = false;
                            continue;
                        }

                        diagnostics && diagnostics.counts.signalExitOrders++;
                        const exitPrice = resolveSignalExitPrice(exitTarget, signal, slippageRate);
                        const { fullyClosed } = recordExit(exitTarget, exitPrice, exitOrder.exitSize, forcedExitReason ?? 'signal');
                        allTargetsFullyClosed = allTargetsFullyClosed && fullyClosed;
                        allExitOrdersFull = allExitOrdersFull && !exitOrder.wasPartial;
                        if (fullyClosed) {
                            finalizeClosedPosition(exitTarget, candle, exitPrice, forcedExitReason ?? 'signal');
                        }
                    }
                    if (forcedExitReason === null && !isExitOnly && allTargetsFullyClosed && canImmediatelyReenterAfterSignalExit({
                        fullyClosed: true,
                        wasPartial: !allExitOrdersFull,
                        tradeDirection,
                        flipLossDirection,
                        signal,
                        positions,
                        maxOpenTrades,
                        signalExitReentryCooldownUntilBarIndex,
                        barIndex: i,
                    })) {
                        openSignalPosition(signal, i);
                    }
                }
            }
        }

        // Process exits for ALL open positions (iterate backwards for safe splice)
        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const openedThisBar = pos.openedBarIndex === i;
            if (!openedThisBar) {
                pos.barsInTrade += 1;
            }

            if (config.executionModel === 'next_open' && openedThisBar && !config.allowSameBarExit) {
                const stopLossTrigger = processPositionExits(candle, pos, config, slippageRate, STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS, undefined, i);
                if (stopLossTrigger) {
                    const { fullyClosed } = recordExit(pos, stopLossTrigger.exitPrice, stopLossTrigger.exitSize, stopLossTrigger.exitReason);
                    if (fullyClosed) {
                        finalizeClosedPosition(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
                    }
                }
                continue;
            }

            updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
            const pathExitContext: PathExitEvaluationContext | undefined = config.pathExitEnabled ? {
                data,
                barIndex: i,
                atrValue: indicatorSeries.atr[i],
                learningState,
            } : undefined;
            const exitTrigger = processPositionExits(candle, pos, config, slippageRate, undefined, pathExitContext, i);
            let fullyClosed = false;
            if (exitTrigger) {
                ({ fullyClosed } = recordExit(pos, exitTrigger.exitPrice, exitTrigger.exitSize, exitTrigger.exitReason));
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
                    const forcedExitReason = getForcedPolymarketSignalExitReason(signal);
                    const isExitOnly = signal.exitOnly === true;
                    const exitTargets = config.disableSignalExits && forcedExitReason === null && !isExitOnly
                        ? undefined
                        : findSignalExitTargets(positions, signal, config.allowSameBarExit);

                    if ((!exitTargets || exitTargets.length === 0) && positions.length < maxOpenTrades) {
                        // New entry (no opposite position to close, and we have room)
                        if (forcedExitReason !== null || isExitOnly) {
                            continue;
                        }
                        if (config.disableSignalExits && hasOppositePositionForSignal(positions, signal)) {
                            continue;
                        }
                        if (isEntryCooldownEnabled(config)
                            && isSignalExitReentryCooldownActive(signalExitReentryCooldownUntilBarIndex, i)) {
                            continue;
                        }
                        if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                            continue;
                        }
                        const opened = openSignalPosition(signal, i);
                        if (opened) {
                            finalizeEntryBarState(opened.position, candle, i);
                        }
                    } else if (exitTargets && exitTargets.length > 0) {
                        // Signal exit: close the opposite-direction position
                        let allTargetsFullyClosed = true;
                        let allExitOrdersFull = true;
                        for (const exitTarget of exitTargets) {
                            if (!canExitAfterMinimumHold(exitTarget, config)) {
                                allTargetsFullyClosed = false;
                                continue;
                            }
                            const exitOrder = resolveSignalExitOrder(exitTarget, signal);
                            if (!exitOrder) {
                                allTargetsFullyClosed = false;
                                continue;
                            }

                            diagnostics && diagnostics.counts.signalExitOrders++;
                            const exitPrice = resolveSignalExitPrice(exitTarget, signal, slippageRate);
                            const { fullyClosed } = recordExit(exitTarget, exitPrice, exitOrder.exitSize, forcedExitReason ?? 'signal');
                            allTargetsFullyClosed = allTargetsFullyClosed && fullyClosed;
                            allExitOrdersFull = allExitOrdersFull && !exitOrder.wasPartial;
                            if (fullyClosed) {
                                finalizeClosedPosition(exitTarget, candle, exitPrice, forcedExitReason ?? 'signal');
                            }
                        }
                        if (forcedExitReason === null && !isExitOnly && allTargetsFullyClosed && canImmediatelyReenterAfterSignalExit({
                            fullyClosed: true,
                            wasPartial: !allExitOrdersFull,
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

        if (diagnostics && positions.length > 0) {
            diagnostics.counts.barsWithPosition++;
            diagnostics.counts.maxOpenPositions = Math.max(diagnostics.counts.maxOpenPositions, positions.length);
        }
        if (compactEquity) {
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
    }
    addBacktestDiagnosticElapsed(diagnostics, "tradeSimulation", tradeSimulationStartedAt);

    // Match full backtest behavior: close any remaining positions at the final close.
    const forcedCloseStartedAt = performance.now();
    if (positions.length > 0 && data.length > 0) {
        const finalCandle = data[data.length - 1];
        while (positions.length > 0) {
            diagnostics && diagnostics.counts.forcedEndOfDataExits++;
            recordExit(positions[0], finalCandle.close, positions[0].size, 'end_of_data');
        }
        if (compactEquity) {
            const finalEquity = capital;
            compactEquity[data.length - 1] = finalEquity;
            if (finalEquity > peakEquity) peakEquity = finalEquity; else {
                const dd = peakEquity - finalEquity;
                if (dd > maxDrawdown) { maxDrawdown = dd; maxDrawdownPercent = (dd / peakEquity) * 100; }
            }
        }
    }
    addBacktestDiagnosticElapsed(diagnostics, "forcedClose", forcedCloseStartedAt);

    const metricsStartedAt = performance.now();
    const sharpeRatio = options?.includeSharpeRatio === false || !compactEquity
        ? 0
        : calculateSharpeRatioFromEquitySamples(data, compactEquity, data.length);
    const result = finalizeBacktestMetrics(
        initialCapital,
        capital,
        totalTrades,
        winningTrades,
        totalProfit,
        totalLoss,
        sharpeRatio,
        skipDrawdown ? 0 : maxDrawdown,
        skipDrawdown ? 0 : maxDrawdownPercent
    ) as BacktestResult;
    if (options?.requireTradeHistory === true) {
        result.trades = trades;
    }
    diagnostics && (diagnostics.counts.tradesClosed = totalTrades);
    addBacktestDiagnosticElapsed(diagnostics, "metrics", metricsStartedAt);
    return finalizeBacktestDiagnostics(diagnostics, result, runStartedAt);
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
    precomputed?: PrecomputedIndicators,
    options?: BacktestRunOptions
): BacktestResult {
    const runStartedAt = performance.now();
    const diagnostics = options?.collectDiagnostics
        ? createBacktestDiagnostics(data.length, signals.length)
        : undefined;
    if (signals.length === 0) {
        return finalizeBacktestDiagnostics(diagnostics, createEmptyBacktestResult(), runStartedAt);
    }
    const dataCleanStartedAt = performance.now();
    data = ensureCleanData(data);
    if (diagnostics) {
        diagnostics.counts.evaluationBars = data.length;
    }
    addBacktestDiagnosticElapsed(diagnostics, "dataClean", dataCleanStartedAt);

    const tradeDirection = normalizeTradeDirection(settings);
    if (tradeDirection === 'combined') {
        if (diagnostics) {
            diagnostics.fastPath = {
                used: false,
                blockers: ["trade_direction_combined"],
            };
        }
        return finalizeBacktestDiagnostics(diagnostics, runCombinedBacktest(
            data,
            signals,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            settings,
            sizing,
            precomputed,
            options,
            diagnostics
        ), runStartedAt);
    }

    const config = normalizeBacktestSettings(settings);
    const omitEquityCurve = options?.omitEquityCurve === true && options?.includeSharpeRatio === false;
    const learningState: PathExitLearningState = {
        hazardSamples: new Map(),
        barrierSamples: new Map(),
    };
    let currentBarIndex = 0;
    const sizingMode = sizing?.mode ?? 'percent';
    const fixedTradeAmount = Math.max(0, sizing?.fixedTradeAmount ?? 0);
    const advancedSizing = sizing?.advancedSizing;
    const indicatorStartedAt = performance.now();
    const indicatorSeries = resolveIndicatorsFromConfig(data, config, precomputed);
    addBacktestDiagnosticElapsed(diagnostics, "indicatorResolution", indicatorStartedAt);

    const fastPathBlockers = getSinglePositionFinderFastPathBlockers(config, tradeDirection, sizingMode, options);
    const signalPreparationStartedAt = performance.now();
    const indexedSignals = fastPathBlockers.length === 0
        ? prepareIndexedFinderSignals(data, signals, config, tradeDirection)
        : null;
    const preparedSignals = indexedSignals
        ? signals
        : prepareSignals(data, signals, config, indicatorSeries, tradeDirection);
    diagnostics && (diagnostics.counts.preparedSignals = indexedSignals?.count ?? preparedSignals.length);
    addBacktestDiagnosticElapsed(diagnostics, "signalPreparation", signalPreparationStartedAt);
    const signalIndexingStartedAt = performance.now();
    const preparedSignalBarIndexes = indexedSignals?.barIndexes
        ?? resolvePreparedSignalBarIndexes(data, preparedSignals);
    addBacktestDiagnosticElapsed(diagnostics, "signalIndexing", signalIndexingStartedAt);

    if (diagnostics) {
        diagnostics.fastPath = {
            used: fastPathBlockers.length === 0,
            blockers: fastPathBlockers,
            signalPreparation: indexedSignals ? "indexed" : "objects",
        };
    }

    if (fastPathBlockers.length === 0) {
        const fastPathEquity = options?.includeSharpeRatio !== false
            ? new Float64Array(data.length)
            : undefined;
        // The standard engine's contract always includes full trade history;
        // only compact Finder callers may opt out of those allocations.
        const standardOptions: BacktestRunOptions = {
            ...(options ?? {}),
            requireTradeHistory: true,
        };
        const result = runSinglePositionFinderFastPath({
            data,
            preparedSignals,
            preparedSignalBarIndexes,
            indexedSignals: indexedSignals ?? undefined,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            config,
            tradeDirection,
            sizingMode,
            fixedTradeAmount,
            advancedSizing,
            indicatorSeries,
            diagnostics,
            options: standardOptions,
            equityOut: fastPathEquity,
        });
        return finalizeBacktestDiagnostics(diagnostics, result, runStartedAt) as BacktestResultWithEndpointSelection;
    }

    let capital = initialCapital, tradeId = 0, signalIdx = 0;
    let peakEquity = initialCapital, maxDrawdown = 0, maxDrawdownPercent = 0;
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
        if (config.pathExitEnabled && (config.pathExitMode === 'conditional_hazard' || config.pathExitMode === 'triple_barrier_meta')) {
            learnFromClosedTrade(
                position,
                position.openedBarIndex ?? 0,
                currentBarIndex,
                exitPrice,
                data,
                learningState,
                config
            );
        }
    };

    const flushAdaptiveTakeProfitUpdates = () => {
        for (let i = 0; i < pendingAdaptiveTakeProfitUpdates.length; i++) {
            const update = pendingAdaptiveTakeProfitUpdates[i];
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
        pendingAdaptiveTakeProfitUpdates.length = 0;
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
        diagnostics && diagnostics.counts.tradesClosed++;
        pos.realizedPnl += d.totalPnl;
        pos.size -= d.size;
        let fullyClosed = false;
        if (pos.size <= 0) {
            const idx = positions.indexOf(pos);
            if (idx >= 0) positions.splice(idx, 1);
            pendingAdaptiveTakeProfitExits.delete(pos);
            if (isEntryCooldownEnabled(config)) {
                signalExitReentryCooldownUntilBarIndex = armSignalExitReentryCooldown(currentBarIndex, config.riskCooldownBars);
            }
            fullyClosed = true;
        }
        return { details: d, fullyClosed };
    };

    const tryProcessExitsAfterEntryFull = (pos: PositionState, candle: OHLCVData, barIndex: number) => {
        updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
        const pathExitContext: PathExitEvaluationContext | undefined = config.pathExitEnabled ? {
            data,
            barIndex,
            atrValue: indicatorSeries.atr[barIndex],
            learningState,
        } : undefined;
        const exitTrigger = processPositionExits(candle, pos, config, slippageRate, undefined, pathExitContext, barIndex);
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

        const stopLossTrigger = processPositionExits(candle, pos, config, slippageRate, STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS, undefined, barIndex);
        if (stopLossTrigger) {
            const { fullyClosed } = recordExitFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitSize, stopLossTrigger.exitReason);
            if (fullyClosed) {
                finalizeClosedPositionFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
            }
        }
    };

    const openSignalPosition = (
        signal: Signal,
        barIndex: number
    ) => {
        if (diagnostics) {
            diagnostics.counts.entriesAttempted++;
        }
        const opened = openPositionFromSignal({
            entryBuildContext,
            signal,
            barIndex,
            capital,
            positions,
            smartSizingPositionState,
            config,
            adaptiveTakeProfitState,
            tradeDirection,
            flipLossDirection,
        });
        if (opened) {
            capital -= opened.entryCommission;
            if (diagnostics) {
                diagnostics.counts.tradesOpened++;
                diagnostics.counts.maxOpenPositions = Math.max(diagnostics.counts.maxOpenPositions, positions.length);
            }
        }
        return opened;
    };

    const tradeSimulationStartedAt = performance.now();
    for (let i = 0; i < data.length; i++) {
        currentBarIndex = i;
        if (omitEquityCurve && positions.length === 0 && pendingAdaptiveTakeProfitExits.size === 0) {
            const nextSignalBarIndex = preparedSignalBarIndexes[signalIdx];
            if (nextSignalBarIndex === undefined) {
                break;
            }
            if (nextSignalBarIndex > i) {
                i = nextSignalBarIndex - 1;
                continue;
            }
        }
        diagnostics && diagnostics.counts.barsScanned++;
        const candle = data[i];

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
                const openExitTrigger = processPositionExits(candle, pos, config, slippageRate, OPEN_ONLY_POSITION_EXIT_OPTIONS, undefined, i);
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

                const forcedExitReason = getForcedPolymarketSignalExitReason(signal);
                const isExitOnly = signal.exitOnly === true;
                const exitTargets = config.disableSignalExits && forcedExitReason === null && !isExitOnly
                    ? undefined
                    : findSignalExitTargets(positions, signal, config.allowSameBarExit);

                if ((!exitTargets || exitTargets.length === 0) && positions.length < maxOpenTrades) {
                    // New entry
                    if (forcedExitReason !== null || isExitOnly) {
                        continue;
                    }
                    if (config.disableSignalExits && hasOppositePositionForSignal(positions, signal)) {
                        continue;
                    }
                    if (isSignalExitReentryCooldownActive(signalExitReentryCooldownUntilBarIndex, i)) {
                        continue;
                    }
                    if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                        continue;
                    }
                    openSignalPosition(signal, i);
                } else if (exitTargets && exitTargets.length > 0) {
                    // Signal exit
                    let allTargetsFullyClosed = true;
                    let allExitOrdersFull = true;
                    for (const exitTarget of exitTargets) {
                        if (!canExitAfterMinimumHold(exitTarget, config)) {
                            allTargetsFullyClosed = false;
                            continue;
                        }
                        const exitOrder = resolveSignalExitOrder(exitTarget, signal);
                        if (!exitOrder) {
                            allTargetsFullyClosed = false;
                            continue;
                        }

                        diagnostics && diagnostics.counts.signalExitOrders++;
                        const exitPrice = resolveSignalExitPrice(exitTarget, signal, slippageRate);
                        const { fullyClosed } = recordExitFull(exitTarget, candle, exitPrice, exitOrder.exitSize, forcedExitReason ?? 'signal');
                        allTargetsFullyClosed = allTargetsFullyClosed && fullyClosed;
                        allExitOrdersFull = allExitOrdersFull && !exitOrder.wasPartial;
                        if (fullyClosed) {
                            finalizeClosedPositionFull(exitTarget, candle, exitPrice, forcedExitReason ?? 'signal');
                        }
                    }
                    if (forcedExitReason === null && !isExitOnly && allTargetsFullyClosed && canImmediatelyReenterAfterSignalExit({
                        fullyClosed: true,
                        wasPartial: !allExitOrdersFull,
                        tradeDirection,
                        flipLossDirection,
                        signal,
                        positions,
                        maxOpenTrades,
                        signalExitReentryCooldownUntilBarIndex,
                        barIndex: i,
                    })) {
                        openSignalPosition(signal, i);
                    }
                }
            }
        }

        // Process exits for ALL open positions
        for (let p = positions.length - 1; p >= 0; p--) {
            const pos = positions[p];
            const openedThisBar = pos.openedBarIndex === i;
            if (!openedThisBar) {
                pos.barsInTrade += 1;
            }

            if (config.executionModel === 'next_open' && openedThisBar && !config.allowSameBarExit) {
                const stopLossTrigger = processPositionExits(candle, pos, config, slippageRate, STOP_LOSS_ONLY_POSITION_EXIT_OPTIONS, undefined, i);
                if (stopLossTrigger) {
                    const { fullyClosed } = recordExitFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitSize, stopLossTrigger.exitReason);
                    if (fullyClosed) {
                        finalizeClosedPositionFull(pos, candle, stopLossTrigger.exitPrice, stopLossTrigger.exitReason);
                    }
                }
                continue;
            }

            updateSmartSizingPosition(config, smartSizingPositionState, pos, candle);
            const pathExitContext: PathExitEvaluationContext | undefined = config.pathExitEnabled ? {
                data,
                barIndex: i,
                atrValue: indicatorSeries.atr[i],
                learningState,
            } : undefined;
            const exitTrigger = processPositionExits(candle, pos, config, slippageRate, undefined, pathExitContext, i);
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
                    const forcedExitReason = getForcedPolymarketSignalExitReason(signal);
                    const isExitOnly = signal.exitOnly === true;
                    const exitTargets = config.disableSignalExits && forcedExitReason === null && !isExitOnly
                        ? undefined
                        : findSignalExitTargets(positions, signal, config.allowSameBarExit);

                    if ((!exitTargets || exitTargets.length === 0) && positions.length < maxOpenTrades) {
                        // New entry
                        if (forcedExitReason !== null || isExitOnly) {
                            continue;
                        }
                        if (config.disableSignalExits && hasOppositePositionForSignal(positions, signal)) {
                            continue;
                        }
                        if (isEntryCooldownEnabled(config)
                            && isSignalExitReentryCooldownActive(signalExitReentryCooldownUntilBarIndex, i)) {
                            continue;
                        }
                        if (!canEnterLossFlipDirection(tradeDirection, flipLossDirection, signal)) {
                            continue;
                        }
                        const opened = openSignalPosition(signal, i);
                        if (opened) {
                            finalizeEntryBarStateFull(opened.position, candle, i);
                        }
                    } else if (exitTargets && exitTargets.length > 0) {
                        // Signal exit
                        let allTargetsFullyClosed = true;
                        let allExitOrdersFull = true;
                        for (const exitTarget of exitTargets) {
                            if (!canExitAfterMinimumHold(exitTarget, config)) {
                                allTargetsFullyClosed = false;
                                continue;
                            }
                            const exitOrder = resolveSignalExitOrder(exitTarget, signal);
                            if (!exitOrder) {
                                allTargetsFullyClosed = false;
                                continue;
                            }

                            diagnostics && diagnostics.counts.signalExitOrders++;
                            const exitPrice = resolveSignalExitPrice(exitTarget, signal, slippageRate);
                            const { fullyClosed } = recordExitFull(exitTarget, candle, exitPrice, exitOrder.exitSize, forcedExitReason ?? 'signal');
                            allTargetsFullyClosed = allTargetsFullyClosed && fullyClosed;
                            allExitOrdersFull = allExitOrdersFull && !exitOrder.wasPartial;
                            if (fullyClosed) {
                                finalizeClosedPositionFull(exitTarget, candle, exitPrice, forcedExitReason ?? 'signal');
                            }
                        }
                        if (forcedExitReason === null && !isExitOnly && allTargetsFullyClosed && canImmediatelyReenterAfterSignalExit({
                            fullyClosed: true,
                            wasPartial: !allExitOrdersFull,
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

        if (diagnostics && positions.length > 0) {
            diagnostics.counts.barsWithPosition++;
            diagnostics.counts.maxOpenPositions = Math.max(diagnostics.counts.maxOpenPositions, positions.length);
        }
        let unrealizedPnl = 0;
        for (let p = 0; p < positions.length; p++) {
            unrealizedPnl += (candle.close - positions[p].entryPrice) * positions[p].size * directionFactorFor(positions[p].direction);
        }
        const equity = capital + unrealizedPnl;
        if (!omitEquityCurve) {
            equityCurve.push({ time: candle.time, value: equity });
        }
        if (equity > peakEquity) {
            peakEquity = equity;
        } else {
            const drawdown = peakEquity - equity;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
                maxDrawdownPercent = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
            }
        }
    }
    addBacktestDiagnosticElapsed(diagnostics, "tradeSimulation", tradeSimulationStartedAt);

    const forcedCloseStartedAt = performance.now();
    if (positions.length > 0 && data.length > 0) {
        const candle = data[data.length - 1];
        while (positions.length > 0) {
            const pos = positions[0];
            const d = calculateTradeExitDetails(pos, candle.close, pos.size, commissionRate);
            capital += d.rawPnl - d.commission;
            const eodTrade: Trade = { id: ++tradeId, type: pos.direction, entryTime: pos.entryTime, entryPrice: pos.entryPrice, exitTime: candle.time, exitPrice: candle.close, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: 'end_of_data', stopLossPrice: pos.stopLossPrice, takeProfitPrice: pos.takeProfitPrice };
            trades.push(eodTrade);
            if (diagnostics) {
                diagnostics.counts.tradesClosed++;
                diagnostics.counts.forcedEndOfDataExits++;
            }
            positions.splice(0, 1);
        }
        if (equityCurve.length > 0) {
            equityCurve[equityCurve.length - 1] = { time: candle.time, value: capital };
        }
        if (capital > peakEquity) {
            peakEquity = capital;
        } else {
            const drawdown = peakEquity - capital;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
                maxDrawdownPercent = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
            }
        }
    }
    addBacktestDiagnosticElapsed(diagnostics, "forcedClose", forcedCloseStartedAt);


    const drawdownStartedAt = performance.now();
    addBacktestDiagnosticElapsed(diagnostics, "drawdown", drawdownStartedAt);
    const metricsStartedAt = performance.now();
    const result = calculateBacktestStats(trades, equityCurve, initialCapital, capital, maxDrawdown, maxDrawdownPercent, options);
    addBacktestDiagnosticElapsed(diagnostics, "metrics", metricsStartedAt);
    return finalizeBacktestDiagnostics(diagnostics, result, runStartedAt);
}
