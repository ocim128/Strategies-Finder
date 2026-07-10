import type { Time } from "lightweight-charts";
import type { OHLCVData } from "./types/index";
import { normalizeTradFiDailyCandles } from "./data/data-interval-utils";
import { debugLogger } from "./debug-logger";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { fetchLocalApi } from "./local-api-transport";
import {
    LOCAL_DAILY_DATASETS,
    isIbkrDatasetKey,
    isIbkrSymbol,
    isStockMarketDatasetKey,
    isStockMarketSymbol,
    stripIbkrMarker,
    stripStockMarketMarker,
    type LocalDailyDatasetConfig,
} from "./local-daily-datasets";

const DB_NAME = 'strategies-finder-candles';
const STORE_NAME = 'series';
const DB_VERSION = 1;
const MAX_CANDLES_PER_SERIES = 100000;

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
// Bounded negative-result caches. Without a cap, long-lived sessions that
// sample many symbols accumulate entries forever; eviction also bounds the
// window during which an operator-shipped CSV is wrongly remembered as missing.
const MAX_MISSING_ENTRIES = 500;
const MAX_LOCAL_DAILY_CSV_ENTRIES = 64;
const missingSeedFiles = new Set<string>();
const missingLocalDailyCsvFiles = new Set<string>();
const localDailyCsvCache = new Map<string, OHLCVData[]>();

function rememberMissing(set: Set<string>, key: string): void {
    if (set.has(key)) return;
    if (set.size >= MAX_MISSING_ENTRIES) {
        // FIFO eviction of the oldest entry to keep the cache bounded.
        const oldest = set.values().next().value;
        if (oldest !== undefined) set.delete(oldest);
    }
    set.add(key);
}

function toCacheKey(symbol: string, interval: string): string {
    return `${symbol.trim().toUpperCase()}::${interval.trim().toLowerCase()}`;
}

function getLocalDailyCsvCache(cacheKey: string): OHLCVData[] | undefined {
    const candles = localDailyCsvCache.get(cacheKey);
    if (candles) {
        localDailyCsvCache.delete(cacheKey);
        localDailyCsvCache.set(cacheKey, candles);
    }
    return candles;
}

function rememberLocalDailyCsv(cacheKey: string, candles: OHLCVData[]): void {
    if (localDailyCsvCache.has(cacheKey)) {
        localDailyCsvCache.delete(cacheKey);
    } else if (localDailyCsvCache.size >= MAX_LOCAL_DAILY_CSV_ENTRIES) {
        const oldest = localDailyCsvCache.keys().next().value;
        if (oldest !== undefined) localDailyCsvCache.delete(oldest);
    }
    localDailyCsvCache.set(cacheKey, candles);
}

function getLocalDailyCsvSymbolFromCacheKey(cacheKey: string): string {
    const parts = cacheKey.split(":");
    return (parts[parts.length - 1] ?? "").trim().toUpperCase();
}

export function clearLocalDailyCsvCachesForSymbols(symbols?: readonly string[]): void {
    if (!symbols || symbols.length === 0) {
        localDailyCsvCache.clear();
        missingLocalDailyCsvFiles.clear();
        return;
    }

    const bareSymbols = new Set(
        symbols
            .map((symbol) => isIbkrSymbol(symbol) ? stripIbkrMarker(symbol) : stripStockMarketMarker(symbol))
            .map((symbol) => symbol.trim().toUpperCase())
            .filter(Boolean)
    );
    for (const key of Array.from(localDailyCsvCache.keys())) {
        if (bareSymbols.has(getLocalDailyCsvSymbolFromCacheKey(key))) {
            localDailyCsvCache.delete(key);
        }
    }
    for (const key of Array.from(missingLocalDailyCsvFiles.values())) {
        if (bareSymbols.has(getLocalDailyCsvSymbolFromCacheKey(key))) {
            missingLocalDailyCsvFiles.delete(key);
        }
    }
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

function normalizeCsvDate(raw: string): string {
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

        const time = parseTimeToUnixSeconds(normalizeCsvDate(columns[dateIdx] ?? ''));
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

// Stock Market Data CSVs ship with a `DD-MM-YYYY` Date column (e.g.
// 15-12-1980 = Dec 15 1980). The shared parseTimeToUnixSeconds relies on
// Date.parse, which is MM-DD-YYYY-biased and silently rejects days > 12,
// so this loader parses the date explicitly. Columns are matched by header
// name to tolerate the Yahoo column order (`Date,Low,Open,Volume,High,Close,
// Adjusted Close`) and uses the unadjusted OHLC columns.
const STOCK_MARKET_DATE_PATTERN = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;

export function parseStockMarketCsvDate(raw: string): number | null {
    const match = STOCK_MARKET_DATE_PATTERN.exec(raw.trim());
    if (!match) return null;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const utcSeconds = Math.floor(Date.UTC(year, month - 1, day) / 1000);
    if (Number.isFinite(utcSeconds)) return utcSeconds;
    return null;
}

export function extractCandlesFromStockMarketCsvPayload(payload: string): OHLCVData[] {
    const lines = payload
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length <= 1) return [];

    const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
    const dateIdx = header.indexOf('date');
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

        const time = parseStockMarketCsvDate(columns[dateIdx] ?? '');
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

function buildLocalDailySymbolCandidates(symbol: string): string[] {
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

async function loadLocalDailyDatasetCandles(
    dataset: LocalDailyDatasetConfig,
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    bypassCache = false,
): Promise<OHLCVData[] | null> {
    const baseInterval = interval.trim().toLowerCase().split('@')[0];
    const isIbkr = isIbkrDatasetKey(dataset.key);
    if (!isIbkr && baseInterval !== '1d') return null;
    if (isIbkr && dataset.supportedIntervals && !dataset.supportedIntervals.includes(baseInterval)) return null;

    const isStockMarket = isStockMarketDatasetKey(dataset.key);
    const isMarkedIbkr = isIbkr && isIbkrSymbol(symbol);
    // Stock-market symbols are stored on disk under their bare ticker; the
    // diamond marker is a runtime-only namespace. Strip it before resolving
    // the CSV path so `AAPL♦` maps to `AAPL.csv`.
    const lookupSymbol = isStockMarket
        ? stripStockMarketMarker(symbol)
        : isMarkedIbkr
            ? stripIbkrMarker(symbol)
            : symbol;
    const candidates = buildLocalDailySymbolCandidates(lookupSymbol);
    const parsePayload = isStockMarket
        ? extractCandlesFromStockMarketCsvPayload
        : extractCandlesFromCsvPayload;

    for (const candidate of candidates) {
        const cacheKey = isIbkr
            ? `${dataset.key}:${baseInterval}:${candidate}`
            : `${dataset.key}:${candidate}`;
        if (!bypassCache) {
            const cachedCandles = getLocalDailyCsvCache(cacheKey);
            if (cachedCandles) {
                return cachedCandles;
            }
            if (missingLocalDailyCsvFiles.has(cacheKey)) {
                continue;
            }
        }

        const filePath = isIbkr
            ? `${dataset.candlesBasePath}/${encodeURIComponent(baseInterval)}/${encodeURIComponent(candidate)}.csv`
            : `${dataset.candlesBasePath}/${encodeURIComponent(candidate)}.csv`;
        try {
            // `fetchLocalApi` resolves relative `/price-data/...` URLs against
            // the dev-server origin in Node (browser fetch does this implicitly).
            // Without it, server-side batch loads of IBKR / stock_market_data
            // seed CSVs return 0 bars and surface as "Quote bars must contain
            // at least one aligned candle" downstream.
            const response = await fetchLocalApi(filePath, {
                signal,
                cache: 'no-store',
            }, 30_000);

            if (response.status === 404) {
                rememberMissing(missingLocalDailyCsvFiles, cacheKey);
                continue;
            }
            if (!response.ok) {
                continue;
            }

            const payload = await response.text();
            const candles = normalizeTradFiDailyCandles(parsePayload(payload), baseInterval);
            if (candles.length === 0) {
                rememberMissing(missingLocalDailyCsvFiles, cacheKey);
                continue;
            }

            rememberLocalDailyCsv(cacheKey, candles);
            return candles;
        } catch (error) {
            if (signal?.aborted) return null;
            debugLogger.warn('seed.local_daily_dataset_load_failed', {
                dataset: dataset.key,
                symbol,
                candidate,
                interval: baseInterval,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    return null;
}

/**
 * Load an IBKR CSV from the authoritative file response without consulting
 * the parsed-CSV cache. Server-side synthetic-pair cache misses use this path
 * so a fresh pair artifact cannot be rebuilt from a retained pre-sync leg.
 */
export async function loadFreshIbkrCandlesFromPriceData(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[] | null> {
    if (!isIbkrSymbol(symbol)) return null;
    const dataset = LOCAL_DAILY_DATASETS.find((candidate) => isIbkrDatasetKey(candidate.key));
    return dataset
        ? loadLocalDailyDatasetCandles(dataset, symbol, interval, signal, true)
        : null;
}

async function loadLocalDailyCandles(
    symbol: string,
    interval: string,
    signal?: AbortSignal
): Promise<OHLCVData[] | null> {
    const stockMarked = isStockMarketSymbol(symbol);
    const ibkrMarked = isIbkrSymbol(symbol);
    // Marked symbols only resolve against their matching marked dataset; skip
    // the others so a source marker cannot accidentally match a bare-ticker CSV.
    const candidateDatasets = LOCAL_DAILY_DATASETS.filter((dataset) => {
        if (stockMarked) return isStockMarketDatasetKey(dataset.key);
        if (ibkrMarked) return isIbkrDatasetKey(dataset.key);
        return !isStockMarketDatasetKey(dataset.key) && !isIbkrDatasetKey(dataset.key);
    });
    if (candidateDatasets.length === 0) return null;

    // Iterate datasets in parallel; per-dataset caches make repeat loads
    // cheap and the first non-empty winner is returned.
    const results = await Promise.all(
        candidateDatasets.map((dataset) =>
            loadLocalDailyDatasetCandles(dataset, symbol, interval, signal)
        )
    );
    for (const candles of results) {
        if (candles && candles.length > 0) {
            return candles;
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

export async function clearCachedCandlesDatabase(): Promise<boolean> {
    const factory = getIndexedDbFactory();
    if (!factory) return false;

    if (dbPromise) {
        const db = await dbPromise.catch(() => null);
        db?.close();
        dbPromise = null;
    }

    return new Promise((resolve) => {
        const request = factory.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
        request.onblocked = () => resolve(false);
    });
}

export async function loadSeedCandlesFromPriceData(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    provider?: string
): Promise<OHLCVData[] | null> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedInterval = interval.trim().toLowerCase();
    const key = toCacheKey(normalizedSymbol, normalizedInterval);
    if (missingSeedFiles.has(key)) return null;

    // The `.json` seed probe only applies to legacy Binance/bybit-tradfi
    // overlay seeds. `local-daily` symbols only ever resolve via per-dataset
    // CSVs, so probing `/price-data/{symbol}-{interval}.json` is an always-404
    // round trip before the real loader runs. Skip it for that provider.
    const skipJsonProbe = provider === 'local-daily' || provider === 'ibkr-local';

    let markMissing = false;

    if (!skipJsonProbe) {
        const fileName = `${normalizedSymbol}-${normalizedInterval}.json`;
        const filePath = `/price-data/${fileName}`;
        try {
            // `fetchLocalApi` for Node-side origin resolution; see
            // loadLocalDailyDatasetCandles for the same fix.
            const response = await fetchLocalApi(filePath, {
                signal,
                cache: 'no-store',
            }, 30_000);

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
    }

    const localDailyCandles = await loadLocalDailyCandles(normalizedSymbol, normalizedInterval, signal);
    if (localDailyCandles && localDailyCandles.length > 0) {
        return localDailyCandles;
    }

    if (markMissing) {
        rememberMissing(missingSeedFiles, key);
    }

    return null;
}
