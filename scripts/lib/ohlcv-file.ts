import { parseTimeToUnixSeconds } from "../../lib/time-normalization";
import type { OHLCVData } from "../../lib/types/strategies";

export type ParsedOhlcvDataFile = {
    bars: OHLCVData[];
    symbol: string | null;
    interval: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOhlcvBar(row: unknown): OHLCVData | null {
    if (Array.isArray(row)) {
        if (row.length < 5) return null;
        const time = parseTimeToUnixSeconds(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = row.length > 5 ? Number(row[5]) : 0;
        if (time === null) return null;
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
        return { time: time as OHLCVData["time"], open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
    }

    if (!isObject(row)) return null;
    const time = parseTimeToUnixSeconds(row.time ?? row.t ?? row.timestamp ?? row.date ?? row.datetime ?? row.start ?? row.openTime);
    const open = Number(row.open ?? row.o);
    const high = Number(row.high ?? row.h);
    const low = Number(row.low ?? row.l);
    const close = Number(row.close ?? row.c);
    const volume = Number(row.volume ?? row.v ?? 0);
    if (time === null) return null;
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
    return { time: time as OHLCVData["time"], open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

export function parseOhlcvBars(raw: unknown): OHLCVData[] {
    let rows: unknown[] = [];
    if (Array.isArray(raw)) {
        rows = raw;
    } else if (isObject(raw)) {
        if (Array.isArray(raw.data)) rows = raw.data;
        else if (Array.isArray(raw.ohlcv)) rows = raw.ohlcv;
        else if (Array.isArray(raw.candles)) rows = raw.candles;
    }

    const parsed = rows
        .map((row) => parseOhlcvBar(row))
        .filter((bar): bar is OHLCVData => Boolean(bar))
        .sort((a, b) => Number(a.time) - Number(b.time));

    const deduped: OHLCVData[] = [];
    for (const bar of parsed) {
        const last = deduped[deduped.length - 1];
        if (last && Number(last.time) === Number(bar.time)) {
            deduped[deduped.length - 1] = bar;
        } else {
            deduped.push(bar);
        }
    }
    return deduped;
}

export function parseOhlcvDataFile(raw: unknown): ParsedOhlcvDataFile {
    const symbol = isObject(raw) && typeof raw.symbol === "string" && raw.symbol.trim()
        ? raw.symbol.trim().toUpperCase()
        : null;
    const interval = isObject(raw) && typeof raw.interval === "string" && raw.interval.trim()
        ? raw.interval.trim()
        : null;
    return { bars: parseOhlcvBars(raw), symbol, interval };
}
