import { Signal, OHLCVData, Time } from '../types/strategies';

// ============================================================================
// Data Mapping & Memoization
// ============================================================================

const highsCache = new WeakMap<OHLCVData[], number[]>();
const lowsCache = new WeakMap<OHLCVData[], number[]>();
const closesCache = new WeakMap<OHLCVData[], number[]>();
const volumesCache = new WeakMap<OHLCVData[], number[]>();

/**
 * Gets a memoized array of high prices from OHLCV data.
 * Useful for ensuring indicator cache hits.
 */
export function getHighs(data: OHLCVData[]): number[] {
    let cached = highsCache.get(data);
    if (!cached) {
        cached = data.map(d => d.high);
        highsCache.set(data, cached);
    }
    return cached;
}

/**
 * Gets a memoized array of low prices from OHLCV data.
 */
export function getLows(data: OHLCVData[]): number[] {
    let cached = lowsCache.get(data);
    if (!cached) {
        cached = data.map(d => d.low);
        lowsCache.set(data, cached);
    }
    return cached;
}

/**
 * Gets a memoized array of close prices from OHLCV data.
 */
export function getCloses(data: OHLCVData[]): number[] {
    let cached = closesCache.get(data);
    if (!cached) {
        cached = data.map(d => d.close);
        closesCache.set(data, cached);
    }
    return cached;
}

/**
 * Gets a memoized array of volume from OHLCV data.
 */
export function getVolumes(data: OHLCVData[]): number[] {
    let cached = volumesCache.get(data);
    if (!cached) {
        cached = data.map(d => d.volume);
        volumesCache.set(data, cached);
    }
    return cached;
}

// ============================================================================
// Signal Helpers
// ============================================================================


/**
 * Checks if any of the provided values at the specified index or the previous index are null.
 * @param arrays Arrays of numbers (or nulls) to check.
 * @param index Current index to check.
 * @returns true if any value is null at index or index - 1.
 */
export function hasNullValues(arrays: (number | null)[][], index: number): boolean {
    for (const arr of arrays) {
        if (arr[index] === null || arr[index - 1] === null) return true;
    }
    return false;
}

/**
 * Creates a buy signal.
 * @param data The OHLCV data array.
 * @param index The current index.
 * @param reason The reason for the signal.
 */
export function createBuySignal(data: OHLCVData[], index: number, reason: string): Signal {
    return {
        time: data[index].time,
        type: 'buy',
        price: data[index].close,
        reason,
        barIndex: index,
    };
}

/**
 * Creates a sell signal.
 * @param data The OHLCV data array.
 * @param index The current index.
 * @param reason The reason for the signal.
 */
export function createSellSignal(data: OHLCVData[], index: number, reason: string): Signal {
    return {
        time: data[index].time,
        type: 'sell',
        price: data[index].close,
        reason,
        barIndex: index,
    };
}

/**
 * Helper to cross-check two arrays (e.g. Fast vs Slow MA).
 * Checks for a crossover event at the current index.
 */
export function checkCrossover(
    fast: (number | null)[],
    slow: (number | null)[],
    index: number
): 'bullish' | 'bearish' | null {
    const fPrev = fast[index - 1]!;
    const sPrev = slow[index - 1]!;
    const fCurr = fast[index]!;
    const sCurr = slow[index]!;

    // Bullish: Fast crosses above Slow
    if (fPrev <= sPrev && fCurr > sCurr) return 'bullish';
    // Bearish: Fast crosses below Slow
    if (fPrev >= sPrev && fCurr < sCurr) return 'bearish';

    return null;
}

/**
 * Ensures the data array is clean by filtering out null or undefined elements.
 */
export function ensureCleanData(data: OHLCVData[] | undefined | null): OHLCVData[] {
    if (!data) return [];
    return data.filter(d => d !== undefined && d !== null);
}

/**
 * Validates that an OHLCV data array is valid and non-empty.
 */
export function isValidDataArray(data: OHLCVData[]): boolean {
    if (!data || data.length === 0) return false;
    // Check points to balance performance and safety
    if (data[0] === undefined || data[data.length - 1] === undefined) return false;

    // For smaller arrays or if we're feeling paranoid, we could check every element
    // but usually checking the ends and cleaning the data at the entry point is better.
    return true;
}

/**
 * Helper to iterate over data and generate signals.
 * Automates the loop and null checking.
 */
export function createSignalLoop(
    data: OHLCVData[],
    indicators: (number | null)[][],
    checkSignal: (index: number) => Signal | undefined | null
): Signal[] {
    // Validate data before processing
    if (!isValidDataArray(data)) {
        return [];
    }

    const signals: Signal[] = [];
    // Start from 1 because most strategies compare with previous value (i-1)
    for (let i = 1; i < data.length; i++) {
        if (hasNullValues(indicators, i)) continue;
        const signal = checkSignal(i);
        if (signal) {
            signals.push(signal);
        }
    }
    return signals;
}

// ============================================================================
// Pivot Detection
// ============================================================================

export interface Pivot {
    index: number;
    price: number;
    isHigh: boolean; // true = high, false = low
    time: Time;
}

/**
 * Detects pivots using a combination of local extrema (depth) and price deviation.
 * Matches the logic of "Auto Fib Time Zones" Pine Script.
 * 
 * @param data OHLCV data array
 * @param deviationPercent Minimum percentage change to confirm a new pivot direction
 * @param depth Minimum bars on left/right to be a local candidate (total window ~ depth)
 */
export function detectPivotsWithDeviation(
    data: OHLCVData[],
    deviationPercent: number,
    depth: number
): Pivot[] {
    const pivots: Pivot[] = [];
    const highs = getHighs(data);
    const lows = getLows(data);

    // 1. Find candidate local extrema (standard pivots)
    // using a rolling window approach
    const candidates: Pivot[] = [];
    const halfDepth = Math.floor(depth / 2);

    for (let i = halfDepth; i < data.length - halfDepth; i++) {
        // Check High
        let isHigh = true;
        for (let j = 1; j <= halfDepth; j++) {
            if (highs[i] < highs[i - j] || highs[i] <= highs[i + j]) {
                isHigh = false;
                break;
            }
        }
        if (isHigh) {
            candidates.push({ index: i, price: highs[i], isHigh: true, time: data[i].time });
        }

        // Check Low
        let isLow = true;
        for (let j = 1; j <= halfDepth; j++) {
            if (lows[i] > lows[i - j] || lows[i] >= lows[i + j]) {
                isLow = false;
                break;
            }
        }
        if (isLow) {
            candidates.push({ index: i, price: lows[i], isHigh: false, time: data[i].time });
        }
    }

    // Sort candidates by index
    candidates.sort((a, b) => a.index - b.index);

    if (candidates.length === 0) return [];

    // 2. Filter using ZigZag/Deviation logic
    // Corresponds to 'pivotFound' logic in Pine Script
    let lastPivot = candidates[0];
    pivots.push(lastPivot);

    for (const cand of candidates) {
        if (cand.index <= lastPivot.index) continue;

        const dev = Math.abs((cand.price - lastPivot.price) / lastPivot.price) * 100;

        if (lastPivot.isHigh === cand.isHigh) {
            // Same direction
            if (lastPivot.isHigh) {
                // If we found a HIGHER high, update the current pivot
                if (cand.price > lastPivot.price) {
                    lastPivot.price = cand.price;
                    lastPivot.index = cand.index;
                    lastPivot.time = cand.time;
                    lastPivot.isHigh = cand.isHigh; // redundant but safe
                    // Update in the final list too
                    pivots[pivots.length - 1] = lastPivot;
                }
            } else {
                // If we found a LOWER low, update the current pivot
                if (cand.price < lastPivot.price) {
                    lastPivot.price = cand.price;
                    lastPivot.index = cand.index;
                    lastPivot.time = cand.time;
                    lastPivot.isHigh = cand.isHigh;
                    pivots[pivots.length - 1] = lastPivot;
                }
            }
        } else {
            // Reverse direction
            if (dev >= deviationPercent) {
                // Confirm new pivot
                lastPivot = cand;
                pivots.push(lastPivot);
            }
        }
    }

    return pivots;
}


