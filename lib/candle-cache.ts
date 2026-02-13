import { Time } from "lightweight-charts";
import type { OHLCVData } from "./types/index";
import { debugLogger } from "./debug-logger";
import { parseTimeToUnixSeconds } from "./time-normalization";

const DB_NAME = 'strategies-finder-candles';
const STORE_NAME = 'series';
const DB_VERSION = 1;
const MAX_CANDLES_PER_SERIES = 50000;

type CandleCacheSource =
    | 'seed-file'
    | 'binance-full'
    | 'binance-gap'
    | 'stream'
    | 'manual';

type CandleSeriesRecord = {
    key: string;
    symbol: string;
    interval: string;
    candles: OHLCVData[];
    updatedAt: number;
    source: CandleCacheSource | string;
};

export type CachedCandles = {
    candles: OHLCVData[];
    updatedAt: number;
    source: CandleCacheSource | string;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;
const missingSeedFiles = new Set<string>();

function toCacheKey(symbol: string, interval: string): string {
    return `${symbol.trim().toUpperCase()}::${interval.trim().toLowerCase()}`;
}

function getIndexedDbFactory(): IDBFactory | null {
    if (typeof indexedDB !== 'undefined') return indexedDB;
    return null;
}

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve) => {
        const factory = getIndexedDbFactory();
        if (!factory) {
            resolve(null);
            return;
        }

        const request = factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            debugLogger.warn('data.cache.open_failed', {
                error: request.error?.message ?? 'unknown',
            });
            resolve(null);
        };
    });

    return dbPromise;
}

function normalizeTime(raw: unknown): number | null {
    return parseTimeToUnixSeconds(raw);
}

function buildCandle(
    time: number | null,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number
): OHLCVData | null {
    if (!Number.isFinite(time) || time === null) return null;
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        return null;
    }

    return {
        time: time as Time,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
    };
}

function parseRawCandle(row: unknown): OHLCVData | null {
    if (!row) return null;

    if (Array.isArray(row)) {
        if (row.length < 5) return null;
        const time = normalizeTime(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = Number(row[5] ?? 0);
        return buildCandle(time, open, high, low, close, volume);
    }

    if (typeof row === 'object') {
        const value = row as Record<string, unknown>;
        const time = normalizeTime(
            value.time ??
            value.t ??
            value.timestamp ??
            value.openTime ??
            value.datetime ??
            value.date
        );
        const open = Number(value.open ?? value.o);
        const high = Number(value.high ?? value.h);
        const low = Number(value.low ?? value.l);
        const close = Number(value.close ?? value.c);
        const volume = Number(value.volume ?? value.v ?? 0);
        return buildCandle(time, open, high, low, close, volume);
    }

    return null;
}

function sanitizeCandles(candles: OHLCVData[]): OHLCVData[] {
    const normalized = candles
        .map((row) => parseRawCandle(row))
        .filter((bar): bar is OHLCVData => !!bar)
        .sort((a, b) => Number(a.time) - Number(b.time));

    const deduped: OHLCVData[] = [];
    for (const bar of normalized) {
        const last = deduped[deduped.length - 1];
        if (last && Number(last.time) === Number(bar.time)) {
            deduped[deduped.length - 1] = bar;
        } else {
            deduped.push(bar);
        }
    }
    return deduped.slice(-MAX_CANDLES_PER_SERIES);
}

export function mergeCandles(
    existingCandles: OHLCVData[],
    incomingCandles: OHLCVData[]
): OHLCVData[] {
    if (existingCandles.length === 0) return sanitizeCandles(incomingCandles);
    if (incomingCandles.length === 0) return existingCandles.slice(-MAX_CANDLES_PER_SERIES);

    const incoming = sanitizeCandles(incomingCandles);
    if (incoming.length === 0) return existingCandles.slice(-MAX_CANDLES_PER_SERIES);

    // Fast path for incremental append/replace of the latest candle(s).
    const firstIncomingTime = Number(incoming[0].time);
    const lastExistingTime = Number(existingCandles[existingCandles.length - 1].time);
    if (Number.isFinite(firstIncomingTime) && Number.isFinite(lastExistingTime) && firstIncomingTime >= lastExistingTime) {
        const merged = existingCandles.length > MAX_CANDLES_PER_SERIES
            ? existingCandles.slice(-MAX_CANDLES_PER_SERIES)
            : existingCandles.slice();
        let tailTime = Number(merged[merged.length - 1].time);

        for (const bar of incoming) {
            const barTime = Number(bar.time);
            if (!Number.isFinite(barTime)) {
                return sanitizeCandles([...existingCandles, ...incoming]);
            }
            if (barTime < tailTime) {
                return sanitizeCandles([...existingCandles, ...incoming]);
            }
            if (barTime === tailTime) {
                merged[merged.length - 1] = bar;
                continue;
            }
            merged.push(bar);
            tailTime = barTime;
        }

        if (merged.length > MAX_CANDLES_PER_SERIES) {
            merged.splice(0, merged.length - MAX_CANDLES_PER_SERIES);
        }
        return merged;
    }

    return sanitizeCandles([...existingCandles, ...incoming]);
}

function extractCandlesFromPayload(payload: unknown): OHLCVData[] {
    if (Array.isArray(payload)) {
        return sanitizeCandles(payload as OHLCVData[]);
    }
    if (!payload || typeof payload !== 'object') return [];

    const value = payload as Record<string, unknown>;
    if (Array.isArray(value.data)) {
        return sanitizeCandles(value.data as OHLCVData[]);
    }
    if (Array.isArray(value.ohlcv)) {
        return sanitizeCandles(value.ohlcv as OHLCVData[]);
    }
    if (Array.isArray(value.candles)) {
        return sanitizeCandles(value.candles as OHLCVData[]);
    }
    return [];
}

export async function loadCachedCandles(symbol: string, interval: string): Promise<CachedCandles | null> {
    const db = await openDb();
    if (!db) return null;

    const key = toCacheKey(symbol, interval);
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => {
            const raw = request.result as CandleSeriesRecord | undefined;
            if (!raw || !Array.isArray(raw.candles)) {
                resolve(null);
                return;
            }
            resolve({
                candles: sanitizeCandles(raw.candles),
                updatedAt: Number(raw.updatedAt) || 0,
                source: raw.source ?? 'manual',
            });
        };
        request.onerror = () => resolve(null);
    });
}

export async function saveCachedCandles(
    symbol: string,
    interval: string,
    candles: OHLCVData[],
    source: CandleCacheSource | string
): Promise<void> {
    const db = await openDb();
    if (!db) return;

    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedInterval = interval.trim().toLowerCase();
    const record: CandleSeriesRecord = {
        key: toCacheKey(normalizedSymbol, normalizedInterval),
        symbol: normalizedSymbol,
        interval: normalizedInterval,
        candles: sanitizeCandles(candles),
        updatedAt: Date.now(),
        source,
    };

    await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

export async function loadSeedCandlesFromPriceData(
    symbol: string,
    interval: string,
    signal?: AbortSignal
): Promise<OHLCVData[] | null> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedInterval = interval.trim().toLowerCase();
    const key = toCacheKey(normalizedSymbol, normalizedInterval);
    if (missingSeedFiles.has(key)) return null;

    const fileName = `${normalizedSymbol}-${normalizedInterval}.json`;
    const filePath = `/price-data/${fileName}`;
    try {
        const response = await fetch(filePath, {
            signal,
            cache: 'no-store',
        });

        if (response.status === 404) {
            missingSeedFiles.add(key);
            return null;
        }
        if (!response.ok) {
            return null;
        }

        const payload = await response.json();
        const candles = extractCandlesFromPayload(payload);
        if (candles.length === 0) {
            missingSeedFiles.add(key);
            return null;
        }
        return candles;
    } catch {
        return null;
    }
}
