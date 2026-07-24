import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import { debugLogger } from "../debug-logger";
import { markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/strategies";
import { beginNdjsonStream, HttpStatusError, readJsonBody, sendCaughtErrorJson, sendJson, type ViteHttpResponse } from "../vite-http-utils";
import { isAllowedLocalRequest } from "../local-route-authorization";
import { createFetchTimeoutSignal, isAbortError } from "../dataProviders/fetch-helpers";
import type { IbkrIntervalMeta, IbkrStreamEvent, IbkrSyncRunSnapshot } from "./ibkr-data-stream-types";
import {
    ALPACA_SUPPORTED_INTERVAL,
    ALPACA_TIMEFRAME_BY_INTERVAL,
    fetchAlpacaBars,
    resolveAlpacaConfig,
    type AlpacaConfig,
} from "./alpaca-fetcher";

// Re-export so existing imports of the wire types and snapshot type from the
// plugin module keep resolving. The single source of truth now lives in the
// shared leaf `ibkr-data-stream-types` module imported by both server and
// browser.
export type { IbkrStreamEvent, IbkrSyncRunSnapshot };

const APP_ROOT = process.cwd();
const IBKR_DATA_DIR = resolve(APP_ROOT, "price-data", "ibkr");
const IBKR_CSV_DIR = resolve(IBKR_DATA_DIR, "csv");
const IBKR_CATALOG_PATH = resolve(IBKR_DATA_DIR, "catalog.json");
// Pin to 127.0.0.1, not "localhost": Node resolves localhost to ::1 first and
// the gateway listens on IPv6 too, but its conf.yaml IP allowlist only permits
// 127.0.0.1 — an IPv6 connection gets a 404 "Access Denied" from the gateway
// even though TCP connects fine. The TLS dispatcher below already treats
// 127.0.0.1 as localhost (rejectUnauthorized: false), so no cert issue.
const DEFAULT_GATEWAY_URL = "https://127.0.0.1:5000/v1/api";
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
const IBKR_AUTH_RECOVERY_DELAY_MS = 3_000;
// Auth-cache TTL: `fetchGatewayJsonAuthenticated` previously called
// `ensureBrokerageSession()` before every gateway request, and that helper
// makes an HTTP round-trip to /iserver/auth/status. For a 20-symbol sync
// (~60-100 gateway calls) that was 10-20s of pure auth overhead. The TTL is
// comfortably shorter than `IBKR_KEEPALIVE_INTERVAL_MS` and is invalidated
// immediately on a 401 in the retry path below.
const IBKR_AUTH_CACHE_TTL_MS = 30_000;
// Per-gateway-request timeout. The Gateway is a local HTTPS service with no
// inherent request deadline — without this cap, a wedged Gateway hangs sync,
// Stop completion, status, and keepalive indefinitely. Composed with the
// active sync's abort signal inside `requestGatewayText` via
// `createFetchTimeoutSignal`, so both Stop-abort and a slow Gateway abort the
// fetch.
const IBKR_GATEWAY_TIMEOUT_MS = 45_000;
// Cached-conid TTL: bounds how long `syncOneSymbol` will trust a catalog
// entry's conid before re-resolving. Conids can change on corporate actions
// / ticker remaps; the 0-bars fallback below covers the rare stale case.
const IBKR_CONID_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IBKR_NO_ADVANCE_STALE_MS = 5 * 24 * 60 * 60 * 1000;
// IBKR mutation routes (sync/download/resolve/stop) are local-control-plane
// operations: the IBKR Gateway itself is https://localhost:5000 and the only
// documented remote path (the Cloudflare Tunnel in run_playground.bat) is for
// candle proxying, gated on LOCAL_PROXY_TOKEN. Reject any non-loopback caller
// that doesn't present the shared bearer token, so the tunnel can't be used
// to drive auth recovery / CSV writes / Stop remotely.
const IBKR_BODY_LIMIT_BYTES = 64 * 1024;
const IBKR_MAX_SYNC_SYMBOLS = 500;
let syncAbortController: AbortController | null = null;
// Sync lock: instead of a bare boolean, an owner-generation counter. Stop
// aborts the in-flight run via `syncAbortController` but does NOT release
// ownership here — the run's own `finally` is the only place the lock is
// released, so an aborted run's late per-symbol writes cannot overlap a new
// run's writes. A stuck sync's late `finally` only writes its own (stale)
// owner value back to SYNC_OWNER_NONE, so it cannot clobber a newer sync
// that has since acquired the lock with a newer generation.
const SYNC_OWNER_NONE = 0;
let syncOwner = SYNC_OWNER_NONE;
let syncOwnerGen = 0;

// In-progress sync snapshot. Populated when a sync starts, cleared when it
// ends. Used by GET /api/ibkr/sync/status so a browser reload can show the
// running batch instead of "Ready" — the server keeps syncing after the
// NDJSON response stream is gone, this is how the UI reattaches.
//
// `SyncRunState` is now a alias for the shared `IbkrSyncRunSnapshot` wire type
// (single source of truth in `ibkr-data-stream-types.ts`). The two were
// structurally identical before; the alias makes any future field drift a
// compile-time failure on both server and browser instead of a silent
// reattach-polling regression.
export type SyncRunState = IbkrSyncRunSnapshot;
let syncRunState: SyncRunState | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveInFlight = false;
let authRecoveryInFlight: Promise<unknown> | null = null;
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
    intervals: Record<string, IbkrIntervalMeta>;
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
    if (symbols.length > IBKR_MAX_SYNC_SYMBOLS) {
        throw new HttpStatusError(400, `Too many IBKR symbols; maximum is ${IBKR_MAX_SYNC_SYMBOLS}.`);
    }
    return symbols;
}

/**
 * Validates a sync `period` against the shapes IBKR actually accepts:
 * `max` / `all` (full backfill) or a positive count + d/w/m/y unit. Rejects
 * arbitrary strings so a malformed period can't flow silently into the
 * fetch window math (where it would otherwise be treated as "unbounded").
 */
export function normalizePeriod(period: string): string {
    const trimmed = period.trim();
    if (/^(max|all)$/i.test(trimmed) || /^[1-9]\d*[dwmy]$/i.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    throw new HttpStatusError(400, `Invalid IBKR period "${period}". Expected max, all, or e.g. 1d/2w/3m/1y.`);
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
        // Let caller aborts (Stop / newer sync) propagate as-is so the sync
        // loop can recognize them via `signal?.aborted` and mark the run
        // cancelled instead of treating it as a Gateway failure. A pure
        // IBKR_GATEWAY_TIMEOUT_MS expiry (signal not aborted) is reported as a
        // 502 so the user sees "Gateway timed out" rather than a cancel.
        if (init?.signal && init.signal.aborted) {
            throw error;
        }
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

    // Compose the per-request timeout with the caller's abort signal (e.g. the
    // active sync's AbortController). Either one aborting the fetch is enough;
    // `cleanup()` clears the timeout and detaches the listener. Without this
    // cap a wedged Gateway hangs sync/Stop/status/keepalive indefinitely.
    const callerSignal = init?.signal ?? undefined;
    const timeout = createFetchTimeoutSignal(callerSignal, IBKR_GATEWAY_TIMEOUT_MS);
    return fetch(url, {
        method: init?.method ?? "GET",
        headers,
        body,
        signal: timeout.signal,
        ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: unknown }).then(async (response) => {
        return {
            status: response.status,
            text: await response.text(),
        };
    }).finally(() => {
        timeout.cleanup();
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

/**
 * Abortable sleep. Resolves after `ms` unless `signal` aborts first, in which
 * case it rejects with the signal's abort reason (an AbortError-shaped error).
 * Used for retry/backoff waits inside `fetchHistorical` so a Stop abort is
 * observed within one event-loop tick rather than after the full delay.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) {
        return Promise.reject((signal as AbortSignal & { reason?: unknown }).reason ?? new Error("Aborted"));
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timeout);
            reject((signal as AbortSignal & { reason?: unknown })?.reason ?? new Error("Aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

type IbkrKeepAliveDependencies = {
    tickle: () => Promise<unknown>;
    recover: (trigger: string) => Promise<unknown>;
};

export async function runIbkrKeepAliveCycle(dependencies: IbkrKeepAliveDependencies): Promise<void> {
    let payload: unknown;
    try {
        payload = await dependencies.tickle();
    } catch (error) {
        if (!(error instanceof HttpStatusError) || (error.status !== 401 && error.status !== 403)) {
            throw error;
        }
        cachedAuthExpiry = 0;
        const recoveredStatus = await dependencies.recover(`keepalive-${error.status}`);
        if (!isAuthenticatedBrokerageSession(recoveredStatus)) {
            throw new HttpStatusError(error.status, "IBKR keepalive could not recover the brokerage session.");
        }
        return;
    }

    const authStatus = getTickleAuthStatus(payload);
    if (authStatus && !isAuthenticatedBrokerageSession(authStatus)) {
        cachedAuthExpiry = 0;
        const recoveredStatus = await dependencies.recover("keepalive-status");
        if (!isAuthenticatedBrokerageSession(recoveredStatus)) {
            throw new HttpStatusError(401, "IBKR keepalive could not recover the brokerage session.");
        }
    }
}

function startKeepAlive(): void {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
        // Skip if a previous cycle is still in flight. Without this guard a
        // wedged Gateway (each cycle now bounded to 45s but still slow) would
        // let overlapping `setInterval` ticks queue concurrent keepalive
        // fetches and concurrent auth-recovery attempts.
        if (keepAliveInFlight) return;
        keepAliveInFlight = true;
        void runIbkrKeepAliveCycle({
            tickle: tickleGateway,
            recover: recoverBrokerageSession,
        }).then(() => {
            lastKeepAliveError = null;
        }).catch((error) => {
            lastKeepAliveError = error instanceof Error ? error.message : String(error);
        }).finally(() => {
            keepAliveInFlight = false;
        });
    }, IBKR_KEEPALIVE_INTERVAL_MS);
    // Don't let the keepalive interval keep the Node process alive on its own
    // (e.g. after the Vite dev server closes). `unref()` is a no-op if the
    // timer has already cleared.
    keepAliveTimer.unref?.();
}

/**
 * Clears the keepalive interval and aborts any in-flight sync, for the Vite
 * server `close` hook (mirrors `local-sqlite-vite-plugin.ts`'s close-cleanup
 * idiom). Defense-in-depth: the run's own `finally` is the primary owner of
 * lock release, but clearing the timer here prevents a late keepalive tick
 * from firing after shutdown.
 */
function stopIbkrServerState(): void {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    keepAliveInFlight = false;
    syncAbortController?.abort();
}

async function initializeBrokerageSession(): Promise<void> {
    await fetchGatewayJson("/iserver/auth/ssodh/init", {
        method: "POST",
        // This tool only reads market data. Do not disconnect a concurrent
        // TWS, Client Portal, or IBKR Mobile brokerage session to prioritize
        // the Gateway connection.
        body: JSON.stringify({ publish: true, compete: false }),
    });
}

async function reauthenticateBrokerageSession(): Promise<void> {
    await fetchGatewayJson("/iserver/reauthenticate", {
        method: "POST",
        body: "{}",
    });
}

async function recoverBrokerageSession(trigger: string): Promise<unknown> {
    // Single-flight: keepalive and an in-flight sync can independently observe
    // a 401 and both call recovery. Dedupe to one in-flight recovery so we
    // don't fire overlapping ssodh/init + reauthenticate round-trips against
    // the Gateway. The `trigger` of the first caller wins for logging.
    if (authRecoveryInFlight) {
        return authRecoveryInFlight;
    }
    const promise = (async (): Promise<unknown> => {
        let lastError: unknown = null;
        try {
            await initializeBrokerageSession();
            await wait(IBKR_AUTH_RECOVERY_DELAY_MS);
            const status = await fetchGatewayJson("/iserver/auth/status");
            if (isAuthenticatedBrokerageSession(status)) {
                debugLogger.info("ibkr.auth.recovered", { target: "ibkr", trigger, method: "ssodh-init" });
                startKeepAlive();
                return status;
            }
            lastError = new Error("IBKR ssodh/init completed, but the brokerage session remained unauthenticated.");
        } catch (error) {
            if (!(error instanceof HttpStatusError) || (error.status !== 401 && error.status !== 403)) {
                throw error;
            }
            lastError = error;
        }

        try {
            await reauthenticateBrokerageSession();
            await wait(IBKR_AUTH_RECOVERY_DELAY_MS);
            const status = await fetchGatewayJson("/iserver/auth/status");
            if (isAuthenticatedBrokerageSession(status)) {
                debugLogger.info("ibkr.auth.recovered", { target: "ibkr", trigger, method: "reauthenticate" });
                startKeepAlive();
                return status;
            }
            const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "");
            throw new HttpStatusError(
                401,
                `IBKR brokerage session remained unauthenticated after automatic recovery.${detail ? ` Previous recovery error: ${detail}` : ""}`
            );
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
    })();
    authRecoveryInFlight = promise;
    try {
        return await promise;
    } finally {
        // Identity guard: don't clobber a newer recovery a concurrent caller
        // may have started after this one's await resolved.
        if (authRecoveryInFlight === promise) {
            authRecoveryInFlight = null;
        }
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

function summarizeCandles(
    candles: OHLCVData[],
    lastSyncAt: string,
    completeness?: { complete: boolean; stopReason: IbkrIntervalMeta["stopReason"] },
    source?: IbkrIntervalMeta["source"],
): IbkrCatalogEntry["intervals"][string] {
    const first = candles[0];
    const last = candles[candles.length - 1];
    return {
        firstTime: first ? new Date(Number(first.time) * 1000).toISOString() : null,
        lastTime: last ? new Date(Number(last.time) * 1000).toISOString() : null,
        bars: candles.length,
        lastSyncAt,
        ...(completeness ? { complete: completeness.complete, stopReason: completeness.stopReason } : {}),
        ...(source ? { source } : {}),
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
    if (isDerivativeExchange(entry.exchange) || isDerivativeExchange(entry.primaryExchange)) return null;
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
    completeness?: { complete: boolean; stopReason: IbkrIntervalMeta["stopReason"] };
    source?: IbkrIntervalMeta["source"];
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
    entry.intervals[args.interval] = summarizeCandles(args.candles, nowIso, args.completeness, args.source);
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

function toUtcDateKey(time: OHLCVData["time"]): string | null {
    const seconds = parseTimeToUnixSeconds(time);
    if (seconds === null) return null;
    return new Date(seconds * 1000).toISOString().slice(0, 10);
}

const COMMON_SPLIT_PRICE_FACTORS = [
    1 / 100, 1 / 50, 1 / 40, 1 / 30, 1 / 25, 1 / 20, 1 / 15, 1 / 12,
    1 / 10, 1 / 8, 1 / 7, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 2 / 3,
    1,
    3 / 2, 2, 3, 4, 5, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100,
] as const;
const SPLIT_FACTOR_TOLERANCE = 0.025;

function snapSplitPriceFactor(rawFactor: number): number | null {
    if (!Number.isFinite(rawFactor) || rawFactor <= 0) return null;
    let best: number | null = null;
    let bestDelta = Infinity;
    for (const candidate of COMMON_SPLIT_PRICE_FACTORS) {
        const delta = Math.abs(rawFactor - candidate) / candidate;
        if (delta < bestDelta) {
            best = candidate;
            bestDelta = delta;
        }
    }
    return best !== null && bestDelta <= SPLIT_FACTOR_TOLERANCE ? best : null;
}

function roundScaled(value: number, digits: number): number {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

export function adjustIntradayCandlesToDailyScale(
    intradayCandles: readonly OHLCVData[],
    dailyCandles: readonly OHLCVData[],
    interval: string
): OHLCVData[] {
    if (interval === "1d" || intradayCandles.length === 0 || dailyCandles.length === 0) {
        return [...intradayCandles];
    }

    const dailyByDate = new Map<string, OHLCVData>();
    for (const candle of dailyCandles) {
        const dateKey = toUtcDateKey(candle.time);
        if (dateKey) dailyByDate.set(dateKey, candle);
    }

    const intradayLastByDate = new Map<string, OHLCVData>();
    for (const candle of intradayCandles) {
        const dateKey = toUtcDateKey(candle.time);
        if (!dateKey) continue;
        const existing = intradayLastByDate.get(dateKey);
        if (!existing || Number(candle.time) >= Number(existing.time)) {
            intradayLastByDate.set(dateKey, candle);
        }
    }

    const priceFactorByDate = new Map<string, number>();
    for (const [dateKey, intraday] of intradayLastByDate) {
        const daily = dailyByDate.get(dateKey);
        if (!daily || intraday.close <= 0 || daily.close <= 0) continue;
        const priceFactor = snapSplitPriceFactor(daily.close / intraday.close);
        if (priceFactor === null || priceFactor === 1) continue;
        priceFactorByDate.set(dateKey, priceFactor);
    }

    if (priceFactorByDate.size === 0) return [...intradayCandles];

    return intradayCandles.map((candle) => {
        const dateKey = toUtcDateKey(candle.time);
        const priceFactor = dateKey ? priceFactorByDate.get(dateKey) : undefined;
        if (priceFactor === undefined) return { ...candle };
        const volumeFactor = 1 / priceFactor;
        return {
            ...candle,
            open: roundScaled(candle.open * priceFactor, 10),
            high: roundScaled(candle.high * priceFactor, 10),
            low: roundScaled(candle.low * priceFactor, 10),
            close: roundScaled(candle.close * priceFactor, 10),
            volume: roundScaled((candle.volume ?? 0) * volumeFactor, 6),
        };
    });
}

function adjustIntradayCandlesFromDailyCsv(symbol: string, interval: string, candles: OHLCVData[]): OHLCVData[] {
    if (interval === "1d") return candles;
    const daily = readCsvCandles(symbol, "1d");
    return adjustIntradayCandlesToDailyScale(candles, daily, interval);
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

const PREFERRED_US_STOCK_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "IEX"]);
const DERIVATIVE_EXCHANGES = new Set(["EUREX", "CME", "CBOT", "NYMEX", "COMEX", "GLOBEX"]);

function normalizeExchange(value: string | undefined): string {
    return String(value ?? "").trim().toUpperCase();
}

function isDerivativeExchange(value: string | undefined): boolean {
    return DERIVATIVE_EXCHANGES.has(normalizeExchange(value));
}

export function selectPreferredResolvedContract(
    contracts: readonly IbkrResolvedContract[],
): IbkrResolvedContract | null {
    if (contracts.length === 0) return null;
    const scored = contracts.map((contract, index) => {
        const primary = normalizeExchange(contract.primaryExchange);
        const exchange = normalizeExchange(contract.exchange);
        const score = (PREFERRED_US_STOCK_EXCHANGES.has(primary) ? 100 : 0)
            + (PREFERRED_US_STOCK_EXCHANGES.has(exchange) ? 50 : 0)
            + (normalizeExchange(contract.currency) === "USD" ? 10 : 0)
            - (isDerivativeExchange(primary) || isDerivativeExchange(exchange) ? 1_000 : 0);
        return { contract, index, score };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored[0]?.contract ?? null;
}

async function resolveSymbol(symbol: string): Promise<IbkrResolvedContract> {
    const params = new URLSearchParams({ symbol, sectype: "STK" });
    const payload = await fetchGatewayJsonAuthenticated(`/iserver/secdef/search?${params.toString()}`, {
        method: "POST",
        body: "{}",
    });
    const contracts = parseResolvedContracts(symbol, payload);
    const resolved = selectPreferredResolvedContract(contracts);
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

export function isStaleIbkrSyncWithoutAdvance(
    existingLastTime: string | null | undefined,
    fetched: readonly OHLCVData[],
    nowMs: number = Date.now(),
): boolean {
    if (!existingLastTime || fetched.length === 0) return false;
    const existingTime = Date.parse(existingLastTime);
    const fetchedTime = parseTimeToUnixSeconds(fetched[fetched.length - 1]?.time);
    if (!Number.isFinite(existingTime) || fetchedTime === null) return false;
    return nowMs - existingTime > IBKR_NO_ADVANCE_STALE_MS
        && fetchedTime * 1000 <= existingTime;
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
    startTime?: number,
    signal?: AbortSignal
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
    const payload = await fetchGatewayJsonAuthenticated(
        `/iserver/marketdata/history?${params.toString()}`,
        signal ? { signal } : undefined
    );
    return parseHistoryCandles(payload);
}

/**
 * IBKR's `startTime` is the end of a backward-looking history window. The
 * first incremental page must therefore omit it so the response is anchored
 * at the latest available candle. Later pages use the oldest prior candle to
 * continue walking backward until the saved CSV overlap is reached.
 */
export function resolveIbkrHistoryPageStartTime(
    pageIndex: number,
    previousFirstTime: number | null
): number | undefined {
    return pageIndex > 0 && previousFirstTime !== null
        ? previousFirstTime
        : undefined;
}

function isRetryableHistoryError(error: unknown): error is HttpStatusError {
    return error instanceof HttpStatusError
        && (error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504);
}

/**
 * Result of a historical fetch. `complete` is true only when the fetch covered
 * the full requested window without hitting the retry/chunk ceiling or being
 * cancelled — so the catalog and UI can distinguish a true full backfill from
 * a partial one instead of reporting every landed dataset as `ok: true`.
 */
export type HistoricalFetchResult = {
    candles: OHLCVData[];
    complete: boolean;
    stopReason: IbkrIntervalMeta["stopReason"];
    chunks: number;
    retries: number;
};

async function fetchHistorical(
    resolved: IbkrResolvedContract,
    interval: string,
    period: string,
    incrementalFromTime?: number,
    signal?: AbortSignal
): Promise<HistoricalFetchResult> {
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
    // Incremental sync: the first request intentionally omits `startTime` so
    // IBKR anchors the backward-looking window at the latest available bar.
    // Subsequent pages walk backward until a chunk reaches existing data.
    const byTime = new Map<number, OHLCVData>();
    let oldestTime = Infinity;
    let newestTime = -Infinity;
    let previousFirstTime: number | null = null;
    let chunkCount = 0;
    let retryCount = 0;

    for (let i = 0; i < maxChunks; i += 1) {
        // Observe Stop / newer-sync abort at the top of every iteration so the
        // backward walk bails within one event-loop tick of the abort rather
        // than waiting for the next chunk's gateway round-trip.
        if (signal?.aborted) {
            return {
                candles: mergeSortedFromMap(byTime),
                complete: false,
                stopReason: "cancelled",
                chunks: chunkCount,
                retries: retryCount,
            };
        }
        const pageStartTime = resolveIbkrHistoryPageStartTime(i, previousFirstTime);
        let chunk: OHLCVData[] | null = null;
        try {
            chunk = await fetchHistoricalChunk(resolved, interval, requestPeriod, pageStartTime, signal);
        } catch (error) {
            // Propagate aborts immediately as a `cancelled` result.
            if (signal?.aborted) {
                return {
                    candles: mergeSortedFromMap(byTime),
                    complete: false,
                    stopReason: "cancelled",
                    chunks: chunkCount,
                    retries: retryCount,
                };
            }
            if (!maxSync || !isRetryableHistoryError(error)) {
                throw error;
            }
            let recovered = false;
            for (let retryIndex = 0; retryIndex < IBKR_HISTORY_RETRY_DELAYS_MS.length; retryIndex += 1) {
                await wait(IBKR_HISTORY_RETRY_DELAYS_MS[retryIndex]!, signal);
                retryCount += 1;
                // The abortable wait rejects on abort; surface as cancelled.
                if (signal?.aborted) {
                    return {
                        candles: mergeSortedFromMap(byTime),
                        complete: false,
                        stopReason: "cancelled",
                        chunks: chunkCount,
                        retries: retryCount,
                    };
                }
                try {
                    chunk = await fetchHistoricalChunk(resolved, interval, requestPeriod, pageStartTime, signal);
                    recovered = true;
                    break;
                } catch (retryError) {
                    if (signal?.aborted) {
                        return {
                            candles: mergeSortedFromMap(byTime),
                            complete: false,
                            stopReason: "cancelled",
                            chunks: chunkCount,
                            retries: retryCount,
                        };
                    }
                    if (!isRetryableHistoryError(retryError) || retryIndex === IBKR_HISTORY_RETRY_DELAYS_MS.length - 1) {
                        if (byTime.size > 0) {
                            debugLogger.warn("ibkr.history.partialMax", {
                                target: "ibkr",
                                conid: resolved.conid,
                                interval,
                                period,
                                startTime: pageStartTime ?? null,
                                bars: byTime.size,
                                error: retryError instanceof Error ? retryError.message : String(retryError),
                            });
                            return {
                                candles: mergeSortedFromMap(byTime),
                                complete: false,
                                stopReason: "retry_exhausted",
                                chunks: chunkCount,
                                retries: retryCount,
                            };
                        }
                        throw retryError;
                    }
                }
            }
            if (!recovered) break;
        }
        if (chunk === null) break;
        if (chunk.length === 0) {
            // Empty chunk: the backward walk has reached available history.
            // For a max sync this is the normal "no more data" stop.
            return {
                candles: maxSync ? mergeSortedFromMap(byTime) : trimCandlesToPeriod(mergeSortedFromMap(byTime), requestPeriod),
                complete: true,
                stopReason: "no_more_data",
                chunks: chunkCount,
                retries: retryCount,
            };
        }
        chunkCount += 1;

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
            return {
                candles: trimCandlesToPeriod(mergeSortedFromMap(byTime), period),
                complete: true,
                stopReason: "covered",
                chunks: chunkCount,
                retries: retryCount,
            };
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
        if (maxSync) {
            // The abortable wait rejects on abort; catch that and break so the
            // fall-through return below classifies the run as cancelled. The
            // other abortable wait (retry backoff) is already inside a
            // try/catch that returns cancelled directly.
            try {
                await wait(IBKR_HISTORY_CHUNK_DELAY_MS, signal);
            } catch {
                if (signal?.aborted) break;
                throw new Error("Unexpected non-abort rejection from abortable wait.");
            }
        }
    }

    // Loop fell through without an explicit early-exit return. An abort that
    // broke out of the chunk-delay wait lands here — classify it as cancelled
    // before anything else so the caller's no-write-on-cancel invariant holds.
    if (signal?.aborted) {
        return {
            candles: maxSync ? mergeSortedFromMap(byTime) : trimCandlesToPeriod(mergeSortedFromMap(byTime), requestPeriod),
            complete: false,
            stopReason: "cancelled",
            chunks: chunkCount,
            retries: retryCount,
        };
    }
    const merged = mergeSortedFromMap(byTime);
    const candles = maxSync ? merged : trimCandlesToPeriod(merged, requestPeriod);
    // `chunk_limit`: we exhausted the chunk ceiling without the gateway
    // signalling no-more-data or full coverage. Only the max-sync path can
    // land here for a bounded period (`covered` returns early), so this is the
    // "incomplete max backfill" the catalog/UI must flag. A bounded-period
    // run that exhausted chunks is effectively complete for its window too —
    // but mark it incomplete to be safe, since we can't prove coverage.
    const hitChunkLimit = chunkCount >= maxChunks;
    return {
        candles,
        complete: maxSync ? !hitChunkLimit : true,
        stopReason: maxSync && hitChunkLimit ? "chunk_limit" : (maxSync ? "no_more_data" : "covered"),
        chunks: chunkCount,
        retries: retryCount,
    };
}

function mergeSortedFromMap(byTime: Map<number, OHLCVData>): OHLCVData[] {
    return Array.from(byTime.values()).sort((a, b) => Number(a.time) - Number(b.time));
}

async function syncOneSymbol(
    catalog: IbkrCatalog,
    symbol: string,
    interval: string,
    period: string,
    syncOnly: boolean,
    signal?: AbortSignal
): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const existingEntry = findCatalogEntry(catalog, symbol);

    // Cached conid: skip `resolveSymbol` when the catalog has a fresh one.
    // Falls back to a fresh resolve if the cached conid returns 0 bars
    // (handles corporate actions / stale conids without silent wrong data).
    const cachedResolved = resolveFromCatalog(existingEntry);
    let usedCachedConid = cachedResolved !== null;
    let resolved: IbkrResolvedContract = cachedResolved ?? await resolveSymbol(symbol);
    const assertContractStableForSync = (): void => {
        if (syncOnly && existingEntry?.conid && existingEntry.conid !== resolved.conid) {
            throw new HttpStatusError(
                409,
                `IBKR resolved ${symbol} to a different contract (${existingEntry.conid} -> ${resolved.conid}). Use Download with period=max to replace the old contract data instead of merging incompatible histories.`,
            );
        }
    };
    assertContractStableForSync();

    // Incremental sync: for bounded periods with a known last bar, narrow the
    // fetch window. `max` must still walk backward for a full backfill.
    let incrementalFromTime: number | undefined;
    if (shouldUseIncrementalIbkrSync(syncOnly, period, existingEntry !== undefined)) {
        const lastIso = existingEntry!.intervals[interval]?.lastTime ?? null;
        incrementalFromTime = computeIncrementalStartTime(interval, lastIso) ?? undefined;
    }

    let result = await fetchHistorical(resolved, interval, period, incrementalFromTime, signal);
    const isCancelled = (): boolean => result.stopReason === "cancelled" || signal?.aborted === true;
    if (!isCancelled() && result.candles.length === 0 && usedCachedConid) {
        debugLogger.info("ibkr.sync.conidFallback", {
            target: "ibkr",
            symbol,
            interval,
            reason: "0 bars with cached conid; re-resolving",
        });
        resolved = await resolveSymbol(symbol);
        usedCachedConid = false;
        assertContractStableForSync();
        result = await fetchHistorical(resolved, interval, period, incrementalFromTime, signal);
    }

    const existingLastTime = existingEntry?.intervals[interval]?.lastTime;
    if (!isCancelled() && syncOnly && isStaleIbkrSyncWithoutAdvance(existingLastTime, result.candles)) {
        if (usedCachedConid) {
            debugLogger.info("ibkr.sync.staleNoAdvanceReresolve", {
                target: "ibkr",
                symbol,
                interval,
                existingLastTime,
            });
            resolved = await resolveSymbol(symbol);
            usedCachedConid = false;
            assertContractStableForSync();
            result = await fetchHistorical(resolved, interval, period, incrementalFromTime, signal);
        }
        if (!isCancelled() && isStaleIbkrSyncWithoutAdvance(existingLastTime, result.candles)) {
            throw new HttpStatusError(
                502,
                `IBKR returned no ${interval} candles newer than ${existingLastTime} for ${symbol}, even after contract re-resolution.`,
            );
        }
    }

    // Cancellation invariant: if the fetch was aborted (Stop / newer sync),
    // do NOT write CSV or catalog. Ownership may already belong to a newer
    // run; writing here would race that run's writes. Surface as a cancelled
    // result so the batch loop can mark the run cancelled and move on.
    if (isCancelled()) {
        debugLogger.info("ibkr.sync.symbol.cancelled", {
            target: "ibkr",
            symbol,
            interval,
            bars: result.candles.length,
            durationMs: Date.now() - startedAt,
        });
        return {
            symbol,
            markedSymbol: markIbkrSymbol(symbol),
            interval,
            bars: 0,
            fetchedBars: 0,
            firstTime: null,
            lastTime: null,
            filePath: getCsvPath(symbol, interval),
            conid: resolved.conid,
            cancelled: true,
            complete: false,
            stopReason: "cancelled" as const,
        };
    }
    if (result.candles.length === 0) {
        throw new HttpStatusError(502, `IBKR returned no ${interval} bars for ${symbol}.`);
    }

    const fetched = result.candles;
    const existing = syncOnly ? readCsvCandles(symbol, interval) : [];
    const merged = adjustIntradayCandlesFromDailyCsv(symbol, interval, mergeCandlesByTime([...existing, ...fetched]));
    writeCsv(symbol, interval, merged);
    const catalogEntry = upsertCatalogEntry(catalog, {
        symbol,
        interval,
        candles: merged,
        resolved,
        completeness: { complete: result.complete, stopReason: result.stopReason },
        source: "ibkr",
    });
    debugLogger.info("ibkr.sync.symbol", {
        target: "ibkr",
        symbol,
        interval,
        mode: syncOnly ? "sync" : "download",
        bars: merged.length,
        fetchedBars: fetched.length,
        incremental: incrementalFromTime !== undefined,
        cachedConid: usedCachedConid,
        complete: result.complete,
        stopReason: result.stopReason,
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
        complete: result.complete,
        stopReason: result.stopReason,
        ...(result.complete ? {} : { warning: describeIncompleteStopReason(result.stopReason) }),
    };
}

/**
 * Human-readable reason for an incomplete max backfill, surfaced in the
 * `symbol_warning` stream event so the UI can show "completed with warnings".
 */
function describeIncompleteStopReason(stopReason: IbkrIntervalMeta["stopReason"]): string {
    switch (stopReason) {
        case "retry_exhausted": return "Late retries failed after partial data was fetched.";
        case "chunk_limit": return "Hit the maximum chunk ceiling before the full history was covered.";
        case "cancelled": return "Fetch was cancelled mid-backfill.";
        default: return "History fetch did not complete.";
    }
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

/** Supported data sources for the IBKR Data pipeline. */
export type IbkrDataSource = "ibkr" | "alpaca";

/**
 * Normalizes the request-body `source`.
 *
 * Backward compatibility: a missing or blank `source` defaults to `"ibkr"`
 * so existing IBKR requests (and old callers that never set `source`) route
 * to the IBKR fetcher unchanged.
 *
 * Audit Finding 2: a non-empty value that is neither `"ibkr"` nor `"alpaca"`
 * (e.g. a typo like `"alpacca"`) used to silently fall back to IBKR, which
 * could route an intended-Alpaca request to the IBKR Gateway and recreate
 * the rate-limit problem the source selector exists to avoid. Such a value
 * is now an explicit HTTP 400 so the typo surfaces at the request boundary
 * instead of producing silently-wrong-source data.
 *
 * Exported for unit tests.
 */
export function normalizeDataSource(value: unknown): IbkrDataSource {
    const raw = value == null ? "" : String(value).trim().toLowerCase();
    if (raw === "" || raw === "ibkr") return "ibkr";
    if (raw === "alpaca") return "alpaca";
    throw new HttpStatusError(
        400,
        `Unknown data source "${String(value)}". Supported sources: ibkr, alpaca.`,
    );
}

/**
 * Validates source-specific constraints that the request body alone cannot
 * enforce. Throws `HttpStatusError` (surfaced in the existing UI failure
 * path) for:
 *  - Alpaca + `interval !== "30m"` (initial scope is 30m bars only)
 *  - Alpaca + `period === "max"` (Alpaca `period=max` is rejected; bounded
 *    periods only — existing IBKR `max` behavior is unchanged)
 * Exported for unit tests.
 */
export function assertSourceConstraints(
    source: IbkrDataSource,
    interval: string,
    period: string,
): void {
    if (source !== "alpaca") return;
    if (interval !== ALPACA_SUPPORTED_INTERVAL) {
        throw new HttpStatusError(
            400,
            `Alpaca source only supports the ${ALPACA_SUPPORTED_INTERVAL} interval in this release. Use IBKR for ${interval}.`,
        );
    }
    if (isMaxHistoryPeriod(period)) {
        throw new HttpStatusError(
            400,
            "Alpaca source rejects period=max. Provide a bounded period (e.g. 1m, 3m, 1y).",
        );
    }
}

/**
 * Computes the `[start, end]` ISO-8601 window for an Alpaca bounded fetch.
 * `end` is now; `start` is `end - periodMs`. For incremental Alpaca syncs,
 * the caller passes `startOverride` (the catalog's last bar time) so the
 * window overlaps the existing data — the merge step's last-write-wins dedup
 * handles the overlap safely. Exported for unit tests.
 */
export function resolveAlpacaWindow(
    period: string,
    nowMs: number = Date.now(),
    startOverrideMs?: number,
): { start: string; end: string } {
    const periodMs = parsePeriodToMs(period);
    if (periodMs === null) {
        throw new HttpStatusError(400, `Invalid Alpaca period "${period}". Expected e.g. 1d/2w/3m/1y.`);
    }
    const endMs = nowMs;
    const startMs = startOverrideMs !== undefined && Number.isFinite(startOverrideMs)
        ? Math.max(0, startOverrideMs)
        : endMs - periodMs;
    return {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
    };
}

/**
 * Alpaca per-symbol worker — mirrors `syncOneSymbol`'s return shape so
 * `processSyncBatch` can treat both sources uniformly. Source guard:
 *  - Download replaces the target interval's dataset and records `source: "alpaca"`.
 *  - Sync requires the catalog interval to already be `source === "alpaca"`;
 *    otherwise the user must run Alpaca Download first. Never merge Alpaca
 *    rows into an IBKR/unknown interval.
 *
 * Credentials are read inside `resolveAlpacaConfig` and never flow into the
 * returned result, the catalog, the CSV, or stream events.
 *
 * `config` is injected so tests can avoid env coupling; production passes
 * `resolveAlpacaConfig()` lazily so a missing-env error surfaces per-run
 * rather than at module load.
 */
type AlpacaSymbolWorker = (
    catalog: IbkrCatalog,
    symbol: string,
    interval: string,
    period: string,
    syncOnly: boolean,
    signal?: AbortSignal,
    config?: AlpacaConfig,
) => Promise<Record<string, unknown>>;

export async function syncOneAlpacaSymbol(
    catalog: IbkrCatalog,
    symbol: string,
    interval: string,
    period: string,
    syncOnly: boolean,
    signal?: AbortSignal,
    config: AlpacaConfig = resolveAlpacaConfig(),
): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const existingEntry = findCatalogEntry(catalog, symbol);
    const existingInterval = existingEntry?.intervals[interval];
    const existingSource = existingInterval?.source;

    // Source guard for sync: an unknown or IBKR interval must NOT be merged
    // with Alpaca rows. Instruct the user to run Alpaca Download first.
    if (syncOnly && existingSource !== "alpaca") {
        const sourceLabel = existingSource ?? "unknown (pre-Alpaca catalog entry)";
        throw new HttpStatusError(
            409,
            `Alpaca sync requires the ${interval} interval for ${symbol} to already be Alpaca-sourced (current: ${sourceLabel}). Run Alpaca Download first to establish the source, then sync.`,
        );
    }

    const timeframe = ALPACA_TIMEFRAME_BY_INTERVAL[interval];
    if (!timeframe) {
        throw new HttpStatusError(400, `Alpaca source does not support interval "${interval}".`);
    }

    // Incremental sync: overlap the window with the last bar so late
    // corrections to the previous bar are re-fetched.
    const existingLastMs = existingInterval?.lastTime
        ? Date.parse(existingInterval.lastTime)
        : NaN;
    const startOverrideMs = syncOnly && Number.isFinite(existingLastMs)
        ? existingLastMs - ALPACA_SYNC_OVERLAP_MS
        : undefined;
    const window = resolveAlpacaWindow(period, Date.now(), startOverrideMs);

    const result = await fetchAlpacaBars(
        config,
        { symbol, timeframe, start: window.start, end: window.end },
        signal,
    );
    const isCancelled = (): boolean => result.stopReason === "cancelled" || signal?.aborted === true;

    // Cancellation invariant: no CSV/catalog writes if aborted. Mirrors
    // `syncOneSymbol`'s no-write-on-cancel path so ownership cannot race a
    // newer run's writes.
    if (isCancelled()) {
        debugLogger.info("alpaca.sync.symbol.cancelled", {
            target: "alpaca",
            symbol,
            interval,
            bars: result.candles.length,
            durationMs: Date.now() - startedAt,
        });
        return {
            symbol,
            markedSymbol: markIbkrSymbol(symbol),
            interval,
            bars: 0,
            fetchedBars: 0,
            firstTime: null,
            lastTime: null,
            filePath: getCsvPath(symbol, interval),
            cancelled: true,
            complete: false,
            stopReason: "cancelled" as const,
            source: "alpaca" as const,
        };
    }
    if (result.candles.length === 0) {
        throw new HttpStatusError(502, `Alpaca returned no ${interval} bars for ${symbol} in the requested window.`);
    }

    const fetched = result.candles;
    // Download replaces; sync merges with existing rows (the source guard
    // above guarantees existing is Alpaca when syncOnly is true).
    const existing = syncOnly ? readCsvCandles(symbol, interval) : [];
    const merged = mergeCandlesByTime([...existing, ...fetched]);
    writeCsv(symbol, interval, merged);
    // Map the fetcher's Alpaca-specific stopReason onto the catalog schema.
    // The fetcher uses `page_limit` for "hit the page ceiling"; the catalog's
    // documented equivalent is `chunk_limit` (same semantics: hit the ceiling
    // before full coverage). Keeping the catalog schema stable avoids a
    // migration and reuses the existing `describeIncompleteStopReason` case.
    const catalogStopReason = mapAlpacaStopReason(result.stopReason);
    const catalogEntry = upsertCatalogEntry(catalog, {
        symbol,
        interval,
        candles: merged,
        completeness: { complete: result.complete, stopReason: catalogStopReason },
        source: "alpaca",
    });
    debugLogger.info("alpaca.sync.symbol", {
        target: "alpaca",
        symbol,
        interval,
        mode: syncOnly ? "sync" : "download",
        bars: merged.length,
        fetchedBars: fetched.length,
        pages: result.pages,
        retries: result.retries,
        complete: result.complete,
        stopReason: result.stopReason,
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
        complete: result.complete,
        stopReason: catalogStopReason,
        source: "alpaca" as const,
        ...(result.complete ? {} : { warning: describeIncompleteStopReason(catalogStopReason) }),
    };
}

/**
 * Maps the Alpaca fetcher's stopReason onto the catalog's stopReason schema.
 * `"page_limit"` (the fetcher hit `ALPACA_MAX_PAGES_PER_SYMBOL` before
 * exhausting `next_page_token`) is documented in the catalog as
 * `"chunk_limit"` — same semantics, different name. `"covered"` and
 * `"cancelled"` pass through unchanged. Audit Finding 1: the page ceiling
 * MUST surface as incomplete, and this mapping is what makes the existing
 * `symbol_warning` + `describeIncompleteStopReason` paths fire for it.
 *
 * Exported for unit tests.
 */
export function mapAlpacaStopReason(stopReason: "covered" | "cancelled" | "page_limit"): IbkrIntervalMeta["stopReason"] {
    if (stopReason === "page_limit") return "chunk_limit";
    return stopReason;
}

// Back up by ~2 bars of overlap so late corrections to the previous bar are
// re-fetched during an Alpaca incremental sync. 30m bars → 2 * 30min.
const ALPACA_SYNC_OVERLAP_MS = 2 * 30 * 60 * 1000;

type ProcessSyncBatchOptions = {
    /** Override the per-symbol worker (test seam — mirrors crypto's fetcher). */
    fetcher?: typeof syncOneSymbol;
    /** Override the Alpaca per-symbol worker (test seam). */
    alpacaFetcher?: AlpacaSymbolWorker;
    /** Abort signal from the run's AbortController; Stop aborts this. */
    signal?: AbortSignal;
    /**
     * Inject Alpaca config (test seam). Production resolves lazily inside the
     * Alpaca worker so a missing-env error surfaces per-run.
     */
    alpacaConfig?: AlpacaConfig;
};

/**
 * Core batch loop, factored out of the HTTP handler so it can be tested and
 * so the NDJSON writer is the only thing that depends on the HTTP response.
 *
 * `writer` receives one event per symbol plus a final `done` event. The
 * catalog is read once and mutated in place across all symbols; a write
 * fires after each successful symbol (atomic temp+rename) so completed
 * symbols survive an interrupted batch. The `owner` param keys cancellation:
 * the loop bails as soon as `syncOwner !== owner` (Stop or a newer sync) OR
 * the run's abort signal fires — whichever the caller observes first.
 */
export async function processSyncBatch(
    body: Record<string, unknown>,
    syncOnly: boolean,
    writer: SyncStreamWriter,
    owner: number,
    options?: ProcessSyncBatchOptions
): Promise<void> {
    const signal = options?.signal;
    const source = normalizeDataSource(body.source);
    const symbols = normalizeSymbols(body.symbols ?? body.symbol);
    const interval = normalizeInterval(body.interval);
    const period = normalizePeriod(String(body.period ?? DEFAULT_PERIOD_BY_INTERVAL[interval] ?? "1y").trim());
    // Validate source-specific constraints BEFORE any work. Throws surface in
    // the existing UI failure path. Existing IBKR requests (no `source`) skip
    // this entirely — backward compatibility.
    assertSourceConstraints(source, interval, period);
    // Select the per-symbol worker by source. The Alpaca worker is wrapped so
    // the dispatch shape stays `(catalog, symbol, interval, period, syncOnly,
    // signal) => Promise<Record<string, unknown>>` and the batch loop below
    // is identical for both sources.
    const ibkrFetcher = options?.fetcher ?? syncOneSymbol;
    const alpacaFetcher = options?.alpacaFetcher ?? syncOneAlpacaSymbol;
    const alpacaConfig = options?.alpacaConfig;
    const fetcher = source === "alpaca"
        ? (async (catalog: IbkrCatalog, symbol: string, interval: string, period: string, syncOnly: boolean, signal?: AbortSignal) =>
            alpacaFetcher(catalog, symbol, interval, period, syncOnly, signal, alpacaConfig))
        : ibkrFetcher;

    // Populate the in-progress snapshot so a browser reload can reattach via
    // GET /api/ibkr/sync/status. Cleared in handleSyncRequest's finally when
    // the batch ends (cleanly, cancelled, or fatal).
    syncRunState = {
        startedAt: new Date().toISOString(),
        mode: syncOnly ? "sync" : "download",
        interval,
        period: period || null,
        source,
        total: symbols.length,
        index: 0,
        completed: 0,
        failed: 0,
        currentSymbol: null,
        failedSymbols: [],
        cancelled: false,
        completedSymbols: [],
        updatedAt: new Date().toISOString(),
    };
    // Capture the run-state object by identity. Cancellation checks below
    // branch on `syncOwner !== owner`, and the snapshot mutations check
    // `syncRunState === runState`. Together these prevent an old owner's
    // late iteration from corrupting a new owner's lock or snapshot — the
    // hazard that the bare `stopRequested` boolean could not prevent.
    const runState = syncRunState;
    const touchRunState = () => {
        if (syncRunState === runState) runState.updatedAt = new Date().toISOString();
    };

    writer({ type: "start", total: symbols.length, interval, period: period || null, mode: syncOnly ? "sync" : "download", source });

    const results: unknown[] = [];
    const failed: unknown[] = [];
    let cancelled = false;
    const catalog = readCatalog();

    // `lostOwnership()` is true only when a *newer* sync has taken the lock
    // (Stop no longer force-resets it — see /api/ibkr/stop). The per-iteration
    // re-check covers ownership changing during the await. The abort signal is
    // the primary cancellation path: Stop aborts it, which surfaces either as
    // `signal.aborted` or as a thrown AbortError caught below.
    const lostOwnership = () => syncOwner !== owner;
    const wasCancelled = () => lostOwnership() || signal?.aborted === true;

    try {
        for (let index = 0; index < symbols.length; index += 1) {
            if (wasCancelled()) {
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
                const result = await fetcher(catalog, symbol, interval, period, syncOnly, signal);
                // Re-check ownership/abort after the await: a Stop or newer
                // sync may have arrived mid-fetch. If so, drop this result and
                // break without writing — the new owner owns the catalog.
                if (wasCancelled()) {
                    cancelled = true;
                    if (syncRunState === runState) runState.cancelled = true;
                    break;
                }
                // A cancelled per-symbol result (fetch aborted mid-symbol but
                // observed before ownership changed) also ends the run.
                if ((result as Record<string, unknown>).cancelled === true) {
                    cancelled = true;
                    if (syncRunState === runState) runState.cancelled = true;
                    break;
                }
                results.push(result);
                const marked = String((result as Record<string, unknown>).markedSymbol ?? "");
                if (syncRunState === runState) {
                    runState.completed += 1;
                    if (marked && !runState.completedSymbols!.includes(marked)) {
                        runState.completedSymbols!.push(marked);
                    }
                }
                // Per-symbol catalog write: ensures completed symbols appear
                // in the catalog even if the batch is interrupted (reload,
                // crash, fatal on a later symbol). The atomic temp+rename in
                // writeCatalog keeps each individual write safe.
                writeCatalog(catalog);
                writer({ type: "symbol", index, total: symbols.length, ...result });
                // Partial-max warning: a landed dataset that didn't cover the
                // full window still counts as success, but the UI must not
                // treat it as a complete history.
                if ((result as Record<string, unknown>).complete === false) {
                    writer({
                        type: "symbol_warning",
                        index,
                        total: symbols.length,
                        symbol,
                        reason: String((result as Record<string, unknown>).warning ?? "History fetch did not complete."),
                        complete: false,
                    });
                }
                touchRunState();
            } catch (error) {
                // Abort during a fetch: mark cancelled, not failed, and break.
                if (signal?.aborted || isAbortError(error)) {
                    cancelled = true;
                    if (syncRunState === runState) runState.cancelled = true;
                    break;
                }
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
                touchRunState();
            }
        }
    } finally {
        if (syncRunState === runState) {
            runState.index = runState.completed + runState.failed;
            runState.currentSymbol = null;
            touchRunState();
        }
    }

    writer({
        type: "done",
        ok: failed.length === 0 && !cancelled,
        cancelled,
        interval,
        source,
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
    // One AbortController per run. Stop aborts it (cancels in-flight gateway
    // fetches within one event-loop tick) but does NOT release ownership —
    // the run's own `finally` below is the only place the lock is released,
    // so an aborted run's late per-symbol writes cannot overlap a new run's
    // writes. This mirrors the crypto-data plugin's pattern exactly.
    const abortController = new AbortController();
    syncAbortController = abortController;
    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processSyncBatch(body, syncOnly, stream.write, owner, { signal: abortController.signal });
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
        // Only release the lock if we still own it. If a newer sync has since
        // taken the lock (Stop aborted us and the user restarted), our stale
        // owner value no longer matches `syncOwner` — leave it alone so we
        // don't clobber the newer sync's lock. This is the single place the
        // lock is released: not in /stop, not on abort.
        if (syncOwner === owner) {
            syncOwner = SYNC_OWNER_NONE;
        }
        // Clear the controller if it's still ours.
        if (syncAbortController === abortController) {
            syncAbortController = null;
        }
        // Clear the in-progress snapshot only if we still own it. A newer
        // sync that started after a Stop will have repopulated
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
            // Raw auth/tickle payloads leak session internals; only include
            // them in diagnostic mode. The default status check only needs the
            // derived booleans + market-data readiness.
            const diagnostic = String(req.url ?? "").includes("diagnostic=1");
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
                    ...(diagnostic ? { payload, ticklePayload } : {}),
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
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: IBKR routes are local-only." });
                return;
            }
            try {
                const body = await readJsonBody(req, IBKR_BODY_LIMIT_BYTES);
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
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: IBKR routes are local-only." });
                return;
            }
            try {
                await handleSyncRequest(res as ViteHttpResponse, await readJsonBody(req, IBKR_BODY_LIMIT_BYTES), false);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        // NOTE: Vite's Connect `use(path)` prefix-matches, so the more-specific
        // `/api/ibkr/sync/status` MUST be registered before `/api/ibkr/sync` —
        // otherwise the /sync handler claims GET /sync/status and returns 405,
        // breaking browser reattach. (Same hazard documented in the crypto-data
        // plugin; this was a latent bug in the prior IBKR route order.)
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

        middlewares.use("/api/ibkr/sync", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: IBKR routes are local-only." });
                return;
            }
            try {
                await handleSyncRequest(res as ViteHttpResponse, await readJsonBody(req, IBKR_BODY_LIMIT_BYTES), true);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/ibkr/stop", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            if (!isAllowedLocalRequest(req)) {
                sendJson(res, 401, { ok: false, error: "Unauthorized: IBKR routes are local-only." });
                return;
            }
            // Abort the in-flight run. This cancels gateway fetches within one
            // event-loop tick (the AbortSignal threads all the way down to the
            // per-chunk fetch and the abortable retry waits). We intentionally
            // do NOT release ownership here: the run's own `finally` is the
            // only place the lock is released, so an aborted run's late
            // per-symbol writes cannot overlap a new run's writes. A new sync
            // is rejected (409) until the aborted run unwinds.
            const stopped = syncOwner !== SYNC_OWNER_NONE;
            syncAbortController?.abort();
            sendJson(res, 200, { ok: true, stopped });
        });
    };

    return {
        name: "ibkr-data",
        configureServer(server) {
            register(server.middlewares);
            // Clear the keepalive interval and abort any in-flight sync when
            // the dev server closes — mirrors the close-cleanup idiom in
            // `local-sqlite-vite-plugin.ts`. Defense-in-depth: the run's own
            // `finally` is the primary lock owner.
            server.httpServer?.once("close", stopIbkrServerState);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
            server.httpServer?.once("close", stopIbkrServerState);
        },
    };
}

// ---------------------------------------------------------------------------
// Test seams. Mirrors the crypto-data plugin's `__resetCryptoSyncStateForTests`
// / `__acquireCryptoSyncOwnerForTests` exports, used by the lifecycle spec to
// drive `processSyncBatch` with an injected fetcher without real I/O.
// ---------------------------------------------------------------------------

/** Reset all module-level sync state. Exported for test isolation. */
export function __resetIbkrSyncStateForTests(): void {
    syncAbortController?.abort();
    syncOwner = SYNC_OWNER_NONE;
    syncOwnerGen = 0;
    syncRunState = null;
    syncAbortController = null;
}

/**
 * Acquire the sync lock for `processSyncBatch` in tests. Mirrors what
 * `handleSyncRequest` does (bumps the generation and sets the owner) so the
 * batch's `lostOwnership()` check doesn't immediately bail. Pair with
 * `__resetIbkrSyncStateForTests` in `beforeEach`/`afterEach`.
 */
export function __acquireIbkrSyncOwnerForTests(): number {
    const owner = ++syncOwnerGen;
    syncOwner = owner;
    return owner;
}
