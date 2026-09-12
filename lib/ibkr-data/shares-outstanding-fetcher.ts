/**
 * EDGAR shares-outstanding + Alpaca corporate-actions (splits) fetcher for the
 * market-cap dataset (docs/marketcap-download.md).
 *
 * Why a leaf module: it lives under `lib/ibkr-data/` next to the server plugin
 * that consumes it, but it reaches only the fs/HTTP/debug-logger leaves plus
 * `alpaca-fetcher.ts` (itself a proven leaf) — NOT `lib/constants.ts`,
 * `lib/chart-manager.ts`, or any browser-bound module. That isolation is
 * mandatory: this file is transitively imported by
 * `lib/ibkr-data/ibkr-data-vite-plugin.ts`, which is bundled by esbuild when
 * Vite bundles `vite.config.ts` for the Node dev server. Pulling in
 * `lightweight-charts` (ESM-only) here would break `vite dev` startup with the
 * bundle trap documented in AGENTS.md.
 *
 * Split-factor convention (docs/marketcap-download.md, non-negotiable): every
 * split factor in this module is a SHARE-COUNT multiplier (a 10:1 split has
 * factor 10). Local 1d bars are split-adjusted prices
 * (`barPrice(t) = rawPrice(t) / F(t → now)`); EDGAR counts are raw
 * (`edgarShares(t) = rawShares(t)`), so the count paired with adjusted prices
 * is `adjustedShares(t) = edgarShares(t) × F(t → now)` — MULTIPLY, never
 * divide. Numeric invariant (locked by tests):
 * `barPrice(t) × adjustedShares(t) === rawPrice(t) × rawShares(t)`.
 *
 * Point-in-time semantics: EDGAR facts are keyed by their `filed` date
 * (availability), never backdated to `end` (measurement). A trading day uses
 * the latest fact with `filed ≤ tradingDay`; days before the first filing are
 * skipped, keeping a historical replay free of look-ahead.
 *
 * Security contract:
 *  - EDGAR is keyless; the `User-Agent` below is a descriptive contact string
 *    (SEC fair-access policy), not a secret.
 *  - Alpaca credentials are read ONLY inside `resolveAlpacaConfig()` (imported
 *    from `alpaca-fetcher.ts`) and only appear on the outbound `fetch` header.
 *    They never reach URLs, the tickers disk cache, catalog JSON, CSV, NDJSON,
 *    or debug logs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { debugLogger } from "../debug-logger";
import { createFetchTimeoutSignal } from "../dataProviders/fetch-helpers";
import { HttpStatusError } from "../vite-http-utils";
import { getAlpacaIpv4Dispatcher, type AlpacaConfig } from "./alpaca-fetcher";

/** SEC EDGAR bulk ticker→CIK map (keyless). */
export const EDGAR_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
/** SEC XBRL company-concept host. */
export const EDGAR_DATA_HOST = "https://data.sec.gov";
/**
 * Descriptive static User-Agent for EDGAR fair access (a contact string, NOT
 * a secret). Format matters: SEC's documented convention is
 * "Name adminContact@domain" and www.sec.gov rejects UAs without an @ contact
 * with a misleading "Request Rate Threshold Exceeded" page (verified live —
 * data.sec.gov tolerates more, www.sec.gov/files does not).
 */
export const EDGAR_USER_AGENT = "Strategies-Finder Research admin@localhost.local";
/** dei cover-page tag: shares outstanding as reported on 10-Q/10-K covers. */
export const EDGAR_SHARES_OUTSTANDING_TAG = "dei/EntityCommonStockSharesOutstanding";
/**
 * EDGAR fair-access: keep requests ≥150 ms apart (well under the published
 * ~10 req/s guidance).
 */
export const EDGAR_MIN_REQUEST_SPACING_MS = 150;
/** Tick disk cache age ceiling; older caches are refreshed from EDGAR. */
export const TICKERS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Alpaca corporate-actions endpoint (same data host + header auth as bars). */
const ALPACA_CORPORATE_ACTIONS_PATH = "/v1/corporate-actions";
/**
 * Split queries always pass an explicit window: without dates the endpoint
 * defaults to a narrow recent window (verified live — NVDA's 2024 split is
 * invisible without `start`/`end`). 2000-01-01 predates every EDGAR dei fact
 * window we join against; splits earlier than a fact's filed date are no-ops.
 */
const ALPACA_SPLITS_QUERY_START = "2000-01-01";
/** The corporate-actions endpoint caps `limit` at 1000 (verified live). */
const ALPACA_SPLITS_PAGE_LIMIT = 1000;
/** Per-request timeout, composed with the caller's abort signal. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Bounded retry policy for transient failures (network errors + 429/5xx). */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
/** HTTP statuses that are NOT retried. Everything else 429/5xx is transient. */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404]);

/** One point of the point-in-time shares-outstanding step function. */
export type SharesFactPoint = {
    /** Availability date (YYYY-MM-DD): the fact applies from its filing date. */
    filed: string;
    /** Measurement date (YYYY-MM-DD): the cover-page "as of" date. Metadata. */
    end: string;
    /** Positive finite share count (raw, as filed). */
    shares: number;
};

/** One Alpaca split event. `factor` is a SHARE-COUNT multiplier (10:1 → 10). */
export type SplitEvent = {
    /** The split execution date (YYYY-MM-DD), used as the effective date. */
    executionDate: string;
    /** Share-count multiplier: 10:1 split → 10, reverse 1:5 → 1/5. */
    factor: number;
};

/** EDGAR `company_tickers.json` row shape (subset we read). */
type CompanyTickersRow = { cik_str?: number | string; ticker?: string | number; title?: string };
type CompanyTickersPayload = Record<string, CompanyTickersRow>;

/** EDGAR company-concept payload shape (subset we read). */
type EdgarFactRow = { end?: string; val?: number | string; filed?: string };
type EdgarConceptPayload = { units?: Record<string, unknown> };

/** Alpaca corporate-actions payload shape (subset we read). */
type AlpacaSplitsPayload = {
    // The v1 endpoint groups actions into per-type lists under
    // `corporate_actions` (e.g. `forward_splits`, `cash_dividends`) — an
    // object, not an array. Verified live against the NVDA 2024 split.
    corporate_actions?: Record<string, unknown>;
    next_page_token?: string | null;
};

/**
 * Builds the EDGAR bulk ticker→CIK map URL. Exported for unit tests.
 */
export function buildCompanyTickersUrl(): string {
    return EDGAR_COMPANY_TICKERS_URL;
}

/**
 * Builds the EDGAR XBRL company-concept URL for one CIK (zero-padded to 10
 * digits, as the API requires). Exported for unit tests.
 */
export function buildEdgarConceptUrl(cik: number): string {
    const padded = String(Math.trunc(Math.abs(cik))).padStart(10, "0");
    return `${EDGAR_DATA_HOST}/api/xbrl/companyconcept/CIK${padded}/${EDGAR_SHARES_OUTSTANDING_TAG}.json`;
}

/**
 * Normalizes a raw ticker the way the lookup expects: EDGAR lists share
 * classes with a dot (`BRK.B`) while the app's symbols use a hyphen
 * (`BRK-B`). Exported for unit tests.
 */
export function normalizeEdgarTicker(ticker: string): string {
    return String(ticker ?? "").trim().toUpperCase().replace(/\./g, "-");
}

/**
 * Parses the EDGAR `company_tickers.json` payload into a
 * normalizedTicker → CIK map. `.`→`-` normalization covers share-class
 * tickers (BRK.B → BRK-B). Invalid rows are skipped; a non-object payload
 * yields an empty map (the caller fails the run loudly). Exported for tests.
 */
export function parseCompanyTickers(payload: unknown): Record<string, number> {
    if (!payload || typeof payload !== "object") return {};
    const tickers: Record<string, number> = {};
    for (const row of Object.values(payload as CompanyTickersPayload)) {
        if (!row || typeof row !== "object") continue;
        const cik = Number(row.cik_str);
        const rawTicker = String(row.ticker ?? "").trim();
        if (!rawTicker || !Number.isInteger(cik) || cik <= 0) continue;
        tickers[normalizeEdgarTicker(rawTicker)] = cik;
    }
    return tickers;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reduces an EDGAR company-concept payload to the point-in-time step function:
 * one fact per `filed` date (dedupe: same `filed` → latest wins; `end` is
 * carried as metadata), sorted ascending by `filed`. Rows without a valid
 * positive-finite `val` or a `filed` date are dropped. A payload without a
 * usable `units` array yields `[]` — the caller surfaces that as a per-symbol
 * failure ("no shares-outstanding facts on EDGAR"), never a partial write.
 * Exported for unit tests.
 */
export function parseSharesOutstandingFacts(payload: unknown): SharesFactPoint[] {
    if (!payload || typeof payload !== "object") return [];
    const units = (payload as EdgarConceptPayload).units;
    if (!units || typeof units !== "object") return [];
    // The dei tag is denominated in "shares"; fall back to the first array
    // unit in case EDGAR ever renames the unit key.
    let rows: unknown = units.shares;
    if (!Array.isArray(rows)) {
        for (const value of Object.values(units)) {
            if (Array.isArray(value)) { rows = value; break; }
        }
    }
    if (!Array.isArray(rows)) return [];
    const byFiled = new Map<string, SharesFactPoint>();
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as EdgarFactRow;
        const filed = String(record.filed ?? "").trim();
        const end = String(record.end ?? "").trim();
        const shares = Number(record.val);
        if (!ISO_DATE_RE.test(filed) || !Number.isFinite(shares) || shares <= 0) continue;
        // Same `filed` date → the later entry wins (EDGAR appends corrections).
        byFiled.set(filed, { filed, end: ISO_DATE_RE.test(end) ? end : "", shares });
    }
    return Array.from(byFiled.values()).sort((a, b) => a.filed.localeCompare(b.filed));
}

/**
 * Parses one page of the Alpaca corporate-actions response into split events.
 * The split's `ex_date` is the effective date (the day the adjusted price
 * series steps — matches the repo's split-adjusted 1d bars), and the factor
 * is `new_rate / old_rate`: the SHARE-COUNT multiplier (NVDA's 2024 10:1
 * split reports new_rate=10, old_rate=1 → factor 10). `next_page_token` is
 * returned so the paged fetch loop can accumulate. A payload where
 * `corporate_actions` is not an object, a split list is not an array, or a
 * split entry has unparsable rates/date is an unrecognized payload →
 * `HttpStatusError` (strict: the caller must NOT write an unadjusted
 * series). An object without the expected lists is zero splits (a symbol
 * that never split is normal). Exported for unit tests.
 */
export function parseAlpacaSplits(payload: unknown): { splits: SplitEvent[]; nextPageToken: string | null } {
    if (!payload || typeof payload !== "object") {
        throw new HttpStatusError(502, "Unrecognized Alpaca corporate-actions payload (not an object).");
    }
    const value = payload as AlpacaSplitsPayload;
    const actionsByType = value.corporate_actions ?? {};
    if (typeof actionsByType !== "object" || Array.isArray(actionsByType)) {
        throw new HttpStatusError(502, "Unrecognized Alpaca corporate-actions payload (corporate_actions is not an object).");
    }
    const splits: SplitEvent[] = [];
    for (const listKey of ["forward_splits", "reverse_splits"]) {
        const list = actionsByType[listKey];
        if (list === undefined || list === null) continue;
        if (!Array.isArray(list)) {
            throw new HttpStatusError(502, `Unrecognized Alpaca corporate-actions payload (${listKey} is not an array).`);
        }
        for (const entry of list) {
            const oldRate = Number(entry?.old_rate);
            const newRate = Number(entry?.new_rate);
            const exDate = String(entry?.ex_date ?? "").trim();
            if (!Number.isFinite(oldRate) || !Number.isFinite(newRate)
                || oldRate <= 0 || newRate <= 0 || !ISO_DATE_RE.test(exDate)) {
                throw new HttpStatusError(502, "Unrecognized Alpaca corporate-actions payload (split rates or ex_date are missing/invalid).");
            }
            splits.push({ executionDate: exDate, factor: newRate / oldRate });
        }
    }
    const token = typeof value.next_page_token === "string" && value.next_page_token.trim()
        ? value.next_page_token.trim()
        : null;
    return { splits, nextPageToken: token };
}

/**
 * Applies split correction to the step function: each fact's count is
 * MULTIPLIED by the cumulative share-count multiplier of all splits whose
 * execution date is strictly after the fact's `filed` date. This is the
 * non-negotiable convention from docs/marketcap-download.md:
 * `adjustedShares = edgarShares × F(filed → now)`. Exported for unit tests.
 */
export function applySplitFactors(facts: SharesFactPoint[], splits: SplitEvent[]): SharesFactPoint[] {
    return facts.map((fact) => {
        let factor = 1;
        for (const split of splits) {
            if (split.executionDate > fact.filed && Number.isFinite(split.factor) && split.factor > 0) {
                factor *= split.factor;
            }
        }
        return { ...fact, shares: fact.shares * factor };
    });
}

/**
 * Step-function lookup: the share count in force on `dateKey` is the latest
 * fact with `filed ≤ dateKey`; `null` before the first filing (those trading
 * days are skipped by the join). Facts must be sorted ascending by `filed`
 * (as `parseSharesOutstandingFacts` returns them). Exported for unit tests.
 */
export function lookupSharesForDate(facts: SharesFactPoint[], dateKey: string): number | null {
    let shares: number | null = null;
    for (const fact of facts) {
        if (fact.filed <= dateKey) shares = fact.shares;
        else break;
    }
    return shares;
}

/**
 * Abortable sleep: resolves after `ms` unless `signal` aborts first, in which
 * case it rejects with the abort reason. Mirrors alpaca-fetcher's private
 * helper.
 */
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

function isTimeoutSignalError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    return (error as { name?: string }).name === "TimeoutError";
}

function parseRetryAfterMs(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
    return null;
}

/**
 * EDGAR fair-access client-side rate limiter: keeps EDGAR requests ≥150 ms
 * apart across the whole process. Shared by the tickers map and the
 * company-concept fetches.
 */
let lastEdgarRequestAtMs = 0;
async function edgarRateLimitDelay(signal?: AbortSignal): Promise<void> {
    const waitMs = lastEdgarRequestAtMs + EDGAR_MIN_REQUEST_SPACING_MS - Date.now();
    if (waitMs > 0) await abortableDelay(waitMs, signal);
    lastEdgarRequestAtMs = Date.now();
}

/**
 * One JSON GET with the alpaca-fetcher retry discipline: per-request timeout
 * composed with the caller's abort signal, bounded retry backoff, `Retry-After`
 * respected on 429, user aborts propagate immediately without retry, and
 * timeout/network errors retry as transient. Non-2xx after retries (or a
 * non-retryable status) throws `HttpStatusError` carrying the original status.
 */
async function fetchJsonWithRetries(args: {
    url: string;
    headers: Record<string, string>;
    label: string;
    signal?: AbortSignal;
    /** Optional undici dispatcher (Alpaca host IPv4/DoH workaround). */
    dispatcher?: unknown;
}): Promise<unknown> {
    const { url, headers, label, signal, dispatcher } = args;
    let attempts = 0;
    for (let retry = 0; retry <= RETRY_DELAYS_MS.length; retry += 1) {
        attempts = retry + 1;
        if (signal?.aborted) {
            throw (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("Aborted");
        }
        const timeout = createFetchTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
        let response: Response;
        try {
            response = await fetch(url, {
                method: "GET",
                headers,
                signal: timeout.signal,
                ...(dispatcher ? { dispatcher } : {}),
            } as RequestInit & { dispatcher?: unknown });
        } catch (error) {
            timeout.cleanup();
            // User-initiated abort propagates without retry; a per-request
            // timeout or network error is a transient retryable condition.
            if (signal?.aborted) throw error;
            if (retry >= RETRY_DELAYS_MS.length) {
                const timedOut = isTimeoutSignalError(error);
                const why = timedOut ? "timed out" : "failed";
                throw new HttpStatusError(502, `${label} request ${why} after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
            }
            await abortableDelay(RETRY_DELAYS_MS[retry]!, signal);
            continue;
        }
        try {
            if (response.ok) {
                try {
                    return await response.json() as unknown;
                } catch (error) {
                    // A 200 whose body never parses as JSON is a deterministic
                    // protocol error, not a transient condition — surface it
                    // as an unrecognized payload instead of retrying.
                    if (error instanceof SyntaxError) {
                        throw new HttpStatusError(502, `${label} returned an unrecognized payload (invalid JSON).`);
                    }
                    throw error;
                }
            }
            const text = await response.text().catch(() => "");
            const detail = text.slice(0, 300);
            if (NON_RETRYABLE_STATUSES.has(response.status)) {
                throw new HttpStatusError(response.status, `${label} request failed (${response.status}).${detail ? ` ${detail}` : ""}${response.status === 403 ? " SEC rejects requests without a compliant User-Agent policy." : ""}`);
            }
            if (response.status !== 429 && response.status < 500) {
                throw new HttpStatusError(response.status, `${label} request failed (${response.status}).${detail ? ` ${detail}` : ""}`);
            }
            // Transient 429/5xx: honor Retry-After when present.
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            if (signal?.aborted) {
                throw (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("Aborted");
            }
            if (retry >= RETRY_DELAYS_MS.length) {
                throw new HttpStatusError(response.status, `${label} request failed (${response.status}) after ${attempts} attempts.${detail ? ` ${detail}` : ""}`);
            }
            await abortableDelay(retryAfterMs ?? RETRY_DELAYS_MS[retry]!, signal);
        } catch (error) {
            if (error instanceof HttpStatusError) throw error;
            if (signal?.aborted) throw error;
            if (retry >= RETRY_DELAYS_MS.length) {
                const timedOut = isTimeoutSignalError(error);
                const why = timedOut ? "timed out reading body" : "failed reading body";
                throw new HttpStatusError(502, `${label} request ${why} after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
            }
            await abortableDelay(RETRY_DELAYS_MS[retry]!, signal);
        } finally {
            timeout.cleanup();
        }
    }
    // Unreachable: the loop either returns or throws.
    throw new HttpStatusError(502, `${label} request exhausted retries.`);
}

/**
 * Fetches the raw EDGAR company-concept JSON for one CIK
 * (`dei:EntityCommonStockSharesOutstanding`). Rate-limited to EDGAR's
 * fair-access policy and carrying the descriptive `User-Agent`. Returns the
 * raw payload; parse it with `parseSharesOutstandingFacts`.
 */
export async function fetchEdgarSharesOutstanding(cik: number, signal?: AbortSignal): Promise<unknown> {
    const url = buildEdgarConceptUrl(cik);
    const startedAt = Date.now();
    await edgarRateLimitDelay(signal);
    const payload = await fetchJsonWithRetries({
        url,
        headers: {
            Accept: "application/json",
            "User-Agent": EDGAR_USER_AGENT,
        },
        label: "EDGAR shares-outstanding",
        signal,
    });
    debugLogger.info("marketcap.edgar.facts", {
        target: "edgar",
        cik,
        durationMs: Date.now() - startedAt,
    });
    return payload;
}

/**
 * Builds the Alpaca corporate-actions URL for one page. `types` filters to
 * split actions server-side; the explicit `[start, end]` window is mandatory
 * (without dates the endpoint only searches a narrow recent window).
 * `pageToken` is the opaque `next_page_token` from a prior response. Exported
 * for unit tests; auth is header-based and deliberately not part of this
 * builder.
 */
export function buildAlpacaSplitsUrl(
    config: Pick<AlpacaConfig, "host">,
    args: { symbol: string; end: string; pageToken?: string },
): string {
    const symbol = args.symbol.trim().toUpperCase();
    const params = new URLSearchParams({
        symbols: symbol,
        types: "forward_split,reverse_split",
        start: ALPACA_SPLITS_QUERY_START,
        end: args.end,
        sort: "asc",
        limit: String(ALPACA_SPLITS_PAGE_LIMIT),
    });
    if (args.pageToken) params.set("page_token", args.pageToken);
    return `${config.host}${ALPACA_CORPORATE_ACTIONS_PATH}?${params.toString()}`;
}

/**
 * Constructs the Alpaca auth header. NOT exported — the header carries
 * credentials and must not leak into logs, URLs, or payloads. Mirrors
 * alpaca-fetcher's private `buildAlpacaHeaders`.
 */
function buildAlpacaHeaders(config: Pick<AlpacaConfig, "apiKey" | "apiSecret">): Record<string, string> {
    return {
        Accept: "application/json",
        "APCA-API-KEY-ID": config.apiKey,
        "APCA-API-SECRET-KEY": config.apiSecret,
    };
}

/**
 * Fetches ALL split events for one symbol, paging through `next_page_token`
 * until exhausted. An unrecognized payload throws `HttpStatusError` (strict:
 * the caller fails the symbol rather than writing an unadjusted series).
 * `config` is injected so tests can avoid env coupling; production resolves
 * lazily via `resolveAlpacaConfig()`.
 */
export async function fetchAlpacaSplits(
    config: AlpacaConfig,
    symbol: string,
    signal?: AbortSignal,
): Promise<SplitEvent[]> {
    const startedAt = Date.now();
    const headers = buildAlpacaHeaders(config);
    const splits: SplitEvent[] = [];
    let pages = 0;
    let pageToken: string | undefined;
    // Bounded page ceiling so a misbehaving API cannot loop forever (mirrors
    // alpaca-fetcher's ALPACA_MAX_PAGES_PER_SYMBOL).
    const maxPages = 200;
    for (let page = 0; page < maxPages; page += 1) {
        if (signal?.aborted) {
            throw (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("Aborted");
        }
        const url = buildAlpacaSplitsUrl(config, {
            symbol,
            end: new Date().toISOString().slice(0, 10),
            pageToken,
        });
        const payload = await fetchJsonWithRetries({
            url,
            headers,
            label: `Alpaca corporate-actions (${symbol})`,
            signal,
            // Same ISP-DNS workaround as the bars fetcher: plain fetch to
            // data.alpaca.markets fails on hosts whose resolver cannot
            // answer for this name.
            dispatcher: getAlpacaIpv4Dispatcher(url),
        });
        pages += 1;
        const parsed = parseAlpacaSplits(payload);
        splits.push(...parsed.splits);
        if (!parsed.nextPageToken) {
            debugLogger.info("marketcap.splits.fetch", {
                target: "alpaca",
                symbol,
                splits: splits.length,
                pages,
                durationMs: Date.now() - startedAt,
            });
            return splits;
        }
        pageToken = parsed.nextPageToken;
    }
    throw new HttpStatusError(502, `Alpaca corporate-actions pagination for ${symbol} exceeded ${maxPages} pages.`);
}

/** Disk-cache envelope for the ticker→CIK map. */
type TickersCache = { fetchedAt: string; tickers: Record<string, number> };

function defaultTickersCachePath(): string {
    // Sibling of the candle CSV tree, inside the marketcap dataset dir (the
    // dot-file keeps readCatalogAssets()-style CSV scans unaffected).
    return resolve(process.cwd(), "price-data", "ibkr", "marketcap", ".company-tickers.json");
}

/**
 * Loads the ticker→CIK map through the on-disk cache at
 * `price-data/ibkr/marketcap/.company-tickers.json`: a cache younger than
 * `maxAgeMs` (default ~30 days) is returned as-is; otherwise the map is
 * fetched from EDGAR (rate-limited) and written back atomically via
 * temp+rename. A fetch failure throws — the market-cap run fails loudly
 * rather than silently serving a stale map. `cachePath` is injectable for
 * tests. Returns the parsed normalizedTicker → CIK map.
 */
export async function loadCompanyTickersCached(options?: {
    cachePath?: string;
    maxAgeMs?: number;
    signal?: AbortSignal;
}): Promise<Record<string, number>> {
    const cachePath = options?.cachePath ?? defaultTickersCachePath();
    const maxAgeMs = options?.maxAgeMs ?? TICKERS_CACHE_MAX_AGE_MS;
    if (existsSync(cachePath)) {
        try {
            const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<TickersCache>;
            const fetchedAtMs = Date.parse(String(parsed.fetchedAt ?? ""));
            if (Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs <= maxAgeMs && parsed.tickers && typeof parsed.tickers === "object") {
                debugLogger.info("marketcap.tickers.cacheHit", { target: "edgar", count: Object.keys(parsed.tickers).length });
                return parsed.tickers as Record<string, number>;
            }
        } catch {
            // Corrupt cache: fall through to a network refresh.
        }
    }
    const payload = await fetchJsonWithRetries({
        url: buildCompanyTickersUrl(),
        headers: {
            Accept: "application/json",
            "User-Agent": EDGAR_USER_AGENT,
        },
        label: "EDGAR company_tickers",
        signal: options?.signal,
    });
    const tickers = parseCompanyTickers(payload);
    if (Object.keys(tickers).length === 0) {
        throw new HttpStatusError(502, "EDGAR company_tickers payload was unrecognized (no valid ticker rows).");
    }
    mkdirSync(dirname(cachePath), { recursive: true });
    const cache: TickersCache = { fetchedAt: new Date().toISOString(), tickers };
    const tempPath = `${cachePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(cache));
    renameSync(tempPath, cachePath);
    debugLogger.info("marketcap.tickers.fetch", { target: "edgar", count: Object.keys(tickers).length });
    return tickers;
}
