import type { OHLCVData } from "./types/index";
import { parseTimeToUnixSeconds } from "./time-normalization";
import {
    checkLocalApiAvailable,
    fetchLocalApi,
    markLocalApiUnavailable,
    resetLocalApiAvailability,
} from "./local-api-transport";

const AVAILABILITY_CACHE_MS = 60000;
const SQLITE_REQUEST_TIMEOUT_MS = 8000;
const SQLITE_INGEST_TIMEOUT_MS = 180000;
const SQLITE_API_AVAILABILITY_KEY = "sqlite";
const OHLCV_BINARY_MAGIC = 0x4F484C56;
const OHLCV_BINARY_VERSION = 1;
const OHLCV_BINARY_FIELD_COUNT = 6;
const OHLCV_BINARY_HEADER_BYTES = 16;
const OHLCV_BINARY_STORE_MIN_ROWS = 1024;

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
    return parseTimeToUnixSeconds(value);
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

function markSqliteApiUnavailable(): void {
    markLocalApiUnavailable(SQLITE_API_AVAILABILITY_KEY);
}

function handleLoadFailureStatus(response: Response): void {
    if (response.status === 404 || response.status >= 500) {
        markSqliteApiUnavailable();
    }
}

function parseJsonCandleRows(rows: unknown[]): OHLCVData[] {
    const candles: OHLCVData[] = [];
    for (const row of rows) {
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
            time: parsedTime as OHLCVData['time'],
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
        });
    }
    return candles;
}

function decodeBinaryCandles(buffer: ArrayBuffer): OHLCVData[] | null {
    if (buffer.byteLength < OHLCV_BINARY_HEADER_BYTES) return null;

    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const rowCount = view.getUint32(8, true);
    const fieldCount = view.getUint32(12, true);
    const expectedBytes = OHLCV_BINARY_HEADER_BYTES + rowCount * fieldCount * Float64Array.BYTES_PER_ELEMENT;

    if (
        magic !== OHLCV_BINARY_MAGIC
        || version !== OHLCV_BINARY_VERSION
        || fieldCount !== OHLCV_BINARY_FIELD_COUNT
        || buffer.byteLength !== expectedBytes
    ) {
        return null;
    }

    const candles: OHLCVData[] = [];
    const columnBytes = rowCount * Float64Array.BYTES_PER_ELEMENT;
    for (let i = 0; i < rowCount; i++) {
        const offset = OHLCV_BINARY_HEADER_BYTES + i * Float64Array.BYTES_PER_ELEMENT;
        const time = view.getFloat64(offset, true);
        const open = view.getFloat64(offset + columnBytes, true);
        const high = view.getFloat64(offset + 2 * columnBytes, true);
        const low = view.getFloat64(offset + 3 * columnBytes, true);
        const close = view.getFloat64(offset + 4 * columnBytes, true);
        const volume = view.getFloat64(offset + 5 * columnBytes, true);
        if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
            return null;
        }
        candles.push({
            time: time as OHLCVData['time'],
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
        });
    }
    return candles;
}

function encodeBinaryCandles(
    rows: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>
): ArrayBuffer {
    const rowCount = rows.length;
    const buffer = new ArrayBuffer(OHLCV_BINARY_HEADER_BYTES + OHLCV_BINARY_FIELD_COUNT * rowCount * Float64Array.BYTES_PER_ELEMENT);
    const view = new DataView(buffer);
    const columnBytes = rowCount * Float64Array.BYTES_PER_ELEMENT;

    view.setUint32(0, OHLCV_BINARY_MAGIC, true);
    view.setUint32(4, OHLCV_BINARY_VERSION, true);
    view.setUint32(8, rowCount, true);
    view.setUint32(12, OHLCV_BINARY_FIELD_COUNT, true);

    for (let i = 0; i < rowCount; i++) {
        const row = rows[i];
        const offset = OHLCV_BINARY_HEADER_BYTES + i * Float64Array.BYTES_PER_ELEMENT;
        view.setFloat64(offset, row.time, true);
        view.setFloat64(offset + columnBytes, row.open, true);
        view.setFloat64(offset + 2 * columnBytes, row.high, true);
        view.setFloat64(offset + 3 * columnBytes, row.low, true);
        view.setFloat64(offset + 4 * columnBytes, row.close, true);
        view.setFloat64(offset + 5 * columnBytes, row.volume, true);
    }

    return buffer;
}

async function parseJsonLoadResponse(response: Response): Promise<{ candles: OHLCVData[]; trusted: boolean } | null> {
    const payload = await response.json() as { ok?: boolean; candles?: unknown[] };
    if (!payload?.ok || !Array.isArray(payload.candles)) return null;
    return { candles: parseJsonCandleRows(payload.candles), trusted: true };
}

async function loadSqliteCandlesJson(query: URLSearchParams): Promise<{ candles: OHLCVData[]; trusted: boolean } | null> {
    const response = await fetchLocalApi(`/api/sqlite/load-ohlcv?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
    }, SQLITE_REQUEST_TIMEOUT_MS);
    if (!response.ok) {
        handleLoadFailureStatus(response);
        return null;
    }
    return parseJsonLoadResponse(response);
}

async function checkSqliteApiAvailable(force = false): Promise<boolean> {
    return checkLocalApiAvailable({
        key: SQLITE_API_AVAILABILITY_KEY,
        statusUrl: '/api/sqlite/status',
        force,
        cacheMs: AVAILABILITY_CACHE_MS,
        timeoutMs: SQLITE_REQUEST_TIMEOUT_MS,
    });
}

export async function loadSqliteCandles(
    symbol: string,
    interval: string,
    limit = 50000
): Promise<{ candles: OHLCVData[]; trusted: boolean } | null> {
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
        const response = await fetchLocalApi(`/api/sqlite/load-ohlcv?${query.toString()}`, {
            method: 'GET',
            headers: { Accept: 'application/octet-stream' },
        }, SQLITE_REQUEST_TIMEOUT_MS);
        if (!response.ok) {
            handleLoadFailureStatus(response);
            return null;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/octet-stream')) {
            const candles = decodeBinaryCandles(await response.arrayBuffer());
            if (candles) {
                return { candles, trusted: true };
            }
            return loadSqliteCandlesJson(query);
        }

        if (contentType.includes('application/json')) {
            return parseJsonLoadResponse(response);
        }

        return loadSqliteCandlesJson(query);
    } catch {
        markSqliteApiUnavailable();
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

    const postJson = async (): Promise<StoreSqliteResponse | null> => {
        const response = await fetchLocalApi('/api/sqlite/store-ohlcv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: normalizeSymbol(symbol),
                interval: normalizeInterval(interval),
                provider,
                source,
                candles: normalizedRows,
            }),
        }, SQLITE_INGEST_TIMEOUT_MS);

        const payload = await response.json() as StoreSqliteResponse;
        if (!response.ok || !payload?.ok) {
            return { ok: false, error: payload?.error || `Store request failed (${response.status})` };
        }
        return payload;
    };

    const postBinary = async (): Promise<StoreSqliteResponse | null> => {
        const query = new URLSearchParams({
            symbol: normalizeSymbol(symbol),
            interval: normalizeInterval(interval),
            provider,
            source,
        });
        const response = await fetchLocalApi(`/api/sqlite/store-ohlcv?${query.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: encodeBinaryCandles(normalizedRows),
        }, SQLITE_INGEST_TIMEOUT_MS);
        const payload = await response.json().catch(() => null) as StoreSqliteResponse | null;
        if (!response.ok || !payload?.ok) {
            return { ok: false, error: payload?.error || `Store request failed (${response.status})` };
        }
        return payload;
    };

    try {
        if (normalizedRows.length >= OHLCV_BINARY_STORE_MIN_ROWS) {
            const binaryResult = await postBinary().catch(() => null);
            if (binaryResult?.ok) {
                return binaryResult;
            }
        }
        return await postJson();
    } catch {
        markSqliteApiUnavailable();
        return null;
    }
}

export function resetLocalSqliteApiAvailabilityForTests(): void {
    resetLocalApiAvailability(SQLITE_API_AVAILABILITY_KEY);
}
