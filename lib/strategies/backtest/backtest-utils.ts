
import { BacktestSettings, OHLCVData, Signal, Time, TradeDirection } from '../../types/index';
import { NormalizedSettings } from '../../types/backtest';

export function toNumberOr(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) ? value! : fallback;
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function normalizeBacktestSettings(settings?: BacktestSettings): NormalizedSettings {
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
        slippageBps: Math.max(0, toNumberOr(settings?.slippageBps, 0)),

        snapshotAtrPercentMin: Math.max(0, toNumberOr(settings?.snapshotAtrPercentMin, 0)),
        snapshotAtrPercentMax: Math.max(0, toNumberOr(settings?.snapshotAtrPercentMax, 0)),
        snapshotVolumeRatioMin: Math.max(0, toNumberOr(settings?.snapshotVolumeRatioMin, 0)),
        snapshotVolumeRatioMax: Math.max(0, toNumberOr(settings?.snapshotVolumeRatioMax, 0)),
        snapshotAdxMin: Math.max(0, toNumberOr(settings?.snapshotAdxMin, 0)),
        snapshotAdxMax: Math.max(0, toNumberOr(settings?.snapshotAdxMax, 0)),
        snapshotEmaDistanceMin: toNumberOr(settings?.snapshotEmaDistanceMin, 0),
        snapshotEmaDistanceMax: toNumberOr(settings?.snapshotEmaDistanceMax, 0),
        snapshotRsiMin: Math.max(0, toNumberOr(settings?.snapshotRsiMin, 0)),
        snapshotRsiMax: Math.max(0, toNumberOr(settings?.snapshotRsiMax, 0)),
        snapshotPriceRangePosMin: Math.max(0, toNumberOr(settings?.snapshotPriceRangePosMin, 0)),
        snapshotPriceRangePosMax: Math.max(0, toNumberOr(settings?.snapshotPriceRangePosMax, 0)),
        snapshotBarsFromHighMax: Math.max(0, toNumberOr(settings?.snapshotBarsFromHighMax, 0)),
        snapshotBarsFromLowMax: Math.max(0, toNumberOr(settings?.snapshotBarsFromLowMax, 0)),
        snapshotTrendEfficiencyMin: clamp(toNumberOr(settings?.snapshotTrendEfficiencyMin, 0), 0, 1),
        snapshotTrendEfficiencyMax: clamp(toNumberOr(settings?.snapshotTrendEfficiencyMax, 0), 0, 1),
        snapshotAtrRegimeRatioMin: Math.max(0, toNumberOr(settings?.snapshotAtrRegimeRatioMin, 0)),
        snapshotAtrRegimeRatioMax: Math.max(0, toNumberOr(settings?.snapshotAtrRegimeRatioMax, 0)),
        snapshotBodyPercentMin: clamp(toNumberOr(settings?.snapshotBodyPercentMin, 0), 0, 100),
        snapshotBodyPercentMax: clamp(toNumberOr(settings?.snapshotBodyPercentMax, 0), 0, 100),
        snapshotWickSkewMin: clamp(toNumberOr(settings?.snapshotWickSkewMin, 0), -100, 100),
        snapshotWickSkewMax: clamp(toNumberOr(settings?.snapshotWickSkewMax, 0), -100, 100),
        snapshotVolumeTrendMin: Math.max(0, toNumberOr(settings?.snapshotVolumeTrendMin, 0)),
        snapshotVolumeTrendMax: Math.max(0, toNumberOr(settings?.snapshotVolumeTrendMax, 0)),
        snapshotVolumeBurstMin: toNumberOr(settings?.snapshotVolumeBurstMin, 0),
        snapshotVolumeBurstMax: toNumberOr(settings?.snapshotVolumeBurstMax, 0),
        snapshotVolumePriceDivergenceMin: clamp(toNumberOr(settings?.snapshotVolumePriceDivergenceMin, 0), -1, 1),
        snapshotVolumePriceDivergenceMax: clamp(toNumberOr(settings?.snapshotVolumePriceDivergenceMax, 0), -1, 1),
        snapshotVolumeConsistencyMin: Math.max(0, toNumberOr(settings?.snapshotVolumeConsistencyMin, 0)),
        snapshotVolumeConsistencyMax: Math.max(0, toNumberOr(settings?.snapshotVolumeConsistencyMax, 0)),
    };
}

export function timeKey(time: Time): string {
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

export function timeToNumber(time: Time): number | null {
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

export function getExecutionShift(config: NormalizedSettings): number {
    return config.executionModel === 'signal_close' ? 0 : 1;
}

export function resolveExecutionPrice(
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

export function applySlippage(price: number, side: 'buy' | 'sell', slippageRate: number): number {
    if (!Number.isFinite(slippageRate) || slippageRate <= 0) return price;
    return side === 'buy' ? price * (1 + slippageRate) : price * (1 - slippageRate);
}

export function normalizeTradeDirection(settings?: BacktestSettings): TradeDirection {
    return settings?.tradeDirection === 'short' || settings?.tradeDirection === 'both' || settings?.tradeDirection === 'combined'
        ? settings.tradeDirection
        : 'long';
}

export function signalToPositionDirection(type: Signal['type']): 'long' | 'short' {
    return type === 'buy' ? 'long' : 'short';
}

export function directionToSignalType(direction: 'long' | 'short'): Signal['type'] {
    return direction === 'short' ? 'sell' : 'buy';
}

export function entrySideForDirection(direction: 'long' | 'short'): 'buy' | 'sell' {
    return direction === 'short' ? 'sell' : 'buy';
}

export function exitSideForDirection(direction: 'long' | 'short'): 'buy' | 'sell' {
    return direction === 'short' ? 'buy' : 'sell';
}

export function directionFactorFor(direction: 'long' | 'short'): number {
    return direction === 'short' ? -1 : 1;
}

export function allowsSignalAsEntry(signalType: Signal['type'], tradeDirection: TradeDirection): boolean {
    if (tradeDirection === 'both' || tradeDirection === 'combined') return true;
    if (tradeDirection === 'short') return signalType === 'sell';
    return signalType === 'buy';
}

export const timeIndexCache = new WeakMap<OHLCVData[], Map<string, number>>();

export function getTimeIndex(data: OHLCVData[]): Map<string, number> {
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

export function needsSnapshotIndicators(config: NormalizedSettings, captureSnapshots = false): boolean {
    return captureSnapshots ||
        config.snapshotAtrPercentMin > 0 || config.snapshotAtrPercentMax > 0 ||
        config.snapshotVolumeRatioMin > 0 || config.snapshotVolumeRatioMax > 0 ||
        config.snapshotAdxMin > 0 || config.snapshotAdxMax > 0 ||
        config.snapshotEmaDistanceMin !== 0 || config.snapshotEmaDistanceMax !== 0 ||
        config.snapshotRsiMin > 0 || config.snapshotRsiMax > 0 ||
        config.snapshotPriceRangePosMin > 0 || config.snapshotPriceRangePosMax > 0 ||
        config.snapshotBarsFromHighMax > 0 || config.snapshotBarsFromLowMax > 0 ||
        config.snapshotTrendEfficiencyMin > 0 || config.snapshotTrendEfficiencyMax > 0 ||
        config.snapshotAtrRegimeRatioMin > 0 || config.snapshotAtrRegimeRatioMax > 0 ||
        config.snapshotBodyPercentMin > 0 || config.snapshotBodyPercentMax > 0 ||
        config.snapshotWickSkewMin !== 0 || config.snapshotWickSkewMax !== 0 ||
        config.snapshotVolumeTrendMin > 0 || config.snapshotVolumeTrendMax > 0 ||
        config.snapshotVolumeBurstMin !== 0 || config.snapshotVolumeBurstMax !== 0 ||
        config.snapshotVolumePriceDivergenceMin !== 0 || config.snapshotVolumePriceDivergenceMax !== 0 ||
        config.snapshotVolumeConsistencyMin > 0 || config.snapshotVolumeConsistencyMax > 0;
}


