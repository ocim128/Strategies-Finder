import { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { dataManager } from "../dataManager";
import { debugLogger } from "../debugLogger";
import type { AlignedPairData, AlignmentStats } from "./types";

function timeKey(time: Time): string {
    if (typeof time === 'number') return `n:${time}`;
    if (typeof time === 'string') return `s:${time}`;
    if (typeof time === 'object' && time && 'year' in time) {
        return `o:${time.year}-${time.month}-${time.day}`;
    }
    return String(time);
}

function computeSpread(primary: OHLCVData[], secondary: OHLCVData[]): number[] {
    const spread: number[] = [];
    for (let i = 0; i < primary.length; i++) {
        const p = primary[i].close;
        const s = secondary[i].close;
        const safeP = Math.max(1e-12, p);
        const safeS = Math.max(1e-12, s);
        spread.push(Math.log(safeP) - Math.log(safeS));
    }
    return spread;
}

function computeRatio(primary: OHLCVData[], secondary: OHLCVData[]): number[] {
    const ratio: number[] = [];
    for (let i = 0; i < primary.length; i++) {
        const p = primary[i].close;
        const s = secondary[i].close;
        ratio.push(s > 0 ? p / s : 0);
    }
    return ratio;
}

export function alignPairData(primaryData: OHLCVData[], secondaryData: OHLCVData[]): AlignedPairData {
    const secondaryMap = new Map<string, OHLCVData>();
    secondaryData.forEach(bar => secondaryMap.set(timeKey(bar.time), bar));

    const primaryAligned: OHLCVData[] = [];
    const secondaryAligned: OHLCVData[] = [];
    const alignedTimestamps: Time[] = [];

    for (const bar of primaryData) {
        const key = timeKey(bar.time);
        const secondaryBar = secondaryMap.get(key);
        if (!secondaryBar) continue;
        primaryAligned.push(bar);
        secondaryAligned.push(secondaryBar);
        alignedTimestamps.push(bar.time);
    }

    const spread = computeSpread(primaryAligned, secondaryAligned);
    const ratio = computeRatio(primaryAligned, secondaryAligned);
    const overlap = primaryAligned.length;
    const alignmentStats: AlignmentStats = {
        matchRate: overlap / Math.max(1, Math.min(primaryData.length, secondaryData.length)),
        primaryMissing: Math.max(0, primaryData.length - overlap),
        secondaryMissing: Math.max(0, secondaryData.length - overlap),
    };

    return {
        primary: primaryAligned,
        secondary: secondaryAligned,
        spread,
        ratio,
        alignedTimestamps,
        alignmentStats,
    };
}

export async function fetchAndAlignPairs(
    primary: { symbol: string; interval: string },
    secondary: { symbol: string; interval: string }
): Promise<AlignedPairData> {
    const [primaryData, secondaryData] = await Promise.all([
        dataManager.fetchData(primary.symbol, primary.interval),
        dataManager.fetchData(secondary.symbol, secondary.interval),
    ]);

    debugLogger.info('pairCombiner.fetch', {
        primary: primary.symbol,
        secondary: secondary.symbol,
        primaryBars: primaryData.length,
        secondaryBars: secondaryData.length,
    });

    return alignPairData(primaryData, secondaryData);
}
