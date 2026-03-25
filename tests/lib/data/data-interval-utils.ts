import { getIntervalSeconds } from "../dataProviders/utils";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/index";
import type { TwoHourCloseParity } from "../strategies/resample-utils";

export function getImportStorageIntervals(interval: string): string[] {
    if (interval.includes("@close-")) {
        return [interval];
    }
    if (getIntervalSeconds(interval) === 7200) {
        return [`${interval}@close-odd`, `${interval}@close-even`];
    }
    return [interval];
}

export function getStorageInterval(interval: string, parity: TwoHourCloseParity): string {
    const normalized = interval.trim().toLowerCase();
    if (normalized.includes("@close-")) {
        return normalized;
    }
    if (getIntervalSeconds(normalized) === 7200) {
        return `${normalized}@close-${parity}`;
    }
    return normalized;
}

export function takeLastCandles(candles: OHLCVData[], limit: number): OHLCVData[] {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit <= 0) {
        return [];
    }
    return candles.length > normalizedLimit ? candles.slice(-normalizedLimit) : candles;
}

export function sliceCandlesToLookback(candles: OHLCVData[], lookbackBars: number | null): OHLCVData[] {
    return typeof lookbackBars === "number" ? takeLastCandles(candles, lookbackBars) : candles;
}

export function estimateBybitSeedOverlayBars(
    interval: string,
    seedData: OHLCVData[],
    nowSec = Math.floor(Date.now() / 1000)
): number {
    const intervalSeconds = getIntervalSeconds(interval);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        return 30;
    }

    const lastSeedTime = seedData.length > 0
        ? parseTimeToUnixSeconds(seedData[seedData.length - 1].time)
        : null;
    if (lastSeedTime === null) {
        return 30;
    }

    const gapSec = Math.max(0, nowSec - lastSeedTime);
    const estimatedGapBars = Math.ceil(gapSec / intervalSeconds);
    return Math.max(12, Math.min(240, estimatedGapBars + 10));
}

export function getIntervalAlignment(interval: string): { intervalSeconds: number; phaseOffsetSeconds: number } | null {
    const normalized = interval.trim().toLowerCase();
    const baseInterval = normalized.split("@")[0];
    const intervalSeconds = getIntervalSeconds(baseInterval);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        return null;
    }

    if (intervalSeconds > 86400) {
        return null;
    }

    const phaseOffsetSeconds = intervalSeconds === 7200 && normalized.includes("@close-even")
        ? 3600
        : 0;
    return { intervalSeconds, phaseOffsetSeconds };
}

export function isIntervalAlignedTime(timeSec: number, interval: string): boolean {
    if (!Number.isFinite(timeSec)) return false;
    const alignment = getIntervalAlignment(interval);
    if (!alignment) return true;

    const { intervalSeconds, phaseOffsetSeconds } = alignment;
    const remainder = ((timeSec - phaseOffsetSeconds) % intervalSeconds + intervalSeconds) % intervalSeconds;
    return remainder === 0;
}
