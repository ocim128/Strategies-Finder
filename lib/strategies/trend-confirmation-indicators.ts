type NullableSeries = (number | null)[];

const seriesCache = new WeakMap<number[], Map<string, NullableSeries>>();
const pairedSeriesCache = new WeakMap<number[], WeakMap<number[], Map<string, NullableSeries>>>();

function getCachedSeries(
    values: number[],
    key: string,
    calculate: () => NullableSeries
): NullableSeries {
    let byKey = seriesCache.get(values);
    if (!byKey) {
        byKey = new Map<string, NullableSeries>();
        seriesCache.set(values, byKey);
    }
    const cached = byKey.get(key);
    if (cached) return cached;
    const result = calculate();
    byKey.set(key, result);
    return result;
}

function getCachedPairedSeries(
    first: number[],
    second: number[],
    key: string,
    calculate: () => NullableSeries
): NullableSeries {
    let bySecond = pairedSeriesCache.get(first);
    if (!bySecond) {
        bySecond = new WeakMap<number[], Map<string, NullableSeries>>();
        pairedSeriesCache.set(first, bySecond);
    }
    let byKey = bySecond.get(second);
    if (!byKey) {
        byKey = new Map<string, NullableSeries>();
        bySecond.set(second, byKey);
    }
    const cached = byKey.get(key);
    if (cached) return cached;
    const result = calculate();
    byKey.set(key, result);
    return result;
}

function calculateEma(values: number[], period: number, startIndex = 0): NullableSeries {
    const result: NullableSeries = new Array(values.length).fill(null);
    const seedIndex = startIndex + period - 1;
    if (seedIndex >= values.length) return result;

    let sum = 0;
    for (let i = startIndex; i <= seedIndex; i++) sum += values[i];
    let previous = sum / period;
    result[seedIndex] = previous;

    const multiplier = 2 / (period + 1);
    for (let i = seedIndex + 1; i < values.length; i++) {
        previous += multiplier * (values[i] - previous);
        result[i] = previous;
    }
    return result;
}

function calculateWeightedMovingAverage(
    values: number[],
    period: number,
    startIndex = 0
): NullableSeries {
    const result: NullableSeries = new Array(values.length).fill(null);
    const firstIndex = startIndex + period - 1;
    if (firstIndex >= values.length) return result;

    const weightTotal = period * (period + 1) / 2;
    let sum = 0;
    let weightedSum = 0;
    for (let offset = 0; offset < period; offset++) {
        const value = values[startIndex + offset];
        sum += value;
        weightedSum += value * (offset + 1);
    }
    result[firstIndex] = weightedSum / weightTotal;

    for (let i = firstIndex + 1; i < values.length; i++) {
        const outgoing = values[i - period];
        weightedSum = weightedSum - sum + period * values[i];
        sum += values[i] - outgoing;
        result[i] = weightedSum / weightTotal;
    }
    return result;
}

export function calculateKama(values: number[], period: number): NullableSeries {
    return getCachedSeries(values, `kama:${period}`, () => {
        const result: NullableSeries = new Array(values.length).fill(null);
        if (values.length < period) return result;

        let seed = 0;
        for (let i = 0; i < period; i++) seed += values[i];
        let previous = seed / period;
        result[period - 1] = previous;

        const fast = 2 / 3;
        const slow = 2 / 31;
        let volatility = 0;
        for (let i = 1; i <= period && i < values.length; i++) {
            volatility += Math.abs(values[i] - values[i - 1]);
        }

        for (let i = period; i < values.length; i++) {
            if (i > period) {
                volatility += Math.abs(values[i] - values[i - 1]);
                volatility -= Math.abs(values[i - period] - values[i - period - 1]);
            }
            const direction = Math.abs(values[i] - values[i - period]);
            const efficiencyRatio = volatility === 0 ? 0 : direction / volatility;
            const smoothing = Math.pow(efficiencyRatio * (fast - slow) + slow, 2);
            previous += smoothing * (values[i] - previous);
            result[i] = previous;
        }
        return result;
    });
}

export function calculateLinearRegressionEndpoint(values: number[], period: number): NullableSeries {
    return getCachedSeries(values, `regression-endpoint:${period}`, () => {
        const result: NullableSeries = new Array(values.length).fill(null);
        if (values.length < period) return result;

        const sumX = period * (period - 1) / 2;
        const sumX2 = period * (period - 1) * (2 * period - 1) / 6;
        const denominator = period * sumX2 - sumX * sumX;
        let sumY = 0;
        let sumXY = 0;

        for (let i = 0; i < period; i++) {
            sumY += values[i];
            sumXY += i * values[i];
        }

        for (let i = period - 1; i < values.length; i++) {
            if (i >= period) {
                const outgoing = values[i - period];
                const previousSumY = sumY;
                sumY = previousSumY - outgoing + values[i];
                sumXY = sumXY - (previousSumY - outgoing) + (period - 1) * values[i];
            }
            const slope = (period * sumXY - sumX * sumY) / denominator;
            const intercept = (sumY - slope * sumX) / period;
            result[i] = intercept + slope * (period - 1);
        }
        return result;
    });
}

export function calculateDonchianMidpoint(
    highs: number[],
    lows: number[],
    period: number
): NullableSeries {
    return getCachedPairedSeries(highs, lows, `donchian-midpoint:${period}`, () => {
        const result: NullableSeries = new Array(highs.length).fill(null);
        const maxDeque: number[] = [];
        const minDeque: number[] = [];

        for (let i = 0; i < highs.length; i++) {
            while (maxDeque.length > 0 && highs[maxDeque[maxDeque.length - 1]] <= highs[i]) maxDeque.pop();
            while (minDeque.length > 0 && lows[minDeque[minDeque.length - 1]] >= lows[i]) minDeque.pop();
            maxDeque.push(i);
            minDeque.push(i);
            if (maxDeque[0] <= i - period) maxDeque.shift();
            if (minDeque[0] <= i - period) minDeque.shift();
            if (i >= period - 1) {
                result[i] = (highs[maxDeque[0]] + lows[minDeque[0]]) / 2;
            }
        }
        return result;
    });
}

export function calculateZeroLagEma(values: number[], period: number): NullableSeries {
    return getCachedSeries(values, `zlema:${period}`, () => {
        const lag = Math.floor((period - 1) / 2);
        const adjusted = values.map((value, i) =>
            i < lag ? value : value + (value - values[i - lag])
        );
        return calculateEma(adjusted, period);
    });
}

export function calculateHullMovingAverage(values: number[], period: number): NullableSeries {
    return getCachedSeries(values, `hma:${period}`, () => {
        const halfPeriod = Math.max(1, Math.round(period / 2));
        const rootPeriod = Math.max(1, Math.round(Math.sqrt(period)));
        const halfWma = calculateWeightedMovingAverage(values, halfPeriod);
        const fullWma = calculateWeightedMovingAverage(values, period);
        const firstDifferenceIndex = period - 1;
        const differences = new Array<number>(values.length).fill(0);

        for (let i = firstDifferenceIndex; i < values.length; i++) {
            differences[i] = 2 * halfWma[i]! - fullWma[i]!;
        }
        return calculateWeightedMovingAverage(differences, rootPeriod, firstDifferenceIndex);
    });
}

export function calculateWilderMovingAverage(values: number[], period: number): NullableSeries {
    return getCachedSeries(values, `wilder:${period}`, () => {
        const result: NullableSeries = new Array(values.length).fill(null);
        if (values.length < period) return result;

        let sum = 0;
        for (let i = 0; i < period; i++) sum += values[i];
        let previous = sum / period;
        result[period - 1] = previous;

        for (let i = period; i < values.length; i++) {
            previous = (previous * (period - 1) + values[i]) / period;
            result[i] = previous;
        }
        return result;
    });
}

export function calculateDoubleExponentialMovingAverage(
    values: number[],
    period: number
): NullableSeries {
    return getCachedSeries(values, `dema:${period}`, () => {
        const result: NullableSeries = new Array(values.length).fill(null);
        const firstEma = calculateEma(values, period);
        const firstSeedIndex = period - 1;
        if (firstSeedIndex >= values.length) return result;

        const denseFirstEma = firstEma.slice(firstSeedIndex) as number[];
        const secondEma = calculateEma(denseFirstEma, period);
        for (let i = period - 1; i < denseFirstEma.length; i++) {
            const originalIndex = firstSeedIndex + i;
            result[originalIndex] = 2 * denseFirstEma[i] - secondEma[i]!;
        }
        return result;
    });
}

export function calculateMcGinleyDynamic(values: number[], period: number): NullableSeries {
    return getCachedSeries(values, `mcginley:${period}`, () => {
        const result: NullableSeries = new Array(values.length).fill(null);
        if (values.length < period) return result;

        let seed = 0;
        for (let i = 0; i < period; i++) seed += values[i];
        let previous = seed / period;
        result[period - 1] = previous;

        for (let i = period; i < values.length; i++) {
            if (previous === 0) {
                previous = values[i];
            } else {
                const ratio = values[i] / previous;
                previous += (values[i] - previous) / (0.6 * period * Math.pow(ratio, 4));
            }
            result[i] = previous;
        }
        return result;
    });
}

type WeightedValue = {
    index: number;
    value: number;
    weight: number;
};

function compareWeightedValues(left: WeightedValue, right: WeightedValue): number {
    return left.value - right.value || left.index - right.index;
}

function lowerBoundWeightedValue(window: WeightedValue[], target: WeightedValue): number {
    let low = 0;
    let high = window.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (compareWeightedValues(window[mid], target) < 0) low = mid + 1;
        else high = mid;
    }
    return low;
}

export function calculateVolumeWeightedMedian(
    values: number[],
    volumes: number[],
    period: number
): NullableSeries {
    return getCachedPairedSeries(values, volumes, `volume-weighted-median:${period}`, () => {
        const result: NullableSeries = new Array(values.length).fill(null);
        const window: WeightedValue[] = [];
        let totalWeight = 0;

        for (let i = 0; i < values.length; i++) {
            const entry = {
                index: i,
                value: values[i],
                weight: Math.max(0, volumes[i]),
            };
            window.splice(lowerBoundWeightedValue(window, entry), 0, entry);
            totalWeight += entry.weight;

            if (i >= period) {
                const outgoing = {
                    index: i - period,
                    value: values[i - period],
                    weight: Math.max(0, volumes[i - period]),
                };
                window.splice(lowerBoundWeightedValue(window, outgoing), 1);
                totalWeight -= outgoing.weight;
            }
            if (i < period - 1) continue;

            if (totalWeight <= 0) {
                const middle = period >> 1;
                result[i] = (period & 1)
                    ? window[middle].value
                    : (window[middle - 1].value + window[middle].value) / 2;
                continue;
            }

            const targetWeight = totalWeight / 2;
            let cumulativeWeight = 0;
            for (const candidate of window) {
                cumulativeWeight += candidate.weight;
                if (cumulativeWeight >= targetWeight) {
                    result[i] = candidate.value;
                    break;
                }
            }
        }
        return result;
    });
}
