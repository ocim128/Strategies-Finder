
import { BacktestSettings, OHLCVData, Signal, Time, TradeDirection } from '../../types/index';
import { IndicatorSeries, NormalizedSettings } from '../../types/backtest';
import { getTimeIndex, getExecutionShift, resolveExecutionPrice, compareTime, isBothLikeTradeDirection, normalizeBacktestSettings, normalizeTradeDirection, timeToNumber, signalToPositionDirection, getTimeIndexValue } from './backtest-utils';
import { passesRegimeFilters } from './regime-filters';
import { resolveIndicators } from './indicator-precompute';
import { runBacktest } from './backtest-engine';
import { resolveEntryRiskTargets } from '../../entry-risk-targets';

export function prepareSignals(
    data: OHLCVData[],
    signals: Signal[],
    config: NormalizedSettings,
    indicators: IndicatorSeries,
    tradeDirection: TradeDirection
): Signal[] {
    if (signals.length === 0) return [];
    let timeIndex: Map<string, number> | null = null;

    const prepared: Signal[] = [];
    let isPreparedOrderSorted = true;
    let lastPreparedBarIndex = -1;
    const executionShift = getExecutionShift(config);
    const isBothLikeDirection = isBothLikeTradeDirection(tradeDirection);
    const entryType: Signal['type'] = tradeDirection === 'short' ? 'sell' : 'buy';
    const exitType: Signal['type'] = tradeDirection === 'short' ? 'buy' : 'sell';
    const hasRegimeFilters = config.marketMode !== 'all'
        || config.trendEmaPeriod > 0
        || config.atrPercentMin > 0
        || config.atrPercentMax > 0
        || config.adxMin > 0
        || config.adxMax > 0;

    const pushPreparedSignal = (
        barIndex: number,
        signal: Signal,
        type: Signal['type'],
        price: number
    ): void => {
        if (barIndex < lastPreparedBarIndex) {
            isPreparedOrderSorted = false;
        }
        lastPreparedBarIndex = barIndex;
        prepared.push({
            barIndex,
            time: data[barIndex].time,
            type,
            price,
            triggerPrice: signal.price,
            reason: signal.reason,
            sizeFraction: signal.sizeFraction
        });
    };

    for (let order = 0; order < signals.length; order++) {
        const signal = signals[order];
        const signalIndex = Number.isFinite(signal.barIndex)
            ? Math.trunc(signal.barIndex as number)
            : getTimeIndexValue(timeIndex ??= getTimeIndex(data), signal.time);
        if (signalIndex === undefined || signalIndex < 0 || signalIndex >= data.length) continue;

        if (!isBothLikeDirection) {
            if (signal.type === exitType) {
                const exitIndex = signalIndex + executionShift;
                if (exitIndex < 0 || exitIndex >= data.length) continue;
                const exitPrice = resolveExecutionPrice(data, signal, signalIndex, exitIndex, config);
                pushPreparedSignal(exitIndex, signal, exitType, exitPrice);
                continue;
            }

            if (signal.type !== entryType) continue;

            const decisionIndex = signalIndex;
            if (decisionIndex >= data.length) continue;

            const executionIndex = decisionIndex + executionShift;
            if (executionIndex >= data.length) continue;

            if (hasRegimeFilters && !passesRegimeFilters(data, decisionIndex, config, indicators, tradeDirection)) continue;

            const entryPrice = resolveExecutionPrice(data, signal, signalIndex, executionIndex, config);

            pushPreparedSignal(executionIndex, signal, entryType, entryPrice);
            continue;
        }

        if (signal.type !== 'buy' && signal.type !== 'sell') continue;

        const decisionIndex = signalIndex;
        if (decisionIndex >= data.length) continue;

        const executionIndex = decisionIndex + executionShift;
        if (executionIndex >= data.length) continue;

        if (hasRegimeFilters) {
            const signalDirection = signalToPositionDirection(signal.type);
            if (!passesRegimeFilters(data, decisionIndex, config, indicators, signalDirection)) continue;
        }

        const entryPrice = resolveExecutionPrice(data, signal, signalIndex, executionIndex, config);

        pushPreparedSignal(executionIndex, signal, signal.type, entryPrice);
    }

    if (isPreparedOrderSorted) {
        return prepared;
    }

    return prepared.map((signal, index) => ({ signal, index })).sort((a, b) => {
        const aSignal = a.signal;
        const bSignal = b.signal;
        const aBarIndex = Number.isFinite(aSignal.barIndex as number) ? Math.trunc(aSignal.barIndex as number) : null;
        const bBarIndex = Number.isFinite(bSignal.barIndex as number) ? Math.trunc(bSignal.barIndex as number) : null;
        if (aBarIndex !== null && bBarIndex !== null && aBarIndex !== bBarIndex) {
            return aBarIndex - bBarIndex;
        }
        return compareTime(aSignal.time, bSignal.time) || a.index - b.index;
    }).map(({ signal }) => signal);
}

/**
 * Prepare signals for the scanner using the same logic as the backtest engine.
 * This ensures the scanner shows the same entry prices and filters as the backtest.
 */
export function prepareSignalsForScanner(
    data: OHLCVData[],
    signals: Signal[],
    settings: BacktestSettings = {}
): Signal[] {
    if (signals.length === 0 || data.length === 0) return [];

    const config = normalizeBacktestSettings(settings);
    const tradeDirection = normalizeTradeDirection(settings);
    const indicators = resolveIndicators(data, settings);

    return prepareSignals(data, signals, config, indicators, tradeDirection);
}

/**
 * Represents an open position returned by getOpenPositionForScanner
 */
export interface OpenPosition {
    direction: 'long' | 'short';
    entryTime: Time;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnlPercent: number;
    barsInTrade: number;
    stopLossPrice: number | null;
    takeProfitPrice: number | null;
}

/**
 * Get the current open position (if any) for the scanner.
 * This runs a lightweight backtest to determine position state.
 * 
 * @param data OHLCV data array
 * @param signals Raw signals from strategy execution
 * @param settings Backtest settings 
 * @returns OpenPosition if there's a currently open position, null otherwise
 */
export function getOpenPositionForScanner(
    data: OHLCVData[],
    signals: Signal[],
    settings: BacktestSettings = {}
): OpenPosition | null {
    if (signals.length === 0 || data.length === 0) return null;

    // Run backtest to get trades
    const result = runBacktest(
        data,
        signals,
        10000, // Initial capital (doesn't affect position detection)
        100,   // 100% position size
        0,     // No commission for this check
        settings
    );

    // Check if the last trade is still open (exited at end_of_data with current bar)
    if (result.trades.length === 0) return null;

    const lastTrade = result.trades[result.trades.length - 1];
    const lastBar = data[data.length - 1];

    // A trade is "open" if it exited due to end_of_data AND the exit time is the last bar
    // This means the backtest closed it artificially, so it's really still open
    if (lastTrade.exitReason !== 'end_of_data') {
        return null; // Trade was closed by SL/TP/signal, not open
    }

    // Compare exit time with last bar time
    const exitTimeNum = timeToNumber(lastTrade.exitTime);
    const lastBarTimeNum = timeToNumber(lastBar.time);

    // If exit time is the last bar, position is open
    if (exitTimeNum === null || lastBarTimeNum === null) {
        return null;
    }

    const toEpochMs = (numericTime: number): number => {
        return Math.abs(numericTime) < 1e11 ? numericTime * 1000 : numericTime;
    };

    const exitTimeMs = toEpochMs(exitTimeNum);
    const lastBarTimeMs = toEpochMs(lastBarTimeNum);
    if (Math.abs(exitTimeMs - lastBarTimeMs) > 60000) { // 60 seconds
        return null; // Exit wasn't at last bar, position was closed before
    }

    const currentPrice = lastBar.close;
    const directionFactor = lastTrade.type === 'long' ? 1 : -1;
    const unrealizedPnlPercent = directionFactor * ((currentPrice - lastTrade.entryPrice) / lastTrade.entryPrice) * 100;

    // Calculate bars in trade
    const entryTimeNum = timeToNumber(lastTrade.entryTime);
    if (entryTimeNum === null) return null;

    let entryBarIndex = 0;
    for (let i = 0; i < data.length; i++) {
        const barTime = timeToNumber(data[i].time);
        if (barTime !== null && barTime >= entryTimeNum) {
            entryBarIndex = i;
            break;
        }
    }
    const barsInTrade = data.length - 1 - entryBarIndex;

    const stopLossPrice = typeof lastTrade.stopLossPrice === 'number' && Number.isFinite(lastTrade.stopLossPrice)
        ? lastTrade.stopLossPrice
        : null;
    let takeProfitPrice = typeof lastTrade.takeProfitPrice === 'number' && Number.isFinite(lastTrade.takeProfitPrice)
        ? lastTrade.takeProfitPrice
        : null;

    // Fallback for legacy trades where TP wasn't populated on the EOD trade.
    if (takeProfitPrice === null) {
        takeProfitPrice = resolveEntryRiskTargets({
            candles: data,
            entryTime: lastTrade.entryTime,
            entryPrice: lastTrade.entryPrice,
            direction: lastTrade.type,
            settings,
            entryBarIndex,
        }).takeProfitPrice;
    }

    return {
        direction: lastTrade.type,
        entryTime: lastTrade.entryTime,
        entryPrice: lastTrade.entryPrice,
        currentPrice,
        unrealizedPnlPercent,
        barsInTrade,
        stopLossPrice,
        takeProfitPrice,
    };
}




