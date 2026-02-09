import { OHLCVData } from '../types/strategies';

// ============================================================================
// Indicator Calculations
// ============================================================================

export function calculateSMA(data: number[], period: number): (number | null)[] {
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
}


// EMA results cache to avoid recomputation across repeated calls on the same data
const __emaCache: WeakMap<number[], Map<number, (number | null)[]>> = new WeakMap();
const __rsiCache: WeakMap<number[], Map<number, (number | null)[]>> = new WeakMap();
const __macDCache: WeakMap<number[], Map<string, { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[]; }>> = new WeakMap();
const __bbCache: WeakMap<number[], Map<string, { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[]; }>> = new WeakMap();
const __atrCache: WeakMap<number[], Map<number, (number | null)[]>> = new WeakMap();
const __adxCache: WeakMap<number[], Map<number, (number | null)[]>> = new WeakMap();

export function calculateEMA(data: number[], period: number): (number | null)[] {
    // Cache hit
    let periodMap = __emaCache.get(data);
    if (!periodMap) {
        periodMap = new Map();
        __emaCache.set(data, periodMap);
    }
    const cached = periodMap.get(period);
    if (cached) return cached;

    const result: (number | null)[] = new Array(data.length).fill(null);
    if (data.length < period) {
        periodMap.set(period, result);
        return result;
    }

    const multiplier = 2 / (period + 1);
    let sum = 0;

    // Calculate initial SMA
    for (let i = 0; i < period; i++) {
        sum += data[i];
    }

    let prevEMA = sum / period;
    result[period - 1] = prevEMA;

    // Calculate EMA
    for (let i = period; i < data.length; i++) {
        const currentEMA = (data[i] - prevEMA) * multiplier + prevEMA;
        result[i] = currentEMA;
        prevEMA = currentEMA;
    }

    periodMap.set(period, result);
    return result;
}

export function calculateRSI(data: number[], period: number): (number | null)[] {
    // Cache check
    let periodMap = __rsiCache.get(data);
    if (!periodMap) {
        periodMap = new Map();
        __rsiCache.set(data, periodMap);
    }
    const cached = periodMap.get(period);
    if (cached) return cached;

    const length = data.length;
    const result: (number | null)[] = new Array(length).fill(null);

    if (length < period + 1) {
        periodMap.set(period, result);
        return result;
    }

    // Calculate initial gains and losses
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
        const change = data[i] - data[i - 1];
        if (change > 0) {
            avgGain += change;
        } else {
            avgLoss += Math.abs(change);
        }
    }

    avgGain /= period;
    avgLoss /= period;

    // First RSI value
    let firstRSI: number;
    if (avgLoss === 0) {
        firstRSI = 100;
    } else {
        const rs = avgGain / avgLoss;
        firstRSI = 100 - (100 / (1 + rs));
    }
    result[period] = firstRSI;

    // Calculate remaining RSI values using Wilder's smoothing
    for (let i = period + 1; i < length; i++) {
        const change = data[i] - data[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        if (avgLoss === 0) {
            result[i] = 100;
        } else {
            const rs = avgGain / avgLoss;
            result[i] = 100 - (100 / (1 + rs));
        }
    }

    periodMap.set(period, result);
    return result;
}

export function calculateMACD(data: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number): {
    macd: (number | null)[];
    signal: (number | null)[];
    histogram: (number | null)[];
} {
    const cacheKey = `${fastPeriod}-${slowPeriod}-${signalPeriod}`;

    // Cache check
    let paramsMap = __macDCache.get(data);
    if (!paramsMap) {
        paramsMap = new Map();
        __macDCache.set(data, paramsMap);
    }
    const cached = paramsMap.get(cacheKey);
    if (cached) return cached;

    // Use cached EMA to avoid redundant allocations
    const fastEMA = calculateEMA(data, fastPeriod);
    const slowEMA = calculateEMA(data, slowPeriod);

    const length = data.length;
    const macd: (number | null)[] = new Array(length).fill(null);

    for (let i = 0; i < length; i++) {
        const f = fastEMA[i];
        const s = slowEMA[i];
        macd[i] = (f === null || s === null) ? null : (f - s);
    }

    // Compute signal line inline without filtering/allocations
    const signal: (number | null)[] = new Array(length).fill(null);
    const histogram: (number | null)[] = new Array(length).fill(null);
    const multiplier = 2 / (signalPeriod + 1);

    let validMacdCount = 0;
    let initSum = 0;
    let prevSignal: number | null = null;

    for (let i = 0; i < length; i++) {
        const m = macd[i];
        if (m === null) {
            // Keep signal and histogram as null until MACD becomes available
            continue;
        }

        if (prevSignal === null) {
            // Accumulate for initial SMA of signalPeriod
            initSum += m;
            validMacdCount++;
            if (validMacdCount === signalPeriod) {
                prevSignal = initSum / signalPeriod;
                signal[i] = prevSignal;
                histogram[i] = m - prevSignal;
            }
        } else {
            // Standard EMA update
            const valM = m as number;
            const valPrev = prevSignal as number;
            const currentSignal: number = (valM - valPrev) * multiplier + valPrev;
            signal[i] = currentSignal;
            histogram[i] = m - currentSignal;
            prevSignal = currentSignal;
        }
    }

    const result = { macd, signal, histogram };
    paramsMap.set(cacheKey, result);
    return result;
}

export function calculateBollingerBands(data: number[], period: number, stdDev: number = 2): {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
} {
    const cacheKey = `${period}-${stdDev}`;

    // Cache check
    let paramsMap = __bbCache.get(data);
    if (!paramsMap) {
        paramsMap = new Map();
        __bbCache.set(data, paramsMap);
    }
    const cached = paramsMap.get(cacheKey);
    if (cached) return cached;

    const length = data.length;
    const upper: (number | null)[] = new Array(length).fill(null);
    const middle: (number | null)[] = new Array(length).fill(null);
    const lower: (number | null)[] = new Array(length).fill(null);

    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < length; i++) {
        const val = data[i];
        sum += val;
        sumSq += val * val;

        if (i >= period - 1) {
            if (i >= period) {
                const oldVal = data[i - period];
                sum -= oldVal;
                sumSq -= oldVal * oldVal;
            }

            const avg = sum / period;
            // Variance formula: (SumSq - (Sum^2 / N)) / N
            const variance = Math.max(0, (sumSq - (sum * sum) / period) / period);
            const std = Math.sqrt(variance);

            middle[i] = avg;
            upper[i] = avg + stdDev * std;
            lower[i] = avg - stdDev * std;
        }
    }

    const result = { upper, middle, lower };
    paramsMap.set(cacheKey, result);
    return result;
}

export function calculateStochastic(
    high: number[],
    low: number[],
    close: number[],
    kPeriod: number,
    dPeriod: number
): {
    k: (number | null)[];
    d: (number | null)[];
} {
    const k: (number | null)[] = [];
    const d: (number | null)[] = [];

    // Monotonic queues for sliding window min/max
    const maxDeque: number[] = [];
    const minDeque: number[] = [];

    for (let i = 0; i < close.length; i++) {
        while (maxDeque.length > 0 && high[maxDeque[maxDeque.length - 1]] <= high[i]) maxDeque.pop();
        maxDeque.push(i);
        if (maxDeque[0] <= i - kPeriod) maxDeque.shift();

        while (minDeque.length > 0 && low[minDeque[minDeque.length - 1]] >= low[i]) minDeque.pop();
        minDeque.push(i);
        if (minDeque[0] <= i - kPeriod) minDeque.shift();

        if (i < kPeriod - 1) {
            k.push(null);
        } else {
            const highestHigh = high[maxDeque[0]];
            const lowestLow = low[minDeque[0]];
            const range = highestHigh - lowestLow;
            if (range === 0) {
                k.push(50);
            } else {
                k.push(((close[i] - lowestLow) / range) * 100);
            }
        }
    }

    // %D (SMA of %K)
    let dSum = 0;
    let dCount = 0;
    for (let i = 0; i < k.length; i++) {
        const val = k[i];
        if (val !== null) {
            dSum += val;
            dCount++;
            if (dCount > dPeriod) {
                const oldVal = k[i - dPeriod];
                if (oldVal !== null) {
                    dSum -= oldVal;
                    dCount--;
                }
            }
        }

        if (val === null || dCount < dPeriod) {
            d.push(null);
        } else {
            d.push(dSum / dPeriod);
        }
    }

    return { k, d };
}

export function calculateVWAP(ohlcv: OHLCVData[]): (number | null)[] {
    const vwap: (number | null)[] = [];
    let cumulativeTPV = 0; // Typical Price * Volume
    let cumulativeVolume = 0;

    for (let i = 0; i < ohlcv.length; i++) {
        const typicalPrice = (ohlcv[i].high + ohlcv[i].low + ohlcv[i].close) / 3;
        cumulativeTPV += typicalPrice * ohlcv[i].volume;
        cumulativeVolume += ohlcv[i].volume;

        if (cumulativeVolume === 0) {
            vwap.push(null);
        } else {
            vwap.push(cumulativeTPV / cumulativeVolume);
        }
    }

    return vwap;
}

export function calculateATR(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    // Cache check using 'close' array as ID for the dataset
    let periodMap = __atrCache.get(close);
    if (!periodMap) {
        periodMap = new Map();
        __atrCache.set(close, periodMap);
    }
    const cached = periodMap.get(period);
    if (cached) return cached;

    const length = close.length;
    const atr: (number | null)[] = new Array(length).fill(null);
    let initialTRSum = 0;

    // Use a previous ATR variable to avoid array lookups
    let prevATR = 0;

    for (let i = 0; i < length; i++) {
        const tr = i === 0
            ? high[i] - low[i]
            : Math.max(
                high[i] - low[i],
                Math.abs(high[i] - close[i - 1]),
                Math.abs(low[i] - close[i - 1])
            );

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

    periodMap.set(period, atr);
    return atr;
}

export function calculateADX(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    // Cache check using 'close' array as ID for the dataset
    let periodMap = __adxCache.get(close);
    if (!periodMap) {
        periodMap = new Map();
        __adxCache.set(close, periodMap);
    }
    const cached = periodMap.get(period);
    if (cached) return cached;

    const length = close.length;
    const adx: (number | null)[] = new Array(length).fill(null);

    if (length < period * 2 || period < 1) {
        periodMap.set(period, adx);
        return adx;
    }

    const tr: number[] = new Array(length).fill(0);
    const plusDM: number[] = new Array(length).fill(0);
    const minusDM: number[] = new Array(length).fill(0);

    for (let i = 1; i < length; i++) {
        const upMove = high[i] - high[i - 1];
        const downMove = low[i - 1] - low[i];

        plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;

        tr[i] = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - close[i - 1]),
            Math.abs(low[i] - close[i - 1])
        );
    }

    let trSmooth = 0;
    let plusSmooth = 0;
    let minusSmooth = 0;

    for (let i = 1; i <= period; i++) {
        trSmooth += tr[i];
        plusSmooth += plusDM[i];
        minusSmooth += minusDM[i];
    }

    const dx: number[] = new Array(length).fill(0);
    // Optimized loop merging
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
    for (let i = period; i < period * 2; i++) {
        dxSum += dx[i];
    }

    let prevADX = dxSum / period;
    adx[period * 2 - 1] = prevADX;

    for (let i = period * 2; i < length; i++) {
        prevADX = ((prevADX * (period - 1)) + dx[i]) / period;
        adx[i] = prevADX;
    }

    periodMap.set(period, adx);
    return adx;
}

export function calculateVolumeProfile(
    data: { low: number; high: number; close: number; volume: number }[],
    period: number,
    bins: number
): {
    poc: (number | null)[];
    vah: (number | null)[];
    val: (number | null)[];
} {
    const poc: (number | null)[] = [];
    const vah: (number | null)[] = [];
    const val: (number | null)[] = [];

    // Monotonic deques for O(1) min/max across the sliding window of [i - period, i - 1]
    const maxDeque: number[] = [];
    const minDeque: number[] = [];

    for (let i = 0; i < data.length; i++) {
        // Build window over previous period bars (exclusive of i)
        const idxToAdd = i - 1;
        if (idxToAdd >= 0) {
            while (maxDeque.length > 0 && data[maxDeque[maxDeque.length - 1]].high <= data[idxToAdd].high) {
                maxDeque.pop();
            }
            maxDeque.push(idxToAdd);

            while (minDeque.length > 0 && data[minDeque[minDeque.length - 1]].low >= data[idxToAdd].low) {
                minDeque.pop();
            }
            minDeque.push(idxToAdd);
        }

        const windowStart = i - period;
        while (maxDeque.length > 0 && maxDeque[0] < windowStart) maxDeque.shift();
        while (minDeque.length > 0 && minDeque[0] < windowStart) minDeque.shift();

        if (i < period) {
            poc.push(null);
            vah.push(null);
            val.push(null);
            continue;
        }

        // O(1) min/max from deques
        const minPrice = data[minDeque[0]].low;
        const maxPrice = data[maxDeque[0]].high;

        const range = maxPrice - minPrice;
        if (range <= 0) {
            const price = data[i].close;
            poc.push(price);
            vah.push(price);
            val.push(price);
            continue;
        }

        const binSize = range / bins;
        const volumeProfile = new Float64Array(bins);

        // Distribute volume into bins for the window [i - period, i - 1]
        for (let j = windowStart; j < i; j++) {
            const candle = data[j];
            const meanPrice = (candle.high + candle.low) / 2;
            let binIndex = Math.floor((meanPrice - minPrice) / binSize);
            if (binIndex < 0) binIndex = 0;
            if (binIndex >= bins) binIndex = bins - 1;
            volumeProfile[binIndex] += candle.volume;
        }

        // Find POC and total volume
        let maxVol = 0;
        let maxVolIndex = 0;
        let totalVolume = 0;

        for (let j = 0; j < bins; j++) {
            const vol = volumeProfile[j];
            totalVolume += vol;
            if (vol > maxVol) {
                maxVol = vol;
                maxVolIndex = j;
            }
        }

        poc.push(minPrice + (maxVolIndex + 0.5) * binSize);

        // Calculate Value Area (70% of volume) around POC
        const targetVolume = totalVolume * 0.70;
        let currentVolume = maxVol;
        let upIdx = maxVolIndex;
        let downIdx = maxVolIndex;

        while (currentVolume < targetVolume && (upIdx < bins - 1 || downIdx > 0)) {
            const upVol = (upIdx < bins - 1) ? volumeProfile[upIdx + 1] : -1;
            const downVol = (downIdx > 0) ? volumeProfile[downIdx - 1] : -1;

            if (upVol >= downVol && upIdx < bins - 1) {
                upIdx++;
                currentVolume += upVol;
            } else if (downIdx > 0) {
                downIdx--;
                currentVolume += downVol;
            } else {
                break;
            }
        }

        vah.push(minPrice + (upIdx + 1) * binSize);
        val.push(minPrice + downIdx * binSize);
    }

    return { poc, vah, val };
}

export function calculateDonchianChannels(
    high: number[],
    low: number[],
    period: number
): {
    upper: (number | null)[];
    lower: (number | null)[];
    middle: (number | null)[];
} {
    const upper: (number | null)[] = [];
    const lower: (number | null)[] = [];
    const middle: (number | null)[] = [];

    const maxDeque: number[] = [];
    const minDeque: number[] = [];

    for (let i = 0; i < high.length; i++) {
        while (maxDeque.length > 0 && high[maxDeque[maxDeque.length - 1]] <= high[i]) maxDeque.pop();
        maxDeque.push(i);
        if (maxDeque[0] <= i - period) maxDeque.shift();

        while (minDeque.length > 0 && low[minDeque[minDeque.length - 1]] >= low[i]) minDeque.pop();
        minDeque.push(i);
        if (minDeque[0] <= i - period) minDeque.shift();

        if (i < period - 1) {
            upper.push(null);
            lower.push(null);
            middle.push(null);
        } else {
            const maxHigh = high[maxDeque[0]];
            const minLow = low[minDeque[0]];
            upper.push(maxHigh);
            lower.push(minLow);
            middle.push((maxHigh + minLow) / 2);
        }
    }
    return { upper, lower, middle };
}

export function calculateSupertrend(
    high: number[],
    low: number[],
    close: number[],
    period: number,
    factor: number
): {
    supertrend: (number | null)[];
    direction: (1 | -1 | null)[]; // 1: Bullish, -1: Bearish
} {
    const atr = calculateATR(high, low, close, period);
    const supertrend: (number | null)[] = [];
    const direction: (1 | -1 | null)[] = [];

    let prevFinalUpper = 0;
    let prevFinalLower = 0;
    let prevTrend: 1 | -1 = 1;

    for (let i = 0; i < close.length; i++) {
        if (atr[i] === null) {
            supertrend.push(null);
            direction.push(null);
            continue;
        }

        const hl2 = (high[i] + low[i]) / 2;
        const basicUpper = hl2 + factor * atr[i]!;
        const basicLower = hl2 - factor * atr[i]!;

        // Initial values for the first valid bar
        if (supertrend.length > 0 && supertrend[i - 1] === null) {
            supertrend.push(basicLower);
            direction.push(1);
            prevFinalUpper = basicUpper;
            prevFinalLower = basicLower;
            prevTrend = 1;
            continue;
        }

        const prevClose = close[i - 1];

        // Calculate Final Bands
        let finalUpper = basicUpper;
        if (basicUpper < prevFinalUpper || prevClose > prevFinalUpper) {
            finalUpper = basicUpper;
        } else {
            finalUpper = prevFinalUpper;
        }

        let finalLower = basicLower;
        if (basicLower > prevFinalLower || prevClose < prevFinalLower) {
            finalLower = basicLower;
        } else {
            finalLower = prevFinalLower;
        }

        // Determine Trend
        let currentTrend: 1 | -1 = prevTrend;
        if (prevTrend === 1) {
            if (close[i] < finalLower) {
                currentTrend = -1;
            }
        } else {
            if (close[i] > finalUpper) {
                currentTrend = 1;
            }
        }

        direction.push(currentTrend);
        if (currentTrend === 1) {
            supertrend.push(finalLower);
        } else {
            supertrend.push(finalUpper);
        }

        prevFinalUpper = finalUpper;
        prevFinalLower = finalLower;
        prevTrend = currentTrend;
    }

    return { supertrend, direction };
}

export function calculateParabolicSAR(
    high: number[],
    low: number[],
    start: number,
    increment: number,
    max: number
): (number | null)[] {
    const length = Math.min(high.length, low.length);
    const sar: (number | null)[] = new Array(length).fill(null);

    if (length < 2) return sar;

    let isUptrend = high[1] > high[0] || (high[1] === high[0] && low[1] >= low[0]);
    let af = start;
    let ep = isUptrend ? Math.max(high[0], high[1]) : Math.min(low[0], low[1]);

    sar[1] = isUptrend ? Math.min(low[0], low[1]) : Math.max(high[0], high[1]);

    for (let i = 2; i < length; i++) {
        const prevSar = sar[i - 1] as number;
        let currentSar = prevSar + af * (ep - prevSar);

        if (isUptrend) {
            const minLow = Math.min(low[i - 1], low[i - 2]);
            if (currentSar > minLow) currentSar = minLow;
        } else {
            const maxHigh = Math.max(high[i - 1], high[i - 2]);
            if (currentSar < maxHigh) currentSar = maxHigh;
        }

        if (isUptrend) {
            if (low[i] < currentSar) {
                isUptrend = false;
                currentSar = ep;
                ep = low[i];
                af = start;
            } else if (high[i] > ep) {
                ep = high[i];
                af = Math.min(max, af + increment);
            }
        } else {
            if (high[i] > currentSar) {
                isUptrend = true;
                currentSar = ep;
                ep = high[i];
                af = start;
            } else if (low[i] < ep) {
                ep = low[i];
                af = Math.min(max, af + increment);
            }
        }

        sar[i] = currentSar;
    }

    return sar;
}

export function calculateMomentum(data: number[], period: number): (number | null)[] {
    const result: (number | null)[] = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period) {
            result.push(null);
        } else {
            result.push(data[i] - data[i - period]);
        }
    }
    return result;
}


