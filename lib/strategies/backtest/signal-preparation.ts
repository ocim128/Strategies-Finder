
import { BacktestSettings, OHLCVData, Signal, Time, TradeDirection } from '../../types/index';
import { calculateADX, calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';
import { getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { IndicatorSeries, NormalizedSettings, PreparedSignal } from '../../types/backtest';
import { getTimeIndex, getExecutionShift, resolveExecutionPrice, compareTime, normalizeBacktestSettings, normalizeTradeDirection, timeToNumber, timeKey, signalToPositionDirection } from './backtest-utils';
import { resolveTrendPeriod, passesTradeFilter, passesRegimeFilters } from './trade-filters';
import { runBacktest } from './backtest-engine';

export function prepareSignals(
    data: OHLCVData[],
    signals: Signal[],
    config: NormalizedSettings,
    indicators: IndicatorSeries,
    tradeDirection: TradeDirection
): Signal[] {
    if (signals.length === 0) return [];
    const timeIndex = getTimeIndex(data);

    const prepared: PreparedSignal[] = [];
    const executionShift = getExecutionShift(config);

    signals.forEach((signal, order) => {
        const signalIndex = Number.isFinite(signal.barIndex)
            ? Math.trunc(signal.barIndex as number)
            : timeIndex.get(timeKey(signal.time));
        if (signalIndex === undefined || signalIndex < 0 || signalIndex >= data.length) return;

        if (tradeDirection !== 'both') {
            const entryType: Signal['type'] = tradeDirection === 'short' ? 'sell' : 'buy';
            const exitType: Signal['type'] = tradeDirection === 'short' ? 'buy' : 'sell';

            if (signal.type === exitType) {
                const exitIndex = signalIndex + executionShift;
                if (exitIndex < 0 || exitIndex >= data.length) return;
                const exitPrice = resolveExecutionPrice(data, signal, signalIndex, exitIndex, config);
                prepared.push({
                    time: data[exitIndex].time,
                    type: exitType,
                    price: exitPrice,
                    reason: signal.reason,
                    order
                });
                return;
            }

            if (signal.type !== entryType) return;

            let entryIndex = signalIndex + executionShift;
            if (config.tradeFilterMode === 'close') {
                entryIndex = Math.max(entryIndex, signalIndex + 1);
            }
            if (entryIndex >= data.length) return;

            if (!passesTradeFilter(data, entryIndex, config, indicators, tradeDirection)) return;
            if (!passesRegimeFilters(data, entryIndex, config, indicators, tradeDirection)) return;

            const entryPrice = resolveExecutionPrice(data, signal, signalIndex, entryIndex, config);

            prepared.push({
                time: data[entryIndex].time,
                type: entryType,
                price: entryPrice,
                reason: signal.reason,
                order
            });
            return;
        }

        if (signal.type !== 'buy' && signal.type !== 'sell') return;

        let entryIndex = signalIndex + executionShift;
        if (config.tradeFilterMode === 'close') {
            entryIndex = Math.max(entryIndex, signalIndex + 1);
        }
        if (entryIndex >= data.length) return;

        const signalDirection = signalToPositionDirection(signal.type);
        if (!passesTradeFilter(data, entryIndex, config, indicators, signalDirection)) return;
        if (!passesRegimeFilters(data, entryIndex, config, indicators, signalDirection)) return;

        const entryPrice = resolveExecutionPrice(data, signal, signalIndex, entryIndex, config);

        prepared.push({
            time: data[entryIndex].time,
            type: signal.type,
            price: entryPrice,
            reason: signal.reason,
            order
        });
    });

    prepared.sort((a, b) => compareTime(a.time, b.time) || a.order - b.order);

    return prepared.map(({ order, ...signal }) => signal);
}

/**
 * Prepare signals for the scanner using the same logic as the backtest engine.
 * This ensures the scanner shows the same entry prices and filters as the backtest.
 * 
 * @param data OHLCV data array
 * @param signals Raw signals from strategy execution
 * @param settings Backtest settings for filtering and price resolution
 * @returns Prepared signals with resolved execution prices
 */
export function prepareSignalsForScanner(
    data: OHLCVData[],
    signals: Signal[],
    settings: BacktestSettings = {}
): Signal[] {
    if (signals.length === 0 || data.length === 0) return [];

    const config = normalizeBacktestSettings(settings);
    const tradeDirection = normalizeTradeDirection(settings);

    // Compute indicators needed for trade filters
    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);

    const needsAtr = config.atrPercentMin > 0 || config.atrPercentMax > 0;
    const atr = needsAtr ? calculateATR(highs, lows, closes, config.atrPeriod) : [];
    const trendPeriod = resolveTrendPeriod(config);
    const emaTrend = trendPeriod > 0 ? calculateEMA(closes, trendPeriod) : [];

    const useAdx = config.tradeFilterMode === 'adx' || config.adxMin > 0 || config.adxMax > 0;
    const adxPeriod = useAdx ? Math.max(1, config.adxPeriod) : 0;
    const adx = useAdx ? calculateADX(highs, lows, closes, adxPeriod) : [];

    const volumeSma = config.tradeFilterMode === 'volume'
        ? calculateSMA(volumes, config.volumeSmaPeriod)
        : [];
    const rsi = config.tradeFilterMode === 'rsi'
        ? calculateRSI(closes, config.rsiPeriod)
        : [];

    const indicators: IndicatorSeries = {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi
    };

    // Use the same prepareSignals logic
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
    if (Math.abs(exitTimeNum - lastBarTimeNum) > 60000) { // 60 seconds in milliseconds
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

    // Calculate take profit price from settings
    let takeProfitPrice: number | null = null;
    if (settings.takeProfitEnabled && settings.takeProfitPercent && settings.takeProfitPercent > 0) {
        // Calculate TP based on percentage: entry * (1 + direction * tp%)
        takeProfitPrice = lastTrade.entryPrice * (1 + directionFactor * (settings.takeProfitPercent / 100));
    }

    return {
        direction: lastTrade.type,
        entryTime: lastTrade.entryTime,
        entryPrice: lastTrade.entryPrice,
        currentPrice,
        unrealizedPnlPercent,
        barsInTrade,
        stopLossPrice: null, // Would need more complex tracking to get these
        takeProfitPrice,
    };
}




