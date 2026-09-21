import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";
import { extractCandlesFromCsvPayload } from "../candle-cache";
import { normalizeTradFiDailyCandles } from "../data/data-interval-utils";
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
 * seed) and candle objects are materialized per cache hit. Audit
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

type ParsedCsvCache = Map<string, { mtimeMs: number; columns: ParsedSeedColumns }>;
const parsedCsvCache: ParsedCsvCache = new Map();
// The coordinator replays thousands of standalone 4h targets across annual
// passes. Keep that main-thread target working set separate from the normal
// cache so it cannot evict the 30m seed cache used by other server work.
const parsed4hTargetCache: ParsedCsvCache = new Map();

interface CacheCheck {
    filePath: string;
    mtimeMs: number;
    columns: ParsedSeedColumns;
}

async function checkParsedCsvCache(filePath: string, cache: ParsedCsvCache): Promise<CacheCheck | null> {
    const cached = cache.get(filePath);
    if (!cached) return null;
    try {
        const mtimeMs = isMainThread
            ? (await stat(filePath)).mtimeMs
            : statSync(filePath).mtimeMs;
        if (mtimeMs === cached.mtimeMs) {
            // Move-to-end for LRU recency.
            cache.delete(filePath);
            cache.set(filePath, cached);
            return { filePath, mtimeMs, columns: cached.columns };
        }
        cache.delete(filePath);
    } catch {
        cache.delete(filePath);
    }
    return null;
}

function storeParsedCsvCache(
    filePath: string,
    mtimeMs: number,
    candles: OHLCVData[],
    cache: ParsedCsvCache,
    maxEntries: number,
): void {
    if (cache.has(filePath)) {
        cache.delete(filePath);
    } else if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(filePath, { mtimeMs, columns: columnsFromCandles(candles) });
}

export function clearParsedIbkrCsvCache(): void {
    parsedCsvCache.clear();
    parsed4hTargetCache.clear();
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
): Promise<OHLCVData[] | null> {
    if (!isIbkrSymbol(symbol) || signal?.aborted) return null;
    const baseInterval = interval.trim().toLowerCase().split("@")[0]!;
    if (!/^[a-z0-9]+$/.test(baseInterval)) return null;
    const parsedCache = isMainThread && baseInterval === "4h"
        ? parsed4hTargetCache
        : parsedCsvCache;
    const parsedCacheMaxEntries = parsedCache === parsed4hTargetCache
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
                // Check the parsed-seed cache before re-reading. The cache keys
                // on (filePath, mtimeMs), so an IBKR sync that rewrites the
                // seed invalidates automatically. Cached entries are columnar
                // (GC-invisible); candle objects are materialized per hit at
                // ~1–2 ms against ~137 ms for a full re-parse.
                const cached = await checkParsedCsvCache(filePath, parsedCache);
                if (cached) {
                    if (signal?.aborted) return null;
                    return candlesFromColumns(cached.columns);
                }

                // A TOP_MEAN worker is already an isolated blocking boundary.
                // Synchronous reads there avoid funneling 20 workers through
                // Node's process-wide four-thread fs pool. Keep the async path
                // on Vite's main thread so regular server requests stay live.
                const payload = isMainThread
                    ? await readFile(filePath, { encoding: "utf8", signal })
                    : readFileSync(filePath, "utf8");
                if (signal?.aborted) return null;
                const candles = normalizeTradFiDailyCandles(parseIbkrCsvPayload(payload), baseInterval);
                if (candles.length > 0) {
                    const mtimeMs = isMainThread
                        ? (await stat(filePath)).mtimeMs
                        : statSync(filePath).mtimeMs;
                    storeParsedCsvCache(filePath, mtimeMs, candles, parsedCache, parsedCacheMaxEntries);
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
