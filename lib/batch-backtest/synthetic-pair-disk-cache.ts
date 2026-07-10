/**
 * Server-side disk cache for synthetic pair OHLCV series.
 *
 * Caches pairs whose legs are file-backed OR Binance-backed (i.e. almost every
 * realistic pair). For file-backed legs (IBKR `•` / stock-market `♦`), the
 * seed CSV mtimes give the invalidation signal. For Binance legs, the SQLite
 * `series_meta.last_time` (last bar's unix seconds) is the content fingerprint
 * — if the last bar hasn't moved since the pair was cached, the upstream
 * series is unchanged for backtesting purposes.
 *
 * Server-side only. Imported transitively by `batch-backtest-vite-plugin.ts`,
 * so it MUST NOT import any browser-bound module (no `vite`, no
 * `lightweight-charts`, no `data-manager`, no `chart-manager`). The
 * `local-daily-datasets` and `local-api-transport` imports are leaf-safe.
 *
 * Cache files live at `price-data/synthetic-cache/<sanitized-key>.json`. They
 * intentionally survive process restarts and `clearCaches()` — disk
 * invalidation is by fingerprint only. The directory is gitignored.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OHLCVData } from "../types/strategies";
import {
    isIbkrSymbol,
    isStockMarketSymbol,
    stripMarkedLocalStockSymbol,
} from "../local-daily-datasets";
import { fetchLocalApi } from "../local-api-transport";
import type { SyntheticPairDiskCacheArgs } from "./batch-dataset-loader-core";

/**
 * Bump when the synthetic pair output may change for the same seeds:
 *  - ratio formula (`buildSyntheticPairDataset`)
 *  - aggregation bucketing (`aggregateSyntheticBars`)
 *  - source-interval selection (`pickSourceInterval`)
 *  - `SYNTHETIC_TARGET_BARS` / `DATA_CHART_TOTAL_LIMIT` resolution that
 *    changes the slice length
 */
// v6 rejects files that may have been stamped with a fresh IBKR seed mtime
// while still containing candles from the stale Node-side parsed CSV cache.
// Earlier versions were produced before every true IBKR leg-LRU miss bypassed
// the parsed/persistence caches, so they cannot be trusted after a sync.
export const SYNTHETIC_PAIR_CACHE_VERSION = 6;

const CACHE_DIR_NAME = "synthetic-cache";
const SERIES_META_TIMEOUT_MS = 2_000;
let cacheDirForTests: string | null = null;

interface CachedSyntheticPairFile {
    version: number;
    fingerprint: string;
    generatedAt: string;
    sourceInterval: string;
    bars: number;
    data: Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
}

interface SeriesMetaResponse {
    ok?: boolean;
    lastTime?: number | null;
    barsCount?: number | null;
}

/**
 * Compute a fingerprint for a pair's underlying legs. Returns null when EITHER
 * leg has no usable staleness signal — the pair must not be disk-cached in
 * that case, and the caller falls through to the in-memory build.
 *
 * - File-backed leg (IBKR `•` / stock-market `♦`): seed CSV mtime at the
 *   source interval. Touching the seed (IBKR sync, manual edit) invalidates.
 * - Binance leg: `series_meta.last_time` from the local SQLite DB. Appended
 *   bars move `last_time` forward and invalidate; rewinds are not detected
 *   (rare for Binance; see caveat in module docstring).
 * - Mixed pairs are supported: each leg segment is tagged with its source
 *   kind so the two signals compose safely.
 *
 * Async because the Binance path issues an HTTP call to the SQLite plugin.
 */
export async function computeSeedFingerprint(
    baseSymbol: string,
    quoteSymbol: string,
    sourceInterval: string,
): Promise<string | null> {
    const baseSegment = await legFingerprintSegment(baseSymbol, sourceInterval);
    if (baseSegment === null) return null;
    const quoteSegment = await legFingerprintSegment(quoteSymbol, sourceInterval);
    if (quoteSegment === null) return null;

    return `v${SYNTHETIC_PAIR_CACHE_VERSION}|${baseSegment}|${quoteSegment}`;
}

async function legFingerprintSegment(symbol: string, sourceInterval: string): Promise<string | null> {
    if (isIbkrSymbol(symbol) || isStockMarketSymbol(symbol)) {
        return fileBackedSegment(symbol, sourceInterval);
    }
    return binanceBackedSegment(symbol, sourceInterval);
}

function fileBackedSegment(symbol: string, sourceInterval: string): string | null {
    const bare = stripMarkedLocalStockSymbol(symbol);
    const mtime = seedCsvMtimeMs(bare, sourceInterval);
    if (mtime === null) return null;
    return `file:${bare}:${sourceInterval}:${mtime}`;
}

async function binanceBackedSegment(symbol: string, sourceInterval: string): Promise<string | null> {
    const meta = await loadSeriesMeta(symbol, sourceInterval);
    if (!meta || meta.lastTime == null) return null;
    // Fold barsCount in to detect historical rewrites (rare for Binance but
    // cheap insurance — both are indexed PK lookups).
    const bars = meta.barsCount ?? 0;
    return `binance:${symbol}:${sourceInterval}:${meta.lastTime}:${bars}`;
}

/**
 * Test seam: replace the series_meta fetcher. Production uses `fetchLocalApi`
 * via `loadSeriesMeta`; tests inject a stub that returns a canned response
 * without needing the dev server running. Set to `null` to restore default.
 */
export let __seriesMetaFetcherForTests: ((symbol: string, interval: string) => Promise<SeriesMetaResponse | null>) | null = null;

export function __setSeriesMetaFetcherForTests(
    fetcher: ((symbol: string, interval: string) => Promise<SeriesMetaResponse | null>) | null,
): void {
    __seriesMetaFetcherForTests = fetcher;
}

/**
 * Read `series_meta` for a symbol+interval via the SQLite plugin's HTTP
 * endpoint. Returns null on any failure (endpoint missing, cold cache, DB
 * error) — the caller treats null as "no fingerprint available, skip cache".
 */
async function loadSeriesMeta(symbol: string, interval: string): Promise<SeriesMetaResponse | null> {
    if (__seriesMetaFetcherForTests) {
        return __seriesMetaFetcherForTests(symbol, interval);
    }
    const query = new URLSearchParams({ symbol, interval });
    try {
        const response = await fetchLocalApi(
            `/api/sqlite/series-meta?${query.toString()}`,
            { method: "GET" },
            SERIES_META_TIMEOUT_MS,
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as SeriesMetaResponse;
        if (!payload?.ok) return null;
        return payload;
    } catch {
        return null;
    }
}

/**
 * Resolve the seed CSV path for a bare ticker at a given interval.
 *
 * IBKR seeds live at `price-data/ibkr/csv/<interval>/<SYMBOL>.csv`. Stock-
 * market-data seeds (`♦`) share the same directory layout under
 * `price-data/ibkr/csv/` (the catalog reader treats them uniformly). If
 * stock-market-data ever moves to a different directory, this path needs to
 * track it; for now both go through the IBKR csv dir.
 *
 * Inlined here (instead of importing `getCsvPath` from `ibkr-data-vite-plugin`)
 * to keep this module free of the vite plugin's `vite` import.
 */
function seedCsvPath(bareSymbol: string, interval: string): string {
    return resolve(process.cwd(), "price-data", "ibkr", "csv", interval, `${bareSymbol}.csv`);
}

function seedCsvMtimeMs(bareSymbol: string, interval: string): number | null {
    const filePath = seedCsvPath(bareSymbol, interval);
    try {
        return statSync(filePath).mtimeMs;
    } catch {
        return null;
    }
}

/**
 * Filename-safe encoding of a pairCache key. The pairCache key contains pipes
 * and may contain unicode markers (`•`, `♦`) — both are fine on NTFS/ext4 but
 * pipes are awkward in shells, so swap them for `-`. The markers are kept so
 * the filename stays human-readable and traceable to the pair token.
 */
function cacheFilePath(args: SyntheticPairDiskCacheArgs): string {
    const sanitized = args.pairKey.replace(/\|/g, "-");
    return resolve(cacheDir(), `${sanitized}.json`);
}

function cacheDir(): string {
    if (cacheDirForTests) return cacheDirForTests;
    return resolve(process.cwd(), "price-data", CACHE_DIR_NAME);
}

/**
 * Read a cached synthetic pair from disk. Returns null on any miss: file
 * absent, version mismatch, fingerprint mismatch, malformed JSON, or I/O
 * error. Never throws — the caller falls through to the in-memory build path.
 *
 * Async because fingerprint computation may hit the SQLite endpoint.
 */
export async function loadCachedSyntheticPair(
    args: SyntheticPairDiskCacheArgs,
): Promise<{ bars: OHLCVData[] } | null> {
    const fingerprint = await computeSeedFingerprint(args.baseSymbol, args.quoteSymbol, args.sourceInterval);
    if (fingerprint === null) return null;

    const filePath = cacheFilePath(args);
    let raw: string;
    try {
        raw = readFileSync(filePath, "utf8");
    } catch {
        return null;
    }

    let parsed: CachedSyntheticPairFile;
    try {
        parsed = JSON.parse(raw) as CachedSyntheticPairFile;
    } catch {
        return null;
    }

    if (parsed.version !== SYNTHETIC_PAIR_CACHE_VERSION) return null;
    if (parsed.fingerprint !== fingerprint) return null;
    if (!Array.isArray(parsed.data)) return null;

    // Cast `time` to the lightweight-charts `Time` branded number. The
    // disk format stores a plain number (mirrors `buildSyntheticPairPayload`
    // in `scripts/lib/synthetic-pair.ts`).
    const bars = parsed.data as OHLCVData[];
    return { bars };
}

/**
 * Write a synthetic pair to disk. Failures are swallowed (caller logs); the
 * cache is advisory and the in-memory path remains authoritative. No-op when
 * the pair has no fingerprint (e.g. cold-cache crypto leg with no series_meta).
 *
 * Returns true only when a cache file was written.
 */
export async function storeSyntheticPair(args: SyntheticPairDiskCacheArgs, bars: OHLCVData[]): Promise<boolean> {
    const fingerprint = await computeSeedFingerprint(args.baseSymbol, args.quoteSymbol, args.sourceInterval);
    if (fingerprint === null) return false;

    const filePath = cacheFilePath(args);
    const payload: CachedSyntheticPairFile = {
        version: SYNTHETIC_PAIR_CACHE_VERSION,
        fingerprint,
        generatedAt: new Date().toISOString(),
        sourceInterval: args.sourceInterval,
        bars: bars.length,
        data: bars.map((bar) => ({
            time: Number(bar.time),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
        })),
    };
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, JSON.stringify(payload), "utf8");
        return true;
    } catch {
        // Disk full, permissions, transient I/O — the in-memory path still
        // served the caller; the next run will retry the write.
        return false;
    }
}

/** Exposed for tests so they can inspect path resolution without re-deriving. */
export function __cacheFilePathForTests(args: SyntheticPairDiskCacheArgs): string {
    return cacheFilePath(args);
}

export function __setSyntheticPairCacheDirForTests(dir: string | null): void {
    cacheDirForTests = dir;
}

/** Wipe the cache directory. Test-only — production invalidation is by fingerprint. */
export function __clearSyntheticPairDiskCacheForTests(): void {
    const dir = cacheDir();
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
        if (entry.endsWith(".json")) {
            try { unlinkSync(resolve(dir, entry)); } catch { /* ignore */ }
        }
    }
}
