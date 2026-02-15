import { Signal, OHLCVData, Time } from '../types/strategies';

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
const _c = new WeakMap<OHLCVData[], number[]>();
const _v = new WeakMap<OHLCVData[], number[]>();

export const getHighs = (data: OHLCVData[]): number[] => getMemoized(_h, data, d => d.high);
export const getLows = (data: OHLCVData[]): number[] => getMemoized(_l, data, d => d.low);
export const getCloses = (data: OHLCVData[]): number[] => getMemoized(_c, data, d => d.close);
export const getVolumes = (data: OHLCVData[]): number[] => getMemoized(_v, data, d => d.volume);

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
    /**
     * Optional bar index when the pivot becomes confirmable without look-ahead.
     * For centered-window pivots this is typically index + halfDepth.
     */
    confirmationIndex?: number;
}

export type PivotExtremaMode = 'strict' | 'pine';

export interface DetectPivotsOptions {
    depth: number;
    deviationThreshold: number | number[];
    extremaMode?: PivotExtremaMode;
    includeConfirmationIndex?: boolean;
    /**
     * Inclusive means deviation >= threshold confirms reversal.
     * Exclusive means deviation > threshold confirms reversal.
     */
    deviationInclusive?: boolean;
}

export function buildPivotFlags(
    highs: number[],
    lows: number[],
    swingLength: number,
    extremaMode: PivotExtremaMode = 'strict'
): { pivotHighs: boolean[]; pivotLows: boolean[] } {
    const length = highs.length;
    const pivotHighs = new Array(length).fill(false);
    const pivotLows = new Array(length).fill(false);

    if (length === 0 || swingLength <= 0) {
        return { pivotHighs, pivotLows };
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

    return { pivotHighs, pivotLows };
}

export function detectPivots(
    data: OHLCVData[],
    options: DetectPivotsOptions
): Pivot[] {
    const pivots: Pivot[] = [];
    if (data.length === 0) return pivots;

    const highs = getHighs(data);
    const lows = getLows(data);
    const halfDepth = Math.floor(options.depth / 2);
    if (halfDepth <= 0 || data.length < (halfDepth * 2 + 1)) return pivots;

    const extremaMode = options.extremaMode ?? 'strict';
    const includeConfirmationIndex = options.includeConfirmationIndex === true;
    const deviationInclusive = options.deviationInclusive !== false;
    const thresholds = options.deviationThreshold;
    const thresholdAt = (index: number): number => {
        if (Array.isArray(thresholds)) return thresholds[index] ?? 0;
        return thresholds;
    };

    const { pivotHighs, pivotLows } = buildPivotFlags(highs, lows, halfDepth, extremaMode);

    const candidates: Pivot[] = [];
    for (let i = halfDepth; i < data.length - halfDepth; i++) {
        if (pivotHighs[i]) {
            candidates.push({
                index: i,
                price: highs[i],
                isHigh: true,
                time: data[i].time,
                confirmationIndex: includeConfirmationIndex ? i + halfDepth : undefined
            });
        }
        if (pivotLows[i]) {
            candidates.push({
                index: i,
                price: lows[i],
                isHigh: false,
                time: data[i].time,
                confirmationIndex: includeConfirmationIndex ? i + halfDepth : undefined
            });
        }
    }

    candidates.sort((a, b) => a.index - b.index);
    if (candidates.length === 0) return pivots;

    let lastPivot = candidates[0];
    pivots.push(lastPivot);

    for (const cand of candidates) {
        if (cand.index <= lastPivot.index) continue;

        const dev = Math.abs((cand.price - lastPivot.price) / lastPivot.price) * 100;
        const threshold = thresholdAt(cand.index);

        if (lastPivot.isHigh === cand.isHigh) {
            if ((cand.isHigh && cand.price > lastPivot.price) || (!cand.isHigh && cand.price < lastPivot.price)) {
                lastPivot = cand;
                pivots[pivots.length - 1] = lastPivot;
            }
            continue;
        }

        const passesThreshold = deviationInclusive ? dev >= threshold : dev > threshold;
        if (passesThreshold) {
            lastPivot = cand;
            pivots.push(lastPivot);
        }
    }

    return pivots;
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
    return detectPivots(data, {
        depth,
        deviationThreshold: deviationPercent,
        extremaMode: 'pine',
        includeConfirmationIndex: false,
        deviationInclusive: true
    });
}


