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
        previousFoldEnd = foldEnd;
        schedule.push({ holdoutBars, foldEnd });
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
): OHLCVData[] {
    if (foldEnd === undefined) return [];
    return data.filter((candle) => {
        const timestamp = timeToNumber(candle.time);
        return timestamp !== null && timestamp > foldEnd;
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
