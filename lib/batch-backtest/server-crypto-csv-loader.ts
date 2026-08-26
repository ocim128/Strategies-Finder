import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/strategies";

const MAX_CANDLES_PER_SERIES = 100_000;
const CRYPTO_HEADER = "time,open,high,low,close,volume";
const CRYPTO_SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;

// TOP_MEAN workers are isolated blocking boundaries. Keep a parsed CSV cache
// in each worker so pair-affinity misses do not repeatedly parse the same
// crypto leg after its small SyntheticLegCache evicts it.
const PARSED_CSV_CACHE_MAX_ENTRIES = !isMainThread && workerData?.topMean === true ? 128 : 512;
const parsedCsvCache = new Map<string, { mtimeMs: number; candles: OHLCVData[] }>();

function normalizeSymbol(symbol: string): string | null {
    const normalized = symbol.trim().toUpperCase();
    return CRYPTO_SYMBOL_PATTERN.test(normalized) ? normalized : null;
}

function normalizeInterval(interval: string): string | null {
    const normalized = interval.trim().toLowerCase().split("@")[0]!;
    return /^[a-z0-9]+$/.test(normalized) ? normalized : null;
}

function resolveCryptoCsvPath(symbol: string, interval: string, baseDir = process.cwd()): string | null {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeInterval(interval);
    if (!normalizedSymbol || !normalizedInterval) return null;

    const roots = [
        resolve(baseDir, "price-data", "crypto", "csv", normalizedInterval),
        resolve(baseDir, "..", "Strategies-Finder", "price-data", "crypto", "csv", normalizedInterval),
    ];
    for (const root of roots) {
        const filePath = resolve(root, `${normalizedSymbol}.csv`);
        if (filePath.startsWith(`${root}${sep}`) && existsSync(filePath)) return filePath;
    }
    return null;
}

export function getCryptoCsvMtimeMs(
    symbol: string,
    interval: string,
    baseDir = process.cwd(),
): number | null {
    const filePath = resolveCryptoCsvPath(symbol, interval, baseDir);
    if (!filePath) return null;
    try {
        return statSync(filePath).mtimeMs;
    } catch {
        return null;
    }
}

function parseCryptoCsvPayload(payload: string): OHLCVData[] | null {
    const lines = payload.split(/\r?\n/);
    const header = (lines[0] ?? "").replace(/^\uFEFF/, "").trim().toLowerCase();
    if (header !== CRYPTO_HEADER) return null;

    const candles: OHLCVData[] = [];
    let previousTime = -Infinity;
    for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i]!.trim();
        if (!line) continue;
        const columns = line.split(",");
        if (columns.length !== 6 || line.includes('"')) return null;

        const time = parseTimeToUnixSeconds(columns[0]);
        const open = Number(columns[1]);
        const high = Number(columns[2]);
        const low = Number(columns[3]);
        const close = Number(columns[4]);
        const volume = Number(columns[5]);
        if (
            time === null
            || !Number.isFinite(open)
            || !Number.isFinite(high)
            || !Number.isFinite(low)
            || !Number.isFinite(close)
            || time <= previousTime
        ) {
            return null;
        }
        previousTime = time;
        candles.push({
            time: time as OHLCVData["time"],
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

async function getCachedCandles(filePath: string): Promise<OHLCVData[] | null> {
    const cached = parsedCsvCache.get(filePath);
    if (!cached) return null;
    try {
        const mtimeMs = isMainThread
            ? (await stat(filePath)).mtimeMs
            : statSync(filePath).mtimeMs;
        if (mtimeMs === cached.mtimeMs) {
            parsedCsvCache.delete(filePath);
            parsedCsvCache.set(filePath, cached);
            return cached.candles;
        }
    } catch {
        // The caller will retry the normal read path below.
    }
    parsedCsvCache.delete(filePath);
    return null;
}

function setCachedCandles(filePath: string, mtimeMs: number, candles: OHLCVData[]): void {
    if (parsedCsvCache.has(filePath)) {
        parsedCsvCache.delete(filePath);
    } else if (parsedCsvCache.size >= PARSED_CSV_CACHE_MAX_ENTRIES) {
        const oldest = parsedCsvCache.keys().next().value;
        if (oldest !== undefined) parsedCsvCache.delete(oldest);
    }
    parsedCsvCache.set(filePath, { mtimeMs, candles });
}

export function clearParsedCryptoCsvCache(): void {
    parsedCsvCache.clear();
}

/** Read a synced crypto CSV directly inside the TOP_MEAN worker. */
export async function loadFreshCryptoCandlesFromDisk(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    baseDir = process.cwd(),
): Promise<OHLCVData[] | null> {
    if (signal?.aborted) return null;
    const filePath = resolveCryptoCsvPath(symbol, interval, baseDir);
    if (!filePath) return null;

    try {
        const cached = await getCachedCandles(filePath);
        if (cached) return cached;

        const payload = isMainThread
            ? await readFile(filePath, { encoding: "utf8", signal })
            : readFileSync(filePath, "utf8");
        if (signal?.aborted) return null;
        const candles = parseCryptoCsvPayload(payload);
        if (!candles || candles.length === 0) return null;

        const mtimeMs = isMainThread
            ? (await stat(filePath)).mtimeMs
            : statSync(filePath).mtimeMs;
        setCachedCandles(filePath, mtimeMs, candles);
        return candles;
    } catch (error) {
        if (signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") return null;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return null;
    }
}
