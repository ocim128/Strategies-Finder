import { Signal, OHLCVData } from './types';

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
