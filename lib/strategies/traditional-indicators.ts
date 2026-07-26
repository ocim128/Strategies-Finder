import type { OHLCVData } from "../types/strategies";

type NullableSeries = (number | null)[];
type RegressionSeries = {
    slope: NullableSeries;
    endpoint: NullableSeries;
};

const cache = new WeakMap<OHLCVData[], Map<string, unknown>>();

function getCached<T>(data: OHLCVData[], key: string, calculate: () => T): T {
    let entries = cache.get(data);
    if (!entries) {
        entries = new Map();
        cache.set(data, entries);
    }
    const cached = entries.get(key);
    if (cached !== undefined) return cached as T;
    const result = calculate();
    entries.set(key, result);
    return result;
}

function rollingMean(values: number[], period: number, startIndex = 0): NullableSeries {
    const result: NullableSeries = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = startIndex; i < values.length; i++) {
        sum += values[i];
        if (i >= startIndex + period) sum -= values[i - period];
        if (i >= startIndex + period - 1) result[i] = sum / period;
    }
    return result;
}

function ema(values: number[], period: number, startIndex = 0): NullableSeries {
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

function calculateRegression(data: OHLCVData[], period: number): RegressionSeries {
    return getCached(data, `regression:${period}`, () => {
        const slope: NullableSeries = new Array(data.length).fill(null);
        const endpoint: NullableSeries = new Array(data.length).fill(null);
        if (data.length < period) return { slope, endpoint };

        const sumX = period * (period - 1) / 2;
        const sumX2 = period * (period - 1) * (2 * period - 1) / 6;
        const denominator = period * sumX2 - sumX * sumX;
        let sumY = 0;
        let sumXY = 0;

        for (let i = 0; i < period; i++) {
            sumY += data[i].close;
            sumXY += i * data[i].close;
        }

        for (let i = period - 1; i < data.length; i++) {
            if (i >= period) {
                const outgoing = data[i - period].close;
                const previousSumY = sumY;
                sumY = previousSumY - outgoing + data[i].close;
                sumXY = sumXY - (previousSumY - outgoing) + (period - 1) * data[i].close;
            }

            const currentSlope = (period * sumXY - sumX * sumY) / denominator;
            const intercept = (sumY - currentSlope * sumX) / period;
            slope[i] = currentSlope;
            endpoint[i] = intercept + currentSlope * (period - 1);
        }

        return { slope, endpoint };
    });
}

export function calculateLinearRegressionSlope(data: OHLCVData[], period: number): NullableSeries {
    return calculateRegression(data, period).slope;
}

export function calculateQstick(data: OHLCVData[], period: number): NullableSeries {
    return getCached(data, `qstick:${period}`, () => {
        const bodies = data.map((bar) => bar.close - bar.open);
        return rollingMean(bodies, period);
    });
}

export function calculateChandeMomentumOscillator(data: OHLCVData[], period: number): NullableSeries {
    return getCached(data, `cmo:${period}`, () => {
        const result: NullableSeries = new Array(data.length).fill(null);
        const gains = new Array<number>(data.length).fill(0);
        const losses = new Array<number>(data.length).fill(0);
        let gainSum = 0;
        let lossSum = 0;

        for (let i = 1; i < data.length; i++) {
            const change = data[i].close - data[i - 1].close;
            gains[i] = Math.max(change, 0);
            losses[i] = Math.max(-change, 0);
            gainSum += gains[i];
            lossSum += losses[i];
            if (i > period) {
                gainSum -= gains[i - period];
                lossSum -= losses[i - period];
            }
            if (i >= period) {
                const total = gainSum + lossSum;
                result[i] = total === 0 ? 0 : 100 * (gainSum - lossSum) / total;
            }
        }

        return result;
    });
}

export function calculateFisherTransform(data: OHLCVData[], period: number): NullableSeries {
    return getCached(data, `fisher:${period}`, () => {
        const result: NullableSeries = new Array(data.length).fill(null);
        const midpoint = data.map((bar) => (bar.high + bar.low) / 2);
        const maxDeque: number[] = [];
        const minDeque: number[] = [];
        let previousValue = 0;
        let previousFisher = 0;

        for (let i = 0; i < data.length; i++) {
            while (maxDeque.length > 0 && midpoint[maxDeque[maxDeque.length - 1]] <= midpoint[i]) maxDeque.pop();
            while (minDeque.length > 0 && midpoint[minDeque[minDeque.length - 1]] >= midpoint[i]) minDeque.pop();
            maxDeque.push(i);
            minDeque.push(i);
            if (maxDeque[0] <= i - period) maxDeque.shift();
            if (minDeque[0] <= i - period) minDeque.shift();
            if (i < period - 1) continue;

            const highest = midpoint[maxDeque[0]];
            const lowest = midpoint[minDeque[0]];
            const normalized = highest === lowest
                ? 0
                : 2 * ((midpoint[i] - lowest) / (highest - lowest) - 0.5);
            const currentValue = Math.max(-0.999, Math.min(0.999, 0.33 * normalized + 0.67 * previousValue));
            const currentFisher = 0.5 * Math.log((1 + currentValue) / (1 - currentValue)) + 0.5 * previousFisher;
            result[i] = currentFisher;
            previousValue = currentValue;
            previousFisher = currentFisher;
        }

        return result;
    });
}

export function calculateDeMarker(data: OHLCVData[], period: number): NullableSeries {
    return getCached(data, `demarker:${period}`, () => {
        const result: NullableSeries = new Array(data.length).fill(null);
        const up = new Array<number>(data.length).fill(0);
        const down = new Array<number>(data.length).fill(0);
        let upSum = 0;
        let downSum = 0;

        for (let i = 1; i < data.length; i++) {
            up[i] = Math.max(data[i].high - data[i - 1].high, 0);
            down[i] = Math.max(data[i - 1].low - data[i].low, 0);
            upSum += up[i];
            downSum += down[i];
            if (i > period) {
                upSum -= up[i - period];
                downSum -= down[i - period];
            }
            if (i >= period) {
                const total = upSum + downSum;
                result[i] = total === 0 ? 0.5 : upSum / total;
            }
        }

        return result;
    });
}

export function calculateRelativeVigor(
    data: OHLCVData[],
    period: number
): { vigor: NullableSeries; signal: NullableSeries } {
    return getCached(data, `rvi:${period}`, () => {
        const vigor: NullableSeries = new Array(data.length).fill(null);
        const signal: NullableSeries = new Array(data.length).fill(null);
        const numerator = new Array<number>(data.length).fill(0);
        const denominator = new Array<number>(data.length).fill(0);
        let numeratorSum = 0;
        let denominatorSum = 0;

        for (let i = 3; i < data.length; i++) {
            numerator[i] = (
                (data[i].close - data[i].open)
                + 2 * (data[i - 1].close - data[i - 1].open)
                + 2 * (data[i - 2].close - data[i - 2].open)
                + (data[i - 3].close - data[i - 3].open)
            ) / 6;
            denominator[i] = (
                (data[i].high - data[i].low)
                + 2 * (data[i - 1].high - data[i - 1].low)
                + 2 * (data[i - 2].high - data[i - 2].low)
                + (data[i - 3].high - data[i - 3].low)
            ) / 6;
            numeratorSum += numerator[i];
            denominatorSum += denominator[i];
            if (i >= period + 3) {
                numeratorSum -= numerator[i - period];
                denominatorSum -= denominator[i - period];
            }
            if (i >= period + 2) {
                vigor[i] = denominatorSum === 0 ? 0 : numeratorSum / denominatorSum;
            }
            if (
                i >= period + 5
                && vigor[i] !== null
                && vigor[i - 1] !== null
                && vigor[i - 2] !== null
                && vigor[i - 3] !== null
            ) {
                signal[i] = (
                    vigor[i]!
                    + 2 * vigor[i - 1]!
                    + 2 * vigor[i - 2]!
                    + vigor[i - 3]!
                ) / 6;
            }
        }

        return { vigor, signal };
    });
}

export function calculateEaseOfMovement(data: OHLCVData[], period: number): NullableSeries {
    return getCached(data, `eom:${period}`, () => {
        const raw = new Array<number>(data.length).fill(0);
        for (let i = 1; i < data.length; i++) {
            const midpointMove = (data[i].high + data[i].low - data[i - 1].high - data[i - 1].low) / 2;
            const range = data[i].high - data[i].low;
            raw[i] = data[i].volume === 0 ? 0 : midpointMove * range / data[i].volume;
        }
        return rollingMean(raw, period, 1);
    });
}

export function calculateForceIndex(data: OHLCVData[], period: number): NullableSeries {
    return getCached(data, `force-index:${period}`, () => {
        const raw = new Array<number>(data.length).fill(0);
        for (let i = 1; i < data.length; i++) {
            raw[i] = (data[i].close - data[i - 1].close) * data[i].volume;
        }
        return ema(raw, period, 1);
    });
}

export function calculateAccumulationDistributionSlope(data: OHLCVData[], lookback: number): NullableSeries {
    return getCached(data, `ad-slope:${lookback}`, () => {
        const result: NullableSeries = new Array(data.length).fill(null);
        const line = new Array<number>(data.length).fill(0);
        for (let i = 0; i < data.length; i++) {
            const range = data[i].high - data[i].low;
            const multiplier = range === 0
                ? 0
                : ((data[i].close - data[i].low) - (data[i].high - data[i].close)) / range;
            line[i] = (i === 0 ? 0 : line[i - 1]) + multiplier * data[i].volume;
            if (i >= lookback) result[i] = line[i] - line[i - lookback];
        }
        return result;
    });
}

export function calculateChandeForecastOscillator(data: OHLCVData[], period: number): NullableSeries {
    return getCached(data, `cfo:${period}`, () => {
        const result: NullableSeries = new Array(data.length).fill(null);
        const endpoint = calculateRegression(data, period).endpoint;
        for (let i = period - 1; i < data.length; i++) {
            if (endpoint[i] === null || data[i].close === 0) continue;
            result[i] = 100 * (data[i].close - endpoint[i]!) / Math.abs(data[i].close);
        }
        return result;
    });
}

export function calculateKlingerOscillator(
    data: OHLCVData[],
    signalPeriod: number
): { oscillator: NullableSeries; signal: NullableSeries } {
    return getCached(data, `klinger:${signalPeriod}`, () => {
        const volumeForce = new Array<number>(data.length).fill(0);
        let previousTrend = 0;
        let previousMovement = data.length === 0 ? 0 : data[0].high - data[0].low;
        let cumulativeMovement = previousMovement;

        for (let i = 1; i < data.length; i++) {
            const currentSum = data[i].high + data[i].low + data[i].close;
            const previousSum = data[i - 1].high + data[i - 1].low + data[i - 1].close;
            const trend = currentSum > previousSum ? 1 : currentSum < previousSum ? -1 : previousTrend;
            const movement = data[i].high - data[i].low;
            cumulativeMovement = trend === previousTrend
                ? cumulativeMovement + movement
                : previousMovement + movement;
            volumeForce[i] = cumulativeMovement === 0
                ? 0
                : data[i].volume * trend * Math.abs(2 * (movement / cumulativeMovement - 1)) * 100;
            previousTrend = trend;
            previousMovement = movement;
        }

        const fast = ema(volumeForce, 34, 1);
        const slow = ema(volumeForce, 55, 1);
        const oscillator: NullableSeries = new Array(data.length).fill(null);
        const denseOscillator = new Array<number>(data.length).fill(0);
        const oscillatorStart = 55;
        for (let i = oscillatorStart; i < data.length; i++) {
            if (fast[i] === null || slow[i] === null) continue;
            denseOscillator[i] = fast[i]! - slow[i]!;
            oscillator[i] = denseOscillator[i];
        }
        const signal = ema(denseOscillator, signalPeriod, oscillatorStart);
        return { oscillator, signal };
    });
}

export function calculateCoppockCurve(data: OHLCVData[], smoothingPeriod: number): NullableSeries {
    return getCached(data, `coppock:${smoothingPeriod}`, () => {
        const rocSum = new Array<number>(data.length).fill(0);
        const startIndex = 14;
        for (let i = startIndex; i < data.length; i++) {
            const close11 = data[i - 11].close;
            const close14 = data[i - 14].close;
            const roc11 = close11 === 0 ? 0 : 100 * (data[i].close - close11) / Math.abs(close11);
            const roc14 = close14 === 0 ? 0 : 100 * (data[i].close - close14) / Math.abs(close14);
            rocSum[i] = roc11 + roc14;
        }

        const result: NullableSeries = new Array(data.length).fill(null);
        const weightTotal = smoothingPeriod * (smoothingPeriod + 1) / 2;
        const firstIndex = startIndex + smoothingPeriod - 1;
        if (firstIndex >= data.length) return result;

        let sum = 0;
        let weightedSum = 0;
        for (let offset = 0; offset < smoothingPeriod; offset++) {
            const value = rocSum[startIndex + offset];
            sum += value;
            weightedSum += value * (offset + 1);
        }
        result[firstIndex] = weightedSum / weightTotal;

        for (let i = firstIndex + 1; i < data.length; i++) {
            const outgoing = rocSum[i - smoothingPeriod];
            weightedSum = weightedSum - sum + smoothingPeriod * rocSum[i];
            sum += rocSum[i] - outgoing;
            result[i] = weightedSum / weightTotal;
        }
        return result;
    });
}
