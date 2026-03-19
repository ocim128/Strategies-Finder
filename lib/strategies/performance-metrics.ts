import type { Time } from "../types/strategies";
import { timeToNumber } from "./backtest/backtest-utils";

const SHARPE_MIN_SAMPLES = 5;
const SHARPE_MIN_STD_DEV = 1e-4;
const SHARPE_MAX_ABS = 8;
const MILLIS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

type TimedPoint = { time: Time };

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function toEpochMilliseconds(time: Time): number | null {
    const numeric = timeToNumber(time);
    if (numeric === null) return null;
    if (typeof time === "number" && Math.abs(time) < 1e11) {
        return numeric * 1000;
    }
    return numeric;
}

function extractSampleTime(sample: Time | TimedPoint): Time {
    return typeof sample === "object" && sample !== null && "time" in sample
        ? sample.time
        : sample;
}

function toUtcDayKey(time: Time): string | null {
    if (time && typeof time === "object" && "year" in time) {
        const businessDay = time as { year: number; month: number; day: number };
        const month = String(businessDay.month).padStart(2, "0");
        const day = String(businessDay.day).padStart(2, "0");
        return `${businessDay.year}-${month}-${day}`;
    }

    const epochMs = toEpochMilliseconds(time);
    if (epochMs === null) return null;
    return new Date(epochMs).toISOString().slice(0, 10);
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle];
    }
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function estimatePeriodsPerYear(
    samples: ArrayLike<Time | TimedPoint>,
    sampleCount = samples.length
): number {
    if (sampleCount < 2) return 1;

    const deltas: number[] = [];
    let previousTimeMs: number | null = null;

    for (let index = 0; index < sampleCount; index += 1) {
        const currentTimeMs = toEpochMilliseconds(extractSampleTime(samples[index]));
        if (currentTimeMs === null) continue;
        if (previousTimeMs !== null) {
            const deltaMs = currentTimeMs - previousTimeMs;
            if (Number.isFinite(deltaMs) && deltaMs > 0) {
                deltas.push(deltaMs);
            }
        }
        previousTimeMs = currentTimeMs;
    }

    if (deltas.length === 0) return 1;
    const typicalDeltaMs = median(deltas);
    if (!Number.isFinite(typicalDeltaMs) || typicalDeltaMs <= 0) return 1;

    return Math.max(1, MILLIS_PER_YEAR / typicalDeltaMs);
}

function collapseIntradayEquitySamples(
    samples: ArrayLike<Time | TimedPoint>,
    equityValues: ArrayLike<number>,
    sampleCount: number
): { times: Time[]; values: number[] } {
    if (sampleCount === 0) return { times: [], values: [] };

    const periodsPerYear = estimatePeriodsPerYear(samples, sampleCount);
    const typicalDeltaMs = periodsPerYear > 0 ? MILLIS_PER_YEAR / periodsPerYear : Infinity;
    if (!Number.isFinite(typicalDeltaMs) || typicalDeltaMs >= MILLIS_PER_DAY) {
        const times: Time[] = [];
        const values: number[] = [];
        for (let index = 0; index < sampleCount; index += 1) {
            times.push(extractSampleTime(samples[index]));
            values.push(Number(equityValues[index]));
        }
        return { times, values };
    }

    const collapsedTimes: Time[] = [];
    const collapsedValues: number[] = [];
    let currentDayKey: string | null = null;

    for (let index = 0; index < sampleCount; index += 1) {
        const sampleTime = extractSampleTime(samples[index]);
        const dayKey = toUtcDayKey(sampleTime);
        const equityValue = Number(equityValues[index]);
        if (dayKey === null || !Number.isFinite(equityValue)) continue;

        if (dayKey !== currentDayKey) {
            collapsedTimes.push(sampleTime);
            collapsedValues.push(equityValue);
            currentDayKey = dayKey;
            continue;
        }

        collapsedTimes[collapsedTimes.length - 1] = sampleTime;
        collapsedValues[collapsedValues.length - 1] = equityValue;
    }

    return { times: collapsedTimes, values: collapsedValues };
}

/**
 * Normalizes Sharpe to avoid unstable values caused by near-zero variance,
 * very small sample sizes, or numeric noise.
 */
export function calculateSharpeRatioFromMoments(
    avgReturn: number,
    stdReturn: number,
    sampleCount: number,
    periodsPerYear = 1,
    riskFreeRatePerPeriod = 0
): number {
    if (!Number.isFinite(avgReturn) || !Number.isFinite(stdReturn)) return 0;
    if (sampleCount < SHARPE_MIN_SAMPLES) return 0;
    if (stdReturn < SHARPE_MIN_STD_DEV) return 0;

    const annualizationFactor = Math.sqrt(Math.max(1, periodsPerYear));
    const raw = ((avgReturn - riskFreeRatePerPeriod) / stdReturn) * annualizationFactor;
    if (!Number.isFinite(raw)) return 0;

    return clamp(raw, -SHARPE_MAX_ABS, SHARPE_MAX_ABS);
}

export function calculateSharpeRatioFromReturns(
    returns: number[],
    periodsPerYear = 1,
    riskFreeRatePerPeriod = 0
): number {
    const finiteReturns = returns.filter(value => Number.isFinite(value));
    if (finiteReturns.length < SHARPE_MIN_SAMPLES) return 0;

    const avgReturn = finiteReturns.reduce((sum, value) => sum + value, 0) / finiteReturns.length;
    const variance = finiteReturns.length > 1
        ? finiteReturns.reduce((sum, value) => sum + Math.pow(value - avgReturn, 2), 0) / (finiteReturns.length - 1)
        : 0;
    const stdReturn = Math.sqrt(Math.max(0, variance));

    return calculateSharpeRatioFromMoments(
        avgReturn,
        stdReturn,
        finiteReturns.length,
        periodsPerYear,
        riskFreeRatePerPeriod
    );
}

export function calculateSharpeRatioFromEquityCurve(
    equityCurve: Array<{ time: Time; value: number }>,
    riskFreeRateAnnual = 0
): number {
    return calculateSharpeRatioFromEquitySamples(equityCurve, equityCurve.map(point => point.value), equityCurve.length, riskFreeRateAnnual);
}

export function calculateSharpeRatioFromEquitySamples(
    samples: ArrayLike<Time | TimedPoint>,
    equityValues: ArrayLike<number>,
    sampleCount = Math.min(samples.length, equityValues.length),
    riskFreeRateAnnual = 0
): number {
    if (sampleCount < 2) return 0;

    const collapsed = collapseIntradayEquitySamples(samples, equityValues, sampleCount);
    if (collapsed.times.length < 2) return 0;

    const periodsPerYear = estimatePeriodsPerYear(collapsed.times, collapsed.times.length);
    const riskFreeRatePerPeriod = periodsPerYear > 0 ? riskFreeRateAnnual / periodsPerYear : 0;
    const returns: number[] = [];

    for (let index = 1; index < collapsed.values.length; index += 1) {
        const previous = collapsed.values[index - 1];
        const current = collapsed.values[index];
        if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) {
            continue;
        }
        returns.push((current - previous) / previous);
    }

    return calculateSharpeRatioFromReturns(returns, periodsPerYear, riskFreeRatePerPeriod);
}

export function sanitizeSharpeRatio(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return clamp(value, -SHARPE_MAX_ABS, SHARPE_MAX_ABS);
}
