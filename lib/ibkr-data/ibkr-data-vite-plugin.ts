import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import { debugLogger } from "../debug-logger";
import { markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/strategies";
import { beginNdjsonStream, HttpStatusError, readJsonBody, sendCaughtErrorJson, sendJson, type ViteHttpResponse } from "../vite-http-utils";

const APP_ROOT = process.cwd();
const IBKR_DATA_DIR = resolve(APP_ROOT, "price-data", "ibkr");
const IBKR_CSV_DIR = resolve(IBKR_DATA_DIR, "csv");
const IBKR_CATALOG_PATH = resolve(IBKR_DATA_DIR, "catalog.json");
const DEFAULT_GATEWAY_URL = "https://localhost:5000/v1/api";
const DEFAULT_PERIOD_BY_INTERVAL: Record<string, string> = {
    "1m": "1w",
    "5m": "1m",
    "15m": "3m",
    "30m": "6m",
    "1h": "1y",
    "4h": "6m",
    "1d": "max",
};
const MAX_SYNC_CHUNK_PERIOD_BY_INTERVAL: Record<string, string> = {
    "1m": "1w",
    "5m": "1m",
    "15m": "3m",
    "30m": "6m",
    "1h": "6m",
    "4h": "6m",
    "1d": "5y",
};
const IBKR_BAR_BY_INTERVAL: Record<string, string> = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
};
// undici is an optional peer: it ships with Node >=18 but is not declared
// as a project dependency, and is resolvable only when the monorepo's
// hoisted node_modules is on the resolver path (i.e. locally). On hosts
// where it isn't resolvable (Vercel, minimal installs), requiring it at
// module top level would throw during `vite.config.ts` load and abort the
// whole build. Resolve it lazily and tolerate absence — the dispatcher is
// only used for `https://localhost:*` calls to the user's local IBKR
// Gateway, which never exist in a Vercel build/runtime anyway.
type UndiciAgent = { new (options: { connect: { rejectUnauthorized: boolean } }): unknown };
const requireFromConfig = createRequire(import.meta.url);
let localhostTlsDispatcher: unknown | undefined;
let undiciUnavailable = false;
function getLocalhostTlsDispatcher(): unknown | undefined {
    if (localhostTlsDispatcher || undiciUnavailable) return localhostTlsDispatcher;
    try {
        const Undici = requireFromConfig("undici") as { Agent: UndiciAgent };
        localhostTlsDispatcher = new Undici.Agent({ connect: { rejectUnauthorized: false } });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ibkr-data-vite-plugin] undici unavailable (${message}); localhost HTTPS requests will use the default fetch dispatcher.`);
        undiciUnavailable = true;
    }
    return localhostTlsDispatcher;
}
const IBKR_HISTORY_SOFT_LIMIT = 900;
const IBKR_HISTORY_MAX_CHUNKS = 20;
const IBKR_HISTORY_MAX_SYNC_CHUNKS = 80;
const IBKR_HISTORY_CHUNK_DELAY_MS = 1_500;
const IBKR_HISTORY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;
const IBKR_KEEPALIVE_INTERVAL_MS = 60_000;
// Auth-cache TTL: `fetchGatewayJsonAuthenticated` previously called
// `ensureBrokerageSession()` before every gateway request, and that helper
// makes an HTTP round-trip to /iserver/auth/status. For a 20-symbol sync
// (~60-100 gateway calls) that was 10-20s of pure auth overhead. The TTL is
// comfortably shorter than `IBKR_KEEPALIVE_INTERVAL_MS` and is invalidated
// immediately on a 401 in the retry path below.
const IBKR_AUTH_CACHE_TTL_MS = 30_000;
// Cached-conid TTL: bounds how long `syncOneSymbol` will trust a catalog
// entry's conid before re-resolving. Conids can change on corporate actions
// / ticker remaps; the 0-bars fallback below covers the rare stale case.
const IBKR_CONID_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let stopRequested = false;
// Sync lock: instead of a bare boolean, an owner-generation counter. Stop
// force-resets the lock by bumping `syncOwnerGen` to a new sentinel value
// (SYNC_OWNER_NONE) so a stuck/hung sync can always be recovered without a
// server restart. A stuck sync's late `finally` only writes its own (stale)
// owner value back to SYNC_OWNER_NONE, so it cannot clobber a newer sync
// that has since acquired the lock with a newer generation. Bare booleans
// cannot distinguish "my lock" from "their lock" — that's how force-reset
// would race.
const SYNC_OWNER_NONE = 0;
let syncOwner = SYNC_OWNER_NONE;
let syncOwnerGen = 0;

// In-progress sync snapshot. Populated when a sync starts, cleared when it
// ends. Used by GET /api/ibkr/sync/status so a browser reload can show the
// running batch instead of "Ready" — the server keeps syncing after the
// NDJSON response stream is gone, this is how the UI reattaches.
export type SyncRunState = {
    startedAt: string;
    mode: "sync" | "download";
    interval: string;
    period: string | null;
    total: number;
    index: number;          // index of the next symbol to process
    completed: number;      // successful symbols so far
    failed: number;
    currentSymbol: string | null;
    failedSymbols: Array<{ symbol: string; error: string }>;
    cancelled: boolean;
};
let syncRunState: SyncRunState | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let lastKeepAliveAt: string | null = null;
let lastKeepAliveError: string | null = null;
let cachedAuthExpiry = 0;

type IbkrCatalogEntry = {
    symbol: string;
    markedSymbol: string;
    conid?: string;
    exchange?: string;
    primaryExchange?: string;
    currency?: string;
    intervals: Record<string, { firstTime: string | null; lastTime: string | null; bars: number; lastSyncAt: string }>;
};

type IbkrCatalog = {
    updatedAt: string;
    entries: IbkrCatalogEntry[];
};

type IbkrResolvedContract = {
    symbol: string;
    conid: string;
    name: string;
    exchange?: string;
    primaryExchange?: string;
    currency?: string;
};

function normalizeInterval(value: unknown): string {
    const interval = String(value ?? "1d").trim().toLowerCase();
    if (!IBKR_BAR_BY_INTERVAL[interval]) {
        throw new HttpStatusError(400, `Unsupported IBKR interval: ${interval}`);
    }
    return interval;
}

export function normalizeSymbol(value: unknown): string {
    const symbol = stripIbkrMarker(String(value ?? "").trim().toUpperCase());
    if (!symbol || !/^[A-Z0-9._-]+$/.test(symbol)) {
        throw new HttpStatusError(400, `Invalid IBKR symbol: ${String(value ?? "")}`);
    }
    return symbol;
}

function normalizeSymbols(value: unknown): string[] {
    const raw = Array.isArray(value)
        ? value
        : String(value ?? "").split(/[\s,]+/);
    const seen = new Set<string>();
    const symbols: string[] = [];
    for (const item of raw) {
        const text = String(item ?? "").trim();
        if (!text) continue;
        const symbol = normalizeSymbol(text);
        if (seen.has(symbol)) continue;
        seen.add(symbol);
        symbols.push(symbol);
    }
    if (symbols.length === 0) {
        throw new HttpStatusError(400, "At least one symbol is required.");
    }
    return symbols;
}

function getGatewayUrl(): string {
    return (process.env.IBKR_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
}

async function fetchGatewayJson(path: string, init?: RequestInit): Promise<unknown> {
    const url = `${getGatewayUrl()}${path}`;
    const startedAt = Date.now();
    let response: { status: number; text: string };
    try {
        response = await requestGatewayText(url, init);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("ibkr.gateway.failed", {
            target: "ibkr",
            url,
            durationMs: Date.now() - startedAt,
            error: message,
        });
        throw new HttpStatusError(502, `Failed to reach IBKR Gateway at ${url}: ${message}`);
    }

    const text = response.text;
    let payload: unknown = null;
    if (text.trim()) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = { raw: text };
        }
    }
    if (response.status < 200 || response.status >= 300) {
        debugLogger.warn("ibkr.gateway.failed", {
            target: "ibkr",
            url,
            status: response.status,
            durationMs: Date.now() - startedAt,
        });
        throw new HttpStatusError(response.status, `IBKR Gateway request failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return payload;
}

function requestGatewayText(url: string, init?: RequestInit): Promise<{ status: number; text: string }> {
    const parsed = new URL(url);
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
    const headers: Record<string, string> = {
        Accept: "*/*",
        "User-Agent": "curl/8.13.0",
        ...(body ? { "Content-Type": "application/json" } : {}),
    };
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
    const dispatcher = parsed.protocol === "https:" && isLocalhost ? getLocalhostTlsDispatcher() : undefined;

    return fetch(url, {
        method: init?.method ?? "GET",
        headers,
        body,
        ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: unknown }).then(async (response) => {
        return {
            status: response.status,
            text: await response.text(),
        };
    });
}

function isAuthenticatedBrokerageSession(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const value = payload as Record<string, unknown>;
    return value.authenticated === true && value.connected === true;
}

function getTickleAuthStatus(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return null;
    const value = payload as Record<string, unknown>;
    const iserver = value.iserver && typeof value.iserver === "object"
        ? value.iserver as Record<string, unknown>
        : null;
    return iserver?.authStatus ?? null;
}

export type IbkrMarketDataReadiness = {
    ok: boolean;
    error: string | null;
    warning: string | null;
    hmds: unknown;
};

export function describeIbkrMarketDataReadiness(ticklePayload: unknown): IbkrMarketDataReadiness {
    const value = ticklePayload && typeof ticklePayload === "object"
        ? ticklePayload as Record<string, unknown>
        : {};
    const hmds = value.hmds;
    if (!hmds || typeof hmds !== "object") {
        return { ok: true, error: null, warning: null, hmds: null };
    }

    const status = hmds as Record<string, unknown>;
    const error = String(status.error ?? "").trim();
    if (error) {
        return {
            ok: true,
            error: null,
            warning: `IBKR /tickle reports hmds.error="${error}". This gateway build can still serve /iserver/marketdata/history with that tickle warning, so sync will probe the history endpoint directly.`,
            hmds,
        };
    }

    if (status.connected === false || status.authenticated === false) {
        return {
            ok: false,
            error: "IBKR historical market data is not ready: HMDS is not connected/authenticated.",
            warning: null,
            hmds,
        };
    }

    return { ok: true, error: null, warning: null, hmds };
}

async function tickleGateway(): Promise<unknown> {
    const payload = await fetchGatewayJson("/tickle", {
        method: "POST",
        body: "{}",
    });
    lastKeepAliveAt = new Date().toISOString();
    lastKeepAliveError = null;
    return payload;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function stopKeepAlive(): void {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

function startKeepAlive(): void {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
        void tickleGateway().then((payload) => {
            const authStatus = getTickleAuthStatus(payload);
            if (authStatus && !isAuthenticatedBrokerageSession(authStatus)) {
                lastKeepAliveError = "IBKR tickle returned an unauthenticated brokerage session.";
                stopKeepAlive();
            }
        }).catch((error) => {
            lastKeepAliveError = error instanceof Error ? error.message : String(error);
            stopKeepAlive();
        });
    }, IBKR_KEEPALIVE_INTERVAL_MS);
}

async function initializeBrokerageSession(): Promise<void> {
    await fetchGatewayJson("/iserver/auth/ssodh/init", {
        method: "POST",
        body: JSON.stringify({ publish: true, compete: true }),
    });
}

async function reauthenticateBrokerageSession(): Promise<void> {
    await fetchGatewayJson("/iserver/reauthenticate", {
        method: "POST",
        body: "{}",
    });
}

async function recoverBrokerageSession(trigger: string): Promise<unknown> {
    let lastError: unknown = null;
    try {
        await initializeBrokerageSession();
        await wait(750);
        const status = await fetchGatewayJson("/iserver/auth/status");
        if (isAuthenticatedBrokerageSession(status)) {
            debugLogger.info("ibkr.auth.recovered", { target: "ibkr", trigger, method: "ssodh-init" });
            startKeepAlive();
        }
        return status;
    } catch (error) {
        if (!(error instanceof HttpStatusError) || (error.status !== 401 && error.status !== 403)) {
            throw error;
        }
        lastError = error;
    }

    try {
        await reauthenticateBrokerageSession();
        await wait(3_000);
        const status = await fetchGatewayJson("/iserver/auth/status");
        if (isAuthenticatedBrokerageSession(status)) {
            debugLogger.info("ibkr.auth.recovered", { target: "ibkr", trigger, method: "reauthenticate" });
            startKeepAlive();
        }
        return status;
    } catch (error) {
        if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
            const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "");
            throw new HttpStatusError(
                error.status,
                `IBKR brokerage session is no longer authenticated and automatic recovery failed. /sso/ping may still be alive, but /iserver/auth/status is returning ${error.status}; reopen the Client Portal Gateway browser login and retry.${detail ? ` Previous recovery error: ${detail}` : ""}`
            );
        }
        throw error;
    }
}

async function ensureBrokerageSession(): Promise<unknown> {
    try {
        const status = await fetchGatewayJson("/iserver/auth/status");
        if (isAuthenticatedBrokerageSession(status)) {
            startKeepAlive();
            return status;
        }
    } catch (error) {
        if (!(error instanceof HttpStatusError) || (error.status !== 401 && error.status !== 403)) {
            throw error;
        }
    }

    return recoverBrokerageSession("ensure");
}

async function fetchGatewayJsonAuthenticated(path: string, init?: RequestInit): Promise<unknown> {
    if (Date.now() >= cachedAuthExpiry) {
        await ensureBrokerageSession();
        cachedAuthExpiry = Date.now() + IBKR_AUTH_CACHE_TTL_MS;
    }
    try {
        return await fetchGatewayJson(path, init);
    } catch (error) {
        if (path.startsWith("/iserver/marketdata/history")
            && error instanceof HttpStatusError
            && error.status === 503) {
            throw await enrichHistoricalMarketDataError(error);
        }
        if (!(error instanceof HttpStatusError) || (error.status !== 401 && error.status !== 403)) {
            throw error;
        }
        debugLogger.info("ibkr.auth.reinit", { target: "ibkr", path, trigger: String(error.status) });
        // Invalidate the auth cache: the cached "authenticated" state was
        // wrong. Forces the retry path to re-validate before the next call.
        cachedAuthExpiry = 0;
        await recoverBrokerageSession(`request-${error.status}`);
        await wait(750);
        // Re-cache only after the retry actually succeeds. Previously this
        // was set before the retry, so a second 401 left the cache claiming
        // authenticated for 30s while every call paid a 401+reinit round-trip.
        let result: unknown;
        try {
            result = await fetchGatewayJson(path, init);
        } catch (retryError) {
            if (path.startsWith("/iserver/marketdata/history")
                && retryError instanceof HttpStatusError
                && (retryError.status === 401 || retryError.status === 403 || retryError.status === 503)) {
                throw await enrichHistoricalMarketDataError(retryError);
            }
            throw retryError;
        }
        cachedAuthExpiry = Date.now() + IBKR_AUTH_CACHE_TTL_MS;
        return result;
    }
}

async function enrichHistoricalMarketDataError(error: HttpStatusError): Promise<HttpStatusError> {
    try {
        const ticklePayload = await tickleGateway();
        const readiness = describeIbkrMarketDataReadiness(ticklePayload);
        if (!readiness.ok && readiness.error) {
            return new HttpStatusError(error.status, `${error.message} ${readiness.error}`);
        }
        if (readiness.warning) {
            return new HttpStatusError(error.status, `${error.message} ${readiness.warning}`);
        }
        return new HttpStatusError(error.status, `${error.message} Historical market data request was rejected even though /tickle did not report an HMDS error.`);
    } catch (tickleError) {
        const detail = tickleError instanceof Error ? tickleError.message : String(tickleError);
        return new HttpStatusError(error.status, `${error.message} Could not verify IBKR HMDS state via /tickle: ${detail}`);
    }
}

function readCatalog(): IbkrCatalog {
    if (!existsSync(IBKR_CATALOG_PATH)) {
        return { updatedAt: new Date(0).toISOString(), entries: [] };
    }
    try {
        const parsed = JSON.parse(readFileSync(IBKR_CATALOG_PATH, "utf8")) as Partial<IbkrCatalog>;
        // Normalize entries defensively: `intervals` is required by the type
        // but on-disk JSON may have been hand-edited or produced by an older
        // version. Callers dereference `entry.intervals[interval]` without
        // guarding, so a missing field would TypeError.
        const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
        const entries: IbkrCatalogEntry[] = rawEntries.map((entry) => {
            const e = entry as Partial<IbkrCatalogEntry>;
            return {
                symbol: typeof e.symbol === "string" ? e.symbol : "",
                markedSymbol: typeof e.markedSymbol === "string" ? e.markedSymbol : "",
                conid: e.conid,
                exchange: e.exchange,
                primaryExchange: e.primaryExchange,
                currency: e.currency,
                intervals: (e.intervals && typeof e.intervals === "object") ? e.intervals : {},
            };
        });
        return {
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
            entries,
        };
    } catch {
        return { updatedAt: new Date(0).toISOString(), entries: [] };
    }
}

function writeCatalog(catalog: IbkrCatalog): void {
    // Atomic write via temp+rename, mirroring `writeCsv` below. A direct
    // `writeFileSync` could leave a truncated JSON if the process is killed
    // mid-batch, and `readCatalog` would silently swallow it as empty.
    mkdirSync(dirname(IBKR_CATALOG_PATH), { recursive: true });
    const tempPath = `${IBKR_CATALOG_PATH}.tmp`;
    writeFileSync(tempPath, JSON.stringify(catalog, null, 2));
    renameSync(tempPath, IBKR_CATALOG_PATH);
}

function summarizeCandles(candles: OHLCVData[], lastSyncAt: string): IbkrCatalogEntry["intervals"][string] {
    const first = candles[0];
    const last = candles[candles.length - 1];
    return {
        firstTime: first ? new Date(Number(first.time) * 1000).toISOString() : null,
        lastTime: last ? new Date(Number(last.time) * 1000).toISOString() : null,
        bars: candles.length,
        lastSyncAt,
    };
}

function findCatalogEntry(catalog: IbkrCatalog, symbol: string): IbkrCatalogEntry | undefined {
    return catalog.entries.find((item) => item.symbol === symbol);
}

/**
 * Builds a `resolved` contract from a catalog entry, used to skip
 * `resolveSymbol` on repeat syncs. Returns null when the entry is missing
 * required fields or is older than `IBKR_CONID_CACHE_TTL_MS`.
 *
 * Exported for unit testing.
 */
export function resolveFromCatalog(
    entry: IbkrCatalogEntry | undefined,
    nowMs: number = Date.now()
): IbkrResolvedContract | null {
    if (!entry || !entry.conid) return null;
    const intervals = entry.intervals ?? {};
    const lastSyncAt = Object.values(intervals)
        .map((info) => info?.lastSyncAt ? Date.parse(info.lastSyncAt) : NaN)
        .filter((ms) => Number.isFinite(ms))
        .sort((a, b) => b - a)[0];
    if (!Number.isFinite(lastSyncAt)) return null;
    if (nowMs - lastSyncAt > IBKR_CONID_CACHE_TTL_MS) return null;
    return {
        symbol: entry.symbol,
        conid: entry.conid,
        name: entry.symbol,
        exchange: entry.exchange,
        primaryExchange: entry.primaryExchange,
        currency: entry.currency,
    };
}

/**
 * Mutates `catalog` in place to upsert one symbol/interval entry. Does not
 * perform any I/O — the caller (processSyncBatch) is responsible for writing
 * `catalog` to disk after each successful symbol via `writeCatalog(catalog)`.
 */
function upsertCatalogEntry(catalog: IbkrCatalog, args: {
    symbol: string;
    interval: string;
    candles: OHLCVData[];
    resolved?: IbkrResolvedContract;
}): IbkrCatalogEntry {
    const nowIso = new Date().toISOString();
    const markedSymbol = markIbkrSymbol(args.symbol);
    let entry = catalog.entries.find((item) => item.symbol === args.symbol);
    if (!entry) {
        entry = {
            symbol: args.symbol,
            markedSymbol,
            intervals: {},
        };
        catalog.entries.push(entry);
    }
    entry.markedSymbol = markedSymbol;
    if (args.resolved) {
        entry.conid = args.resolved.conid;
        entry.exchange = args.resolved.exchange;
        entry.primaryExchange = args.resolved.primaryExchange;
        entry.currency = args.resolved.currency;
        if (!entry.symbol) entry.symbol = args.resolved.symbol;
    }
    entry.intervals[args.interval] = summarizeCandles(args.candles, nowIso);
    catalog.entries.sort((a, b) => a.symbol.localeCompare(b.symbol));
    catalog.updatedAt = nowIso;
    return entry;
}

function readCsvCandles(symbol: string, interval: string): OHLCVData[] {
    const filePath = getCsvPath(symbol, interval);
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return parseCsvCandleLines(lines);
}

export function parseCsvCandleLines(lines: readonly string[]): OHLCVData[] {
    if (lines.length <= 1) return [];
    const candles: OHLCVData[] = [];
    for (let i = 1; i < lines.length; i += 1) {
        const [timeRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = lines[i].split(",");
        const time = parseTimeToUnixSeconds(timeRaw);
        const open = Number(openRaw);
        const high = Number(highRaw);
        const low = Number(lowRaw);
        const close = Number(closeRaw);
        const volume = Number(volumeRaw ?? 0);
        if (time === null || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
            continue;
        }
        candles.push({ time: time as OHLCVData["time"], open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    }
    return mergeCandlesByTime(candles);
}

export function mergeCandlesByTime(candles: OHLCVData[]): OHLCVData[] {
    const byTime = new Map<number, OHLCVData>();
    for (const candle of candles) {
        const time = parseTimeToUnixSeconds(candle.time);
        if (time === null) continue;
        byTime.set(time, { ...candle, time: time as OHLCVData["time"] });
    }
    return Array.from(byTime.values()).sort((a, b) => Number(a.time) - Number(b.time));
}

export function getCsvPath(symbol: string, interval: string): string {
    return resolve(IBKR_CSV_DIR, interval, `${symbol}.csv`);
}

export function writeCsv(symbol: string, interval: string, candles: OHLCVData[]): void {
    const filePath = getCsvPath(symbol, interval);
    mkdirSync(dirname(filePath), { recursive: true });
    const rows = ["time,open,high,low,close,volume"];
    for (const candle of candles) {
        rows.push([
            new Date(Number(candle.time) * 1000).toISOString(),
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

export function parseResolvedContracts(symbol: string, payload: unknown): IbkrResolvedContract[] {
    const rows = Array.isArray(payload) ? payload : [];
    return rows
        .map((row): IbkrResolvedContract | null => {
            if (!row || typeof row !== "object") return null;
            const value = row as Record<string, unknown>;
            const conid = String(value.conid ?? value.conId ?? "").trim();
            if (!conid) return null;
            return {
                symbol,
                conid,
                name: String(value.companyName ?? value.description ?? value.symbol ?? symbol),
                exchange: String(value.description ?? value.exchange ?? ""),
                primaryExchange: String(value.listingExchange ?? value.primaryExchange ?? ""),
                currency: String(value.currency ?? "USD"),
            };
        })
        .filter((item): item is IbkrResolvedContract => item !== null);
}

async function resolveSymbol(symbol: string): Promise<IbkrResolvedContract> {
    const params = new URLSearchParams({ symbol, sectype: "STK" });
    const payload = await fetchGatewayJsonAuthenticated(`/iserver/secdef/search?${params.toString()}`, {
        method: "POST",
        body: "{}",
    });
    const contracts = parseResolvedContracts(symbol, payload);
    const resolved = contracts[0];
    if (!resolved) {
        throw new HttpStatusError(404, `IBKR could not resolve ${symbol}.`);
    }
    return resolved;
}

export function parseHistoryCandles(payload: unknown): OHLCVData[] {
    const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const rows = Array.isArray(value.data) ? value.data : [];
    const candles: OHLCVData[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const bar = row as Record<string, unknown>;
        const time = parseTimeToUnixSeconds(bar.t ?? bar.time ?? bar.date);
        const open = Number(bar.o ?? bar.open);
        const high = Number(bar.h ?? bar.high);
        const low = Number(bar.l ?? bar.low);
        const close = Number(bar.c ?? bar.close);
        const volume = Number(bar.v ?? bar.volume ?? 0);
        if (time === null || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
            continue;
        }
        candles.push({ time: time as OHLCVData["time"], open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    }
    return mergeCandlesByTime(candles);
}

export function parsePeriodToMs(period: string): number | null {
    const match = /^(\d+)\s*([dwmy])$/i.exec(period.trim());
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = match[2].toLowerCase();
    if (unit === "d") return amount * 24 * 60 * 60 * 1000;
    if (unit === "w") return amount * 7 * 24 * 60 * 60 * 1000;
    if (unit === "m") return amount * 30 * 24 * 60 * 60 * 1000;
    if (unit === "y") return amount * 365 * 24 * 60 * 60 * 1000;
    return null;
}

function isMaxHistoryPeriod(period: string): boolean {
    const normalized = period.trim().toLowerCase();
    return normalized === "max" || normalized === "all";
}

export function shouldUseIncrementalIbkrSync(syncOnly: boolean, period: string, hasExistingEntry: boolean): boolean {
    return syncOnly && hasExistingEntry && !isMaxHistoryPeriod(period);
}

function formatIbkrStartTime(unixSeconds: number): string {
    const date = new Date(unixSeconds * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return [
        date.getUTCFullYear(),
        pad(date.getUTCMonth() + 1),
        pad(date.getUTCDate()),
        "-",
        pad(date.getUTCHours()),
        ":",
        pad(date.getUTCMinutes()),
        ":",
        pad(date.getUTCSeconds()),
    ].join("");
}

function trimCandlesToPeriod(candles: OHLCVData[], period: string): OHLCVData[] {
    const periodMs = parsePeriodToMs(period);
    if (periodMs === null || candles.length === 0) return candles;
    const newest = Number(candles[candles.length - 1].time);
    if (!Number.isFinite(newest)) return candles;
    const cutoffSeconds = Math.floor((newest * 1000 - periodMs) / 1000);
    return candles.filter((candle) => Number(candle.time) >= cutoffSeconds);
}

const IBKR_INTERVAL_SECONDS: Record<string, number> = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1h": 60 * 60,
    "4h": 4 * 60 * 60,
    "1d": 24 * 60 * 60,
};

/**
 * Returns the IBKR `startTime` (unix seconds) to pass for an incremental
 * sync, or `null` when incremental sync is not applicable and the caller
 * should fall back to a full-period fetch.
 *
 * Backs up by 2 bars of overlap so the still-forming current bar and any
 * late corrections to the previous bar are re-fetched. The merge step's
 * last-write-wins dedup handles the overlap safely.
 *
 * Exported for unit testing.
 */
export function computeIncrementalStartTime(
    interval: string,
    lastTime: string | number | null,
    nowSeconds: number = Math.floor(Date.now() / 1000)
): number | null {
    if (lastTime === null) return null;
    const barSeconds = IBKR_INTERVAL_SECONDS[interval];
    if (!barSeconds) return null;
    const last = typeof lastTime === "number"
        ? lastTime
        : Math.floor(new Date(lastTime).getTime() / 1000);
    if (!Number.isFinite(last) || last <= 0) return null;
    // Defensive: if the recorded lastTime is in the future (clock skew or a
    // bad write), fall back to full sync rather than asking IBKR for a
    // start-time in the future.
    if (last > nowSeconds + barSeconds) return null;
    return last - 2 * barSeconds;
}

async function fetchHistoricalChunk(
    resolved: IbkrResolvedContract,
    interval: string,
    period: string,
    startTime?: number
): Promise<OHLCVData[]> {
    const params = new URLSearchParams({
        conid: resolved.conid,
        period,
        bar: IBKR_BAR_BY_INTERVAL[interval],
        outsideRth: "false",
    });
    if (startTime !== undefined) {
        params.set("startTime", formatIbkrStartTime(startTime));
    }
    const payload = await fetchGatewayJsonAuthenticated(`/iserver/marketdata/history?${params.toString()}`);
    return parseHistoryCandles(payload);
}

function isRetryableHistoryError(error: unknown): error is HttpStatusError {
    return error instanceof HttpStatusError
        && (error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504);
}

async function fetchHistorical(
    resolved: IbkrResolvedContract,
    interval: string,
    period: string,
    incrementalFromTime?: number
): Promise<OHLCVData[]> {
    const maxSync = isMaxHistoryPeriod(period);
    const requestPeriod = maxSync
        ? MAX_SYNC_CHUNK_PERIOD_BY_INTERVAL[interval] ?? DEFAULT_PERIOD_BY_INTERVAL[interval] ?? "1y"
        : period;
    const periodMs = maxSync ? null : parsePeriodToMs(requestPeriod);
    const maxChunks = maxSync ? IBKR_HISTORY_MAX_SYNC_CHUNKS : IBKR_HISTORY_MAX_CHUNKS;

    // Incremental merge: previously this re-merged every prior chunk on each
    // iteration via `mergeCandlesByTime(chunks.flat())`, making a max sync
    // O(N²) in chunk count. We now fold each chunk into a single map and only
    // sort once at the end. The break conditions and period-coverage early
    // exit behave identically to the prior implementation.
    //
    // Incremental sync: when `incrementalFromTime` is supplied (repeat sync),
    // the first chunk is requested with that startTime so we only fetch bars
    // newer than what's already on disk. The break condition below stops the
    // backward walk as soon as a chunk reaches existing data.
    const byTime = new Map<number, OHLCVData>();
    let oldestTime = Infinity;
    let newestTime = -Infinity;
    let nextStartTime: number | undefined = incrementalFromTime;
    let previousFirstTime: number | null = null;

    for (let i = 0; i < maxChunks; i += 1) {
        if (stopRequested) break;
        let chunk: OHLCVData[] | null = null;
        try {
            chunk = await fetchHistoricalChunk(resolved, interval, requestPeriod, nextStartTime);
        } catch (error) {
            if (!maxSync || !isRetryableHistoryError(error)) {
                throw error;
            }
            let recovered = false;
            for (let retryIndex = 0; retryIndex < IBKR_HISTORY_RETRY_DELAYS_MS.length; retryIndex += 1) {
                await wait(IBKR_HISTORY_RETRY_DELAYS_MS[retryIndex]!);
                try {
                    chunk = await fetchHistoricalChunk(resolved, interval, requestPeriod, nextStartTime);
                    recovered = true;
                    break;
                } catch (retryError) {
                    if (!isRetryableHistoryError(retryError) || retryIndex === IBKR_HISTORY_RETRY_DELAYS_MS.length - 1) {
                        if (byTime.size > 0) {
                            debugLogger.warn("ibkr.history.partialMax", {
                                target: "ibkr",
                                conid: resolved.conid,
                                interval,
                                period,
                                startTime: nextStartTime ?? null,
                                bars: byTime.size,
                                error: retryError instanceof Error ? retryError.message : String(retryError),
                            });
                            return mergeSortedFromMap(byTime);
                        }
                        throw retryError;
                    }
                }
            }
            if (!recovered) break;
        }
        if (chunk === null) break;
        if (chunk.length === 0) break;

        for (const bar of chunk) {
            const time = Number(bar.time);
            if (!Number.isFinite(time)) continue;
            byTime.set(time, bar);
            if (time < oldestTime) oldestTime = time;
            if (time > newestTime) newestTime = time;
        }

        if (periodMs !== null
            && Number.isFinite(oldestTime)
            && Number.isFinite(newestTime)
            && oldestTime * 1000 <= newestTime * 1000 - periodMs) {
            return trimCandlesToPeriod(mergeSortedFromMap(byTime), period);
        }
        // Incremental stop: we've reached the start of data we already have.
        // No need to page further backward.
        if (incrementalFromTime !== undefined
            && Number.isFinite(oldestTime)
            && oldestTime <= incrementalFromTime) {
            break;
        }
        if (!maxSync && chunk.length < IBKR_HISTORY_SOFT_LIMIT) break;

        const firstTime = Number(chunk[0]?.time);
        if (!Number.isFinite(firstTime)) break;
        if (previousFirstTime !== null && firstTime >= previousFirstTime) break;
        previousFirstTime = firstTime;
        nextStartTime = firstTime;
        if (maxSync) {
            await wait(IBKR_HISTORY_CHUNK_DELAY_MS);
        }
    }

    const merged = mergeSortedFromMap(byTime);
    return maxSync ? merged : trimCandlesToPeriod(merged, requestPeriod);
}

function mergeSortedFromMap(byTime: Map<number, OHLCVData>): OHLCVData[] {
    return Array.from(byTime.values()).sort((a, b) => Number(a.time) - Number(b.time));
}

async function syncOneSymbol(
    catalog: IbkrCatalog,
    symbol: string,
    interval: string,
    period: string,
    syncOnly: boolean
): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const existingEntry = findCatalogEntry(catalog, symbol);

    // Cached conid: skip `resolveSymbol` when the catalog has a fresh one.
    // Falls back to a fresh resolve if the cached conid returns 0 bars
    // (handles corporate actions / stale conids without silent wrong data).
    let resolved: IbkrResolvedContract | null = resolveFromCatalog(existingEntry);
    let usedCachedConid = resolved !== null;
    if (!resolved) {
        resolved = await resolveSymbol(symbol);
    }

    // Incremental sync: for bounded periods with a known last bar, narrow the
    // fetch window. `max` must still walk backward for a full backfill.
    let incrementalFromTime: number | undefined;
    if (shouldUseIncrementalIbkrSync(syncOnly, period, existingEntry !== undefined)) {
        const lastIso = existingEntry!.intervals[interval]?.lastTime ?? null;
        incrementalFromTime = computeIncrementalStartTime(interval, lastIso) ?? undefined;
    }

    let fetched = await fetchHistorical(resolved, interval, period, incrementalFromTime);
    if (fetched.length === 0 && usedCachedConid) {
        debugLogger.info("ibkr.sync.conidFallback", {
            target: "ibkr",
            symbol,
            interval,
            reason: "0 bars with cached conid; re-resolving",
        });
        resolved = await resolveSymbol(symbol);
        usedCachedConid = false;
        fetched = await fetchHistorical(resolved, interval, period, incrementalFromTime);
    }
    if (fetched.length === 0) {
        throw new HttpStatusError(502, `IBKR returned no ${interval} bars for ${symbol}.`);
    }

    const existing = syncOnly ? readCsvCandles(symbol, interval) : [];
    const merged = mergeCandlesByTime([...existing, ...fetched]);
    writeCsv(symbol, interval, merged);
    const catalogEntry = upsertCatalogEntry(catalog, { symbol, interval, candles: merged, resolved });
    debugLogger.info("ibkr.sync.symbol", {
        target: "ibkr",
        symbol,
        interval,
        mode: syncOnly ? "sync" : "download",
        bars: merged.length,
        fetchedBars: fetched.length,
        incremental: incrementalFromTime !== undefined,
        cachedConid: usedCachedConid,
        durationMs: Date.now() - startedAt,
    });
    return {
        symbol,
        markedSymbol: markIbkrSymbol(symbol),
        interval,
        bars: merged.length,
        fetchedBars: fetched.length,
        firstTime: catalogEntry.intervals[interval]?.firstTime ?? null,
        lastTime: catalogEntry.intervals[interval]?.lastTime ?? null,
        filePath: getCsvPath(symbol, interval),
        conid: resolved.conid,
    };
}

function readCatalogAssets(): Array<{ symbol: string; name: string; sector?: string; intervals?: string[] }> {
    const catalog = readCatalog();
    const bySymbol = new Map<string, { symbol: string; name: string; sector?: string; intervals?: string[] }>();
    for (const entry of catalog.entries) {
        bySymbol.set(entry.markedSymbol, {
            symbol: entry.markedSymbol,
            name: entry.symbol,
            intervals: Object.keys(entry.intervals ?? {}).sort(),
        });
    }

    if (existsSync(IBKR_CSV_DIR)) {
        for (const intervalEntry of readdirSync(IBKR_CSV_DIR, { withFileTypes: true })) {
            if (!intervalEntry.isDirectory()) continue;
            const interval = intervalEntry.name.toLowerCase();
            const intervalDir = resolve(IBKR_CSV_DIR, intervalEntry.name);
            for (const file of readdirSync(intervalDir, { withFileTypes: true })) {
                if (!file.isFile() || !file.name.toLowerCase().endsWith(".csv")) continue;
                const symbol = file.name.slice(0, -4).trim().toUpperCase();
                if (!symbol || !/^[A-Z0-9._-]+$/.test(symbol)) continue;
                const marked = markIbkrSymbol(symbol);
                const existing = bySymbol.get(marked) ?? { symbol: marked, name: symbol, intervals: [] };
                if (!existing.intervals?.includes(interval)) {
                    existing.intervals = [...(existing.intervals ?? []), interval].sort();
                }
                bySymbol.set(marked, existing);
            }
        }
    }

    return Array.from(bySymbol.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

type SyncStreamEvent = Record<string, unknown> & { type: string };
type SyncStreamWriter = (event: SyncStreamEvent) => void;

/**
 * Core batch loop, factored out of the HTTP handler so it can be tested and
 * so the NDJSON writer is the only thing that depends on the HTTP response.
 *
 * `writer` receives one event per symbol plus a final `done` event. The
 * catalog is read once and mutated in place across all symbols; a write
 * fires after each successful symbol (atomic temp+rename) so completed
 * symbols survive an interrupted batch. The `owner` param keys cancellation:
 * the loop bails as soon as `syncOwner !== owner` (Stop or a newer sync).
 */
async function processSyncBatch(
    body: Record<string, unknown>,
    syncOnly: boolean,
    writer: SyncStreamWriter,
    owner: number
): Promise<void> {
    const symbols = normalizeSymbols(body.symbols ?? body.symbol);
    const interval = normalizeInterval(body.interval);
    const period = String(body.period ?? DEFAULT_PERIOD_BY_INTERVAL[interval] ?? "1y").trim();

    // Populate the in-progress snapshot so a browser reload can reattach via
    // GET /api/ibkr/sync/status. Cleared in handleSyncRequest's finally when
    // the batch ends (cleanly, cancelled, or fatal).
    syncRunState = {
        startedAt: new Date().toISOString(),
        mode: syncOnly ? "sync" : "download",
        interval,
        period: period || null,
        total: symbols.length,
        index: 0,
        completed: 0,
        failed: 0,
        currentSymbol: null,
        failedSymbols: [],
        cancelled: false,
    };
    // Capture the run-state object by identity. Cancellation checks below
    // branch on `syncOwner !== owner`, and the snapshot mutations check
    // `syncRunState === runState`. Together these prevent an old owner's
    // late iteration from corrupting a new owner's lock or snapshot — the
    // hazard that the bare `stopRequested` boolean could not prevent.
    const runState = syncRunState;

    writer({ type: "start", total: symbols.length, interval, period: period || null, mode: syncOnly ? "sync" : "download" });

    const results: unknown[] = [];
    const failed: unknown[] = [];
    let cancelled = false;
    const catalog = readCatalog();

    // `lostOwnership` is true once Stop force-resets the lock or a newer sync
    // takes it. Subsequent iterations observe this and break ASAP. The
    // per-iteration `syncOwner !== owner` re-check covers the case where
    // ownership changed during the await.
    const lostOwnership = () => syncOwner !== owner;

    try {
        for (let index = 0; index < symbols.length; index += 1) {
            if (lostOwnership()) {
                cancelled = true;
                if (syncRunState === runState) runState.cancelled = true;
                break;
            }
            const symbol = symbols[index]!;
            if (syncRunState === runState) {
                runState.index = index;
                runState.currentSymbol = symbol;
            }
            try {
                const result = await syncOneSymbol(catalog, symbol, interval, period, syncOnly);
                // Re-check ownership after the await: a Stop or newer sync
                // may have arrived mid-fetch. If so, drop this result and
                // break without writing — the new owner owns the catalog.
                if (lostOwnership()) {
                    cancelled = true;
                    if (syncRunState === runState) runState.cancelled = true;
                    break;
                }
                results.push(result);
                if (syncRunState === runState) runState.completed += 1;
                // Per-symbol catalog write: ensures completed symbols appear
                // in the catalog even if the batch is interrupted (reload,
                // crash, fatal on a later symbol). The atomic temp+rename in
                // writeCatalog keeps each individual write safe.
                writeCatalog(catalog);
                writer({ type: "symbol", index, total: symbols.length, ...result });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                debugLogger.warn("ibkr.sync.symbol.failed", {
                    target: "ibkr",
                    symbol,
                    interval,
                    mode: syncOnly ? "sync" : "download",
                    error: message,
                });
                failed.push({ symbol, error: message });
                if (syncRunState === runState) {
                    runState.failed += 1;
                    runState.failedSymbols.push({ symbol, error: message });
                }
                writer({ type: "symbol_failed", index, total: symbols.length, symbol, error: message });
            }
        }
    } finally {
        if (syncRunState === runState) {
            runState.index = runState.completed + runState.failed;
            runState.currentSymbol = null;
        }
    }

    writer({
        type: "done",
        ok: failed.length === 0 && !cancelled,
        cancelled,
        interval,
        totals: {
            bars: results.reduce((sum: number, row) => sum + (Number((row as Record<string, unknown>).bars) || 0), 0),
            fetchedBars: results.reduce((sum: number, row) => sum + (Number((row as Record<string, unknown>).fetchedBars) || 0), 0),
        },
        results,
        failed,
    });
}

async function handleSyncRequest(res: ViteHttpResponse, body: Record<string, unknown>, syncOnly: boolean): Promise<void> {
    if (syncOwner !== SYNC_OWNER_NONE) {
        // Thrown before the stream is opened, so the endpoint handler's catch
        // sends this as a normal JSON error.
        throw new HttpStatusError(409, "An IBKR sync is already running. Use Stop first.");
    }
    const owner = ++syncOwnerGen;
    syncOwner = owner;
    // Note: we do NOT reset `stopRequested` here. Cancellation keys off
    // ownership (`syncOwner !== owner`) inside processSyncBatch, not the
    // boolean. `stopRequested` is now only consulted by fetchHistorical's
    // inner chunk loop and remains meaningful for in-flight requests.
    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processSyncBatch(body, syncOnly, stream.write, owner);
        stream.end();
    } catch (error) {
        if (!stream) throw error;
        // Stream already started: surface the error as a terminal event so
        // the NDJSON client sees a clean end-of-stream rather than a partial
        // JSON line from `sendCaughtErrorJson`. Wrapped in try/catch: if the
        // error was caused by the socket dying, this final write can throw
        // synchronously and we don't want to mask the original error or
        // propagate an 'ERR_STREAM_WRITE_AFTER_END'.
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("ibkr.sync.fatal", {
            target: "ibkr",
            mode: syncOnly ? "sync" : "download",
            error: message,
        });
        try {
            stream.end({ type: "fatal", error: message });
        } catch {
            // Best-effort: the connection is likely already gone.
        }
    } finally {
        // Only release the lock if we still own it. If Stop force-bumped the
        // generation and a newer sync has since taken the lock, our stale
        // owner value no longer matches `syncOwner` — leave it alone so we
        // don't clobber the newer sync's lock.
        if (syncOwner === owner) {
            syncOwner = SYNC_OWNER_NONE;
        }
        // Clear the in-progress snapshot only if we still own it. A newer
        // sync that started after a Stop force-reset will have repopulated
        // `syncRunState` itself; don't wipe its state.
        if (syncRunState && syncOwner === SYNC_OWNER_NONE) {
            syncRunState = null;
        }
    }
}

export function ibkrDataVitePlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use("/api/local-price-data/ibkr/catalog", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            const assets = readCatalogAssets();
            sendJson(res, 200, {
                ok: true,
                dataset: "ibkr-stock",
                count: assets.length,
                assets,
            });
        });

        middlewares.use("/api/ibkr/status", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                const payload = await ensureBrokerageSession();
                const brokerageOk = isAuthenticatedBrokerageSession(payload);
                let marketData: IbkrMarketDataReadiness | null = null;
                let ticklePayload: unknown = null;
                if (brokerageOk) {
                    try {
                        ticklePayload = await tickleGateway();
                        marketData = describeIbkrMarketDataReadiness(ticklePayload);
                    } catch (tickleError) {
                        marketData = {
                            ok: false,
                            error: tickleError instanceof Error ? tickleError.message : String(tickleError),
                            warning: null,
                            hmds: null,
                        };
                    }
                }
                sendJson(res, isAuthenticatedBrokerageSession(payload) ? 200 : 401, {
                    ok: brokerageOk && (marketData?.ok ?? true),
                    gatewayUrl: getGatewayUrl(),
                    keepAlive: {
                        active: keepAliveTimer !== null,
                        intervalMs: IBKR_KEEPALIVE_INTERVAL_MS,
                        lastTickleAt: lastKeepAliveAt,
                        lastError: lastKeepAliveError,
                    },
                    marketData,
                    payload,
                    ticklePayload,
                    ...(brokerageOk && marketData && !marketData.ok && marketData.error
                        ? { error: marketData.error }
                        : {}),
                    ...(!brokerageOk
                        ? { error: "IBKR Gateway is reachable, but the brokerage session is not authenticated." }
                        : {}),
                });
            } catch (error) {
                if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
                    sendJson(res, error.status, {
                        ok: false,
                        error: "IBKR Gateway is reachable, but the Client Portal API session is not authenticated. Reopen https://localhost:5000, complete login, then confirm /v1/api/iserver/auth/status returns authenticated=true and connected=true.",
                        detail: error.message,
                    });
                    return;
                }
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/ibkr/resolve", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                const body = await readJsonBody(req);
                const symbols = normalizeSymbols(body.symbols ?? body.symbol);
                const stream = beginNdjsonStream(res);
                const results = [];
                const failed = [];
                stream.write({ type: "start", total: symbols.length, mode: "resolve" });
                for (let index = 0; index < symbols.length; index += 1) {
                    const symbol = symbols[index]!;
                    try {
                        const resolved = await resolveSymbol(symbol);
                        results.push(resolved);
                        stream.write({ type: "symbol", index, total: symbols.length, ...resolved });
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        failed.push({ symbol, error: message });
                        stream.write({ type: "symbol_failed", index, total: symbols.length, symbol, error: message });
                    }
                }
                stream.end({ type: "done", ok: failed.length === 0, results, failed });
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/ibkr/download", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                await handleSyncRequest(res as ViteHttpResponse, await readJsonBody(req), false);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/ibkr/sync", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                await handleSyncRequest(res as ViteHttpResponse, await readJsonBody(req), true);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/ibkr/stop", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            stopRequested = true;
            // Force-reset the sync lock so a stuck/hung sync can be recovered
            // without a server restart. The in-flight processSyncBatch checks
            // `syncOwner !== owner` between symbols and after each await, so
            // dropping the lock here causes the running batch to bail at the
            // next observation point. A new sync can then acquire the lock
            // immediately (`++syncOwnerGen` produces a value > any prior
            // owner, so the old batch's late `finally` won't clobber it).
            syncOwner = SYNC_OWNER_NONE;
            sendJson(res, 200, { ok: true, stopped: true });
        });

        middlewares.use("/api/ibkr/sync/status", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            // Snapshot the in-progress run state (if any) for browser-side
            // reattachment after a reload. The server keeps syncing after the
            // NDJSON response stream is gone; this endpoint is how the UI
            // discovers and presents that still-running work.
            sendJson(res, 200, {
                ok: true,
                running: syncRunState !== null,
                run: syncRunState,
            });
        });
    };

    return {
        name: "ibkr-data",
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}
