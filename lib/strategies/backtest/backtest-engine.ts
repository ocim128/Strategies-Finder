
import { BacktestResult, BacktestSettings, OHLCVData, Signal, Time, Trade } from '../../types/index';
import { ensureCleanData } from '../strategy-helpers';
import { PositionState, PrecomputedIndicators, TradeSizingConfig } from '../../types/backtest';
import { compareTime, directionFactorFor, directionToSignalType, normalizeBacktestSettings, normalizeTradeDirection } from './backtest-utils';

import { prepareSignals } from './signal-preparation';
import { calculateTradeExitDetails, createEmptyBacktestResult, finalizeBacktestMetrics, calculateBacktestStats, calculateMaxDrawdown } from './position-stats';
import { precomputeIndicators, resolveIndicators } from './indicator-precompute';
import { buildPositionFromSignal } from './position-builder';
import { processPositionExits, updatePositionState } from './exit-handlers';

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
    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection);

    let capital = initialCapital;
    let position: PositionState | null = null;
    let totalTrades = 0, winningTrades = 0, totalProfit = 0, totalLoss = 0;
    let avgReturn = 0, returnM2 = 0, peakEquity = initialCapital, maxDrawdown = 0, maxDrawdownPercent = 0;
    let signalIdx = 0;

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        if (position) {
            position.barsInTrade += 1;
            processPositionExits(candle, position, config, slippageRate, (exitPrice, exitSize) => {
                const details = calculateTradeExitDetails(position!, exitPrice, exitSize, commissionRate);
                capital += details.rawPnl - details.commission;
                totalTrades++;
                if (details.totalPnl > 0) { winningTrades++; totalProfit += details.totalPnl; } else { totalLoss += Math.abs(details.totalPnl); }
                const delta = details.pnlPercent - avgReturn;
                avgReturn += delta / totalTrades;
                returnM2 += delta * (details.pnlPercent - avgReturn);
                position!.size -= details.size;
                if (position!.size <= 0) position = null;
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
                    const exitPrice = (candle.close + candle.open) / 2; // Approximate or use slippage
                    const details = calculateTradeExitDetails(position, exitPrice, position.size, commissionRate);
                    capital += details.rawPnl - details.commission;
                    totalTrades++;
                    if (details.totalPnl > 0) { winningTrades++; totalProfit += details.totalPnl; } else { totalLoss += Math.abs(details.totalPnl); }
                    const delta = details.pnlPercent - avgReturn;
                    avgReturn += delta / totalTrades;
                    returnM2 += delta * (details.pnlPercent - avgReturn);
                    position = null;
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
    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection);

    let capital = initialCapital, position: PositionState | null = null, tradeId = 0, signalIdx = 0;
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
                trades.push({ id: ++tradeId, type: position!.direction, entryTime: position!.entryTime, entryPrice: position!.entryPrice, exitTime: candle.time, exitPrice, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: reason });
                position!.size -= d.size;
                if (position!.size <= 0) position = null;
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
                    const details = calculateTradeExitDetails(position, signal.price, position.size, commissionRate);
                    capital += details.rawPnl - details.commission;
                    trades.push({ id: ++tradeId, type: position.direction, entryTime: position.entryTime, entryPrice: position.entryPrice, exitTime: candle.time, exitPrice: signal.price, pnl: details.totalPnl, pnlPercent: details.pnlPercent, size: details.size, fees: details.fees, exitReason: 'signal' });
                    position = null;
                    if (tradeDirection === 'both') {
                        const opened = buildPositionFromSignal({ signal, barIndex: i, capital, initialCapital, positionSizePercent, commissionRate, slippageRate, settings: config, atrArray: indicatorSeries.atr, tradeDirection, sizingMode, fixedTradeAmount });
                        if (opened) { position = opened.nextPosition; capital -= opened.entryCommission; }
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
        trades.push({ id: ++tradeId, type: position.direction, entryTime: position.entryTime, entryPrice: position.entryPrice, exitTime: candle.time, exitPrice: candle.close, pnl: d.totalPnl, pnlPercent: d.pnlPercent, size: d.size, fees: d.fees, exitReason: 'end_of_data' });
    }

    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);
    return calculateBacktestStats(trades, equityCurve, initialCapital, capital, maxDrawdown, maxDrawdownPercent);
}
