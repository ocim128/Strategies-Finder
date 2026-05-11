import { getIntervalSeconds } from "../dataProviders/utils";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/index";

const TRADFI_DAILY_ROLLOVER_HOUR_UTC = 20;
const TRADFI_DAILY_ROLLOVER_OFFSET_SECONDS = 6 * 60 * 60;

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

export function normalizeTradFiDailySessionTime(value: unknown): number | null {
    const timeSec = parseTimeToUnixSeconds(value);
    if (timeSec === null) return null;

    const original = new Date(timeSec * 1000);
    const sessionTimeSec = original.getUTCHours() >= TRADFI_DAILY_ROLLOVER_HOUR_UTC
        ? timeSec + TRADFI_DAILY_ROLLOVER_OFFSET_SECONDS
        : timeSec;
    const sessionDate = new Date(sessionTimeSec * 1000);

    return Math.floor(Date.UTC(
        sessionDate.getUTCFullYear(),
        sessionDate.getUTCMonth(),
        sessionDate.getUTCDate()
    ) / 1000);
}

export function normalizeTradFiDailyCandles(candles: OHLCVData[], interval: string): OHLCVData[] {
    const normalizedInterval = normalizeStorageInterval(interval).split("@")[0];
    if (normalizedInterval !== "1d") {
        return candles;
    }

    const normalized = candles
        .map((candle): OHLCVData | null => {
            const time = normalizeTradFiDailySessionTime(candle.time);
            return time === null
                ? null
                : { ...candle, time: time as OHLCVData["time"] };
        })
        .filter((candle): candle is OHLCVData => candle !== null)
        .sort((a, b) => Number(a.time) - Number(b.time));

    const deduped: OHLCVData[] = [];
    for (const candle of normalized) {
        const last = deduped[deduped.length - 1];
        if (last && Number(last.time) === Number(candle.time)) {
            deduped[deduped.length - 1] = candle;
        } else {
            deduped.push(candle);
        }
    }

    return deduped;
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
