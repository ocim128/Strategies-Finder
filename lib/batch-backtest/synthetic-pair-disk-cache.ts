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
 * Cache files live at `price-data/synthetic-cache/<sanitized-key>.<ext>`. They
 * intentionally survive process restarts and `clearCaches()` — disk
 * invalidation is by fingerprint only. The directory is gitignored.
 *
 * On-disk formats:
 *  - v1: JSON (`*.json`). Legacy; read transparently and lazily upgraded on
 *    the next write. Kept readable so existing caches keep working without a
 *    mass rewrite.
 *  - v2: V8 serialization (`*.bin`). Smaller (~45%) and faster (~23% decode,
 *    ~50% encode) for the numeric-heavy bar arrays, which dominate the ~5 GB
 *    cache the workspace accumulated under v1. New writes are v2; v1 files are
 *    upgraded opportunistically when next written by a fresh build.
 *
 * The cache is BOUNDED: {@link pruneSyntheticPairDiskCache} enforces both a
 * byte and a file-count cap, evicting oldest-mtime files first. It runs once
 * per process startup and is throttled after writes. Eviction is safe — a miss
 * only causes a rebuild (see AGENTS.md §"synthetic-pair disk cache").
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { serialize as v8Serialize, deserialize as v8Deserialize } from "node:v8";
import { isMainThread } from "node:worker_threads";
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
// v7 additionally moves the on-disk format from JSON to v8 serialization
// (.bin), so it invalidates every prior JSON file (v1–v6) by extension as well.
export const SYNTHETIC_PAIR_CACHE_VERSION = 7;

const CACHE_DIR_NAME = "synthetic-cache";
const SERIES_META_TIMEOUT_MS = 2_000;

/**
 * Bounded-cache caps. A complete 100-asset TOP_MEAN universe contains 4,950
 * pairs and the measured v7 files average ~700 KiB, so the cache must retain
 * that working set to avoid a cyclic miss/eviction loop on unchanged-data
 * reruns. Eviction is oldest-mtime-first (LRU-by-mtime); a miss only rebuilds
 * the pair, so these caps cannot affect result correctness.
 */
export const MAX_CACHE_BYTES = 4 * 1024 ** 3; // 4 GiB
export const MAX_CACHE_FILES = 6_000;
/** Post-write prune is throttled so a burst of writes doesn't stat the dir per file. */
const PRUNE_THROTTLE_MS = 60_000;
/**
 * A cache HIT bumps the file mtime at most once per this interval so the
 * prune sort (oldest-mtime-first) reflects actual access, not just write
 * time. Without this, a hot pair that hasn't been rewritten would be evicted
 * before a cold newer one — FIFO dressed as LRU (audit Finding 3). The
 * throttle bounds disk writes: at most one `utimes` per file per window.
 */
export const LRU_TOUCH_THROTTLE_MS = 5 * 60_000;

let cacheDirForTests: string | null = null;
/**
 * Test-only override for the file-backed (IBKR / stock-market) seed CSV root.
 * Production resolves seeds against `process.cwd()/price-data/ibkr/csv/`. Tests
 * that exercise `computeSeedFingerprint`'s seed-mtime stat sensitivity redirect
 * this to a per-spec tempdir so they never touch warmed production seeds.
 */
let seedDirForTests: string | null = null;
let lastPruneAt = 0;
let startupPruneDone = false;
let pruneScheduled = false;
let cacheGeneration = 0;
const lastLruTouchByPath = new Map<string, number>();

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
    // `updated_at` from `series_meta`. The SQLite endpoint returns this; folding
    // it into the fingerprint invalidates a cached pair when a historical bar is
    // corrected (rewritten) without changing last_time or row count (audit
    // Finding 2). Null on cold caches / older endpoints → falls back to 0.
    updatedAt?: number | null;
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
    // The two legs are independent; fetch their fingerprint segments in
    // parallel rather than serially. Each Binance-backed leg issues an HTTP
    // GET to /api/sqlite/series-meta with a 2-second timeout, so the prior
    // serial `await; await` doubled cold-cache fingerprint latency for the
    // dominant crypto-pair case (up to ~4s wall on a loaded dev server).
    // Promise.all halves that with zero behavior change — the early-null
    // short-circuit semantics are preserved by checking both results after.
    const [baseSegment, quoteSegment] = await Promise.all([
        legFingerprintSegment(baseSymbol, sourceInterval),
        legFingerprintSegment(quoteSymbol, sourceInterval),
    ]);
    if (baseSegment === null || quoteSegment === null) return null;

    return `v${SYNTHETIC_PAIR_CACHE_VERSION}|${baseSegment}|${quoteSegment}`;
}

export interface SeedFingerprintMemo {
    compute(baseSymbol: string, quoteSymbol: string, sourceInterval: string): Promise<string | null>;
    clear(): void;
}

export function createSeedFingerprintMemo(): SeedFingerprintMemo {
    const segmentCache = new Map<string, Promise<string | null>>();

    const getSegment = (symbol: string, sourceInterval: string): Promise<string | null> => {
        const key = `${symbol}|${sourceInterval}`;
        const existing = segmentCache.get(key);
        if (existing) return existing;

        const pending = legFingerprintSegment(symbol, sourceInterval).catch((error) => {
            segmentCache.delete(key);
            throw error;
        });
        segmentCache.set(key, pending);
        return pending;
    };

    return {
        async compute(baseSymbol, quoteSymbol, sourceInterval) {
            const [baseSegment, quoteSegment] = await Promise.all([
                getSegment(baseSymbol, sourceInterval),
                getSegment(quoteSymbol, sourceInterval),
            ]);
            if (baseSegment === null || quoteSegment === null) return null;
            return `v${SYNTHETIC_PAIR_CACHE_VERSION}|${baseSegment}|${quoteSegment}`;
        },
        clear() {
            segmentCache.clear();
        },
    };
}

async function legFingerprintSegment(symbol: string, sourceInterval: string): Promise<string | null> {
    if (isIbkrSymbol(symbol) || isStockMarketSymbol(symbol)) {
        return fileBackedSegment(symbol, sourceInterval);
    }
    return binanceBackedSegment(symbol, sourceInterval);
}

async function fileBackedSegment(symbol: string, sourceInterval: string): Promise<string | null> {
    const bare = stripMarkedLocalStockSymbol(symbol);
    const mtime = await seedCsvMtimeMs(bare, sourceInterval);
    if (mtime === null) return null;
    return `file:${bare}:${sourceInterval}:${mtime}`;
}

async function binanceBackedSegment(symbol: string, sourceInterval: string): Promise<string | null> {
    const meta = await loadSeriesMeta(symbol, sourceInterval);
    if (!meta || meta.lastTime == null) return null;
    // Fold barsCount in to detect historical rewrites (rare for Binance but
    // cheap insurance — both are indexed PK lookups). Fold updatedAt in too so
    // a same-row-count correction (a bar's OHLC rewritten in place via
    // `/store-ohlcv`) bumps `series_meta.updated_at` and invalidates the cached
    // pair — without this, last_time + bars_count alone would serve stale bars
    // after a repair (audit Finding 2). Coerce null → 0 so a cold-cache leg
    // (no series_meta row yet) still produces a stable fingerprint instead of
    // breaking the cache for every lookup.
    const bars = meta.barsCount ?? 0;
    const updatedAt = typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt) ? meta.updatedAt : 0;
    return `binance:${symbol}:${sourceInterval}:${meta.lastTime}:${bars}:${updatedAt}`;
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
    if (seedDirForTests) {
        return resolve(seedDirForTests, interval, `${bareSymbol}.csv`);
    }
    return resolve(process.cwd(), "price-data", "ibkr", "csv", interval, `${bareSymbol}.csv`);
}

async function seedCsvMtimeMs(bareSymbol: string, interval: string): Promise<number | null> {
    const filePath = seedCsvPath(bareSymbol, interval);
    try {
        return (await stat(filePath)).mtimeMs;
    } catch {
        return null;
    }
}

/**
 * Filename-safe encoding of a pairCache key. The pairCache key contains pipes
 * and may contain unicode markers (`•`, `♦`) — both are fine on NTFS/ext4 but
 * pipes are awkward in shells, so swap them for `-`. The markers are kept so
 * the filename stays human-readable and traceable to the pair token.
 *
 * New writes use the v2 `.bin` (V8-serialized) extension; v1 `.json` files are
 * still read for backward compatibility and upgraded on the next write.
 */
function cacheFileBasePath(args: SyntheticPairDiskCacheArgs): string {
    const sanitized = args.pairKey.replace(/\|/g, "-");
    const root = resolve(cacheDir());
    const candidate = resolve(root, sanitized);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
        throw new Error("Synthetic cache key escapes cache root");
    }
    return candidate;
}

function cacheFilePath(args: SyntheticPairDiskCacheArgs): string {
    return `${cacheFileBasePath(args)}.bin`;
}

function legacyJsonPath(args: SyntheticPairDiskCacheArgs): string {
    return `${cacheFileBasePath(args)}.json`;
}

function cacheDir(): string {
    if (cacheDirForTests) return cacheDirForTests;
    return resolve(process.cwd(), "price-data", CACHE_DIR_NAME);
}

/**
 * Read a cached synthetic pair from disk. Returns null on any miss: file
 * absent, version mismatch, fingerprint mismatch, malformed payload, or I/O
 * error. Never throws — the caller falls through to the in-memory build path.
 *
 * Reads v2 (`.bin`, V8-serialized) first, then falls back to v1 (`.json`) for
 * backward compatibility with caches written before the format migration. A
 * v1 hit is upgraded to v2 on the next store by {@link storeSyntheticPair}.
 *
 * Async because fingerprint computation may hit the SQLite endpoint.
 */
export async function loadCachedSyntheticPair(
    args: SyntheticPairDiskCacheArgs,
    fingerprint?: string | null,
): Promise<{ bars: OHLCVData[] } | null> {
    const effectiveFingerprint = fingerprint === undefined
        ? await computeSeedFingerprint(args.baseSymbol, args.quoteSymbol, args.sourceInterval)
        : fingerprint;
    if (effectiveFingerprint === null) return null;

    const entry = await readCacheFile(args);
    if (entry === null) return null;
    const parsed = entry.data;

    if (parsed.version !== SYNTHETIC_PAIR_CACHE_VERSION) return null;
    if (parsed.fingerprint !== effectiveFingerprint) return null;
    if (!Array.isArray(parsed.data)) return null;

    // Refresh the file's mtime (throttled) so the oldest-mtime-first prune
    // reflects actual access and a hot pair survives eviction. Without this,
    // eviction was oldest-WRITE-first regardless of reads (audit Finding 3).
    // Awaited so the mtime bump is observable to a caller that immediately
    // stats the file (the prune path and the cache tests both rely on this).
    // The touch itself is throttled and swallow-all, so this does not block on
    // disk contention under normal loads.
    await touchCacheFileForLru(entry.path);

    // Cast `time` to the lightweight-charts `Time` branded number. The
    // disk format stores a plain number (mirrors `buildSyntheticPairPayload`
    // in `scripts/lib/synthetic-pair.ts`).
    const bars = parsed.data as OHLCVData[];
    return { bars };
}

/**
 * Best-effort, throttled mtime bump so a cache HIT survives LRU-by-mtime
 * pruning. Touches the file at most once per {@link LRU_TOUCH_THROTTLE_MS};
 * a `stat` decides whether the (more expensive) `utimes` is needed,
 * so the common case is a single stat per lookup. Swallows all errors — the
 * cache is advisory and a failed touch must not turn a hit into an exception.
 *
 * Async because this sits on the synthetic-pair load hot path; the prior
 * `statSync` + `utimesSync` blocked the event loop on every cache hit, which
 * stalled Stop and `/status` servicing during large cold-cache runs. The
 * caller (`loadCachedSyntheticPair`) treats this as fire-and-forget.
 */
async function touchCacheFileForLru(filePath: string): Promise<void> {
    try {
        const now = Date.now();
        const lastKnownTouch = lastLruTouchByPath.get(filePath);
        if (lastKnownTouch !== undefined && now - lastKnownTouch < LRU_TOUCH_THROTTLE_MS) {
            return;
        }
        const mtimeMs = (await stat(filePath)).mtimeMs;
        if (now - mtimeMs < LRU_TOUCH_THROTTLE_MS) {
            lastLruTouchByPath.set(filePath, mtimeMs);
            return;
        }
        const nowSec = now / 1000;
        await utimes(filePath, nowSec, nowSec);
        lastLruTouchByPath.set(filePath, now);
    } catch {
        // Locked file, vanished between read and touch, permission error —
        // leave the mtime alone. Pruning will still work; it just won't see
        // this hit until the next successful touch.
    }
}

/**
 * Read and decode a cache file, preferring v2 (`.bin`) and falling back to v1
 * (`.json`). Returns null on any miss or decode failure — never throws. Also
 * returns the path that was read so the caller can refresh its mtime for
 * LRU-by-mtime pruning (audit Finding 3).
 *
 * Async because this sits on the synthetic-pair load hot path; the prior
 * `readFileSync` calls blocked the event loop on every cache read, which
 * stalled Stop and `/status` servicing during large cold-cache runs.
 */
async function readCacheFile(args: SyntheticPairDiskCacheArgs): Promise<{ path: string; data: CachedSyntheticPairFile } | null> {
    const binPath = cacheFilePath(args);
    try {
        const buffer = await readFile(binPath);
        const decoded = decodeV2(buffer);
        if (decoded) return { path: binPath, data: decoded };
    } catch {
        // Fall through to legacy JSON.
    }
    const jsonPath = legacyJsonPath(args);
    try {
        const raw = await readFile(jsonPath, "utf8");
        return { path: jsonPath, data: JSON.parse(raw) as CachedSyntheticPairFile };
    } catch {
        return null;
    }
}

/** Decode a v8-serialized cache payload; returns null on any corruption. */
function decodeV2(buffer: Buffer): CachedSyntheticPairFile | null {
    try {
        const value = v8Deserialize(buffer);
        if (value && typeof value === "object" && "version" in value) {
            return value as CachedSyntheticPairFile;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Write a synthetic pair to disk as v2 (V8-serialized `.bin`). Failures are
 * swallowed (caller logs); the cache is advisory and the in-memory path
 * remains authoritative. No-op when the pair has no fingerprint (e.g.
 * cold-cache crypto leg with no series_meta).
 *
 * The v8 serializer handles the plain-object payload directly (no need for the
 * v1 `bars.map(...)` normalization copy — `OHLCVData` is a plain object with
 * number fields, which v8 serializes compactly). Writes are atomic via a
 * temp-file + rename so a crash can't leave a half-written cache file.
 *
 * Removes any legacy `.json` for the same key so the v2 file is the single
 * source of truth after the first upgrade write.
 *
 * Returns true only when a cache file was written.
 */
export async function storeSyntheticPair(
    args: SyntheticPairDiskCacheArgs,
    bars: OHLCVData[],
    fingerprint?: string | null,
): Promise<boolean> {
    const effectiveFingerprint = fingerprint === undefined
        ? await computeSeedFingerprint(args.baseSymbol, args.quoteSymbol, args.sourceInterval)
        : fingerprint;
    if (effectiveFingerprint === null) return false;

    const filePath = cacheFilePath(args);
    // The `.map(...)` here is a type-level coercion, not a redundant copy:
    // `OHLCVData.time` is a lightweight-charts `Time` (a `number | BusinessDay
    // | string` union), but the on-disk `CachedSyntheticPairFile.data` shape
    // pins `time: number` and the load path casts `parsed.data as OHLCVData[]`
    // assuming numeric times. `Number(bar.time)` is what makes that invariant
    // hold for non-numeric `Time` variants. (An earlier audit pass read the
    // v8-serializer docstring as "this copy is unnecessary" and proposed
    // dropping it; that breaks the type contract for non-number `Time`, so it
    // is preserved here.)
    const payload: CachedSyntheticPairFile = {
        version: SYNTHETIC_PAIR_CACHE_VERSION,
        fingerprint: effectiveFingerprint,
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
        const buffer = v8Serialize(payload);
        if (isMainThread) {
            await mkdir(dirname(filePath), { recursive: true });
            await writeAtomic(filePath, buffer);
            // Remove a stale v1 `.json` for the same key so a subsequent read
            // can't resurrect a pre-v2 payload after the v2 file is written.
            try { await unlink(legacyJsonPath(args)); } catch { /* may not exist */ }
        } else {
            // TOP_MEAN workers are already isolated blocking boundaries.
            // Synchronous writes avoid funneling all workers through Node's
            // process-wide four-thread fs pool while preserving the existing
            // write-before-return cache durability contract.
            mkdirSync(dirname(filePath), { recursive: true });
            writeAtomicSync(filePath, buffer);
            try { unlinkSync(legacyJsonPath(args)); } catch { /* may not exist */ }
        }
        maybePruneAfterWrite();
        return true;
    } catch {
        // Disk full, permissions, transient I/O — the in-memory path still
        // served the caller; the next run will retry the write.
        return false;
    }
}

/**
 * Write `buffer` to `filePath` atomically via a sibling temp file + rename.
 * `rename` is atomic on the same filesystem (NTFS/ext4), so a crash mid-write
 * leaves either the old file or the new file — never a truncated hybrid.
 *
 * Async so the write does not block the event loop on the synthetic-pair
 * hot path. The caller (`storeSyntheticPair`) awaits it inside an already-async
 * producer promise.
 */
async function writeAtomic(filePath: string, buffer: Buffer): Promise<void> {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, buffer);
    await rename(tmp, filePath);
}

function writeAtomicSync(filePath: string, buffer: Buffer): void {
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, buffer);
    renameSync(tmp, filePath);
}

/** Exposed for tests so they can inspect path resolution without re-deriving. */
export function __cacheFilePathForTests(args: SyntheticPairDiskCacheArgs): string {
    return cacheFilePath(args);
}

export function __setSyntheticPairCacheDirForTests(dir: string | null): void {
    cacheGeneration += 1;
    cacheDirForTests = dir;
    lastPruneAt = 0;
    startupPruneDone = false;
    pruneScheduled = false;
    lastLruTouchByPath.clear();
}

/**
 * Test seam: redirect file-backed (IBKR / stock-market) seed CSV resolution to
 * a per-spec tempdir so fingerprint tests don't write to or `statSync` against
 * warmed production seeds under `price-data/ibkr/csv/`. Pass `null` to restore
 * the production root.
 */
export function __setSeedDirForTests(dir: string | null): void {
    seedDirForTests = dir;
}

/** Wipe the cache directory. Test-only — production invalidation is by fingerprint. */
export function __clearSyntheticPairDiskCacheForTests(): void {
    const dir = cacheDir();
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
        if (entry.endsWith(".json") || entry.endsWith(".bin")) {
            try { unlinkSync(resolve(dir, entry)); } catch { /* ignore */ }
        }
    }
}

// ---------------------------------------------------------------------------
// Bounded-cache pruning (Finding 1)
// ---------------------------------------------------------------------------

export interface SyntheticPairCachePruneOptions {
    /** Max total bytes; evict oldest until under cap. */
    maxBytes?: number;
    /** Max file count; evict oldest until under cap. */
    maxFiles?: number;
}

export interface SyntheticPairCachePruneResult {
    /** Number of files remaining after pruning. */
    files: number;
    /** Total bytes remaining after pruning. */
    bytes: number;
    /** Bytes reclaimed by eviction. */
    evictedBytes: number;
    /** Number of files evicted. */
    evictedFiles: number;
}

/**
 * Snapshot of cache size for diagnostics. Counts both `.bin` (v2) and `.json`
 * (v1 legacy) files. Returns zeros when the directory does not exist.
 */
export function getSyntheticPairCacheSize(): SyntheticPairCachePruneResult {
    return measureCache();
}

/**
 * Prune the cache to stay under byte/file caps, evicting oldest-mtime files
 * first. Safe to call at any time: a miss only causes a rebuild. Runs:
 *  - Once per process startup (via {@link pruneOnStartup}).
 *  - After writes, throttled to at most once per {@link PRUNE_THROTTLE_MS}.
 *
 * Pass explicit options to override the defaults (tests use small caps).
 */
export function pruneSyntheticPairDiskCache(options: SyntheticPairCachePruneOptions = {}): SyntheticPairCachePruneResult {
    const maxBytes = options.maxBytes ?? MAX_CACHE_BYTES;
    const maxFiles = options.maxFiles ?? MAX_CACHE_FILES;

    const dir = cacheDir();
    if (!existsSync(dir)) return { files: 0, bytes: 0, evictedBytes: 0, evictedFiles: 0 };

    const entries = collectCacheEntries(dir);
    // Sort oldest-mtime first so we evict in LRU-by-mtime order.
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    let totalFiles = entries.length;
    let evictedBytes = 0;
    let evictedFiles = 0;

    for (const entry of entries) {
        if (totalBytes <= maxBytes && totalFiles <= maxFiles) break;
        try {
            unlinkSync(entry.path);
            totalBytes -= entry.size;
            totalFiles -= 1;
            evictedBytes += entry.size;
            evictedFiles += 1;
        } catch {
            // Best-effort: a failed unlink (locked file) just leaves it; the
            // next prune retries. Skip counting it as evicted.
        }
    }

    return { files: totalFiles, bytes: totalBytes, evictedBytes, evictedFiles };
}

/**
 * Run the startup prune exactly once per process. Idempotent across modules
 * because `startupPruneDone` is module-scope. Also stamps `lastPruneAt` so the
 * throttled post-write prune doesn't fire again immediately after the startup
 * prune. Triggered lazily by the first cache write (see `maybePruneAfterWrite`)
 * rather than at import time, so importing the server loaders in tests does not
 * prune the real cache directory.
 */
export function pruneOnStartup(): SyntheticPairCachePruneResult {
    if (startupPruneDone) return measureCache();
    startupPruneDone = true;
    lastPruneAt = Date.now();
    return pruneSyntheticPairDiskCache();
}

/**
 * Throttled post-write prune — at most once per {@link PRUNE_THROTTLE_MS}. The
 * first write also performs the startup prune (idempotent via
 * {@link startupPruneDone}) so the cache is bounded once per process on first
 * real activity, rather than as a destructive import-time side-effect that
 * would prune the real cache directory when tests import the server loaders.
 */
function maybePruneAfterWrite(): void {
    if (pruneScheduled) return;
    const now = Date.now();
    if (startupPruneDone && now - lastPruneAt < PRUNE_THROTTLE_MS) return;

    // Directory-wide stat/sort pruning can take seconds on a warmed multi-GB
    // cache (especially on Windows). It is maintenance, not part of serving
    // the freshly-built pair, so keep it off Finder/Batch's critical path.
    const scheduledGeneration = cacheGeneration;
    pruneScheduled = true;
    setImmediate(() => {
        pruneScheduled = false;
        if (scheduledGeneration !== cacheGeneration) return;
        if (!startupPruneDone) {
            pruneOnStartup();
            return;
        }
        const current = Date.now();
        if (current - lastPruneAt < PRUNE_THROTTLE_MS) return;
        lastPruneAt = current;
        pruneSyntheticPairDiskCache();
    });
}

interface CacheEntry {
    path: string;
    size: number;
    mtimeMs: number;
}

function collectCacheEntries(dir: string): CacheEntry[] {
    const out: CacheEntry[] = [];
    for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".bin") && !entry.endsWith(".json")) continue;
        const fullPath = resolve(dir, entry);
        try {
            const stat = statSync(fullPath);
            if (stat.isFile()) {
                out.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
            }
        } catch {
            /* vanished between readdir and stat — skip */
        }
    }
    return out;
}

function measureCache(): SyntheticPairCachePruneResult {
    const dir = cacheDir();
    if (!existsSync(dir)) return { files: 0, bytes: 0, evictedBytes: 0, evictedFiles: 0 };
    const entries = collectCacheEntries(dir);
    const bytes = entries.reduce((sum, e) => sum + e.size, 0);
    return { files: entries.length, bytes, evictedBytes: 0, evictedFiles: 0 };
}
