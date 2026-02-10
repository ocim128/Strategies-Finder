
import { BacktestResult, BacktestSettings, OHLCVData, Signal, Time, Trade } from '../../types/index';
import { ensureCleanData } from '../strategy-helpers';
import { PositionState, PrecomputedIndicators, TradeSizingConfig } from '../../types/backtest';
import { compareTime, directionFactorFor, directionToSignalType, needsSnapshotIndicators, normalizeBacktestSettings, normalizeTradeDirection } from './backtest-utils';

import { prepareSignals } from './signal-preparation';
import { calculateTradeExitDetails, createEmptyBacktestResult, finalizeBacktestMetrics, calculateBacktestStats, calculateMaxDrawdown } from './position-stats';
import { precomputeIndicators, resolveIndicators } from './indicator-precompute';
import { buildPositionFromSignal } from './position-builder';
import { processPositionExits, updatePositionState } from './exit-handlers';
import { captureTradeSnapshot, computeSnapshotIndicators, SnapshotIndicators } from './snapshot-capture';
import { TradeSnapshot } from '../../types/index';

export { precomputeIndicators };

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
    precomputed?: PrecomputedIndicators
): BacktestResult {
    if (signals.length === 0) return createEmptyBacktestResult();

    const config = normalizeBacktestSettings(settings);
    const tradeDirection = normalizeTradeDirection(settings);
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
                    const exitPrice = (candle.close + candle.open) / 2;
                    recordExit(exitPrice, position.size);
                    if (tradeDirection === 'both') {
                        const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                        if (opened) { position = opened.nextPosition; capital -= opened.entryCommission; }
                    }
                }
            }
        }

        const equity = capital + (position ? (candle.close - position.entryPrice) * position.size * directionFactorFor(position.direction) : 0);
        if (equity > peakEquity) peakEquity = equity; else {
            const dd = peakEquity - equity;
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

    const config = normalizeBacktestSettings(settings);
    const tradeDirection = normalizeTradeDirection(settings);
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
                            currentSnapshot = captureTradeSnapshot(data, i, indicatorSeries, snapshotIndicators);
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
                                currentSnapshot = captureTradeSnapshot(data, i, indicatorSeries, snapshotIndicators);
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
