import type { OHLCVData } from "../types/strategies";
import { timeToNumber } from "../strategies/backtest/backtest-utils";

export interface FinderAssetOpportunityFoldMetadata {
    foldEnd: number;
    searchWindowEnd: number | null;
    oosStart: number | null;
    oosEnd: number | null;
}

export const FINDER_ASSET_FRESH_FOLD_COUNT = 25;
export const FINDER_ASSET_FRESH_FOLD_STRIDE_BARS = 12;

export interface FinderAssetOpportunityFoldScheduleEntry {
    holdoutBars: number;
    foldEnd: number;
    oosStart: number;
    oosEnd: number;
}

export interface FinderAssetOpportunityFreshFoldWindow {
    oosStart: number;
    oosEnd: number;
}

function normalizeReferenceTimestamps(referenceTimestamps: readonly number[]): number[] {
    if (referenceTimestamps.length === 0) {
        throw new Error("Fresh-window reference series is empty.");
    }
    const timestamps = referenceTimestamps.map((value) => Number(value));
    for (let index = 0; index < timestamps.length; index += 1) {
        const timestamp = timestamps[index]!;
        if (!Number.isFinite(timestamp) || timestamp <= 0) {
            throw new Error(`Fresh-window reference timestamp ${index} is invalid.`);
        }
        if (index > 0 && timestamp <= timestamps[index - 1]!) {
            throw new Error("Fresh-window reference timestamps must be strictly ascending.");
        }
    }
    return timestamps;
}

/** Build folds from actual reference bars, preserving calendar gaps. */
export function buildFreshFoldScheduleFromDataEnd(
    referenceTimestamps: readonly number[],
    widestHorizonBars = 24,
): FinderAssetOpportunityFoldScheduleEntry[] {
    if (!Number.isInteger(widestHorizonBars) || widestHorizonBars <= 0) {
        throw new Error("Fresh-window widestHorizonBars must be a positive integer.");
    }
    const timestamps = normalizeReferenceTimestamps(referenceTimestamps);
    const forwardMarginBars = FINDER_ASSET_FRESH_FOLD_STRIDE_BARS + widestHorizonBars;
    const finalFoldIndex = timestamps.length - 1 - forwardMarginBars;
    const firstFoldIndex = finalFoldIndex
        - (FINDER_ASSET_FRESH_FOLD_COUNT - 1) * FINDER_ASSET_FRESH_FOLD_STRIDE_BARS;
    if (firstFoldIndex < 0) {
        const requiredBars = forwardMarginBars
            + 1
            + (FINDER_ASSET_FRESH_FOLD_COUNT - 1) * FINDER_ASSET_FRESH_FOLD_STRIDE_BARS;
        throw new Error(
            `Fresh-window reference series is too short: need at least ${requiredBars} bars `
            + `for ${FINDER_ASSET_FRESH_FOLD_COUNT} stride-spaced folds plus margins, got ${timestamps.length}.`,
        );
    }
    return Array.from({ length: FINDER_ASSET_FRESH_FOLD_COUNT }, (_, index) => {
        const foldIndex = firstFoldIndex + index * FINDER_ASSET_FRESH_FOLD_STRIDE_BARS;
        return {
            holdoutBars: (index + 1) * FINDER_ASSET_FRESH_FOLD_STRIDE_BARS,
            foldEnd: timestamps[foldIndex]!,
            oosStart: timestamps[foldIndex + 1]!,
            oosEnd: timestamps[foldIndex + FINDER_ASSET_FRESH_FOLD_STRIDE_BARS]!,
        };
    });
}

/** Resolve one fresh forward window from actual reference-bar order. */
export function getFinderAssetOpportunityFreshFoldWindow(
    referenceTimestamps: readonly number[],
    foldEnd: number,
): FinderAssetOpportunityFreshFoldWindow {
    const timestamps = normalizeReferenceTimestamps(referenceTimestamps);
    const foldIndex = timestamps.indexOf(foldEnd);
    if (foldIndex < 0) {
        throw new Error(`Fresh-window foldEnd ${foldEnd} is not present in the reference series.`);
    }
    if (foldIndex + FINDER_ASSET_FRESH_FOLD_STRIDE_BARS >= timestamps.length) {
        throw new Error("Fresh-window reference series has fewer than one stride of forward bars after foldEnd.");
    }
    return {
        oosStart: timestamps[foldIndex + 1]!,
        oosEnd: timestamps[foldIndex + FINDER_ASSET_FRESH_FOLD_STRIDE_BARS]!,
    };
}

/**
 * Parse the complete fresh-window schedule at the request boundary. The
 * holdout values are deliberately part of the payload rather than inferred
 * from a range so an archive can prove exactly which fold was evaluated.
 */
export function normalizeFinderAssetFreshFoldSchedule(
    value: unknown,
): FinderAssetOpportunityFoldScheduleEntry[] {
    if (!Array.isArray(value) || value.length !== FINDER_ASSET_FRESH_FOLD_COUNT) {
        throw new Error(
            `Fresh-window foldSchedule must contain exactly ${FINDER_ASSET_FRESH_FOLD_COUNT} entries.`,
        );
    }
    const schedule: FinderAssetOpportunityFoldScheduleEntry[] = [];
    let previousFoldEnd = 0;
    for (let index = 0; index < value.length; index += 1) {
        const raw = value[index];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error(`Fresh-window foldSchedule entry ${index} must be an object.`);
        }
        const record = raw as Record<string, unknown>;
        const holdoutBars = Number(record.holdoutBars);
        const expectedHoldoutBars = (index + 1) * FINDER_ASSET_FRESH_FOLD_STRIDE_BARS;
        if (!Number.isInteger(holdoutBars) || holdoutBars !== expectedHoldoutBars) {
            throw new Error(
                `Fresh-window foldSchedule entry ${index} must use holdoutBars ${expectedHoldoutBars}.`,
            );
        }
        const foldEnd = normalizeFinderAssetFoldEnd(record.foldEnd);
        if (foldEnd === undefined || foldEnd <= previousFoldEnd) {
            throw new Error(`Fresh-window foldSchedule entry ${index} foldEnd must be strictly ascending.`);
        }
        const oosStart = normalizeFinderAssetFoldEnd(record.oosStart);
        const oosEnd = normalizeFinderAssetFoldEnd(record.oosEnd);
        if (oosStart === undefined || oosEnd === undefined) {
            throw new Error(`Fresh-window foldSchedule entry ${index} must declare oosStart and oosEnd.`);
        }
        if (oosStart <= foldEnd || oosEnd < oosStart) {
            throw new Error(`Fresh-window foldSchedule entry ${index} has invalid OOS bounds.`);
        }
        previousFoldEnd = foldEnd;
        schedule.push({ holdoutBars, foldEnd, oosStart, oosEnd });
    }
    return schedule;
}

export function getFinderAssetDataBounds(data: OHLCVData[]): {
    first: number | null;
    last: number | null;
} {
    let first: number | null = null;
    let last: number | null = null;
    for (const candle of data) {
        const timestamp = timeToNumber(candle.time);
        if (timestamp === null) continue;
        if (first === null || timestamp < first) first = timestamp;
        if (last === null || timestamp > last) last = timestamp;
    }
    return { first, last };
}

export function normalizeFinderAssetFoldEnd(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const numeric = typeof value === "number" || typeof value === "string"
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) {
        throw new Error("Asset Opportunity foldEnd must be a positive finite timestamp.");
    }
    return numeric;
}

export function sliceFinderAssetDataAtFoldEnd(
    data: readonly OHLCVData[],
    foldEnd: number | undefined,
): OHLCVData[] {
    if (foldEnd === undefined) return data.slice();
    return data.filter((candle) => {
        const timestamp = timeToNumber(candle.time);
        return timestamp !== null && timestamp <= foldEnd;
    });
}

export function sliceFinderAssetDataStrictlyAfterFoldEnd(
    data: OHLCVData[],
    foldEnd: number | undefined,
    maxBars?: number,
): OHLCVData[] {
    if (foldEnd === undefined) return [];
    const forward = data.filter((candle) => {
        const timestamp = timeToNumber(candle.time);
        return timestamp !== null && timestamp > foldEnd;
    });
    return maxBars === undefined ? forward : forward.slice(0, maxBars);
}

/** Slice by the declared calendar window; missing calendar bars stay missing. */
export function sliceFinderAssetDataWithinFreshFoldWindow(
    data: readonly OHLCVData[],
    window: FinderAssetOpportunityFreshFoldWindow | undefined,
): OHLCVData[] {
    if (window === undefined) return [];
    return data.filter((candle) => {
        const timestamp = timeToNumber(candle.time);
        return timestamp !== null && timestamp >= window.oosStart && timestamp <= window.oosEnd;
    });
}

export function assertFinderAssetDataAtOrBeforeFoldEnd(
    data: readonly OHLCVData[],
    foldEnd: number | undefined,
    label: string,
): void {
    if (foldEnd === undefined) return;
    for (const candle of data) {
        const timestamp = timeToNumber(candle.time);
        if (timestamp === null) {
            throw new Error(`${label} contains a candle with an unusable timestamp.`);
        }
        if (timestamp > foldEnd) {
            throw new Error(`${label} contains data after foldEnd ${foldEnd}.`);
        }
    }
}

export function assertFinderAssetDataStrictlyAfterFoldEnd(
    data: readonly OHLCVData[],
    foldEnd: number | undefined,
    label: string,
): void {
    if (foldEnd === undefined) return;
    for (const candle of data) {
        const timestamp = timeToNumber(candle.time);
        if (timestamp === null || timestamp <= foldEnd) {
            throw new Error(`${label} contains data at or before foldEnd ${foldEnd}.`);
        }
    }
}
