import type { AdvancedPerformanceAnalytics, Time } from "../types/strategies";
import { timeToNumber } from "./backtest/backtest-utils";
import { mean, median, percentile, sampleStdDev } from "../statistics-utils";

const SHARPE_MIN_SAMPLES = 5;
const SHARPE_MIN_STD_DEV = 1e-4;
const SHARPE_MAX_ABS = 8;
const MILLIS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const PERFORMANCE_CONFIDENCE_LEVEL = 95;
const PERFORMANCE_RISK_FREE_RATE_ANNUAL = 0;
const EPSILON = 1e-9;

type TimedPoint = { time: Time };
type CollapsedEquitySeries = { times: Time[]; values: number[] };
type PreparedEquitySeries = {
    collapsed: CollapsedEquitySeries;
    returns: number[];
    drawdownFractions: number[];
    periodsPerYear: number;
    durationYears: number;
    startValue: number;
    endValue: number;
};
type EquitySharpeSamplePlan = {
    indices: Int32Array;
    periodsPerYear: number;
    collapsedIntraday: boolean;
};

const equitySharpeSamplePlanCache = new WeakMap<object, Map<number, EquitySharpeSamplePlan>>();

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function toEpochMilliseconds(time: Time): number | null {
    const numeric = timeToNumber(time);
    if (numeric === null) return null;
    if (Math.abs(numeric) < 1e11) {
        return numeric * 1000;
    }
    return numeric;
}

function extractSampleTime(sample: Time | TimedPoint): Time {
    return typeof sample === "object" && sample !== null && "time" in sample
        ? sample.time
        : sample;
}

function toUtcDayId(time: Time): number | null {
    if (time && typeof time === "object" && "year" in time) {
        const businessDay = time as { year: number; month: number; day: number };
        return businessDay.year * 10000 + businessDay.month * 100 + businessDay.day;
    }

    const epochMs = toEpochMilliseconds(time);
    if (epochMs === null) return null;
    return Math.floor(epochMs / MILLIS_PER_DAY);
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
): CollapsedEquitySeries {
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
    let currentDayId: number | null = null;

    for (let index = 0; index < sampleCount; index += 1) {
        const sampleTime = extractSampleTime(samples[index]);
        const dayId = toUtcDayId(sampleTime);
        const equityValue = Number(equityValues[index]);
        if (dayId === null || !Number.isFinite(equityValue)) continue;

        if (dayId !== currentDayId) {
            collapsedTimes.push(sampleTime);
            collapsedValues.push(equityValue);
            currentDayId = dayId;
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
    const plan = getEquitySharpeSamplePlan(samples, sampleCount);
    if (!plan || plan.indices.length < 2) return 0;

    let returnCount = 0;
    let returnSum = 0;
    for (let offset = 1; offset < plan.indices.length; offset += 1) {
        const previous = Number(equityValues[plan.indices[offset - 1]]);
        const current = Number(equityValues[plan.indices[offset]]);
        if (plan.collapsedIntraday && (!Number.isFinite(previous) || !Number.isFinite(current))) {
            return calculateSharpeRatioFromEquitySamplesLegacy(
                samples,
                equityValues,
                sampleCount,
                riskFreeRateAnnual
            );
        }
        if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) continue;
        returnSum += (current - previous) / previous;
        returnCount += 1;
    }
    if (returnCount < SHARPE_MIN_SAMPLES) return 0;

    const averageReturn = returnSum / returnCount;
    let squaredDeviationSum = 0;
    for (let offset = 1; offset < plan.indices.length; offset += 1) {
        const previous = Number(equityValues[plan.indices[offset - 1]]);
        const current = Number(equityValues[plan.indices[offset]]);
        if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) continue;
        const value = (current - previous) / previous;
        const deviation = value - averageReturn;
        squaredDeviationSum += deviation * deviation;
    }
    const standardDeviation = Math.sqrt(Math.max(0, squaredDeviationSum / (returnCount - 1)));
    const riskFreeRatePerPeriod = plan.periodsPerYear > 0
        ? riskFreeRateAnnual / plan.periodsPerYear
        : 0;
    return calculateSharpeRatioFromMoments(
        averageReturn,
        standardDeviation,
        returnCount,
        plan.periodsPerYear,
        riskFreeRatePerPeriod
    );
}

function getEquitySharpeSamplePlan(
    samples: ArrayLike<Time | TimedPoint>,
    sampleCount: number
): EquitySharpeSamplePlan | null {
    if (sampleCount < 2 || typeof samples !== "object" || samples === null) return null;

    let byCount = equitySharpeSamplePlanCache.get(samples);
    if (!byCount) {
        byCount = new Map();
        equitySharpeSamplePlanCache.set(samples, byCount);
    }
    const cached = byCount.get(sampleCount);
    if (cached) return cached;

    const sourcePeriodsPerYear = estimatePeriodsPerYear(samples, sampleCount);
    const typicalDeltaMs = sourcePeriodsPerYear > 0
        ? MILLIS_PER_YEAR / sourcePeriodsPerYear
        : Infinity;
    const collapsedIntraday = Number.isFinite(typicalDeltaMs) && typicalDeltaMs < MILLIS_PER_DAY;
    const selectedIndices: number[] = [];

    if (!collapsedIntraday) {
        for (let index = 0; index < sampleCount; index += 1) selectedIndices.push(index);
    } else {
        let currentDayId: number | null = null;
        for (let index = 0; index < sampleCount; index += 1) {
            const dayId = toUtcDayId(extractSampleTime(samples[index]));
            if (dayId === null) continue;
            if (dayId !== currentDayId) {
                selectedIndices.push(index);
                currentDayId = dayId;
            } else {
                selectedIndices[selectedIndices.length - 1] = index;
            }
        }
    }

    const selectedTimes = selectedIndices.map((index) => extractSampleTime(samples[index]));
    const plan: EquitySharpeSamplePlan = {
        indices: Int32Array.from(selectedIndices),
        periodsPerYear: estimatePeriodsPerYear(selectedTimes, selectedTimes.length),
        collapsedIntraday,
    };
    byCount.set(sampleCount, plan);
    return plan;
}

function calculateSharpeRatioFromEquitySamplesLegacy(
    samples: ArrayLike<Time | TimedPoint>,
    equityValues: ArrayLike<number>,
    sampleCount: number,
    riskFreeRateAnnual: number
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

function prepareEquitySeries(
    equityCurve: Array<{ time: Time; value: number }>
): PreparedEquitySeries | null {
    if (equityCurve.length < 2) return null;

    const collapsed = collapseIntradayEquitySamples(
        equityCurve,
        equityCurve.map((point) => point.value),
        equityCurve.length
    );
    if (collapsed.times.length < 2 || collapsed.values.length < 2) return null;

    const returns: number[] = [];
    const drawdownFractions: number[] = [];
    let peak = collapsed.values[0];

    for (let index = 0; index < collapsed.values.length; index += 1) {
        const value = collapsed.values[index];
        if (!Number.isFinite(value) || value <= 0) continue;

        if (value > peak) {
            peak = value;
        }

        drawdownFractions.push(peak > 0 ? Math.max(0, (peak - value) / peak) : 0);

        if (index === 0) continue;

        const previous = collapsed.values[index - 1];
        if (!Number.isFinite(previous) || previous <= 0) continue;
        returns.push((value - previous) / previous);
    }

    const startTime = toEpochMilliseconds(collapsed.times[0]);
    const endTime = toEpochMilliseconds(collapsed.times[collapsed.times.length - 1]);
    const durationYears = startTime !== null && endTime !== null && endTime > startTime
        ? (endTime - startTime) / MILLIS_PER_YEAR
        : 0;

    return {
        collapsed,
        returns,
        drawdownFractions,
        periodsPerYear: estimatePeriodsPerYear(collapsed.times, collapsed.times.length),
        durationYears,
        startValue: collapsed.values[0],
        endValue: collapsed.values[collapsed.values.length - 1],
    };
}

function calculateDownsideDeviation(
    returns: readonly number[],
    targetReturn = 0
): number {
    if (returns.length === 0) return 0;

    const downsideSquares = returns.map((value) => {
        const downside = Math.min(0, value - targetReturn);
        return downside * downside;
    });

    return Math.sqrt(mean(downsideSquares));
}

function calculateExcessReturnRatio(
    numerator: number,
    denominator: number
): number {
    if (!Number.isFinite(numerator)) return 0;
    if (Math.abs(denominator) <= EPSILON) {
        if (Math.abs(numerator) <= EPSILON) return 0;
        return numerator > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    }
    return numerator / denominator;
}

function calculateCagr(
    startValue: number,
    endValue: number,
    durationYears: number
): number {
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue) || startValue <= 0 || endValue <= 0) {
        return 0;
    }
    if (!Number.isFinite(durationYears) || durationYears <= 0) {
        return 0;
    }
    return Math.pow(endValue / startValue, 1 / durationYears) - 1;
}

function calculateTailRatio(
    returns: readonly number[],
    confidenceLevelPct: number
): number {
    if (returns.length === 0) return 0;

    const lowerPercentile = Math.max(0, 100 - confidenceLevelPct);
    const upper = percentile(returns, confidenceLevelPct);
    const lower = percentile(returns, lowerPercentile);
    const denominator = Math.abs(lower);

    if (denominator <= EPSILON) {
        if (upper <= EPSILON) return 0;
        return Number.POSITIVE_INFINITY;
    }

    return upper / denominator;
}

function calculateDistributionShape(
    returns: readonly number[]
): { skewness: number; kurtosis: number } {
    if (returns.length === 0) {
        return { skewness: 0, kurtosis: 0 };
    }

    const stdDev = sampleStdDev(returns);
    if (stdDev <= EPSILON) {
        return { skewness: 0, kurtosis: 0 };
    }

    const average = mean(returns);
    let thirdMoment = 0;
    let fourthMoment = 0;

    for (const value of returns) {
        const z = (value - average) / stdDev;
        thirdMoment += z ** 3;
        fourthMoment += z ** 4;
    }

    return {
        skewness: thirdMoment / returns.length,
        kurtosis: (fourthMoment / returns.length) - 3,
    };
}

function calculateUlcerIndex(drawdownFractions: readonly number[]): number {
    if (drawdownFractions.length === 0) return 0;
    return Math.sqrt(mean(drawdownFractions.map((value) => value * value)));
}

export function calculateAdvancedPerformanceAnalyticsFromEquityCurve(
    equityCurve: Array<{ time: Time; value: number }>,
    riskFreeRateAnnual = PERFORMANCE_RISK_FREE_RATE_ANNUAL,
    confidenceLevelPct = PERFORMANCE_CONFIDENCE_LEVEL
): AdvancedPerformanceAnalytics | undefined {
    const prepared = prepareEquitySeries(equityCurve);
    if (!prepared || prepared.returns.length === 0) {
        return undefined;
    }

    const { returns, drawdownFractions, periodsPerYear, durationYears, startValue, endValue } = prepared;
    const riskFreeRatePerPeriod = periodsPerYear > 0 ? riskFreeRateAnnual / periodsPerYear : 0;
    const averageReturn = mean(returns);
    const downsideDeviation = calculateDownsideDeviation(returns, riskFreeRatePerPeriod);
    const sortinoRatio = calculateExcessReturnRatio(
        (averageReturn - riskFreeRatePerPeriod) * Math.sqrt(Math.max(1, periodsPerYear)),
        downsideDeviation
    );

    const cagrFraction = calculateCagr(startValue, endValue, durationYears);
    const maxDrawdownFraction = drawdownFractions.reduce((maxValue, value) => Math.max(maxValue, value), 0);
    const calmarRatio = calculateExcessReturnRatio(cagrFraction, maxDrawdownFraction);
    // Sterling's classic 10% adjustment becomes pathological below that threshold, so floor it.
    const sterlingRatio = calculateExcessReturnRatio(cagrFraction, Math.max(EPSILON, maxDrawdownFraction - 0.10));
    const tailRatio = calculateTailRatio(returns, confidenceLevelPct);
    const { skewness, kurtosis } = calculateDistributionShape(returns);

    const lowerPercentile = Math.max(0, 100 - confidenceLevelPct);
    const varThreshold = percentile(returns, lowerPercentile);
    const tailReturns = returns.filter((value) => value <= varThreshold);
    const varFraction = Math.max(0, -varThreshold);
    const cvarFraction = tailReturns.length > 0
        ? Math.max(0, -mean(tailReturns))
        : varFraction;

    const ulcerIndexFraction = calculateUlcerIndex(drawdownFractions);
    const serenityIndex = calculateExcessReturnRatio(
        cagrFraction - riskFreeRateAnnual,
        ulcerIndexFraction
    );

    return {
        sortinoRatio,
        calmarRatio,
        sterlingRatio,
        tailRatio,
        skewness,
        kurtosis,
        valueAtRisk95: varFraction * 100,
        conditionalValueAtRisk95: cvarFraction * 100,
        ulcerIndex: ulcerIndexFraction * 100,
        serenityIndex,
        cagr: cagrFraction * 100,
        confidenceLevelPct,
        riskFreeRateAnnual,
        sampleCount: returns.length,
    };
}
