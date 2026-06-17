// ============================================================================
// Indicator Calculations
// ============================================================================

import { parseTimeToUnixSeconds } from "../time-normalization";

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
const __atrCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>> = new WeakMap();
const __adxCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>> = new WeakMap();
const __vwapCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>>> = new WeakMap();
const __cmfCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<number, (number | null)[]>>>>> = new WeakMap();
const __keltnerCache: WeakMap<number[], WeakMap<number[], WeakMap<number[], Map<string, {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
}>>>> = new WeakMap();
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

function calculateRollingHighLow(
    high: number[],
    low: number[],
    period: number
): { upper: (number | null)[]; lower: (number | null)[] } {
    const upper: (number | null)[] = new Array(high.length).fill(null);
    const lower: (number | null)[] = new Array(high.length).fill(null);
    const maxDeque: number[] = [];
    const minDeque: number[] = [];

    for (let i = 0; i < high.length; i++) {
        while (maxDeque.length > 0 && high[maxDeque[maxDeque.length - 1]] <= high[i]) maxDeque.pop();
        maxDeque.push(i);
        if (maxDeque[0] <= i - period) maxDeque.shift();

        while (minDeque.length > 0 && low[minDeque[minDeque.length - 1]] >= low[i]) minDeque.pop();
        minDeque.push(i);
        if (minDeque[0] <= i - period) minDeque.shift();

        if (i >= period - 1) {
            upper[i] = high[maxDeque[0]];
            lower[i] = low[minDeque[0]];
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

export function calculateMFI(
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
    period: number
): (number | null)[] {
    const length = close.length;
    const mfi: (number | null)[] = new Array(length).fill(null);
    if (length < period + 1 || period < 1) return mfi;

    const typicalPrices = new Array(length);
    const rawMoneyFlow = new Array(length);
    for (let i = 0; i < length; i++) {
        typicalPrices[i] = (high[i] + low[i] + close[i]) / 3;
        rawMoneyFlow[i] = typicalPrices[i] * volume[i];
    }

    for (let i = period; i < length; i++) {
        let posFlow = 0;
        let negFlow = 0;
        for (let j = i - period + 1; j <= i; j++) {
            if (typicalPrices[j] > typicalPrices[j - 1]) {
                posFlow += rawMoneyFlow[j];
            } else if (typicalPrices[j] < typicalPrices[j - 1]) {
                negFlow += rawMoneyFlow[j];
            }
        }
        if (negFlow === 0) {
            mfi[i] = 100;
        } else {
            const moneyRatio = posFlow / negFlow;
            mfi[i] = 100 - 100 / (1 + moneyRatio);
        }
    }
    return mfi;
}

export function calculateSessionVWAP(
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
    times: unknown[]
): (number | null)[] {
    const length = close.length;
    const vwap: (number | null)[] = new Array(length).fill(null);
    if (length === 0) return vwap;

    let sumPV = 0;
    let sumV = 0;
    let lastDay = -1;

    for (let i = 0; i < length; i++) {
        const ts = parseTimeToUnixSeconds(times[i]);
        const day = ts !== null ? Math.floor(ts / 86400) : -1;

        if (day !== lastDay && day !== -1) {
            sumPV = 0;
            sumV = 0;
            lastDay = day;
        }

        const typical = (high[i] + low[i] + close[i]) / 3;
        sumPV += typical * volume[i];
        sumV += volume[i];

        vwap[i] = sumV > 0 ? sumPV / sumV : typical;
    }

    return vwap;
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

export function calculateParabolicSAR(
    high: number[],
    low: number[],
    step: number,
    max: number
): (number | null)[] {
    const length = high.length;
    const sar: (number | null)[] = new Array(length).fill(null);
    if (length < 2) return sar;

    let isLong = high[1] > high[0] || low[0] > low[1];
    let ep = isLong ? high[1] : low[1];
    let af = step;
    let currentSar = isLong ? low[0] : high[0];

    sar[0] = currentSar;
    sar[1] = currentSar;

    for (let i = 2; i < length; i++) {
        const nextSar = currentSar + af * (ep - currentSar);
        let cappedSar = nextSar;

        if (isLong) {
            cappedSar = Math.min(cappedSar, low[i - 1], low[i - 2]);
            if (low[i] < cappedSar) {
                isLong = false;
                cappedSar = Math.max(high[i], high[i - 1], ep);
                ep = low[i];
                af = step;
            } else {
                if (high[i] > ep) {
                    ep = high[i];
                    af = Math.min(af + step, max);
                }
            }
        } else {
            cappedSar = Math.max(cappedSar, high[i - 1], high[i - 2]);
            if (high[i] > cappedSar) {
                isLong = true;
                cappedSar = Math.min(low[i], low[i - 1], ep);
                ep = high[i];
                af = step;
            } else {
                if (low[i] < ep) {
                    ep = low[i];
                    af = Math.min(af + step, max);
                }
            }
        }

        sar[i] = cappedSar;
        currentSar = cappedSar;
    }

    return sar;
}



