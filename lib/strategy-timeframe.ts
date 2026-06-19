import type { OHLCVData, Signal, Time } from "./types/strategies";
import { getResampleBucketStart, type ResampleOptions } from "./strategies/resample-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";

/**
 * Shared pure helpers for the "strategy timeframe" feature, where a strategy
 * is executed on a resampled higher-timeframe series and its signals are
 * mapped back onto base-bar indices/times.
 *
 * Per-site orchestration (config source, cross-symbol guards, polarity,
 * fallback paths) is intentionally NOT shared — callers keep their own
 * thin orchestration around these primitives.
 */

/** Map OHLCV bars to unix-second times. Returns null if any bar is unparseable. */
export function toNumericTimeData(data: OHLCVData[]): OHLCVData[] | null {
    const mapped: OHLCVData[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const seconds = parseTimeToUnixSeconds(data[i].time);
        if (seconds === null) return null;
        mapped[i] = { ...data[i], time: seconds as Time };
    }
    return mapped;
}

/**
 * Map signals produced on a higher-timeframe series back onto base-bar
 * indices/times. `interval` is a resample interval like "120m".
 *
 * Behavior contract (must stay identical across all callers):
 *  - When `signal.barIndex` resolves to a valid higherData index, use that
 *    bar's time as `bucketStart` directly (do NOT re-bucket). This relies on
 *    `resampleOHLCV` already aligning output bar times to bucket starts.
 *  - Otherwise fall back to bucketing `signal.time` via `getResampleBucketStart`.
 *  - Emit `{ ...signal, time: baseData[idx].time, price: baseData[idx].close, barIndex: idx }`,
 *    preserving the caller's original Time representation.
 */
export function mapSignalsFromHigherTimeframe(
    baseData: OHLCVData[],
    numericBaseData: OHLCVData[],
    higherData: OHLCVData[],
    higherSignals: Signal[],
    interval: string,
    options?: ResampleOptions
): Signal[] {
    if (higherSignals.length === 0) return [];

    const lastBaseIndexByBucket = new Map<number, number>();
    for (let i = 0; i < numericBaseData.length; i++) {
        const time = Number(numericBaseData[i].time);
        if (!Number.isFinite(time)) continue;
        const bucketStart = getResampleBucketStart(time, interval, options);
        lastBaseIndexByBucket.set(bucketStart, i);
    }

    const mapped: Signal[] = [];
    for (const signal of higherSignals) {
        let bucketStart: number | null = null;

        if (Number.isFinite(signal.barIndex)) {
            const index = Math.trunc(signal.barIndex as number);
            if (index >= 0 && index < higherData.length) {
                const timeValue = higherData[index].time;
                const seconds = typeof timeValue === "number" ? timeValue : parseTimeToUnixSeconds(timeValue);
                if (seconds !== null) {
                    bucketStart = seconds;
                }
            }
        }

        if (bucketStart === null) {
            const signalTimeSec = parseTimeToUnixSeconds(signal.time);
            if (signalTimeSec !== null) {
                bucketStart = getResampleBucketStart(signalTimeSec, interval, options);
            }
        }

        if (bucketStart === null) continue;
        const baseIndex = lastBaseIndexByBucket.get(bucketStart);
        if (baseIndex === undefined) continue;

        mapped.push({
            ...signal,
            time: baseData[baseIndex].time,
            price: baseData[baseIndex].close,
            barIndex: baseIndex,
        });
    }

    return mapped;
}
