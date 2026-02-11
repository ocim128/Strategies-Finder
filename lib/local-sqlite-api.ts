import type { OHLCVData } from "./types/index";

const AVAILABILITY_CACHE_MS = 60000;
let sqliteApiAvailable: boolean | null = null;
let sqliteApiCheckedAt = 0;

type StoreSqliteResponse = {
    ok: boolean;
    upserted?: number;
    totalBars?: number;
    dbPath?: string;
    error?: string;
};

function normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
}

function normalizeInterval(interval: string): string {
    return interval.trim().toLowerCase();
}

function toUnixSeconds(value: unknown): number | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        if (value > 1e12) return Math.floor(value / 1000);
        return Math.floor(value);
    }
    if (typeof value === 'string') {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return toUnixSeconds(numeric);
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
    return null;
}

function toStoreRow(candle: OHLCVData): { time: number; open: number; high: number; low: number; close: number; volume: number } | null {
    const time = toUnixSeconds(candle.time);
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume ?? 0);

    if (!Number.isFinite(time) || time === null) return null;
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;

    return {
        time,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
    };
}

async function checkSqliteApiAvailable(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && sqliteApiAvailable !== null && now - sqliteApiCheckedAt < AVAILABILITY_CACHE_MS) {
        return sqliteApiAvailable;
    }

    try {
        const response = await fetch('/api/sqlite/status', { method: 'GET' });
        sqliteApiAvailable = response.ok;
    } catch {
        sqliteApiAvailable = false;
    }
    sqliteApiCheckedAt = now;
    return sqliteApiAvailable;
}

export async function loadSqliteCandles(
    symbol: string,
    interval: string,
    limit = 50000
): Promise<OHLCVData[] | null> {
    const available = await checkSqliteApiAvailable();
    if (!available) return null;

    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeInterval(interval);
    const safeLimit = Math.max(1, Math.min(500000, Math.floor(limit)));
    const query = new URLSearchParams({
        symbol: normalizedSymbol,
        interval: normalizedInterval,
        limit: String(safeLimit),
    });

    try {
        const response = await fetch(`/api/sqlite/load-ohlcv?${query.toString()}`, { method: 'GET' });
        if (!response.ok) {
            if (response.status === 404 || response.status >= 500) {
                sqliteApiAvailable = false;
                sqliteApiCheckedAt = Date.now();
            }
            return null;
        }
        const payload = await response.json() as { ok?: boolean; candles?: unknown[] };
        if (!payload?.ok || !Array.isArray(payload.candles)) return null;

        const candles: OHLCVData[] = [];
        for (const row of payload.candles) {
            if (!row || typeof row !== 'object') continue;
            const value = row as Record<string, unknown>;
            const parsedTime = toUnixSeconds(value.time);
            const open = Number(value.open);
            const high = Number(value.high);
            const low = Number(value.low);
            const close = Number(value.close);
            const volume = Number(value.volume ?? 0);
            if (!Number.isFinite(parsedTime) || parsedTime === null) continue;
            if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
            candles.push({
                time: parsedTime as any,
                open,
                high,
                low,
                close,
                volume: Number.isFinite(volume) ? volume : 0,
            });
        }

        return candles;
    } catch {
        sqliteApiAvailable = false;
        sqliteApiCheckedAt = Date.now();
        return null;
    }
}

export async function storeSqliteCandles(
    symbol: string,
    interval: string,
    candles: OHLCVData[],
    provider = 'Binance',
    source = 'manual'
): Promise<StoreSqliteResponse | null> {
    if (!candles.length) {
        return { ok: true, upserted: 0 };
    }

    const available = await checkSqliteApiAvailable();
    if (!available) return null;

    const normalizedRows = candles
        .map(toStoreRow)
        .filter((row): row is NonNullable<ReturnType<typeof toStoreRow>> => !!row);
    if (normalizedRows.length === 0) {
        return { ok: false, error: 'No valid candles to store.' };
    }

    try {
        const response = await fetch('/api/sqlite/store-ohlcv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: normalizeSymbol(symbol),
                interval: normalizeInterval(interval),
                provider,
                source,
                candles: normalizedRows,
            }),
        });

        const payload = await response.json() as StoreSqliteResponse;
        if (!response.ok || !payload?.ok) {
            return { ok: false, error: payload?.error || `Store request failed (${response.status})` };
        }
        return payload;
    } catch {
        sqliteApiAvailable = false;
        sqliteApiCheckedAt = Date.now();
        return null;
    }
}

