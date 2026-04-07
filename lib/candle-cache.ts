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
    trusted?: boolean;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;
const missingSeedFiles = new Set<string>();
const missingSp500CsvFiles = new Set<string>();
const sp500CsvCache = new Map<string, OHLCVData[]>();
const SP500_INDIVIDUAL_ANALYSIS_BASE_PATH =
    '/price-data/sp500_comprehensive_dataset/sp500_comprehensive/individual_analysis';

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

function isParsedCandle(row: unknown): row is OHLCVData {
    if (!row || typeof row !== 'object') return false;

    const value = row as OHLCVData;
    return Number.isFinite(Number(value.time))
        && Number.isFinite(value.open)
        && Number.isFinite(value.high)
        && Number.isFinite(value.low)
        && Number.isFinite(value.close)
        && Number.isFinite(value.volume);
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

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (ch === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }

    values.push(current.trim());
    return values;
}

function normalizeSp500Date(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    if (trimmed.includes('T')) return trimmed;
    if (trimmed.includes(' ')) {
        return trimmed.replace(' ', 'T');
    }
    return trimmed;
}

function extractCandlesFromCsvPayload(payload: string): OHLCVData[] {
    const lines = payload
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length <= 1) return [];

    const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
    const dateIdx = header.findIndex((value) => value === 'date' || value === 'time' || value === 'timestamp');
    const openIdx = header.indexOf('open');
    const highIdx = header.indexOf('high');
    const lowIdx = header.indexOf('low');
    const closeIdx = header.indexOf('close');
    const volumeIdx = header.indexOf('volume');

    if (dateIdx < 0 || openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0) {
        return [];
    }

    const candles: OHLCVData[] = [];
    for (let i = 1; i < lines.length; i += 1) {
        const columns = parseCsvLine(lines[i]);
        if (columns.length <= closeIdx) continue;

        const time = parseTimeToUnixSeconds(normalizeSp500Date(columns[dateIdx] ?? ''));
        const open = Number(columns[openIdx]);
        const high = Number(columns[highIdx]);
        const low = Number(columns[lowIdx]);
        const close = Number(columns[closeIdx]);
        const volume = volumeIdx >= 0 ? Number(columns[volumeIdx] ?? 0) : 0;
        const candle = buildCandle(time, open, high, low, close, volume);
        if (candle) {
            candles.push(candle);
        }
    }

    return sortAndDedupeCandles(candles);
}

function buildSp500SymbolCandidates(symbol: string): string[] {
    const normalized = symbol.trim().toUpperCase().replace(/\s+/g, '').replace(/\//g, '');
    if (!normalized) return [];

    const candidates = new Set<string>();
    const addCandidate = (value: string) => {
        const next = value.trim().toUpperCase();
        if (next) {
            candidates.add(next);
        }
    };

    addCandidate(normalized);
    if (normalized.endsWith('.S')) {
        addCandidate(normalized.slice(0, -2));
    }
    if (normalized.endsWith('+')) {
        addCandidate(normalized.slice(0, -1));
    }
    if (normalized.includes('.')) {
        addCandidate(normalized.replace(/\./g, '-'));
    }
    if (normalized.includes('-')) {
        addCandidate(normalized.replace(/-/g, '.'));
    }

    return Array.from(candidates);
}

async function loadSp500IndividualAnalysisCandles(
    symbol: string,
    interval: string,
    signal?: AbortSignal
): Promise<OHLCVData[] | null> {
    const baseInterval = interval.trim().toLowerCase().split('@')[0];
    if (baseInterval !== '1d') return null;

    const candidates = buildSp500SymbolCandidates(symbol);
    for (const candidate of candidates) {
        if (sp500CsvCache.has(candidate)) {
            return sp500CsvCache.get(candidate)!;
        }
        if (missingSp500CsvFiles.has(candidate)) {
            continue;
        }

        const filePath = `${SP500_INDIVIDUAL_ANALYSIS_BASE_PATH}/${encodeURIComponent(candidate)}.csv`;
        try {
            const response = await fetch(filePath, {
                signal,
                cache: 'no-store',
            });

            if (response.status === 404) {
                missingSp500CsvFiles.add(candidate);
                continue;
            }
            if (!response.ok) {
                continue;
            }

            const payload = await response.text();
            const candles = extractCandlesFromCsvPayload(payload);
            if (candles.length === 0) {
                missingSp500CsvFiles.add(candidate);
                continue;
            }

            sp500CsvCache.set(candidate, candles);
            return candles;
        } catch {
            return null;
        }
    }

    return null;
}

function sortAndDedupeCandles(candles: OHLCVData[], trusted = false): OHLCVData[] {
    if (trusted) {
        if (candles.length > MAX_CANDLES_PER_SERIES) {
            return candles.slice(-MAX_CANDLES_PER_SERIES);
        }
        return candles;
    }

    const normalized = candles
        .filter((bar): bar is OHLCVData => isParsedCandle(bar))
        .slice()
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

function sanitizeCandles(candles: unknown[], trusted = false): OHLCVData[] {
    if (trusted) {
        return sortAndDedupeCandles(candles as OHLCVData[], true);
    }
    const normalized = candles
        .map((row) => parseRawCandle(row))
        .filter((bar): bar is OHLCVData => !!bar);

    return sortAndDedupeCandles(normalized);
}

export function mergeCandles(
    existingCandles: OHLCVData[],
    incomingCandles: OHLCVData[],
    trustedIncoming = false,
    trustedExisting = false
): OHLCVData[] {
    if (existingCandles.length === 0) return sortAndDedupeCandles(incomingCandles, trustedIncoming);
    if (incomingCandles.length === 0) return sortAndDedupeCandles(existingCandles, trustedExisting);

    const incoming = sortAndDedupeCandles(incomingCandles, trustedIncoming);
    if (incoming.length === 0) return sortAndDedupeCandles(existingCandles, trustedExisting);

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
                return sortAndDedupeCandles([...existingCandles, ...incoming]);
            }
            if (barTime < tailTime) {
                return sortAndDedupeCandles([...existingCandles, ...incoming]);
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

    return sortAndDedupeCandles([...existingCandles, ...incoming]);
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

    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedInterval = interval.trim().toLowerCase();
    const key = toCacheKey(normalizedSymbol, normalizedInterval);

    return new Promise((resolve) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => {
            const record = request.result as CandleSeriesRecord | undefined;
            if (!record || !Array.isArray(record.candles)) {
                resolve(null);
                return;
            }
            resolve({
                candles: record.candles,
                updatedAt: Number(record.updatedAt) || 0,
                source: record.source || 'manual',
                trusted: true
            });
        };
        request.onerror = () => resolve(null);
    });
}

export async function saveCachedCandles(
    symbol: string,
    interval: string,
    candles: OHLCVData[],
    source: CandleCacheSource | string,
    trusted = false
): Promise<void> {
    const db = await openDb();
    if (!db) return;

    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedInterval = interval.trim().toLowerCase();
    const record: CandleSeriesRecord = {
        key: toCacheKey(normalizedSymbol, normalizedInterval),
        symbol: normalizedSymbol,
        interval: normalizedInterval,
        candles: trusted ? sortAndDedupeCandles(candles, true) : sanitizeCandles(candles),
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
    let markMissing = false;

    try {
        const response = await fetch(filePath, {
            signal,
            cache: 'no-store',
        });

        if (response.status === 404) {
            markMissing = true;
        } else if (response.ok) {
            const payload = await response.json();
            const candles = extractCandlesFromPayload(payload);
            if (candles.length > 0) {
                return candles;
            }
            markMissing = true;
        } else {
            return null;
        }
    } catch {
        // Keep fallback path below.
    }

    const sp500Candles = await loadSp500IndividualAnalysisCandles(normalizedSymbol, normalizedInterval, signal);
    if (sp500Candles && sp500Candles.length > 0) {
        return sp500Candles;
    }

    if (markMissing) {
        missingSeedFiles.add(key);
    }

    return null;
}
