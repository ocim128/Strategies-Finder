/**
 * Cross-symbol alignment and derived-series helpers.
 *
 * These are pure, stateless functions that operate on already-fetched OHLCV
 * arrays. The runtime resolver (`lib/cross-symbol-runtime.ts`) is responsible
 * for fetching data and calling these helpers.
 */

import type { OHLCVData } from '../../types/strategies';
import { timeToNumber } from '../backtest/backtest-utils';

// ============================================================================
// Alignment
// ============================================================================

/**
 * Align a secondary OHLCV array to a primary array using causal LOCF
 * (Last Observation Carried Forward).
 *
 * Rules:
 * 1. Output length equals `primary.length`.
 * 2. For primary time T, matched secondary bar satisfies `secondary.time <= T`.
 * 3. Never looks forward to `secondary.time > T`.
 * 4. If no prior secondary bar exists yet, output `null`.
 * 5. Uses existing repo time helpers (`timeToNumber`, `toTimeKey`).
 */
export function alignSecondaryToPrimary(
    primary: OHLCVData[],
    secondary: OHLCVData[]
): (OHLCVData | null)[] {
    if (primary.length === 0) return [];
    if (secondary.length === 0) return new Array(primary.length).fill(null);

    // Convert secondary times to numeric for comparison.
    const secondaryNumeric: { time: number; bar: OHLCVData }[] = [];
    for (const bar of secondary) {
        const t = timeToNumber(bar.time);
        if (t !== null) {
            secondaryNumeric.push({ time: t, bar });
        }
    }

    // Sort secondary by time ascending (should already be sorted, but be safe).
    secondaryNumeric.sort((a, b) => a.time - b.time);

    const aligned: (OHLCVData | null)[] = new Array(primary.length);
    let secIdx = 0;

    for (let i = 0; i < primary.length; i++) {
        const primaryTime = timeToNumber(primary[i].time);
        if (primaryTime === null) {
            // Cannot compare — carry forward whatever we have.
            aligned[i] = secIdx > 0 ? secondaryNumeric[secIdx - 1].bar : null;
            continue;
        }

        // Advance secIdx to the last secondary bar with time <= primaryTime.
        while (
            secIdx < secondaryNumeric.length &&
            secondaryNumeric[secIdx].time <= primaryTime
        ) {
            secIdx++;
        }

        // secIdx now points one past the last valid bar.
        aligned[i] = secIdx > 0 ? secondaryNumeric[secIdx - 1].bar : null;
    }

    return aligned;
}

// ============================================================================
// Trimming
// ============================================================================

export interface TrimmedAlignedPair {
    primaryData: OHLCVData[];
    secondaryData: OHLCVData[];
    trimmedLeadingBars: number;
}

/**
 * Trim the leading prefix where the aligned secondary is still `null`.
 *
 * After trimming:
 * - `primaryData.length === secondaryData.length`
 * - Neither array contains `null`
 * - Signals still carry original primary timestamps
 *
 * @throws Error if remaining length is below `minBars`.
 */
export function trimAlignedPair(
    primary: OHLCVData[],
    alignedSecondary: (OHLCVData | null)[],
    minBars: number = 50
): TrimmedAlignedPair {
    let firstValidIndex = -1;
    for (let i = 0; i < alignedSecondary.length; i++) {
        if (alignedSecondary[i] !== null) {
            firstValidIndex = i;
            break;
        }
    }

    if (firstValidIndex === -1) {
        throw new CrossSymbolAlignmentError(
            'No overlapping bars between primary and secondary symbol data.'
        );
    }

    const trimmedLength = primary.length - firstValidIndex;
    if (trimmedLength < minBars) {
        throw new CrossSymbolAlignmentError(
            `Only ${trimmedLength} aligned bars available, but at least ${minBars} are required.`
        );
    }

    const primaryData = primary.slice(firstValidIndex);
    const secondaryData: OHLCVData[] = new Array(trimmedLength);
    for (let i = 0; i < trimmedLength; i++) {
        // After trimming, all entries are guaranteed non-null.
        secondaryData[i] = alignedSecondary[firstValidIndex + i]!;
    }

    return {
        primaryData,
        secondaryData,
        trimmedLeadingBars: firstValidIndex,
    };
}

// ============================================================================
// Derived series helpers
// ============================================================================

/**
 * Build a relative strength series: `primary[i] / secondary[i]`.
 * Returns NaN where secondary close is zero.
 */
export function buildRelativeStrength(
    primaryCloses: number[],
    secondaryCloses: number[]
): number[] {
    const len = Math.min(primaryCloses.length, secondaryCloses.length);
    const result = new Array<number>(len);
    for (let i = 0; i < len; i++) {
        result[i] = secondaryCloses[i] !== 0
            ? primaryCloses[i] / secondaryCloses[i]
            : NaN;
    }
    return result;
}

/**
 * Build a pair spread series: `primary[i] - secondary[i]`.
 */
export function buildPairSpread(
    primaryCloses: number[],
    secondaryCloses: number[]
): number[] {
    const len = Math.min(primaryCloses.length, secondaryCloses.length);
    const result = new Array<number>(len);
    for (let i = 0; i < len; i++) {
        result[i] = primaryCloses[i] - secondaryCloses[i];
    }
    return result;
}

/**
 * Build a rolling Pearson correlation between two close series.
 * Returns `null` for the first `lookback - 1` bars.
 */
export function buildRollingPairCorrelation(
    primaryCloses: number[],
    secondaryCloses: number[],
    lookback: number
): (number | null)[] {
    const len = Math.min(primaryCloses.length, secondaryCloses.length);
    const result: (number | null)[] = new Array(len);

    for (let i = 0; i < len; i++) {
        if (i < lookback - 1) {
            result[i] = null;
            continue;
        }

        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
            const x = primaryCloses[j];
            const y = secondaryCloses[j];
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumX2 += x * x;
            sumY2 += y * y;
        }

        const n = lookback;
        const numerator = n * sumXY - sumX * sumY;
        const denominator = Math.sqrt(
            (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
        );

        result[i] = denominator !== 0 ? numerator / denominator : 0;
    }

    return result;
}

/**
 * Build a rolling relative volume strength:
 * `(primaryVol / rollingMeanPrimaryVol) / (secondaryVol / rollingMeanSecondaryVol)`.
 * Returns `null` for the first `lookback - 1` bars or when means are zero.
 */
export function buildRelativeVolumeStrength(
    primaryVolumes: number[],
    secondaryVolumes: number[],
    lookback: number
): (number | null)[] {
    const len = Math.min(primaryVolumes.length, secondaryVolumes.length);
    const result: (number | null)[] = new Array(len);

    // Running sums for efficiency.
    let sumP = 0;
    let sumS = 0;

    for (let i = 0; i < len; i++) {
        sumP += primaryVolumes[i];
        sumS += secondaryVolumes[i];

        if (i >= lookback) {
            sumP -= primaryVolumes[i - lookback];
            sumS -= secondaryVolumes[i - lookback];
        }

        if (i < lookback - 1) {
            result[i] = null;
            continue;
        }

        const meanP = sumP / lookback;
        const meanS = sumS / lookback;

        if (meanP === 0 || meanS === 0) {
            result[i] = null;
            continue;
        }

        const relP = primaryVolumes[i] / meanP;
        const relS = secondaryVolumes[i] / meanS;

        result[i] = relS !== 0 ? relP / relS : null;
    }

    return result;
}

// ============================================================================
// Error type
// ============================================================================

export class CrossSymbolAlignmentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CrossSymbolAlignmentError';
    }
}
