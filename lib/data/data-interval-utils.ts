import { getIntervalSeconds } from "../dataProviders/utils";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/index";

function normalizeStorageInterval(interval: string): string {
    return interval.trim().toLowerCase().replace(/@close-(odd|even)$/, "");
}

export function getImportStorageIntervals(interval: string): string[] {
    return [normalizeStorageInterval(interval)];
}

export function getStorageInterval(interval: string): string {
    return normalizeStorageInterval(interval);
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
    const normalized = normalizeStorageInterval(interval);
    const baseInterval = normalized.split("@")[0];
    const intervalSeconds = getIntervalSeconds(baseInterval);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        return null;
    }

    if (intervalSeconds > 86400) {
        return null;
    }
    return { intervalSeconds, phaseOffsetSeconds: 0 };
}

export function isIntervalAlignedTime(timeSec: number, interval: string): boolean {
    if (!Number.isFinite(timeSec)) return false;
    const alignment = getIntervalAlignment(interval);
    if (!alignment) return true;

    const { intervalSeconds, phaseOffsetSeconds } = alignment;
    const remainder = ((timeSec - phaseOffsetSeconds) % intervalSeconds + intervalSeconds) % intervalSeconds;
    return remainder === 0;
}
