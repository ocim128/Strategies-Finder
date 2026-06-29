import { Signal, OHLCVData } from '../types/strategies';

// ============================================================================
// Data Mapping & Memoization
// ============================================================================

function getMemoized(cache: WeakMap<OHLCVData[], number[]>, data: OHLCVData[], mapper: (d: OHLCVData) => number): number[] {
    let c = cache.get(data);
    if (!c) { c = data.map(mapper); cache.set(data, c); }
    return c;
}

const _h = new WeakMap<OHLCVData[], number[]>();
const _l = new WeakMap<OHLCVData[], number[]>();
const _o = new WeakMap<OHLCVData[], number[]>();
const _c = new WeakMap<OHLCVData[], number[]>();
const _v = new WeakMap<OHLCVData[], number[]>();
const _typical = new WeakMap<OHLCVData[], number[]>();
const _weightedClose = new WeakMap<OHLCVData[], number[]>();
const _clean = new WeakMap<OHLCVData[], OHLCVData[]>();

export const getHighs = (data: OHLCVData[]): number[] => getMemoized(_h, data, d => d.high);
export const getLows = (data: OHLCVData[]): number[] => getMemoized(_l, data, d => d.low);
export const getOpens = (data: OHLCVData[]): number[] => getMemoized(_o, data, d => d.open);
export const getCloses = (data: OHLCVData[]): number[] => getMemoized(_c, data, d => d.close);
export const getVolumes = (data: OHLCVData[]): number[] => getMemoized(_v, data, d => d.volume);
export const getTypicalPrices = (data: OHLCVData[]): number[] =>
    getMemoized(_typical, data, d => (d.high + d.low + d.close) / 3);
export const getWeightedClosePrices = (data: OHLCVData[]): number[] =>
    getMemoized(_weightedClose, data, d => (d.high + d.low + 2 * d.close) / 4);

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

function createSignal(
    data: OHLCVData[],
    index: number,
    type: 'buy' | 'sell',
    reason: string,
    sizeFraction?: number
): Signal {
    const signal: Signal = { time: data[index].time, type, price: data[index].close, reason, barIndex: index };
    if (Number.isFinite(sizeFraction as number)) {
        const normalized = Math.max(0, Math.min(1, Number(sizeFraction)));
        if (normalized > 0 && normalized < 1) {
            signal.sizeFraction = normalized;
        } else if (normalized === 1) {
            signal.sizeFraction = 1;
        }
    }
    return signal;
}

export const createBuySignal = (
    data: OHLCVData[],
    index: number,
    reason: string,
    sizeFraction?: number
): Signal => createSignal(data, index, 'buy', reason, sizeFraction);
export const createSellSignal = (
    data: OHLCVData[],
    index: number,
    reason: string,
    sizeFraction?: number
): Signal => createSignal(data, index, 'sell', reason, sizeFraction);

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
    if (data.length === 0) return data;

    const cached = _clean.get(data);
    if (cached) return cached;

    // Fast path: most callers already provide clean arrays.
    for (let i = 0; i < data.length; i++) {
        if (data[i] == null) {
            const cleaned: OHLCVData[] = [];
            for (let j = 0; j < data.length; j++) {
                const point = data[j];
                if (point != null) cleaned.push(point);
            }
            _clean.set(data, cleaned);
            return cleaned;
        }
    }

    _clean.set(data, data);
    return data;
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
// Pivot Flags
// ============================================================================

export type PivotExtremaMode = 'strict' | 'pine';

type PivotFlagsResult = { pivotHighs: boolean[]; pivotLows: boolean[] };
// Two-level cache: highs -> lows -> (key -> result). Both highs and lows must
// match referentially because pivot detection depends on both arrays.
const pivotFlagsCache = new WeakMap<number[], WeakMap<number[], Map<string, PivotFlagsResult>>>();

export function buildPivotFlags(
    highs: number[],
    lows: number[],
    swingLength: number,
    extremaMode: PivotExtremaMode = 'strict'
): { pivotHighs: boolean[]; pivotLows: boolean[] } {
    const length = highs.length;
    const cacheKey = `${swingLength}|${extremaMode}|${length}`;

    let byLows = pivotFlagsCache.get(highs);
    if (!byLows) {
        byLows = new WeakMap<number[], Map<string, PivotFlagsResult>>();
        pivotFlagsCache.set(highs, byLows);
    }
    let byKey = byLows.get(lows);
    if (!byKey) {
        byKey = new Map<string, PivotFlagsResult>();
        byLows.set(lows, byKey);
    }
    const cached = byKey.get(cacheKey);
    if (cached) return cached;

    const pivotHighs = new Array(length).fill(false);
    const pivotLows = new Array(length).fill(false);

    if (length === 0 || swingLength <= 0) {
        const result = { pivotHighs, pivotLows };
        byKey.set(cacheKey, result);
        return result;
    }

    for (let i = swingLength; i < length - swingLength; i++) {
        let isHigh = true;
        let isLow = true;
        const high = highs[i];
        const low = lows[i];

        for (let j = i - swingLength; j <= i + swingLength; j++) {
            if (j === i) continue;

            if (extremaMode === 'strict') {
                if (highs[j] >= high) isHigh = false;
                if (lows[j] <= low) isLow = false;
            } else {
                // Pine-like asymmetric ties: strict-left/non-strict-right.
                if (j < i) {
                    if (highs[j] > high) isHigh = false;
                    if (lows[j] < low) isLow = false;
                } else {
                    if (highs[j] >= high) isHigh = false;
                    if (lows[j] <= low) isLow = false;
                }
            }

            if (!isHigh && !isLow) break;
        }

        if (isHigh) pivotHighs[i] = true;
        if (isLow) pivotLows[i] = true;
    }

    const result = { pivotHighs, pivotLows };
    byKey.set(cacheKey, result);
    return result;
}
