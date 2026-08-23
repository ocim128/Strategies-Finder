import type { OHLCVData } from "../types/strategies";
import { timeToNumber } from "../strategies/backtest/backtest-utils";

export interface FinderAssetOpportunityFoldMetadata {
    foldEnd: number;
    searchWindowEnd: number | null;
    oosStart: number | null;
    oosEnd: number | null;
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
