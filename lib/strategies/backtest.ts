import { Trade, BacktestResult, OHLCVData, Signal, Time, BacktestSettings, TradeFilterMode, MarketMode, TradeDirection } from './types';
import { calculateATR, calculateEMA, calculateADX, calculateSMA, calculateRSI } from './indicators';
import { ensureCleanData, getHighs, getLows, getCloses, getVolumes } from './strategy-helpers';
import { calculateSharpeRatioFromMoments, calculateSharpeRatioFromReturns } from './performance-metrics';

// ============================================================================
// Backtesting Engine
// ============================================================================
// ... (rest of the file remains same, but I need to replace the local getSeries and its usage)

interface NormalizedSettings {
    atrPeriod: number;
    stopLossAtr: number;
    takeProfitAtr: number;
    trailingAtr: number;
    partialTakeProfitAtR: number;
    partialTakeProfitPercent: number;
    breakEvenAtR: number;
    timeStopBars: number;

    riskMode: 'simple' | 'advanced' | 'percentage';
    stopLossPercent: number;
    takeProfitPercent: number;
    stopLossEnabled: boolean;
    takeProfitEnabled: boolean;

    trendEmaPeriod: number;
    trendEmaSlopeBars: number;
    atrPercentMin: number;
    atrPercentMax: number;
    adxPeriod: number;
    adxMin: number;
    adxMax: number;

    tradeFilterMode: TradeFilterMode;
    confirmLookback: number;
    volumeSmaPeriod: number;
    volumeMultiplier: number;
    rsiPeriod: number;
    rsiBullish: number;
    rsiBearish: number;
    marketMode: MarketMode;
    executionModel: 'signal_close' | 'next_open' | 'next_close';
    allowSameBarExit: boolean;
    slippageBps: number;
}

interface IndicatorSeries {
    atr: (number | null)[];
    emaTrend: (number | null)[];
    adx: (number | null)[];
    volumeSma: (number | null)[];
    rsi: (number | null)[];
}

/**
 * Pre-computed indicators that can be reused across multiple backtest runs.
 * This saves significant computation time for large datasets in the finder.
 */
export interface PrecomputedIndicators extends IndicatorSeries {
    /** Source data reference for cache validation */
    readonly dataLength: number;
}

interface PositionState {
    direction: 'long' | 'short';
    entryTime: Time;
    entryPrice: number;
    size: number;
    entryCommissionPerShare: number;
    stopLossPrice: number | null;
    takeProfitPrice: number | null;
    riskPerShare: number;
    barsInTrade: number;
    extremePrice: number;
    partialTargetPrice: number | null;
    partialTaken: boolean;
    breakEvenApplied: boolean;
}

interface TradeSizingConfig {
    mode: 'percent' | 'fixed';
    fixedTradeAmount: number;
}

interface PreparedSignal extends Signal {
    order: number;
}

function toNumberOr(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) ? value! : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeBacktestSettings(settings?: BacktestSettings): NormalizedSettings {
    const tradeFilterMode = settings?.tradeFilterMode ?? settings?.entryConfirmation ?? 'none';
    const rawExecutionModel = settings?.executionModel;
    const executionModel = rawExecutionModel === 'next_open' || rawExecutionModel === 'next_close' || rawExecutionModel === 'signal_close'
        ? rawExecutionModel
        : 'signal_close';

    return {
        atrPeriod: Math.max(1, toNumberOr(settings?.atrPeriod, 14)),
        stopLossAtr: Math.max(0, toNumberOr(settings?.stopLossAtr, 0)),
        takeProfitAtr: Math.max(0, toNumberOr(settings?.takeProfitAtr, 0)),
        trailingAtr: Math.max(0, toNumberOr(settings?.trailingAtr, 0)),
        partialTakeProfitAtR: Math.max(0, toNumberOr(settings?.partialTakeProfitAtR, 0)),
        partialTakeProfitPercent: clamp(Math.max(0, toNumberOr(settings?.partialTakeProfitPercent, 0)), 0, 100),
        breakEvenAtR: Math.max(0, toNumberOr(settings?.breakEvenAtR, 0)),
        timeStopBars: Math.max(0, toNumberOr(settings?.timeStopBars, 0)),

        riskMode: settings?.riskMode ?? 'simple',
        stopLossPercent: Math.max(0, toNumberOr(settings?.stopLossPercent, 0)),
        takeProfitPercent: Math.max(0, toNumberOr(settings?.takeProfitPercent, 0)),
        stopLossEnabled: settings?.stopLossEnabled ?? false,
        takeProfitEnabled: settings?.takeProfitEnabled ?? false,

        trendEmaPeriod: Math.max(0, toNumberOr(settings?.trendEmaPeriod, 0)),
        trendEmaSlopeBars: Math.max(0, toNumberOr(settings?.trendEmaSlopeBars, 0)),
        atrPercentMin: Math.max(0, toNumberOr(settings?.atrPercentMin, 0)),
        atrPercentMax: Math.max(0, toNumberOr(settings?.atrPercentMax, 0)),
        adxPeriod: Math.max(0, toNumberOr(settings?.adxPeriod, 14)),
        adxMin: Math.max(0, toNumberOr(settings?.adxMin, 0)),
        adxMax: Math.max(0, toNumberOr(settings?.adxMax, 0)),

        tradeFilterMode,
        confirmLookback: Math.max(1, toNumberOr(settings?.confirmLookback, 1)),
        volumeSmaPeriod: Math.max(1, toNumberOr(settings?.volumeSmaPeriod, 20)),
        volumeMultiplier: Math.max(0, toNumberOr(settings?.volumeMultiplier, 1)),
        rsiPeriod: Math.max(1, toNumberOr(settings?.rsiPeriod, 14)),
        rsiBullish: clamp(toNumberOr(settings?.rsiBullish, 55), 0, 100),
        rsiBearish: clamp(toNumberOr(settings?.rsiBearish, 45), 0, 100),
        marketMode: settings?.marketMode === 'uptrend' || settings?.marketMode === 'downtrend' || settings?.marketMode === 'sideway'
            ? settings.marketMode
            : 'all',
        executionModel,
        allowSameBarExit: settings?.allowSameBarExit ?? true,
        slippageBps: Math.max(0, toNumberOr(settings?.slippageBps, 0))
    };
}

function timeKey(time: Time): string {
    if (typeof time === 'number') return time.toString();
    if (typeof time === 'string') return time;
    if (time && typeof time === 'object' && 'year' in time) {
        const businessDay = time as { year: number; month: number; day: number };
        const month = String(businessDay.month).padStart(2, '0');
        const day = String(businessDay.day).padStart(2, '0');
        return `${businessDay.year}-${month}-${day}`;
    }
    return String(time);
}

function timeToNumber(time: Time): number | null {
    if (typeof time === 'number') return time;
    if (typeof time === 'string') {
        const parsed = Date.parse(time);
        return Number.isNaN(parsed) ? null : parsed;
    }
    if (time && typeof time === 'object' && 'year' in time) {
        const businessDay = time as { year: number; month: number; day: number };
        return Date.UTC(businessDay.year, businessDay.month - 1, businessDay.day);
    }
    return null;
}

export function compareTime(a: Time, b: Time): number {
    const aNum = timeToNumber(a);
    const bNum = timeToNumber(b);
    if (aNum !== null && bNum !== null) return aNum - bNum;

    const aKey = timeKey(a);
    const bKey = timeKey(b);
    if (aKey === bKey) return 0;
    return aKey < bKey ? -1 : 1;
}

function getExecutionShift(config: NormalizedSettings): number {
    return config.executionModel === 'signal_close' ? 0 : 1;
}

function resolveExecutionPrice(
    data: OHLCVData[],
    signal: Signal,
    signalIndex: number,
    executionIndex: number,
    config: NormalizedSettings
): number {
    if (config.executionModel === 'signal_close' && executionIndex === signalIndex) {
        return signal.price;
    }
    const candle = data[executionIndex];
    return config.executionModel === 'next_open' ? candle.open : candle.close;
}

function applySlippage(price: number, side: 'buy' | 'sell', slippageRate: number): number {
    if (!Number.isFinite(slippageRate) || slippageRate <= 0) return price;
    return side === 'buy' ? price * (1 + slippageRate) : price * (1 - slippageRate);
}

function normalizeTradeDirection(settings?: BacktestSettings): TradeDirection {
    return settings?.tradeDirection === 'short' || settings?.tradeDirection === 'both' ? settings.tradeDirection : 'long';
}

const MARKET_MODE_DEFAULT_EMA_PERIOD = 200;
const MARKET_MODE_SLOPE_LOOKBACK = 20;
const MARKET_MODE_SLOPE_THRESHOLD = 0.0008;
const MARKET_MODE_SIDEWAY_DISTANCE = 0.015;
const TRADE_FILTER_DEFAULT_TREND_EMA_PERIOD = 50;
const TRADE_FILTER_DEFAULT_ADX_MIN = 20;

function resolveTrendPeriod(config: NormalizedSettings): number {
    if (config.trendEmaPeriod > 0) return config.trendEmaPeriod;
    if (config.tradeFilterMode === 'trend') return TRADE_FILTER_DEFAULT_TREND_EMA_PERIOD;
    return config.marketMode === 'all' ? 0 : MARKET_MODE_DEFAULT_EMA_PERIOD;
}

function signalToPositionDirection(type: Signal['type']): 'long' | 'short' {
    return type === 'buy' ? 'long' : 'short';
}

function directionToSignalType(direction: 'long' | 'short'): Signal['type'] {
    return direction === 'short' ? 'sell' : 'buy';
}

function entrySideForDirection(direction: 'long' | 'short'): 'buy' | 'sell' {
    return direction === 'short' ? 'sell' : 'buy';
}

function exitSideForDirection(direction: 'long' | 'short'): 'buy' | 'sell' {
    return direction === 'short' ? 'buy' : 'sell';
}

function directionFactorFor(direction: 'long' | 'short'): number {
    return direction === 'short' ? -1 : 1;
}

function allowsSignalAsEntry(signalType: Signal['type'], tradeDirection: TradeDirection): boolean {
    if (tradeDirection === 'both') return true;
    if (tradeDirection === 'short') return signalType === 'sell';
    return signalType === 'buy';
}

const timeIndexCache = new WeakMap<OHLCVData[], Map<string, number>>();

function getTimeIndex(data: OHLCVData[]): Map<string, number> {
    let cached = timeIndexCache.get(data);
    if (!cached) {
        cached = new Map<string, number>();
        data.forEach((candle, index) => {
            cached!.set(timeKey(candle.time), index);
        });
        timeIndexCache.set(data, cached);
    }
    return cached;
}

function passesTradeFilter(
    data: OHLCVData[],
    entryIndex: number,
    config: NormalizedSettings,
    indicators: IndicatorSeries,
    tradeDirection: 'long' | 'short'
): boolean {
    if (config.tradeFilterMode === 'none') return true;

    if (config.tradeFilterMode === 'close') {
        if (entryIndex <= 0) return false;

        const lookback = config.confirmLookback;
        const start = Math.max(0, entryIndex - lookback);
        if (tradeDirection === 'short') {
            let lowestLow = Infinity;
            for (let i = start; i < entryIndex; i++) {
                lowestLow = Math.min(lowestLow, data[i].low);
            }
            return data[entryIndex].close < lowestLow;
        }

        let highestHigh = -Infinity;
        for (let i = start; i < entryIndex; i++) {
            highestHigh = Math.max(highestHigh, data[i].high);
        }

        return data[entryIndex].close > highestHigh;
    }

    if (config.tradeFilterMode === 'volume') {
        const volumeSma = indicators.volumeSma[entryIndex];
        if (volumeSma === null || volumeSma === undefined) return false;
        return data[entryIndex].volume >= volumeSma * config.volumeMultiplier;
    }

    if (config.tradeFilterMode === 'rsi') {
        const rsi = indicators.rsi[entryIndex];
        if (rsi === null || rsi === undefined) return false;
        return tradeDirection === 'short' ? rsi <= config.rsiBearish : rsi >= config.rsiBullish;
    }

    if (config.tradeFilterMode === 'trend') {
        const ema = indicators.emaTrend[entryIndex];
        if (ema === null || ema === undefined) return false;

        const slopeLookback = Math.max(1, config.confirmLookback);
        const slopeIndex = entryIndex - slopeLookback;
        if (slopeIndex < 0) return false;
        const prevEma = indicators.emaTrend[slopeIndex];
        if (prevEma === null || prevEma === undefined) return false;

        if (tradeDirection === 'short') {
            return data[entryIndex].close < ema && ema < prevEma;
        }
        return data[entryIndex].close > ema && ema > prevEma;
    }

    if (config.tradeFilterMode === 'adx') {
        const adx = indicators.adx[entryIndex];
        if (adx === null || adx === undefined) return false;
        const minAdx = config.adxMin > 0 ? config.adxMin : TRADE_FILTER_DEFAULT_ADX_MIN;
        return adx >= minAdx;
    }

    return true;
}

function passesRegimeFilters(
    data: OHLCVData[],
    entryIndex: number,
    config: NormalizedSettings,
    indicators: IndicatorSeries,
    tradeDirection: 'long' | 'short'
): boolean {
    const isShort = tradeDirection === 'short';
    if (config.marketMode !== 'all') {
        const ema = indicators.emaTrend[entryIndex];
        if (ema === null || ema === undefined || ema === 0) return false;

        const slopeIndex = entryIndex - MARKET_MODE_SLOPE_LOOKBACK;
        if (slopeIndex < 0) return false;
        const prevEma = indicators.emaTrend[slopeIndex];
        if (prevEma === null || prevEma === undefined || prevEma === 0) return false;

        const close = data[entryIndex].close;
        const slope = (ema - prevEma) / prevEma;
        const distance = Math.abs((close - ema) / ema);
        const isUptrend = close > ema && slope >= MARKET_MODE_SLOPE_THRESHOLD;
        const isDowntrend = close < ema && slope <= -MARKET_MODE_SLOPE_THRESHOLD;
        const isSideway = Math.abs(slope) <= MARKET_MODE_SLOPE_THRESHOLD && distance <= MARKET_MODE_SIDEWAY_DISTANCE;

        if (config.marketMode === 'uptrend') {
            if (isShort || !isUptrend) return false;
        } else if (config.marketMode === 'downtrend') {
            if (!isShort || !isDowntrend) return false;
        } else if (!isSideway) {
            return false;
        }
    }

    if (config.trendEmaPeriod > 0) {
        const ema = indicators.emaTrend[entryIndex];
        if (ema === null || ema === undefined) return false;
        if (isShort) {
            if (data[entryIndex].close >= ema) return false;
        } else if (data[entryIndex].close <= ema) {
            return false;
        }

        if (config.trendEmaSlopeBars > 0) {
            const slopeIndex = entryIndex - config.trendEmaSlopeBars;
            if (slopeIndex < 0) return false;
            const previousEma = indicators.emaTrend[slopeIndex];
            if (previousEma === null || previousEma === undefined) return false;
            if (isShort ? ema >= previousEma : ema <= previousEma) return false;
        }
    }

    if (config.atrPercentMin > 0 || config.atrPercentMax > 0) {
        const atr = indicators.atr[entryIndex];
        if (atr === null || atr === undefined) return false;
        const atrPercent = (atr / data[entryIndex].close) * 100;

        if (config.atrPercentMin > 0 && atrPercent < config.atrPercentMin) return false;
        if (config.atrPercentMax > 0 && atrPercent > config.atrPercentMax) return false;
    }

    if (config.adxMin > 0 || config.adxMax > 0) {
        const adx = indicators.adx[entryIndex];
        if (adx === null || adx === undefined) return false;

        if (config.adxMin > 0 && adx < config.adxMin) return false;
        if (config.adxMax > 0 && adx > config.adxMax) return false;
    }

    return true;
}

function prepareSignals(
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

export function calculateMaxDrawdown(equityCurve: { time: Time; value: number }[], initialCapital: number) {
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;

    for (const point of equityCurve) {
        if (point.value > peak) peak = point.value;
        const drawdown = peak - point.value;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
        }
    }

    return { maxDrawdown, maxDrawdownPercent };
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
    const result = runBacktestCompact(
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

    return {
        direction: lastTrade.type,
        entryTime: lastTrade.entryTime,
        entryPrice: lastTrade.entryPrice,
        currentPrice,
        unrealizedPnlPercent,
        barsInTrade,
        stopLossPrice: null, // Would need more complex tracking to get these
        takeProfitPrice: null,
    };
}

/**
 * Pre-computes all indicators needed for backtesting based on settings.
 * Call this ONCE before running multiple backtests with the same settings.
 * This dramatic optimization prevents recalculating indicators for each
 * parameter combination in the finder.
 * 
 * @param data OHLCV data array
 * @param settings Backtest settings that determine which indicators are needed
 * @returns Pre-computed indicators that can be passed to runBacktestCompact
 */
export function precomputeIndicators(
    data: OHLCVData[],
    settings: BacktestSettings = {}
): PrecomputedIndicators {
    const config = normalizeBacktestSettings(settings);

    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.atrPercentMin > 0 ||
        config.atrPercentMax > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

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

    return {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi,
        dataLength: data.length
    };
}

export function runBacktestCompact(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>
): BacktestResult {
    const config = normalizeBacktestSettings(settings);
    const tradeDirection = normalizeTradeDirection(settings);
    const sizingMode = sizing?.mode ?? 'percent';
    const fixedTradeAmount = Math.max(0, sizing?.fixedTradeAmount ?? 0);

    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.atrPercentMin > 0 ||
        config.atrPercentMax > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

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

    const indicatorSeries: IndicatorSeries = {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi
    };

    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection);

    let capital = initialCapital;
    let position: PositionState | null = null;

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    let signalIdx = 0;

    let totalTrades = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    let avgReturn = 0;
    let returnM2 = 0;

    let peakEquity = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;

    const updateDrawdown = (equity: number) => {
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

    const recordTrade = (totalPnl: number, pnlPercent: number) => {
        totalTrades += 1;
        if (totalPnl > 0) {
            winningTrades += 1;
            totalProfit += totalPnl;
        } else {
            losingTrades += 1;
            totalLoss += Math.abs(totalPnl);
        }

        const delta = pnlPercent - avgReturn;
        avgReturn += delta / totalTrades;
        returnM2 += delta * (pnlPercent - avgReturn);
    };

    const exitPosition = (exitPrice: number, exitSize: number) => {
        if (!position || exitSize <= 0) return;

        const positionDirection = position.direction;
        const directionFactor = directionFactorFor(positionDirection);
        const size = Math.min(exitSize, position.size);
        const exitValue = size * exitPrice;
        const entryValue = size * position.entryPrice;
        const commission = exitValue * commissionRate;
        const entryCommission = position.entryCommissionPerShare * size;

        const rawPnl = (exitValue - entryValue) * directionFactor;
        const totalPnl = rawPnl - entryCommission - commission;
        const pnlPercent = entryValue > 0 ? (rawPnl / entryValue) * 100 : 0;

        capital += rawPnl - commission;

        recordTrade(totalPnl, pnlPercent);

        position.size -= size;
        if (position.size <= 0) {
            position = null;
        }
    };

    const buildPositionFromSignal = (signal: Signal, barIndex: number): { nextPosition: PositionState; entryCommission: number } | null => {
        if (!allowsSignalAsEntry(signal.type, tradeDirection)) return null;

        const atrValue = needsAtr ? atr[barIndex] : null;
        const requiresAtrForEntry =
            config.stopLossAtr > 0 ||
            config.takeProfitAtr > 0 ||
            config.trailingAtr > 0 ||
            config.partialTakeProfitAtR > 0 ||
            config.breakEvenAtR > 0;

        if (requiresAtrForEntry && (atrValue === null || atrValue === undefined)) return null;

        const allocatedCapital = (sizingMode === 'fixed' && fixedTradeAmount > 0)
            ? fixedTradeAmount
            : capital * (positionSizePercent / 100);
        if (!Number.isFinite(allocatedCapital) || allocatedCapital <= 0) return null;

        const tradeValue = allocatedCapital / (1 + commissionRate);
        const entryCommission = tradeValue * commissionRate;
        const direction = signalToPositionDirection(signal.type);
        const directionFactor = directionFactorFor(direction);
        const entrySide = entrySideForDirection(direction);
        const entryFillPrice = applySlippage(signal.price, entrySide, slippageRate);
        if (!Number.isFinite(entryFillPrice) || entryFillPrice <= 0 || !Number.isFinite(tradeValue) || tradeValue <= 0) return null;

        const shares = tradeValue / entryFillPrice;
        if (!Number.isFinite(shares) || shares <= 0) return null;

        const stopLossPrice = (atrValue !== null && atrValue !== undefined)
            ? (config.stopLossAtr > 0
                ? entryFillPrice - directionFactor * config.stopLossAtr * atrValue
                : config.trailingAtr > 0
                    ? entryFillPrice - directionFactor * config.trailingAtr * atrValue
                    : null)
            : null;

        const takeProfitPrice = (atrValue !== null && atrValue !== undefined && config.takeProfitAtr > 0)
            ? entryFillPrice + directionFactor * config.takeProfitAtr * atrValue
            : null;

        let riskPerShare = 0;
        if (config.riskMode === 'percentage') {
            if (config.stopLossEnabled && config.stopLossPercent > 0) {
                riskPerShare = entryFillPrice * (config.stopLossPercent / 100);
            }
        } else if (atrValue !== null && atrValue !== undefined && config.stopLossAtr > 0) {
            riskPerShare = config.stopLossAtr * atrValue;
        }

        const partialTargetPrice = (riskPerShare > 0 && config.partialTakeProfitAtR > 0)
            ? entryFillPrice + directionFactor * riskPerShare * config.partialTakeProfitAtR
            : null;

        let finalStopLossPrice = stopLossPrice;
        let finalTakeProfitPrice = takeProfitPrice;

        if (config.riskMode === 'percentage') {
            if (config.stopLossEnabled && config.stopLossPercent > 0) {
                finalStopLossPrice = entryFillPrice * (1 - directionFactor * (config.stopLossPercent / 100));
            }
            if (config.takeProfitEnabled && config.takeProfitPercent > 0) {
                finalTakeProfitPrice = entryFillPrice * (1 + directionFactor * (config.takeProfitPercent / 100));
            }
        }

        return {
            nextPosition: {
                direction,
                entryTime: signal.time,
                entryPrice: entryFillPrice,
                size: shares,
                entryCommissionPerShare: shares > 0 ? entryCommission / shares : 0,
                stopLossPrice: finalStopLossPrice,
                takeProfitPrice: finalTakeProfitPrice,
                riskPerShare,
                barsInTrade: 0,
                extremePrice: entryFillPrice,
                partialTargetPrice,
                partialTaken: false,
                breakEvenApplied: false
            },
            entryCommission
        };
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        if (position) {
            position.barsInTrade += 1;
            const positionDirection = position.direction;
            const directionFactor = directionFactorFor(positionDirection);
            const isShortPosition = positionDirection === 'short';
            const exitSide = exitSideForDirection(positionDirection);

            // Check stop loss
            const stopLoss = position.stopLossPrice;
            if (stopLoss !== null) {
                const stopHit = isShortPosition ? candle.high >= stopLoss : candle.low <= stopLoss;
                if (stopHit) {
                    const exitPrice = applySlippage(stopLoss, exitSide, slippageRate);
                    exitPosition(exitPrice, position.size);
                }
            }

            // Check take profit (independent of stop loss)
            if (position && position.takeProfitPrice !== null) {
                const takeHit = isShortPosition ? candle.low <= position.takeProfitPrice : candle.high >= position.takeProfitPrice;
                if (takeHit) {
                    const exitPrice = applySlippage(position.takeProfitPrice, exitSide, slippageRate);
                    exitPosition(exitPrice, position.size);
                }
            }

            // Check partial take profit
            if (position && !position.partialTaken && position.partialTargetPrice !== null) {
                const partialHit = isShortPosition ? candle.low <= position.partialTargetPrice : candle.high >= position.partialTargetPrice;
                if (partialHit) {
                    const partialSize = position.size * (config.partialTakeProfitPercent / 100);
                    if (partialSize > 0) {
                        const exitPrice = applySlippage(position.partialTargetPrice, exitSide, slippageRate);
                        exitPosition(exitPrice, partialSize);
                        if (position) {
                            position.partialTaken = true;
                        }
                    }
                }
            }

            if (position && config.timeStopBars > 0 && position.barsInTrade >= config.timeStopBars) {
                const isLosing = isShortPosition ? candle.close >= position.entryPrice : candle.close <= position.entryPrice;
                if (!position.partialTaken && isLosing) {
                    const exitPrice = applySlippage(candle.close, exitSide, slippageRate);
                    exitPosition(exitPrice, position.size);
                }
            }

            if (position) {
                const atrValue = atr[i];
                if (atrValue !== null && atrValue !== undefined) {
                    if (config.breakEvenAtR > 0 && position.riskPerShare > 0 && !position.breakEvenApplied) {
                        const breakEvenTarget = position.entryPrice + directionFactor * position.riskPerShare * config.breakEvenAtR;
                        const breakEvenHit = isShortPosition ? candle.low <= breakEvenTarget : candle.high >= breakEvenTarget;
                        if (breakEvenHit) {
                            position.stopLossPrice = position.stopLossPrice === null
                                ? position.entryPrice
                                : isShortPosition
                                    ? Math.min(position.stopLossPrice, position.entryPrice)
                                    : Math.max(position.stopLossPrice, position.entryPrice);
                            position.breakEvenApplied = true;
                        }
                    }

                    if (config.trailingAtr > 0) {
                        const trailStop = position.extremePrice - directionFactor * atrValue * config.trailingAtr;
                        const shouldUpdateStop = position.stopLossPrice === null
                            || (isShortPosition ? trailStop < position.stopLossPrice : trailStop > position.stopLossPrice);
                        if (shouldUpdateStop) {
                            position.stopLossPrice = trailStop;
                        }
                    }
                }

                position.extremePrice = isShortPosition
                    ? Math.min(position.extremePrice, candle.low)
                    : Math.max(position.extremePrice, candle.high);
            }
        }

        while (signalIdx < preparedSignals.length && compareTime(preparedSignals[signalIdx].time, candle.time) <= 0) {
            const signal = preparedSignals[signalIdx];

            if (compareTime(signal.time, candle.time) === 0) {
                if (!position) {
                    const opened = buildPositionFromSignal(signal, i);
                    if (opened) {
                        position = opened.nextPosition;
                        capital -= opened.entryCommission;
                    }
                } else {
                    const oppositeSignalType = directionToSignalType(position.direction === 'long' ? 'short' : 'long');
                    if (signal.type === oppositeSignalType) {
                        const blockedSameBarExit = !config.allowSameBarExit && compareTime(signal.time, position.entryTime) === 0;
                        if (!blockedSameBarExit) {
                            const exitPrice = applySlippage(signal.price, exitSideForDirection(position.direction), slippageRate);
                            exitPosition(exitPrice, position.size);
                            if (tradeDirection === 'both') {
                                const opened = buildPositionFromSignal(signal, i);
                                if (opened) {
                                    position = opened.nextPosition;
                                    capital -= opened.entryCommission;
                                }
                            }
                        }
                    }
                }
            }
            signalIdx++;
        }

        let currentEquity = capital;
        if (position) {
            const directionFactor = directionFactorFor(position.direction);
            const unrealizedPnL = (candle.close - position.entryPrice) * position.size * directionFactor;
            currentEquity += unrealizedPnL;
        }
        updateDrawdown(currentEquity);
    }

    if (position && data.length > 0) {
        const lastCandle = data[data.length - 1];
        const exitPrice = applySlippage(lastCandle.close, exitSideForDirection(position.direction), slippageRate);
        exitPosition(exitPrice, position.size);
        updateDrawdown(capital);
    }

    const netProfit = capital - initialCapital;
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) : 0;
    const lossRate = totalTrades > 0 ? (losingTrades / totalTrades) : 0;
    const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const avgTrade = totalTrades > 0 ? netProfit / totalTrades : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    const stdReturn = totalTrades > 1 ? Math.sqrt(returnM2 / (totalTrades - 1)) : 0;
    const sharpeRatio = calculateSharpeRatioFromMoments(avgReturn, stdReturn, totalTrades);

    return {
        trades: [],
        netProfit,
        netProfitPercent,
        winRate: winRate * 100,
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

export function runBacktest(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>
): BacktestResult {
    // Clean input data to handle potential undefined/null elements
    data = ensureCleanData(data);

    const trades: Trade[] = [];
    const equityCurve: { time: Time; value: number }[] = [];
    const config = normalizeBacktestSettings(settings);
    const tradeDirection = normalizeTradeDirection(settings);
    const sizingMode = sizing?.mode ?? 'percent';
    const fixedTradeAmount = Math.max(0, sizing?.fixedTradeAmount ?? 0);

    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);



    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.atrPercentMin > 0 ||
        config.atrPercentMax > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

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

    const indicatorSeries: IndicatorSeries = {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi
    };

    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection);

    let capital = initialCapital;
    let position: PositionState | null = null;
    let tradeId = 0;

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    let signalIdx = 0;

    const exitPosition = (exitPrice: number, exitTime: Time, exitSize: number, exitReason: Trade['exitReason'] = 'signal') => {
        if (!position || exitSize <= 0) return;

        const positionDirection = position.direction;
        const directionFactor = directionFactorFor(positionDirection);
        const size = Math.min(exitSize, position.size);
        const exitValue = size * exitPrice;
        const entryValue = size * position.entryPrice;
        const commission = exitValue * commissionRate;
        const entryCommission = position.entryCommissionPerShare * size;

        const rawPnl = (exitValue - entryValue) * directionFactor;
        const totalPnl = rawPnl - entryCommission - commission;
        const pnlPercent = entryValue > 0 ? (rawPnl / entryValue) * 100 : 0;

        capital += rawPnl - commission;

        trades.push({
            id: ++tradeId,
            type: positionDirection,
            entryTime: position.entryTime,
            entryPrice: position.entryPrice,
            exitTime,
            exitPrice,
            pnl: totalPnl,
            pnlPercent,
            size,
            fees: entryCommission + commission,
            exitReason
        });

        position.size -= size;
        if (position.size <= 0) {
            position = null;
        }
    };

    const buildPositionFromSignal = (signal: Signal, barIndex: number): { nextPosition: PositionState; entryCommission: number } | null => {
        if (!allowsSignalAsEntry(signal.type, tradeDirection)) return null;

        const atrValue = needsAtr ? atr[barIndex] : null;
        const requiresAtrForEntry =
            config.stopLossAtr > 0 ||
            config.takeProfitAtr > 0 ||
            config.trailingAtr > 0 ||
            config.partialTakeProfitAtR > 0 ||
            config.breakEvenAtR > 0;

        if (requiresAtrForEntry && (atrValue === null || atrValue === undefined)) return null;

        const allocatedCapital = (sizingMode === 'fixed' && fixedTradeAmount > 0)
            ? fixedTradeAmount
            : capital * (positionSizePercent / 100);
        if (!Number.isFinite(allocatedCapital) || allocatedCapital <= 0) return null;

        const tradeValue = allocatedCapital / (1 + commissionRate);
        const entryCommission = tradeValue * commissionRate;
        const direction = signalToPositionDirection(signal.type);
        const directionFactor = directionFactorFor(direction);
        const entrySide = entrySideForDirection(direction);
        const entryFillPrice = applySlippage(signal.price, entrySide, slippageRate);
        if (!Number.isFinite(entryFillPrice) || entryFillPrice <= 0 || !Number.isFinite(tradeValue) || tradeValue <= 0) return null;

        const shares = tradeValue / entryFillPrice;
        if (!Number.isFinite(shares) || shares <= 0) return null;

        const stopLossPrice = (atrValue !== null && atrValue !== undefined)
            ? (config.stopLossAtr > 0
                ? entryFillPrice - directionFactor * config.stopLossAtr * atrValue
                : config.trailingAtr > 0
                    ? entryFillPrice - directionFactor * config.trailingAtr * atrValue
                    : null)
            : null;

        const takeProfitPrice = (atrValue !== null && atrValue !== undefined && config.takeProfitAtr > 0)
            ? entryFillPrice + directionFactor * config.takeProfitAtr * atrValue
            : null;

        let riskPerShare = 0;
        if (config.riskMode === 'percentage') {
            if (config.stopLossEnabled && config.stopLossPercent > 0) {
                riskPerShare = entryFillPrice * (config.stopLossPercent / 100);
            }
        } else if (atrValue !== null && atrValue !== undefined && config.stopLossAtr > 0) {
            riskPerShare = config.stopLossAtr * atrValue;
        }

        const partialTargetPrice = (riskPerShare > 0 && config.partialTakeProfitAtR > 0)
            ? entryFillPrice + directionFactor * riskPerShare * config.partialTakeProfitAtR
            : null;

        let finalStopLossPrice = stopLossPrice;
        let finalTakeProfitPrice = takeProfitPrice;

        if (config.riskMode === 'percentage') {
            if (config.stopLossEnabled && config.stopLossPercent > 0) {
                finalStopLossPrice = entryFillPrice * (1 - directionFactor * (config.stopLossPercent / 100));
            }
            if (config.takeProfitEnabled && config.takeProfitPercent > 0) {
                finalTakeProfitPrice = entryFillPrice * (1 + directionFactor * (config.takeProfitPercent / 100));
            }
        }

        return {
            nextPosition: {
                direction,
                entryTime: signal.time,
                entryPrice: entryFillPrice,
                size: shares,
                entryCommissionPerShare: shares > 0 ? entryCommission / shares : 0,
                stopLossPrice: finalStopLossPrice,
                takeProfitPrice: finalTakeProfitPrice,
                riskPerShare,
                barsInTrade: 0,
                extremePrice: entryFillPrice,
                partialTargetPrice,
                partialTaken: false,
                breakEvenApplied: false
            },
            entryCommission
        };
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        if (position) {
            position.barsInTrade += 1;
            const positionDirection = position.direction;
            const directionFactor = directionFactorFor(positionDirection);
            const isShortPosition = positionDirection === 'short';
            const exitSide = exitSideForDirection(positionDirection);

            // Check stop loss
            const stopLoss = position.stopLossPrice;
            if (stopLoss !== null) {
                const stopHit = isShortPosition ? candle.high >= stopLoss : candle.low <= stopLoss;
                if (stopHit) {
                    const exitPrice = applySlippage(stopLoss, exitSide, slippageRate);
                    exitPosition(exitPrice, candle.time, position.size, 'stop_loss');
                }
            }

            // Check take profit (independent of stop loss)
            if (position && position.takeProfitPrice !== null) {
                const takeHit = isShortPosition ? candle.low <= position.takeProfitPrice : candle.high >= position.takeProfitPrice;
                if (takeHit) {
                    const exitPrice = applySlippage(position.takeProfitPrice, exitSide, slippageRate);
                    exitPosition(exitPrice, candle.time, position.size, 'take_profit');
                }
            }

            // Check partial take profit
            if (position && !position.partialTaken && position.partialTargetPrice !== null) {
                const partialHit = isShortPosition ? candle.low <= position.partialTargetPrice : candle.high >= position.partialTargetPrice;
                if (partialHit) {
                    const partialSize = position.size * (config.partialTakeProfitPercent / 100);
                    if (partialSize > 0) {
                        const exitPrice = applySlippage(position.partialTargetPrice, exitSide, slippageRate);
                        exitPosition(exitPrice, candle.time, partialSize, 'partial');
                        if (position) {
                            position.partialTaken = true;
                        }
                    }
                }
            }

            if (position && config.timeStopBars > 0 && position.barsInTrade >= config.timeStopBars) {
                const isLosing = isShortPosition ? candle.close >= position.entryPrice : candle.close <= position.entryPrice;
                if (!position.partialTaken && isLosing) {
                    const exitPrice = applySlippage(candle.close, exitSide, slippageRate);
                    exitPosition(exitPrice, candle.time, position.size, 'time_stop');
                }
            }

            if (position) {
                const atrValue = atr[i];
                if (atrValue !== null && atrValue !== undefined) {
                    if (config.breakEvenAtR > 0 && position.riskPerShare > 0 && !position.breakEvenApplied) {
                        const breakEvenTarget = position.entryPrice + directionFactor * position.riskPerShare * config.breakEvenAtR;
                        const breakEvenHit = isShortPosition ? candle.low <= breakEvenTarget : candle.high >= breakEvenTarget;
                        if (breakEvenHit) {
                            position.stopLossPrice = position.stopLossPrice === null
                                ? position.entryPrice
                                : isShortPosition
                                    ? Math.min(position.stopLossPrice, position.entryPrice)
                                    : Math.max(position.stopLossPrice, position.entryPrice);
                            position.breakEvenApplied = true;
                        }
                    }

                    if (config.trailingAtr > 0) {
                        const trailStop = position.extremePrice - directionFactor * atrValue * config.trailingAtr;
                        const shouldUpdateStop = position.stopLossPrice === null
                            || (isShortPosition ? trailStop < position.stopLossPrice : trailStop > position.stopLossPrice);
                        if (shouldUpdateStop) {
                            position.stopLossPrice = trailStop;
                        }
                    }
                }

                position.extremePrice = isShortPosition
                    ? Math.min(position.extremePrice, candle.low)
                    : Math.max(position.extremePrice, candle.high);
            }
        }

        while (signalIdx < preparedSignals.length && compareTime(preparedSignals[signalIdx].time, candle.time) <= 0) {
            const signal = preparedSignals[signalIdx];

            if (compareTime(signal.time, candle.time) === 0) {
                if (!position) {
                    const opened = buildPositionFromSignal(signal, i);
                    if (opened) {
                        position = opened.nextPosition;
                        capital -= opened.entryCommission;
                    }
                } else {
                    const oppositeSignalType = directionToSignalType(position.direction === 'long' ? 'short' : 'long');
                    if (signal.type === oppositeSignalType) {
                        const blockedSameBarExit = !config.allowSameBarExit && compareTime(signal.time, position.entryTime) === 0;
                        if (!blockedSameBarExit) {
                            const exitPrice = applySlippage(signal.price, exitSideForDirection(position.direction), slippageRate);
                            exitPosition(exitPrice, signal.time, position.size, 'signal');
                            if (tradeDirection === 'both') {
                                const opened = buildPositionFromSignal(signal, i);
                                if (opened) {
                                    position = opened.nextPosition;
                                    capital -= opened.entryCommission;
                                }
                            }
                        }
                    }
                }
            }
            signalIdx++;
        }

        let currentEquity = capital;
        if (position) {
            const directionFactor = directionFactorFor(position.direction);
            const unrealizedPnL = (candle.close - position.entryPrice) * position.size * directionFactor;
            currentEquity += unrealizedPnL;
        }
        equityCurve.push({ time: candle.time, value: currentEquity });
    }

    if (position && data.length > 0) {
        const lastCandle = data[data.length - 1];
        const exitPrice = applySlippage(lastCandle.close, exitSideForDirection(position.direction), slippageRate);
        exitPosition(exitPrice, lastCandle.time, position.size, 'end_of_data');

        if (equityCurve.length > 0) {
            equityCurve[equityCurve.length - 1].value = capital;
        }
    }

    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);

    return calculateBacktestStats(trades, equityCurve, initialCapital, capital, maxDrawdown, maxDrawdownPercent);
}

export function calculateBacktestStats(
    trades: Trade[],
    equityCurve: { time: Time; value: number }[],
    initialCapital: number,
    finalCapital: number,
    maxDrawdown: number,
    maxDrawdownPercent: number
): BacktestResult {
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl <= 0);

    const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

    const avgWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;

    const netProfit = finalCapital - initialCapital;
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
    const winRate = trades.length > 0 ? (winningTrades.length / trades.length) : 0;
    const lossRate = trades.length > 0 ? (losingTrades.length / trades.length) : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const avgTrade = trades.length > 0 ? netProfit / trades.length : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const returns = trades.map(t => t.pnlPercent);
    const sharpeRatio = calculateSharpeRatioFromReturns(returns);

    return {
        trades,
        netProfit,
        netProfitPercent,
        winRate: winRate * 100,
        expectancy,
        avgTrade,
        profitFactor,
        maxDrawdown,
        maxDrawdownPercent,
        totalTrades: trades.length,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        avgWin,
        avgLoss,
        sharpeRatio,
        equityCurve
    };
}

