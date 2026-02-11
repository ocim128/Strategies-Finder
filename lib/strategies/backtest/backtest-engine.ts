
import { BacktestResult, BacktestSettings, OHLCVData, Signal, Time, Trade } from '../../types/index';
import { ensureCleanData } from '../strategy-helpers';
import { PositionState, PrecomputedIndicators, TradeSizingConfig } from '../../types/backtest';
import { compareTime, directionFactorFor, directionToSignalType, needsSnapshotIndicators, normalizeBacktestSettings, normalizeTradeDirection, timeKey } from './backtest-utils';
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
    const combinedReturns: number[] = [];
    let prevEquity = initialCapital;

    for (let i = 0; i < len; i++) {
        const combined = longEquity[i] + shortEquity[i];
        if (combined > peakEquity) {
            peakEquity = combined;
        } else {
            const dd = peakEquity - combined;
            if (dd > maxDrawdown) {
                maxDrawdown = dd;
                maxDrawdownPercent = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
            }
        }
        // Collect per-bar returns for Sharpe calculation
        if (prevEquity > 0) {
            combinedReturns.push((combined - prevEquity) / prevEquity);
        }
        prevEquity = combined;
    }

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
    return calculateBacktestStats(mergedTrades, equityCurve, initialCapital, finalCapital, maxDrawdown, maxDrawdownPercent);
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

    let capital = initialCapital;
    let position: PositionState | null = null;
    let totalTrades = 0, winningTrades = 0, totalProfit = 0, totalLoss = 0;
    let avgReturn = 0, returnM2 = 0, peakEquity = initialCapital, maxDrawdown = 0, maxDrawdownPercent = 0;
    let signalIdx = 0;

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;

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
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        if (position) {
            position.barsInTrade += 1;
            processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize) => {
                recordExit(exitPrice, exitSize);
            });
            if (position) updatePositionState(candle, position, config, indicatorSeries.atr[i]);
        }

        while (signalIdx < preparedSignals.length && compareTime(preparedSignals[signalIdx].time, candle.time) <= 0) {
            const signal = preparedSignals[signalIdx++];
            if (compareTime(signal.time, candle.time) === 0) {
                if (!position) {
                    const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                    if (opened) { position = opened.nextPosition; capital -= opened.entryCommission; }
                } else if (signal.type === directionToSignalType(position.direction === 'long' ? 'short' : 'long') && (config.allowSameBarExit || compareTime(signal.time, position.entryTime) !== 0)) {
                    // Signal exit
                    const exitPrice = signal.price;
                    recordExit(exitPrice, position.size);
                    if (tradeDirection === 'both') {
                        const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                        if (opened) { position = opened.nextPosition; capital -= opened.entryCommission; }
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

    const doSnapshot = !!settings.captureSnapshots;

    let capital = initialCapital, position: PositionState | null = null, tradeId = 0, signalIdx = 0;
    let currentSnapshot: TradeSnapshot | null = null;
    const trades: Trade[] = [];
    const equityCurve: { time: Time; value: number }[] = [];
    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];
        if (position) {
            position.barsInTrade += 1;
            processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize, reason) => {
                const d = calculateTradeExitDetails(position!, exitPrice, exitSize, commissionRate);
                capital += d.rawPnl - d.commission;
                const trade: Trade = { id: ++tradeId, type: position!.direction, entryTime: position!.entryTime, entryPrice: position!.entryPrice, exitTime: candle.time, exitPrice, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: reason };
                if (currentSnapshot) trade.entrySnapshot = currentSnapshot;
                trades.push(trade);
                position!.size -= d.size;
                if (position!.size <= 0) { position = null; currentSnapshot = null; }
            });
            if (position) updatePositionState(candle, position, config, indicatorSeries.atr[i]);
        }

        while (signalIdx < preparedSignals.length && compareTime(preparedSignals[signalIdx].time, candle.time) <= 0) {
            const signal = preparedSignals[signalIdx++];
            if (compareTime(signal.time, candle.time) === 0) {
                if (!position) {
                    const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                    if (opened) {
                        position = opened.nextPosition;
                        capital -= opened.entryCommission;
                        if (doSnapshot && snapshotIndicators) {
                            currentSnapshot = captureTradeSnapshot(
                                data,
                                i,
                                indicatorSeries,
                                snapshotIndicators,
                                opened.nextPosition.direction,
                                signal.triggerPrice ?? signal.price
                            );
                        }
                    }
                } else if (signal.type === directionToSignalType(position.direction === 'long' ? 'short' : 'long') && (config.allowSameBarExit || compareTime(signal.time, position.entryTime) !== 0)) {
                    const details = calculateTradeExitDetails(position, signal.price, position.size, commissionRate);
                    capital += details.rawPnl - details.commission;
                    const sigTrade: Trade = { id: ++tradeId, type: position.direction, entryTime: position.entryTime, entryPrice: position.entryPrice, exitTime: candle.time, exitPrice: signal.price, pnl: details.totalPnl, pnlPercent: details.pnlPercent, size: details.size, fees: details.fees, exitReason: 'signal' };
                    if (currentSnapshot) sigTrade.entrySnapshot = currentSnapshot;
                    trades.push(sigTrade);
                    position = null;
                    currentSnapshot = null;
                    if (tradeDirection === 'both') {
                        const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                        if (opened) {
                            position = opened.nextPosition;
                            capital -= opened.entryCommission;
                            if (doSnapshot && snapshotIndicators) {
                                currentSnapshot = captureTradeSnapshot(
                                    data,
                                    i,
                                    indicatorSeries,
                                    snapshotIndicators,
                                    opened.nextPosition.direction,
                                    signal.triggerPrice ?? signal.price
                                );
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
    }

    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);
    return calculateBacktestStats(trades, equityCurve, initialCapital, capital, maxDrawdown, maxDrawdownPercent);
}
