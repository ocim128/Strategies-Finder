
import { OHLCVData, Time } from '../types/strategies';

export type TwoHourCloseParity = 'odd' | 'even';

export interface ResampleOptions {
    twoHourCloseParity?: TwoHourCloseParity;
}

/**
 * Gets the number of seconds for a given interval string (e.g., '1m', '1h', '1d').
 */
export function getIntervalSeconds(interval: string): number {
    const unit = interval.slice(-1).toLowerCase();
    const value = parseInt(interval.slice(0, -1)) || 1;
    switch (unit) {
        case 'm': return value * 60;
        case 'h': return value * 3600;
        case 'd': return value * 86400;
        case 'w': return value * 604800;
        default: return 86400; // Default to 1d
    }
}

function normalizeTwoHourCloseParity(options?: ResampleOptions): TwoHourCloseParity {
    return options?.twoHourCloseParity === 'even' ? 'even' : 'odd';
}

export function getResampleBucketStart(
    time: number,
    targetInterval: string,
    options?: ResampleOptions
): number {
    const intervalSeconds = getIntervalSeconds(targetInterval);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        return Math.floor(time);
    }

    // 2H can be bucketed into odd/even close-hour universes by shifting 1 hour.
    const parity = normalizeTwoHourCloseParity(options);
    const phaseOffsetSeconds = intervalSeconds === 7200 && parity === 'even' ? 3600 : 0;
    return Math.floor((time - phaseOffsetSeconds) / intervalSeconds) * intervalSeconds + phaseOffsetSeconds;
}

/**
 * Resamples OHLCV data to a higher timeframe.
 * The output times are aligned to the start of the period.
 */
export function resampleOHLCV(
    data: OHLCVData[],
    targetInterval: string,
    options?: ResampleOptions
): OHLCVData[] {
    if (data.length === 0) return [];

    // Infer source interval from data if possible, otherwise assume smaller than target
    const sourceIntervalSeconds = data.length > 1
        ? (typeof data[1].time === 'number' && typeof data[0].time === 'number'
            ? (data[1].time - data[0].time)
            : 60)
        : 60;

    const targetIntervalSeconds = getIntervalSeconds(targetInterval);

    // If target interval is smaller or equal to source, return original data
    if (targetIntervalSeconds <= sourceIntervalSeconds) return data;

    const resampled: OHLCVData[] = [];
    let currentBar: OHLCVData | null = null;
    let currentPeriodStart = -1;

    for (const bar of data) {
        const time = typeof bar.time === 'number' ? bar.time : 0;
        const periodStart = getResampleBucketStart(time, targetInterval, options);

        if (periodStart !== currentPeriodStart) {
            if (currentBar) {
                resampled.push(currentBar);
            }
            currentBar = {
                time: periodStart as Time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume
            };
            currentPeriodStart = periodStart;
        } else if (currentBar) {
            currentBar.high = Math.max(currentBar.high, bar.high);
            currentBar.low = Math.min(currentBar.low, bar.low);
            currentBar.close = bar.close;
            currentBar.volume += bar.volume;
        }
    }

    if (currentBar) {
        resampled.push(currentBar);
    }

    return resampled;
}

/**
 * Maps a base timeframe timestamp to its corresponding higher timeframe timestamp.
 */
export function mapToBaseTimeframe(time: number, higherInterval: string, options?: ResampleOptions): number {
    return getResampleBucketStart(time, higherInterval, options);
}


