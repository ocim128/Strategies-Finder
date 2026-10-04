import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";
import { debugLogger } from "../debug-logger";
import { extractCandlesFromCsvPayload } from "../candle-cache";
import { normalizeIbkrCandles } from "../data/data-interval-utils";
import { PointBoundedParsedCache } from "../data/point-bounded-parsed-cache";
import { isIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import type { OHLCVData } from "../types/strategies";

const MAX_CANDLES_PER_SERIES = 100_000;
const IBKR_HEADER = "time,open,high,low,close,volume";

/**
 * Parsed-seed cache for {@link loadFreshIbkrCandlesFromDisk}.
 *
 * `loadFreshIbkrCandlesFromDisk` reads and parses the full seed CSV on every
 * call — intentionally always-fresh. But the synthetic-pair loader calls it
 * per leg, and the in-memory `SyntheticLegCache` (24–128 entries) can't hold
 * the ~500 unique legs a full-universe run touches. When it overflows, the
 * same CSV would be re-parsed 3–4× per run (measured: ~88k parses × ~137 ms
 * on a 123k-pair TOP_MEAN run — the single largest load cost).
 *
 * This cache sits BELOW the leg cache and keys on `(filePath, mtimeMs)`. An
 * IBKR sync bumps the seed mtime, invalidating the entry automatically — so
 * it stays always-fresh without an explicit clear.
 *
 * The entries are COLUMNAR (six Float64Arrays per seed, ~1.2 MB per 25k-bar
 * seed) and candle objects are materialized per cache hit — pair leg loads
 * (see {@link loadFreshIbkrCandlesFromDisk} `limitBars`) can materialize only
 * the requested tail. Audit
 * (parse-thrash/GC finding): storing the candles as OBJECTS at this capacity
 * poisoned V8's collector — a 512-entry object cache holds ~12.6M live
 * objects per worker (~1.1 GB live graph), and major-GC cost scales with the
 * live graph, so every worker slowed 3–12× under GC storms (summed backtest
 * time 1.42M ms → 17.38M ms on the rerun). Typed-array backing stores live
 * OFF the V8 heap: the same 512-entry cache is GC-invisible external memory,
 * while a materialization per leg miss costs ~1–2 ms against ~137 ms for a
 * full re-parse.
 */
const PARSED_CSV_CACHE_MAX_ENTRIES = 512;
const PARSED_4H_TARGET_CACHE_MAX_ENTRIES = 4_096;
const PARSED_DAILY_TARGET_CACHE_MAX_ENTRIES = 8_192;
// Six Float64 columns per candle: at most 384 MB of backing arrays.
const PARSED_DAILY_TARGET_CACHE_MAX_POINTS = 8_000_000;

interface ParsedSeedColumns {
    time: Float64Array;
    open: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
}

function columnsFromCandles(candles: OHLCVData[]): ParsedSeedColumns {
    const n = candles.length;
    const columns: ParsedSeedColumns = {
        time: new Float64Array(n),
        open: new Float64Array(n),
        high: new Float64Array(n),
        low: new Float64Array(n),
        close: new Float64Array(n),
        volume: new Float64Array(n),
    };
    for (let i = 0; i < n; i += 1) {
        const bar = candles[i]!;
        columns.time[i] = Number(bar.time);
        columns.open[i] = bar.open;
        columns.high[i] = bar.high;
        columns.low[i] = bar.low;
        columns.close[i] = bar.close;
        columns.volume[i] = bar.volume;
    }
    return columns;
}

function candlesFromColumns(columns: ParsedSeedColumns): OHLCVData[] {
    const n = columns.time.length;
    const candles: OHLCVData[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
        candles[i] = {
            time: columns.time[i]! as OHLCVData["time"],
            open: columns.open[i]!,
            high: columns.high[i]!,
            low: columns.low[i]!,
            close: columns.close[i]!,
            volume: columns.volume[i]!,
        };
    }
    return candles;
}

/**
 * Materialize only the trailing {@link limitBars} candles from columnar cache
 * entries. Bars are contiguous by index, so a tail slice is a cheap inner-loop
 * bound — the columnar entry stays intact for other callers. Pair builders
 * consume the newest `sourceBars` candles, so a tail is exactly what they need;
 * standalone targets (limitBars undefined) still materialize the full series.
 */
function candlesFromColumnsTail(columns: ParsedSeedColumns, limitBars: number): OHLCVData[] {
    const n = columns.time.length;
    const start = n > limitBars ? n - limitBars : 0;
    const candles: OHLCVData[] = new Array(n - start);
    for (let i = start; i < n; i += 1) {
        candles[i - start] = {
            time: columns.time[i]! as OHLCVData["time"],
            open: columns.open[i]!,
            high: columns.high[i]!,
            low: columns.low[i]!,
            close: columns.close[i]!,
            volume: columns.volume[i]!,
        };
    }
    return candles;
}

type ParsedCsvCache = Map<string, { mtimeMs: number; columns: ParsedSeedColumns }>;

const parsedCsvCache: ParsedCsvCache = new Map();
// The coordinator replays thousands of standalone 4h targets across annual
// passes. Keep that main-thread target working set separate from the normal
// cache so it cannot evict the 30m seed cache used by other server work.
const parsed4hTargetCache: ParsedCsvCache = new Map();
// Main-thread daily targets are revisited by causal scoring, switch fills,
// ranking and later candidates. Keep compact columns, never candle objects.
const parsedDailyTargetCache = new PointBoundedParsedCache<{ mtimeMs: number; columns: ParsedSeedColumns }>(PARSED_DAILY_TARGET_CACHE_MAX_POINTS);
const dailyCacheCounters = { hits: 0, misses: 0 };

export function getParsedIbkrDailyCacheStats() {
    return { ...dailyCacheCounters, entries: parsedDailyTargetCache.size, points: parsedDailyTargetCache.points };
}

interface CacheCheck {
    filePath: string;
    mtimeMs: number;
    columns: ParsedSeedColumns;
}

function checkParsedCsvCache(filePath: string, cache: ParsedCsvCache, mtimeMs: number): CacheCheck | null {
    const cached = cache.get(filePath);
    if (!cached) {
        if (cache === parsedDailyTargetCache) dailyCacheCounters.misses++;
        return null;
    }
    if (mtimeMs === cached.mtimeMs) {
        if (cache === parsedDailyTargetCache) dailyCacheCounters.hits++;
        // Move-to-end for LRU recency.
        cache.delete(filePath);
        cache.set(filePath, cached);
        return { filePath, mtimeMs, columns: cached.columns };
    }
    cache.delete(filePath);
    if (cache === parsedDailyTargetCache) dailyCacheCounters.misses++;
    return null;
}

function storeParsedCsvColumns(
    filePath: string,
    mtimeMs: number,
    columns: ParsedSeedColumns,
    cache: ParsedCsvCache,
    maxEntries: number,
): void {
    if (cache.has(filePath)) {
        cache.delete(filePath);
    } else if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(filePath, { mtimeMs, columns });
}

export function clearParsedIbkrCsvCache(): void {
    parsedCsvCache.clear();
    parsed4hTargetCache.clear();
    parsedDailyTargetCache.clear();
    dailyCacheCounters.hits = dailyCacheCounters.misses = 0;
}

export const __testInternals = {
    PointBoundedParsedCache: PointBoundedParsedCache<{ mtimeMs: number; columns: ParsedSeedColumns }>,
};

// ============================================================================
// Disk-backed parsed-seed sidecar
// ============================================================================

/**
 * Binary columnar sidecar for parsed IBKR seed CSVs.
 *
 * The in-memory parsed-seed cache above holds 512–4096 entries PER PROCESS,
 * but a large TOP_MEAN run's leg-affinity shards give each worker a working
 * set of thousands of distinct seeds, so both per-worker LRU thrash. A 50k-
 * pair cold run measured ~38k full text re-parses at ~70–140 ms each —
 * 6.5M ms of summed worker load time (88.7% of the run's cost). Parsing must
 * therefore amortize ACROSS the ~24 worker processes, and the only state
 * they share is the filesystem.
 *
 * After a text parse, the six Float64 columns are written under
 * `price-data/ibkr/seed-cache/<interval>/<SYM>.bin`. Later loads stat the CSV
 * and, while (mtimeMs, size) still match the sidecar header, materialize
 * candles straight from the typed-array payload — a few ms against the
 * ~100 ms text parse. An IBKR/Alpaca sync rewrites the seed, which
 * invalidates the sidecar automatically; the next parse rewrites it.
 *
 * The sidecar stores the POST-normalization series (what the in-memory cache
 * stores), so bump {@link SEED_SIDECAR_FORMAT_VERSION} whenever parse or
 * normalization behavior changes. `IBKR_CSV_SEED_CACHE=0|false|off` disables
 * the cache; sidecar files are regenerable data and safe to delete.
 */
const SEED_SIDECAR_MAGIC = "IBSC";
const SEED_SIDECAR_FORMAT_VERSION = 2;
const SEED_SIDECAR_HEADER_BYTES = 32;
const SEED_SIDECAR_COLUMN_COUNT = 6;

interface SeedSidecarHit {
    columns: ParsedSeedColumns;
}

function isSeedSidecarDisabled(): boolean {
    const flag = process.env.IBKR_CSV_SEED_CACHE;
    return flag === "0" || flag === "false" || flag === "off";
}

function seedSidecarPathForCsv(filePath: string): string {
    return `${filePath.replace(`${sep}csv${sep}`, `${sep}seed-cache${sep}`)}.bin`;
}

function seedSidecarBuffer(columns: ParsedSeedColumns, mtimeMs: number, sizeBytes: number): Buffer {
    const count = columns.time.length;
    const out = Buffer.alloc(SEED_SIDECAR_HEADER_BYTES + count * 8 * SEED_SIDECAR_COLUMN_COUNT);
    out.write(SEED_SIDECAR_MAGIC, 0, "latin1");
    out.writeUInt32LE(SEED_SIDECAR_FORMAT_VERSION, 4);
    out.writeUInt32LE(count, 8);
    out.writeUInt32LE(0, 12);
    out.writeDoubleLE(mtimeMs, 16);
    out.writeDoubleLE(sizeBytes, 24);
    const base = out.byteOffset + SEED_SIDECAR_HEADER_BYTES;
    if (base % 8 === 0) {
        const floats = new Float64Array(out.buffer, base, count * SEED_SIDECAR_COLUMN_COUNT);
        floats.set(columns.time, 0);
        floats.set(columns.open, count);
        floats.set(columns.high, count * 2);
        floats.set(columns.low, count * 3);
        floats.set(columns.close, count * 4);
        floats.set(columns.volume, count * 5);
    } else {
        // Misaligned backing store (not expected for Buffer.alloc): fall back
        // to per-element LE writes rather than misinterpreting the bytes.
        const writeColumn = (values: Float64Array, offset: number) => {
            for (let i = 0; i < count; i += 1) {
                out.writeDoubleLE(values[i]!, base + (offset * count + i) * 8);
            }
        };
        writeColumn(columns.time, 0);
        writeColumn(columns.open, 1);
        writeColumn(columns.high, 2);
        writeColumn(columns.low, 3);
        writeColumn(columns.close, 4);
        writeColumn(columns.volume, 5);
    }
    return out;
}

function parseSeedSidecarBuffer(buf: Buffer, mtimeMs: number, sizeBytes: number): SeedSidecarHit | null {
    if (buf.length < SEED_SIDECAR_HEADER_BYTES) return null;
    if (buf.toString("latin1", 0, 4) !== SEED_SIDECAR_MAGIC) return null;
    if (buf.readUInt32LE(4) !== SEED_SIDECAR_FORMAT_VERSION) return null;
    const count = buf.readUInt32LE(8);
    const expectedLength = SEED_SIDECAR_HEADER_BYTES + count * 8 * SEED_SIDECAR_COLUMN_COUNT;
    if (count === 0 || buf.length !== expectedLength) return null;
    // The header stat pair must match the CURRENT CSV stat exactly; both come
    // from stat(), so an IBKR/Alpaca sync invalidates the sidecar here.
    if (buf.readDoubleLE(16) !== mtimeMs || buf.readDoubleLE(24) !== sizeBytes) return null;
    const base = buf.byteOffset + SEED_SIDECAR_HEADER_BYTES;
    if (base % 8 === 0) {
        const column = (offset: number) => new Float64Array(buf.buffer, base + offset * count * 8, count);
        return {
            columns: {
                time: column(0),
                open: column(1),
                high: column(2),
                low: column(3),
                close: column(4),
                volume: column(5),
            },
        };
    }
    const column = (offset: number) => {
        const values = new Float64Array(count);
        for (let i = 0; i < count; i += 1) {
            values[i] = buf.readDoubleLE(SEED_SIDECAR_HEADER_BYTES + (offset * count + i) * 8);
        }
        return values;
    };
    return {
        columns: {
            time: column(0),
            open: column(1),
            high: column(2),
            low: column(3),
            close: column(4),
            volume: column(5),
        },
    };
}

async function readSeedSidecar(
    filePath: string,
    mtimeMs: number,
    sizeBytes: number,
    signal?: AbortSignal,
): Promise<SeedSidecarHit | null> {
    if (signal?.aborted) return null;
    try {
        const sidecarPath = seedSidecarPathForCsv(filePath);
        const buf = isMainThread ? await readFile(sidecarPath) : readFileSync(sidecarPath);
        if (signal?.aborted) return null;
        return parseSeedSidecarBuffer(buf, mtimeMs, sizeBytes);
    } catch {
        return null;
    }
}

function writeSeedSidecarSync(filePath: string, mtimeMs: number, sizeBytes: number, columns: ParsedSeedColumns): void {
    try {
        const payload = seedSidecarBuffer(columns, mtimeMs, sizeBytes);
        const sidecarPath = seedSidecarPathForCsv(filePath);
        mkdirSync(dirname(sidecarPath), { recursive: true });
        // tmp-then-rename: a crash or concurrent writer can never leave a
        // half-written sidecar that parseSeedSidecarBuffer would trust.
        const temporary = `${sidecarPath}.${process.pid}.tmp`;
        writeFileSync(temporary, payload);
        renameSync(temporary, sidecarPath);
    } catch (error) {
        debugLogger.warn("ibkr.seed_sidecar_write_failed", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

async function writeSeedSidecarAsync(filePath: string, mtimeMs: number, sizeBytes: number, columns: ParsedSeedColumns): Promise<void> {
    try {
        const payload = seedSidecarBuffer(columns, mtimeMs, sizeBytes);
        const sidecarPath = seedSidecarPathForCsv(filePath);
        await mkdir(dirname(sidecarPath), { recursive: true });
        const temporary = `${sidecarPath}.${process.pid}.tmp`;
        await writeFile(temporary, payload);
        await rename(temporary, sidecarPath);
    } catch (error) {
        debugLogger.warn("ibkr.seed_sidecar_write_failed", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function buildIbkrFileCandidates(symbol: string): string[] {
    const normalized = stripIbkrMarker(symbol)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "")
        .replace(/[\\/]/g, "");
    if (!normalized) return [];

    const candidates = new Set<string>([normalized]);
    if (normalized.endsWith(".S")) candidates.add(normalized.slice(0, -2));
    if (normalized.endsWith("+")) candidates.add(normalized.slice(0, -1));
    if (normalized.includes(".")) candidates.add(normalized.replace(/\./g, "-"));
    if (normalized.includes("-")) candidates.add(normalized.replace(/-/g, "."));
    return [...candidates];
}

/**
 * Fast path for the canonical IBKR export shape. Falls back to the shared
 * general CSV parser if a file has another header, quoted values, or
 * non-monotonic timestamps.
 */
export function parseIbkrCsvPayload(payload: string): OHLCVData[] {
    const lines = payload.split("\n");
    const header = (lines[0] ?? "").replace(/^\uFEFF/, "").trim().toLowerCase();
    if (header !== IBKR_HEADER) return extractCandlesFromCsvPayload(payload);

    const candles: OHLCVData[] = [];
    let previousTime = -Infinity;
    for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i]!.trim();
        if (!line) continue;
        const columns = line.split(",");
        if (columns.length !== 6 || line.includes('"')) {
            return extractCandlesFromCsvPayload(payload);
        }

        const time = Date.parse(columns[0]!);
        const open = Number(columns[1]);
        const high = Number(columns[2]);
        const low = Number(columns[3]);
        const close = Number(columns[4]);
        const volume = Number(columns[5]);
        if (
            !Number.isFinite(time)
            || !Number.isFinite(open)
            || !Number.isFinite(high)
            || !Number.isFinite(low)
            || !Number.isFinite(close)
        ) {
            return extractCandlesFromCsvPayload(payload);
        }

        const timeSec = Math.floor(time / 1000);
        if (timeSec <= previousTime) {
            return extractCandlesFromCsvPayload(payload);
        }
        previousTime = timeSec;
        candles.push({
            time: timeSec as OHLCVData["time"],
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
        });
    }

    return candles.length > MAX_CANDLES_PER_SERIES
        ? candles.slice(-MAX_CANDLES_PER_SERIES)
        : candles;
}

/**
 * Server-only direct filesystem loader. Worker threads previously fetched
 * these local files through the Vite HTTP server, serializing thousands of
 * cold-cache requests through one process and leaving CPU cores idle.
 */
export async function loadFreshIbkrCandlesFromDisk(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    baseDir = process.cwd(),
    /**
     * Optional newest-bar budget for synthetic-pair leg loads. Cached seeds
     * materialize only the trailing {@link limitBars} bars (undefined keeps
     * the full-series contract for standalone targets). The uncached path
     * re-parses and stores the full series regardless — the parse cost
     * dominates and the entry stays whole for other callers.
     */
    limitBars?: number,
): Promise<OHLCVData[] | null> {
    if (!isIbkrSymbol(symbol) || signal?.aborted) return null;
    const baseInterval = interval.trim().toLowerCase().split("@")[0]!;
    if (!/^[a-z0-9]+$/.test(baseInterval)) return null;
    const parsedCache = isMainThread && baseInterval === "1d"
        ? parsedDailyTargetCache
        : isMainThread && baseInterval === "4h"
        ? parsed4hTargetCache
        : parsedCsvCache;
    const parsedCacheMaxEntries = parsedCache === parsedDailyTargetCache
        ? PARSED_DAILY_TARGET_CACHE_MAX_ENTRIES
        : parsedCache === parsed4hTargetCache
        ? PARSED_4H_TARGET_CACHE_MAX_ENTRIES
        : PARSED_CSV_CACHE_MAX_ENTRIES;

    const roots = [
        resolve(baseDir, "price-data", "ibkr", "csv", baseInterval),
        resolve(baseDir, "..", "Strategies-Finder", "price-data", "ibkr", "csv", baseInterval),
    ];
    const seenRoots = new Set<string>();
    for (const root of roots) {
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        for (const candidate of buildIbkrFileCandidates(symbol)) {
            const filePath = resolve(root, `${candidate}.csv`);
            if (!filePath.startsWith(`${root}${sep}`)) continue;
            try {
                // One stat per candidate serves both caches: the in-memory
                // parsed-seed cache validates on mtime, and the disk sidecar
                // additionally keys on the CSV byte size.
                const csvStat = isMainThread
                    ? await stat(filePath)
                    : statSync(filePath);
                const cached = checkParsedCsvCache(filePath, parsedCache, csvStat.mtimeMs);
                if (cached) {
                    if (signal?.aborted) return null;
                    return limitBars !== undefined
                        ? candlesFromColumnsTail(cached.columns, limitBars)
                        : candlesFromColumns(cached.columns);
                }

                // Disk sidecar: skips the text parse for seeds already parsed
                // by any worker or previous run since the CSV last changed.
                if (!isSeedSidecarDisabled()) {
                    const sidecar = await readSeedSidecar(filePath, csvStat.mtimeMs, csvStat.size, signal);
                    if (sidecar) {
                        // Sidecar hits must enter the same bounded parsed LRU as
                        // text parses, or repeated leg/target loads reread disk.
                        storeParsedCsvColumns(filePath, csvStat.mtimeMs, sidecar.columns, parsedCache, parsedCacheMaxEntries);
                        return limitBars !== undefined
                            ? candlesFromColumnsTail(sidecar.columns, limitBars)
                            : candlesFromColumns(sidecar.columns);
                    }
                }

                // A TOP_MEAN worker is already an isolated blocking boundary.
                // Synchronous reads there avoid funneling 20 workers through
                // Node's process-wide four-thread fs pool. Keep the async path
                // on Vite's main thread so regular server requests stay live.
                const payload = isMainThread
                    ? await readFile(filePath, { encoding: "utf8", signal })
                    : readFileSync(filePath, "utf8");
                if (signal?.aborted) return null;
                const candles = normalizeIbkrCandles(parseIbkrCsvPayload(payload), baseInterval);
                if (candles.length > 0) {
                    const columns = columnsFromCandles(candles);
                    storeParsedCsvColumns(filePath, csvStat.mtimeMs, columns, parsedCache, parsedCacheMaxEntries);
                    if (!isSeedSidecarDisabled()) {
                        if (isMainThread) {
                            await writeSeedSidecarAsync(filePath, csvStat.mtimeMs, csvStat.size, columns);
                        } else {
                            writeSeedSidecarSync(filePath, csvStat.mtimeMs, csvStat.size, columns);
                        }
                    }
                    return candles;
                }
            } catch (error) {
                if (signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") return null;
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                return null;
            }
        }
    }
    return null;
}
