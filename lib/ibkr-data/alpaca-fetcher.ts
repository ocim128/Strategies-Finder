/**
 * Alpaca stock-bars fetcher — an alternate *source* for the IBKR Data pipeline.
 *
 * Why a leaf module: it lives under `lib/ibkr-data/` next to the server plugin
 * that consumes it, but it reaches only the type/HTTP/debug-logger/time leaves
 * — NOT `lib/constants.ts`, `lib/chart-manager.ts`, or any browser-bound
 * module. That isolation is mandatory: this file is transitively imported by
 * `lib/ibkr-data/ibkr-data-vite-plugin.ts`, which is bundled by esbuild when
 * Vite bundles `vite.config.ts` for the Node dev server. Pulling in
 * `lightweight-charts` (ESM-only) here would break `vite dev` startup with the
 * same bundle trap documented in AGENTS.md for the Batch / Finder plugins.
 *
 * The fetcher is intentionally provider-shaped (no IBKR coupling): the plugin
 * selects it based on `source: "alpaca"` in the request body and reuses the
 * existing CSV/catalog/invalidation contracts downstream.
 *
 * Security contract:
 *  - Credentials are read ONLY from `process.env.ALPACA_API_KEY` /
 *    `ALPACA_API_SECRET`. They never leave the process: not in catalog JSON,
 *    not in CSV, not in NDJSON events, not in debug logs.
 *  - The auth header is constructed in `buildAlpacaHeaders` (not exported) and
 *    is only present on the outbound `fetch`. No public function returns it.
 *  - URLs in logs omit query-string secrets (Alpaca's auth is header-based,
 *    but we keep the discipline anyway).
 */
import { createRequire } from "node:module";
import { debugLogger } from "../debug-logger";
import { createFetchTimeoutSignal, isAbortError } from "../dataProviders/fetch-helpers";
import { HttpStatusError } from "../vite-http-utils";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/strategies";

/** Public Alpaca market-data host (free-tier IEX feed lives here). */
export const ALPACA_DATA_HOST = "https://data.alpaca.markets";
/** Stock bars endpoint (the market-data API, NOT the paper-trading API). */
const ALPACA_STOCK_BARS_PATH = "/v2/stocks/{symbol}/bars";
/** Only 30m bars are in scope for the initial Alpaca path. */
export const ALPACA_SUPPORTED_INTERVAL = "30m";
/** Alpaca `timeframe` token for a 30-minute bar. */
export const ALPACA_TIMEFRAME_BY_INTERVAL: Record<string, string> = {
    "30m": "30Min",
};
/** Default feed + adjustment. Overridable by server env, never by request body. */
export const ALPACA_DEFAULT_FEED = "iex";
export const ALPACA_DEFAULT_ADJUSTMENT = "split";
/** Alpaca returns at most 10,000 bars per page; we cap at the documented max. */
const ALPACA_PAGE_LIMIT_MAX = 10_000;
const ALPACA_DEFAULT_PAGE_LIMIT = 10_000;
/** Per-request timeout. Composed with the caller's abort signal. */
const ALPACA_REQUEST_TIMEOUT_MS = 30_000;
/** Bounded retry policy for transient failures (network errors + 429). */
const ALPACA_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
/** Hard ceiling on pages per symbol so a misbehaving API cannot loop forever. */
const ALPACA_MAX_PAGES_PER_SYMBOL = 200;

/** HTTP statuses that are NOT retried. Everything else is considered transient. */
const ALPACA_NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);
type UndiciAgent = new (options: { connect: { family: 4 } }) => unknown;
const requireFromAlpacaFetcher = createRequire(import.meta.url);
let alpacaIpv4Dispatcher: unknown | undefined;
let undiciUnavailable = false;

function getAlpacaIpv4Dispatcher(url: string): unknown | undefined {
    if (new URL(url).origin !== ALPACA_DATA_HOST || undiciUnavailable) return undefined;
    if (alpacaIpv4Dispatcher) return alpacaIpv4Dispatcher;
    try {
        const { Agent } = requireFromAlpacaFetcher("undici") as { Agent: UndiciAgent };
        alpacaIpv4Dispatcher = new Agent({ connect: { family: 4 } });
        return alpacaIpv4Dispatcher;
    } catch {
        undiciUnavailable = true;
        return undefined;
    }
}

/** Configuration built once per process (env-sourced); never serialized. */
export type AlpacaConfig = {
    apiKey: string;
    apiSecret: string;
    host: string;
    feed: string;
    adjustment: string;
};

/**
 * Reads Alpaca credentials and server-side defaults from the environment.
 * Throws a 500-shaped error if credentials are missing — the caller surfaces
 * it in the existing UI failure path. Server-side only: never import this
 * from browser code.
 */
export function resolveAlpacaConfig(env: NodeJS.ProcessEnv = process.env): AlpacaConfig {
    const apiKey = String(env.ALPACA_API_KEY ?? "").trim();
    const apiSecret = String(env.ALPACA_API_SECRET ?? "").trim();
    if (!apiKey || !apiSecret) {
        throw new HttpStatusError(
            500,
            "Alpaca credentials are not configured on the server. Set ALPACA_API_KEY and ALPACA_API_SECRET in the server environment.",
        );
    }
    return {
        apiKey,
        apiSecret,
        host: String(env.ALPACA_DATA_HOST ?? ALPACA_DATA_HOST).replace(/\/+$/, ""),
        feed: String(env.ALPACA_FEED ?? ALPACA_DEFAULT_FEED).trim() || ALPACA_DEFAULT_FEED,
        adjustment: String(env.ALPACA_ADJUSTMENT ?? ALPACA_DEFAULT_ADJUSTMENT).trim() || ALPACA_DEFAULT_ADJUSTMENT,
    };
}

/**
 * Builds the Alpaca bars URL for one page. `start`/`end` are RFC3339 strings
 * (Alpaca accepts ISO-8601). `pageToken` is the opaque `next_page_token` from
 * a prior response. Exported for unit tests; the auth header is intentionally
 * NOT part of this builder so tests never need to handle secrets.
 */
export function buildAlpacaBarsUrl(
    config: Pick<AlpacaConfig, "host" | "feed" | "adjustment">,
    args: {
        symbol: string;
        timeframe: string;
        start?: string;
        end?: string;
        limit?: number;
        pageToken?: string;
    },
): string {
    const params = new URLSearchParams({
        timeframe: args.timeframe,
        sort: "asc",
        feed: config.feed,
        adjustment: config.adjustment,
        limit: String(Math.min(ALPACA_PAGE_LIMIT_MAX, Math.max(1, Math.floor(args.limit ?? ALPACA_DEFAULT_PAGE_LIMIT)))),
    });
    if (args.start) params.set("start", args.start);
    if (args.end) params.set("end", args.end);
    if (args.pageToken) params.set("page_token", args.pageToken);
    const path = ALPACA_STOCK_BARS_PATH.replace("{symbol}", encodeURIComponent(args.symbol.toUpperCase()));
    return `${config.host}${path}?${params.toString()}`;
}

/**
 * Constructs the auth header. NOT exported — the header carries credentials
 * and must not leak into logs, URLs, or response payloads.
 */
function buildAlpacaHeaders(config: Pick<AlpacaConfig, "apiKey" | "apiSecret">): Record<string, string> {
    return {
        Accept: "application/json",
        "APCA-API-KEY-ID": config.apiKey,
        "APCA-API-SECRET-KEY": config.apiSecret,
    };
}

/** A single Alpaca bar row as returned by the API (subset of fields we read). */
type AlpacaBarRow = {
    t?: string | number;
    o?: number | string;
    h?: number | string;
    l?: number | string;
    c?: number | string;
    v?: number | string | null;
};

/** Alpaca bars response shape. */
type AlpacaBarsResponse = {
    bars?: AlpacaBarRow[];
    next_page_token?: string | null;
    symbol?: string;
};

/**
 * Normalizes raw Alpaca bar rows into `OHLCVData[]` with Unix-second times.
 * Drops rows with invalid OHLC; treats missing/invalid volume as `0`. Does
 * NOT dedup by time — the paged fetch loop folds rows into a `Map<number,
 * OHLCVData>` (last-write-wins) so duplicate timestamps across pages collapse
 * there. Exported for unit tests.
 */
export function normalizeAlpacaBars(rows: readonly AlpacaBarRow[]): OHLCVData[] {
    const candles: OHLCVData[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const time = parseTimeToUnixSeconds(row.t);
        const open = Number(row.o);
        const high = Number(row.h);
        const low = Number(row.l);
        const close = Number(row.c);
        const rawVolume = row.v === null ? undefined : Number(row.v);
        if (time === null
            || !Number.isFinite(open)
            || !Number.isFinite(high)
            || !Number.isFinite(low)
            || !Number.isFinite(close)) {
            continue;
        }
        candles.push({
            time: time as OHLCVData["time"],
            open,
            high,
            low,
            close,
            volume: Number.isFinite(rawVolume as number) ? (rawVolume as number) : 0,
        });
    }
    return candles;
}

/**
 * Parses the JSON body of an Alpaca bars response. Returns `{ bars,
 * nextPageToken }`. Exported for unit tests.
 */
export function parseAlpacaBarsResponse(payload: unknown): {
    bars: AlpacaBarRow[];
    nextPageToken: string | null;
} {
    const value = payload && typeof payload === "object" ? payload as AlpacaBarsResponse : {};
    const rows = Array.isArray(value.bars) ? value.bars as AlpacaBarRow[] : [];
    const token = typeof value.next_page_token === "string" && value.next_page_token.trim()
        ? value.next_page_token.trim()
        : null;
    return { bars: rows, nextPageToken: token };
}

/**
 * True if the HTTP status is retryable for Alpaca. Network-layer errors are
 * handled separately by the caller (they always look transient unless aborted).
 */
export function isRetryableAlpacaStatus(status: number): boolean {
    if (ALPACA_NON_RETRYABLE_STATUSES.has(status)) return false;
    return status === 429 || status >= 500;
}

/**
 * One page fetch. Returns the parsed body, the HTTP status, and the number of
 * retry attempts it took (for telemetry). Throws `HttpStatusError` for
 * non-2xx after exhausting retries; aborts propagate as `AbortError`.
 *
 * Timeout scope: `createFetchTimeoutSignal` is composed with the caller's
 * abort signal and is cleared in a `finally` AFTER `response.json()` /
 * `response.text()` completes. A stalled response body therefore still
 * aborts within `ALPACA_REQUEST_TIMEOUT_MS`, not after the body finishes.
 *
 * Retry classification (audit Finding 3):
 *  - User-initiated abort (`signal.aborted`) → rethrown immediately, no retry.
 *  - Transient network/timeout errors (`TypeError`, `TimeoutError` from the
 *    fetch signal but NOT triggered by the user's signal) → retried with the
 *    bounded policy below.
 */
async function fetchAlpacaBarsPage(
    config: AlpacaConfig,
    url: string,
    signal?: AbortSignal,
): Promise<{ bars: AlpacaBarRow[]; nextPageToken: string | null; status: number; retries: number }> {
    const headers = buildAlpacaHeaders(config);
    let lastError: unknown = null;
    let attempts = 0;
    let retries = 0;
    for (let retry = 0; retry <= ALPACA_RETRY_DELAYS_MS.length; retry += 1) {
        attempts = retry + 1;
        if (signal?.aborted) {
            throw (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("Aborted");
        }
        const timeout = createFetchTimeoutSignal(signal, ALPACA_REQUEST_TIMEOUT_MS);
        let response: Response;
        try {
            const dispatcher = getAlpacaIpv4Dispatcher(url);
            const requestInit: RequestInit & { dispatcher?: unknown } = {
                method: "GET",
                headers,
                signal: timeout.signal,
                ...(dispatcher ? { dispatcher } : {}),
            };
            response = await fetch(url, requestInit);
        } catch (error) {
            // The fetch itself threw before headers arrived. Distinguish a
            // user-initiated abort (propagate, no retry) from a transient
            // network/timeout error (retry). `!signal?.aborted` means the
            // fetch was NOT killed by the user's Stop — a per-request timeout
            // or a network error is a transient retryable condition.
            timeout.cleanup();
            const userAborted = signal?.aborted;
            const timedOut = !userAborted && isTimeoutSignalError(error);
            if (userAborted) throw error;
            lastError = error;
            if (retry >= ALPACA_RETRY_DELAYS_MS.length) {
                const label = timedOut ? "timed out" : "failed";
                throw new HttpStatusError(502, `Alpaca request ${label} after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
            }
            retries += 1;
            await abortableDelay(ALPACA_RETRY_DELAYS_MS[retry]!, signal);
            continue;
        }
        // Body parsing happens INSIDE the timeout's scope so a stalled body
        // still aborts within ALPACA_REQUEST_TIMEOUT_MS (audit Finding 3).
        // A body-parse failure that looks like a timeout/network error is
        // retried like the fetch-stage failures above; a user abort always
        // propagates without retry.
        try {
            if (response.ok) {
                const payload = await response.json() as unknown;
                const parsed = parseAlpacaBarsResponse(payload);
                return { ...parsed, status: response.status, retries };
            }
            // Non-OK: read the body once for the error message (then drop it).
            const text = await response.text().catch(() => "");
            if (!isRetryableAlpacaStatus(response.status) || retry >= ALPACA_RETRY_DELAYS_MS.length) {
                const detail = text.slice(0, 300);
                throw new HttpStatusError(
                    mapAlpacaStatusToHttpStatus(response.status),
                    `Alpaca request failed (${response.status}) for the requested symbol.${detail ? ` ${detail}` : ""}`,
                );
            }
            lastError = new HttpStatusError(response.status, `Alpaca transient ${response.status}: ${text.slice(0, 200)}`);
            // Respect Retry-After when present on 429.
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            // Before sleeping, check user abort again — the response arrived
            // but we may now back off, and Stop should still be honored.
            if (signal?.aborted) {
                throw (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("Aborted");
            }
            retries += 1;
            await abortableDelay(retryAfterMs ?? ALPACA_RETRY_DELAYS_MS[retry]!, signal);
        } catch (error) {
            // An HttpStatusError we just constructed carries the actionable
            // status mapping — propagate it as-is so the UI sees 401/400/502.
            if (error instanceof HttpStatusError) throw error;
            // Body-parse-stage transient error (timeout/network). Same
            // classification as the fetch-stage catch above.
            const userAborted = signal?.aborted;
            if (userAborted) throw error;
            lastError = error;
            if (retry >= ALPACA_RETRY_DELAYS_MS.length) {
                const timedOut = isTimeoutSignalError(error);
                const label = timedOut ? "timed out reading body" : "failed reading body";
                throw new HttpStatusError(502, `Alpaca request ${label} after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
            }
            retries += 1;
            await abortableDelay(ALPACA_RETRY_DELAYS_MS[retry]!, signal);
            continue;
        } finally {
            timeout.cleanup();
        }
    }
    // Unreachable: the loop either returns or throws. Defensive fallback.
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
    throw new HttpStatusError(502, `Alpaca request exhausted retries (attempt ${attempts}): ${message}; retries=${retries}`);
}

/**
 * True if the error is the shape `createFetchTimeoutSignal` produces when the
 * per-request timeout fires (a `TimeoutError`-named error). Used to classify
 * a fetch throw as a transient retryable timeout rather than a user abort.
 * The user's own abort surfaces as `signal.aborted === true` at the call site
 * and is propagated without retry.
 */
function isTimeoutSignalError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const name = (error as { name?: string }).name;
    return name === "TimeoutError";
}

function mapAlpacaStatusToHttpStatus(status: number): number {
    // Keep auth/config/empty-symbol errors actionable in the UI.
    if (status === 401 || status === 403) return 401;
    if (status === 422) return 400;
    if (status === 404) return 404;
    return 502;
}

function parseRetryAfterMs(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
    return null;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) {
        return Promise.reject((signal as AbortSignal & { reason?: unknown }).reason ?? new Error("Aborted"));
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject((signal as AbortSignal & { reason?: unknown })?.reason ?? new Error("Aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Result returned to the IBKR sync pipeline (mirrors `HistoricalFetchResult`). */
export type AlpacaFetchResult = {
    candles: OHLCVData[];
    /**
     * True only when the fetch covered the full requested window. A page-
     * ceiling hit (the bounded window produced more than
     * `ALPACA_MAX_PAGES_PER_SYMBOL` pages) is `false` so the catalog and UI
     * do NOT mark truncated data as complete (audit Finding 1).
     */
    complete: boolean;
    /**
     * - `covered`: bounded window paged to completion (no `next_page_token`)
     * - `cancelled`: aborted by Stop / newer sync
     * - `page_limit`: hit `ALPACA_MAX_PAGES_PER_SYMBOL` before exhausting
     *   `next_page_token` → the dataset is truncated. The caller maps this to
     *   the catalog schema's `chunk_limit` value when persisting.
     */
    stopReason: "covered" | "cancelled" | "page_limit";
    pages: number;
    /** Total retry attempts across all pages (audit Finding 4). */
    retries: number;
};

/**
 * Fetches all 30m bars for one symbol within `[start, end]`, paging through
 * `next_page_token` until exhausted or the page ceiling is hit. `start`/`end`
 * are ISO-8601 strings; the caller computes them from the requested period,
 * including the app-level `max` period's full-range window.
 *
 * Cancellation: every page boundary and every retry wait observes `signal`.
 * An abort surfaces as `stopReason: "cancelled"` with whatever bars landed.
 *
 * Page ceiling (audit Finding 1): if `next_page_token` is still present after
 * `ALPACA_MAX_PAGES_PER_SYMBOL` pages, the result is `complete: false` +
 * `stopReason: "page_limit"` + a warn-level log. The caller treats this as
 * a landed-but-incomplete dataset (the existing `symbol_warning` path), NOT
 * as a complete history.
 */
export async function fetchAlpacaBars(
    config: AlpacaConfig,
    args: {
        symbol: string;
        timeframe: string;
        start: string;
        end: string;
        limit?: number;
    },
    signal?: AbortSignal,
): Promise<AlpacaFetchResult> {
    const startedAt = Date.now();
    const byTime = new Map<number, OHLCVData>();
    let pages = 0;
    let totalRetries = 0;
    let pageToken: string | undefined;
    for (let page = 0; page < ALPACA_MAX_PAGES_PER_SYMBOL; page += 1) {
        if (signal?.aborted) {
            return finalizeAlpaca(byTime, pages, totalRetries, "cancelled", config, args.symbol, startedAt);
        }
        const url = buildAlpacaBarsUrl(config, {
            symbol: args.symbol,
            timeframe: args.timeframe,
            start: args.start,
            end: args.end,
            limit: args.limit,
            pageToken,
        });
        let pageResult: { bars: AlpacaBarRow[]; nextPageToken: string | null; status: number; retries: number };
        try {
            pageResult = await fetchAlpacaBarsPage(config, url, signal);
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                return finalizeAlpaca(byTime, pages, totalRetries, "cancelled", config, args.symbol, startedAt);
            }
            throw error;
        }
        pages += 1;
        totalRetries += pageResult.retries;
        for (const row of pageResult.bars) {
            for (const candle of normalizeAlpacaBars([row])) {
                const time = Number(candle.time);
                if (Number.isFinite(time)) byTime.set(time, candle);
            }
        }
        if (!pageResult.nextPageToken) {
            return finalizeAlpaca(byTime, pages, totalRetries, "covered", config, args.symbol, startedAt);
        }
        pageToken = pageResult.nextPageToken;
    }
    // Hit the page ceiling: `next_page_token` was still present after
    // `ALPACA_MAX_PAGES_PER_SYMBOL` pages. The dataset is TRUNCATED — mark it
    // incomplete so the caller surfaces a warning instead of silently writing
    // partial history as a complete interval (audit Finding 1).
    debugLogger.warn("alpaca.fetch.pageCeiling", {
        target: "alpaca",
        symbol: args.symbol,
        pages,
        bars: byTime.size,
        retries: totalRetries,
    });
    return finalizeAlpaca(byTime, pages, totalRetries, "page_limit", config, args.symbol, startedAt);
}

function finalizeAlpaca(
    byTime: Map<number, OHLCVData>,
    pages: number,
    retries: number,
    stopReason: "covered" | "cancelled" | "page_limit",
    config: AlpacaConfig,
    symbol: string,
    startedAt: number,
): AlpacaFetchResult {
    const candles = Array.from(byTime.values()).sort((a, b) => Number(a.time) - Number(b.time));
    debugLogger.info("alpaca.fetch.symbol", {
        target: "alpaca",
        // Log only non-secret context. Credentials are never logged.
        host: config.host,
        feed: config.feed,
        adjustment: config.adjustment,
        symbol,
        bars: candles.length,
        pages,
        retries,
        stopReason,
        durationMs: Date.now() - startedAt,
    });
    return {
        candles,
        complete: stopReason === "covered",
        stopReason,
        pages,
        retries,
    };
}
