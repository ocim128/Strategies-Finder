import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";
import { extractCandlesFromCsvPayload } from "../candle-cache";
import { normalizeTradFiDailyCandles } from "../data/data-interval-utils";
import { isIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import type { OHLCVData } from "../types/strategies";

const MAX_CANDLES_PER_SERIES = 100_000;
const IBKR_HEADER = "time,open,high,low,close,volume";

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
                // A TOP_MEAN worker is already an isolated blocking boundary.
                // Synchronous reads there avoid funneling 20 workers through
                // Node's process-wide four-thread fs pool. Keep the async path
                // on Vite's main thread so regular server requests stay live.
                const payload = isMainThread
                    ? await readFile(filePath, { encoding: "utf8", signal })
                    : readFileSync(filePath, "utf8");
                if (signal?.aborted) return null;
                const candles = normalizeTradFiDailyCandles(parseIbkrCsvPayload(payload), baseInterval);
                if (candles.length > 0) return candles;
            } catch (error) {
                if (signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") return null;
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                return null;
            }
        }
    }
    return null;
}
