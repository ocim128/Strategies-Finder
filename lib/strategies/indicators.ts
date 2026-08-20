// ============================================================================
// Indicator Calculations
// ============================================================================

export function calculateSMA(data: number[], period: number): (number | null)[] {
    return getOrCompute(__smaCache, data, period, () => {
        const result: (number | null)[] = new Array(data.length).fill(null);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i];
            if (i >= period) {
                sum -= data[i - period];
            }
            if (i >= period - 1) {
                result[i] = sum / period;
            }
        }
        return result;
    });
}

// Indicator caches
const __smaCache: WeakMap<number[], Map<number, (number | null)[]>> = new WeakMap();
const __emaCache: WeakMap<number[], Map<number, (number | null)[]>> = new WeakMap();
const __rsiCache: WeakMap<number[], Map<number, (number | null)[]>> = new WeakMap();
const __trixCache: WeakMap<number[], Map<number, (number | null)[]>> = new WeakMap();
const __atrCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>> = new WeakMap();
const __adxCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>> = new WeakMap();
const __cciCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>> = new WeakMap();
const __williamsRCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>> = new WeakMap();
const __stochasticCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>> = new WeakMap();
const __vwapCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>>> = new WeakMap();
const __cmfCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>>> = new WeakMap();
const __mfiCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>>> = new WeakMap();
const __bollingerCache: WeakMap<number[], Map<string, {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
}>> = new WeakMap();
const __keltnerCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<string, {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
}>>>> = new WeakMap();
const __parabolicSarCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<string, {
    sar: (number | null)[];
    direction: (1 | -1 | null)[];
}>>>> = new WeakMap();
const __supertrendCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<string, {
    line: (number | null)[];
    direction: (1 | -1 | null)[];
}>>>> = new WeakMap();
const __aroonCache: WeakMap<number[], WeakMap<number[], Map<number, {
    up: (number | null)[];
    down: (number | null)[];
}>>> = new WeakMap();
const __dmiCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<string, {
    plus: (number | null)[];
    minus: (number | null)[];
}>>>> = new WeakMap();
const __obvCache: WeakMap<number[], WeakMap<number[], number[]>> = new WeakMap();
const __ichimokuCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<string, {
    conversion: (number | null)[];
    base: (number | null)[];
    spanA: (number | null)[];
    spanB: (number | null)[];
    lagging: (number | null)[];
}>>>> = new WeakMap();

function getOrCompute<D extends object, K, V>(cache: WeakMap<D, Map<K, V>>, data: D, key: K, compute: () => V): V {
    let m = cache.get(data);
    if (!m) { m = new Map(); cache.set(data, m); }
    const cached = m.get(key);
    if (cached) return cached;
    const result = compute();
    m.set(key, result);
    return result;
}

function getOrComputeOHLC(
    cache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>>,
    high: number[],
    low: number[],
    close: number[],
    period: number,
    compute: () => (number | null)[]
): (number | null)[] {
    let byLow = cache.get(high);
    if (!byLow) {
        byLow = new WeakMap();
        cache.set(high, byLow);
    }

    let byClose = byLow.get(low);
    if (!byClose) {
        byClose = new WeakMap();
        byLow.set(low, byClose);
    }

    let byPeriod = byClose.get(close);
    if (!byPeriod) {
        byPeriod = new Map();
        byClose.set(close, byPeriod);
    }

    const cached = byPeriod.get(period);
    if (cached) return cached;

    const result = compute();
    byPeriod.set(period, result);
    return result;
}

function getOrComputeOHLCV(
    cache: WeakMap<number[], WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>>>,
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
    period: number,
    compute: () => (number | null)[]
): (number | null)[] {
    let byLow = cache.get(high);
    if (!byLow) {
        byLow = new WeakMap();
        cache.set(high, byLow);
    }

    let byClose = byLow.get(low);
    if (!byClose) {
        byClose = new WeakMap();
        byLow.set(low, byClose);
    }

    let byVolume = byClose.get(close);
    if (!byVolume) {
        byVolume = new WeakMap();
        byClose.set(close, byVolume);
    }

    let byPeriod = byVolume.get(volume);
    if (!byPeriod) {
        byPeriod = new Map();
        byVolume.set(volume, byPeriod);
    }

    const cached = byPeriod.get(period);
    if (cached) return cached;

    const result = compute();
    byPeriod.set(period, result);
    return result;
}

function getOrComputeOHLCByKey<V>(
    cache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<string, V>>>>,
    high: number[],
    low: number[],
    close: number[],
    key: string,
    compute: () => V
): V {
    let byLow = cache.get(high);
    if (!byLow) {
        byLow = new WeakMap();
        cache.set(high, byLow);
    }

    let byClose = byLow.get(low);
    if (!byClose) {
        byClose = new WeakMap();
        byLow.set(low, byClose);
    }

    let byKey = byClose.get(close);
    if (!byKey) {
        byKey = new Map();
        byClose.set(close, byKey);
    }

    const cached = byKey.get(key);
    if (cached) return cached;

    const result = compute();
    byKey.set(key, result);
    return result;
}

function getOrComputeHL<V>(
    cache: WeakMap<number[], WeakMap<number[], Map<number, V>>>,
    high: number[],
    low: number[],
    period: number,
    compute: () => V
): V {
    let byLow = cache.get(high);
    if (!byLow) {
        byLow = new WeakMap();
        cache.set(high, byLow);
    }

    let byPeriod = byLow.get(low);
    if (!byPeriod) {
        byPeriod = new Map();
        byLow.set(low, byPeriod);
    }

    const cached = byPeriod.get(period);
    if (cached) return cached;

    const result = compute();
    byPeriod.set(period, result);
    return result;
}

function calculateRollingHighLow(
    high: number[],
    low: number[],
    period: number
): { upper: (number | null)[]; lower: (number | null)[] } {
    const upper: (number | null)[] = new Array(high.length).fill(null);
    const lower: (number | null)[] = new Array(high.length).fill(null);
    const maxDeque: number[] = [];
    const minDeque: number[] = [];
    let maxHead = 0;
    let minHead = 0;

    for (let i = 0; i < high.length; i++) {
        while (maxDeque.length > maxHead && high[maxDeque[maxDeque.length - 1]] <= high[i]) maxDeque.pop();
        maxDeque.push(i);
        while (maxDeque.length > maxHead && maxDeque[maxHead] <= i - period) maxHead++;

        while (minDeque.length > minHead && low[minDeque[minDeque.length - 1]] >= low[i]) minDeque.pop();
        minDeque.push(i);
        while (minDeque.length > minHead && minDeque[minHead] <= i - period) minHead++;

        if (i >= period - 1) {
            upper[i] = high[maxDeque[maxHead]];
            lower[i] = low[minDeque[minHead]];
        }
    }

    return { upper, lower };
}

export function calculateEMA(data: number[], period: number): (number | null)[] {
    return getOrCompute(__emaCache, data, period, () => {
        const result: (number | null)[] = new Array(data.length).fill(null);
        if (data.length < period) return result;

        const multiplier = 2 / (period + 1);
        let sum = 0;
        for (let i = 0; i < period; i++) sum += data[i];

        let prevEMA = sum / period;
        result[period - 1] = prevEMA;

        for (let i = period; i < data.length; i++) {
            const currentEMA = (data[i] - prevEMA) * multiplier + prevEMA;
            result[i] = currentEMA;
            prevEMA = currentEMA;
        }
        return result;
    });
}

export function calculateATR(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    return getOrComputeOHLC(__atrCache, high, low, close, period, () => {
        const length = close.length;
        const atr: (number | null)[] = new Array(length).fill(null);
        let initialTRSum = 0, prevATR = 0;

        for (let i = 0; i < length; i++) {
            const tr = i === 0
                ? high[i] - low[i]
                : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));

            if (i < period - 1) {
                initialTRSum += tr;
            } else if (i === period - 1) {
                initialTRSum += tr;
                prevATR = initialTRSum / period;
                atr[i] = prevATR;
            } else {
                prevATR = (prevATR * (period - 1) + tr) / period;
                atr[i] = prevATR;
            }
        }
        return atr;
    });
}

export function calculateKeltnerChannels(
    high: number[],
    low: number[],
    close: number[],
    emaPeriod: number,
    atrPeriod: number,
    multiplier: number
): {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
} {
    const key = `${emaPeriod}|${atrPeriod}|${multiplier}`;
    return getOrComputeOHLCByKey(__keltnerCache, high, low, close, key, () => {
        const middle = calculateEMA(close, emaPeriod);
        const atr = calculateATR(high, low, close, atrPeriod);
        const upper: (number | null)[] = new Array(close.length).fill(null);
        const lower: (number | null)[] = new Array(close.length).fill(null);

        for (let i = 0; i < close.length; i++) {
            const mid = middle[i];
            const atrNow = atr[i];
            if (mid === null || atrNow === null) continue;
            upper[i] = mid + multiplier * atrNow;
            lower[i] = mid - multiplier * atrNow;
        }

        return { upper, middle, lower };
    });
}

export function calculateADX(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    return getOrComputeOHLC(__adxCache, high, low, close, period, () => {
        const length = close.length;
        const adx: (number | null)[] = new Array(length).fill(null);
        if (length < period * 2 || period < 1) return adx;

        const tr: number[] = new Array(length).fill(0);
        const plusDM: number[] = new Array(length).fill(0);
        const minusDM: number[] = new Array(length).fill(0);

        for (let i = 1; i < length; i++) {
            const upMove = high[i] - high[i - 1];
            const downMove = low[i - 1] - low[i];
            plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
            minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
            tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
        }

        let trSmooth = 0, plusSmooth = 0, minusSmooth = 0;
        for (let i = 1; i <= period; i++) {
            trSmooth += tr[i];
            plusSmooth += plusDM[i];
            minusSmooth += minusDM[i];
        }

        const dx: number[] = new Array(length).fill(0);
        for (let i = period; i < length; i++) {
            if (i > period) {
                trSmooth = trSmooth - trSmooth / period + tr[i];
                plusSmooth = plusSmooth - plusSmooth / period + plusDM[i];
                minusSmooth = minusSmooth - minusSmooth / period + minusDM[i];
            }
            const plusDI = trSmooth === 0 ? 0 : (100 * (plusSmooth / trSmooth));
            const minusDI = trSmooth === 0 ? 0 : (100 * (minusSmooth / trSmooth));
            const diSum = plusDI + minusDI;
            dx[i] = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI) / diSum);
        }

        let dxSum = 0;
        for (let i = period; i < period * 2; i++) dxSum += dx[i];

        let prevADX = dxSum / period;
        adx[period * 2 - 1] = prevADX;
        for (let i = period * 2; i < length; i++) {
            prevADX = ((prevADX * (period - 1)) + dx[i]) / period;
            adx[i] = prevADX;
        }
        return adx;
    });
}

export function calculateCMF(
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
    period: number
): (number | null)[] {
    return getOrComputeOHLCV(__cmfCache, high, low, close, volume, period, () => {
        const length = Math.min(high.length, low.length, close.length, volume.length);
        const result: (number | null)[] = new Array(length).fill(null);
        if (length < period || period < 1) return result;

        const moneyFlowVolume: number[] = new Array(length).fill(0);
        for (let i = 0; i < length; i++) {
            const range = high[i] - low[i];
            if (range <= 0) {
                moneyFlowVolume[i] = 0;
                continue;
            }
            const multiplier = ((close[i] - low[i]) - (high[i] - close[i])) / range;
            moneyFlowVolume[i] = multiplier * volume[i];
        }

        let mfvSum = 0;
        let volumeSum = 0;
        for (let i = 0; i < length; i++) {
            mfvSum += moneyFlowVolume[i];
            volumeSum += volume[i];

            if (i >= period) {
                mfvSum -= moneyFlowVolume[i - period];
                volumeSum -= volume[i - period];
            }

            if (i >= period - 1) {
                result[i] = volumeSum === 0 ? 0 : mfvSum / volumeSum;
            }
        }

        return result;
    });
}

function calculateMidpointChannel(
    high: number[],
    low: number[],
    period: number
): (number | null)[] {
    const result: (number | null)[] = new Array(high.length).fill(null);
    const { upper, lower } = calculateRollingHighLow(high, low, period);

    for (let i = period - 1; i < high.length; i++) {
        const upperValue = upper[i];
        const lowerValue = lower[i];
        if (upperValue !== null && lowerValue !== null) {
            result[i] = (upperValue + lowerValue) / 2;
        }
    }

    return result;
}

export function calculateIchimoku(
    high: number[],
    low: number[],
    close: number[],
    conversionPeriod: number = 9,
    basePeriod: number = 26,
    spanBPeriod: number = 52,
    displacement: number = 26
): {
    conversion: (number | null)[];
    base: (number | null)[];
    spanA: (number | null)[];
    spanB: (number | null)[];
    lagging: (number | null)[];
} {
    const key = `${conversionPeriod}|${basePeriod}|${spanBPeriod}|${displacement}`;
    return getOrComputeOHLCByKey(__ichimokuCache, high, low, close, key, () => {
        const conversion = calculateMidpointChannel(high, low, conversionPeriod);
        const base = calculateMidpointChannel(high, low, basePeriod);
        const spanBBase = calculateMidpointChannel(high, low, spanBPeriod);
        const spanA: (number | null)[] = new Array(close.length).fill(null);
        const spanB: (number | null)[] = new Array(close.length).fill(null);
        const lagging: (number | null)[] = new Array(close.length).fill(null);

        for (let i = 0; i < close.length; i++) {
            const conversionNow = conversion[i];
            const baseNow = base[i];
            const spanBNow = spanBBase[i];

            if (conversionNow !== null && baseNow !== null) {
                spanA[i] = (conversionNow + baseNow) / 2;
            }
            if (spanBNow !== null) {
                spanB[i] = spanBNow;
            }
            if (i >= displacement) {
                lagging[i - displacement] = close[i];
            }
        }

        return { conversion, base, spanA, spanB, lagging };
    });
}

export function calculateVWAP(
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
    period: number
): (number | null)[] {
    return getOrComputeOHLCV(__vwapCache, high, low, close, volume, period, () => {
        const length = close.length;
        const vwap: (number | null)[] = new Array(length).fill(null);
        if (length < period || period < 1) return vwap;

        let sumTypicalVolume = 0;
        let sumVolume = 0;

        for (let i = 0; i < length; i++) {
            const typical = (high[i] + low[i] + close[i]) / 3;
            sumTypicalVolume += typical * volume[i];
            sumVolume += volume[i];

            if (i >= period) {
                const oldTypical = (high[i - period] + low[i - period] + close[i - period]) / 3;
                sumTypicalVolume -= oldTypical * volume[i - period];
                sumVolume -= volume[i - period];
            }

            if (i >= period - 1) {
                vwap[i] = sumVolume > 0 ? sumTypicalVolume / sumVolume : typical;
            }
        }

        return vwap;
    });
}

export function calculateRSI(close: number[], period: number): (number | null)[] {
    return getOrCompute(__rsiCache, close, period, () => {
        const result: (number | null)[] = new Array(close.length).fill(null);
        if (period < 1 || close.length <= period) return result;

        let averageGain = 0;
        let averageLoss = 0;
        for (let i = 1; i <= period; i++) {
            const change = close[i] - close[i - 1];
            averageGain += Math.max(change, 0);
            averageLoss += Math.max(-change, 0);
        }
        averageGain /= period;
        averageLoss /= period;

        const toRsi = (): number => {
            if (averageGain === 0 && averageLoss === 0) return 50;
            if (averageLoss === 0) return 100;
            return 100 - (100 / (1 + averageGain / averageLoss));
        };
        result[period] = toRsi();

        for (let i = period + 1; i < close.length; i++) {
            const change = close[i] - close[i - 1];
            averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
            averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
            result[i] = toRsi();
        }
        return result;
    });
}

export function calculateCCI(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    return getOrComputeOHLC(__cciCache, high, low, close, period, () => {
        const length = Math.min(high.length, low.length, close.length);
        const result: (number | null)[] = new Array(length).fill(null);
        if (period < 1 || length < period) return result;

        const typical = new Array<number>(length);
        let sum = 0;
        for (let i = 0; i < length; i++) {
            typical[i] = (high[i] + low[i] + close[i]) / 3;
            sum += typical[i];
            if (i >= period) sum -= typical[i - period];
            if (i < period - 1) continue;

            const mean = sum / period;
            let deviationSum = 0;
            for (let j = i - period + 1; j <= i; j++) {
                deviationSum += Math.abs(typical[j] - mean);
            }
            const meanDeviation = deviationSum / period;
            result[i] = meanDeviation === 0 ? 0 : (typical[i] - mean) / (0.015 * meanDeviation);
        }
        return result;
    });
}

export function calculateWilliamsR(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    return getOrComputeOHLC(__williamsRCache, high, low, close, period, () => {
        const length = Math.min(high.length, low.length, close.length);
        const result: (number | null)[] = new Array(length).fill(null);
        const levels = calculateRollingHighLow(high, low, period);

        for (let i = period - 1; i < length; i++) {
            const highest = levels.upper[i];
            const lowest = levels.lower[i];
            if (highest === null || lowest === null) continue;
            const range = highest - lowest;
            result[i] = range === 0 ? -50 : -100 * (highest - close[i]) / range;
        }
        return result;
    });
}

export function calculateStochasticK(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    return getOrComputeOHLC(__stochasticCache, high, low, close, period, () => {
        const length = Math.min(high.length, low.length, close.length);
        const result: (number | null)[] = new Array(length).fill(null);
        const levels = calculateRollingHighLow(high, low, period);

        for (let i = period - 1; i < length; i++) {
            const highest = levels.upper[i];
            const lowest = levels.lower[i];
            if (highest === null || lowest === null) continue;
            const range = highest - lowest;
            result[i] = range === 0 ? 50 : 100 * (close[i] - lowest) / range;
        }
        return result;
    });
}

export function calculateBollingerBands(
    close: number[],
    period: number,
    deviationMultiplier: number
): {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
} {
    const key = `${period}|${deviationMultiplier}`;
    return getOrCompute(__bollingerCache, close, key, () => {
        const upper: (number | null)[] = new Array(close.length).fill(null);
        const middle: (number | null)[] = new Array(close.length).fill(null);
        const lower: (number | null)[] = new Array(close.length).fill(null);
        if (period < 1 || close.length < period) return { upper, middle, lower };

        let sum = 0;
        let sumSquares = 0;
        for (let i = 0; i < close.length; i++) {
            sum += close[i];
            sumSquares += close[i] * close[i];
            if (i >= period) {
                sum -= close[i - period];
                sumSquares -= close[i - period] * close[i - period];
            }
            if (i < period - 1) continue;

            const mean = sum / period;
            const variance = Math.max(0, sumSquares / period - mean * mean);
            const deviation = Math.sqrt(variance) * deviationMultiplier;
            middle[i] = mean;
            upper[i] = mean + deviation;
            lower[i] = mean - deviation;
        }
        return { upper, middle, lower };
    });
}

export function calculateParabolicSAR(
    high: number[],
    low: number[],
    close: number[],
    accelerationStep: number,
    maximumAcceleration: number
): {
    sar: (number | null)[];
    direction: (1 | -1 | null)[];
} {
    const key = `${accelerationStep}|${maximumAcceleration}`;
    return getOrComputeOHLCByKey(__parabolicSarCache, high, low, close, key, () => {
        const length = Math.min(high.length, low.length, close.length);
        const sar: (number | null)[] = new Array(length).fill(null);
        const direction: (1 | -1 | null)[] = new Array(length).fill(null);
        if (length < 2) return { sar, direction };

        let trend: 1 | -1 = close[1] >= close[0] ? 1 : -1;
        let extreme = trend === 1 ? Math.max(high[0], high[1]) : Math.min(low[0], low[1]);
        let currentSar = trend === 1 ? Math.min(low[0], low[1]) : Math.max(high[0], high[1]);
        let acceleration = accelerationStep;
        sar[1] = currentSar;
        direction[1] = trend;

        for (let i = 2; i < length; i++) {
            currentSar += acceleration * (extreme - currentSar);

            if (trend === 1) {
                currentSar = Math.min(currentSar, low[i - 1], low[i - 2]);
                if (low[i] < currentSar) {
                    trend = -1;
                    currentSar = extreme;
                    extreme = low[i];
                    acceleration = accelerationStep;
                } else if (high[i] > extreme) {
                    extreme = high[i];
                    acceleration = Math.min(maximumAcceleration, acceleration + accelerationStep);
                }
            } else {
                currentSar = Math.max(currentSar, high[i - 1], high[i - 2]);
                if (high[i] > currentSar) {
                    trend = 1;
                    currentSar = extreme;
                    extreme = high[i];
                    acceleration = accelerationStep;
                } else if (low[i] < extreme) {
                    extreme = low[i];
                    acceleration = Math.min(maximumAcceleration, acceleration + accelerationStep);
                }
            }

            sar[i] = currentSar;
            direction[i] = trend;
        }
        return { sar, direction };
    });
}

export function calculateSupertrend(
    high: number[],
    low: number[],
    close: number[],
    atrPeriod: number,
    multiplier: number
): {
    line: (number | null)[];
    direction: (1 | -1 | null)[];
} {
    const key = `${atrPeriod}|${multiplier}`;
    return getOrComputeOHLCByKey(__supertrendCache, high, low, close, key, () => {
        const length = Math.min(high.length, low.length, close.length);
        const line: (number | null)[] = new Array(length).fill(null);
        const direction: (1 | -1 | null)[] = new Array(length).fill(null);
        const atr = calculateATR(high, low, close, atrPeriod);
        const finalUpper: (number | null)[] = new Array(length).fill(null);
        const finalLower: (number | null)[] = new Array(length).fill(null);

        for (let i = atrPeriod - 1; i < length; i++) {
            const atrNow = atr[i];
            if (atrNow === null) continue;
            const midpoint = (high[i] + low[i]) / 2;
            const basicUpper = midpoint + multiplier * atrNow;
            const basicLower = midpoint - multiplier * atrNow;
            const previousUpper = finalUpper[i - 1];
            const previousLower = finalLower[i - 1];

            finalUpper[i] = previousUpper === null || basicUpper < previousUpper || close[i - 1] > previousUpper
                ? basicUpper
                : previousUpper;
            finalLower[i] = previousLower === null || basicLower > previousLower || close[i - 1] < previousLower
                ? basicLower
                : previousLower;

            const previousDirection = direction[i - 1];
            if (previousDirection === null) {
                direction[i] = close[i] >= midpoint ? 1 : -1;
            } else if (previousDirection === 1 && close[i] < (previousLower as number)) {
                direction[i] = -1;
            } else if (previousDirection === -1 && close[i] > (previousUpper as number)) {
                direction[i] = 1;
            } else {
                direction[i] = previousDirection;
            }
            line[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i];
        }
        return { line, direction };
    });
}

export function calculateAroon(
    high: number[],
    low: number[],
    period: number
): {
    up: (number | null)[];
    down: (number | null)[];
} {
    return getOrComputeHL(__aroonCache, high, low, period, () => {
        const length = Math.min(high.length, low.length);
        const up: (number | null)[] = new Array(length).fill(null);
        const down: (number | null)[] = new Array(length).fill(null);
        if (period < 1 || length < period) return { up, down };

        for (let i = period - 1; i < length; i++) {
            const start = i - period + 1;
            let highestIndex = start;
            let lowestIndex = start;
            for (let j = start + 1; j <= i; j++) {
                if (high[j] >= high[highestIndex]) highestIndex = j;
                if (low[j] <= low[lowestIndex]) lowestIndex = j;
            }
            up[i] = 100 * (period - 1 - (i - highestIndex)) / Math.max(1, period - 1);
            down[i] = 100 * (period - 1 - (i - lowestIndex)) / Math.max(1, period - 1);
        }
        return { up, down };
    });
}

export function calculateDMI(
    high: number[],
    low: number[],
    close: number[],
    period: number
): {
    plus: (number | null)[];
    minus: (number | null)[];
} {
    return getOrComputeOHLCByKey(__dmiCache, high, low, close, String(period), () => {
        const length = Math.min(high.length, low.length, close.length);
        const plus: (number | null)[] = new Array(length).fill(null);
        const minus: (number | null)[] = new Array(length).fill(null);
        if (period < 1 || length <= period) return { plus, minus };

        const trueRange = new Array<number>(length).fill(0);
        const plusMovement = new Array<number>(length).fill(0);
        const minusMovement = new Array<number>(length).fill(0);
        for (let i = 1; i < length; i++) {
            const upMove = high[i] - high[i - 1];
            const downMove = low[i - 1] - low[i];
            plusMovement[i] = upMove > downMove && upMove > 0 ? upMove : 0;
            minusMovement[i] = downMove > upMove && downMove > 0 ? downMove : 0;
            trueRange[i] = Math.max(
                high[i] - low[i],
                Math.abs(high[i] - close[i - 1]),
                Math.abs(low[i] - close[i - 1])
            );
        }

        let trSmooth = 0;
        let plusSmooth = 0;
        let minusSmooth = 0;
        for (let i = 1; i <= period; i++) {
            trSmooth += trueRange[i];
            plusSmooth += plusMovement[i];
            minusSmooth += minusMovement[i];
        }

        for (let i = period; i < length; i++) {
            if (i > period) {
                trSmooth = trSmooth - trSmooth / period + trueRange[i];
                plusSmooth = plusSmooth - plusSmooth / period + plusMovement[i];
                minusSmooth = minusSmooth - minusSmooth / period + minusMovement[i];
            }
            plus[i] = trSmooth === 0 ? 0 : 100 * plusSmooth / trSmooth;
            minus[i] = trSmooth === 0 ? 0 : 100 * minusSmooth / trSmooth;
        }
        return { plus, minus };
    });
}

export function calculateMFI(
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
    period: number
): (number | null)[] {
    return getOrComputeOHLCV(__mfiCache, high, low, close, volume, period, () => {
        const length = Math.min(high.length, low.length, close.length, volume.length);
        const result: (number | null)[] = new Array(length).fill(null);
        if (period < 1 || length <= period) return result;

        const typical = new Array<number>(length);
        const positiveFlow = new Array<number>(length).fill(0);
        const negativeFlow = new Array<number>(length).fill(0);
        for (let i = 0; i < length; i++) {
            typical[i] = (high[i] + low[i] + close[i]) / 3;
            if (i === 0) continue;
            const rawFlow = typical[i] * volume[i];
            if (typical[i] > typical[i - 1]) positiveFlow[i] = rawFlow;
            if (typical[i] < typical[i - 1]) negativeFlow[i] = rawFlow;
        }

        let positiveSum = 0;
        let negativeSum = 0;
        for (let i = 1; i < length; i++) {
            positiveSum += positiveFlow[i];
            negativeSum += negativeFlow[i];
            if (i > period) {
                positiveSum -= positiveFlow[i - period];
                negativeSum -= negativeFlow[i - period];
            }
            if (i < period) continue;
            if (positiveSum === 0 && negativeSum === 0) result[i] = 50;
            else if (negativeSum === 0) result[i] = 100;
            else result[i] = 100 - 100 / (1 + positiveSum / negativeSum);
        }
        return result;
    });
}

export function calculateOBV(close: number[], volume: number[]): number[] {
    let byVolume = __obvCache.get(close);
    if (!byVolume) {
        byVolume = new WeakMap();
        __obvCache.set(close, byVolume);
    }
    const cached = byVolume.get(volume);
    if (cached) return cached;

    const length = Math.min(close.length, volume.length);
    const result = new Array<number>(length).fill(0);
    for (let i = 1; i < length; i++) {
        if (close[i] > close[i - 1]) result[i] = result[i - 1] + volume[i];
        else if (close[i] < close[i - 1]) result[i] = result[i - 1] - volume[i];
        else result[i] = result[i - 1];
    }
    byVolume.set(volume, result);
    return result;
}

export function calculateTRIX(close: number[], period: number): (number | null)[] {
    return getOrCompute(__trixCache, close, period, () => {
        const result: (number | null)[] = new Array(close.length).fill(null);
        if (period < 1 || close.length < period * 3) return result;

        const denseEma = (values: number[]): number[] => {
            const output = new Array<number>(values.length);
            const multiplier = 2 / (period + 1);
            output[0] = values[0];
            for (let i = 1; i < values.length; i++) {
                output[i] = (values[i] - output[i - 1]) * multiplier + output[i - 1];
            }
            return output;
        };
        const first = denseEma(close);
        const second = denseEma(first);
        const third = denseEma(second);
        const warmup = period * 3 - 2;
        for (let i = warmup; i < close.length; i++) {
            const previous = third[i - 1];
            result[i] = previous === 0 ? 0 : 100 * (third[i] - previous) / Math.abs(previous);
        }
        return result;
    });
}


