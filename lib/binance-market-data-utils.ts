import { parseIntervalSeconds } from "./interval-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { OHLCVData } from "./types/strategies";

export const BINANCE_INTERVALS = new Set([
    "1s", "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w", "1M",
]);

type RawCandleLike = {
    time: unknown;
    open: unknown;
    high: unknown;
    low: unknown;
    close: unknown;
    volume: unknown;
};

function parseNumeric(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

export function normalizeOhlcvCandles(input: readonly RawCandleLike[]): OHLCVData[] {
    const deduped = new Map<number, OHLCVData>();

    for (const row of input) {
        const timeSec = parseTimeToUnixSeconds(row.time);
        const open = parseNumeric(row.open);
        const high = parseNumeric(row.high);
        const low = parseNumeric(row.low);
        const close = parseNumeric(row.close);
        const volume = parseNumeric(row.volume);

        if (
            timeSec === null ||
            open === null ||
            high === null ||
            low === null ||
            close === null ||
            volume === null
        ) {
            continue;
        }

        deduped.set(timeSec, {
            time: timeSec as OHLCVData["time"],
            open,
            high,
            low,
            close,
            volume,
        });
    }

    return Array.from(deduped.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, candle]) => candle);
}

export function intervalToSeconds(interval: string): number | null {
    return parseIntervalSeconds(interval);
}

function isMexcBase(base: string): boolean {
    try {
        return new URL(base).hostname.toLowerCase() === "api.mexc.com";
    } catch {
        return base.toLowerCase().includes("api.mexc.com");
    }
}

export function translateIntervalForApiBase(base: string, interval: string): string | null {
    if (!isMexcBase(base)) return interval;

    const mexcMap: Record<string, string | null> = {
        "1m": "1m",
        "3m": null,
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "60m",
        "2h": null,
        "4h": "4h",
        "6h": null,
        "8h": "8h",
        "12h": null,
        "1d": "1d",
        "3d": null,
        "1w": null,
        "1M": "1M",
    };

    return mexcMap[interval] ?? null;
}

function getResampleBucketStart(timeSec: number, intervalSec: number): number {
    return Math.floor(timeSec / intervalSec) * intervalSec;
}

export function resampleCandles(
    candles: OHLCVData[],
    targetInterval: string,
    sourceIntervalSec?: number
): OHLCVData[] {
    if (candles.length === 0) return [];
    const targetSec = intervalToSeconds(targetInterval);
    if (!targetSec || targetSec <= 0) return candles;

    const sourceSec = candles.length > 1
        ? Math.max(1, Number(candles[1].time) - Number(candles[0].time))
        : (sourceIntervalSec ?? targetSec);
    if (targetSec <= sourceSec) return candles;

    const out: OHLCVData[] = [];
    let current: OHLCVData | null = null;
    let bucketStart = Number.NaN;

    for (const row of candles) {
        const t = Number(row.time);
        if (!Number.isFinite(t)) continue;
        const nextBucket = getResampleBucketStart(t, targetSec);
        if (!current || nextBucket !== bucketStart) {
            if (current) out.push(current);
            current = {
                time: nextBucket as OHLCVData["time"],
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
            };
            bucketStart = nextBucket;
            continue;
        }

        current.high = Math.max(current.high, row.high);
        current.low = Math.min(current.low, row.low);
        current.close = row.close;
        current.volume += row.volume;
    }

    if (current) out.push(current);
    return out;
}

export function toBinanceInterval(interval: string): string | null {
    const trimmed = interval.trim();
    if (BINANCE_INTERVALS.has(trimmed)) return trimmed;

    const minutesMatch = /^(\d+)m$/.exec(trimmed);
    if (minutesMatch) {
        const mins = Number(minutesMatch[1]);
        const map: Record<number, string> = {
            1: "1m",
            3: "3m",
            5: "5m",
            15: "15m",
            30: "30m",
            60: "1h",
            120: "2h",
            240: "4h",
            360: "6h",
            480: "8h",
            720: "12h",
            1440: "1d",
            4320: "3d",
            10080: "1w",
        };
        return map[mins] ?? null;
    }

    const secondsMatch = /^(\d+)s$/.exec(trimmed);
    if (secondsMatch) {
        const seconds = Number(secondsMatch[1]);
        return seconds === 1 ? "1s" : null;
    }

    const hoursMatch = /^(\d+)h$/.exec(trimmed);
    if (hoursMatch) {
        const hours = Number(hoursMatch[1]);
        const map: Record<number, string> = {
            1: "1h",
            2: "2h",
            4: "4h",
            6: "6h",
            8: "8h",
            12: "12h",
            24: "1d",
            72: "3d",
            168: "1w",
        };
        return map[hours] ?? null;
    }

    return null;
}
