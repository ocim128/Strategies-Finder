/**
 * Crypto Data sync Vite plugin.
 *
 * Mirrors the IBKR Data plugin's owner-lock + NDJSON stream + status-snapshot
 * reattach pattern (`lib/ibkr-data/ibkr-data-vite-plugin.ts`), but fetches
 * Binance klines server-side and writes them to BOTH:
 *   1. the SQLite store the batch loader reads (`/api/sqlite/store-ohlcv`) —
 *      this is what fixes Stability Mine's `DATA_STALE` condition, since the
 *      batch loader reads crypto OHLCV from SQLite, not from CSV.
 *   2. CSV files at `price-data/crypto/csv/<interval>/<SYMBOL>.csv` — IBKR-parity
 *      inspectable/backup files.
 *
 * Import hygiene: this module is imported by `vite.config.ts` and therefore
 * bundled by esbuild for the Node dev server. It MUST NOT import anything that
 * transitively reaches `lightweight-charts` (ESM-only) or `chart-manager`. In
 * particular it MUST NOT import `lib/dataProviders/binance.ts` (which pulls
 * `lib/strategies/index` → `lib/strategies/constants` → `chart-manager`). The
 * Binance kline fetcher is implemented inline using only leaf helpers. Symptom
 * of breakage: dev server fails to start with
 * `Failed to resolve "lightweight-charts". This package is ESM only`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import dns from "node:dns";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import { debugLogger } from "../debug-logger";
import { resolveBinanceApiBases } from "../binance-api-bases";
import type { BinanceMarketType } from "../binance-market";
import { fetchWithTimeoutAndRetry, isAbortError } from "../dataProviders/fetch-helpers";
import { fetchLocalApi } from "../local-api-transport";
import { encodeBinaryOhlcvRows } from "../ohlcv-binary";
import { beginNdjsonStream, HttpStatusError, readJsonBody, sendCaughtErrorJson, sendJson, type ViteHttpResponse } from "../vite-http-utils";

const APP_ROOT = process.cwd();
const CRYPTO_DATA_DIR = resolve(APP_ROOT, "price-data", "crypto");
const CRYPTO_CSV_DIR = resolve(CRYPTO_DATA_DIR, "csv");

// Force IPv4-first DNS resolution. On many Windows / NAT64 networks, Binance
// hostnames resolve to IPv6 (e.g. `64:ff9b::...`) first and Node's undici
// `fetch` tries them before falling back, producing bare "fetch failed" errors
// with no IPv6 routing in place. `ipv4first` makes the resolver return A
// records ahead of AAAA, so `fetch` connects over IPv4 immediately. This is
// benign for every other dev-server request (IPv4 works universally here) and
// composes with the Polymarket AdGuard-DoH dispatcher (`vite.config.ts`) — that
// dispatcher is host-scoped to polymarket.com and replaces the *lookup* fn, so
// the global default-result-order only affects hosts the dispatcher falls
// through to system DNS for (i.e. Binance).
dns.setDefaultResultOrder("ipv4first");

/**
 * Minimal OHLCV shape (unix-second time + OHLCV). Defined locally rather than
 * imported from `lib/types/strategies` to keep this module leaf-safe for the
 * `vite.config.ts` bundle. The stored `time` is a unix-second number.
 */
interface CryptoCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

const SQLITE_STORE_TIMEOUT_MS = 180_000;
const BINANCE_KLINE_LIMIT_MAX = 1000;
const BINANCE_FETCH_TIMEOUT_MS = 30_000;
const BINANCE_FETCH_MAX_ATTEMPTS = 3;
const BINARY_STORE_MIN_ROWS = 1024;
const MAX_TOTAL_BARS = 100_000;
const MAX_SYNC_TARGETS = 5_000;
const BINANCE_SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;
const BINANCE_NATIVE_INTERVALS = new Set([
    "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w", "1M",
]);

// ---------------------------------------------------------------------
// CSV helpers (mirror IBKR's writeCsv / getCsvPath / parseCsvCandleLines)
// ---------------------------------------------------------------------

export function getCryptoCsvPath(symbol: string, interval: string): string {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedInterval = interval.trim();
    if (!BINANCE_SYMBOL_PATTERN.test(normalizedSymbol)) {
        throw new Error(`Invalid Binance symbol: ${symbol}`);
    }
    if (!BINANCE_NATIVE_INTERVALS.has(normalizedInterval)) {
        throw new Error(`Invalid Binance interval: ${interval}`);
    }
    return resolve(CRYPTO_CSV_DIR, normalizedInterval, `${normalizedSymbol}.csv`);
}

/**
 * Atomic CSV write (temp + rename), identical format to IBKR so the same
 * loaders/inspection tools work: header `time,open,high,low,close,volume`,
 * `time` as ISO-8601 UTC, trailing newline. Exported so tests can round-trip.
 */
export function writeCryptoCsv(symbol: string, interval: string, candles: readonly CryptoCandle[]): void {
    const filePath = getCryptoCsvPath(symbol, interval);
    mkdirSync(dirname(filePath), { recursive: true });
    const rows = ["time,open,high,low,close,volume"];
    for (const candle of candles) {
        rows.push([
            new Date(candle.time * 1000).toISOString(),
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volume ?? 0,
        ].join(","));
    }
    const tempPath = `${filePath}.tmp`;
    writeFileSync(tempPath, `${rows.join("\n")}\n`);
    renameSync(tempPath, filePath);
}

/**
 * Parse the CSV format written by `writeCryptoCsv`. Header row is skipped;
 * `time` may be ISO or unix-seconds. Last-write-wins dedup by time, ascending.
 * Exported so tests can round-trip and so the plugin's incremental Sync can
 * read back the existing file to find the last bar.
 */
export function parseCryptoCsvCandleLines(lines: readonly string[]): CryptoCandle[] {
    if (lines.length <= 1) return [];
    const candles: CryptoCandle[] = [];
    for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i]!.trim();
        if (!line) continue;
        const [timeRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = line.split(",");
        const time = parseTimeToSeconds(timeRaw);
        const open = Number(openRaw);
        const high = Number(highRaw);
        const low = Number(lowRaw);
        const close = Number(closeRaw);
        const volume = Number(volumeRaw ?? 0);
        if (time === null || !Number.isFinite(open) || !Number.isFinite(high)
            || !Number.isFinite(low) || !Number.isFinite(close)) {
            continue;
        }
        candles.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    }
    return mergeCandlesByTime(candles);
}

function readCryptoCsvCandles(symbol: string, interval: string): CryptoCandle[] {
    const filePath = getCryptoCsvPath(symbol, interval);
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    return parseCryptoCsvCandleLines(lines);
}

function mergeCandlesByTime(candles: readonly CryptoCandle[]): CryptoCandle[] {
    const byTime = new Map<number, CryptoCandle>();
    for (const candle of candles) {
        byTime.set(candle.time, { ...candle });
    }
    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/**
 * Parse a time value that may be ISO-8601 or unix seconds/milliseconds into
 * unix seconds. Returns null when unparseable. Inlined (rather than importing
 * `parseTimeToUnixSeconds` from `lib/time-normalization`) only because the
 * latter is already leaf-safe — but to keep the CSV reader self-contained and
 * avoid pulling `lib/time-normalization`'s `BusinessDay` branch, a minimal
 * ISO/seconds parser is sufficient for the CSV round-trip.
 */
function parseTimeToSeconds(value: string | undefined): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    // ISO-8601 (the format writeCryptoCsv emits).
    if (/[-:T]/.test(trimmed) || trimmed.endsWith("Z")) {
        const ms = Date.parse(trimmed);
        return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    // Heuristic: milliseconds if the magnitude exceeds year 2287 in seconds.
    return numeric > 9_999_999_999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

// ---------------------------------------------------------------------
// Binance kline fetcher (inline, leaf-only)
// ---------------------------------------------------------------------

/**
 * Fetch up to `limit` most-recent Binance klines for `symbol`/`interval`,
 * optionally bounded by `endTime` (unix ms, exclusive upper bound for the
 * "until now" window — Binance returns bars with openTime < endTime when
 * paginating backward). Mirrors `lib/dataProviders/binance.ts` mapToOHLCV but
 * without the resample / marketdata transitive deps that would break the
 * `vite.config.ts` bundle. `interval` must be a Binance-native interval string
 * (e.g. "4h", "1h", "15m", "1d").
 */
async function fetchCryptoKlines(
    symbol: string,
    interval: string,
    limit: number,
    marketType: BinanceMarketType,
    endTime: number | null,
    signal?: AbortSignal,
    startTime: number | null = null,
): Promise<CryptoCandle[]> {
    const endpointPath = marketType === "futures" ? "/fapi/v1/klines" : "/api/v3/klines";
    const bases = resolveBinanceApiBases(marketType);
    const boundedLimit = Math.max(1, Math.min(BINANCE_KLINE_LIMIT_MAX, Math.floor(limit)));
    let lastError: unknown = null;
    for (const base of bases) {
        const url = new URL(`${base}${endpointPath}`);
        url.searchParams.set("symbol", symbol);
        url.searchParams.set("interval", interval);
        url.searchParams.set("limit", String(boundedLimit));
        if (endTime !== null) {
            url.searchParams.set("endTime", String(endTime));
        }
        if (startTime !== null) {
            url.searchParams.set("startTime", String(startTime));
        }
        try {
            const response = await fetchWithTimeoutAndRetry(url, { signal }, {
                timeoutMs: BINANCE_FETCH_TIMEOUT_MS,
                maxAttempts: BINANCE_FETCH_MAX_ATTEMPTS,
                signal,
            });
            if (!response.ok) {
                lastError = new Error(`Binance ${response.status} for ${symbol}`);
                continue;
            }
            const rows = await response.json() as unknown[];
            const candles: CryptoCandle[] = [];
            for (const row of rows) {
                if (!Array.isArray(row)) continue;
                const openTimeMs = Number(row[0]);
                const open = Number(row[1]);
                const high = Number(row[2]);
                const low = Number(row[3]);
                const close = Number(row[4]);
                const volume = Number(row[5]);
                if (!Number.isFinite(openTimeMs) || !Number.isFinite(open)
                    || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
                    continue;
                }
                candles.push({
                    time: Math.floor(openTimeMs / 1000),
                    open, high, low, close,
                    volume: Number.isFinite(volume) ? volume : 0,
                });
            }
            return candles;
        } catch (error) {
            lastError = error;
            if (isAbortError(error)) throw error;
            // try next base. Capture the underlying cause so the eventual error
            // message names the real failure (e.g. ECONNRESET, ConnectTimeout)
            // instead of the unhelpful bare "fetch failed" undici surfaces.
            const cause = (error as { cause?: { code?: string; host?: string } }).cause;
            if (cause) {
                lastError = new Error(`fetch failed (${cause.code ?? "unknown"}${cause.host ? ` ${cause.host}` : ""})`);
            }
        }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Binance API unavailable for ${symbol} (${marketType}) — ${detail}`);
}

/** Fetch every bar after the local tail, rather than only the latest page. */
async function fetchCryptoKlinesAfter(
    symbol: string,
    interval: string,
    lastStoredTimeMs: number,
    marketType: BinanceMarketType,
    signal?: AbortSignal,
): Promise<CryptoCandle[]> {
    const collected: CryptoCandle[] = [];
    let startTime = lastStoredTimeMs + 1;
    for (let request = 0; request < 1_000; request += 1) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const page = await fetchCryptoKlines(
            symbol,
            interval,
            BINANCE_KLINE_LIMIT_MAX,
            marketType,
            null,
            signal,
            startTime,
        );
        if (page.length === 0) break;
        collected.push(...page);
        const nextStartTime = page[page.length - 1]!.time * 1000 + 1;
        if (nextStartTime <= startTime || page.length < BINANCE_KLINE_LIMIT_MAX) break;
        startTime = nextStartTime;
    }
    return mergeCandlesByTime(collected);
}

/**
 * Backfill klines by paginating backward in chunks of 1000 until `totalBars`
 * are gathered or no older bars remain. Returns ascending candles. Used by
 * the full "Download" path.
 */
async function fetchCryptoKlinesBackfill(
    symbol: string,
    interval: string,
    totalBars: number,
    marketType: BinanceMarketType,
    signal?: AbortSignal
): Promise<CryptoCandle[]> {
    const collected: CryptoCandle[] = [];
    let endTime: number | null = null; // null = "most recent first"
    const maxRequests = Math.ceil(totalBars / BINANCE_KLINE_LIMIT_MAX) + 2;
    for (let request = 0; request < maxRequests; request += 1) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const remaining = totalBars - collected.length;
        if (remaining <= 0) break;
        const page = await fetchCryptoKlines(
            symbol,
            interval,
            Math.min(BINANCE_KLINE_LIMIT_MAX, remaining),
            marketType,
            endTime,
            signal
        );
        if (page.length === 0) break;
        for (const candle of page) {
            collected.push(candle);
        }
        // Next page: older than the oldest bar just fetched.
        const oldest = page[0]!.time;
        const nextEndTime = oldest * 1000 - 1;
        // A short page is not proof that no older data exists: alternate
        // Binance hosts have occasionally returned only the newest few rows.
        // Continue with an older endTime; a genuinely new listing then returns
        // an empty page and exits naturally.
        if (endTime === nextEndTime) break; // guard against identical endpoints
        endTime = nextEndTime;
    }
    return mergeCandlesByTime(collected).slice(-totalBars);
}

// ---------------------------------------------------------------------
// SQLite store (HTTP loop through the existing /api/sqlite/store-ohlcv)
// ---------------------------------------------------------------------

/**
 * Store candles into the SQLite DB the batch loader reads. Goes through the
 * existing `/api/sqlite/store-ohlcv` endpoint via `fetchLocalApi` so there is
 * a single DB owner (`localSqlitePlugin`) and the `series_meta` freshness
 * fingerprint is refreshed. Binary octet-stream is used for >= 1024 rows
 * (matches `lib/local-sqlite-api.ts`'s threshold); JSON otherwise.
 *
 * `fetchLocalApi` resolves relative `/api/...` URLs against the dev-server
 * origin when running in Node (see `lib/local-api-transport.ts`), so this works
 * server-side without an explicit base.
 */
async function storeCandlesViaSqlite(
    symbol: string,
    interval: string,
    candles: readonly CryptoCandle[],
    provider: string,
    source: string,
    signal?: AbortSignal
): Promise<void> {
    if (candles.length === 0) return;
    const upperSymbol = symbol.toUpperCase();
    const lowerInterval = interval.toLowerCase();
    // The SQLite plugin's POST handler matches exact path `/store-ohlcv` (mounted
    // at `/api/sqlite`, so the full URL is `/api/sqlite/store-ohlcv`). For the
    // binary branch it reads symbol/interval/provider/source from QUERY PARAMS,
    // not path segments — a path-style suffix like `/store-ohlcv/SYM/INT` makes
    // `pathname` ≠ `/store-ohlcv` and returns 404. Both branches use the exact
    // path here; binary carries symbol/interval in the query.
    const baseQuery = `?summary=1&provider=${encodeURIComponent(provider)}&source=${encodeURIComponent(source)}`
        + `&symbol=${encodeURIComponent(upperSymbol)}&interval=${encodeURIComponent(lowerInterval)}`;
    if (candles.length >= BINARY_STORE_MIN_ROWS) {
        const buffer = encodeBinaryOhlcvRows(candles);
        const response = await fetchLocalApi(
            `/api/sqlite/store-ohlcv${baseQuery}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: Buffer.from(buffer),
                signal,
            },
            SQLITE_STORE_TIMEOUT_MS
        );
        if (!response.ok) {
            throw new Error(`SQLite store failed (${response.status}) for ${upperSymbol} ${lowerInterval}`);
        }
        return;
    }
    const response = await fetchLocalApi(
        `/api/sqlite/store-ohlcv${baseQuery}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol: upperSymbol, interval: lowerInterval, candles }),
            signal,
        },
        SQLITE_STORE_TIMEOUT_MS
    );
    if (!response.ok) {
        throw new Error(`SQLite store failed (${response.status}) for ${upperSymbol} ${lowerInterval}`);
    }
}

// ---------------------------------------------------------------------
// Per-symbol sync
// ---------------------------------------------------------------------

interface SyncSymbolResult {
    symbol: string;
    interval: string;
    bars: number;
    fetchedBars: number;
    lastTime: number | null;
}

/** Default backfill bar count per interval when the caller doesn't pin one. */
const DEFAULT_TOTAL_BARS_BY_INTERVAL: Record<string, number> = {
    "1m": 50_000,
    "15m": 30_000,
    "30m": 30_000,
    "1h": 20_000,
    "4h": 20_000,
    "1d": 5_000,
};

/**
 * Sync one symbol. `syncOnly=true` (Sync Latest) does an incremental gap-fill
 * from the last stored bar; `syncOnly=false` (Download) does a bounded full
 * backfill. In both cases the merged result is written to CSV + SQLite.
 */
async function syncOneSymbol(
    symbol: string,
    interval: string,
    totalBars: number,
    marketType: BinanceMarketType,
    syncOnly: boolean,
    signal?: AbortSignal
): Promise<SyncSymbolResult> {
    // Preserve a healthy existing CSV even if a provider returns a transiently
    // short page during Download. The SQLite store is merge-based too.
    const existing = readCryptoCsvCandles(symbol, interval);
    let fetched: CryptoCandle[];
    if (syncOnly && existing.length > 0) {
        const lastStoredTimeMs = existing[existing.length - 1]!.time * 1000;
        fetched = await fetchCryptoKlinesAfter(symbol, interval, lastStoredTimeMs, marketType, signal);
    } else {
        fetched = await fetchCryptoKlinesBackfill(symbol, interval, totalBars, marketType, signal);
    }
    const merged = mergeCandlesByTime([...existing, ...fetched]);
    if (merged.length === 0) {
        return { symbol, interval, bars: 0, fetchedBars: 0, lastTime: null };
    }
    writeCryptoCsv(symbol, interval, merged);
    await storeCandlesViaSqlite(symbol, interval, merged, "Binance", syncOnly ? "crypto-sync" : "crypto-download", signal);
    return {
        symbol,
        interval,
        bars: merged.length,
        fetchedBars: fetched.length,
        lastTime: merged[merged.length - 1]!.time,
    };
}

// ---------------------------------------------------------------------
// Owner-lock + NDJSON + status-snapshot (mirrors IBKR plugin)
// ---------------------------------------------------------------------

export type CryptoSyncRunState = {
    startedAt: string;
    mode: "sync" | "download";
    interval: string;
    marketType: BinanceMarketType;
    total: number;
    index: number;
    completed: number;
    failed: number;
    currentSymbol: string | null;
    currentInterval: string | null;
    failedSymbols: Array<{ symbol: string; error: string }>;
    cancelled: boolean;
};

const SYNC_OWNER_NONE = 0;
let syncOwner = SYNC_OWNER_NONE;
let syncOwnerGen = 0;
let syncRunState: CryptoSyncRunState | null = null;
let syncAbortController: AbortController | null = null;

type SyncStreamEvent = Record<string, unknown> & { type: string };
type SyncStreamWriter = (event: SyncStreamEvent) => void;

function normalizeSymbols(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        const text = String(item ?? "").trim().toUpperCase();
        if (!text || seen.has(text)) continue;
        if (!BINANCE_SYMBOL_PATTERN.test(text)) {
            throw new HttpStatusError(400, `Invalid Binance symbol: ${String(item ?? "")}`);
        }
        seen.add(text);
        out.push(text);
    }
    return out;
}

function normalizeInterval(value: unknown): string {
    const interval = String(value ?? "4h").trim();
    if (!BINANCE_NATIVE_INTERVALS.has(interval)) {
        throw new HttpStatusError(400, `Unsupported Binance interval: ${interval || "(empty)"}`);
    }
    return interval;
}

function resolveTotalBars(value: unknown, interval: string): number {
    const explicit = Number(value);
    const resolved = (Number.isFinite(explicit) && explicit > 0 ? explicit : 0)
        || DEFAULT_TOTAL_BARS_BY_INTERVAL[interval]
        || DEFAULT_TOTAL_BARS_BY_INTERVAL["4h"]!;
    return Math.max(1, Math.min(MAX_TOTAL_BARS, Math.floor(resolved)));
}

interface CryptoSyncTargetRequest {
    symbol: string;
    interval: string;
    totalBars: number;
}

function normalizeSyncTargets(body: Record<string, unknown>): CryptoSyncTargetRequest[] {
    if (!Array.isArray(body.targets)) {
        const interval = normalizeInterval(body.interval);
        const totalBars = resolveTotalBars(body.totalBars, interval);
        const symbols = normalizeSymbols(body.symbols ?? body.symbol);
        if (symbols.length > MAX_SYNC_TARGETS) {
            throw new HttpStatusError(400, `Too many crypto sync targets; maximum is ${MAX_SYNC_TARGETS}.`);
        }
        return symbols.map((symbol) => ({ symbol, interval, totalBars }));
    }

    if (body.targets.length > MAX_SYNC_TARGETS) {
        throw new HttpStatusError(400, `Too many crypto sync targets; maximum is ${MAX_SYNC_TARGETS}.`);
    }

    const seen = new Set<string>();
    const targets: CryptoSyncTargetRequest[] = [];
    for (const raw of body.targets) {
        if (!raw || typeof raw !== "object") {
            throw new HttpStatusError(400, "Each crypto sync target must be an object.");
        }
        const candidate = raw as Record<string, unknown>;
        const symbols = normalizeSymbols([candidate.symbol]);
        if (symbols.length !== 1) {
            throw new HttpStatusError(400, "Each crypto sync target requires a symbol.");
        }
        const interval = normalizeInterval(candidate.interval);
        const key = `${symbols[0]}|${interval}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({
            symbol: symbols[0]!,
            interval,
            totalBars: resolveTotalBars(candidate.totalBars, interval),
        });
    }
    return targets;
}

function resolveMarketType(value: unknown): BinanceMarketType {
    return value === "futures" ? "futures" : "spot";
}

/**
 * Core batch loop, factored out of the HTTP handler so it can be tested. The
 * NDJSON writer is the only thing that depends on the HTTP response. The
 * `owner` param keys cancellation: the loop bails as soon as
 * `syncOwner !== owner` (Stop or a newer sync).
 */
export async function processCryptoSyncBatch(
    body: Record<string, unknown>,
    syncOnly: boolean,
    writer: SyncStreamWriter,
    owner: number,
    options?: {
        fetcher?: typeof syncOneSymbol;
        signal?: AbortSignal;
    }
): Promise<void> {
    const fetcher = options?.fetcher ?? syncOneSymbol;
    const signal = options?.signal;
    const targets = normalizeSyncTargets(body);
    const marketType = resolveMarketType(body.marketType);
    const intervals = Array.from(new Set(targets.map((target) => target.interval)));
    const runInterval = intervals.length === 1 ? intervals[0]! : "mixed";

    syncRunState = {
        startedAt: new Date().toISOString(),
        mode: syncOnly ? "sync" : "download",
        interval: runInterval,
        marketType,
        total: targets.length,
        index: 0,
        completed: 0,
        failed: 0,
        currentSymbol: null,
        currentInterval: null,
        failedSymbols: [],
        cancelled: false,
    };
    const runState = syncRunState;

    writer({ type: "start", total: targets.length, interval: runInterval, marketType, mode: syncOnly ? "sync" : "download" });

    const results: SyncSymbolResult[] = [];
    const failed: Array<{ symbol: string; interval: string; error: string }> = [];
    let cancelled = false;
    const lostOwnership = () => syncOwner !== owner;

    try {
        for (let index = 0; index < targets.length; index += 1) {
            if (lostOwnership() || signal?.aborted) {
                cancelled = true;
                if (syncRunState === runState) runState.cancelled = true;
                break;
            }
            const target = targets[index]!;
            const { symbol, interval, totalBars } = target;
            if (syncRunState === runState) {
                runState.index = index;
                runState.currentSymbol = symbol;
                runState.currentInterval = interval;
            }
            try {
                const result = await fetcher(symbol, interval, totalBars, marketType, syncOnly, signal);
                if (lostOwnership() || signal?.aborted) {
                    cancelled = true;
                    if (syncRunState === runState) runState.cancelled = true;
                    break;
                }
                results.push(result);
                if (syncRunState === runState) runState.completed += 1;
                writer({ type: "symbol", index, total: targets.length, ...result });
            } catch (error) {
                if (isAbortError(error) || signal?.aborted) {
                    cancelled = true;
                    if (syncRunState === runState) runState.cancelled = true;
                    break;
                }
                const message = error instanceof Error ? error.message : String(error);
                debugLogger.warn("crypto.sync.symbol.failed", {
                    target: "crypto",
                    symbol, interval, marketType,
                    mode: syncOnly ? "sync" : "download",
                    error: message,
                });
                failed.push({ symbol, interval, error: message });
                if (syncRunState === runState) {
                    runState.failed += 1;
                    runState.failedSymbols.push({ symbol, error: message });
                }
                writer({ type: "symbol_failed", index, total: targets.length, symbol, interval, error: message });
            }
        }
    } finally {
        if (syncRunState === runState) {
            runState.index = runState.completed + runState.failed;
            runState.currentSymbol = null;
            runState.currentInterval = null;
        }
    }

    writer({
        type: "done",
        ok: failed.length === 0 && !cancelled,
        cancelled,
        interval: runInterval,
        marketType,
        totals: {
            bars: results.reduce((sum, row) => sum + row.bars, 0),
            fetchedBars: results.reduce((sum, row) => sum + row.fetchedBars, 0),
        },
        results,
        failed,
    });
}

async function handleCryptoSyncRequest(
    res: ViteHttpResponse,
    body: Record<string, unknown>,
    syncOnly: boolean
): Promise<void> {
    if (syncOwner !== SYNC_OWNER_NONE) {
        throw new HttpStatusError(409, "A crypto sync is already running. Use Stop first.");
    }
    const owner = ++syncOwnerGen;
    syncOwner = owner;
    const abortController = new AbortController();
    syncAbortController = abortController;
    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processCryptoSyncBatch(body, syncOnly, stream.write, owner, { signal: abortController.signal });
        stream.end();
    } catch (error) {
        if (!stream) throw error;
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("crypto.sync.fatal", {
            target: "crypto",
            mode: syncOnly ? "sync" : "download",
            error: message,
        });
        try {
            stream.end({ type: "fatal", error: message });
        } catch {
            // Best-effort: the connection is likely already gone.
        }
    } finally {
        if (syncOwner === owner) {
            syncOwner = SYNC_OWNER_NONE;
        }
        if (syncAbortController === abortController) {
            syncAbortController = null;
        }
        if (syncRunState && syncOwner === SYNC_OWNER_NONE) {
            syncRunState = null;
        }
    }
}

/** Reset all module-level sync state. Exported for test isolation. */
export function __resetCryptoSyncStateForTests(): void {
    syncAbortController?.abort();
    syncOwner = SYNC_OWNER_NONE;
    syncOwnerGen = 0;
    syncRunState = null;
    syncAbortController = null;
}

/**
 * Acquire the sync lock for `processCryptoSyncBatch` in tests. Mirrors what
 * `handleCryptoSyncRequest` does (bumps the generation and sets the owner) so
 * the batch's `lostOwnership()` check doesn't immediately bail. Pair with
 * `__resetCryptoSyncStateForTests` in `afterEach`/`beforeEach`.
 */
export function __acquireCryptoSyncOwnerForTests(): number {
    const owner = ++syncOwnerGen;
    syncOwner = owner;
    return owner;
}

// ---------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------

export function cryptoDataVitePlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use("/api/crypto/download", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                await handleCryptoSyncRequest(res as ViteHttpResponse, await readJsonBody(req), false);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        // NOTE: Vite's Connect `use(path)` prefix-matches, so the more-specific
        // `/api/crypto/sync/status` MUST be registered before `/api/crypto/sync`
        // — otherwise the /sync handler claims GET /sync/status and returns 405,
        // breaking browser reattach. (This is a robustness improvement over the
        // IBKR plugin, which registers them in the shadowing order.)
        middlewares.use("/api/crypto/sync/status", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                running: syncRunState !== null,
                run: syncRunState,
            });
        });

        middlewares.use("/api/crypto/sync", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                await handleCryptoSyncRequest(res as ViteHttpResponse, await readJsonBody(req), true);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/crypto/stop", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            // Keep ownership until the aborted run unwinds. Releasing it here
            // would allow a second run to overlap CSV/SQLite writes from the
            // first run.
            const stopped = syncOwner !== SYNC_OWNER_NONE;
            syncAbortController?.abort();
            sendJson(res, 200, { ok: true, stopped });
        });
    };

    return {
        name: "crypto-data",
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}
