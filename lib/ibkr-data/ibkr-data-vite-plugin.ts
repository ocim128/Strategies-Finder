import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Agent } from "undici";
import type { Plugin } from "vite";
import { markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/strategies";
import { HttpStatusError, readJsonBody, sendCaughtErrorJson, sendJson } from "../vite-http-utils";

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
const LOCALHOST_TLS_DISPATCHER = new Agent({ connect: { rejectUnauthorized: false } });
const IBKR_HISTORY_SOFT_LIMIT = 900;
const IBKR_HISTORY_MAX_CHUNKS = 20;
const IBKR_HISTORY_MAX_SYNC_CHUNKS = 80;
const IBKR_HISTORY_CHUNK_DELAY_MS = 250;
const IBKR_KEEPALIVE_INTERVAL_MS = 60_000;
let stopRequested = false;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let lastKeepAliveAt: string | null = null;
let lastKeepAliveError: string | null = null;

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

function normalizeSymbol(value: unknown): string {
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
    let response: { status: number; text: string };
    try {
        response = await requestGatewayText(url, init);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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

    return fetch(url, {
        method: init?.method ?? "GET",
        headers,
        body,
        ...(parsed.protocol === "https:" && isLocalhost ? { dispatcher: LOCALHOST_TLS_DISPATCHER } : {}),
    } as RequestInit & { dispatcher?: Agent }).then(async (response) => {
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

    await initializeBrokerageSession();
    const status = await fetchGatewayJson("/iserver/auth/status");
    if (isAuthenticatedBrokerageSession(status)) startKeepAlive();
    return status;
}

async function fetchGatewayJsonAuthenticated(path: string, init?: RequestInit): Promise<unknown> {
    await ensureBrokerageSession();
    try {
        return await fetchGatewayJson(path, init);
    } catch (error) {
        if (!(error instanceof HttpStatusError) || (error.status !== 401 && error.status !== 403)) {
            throw error;
        }
        await initializeBrokerageSession();
        await wait(750);
        return fetchGatewayJson(path, init);
    }
}

function readCatalog(): IbkrCatalog {
    if (!existsSync(IBKR_CATALOG_PATH)) {
        return { updatedAt: new Date(0).toISOString(), entries: [] };
    }
    try {
        const parsed = JSON.parse(readFileSync(IBKR_CATALOG_PATH, "utf8")) as Partial<IbkrCatalog>;
        return {
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
            entries: Array.isArray(parsed.entries) ? parsed.entries as IbkrCatalogEntry[] : [],
        };
    } catch {
        return { updatedAt: new Date(0).toISOString(), entries: [] };
    }
}

function writeCatalog(catalog: IbkrCatalog): void {
    mkdirSync(dirname(IBKR_CATALOG_PATH), { recursive: true });
    writeFileSync(IBKR_CATALOG_PATH, JSON.stringify(catalog, null, 2));
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

function upsertCatalogEntry(args: {
    symbol: string;
    interval: string;
    candles: OHLCVData[];
    resolved?: IbkrResolvedContract;
}): IbkrCatalogEntry {
    const catalog = readCatalog();
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
    writeCatalog(catalog);
    return entry;
}

function readCsvCandles(symbol: string, interval: string): OHLCVData[] {
    const filePath = getCsvPath(symbol, interval);
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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

function mergeCandlesByTime(candles: OHLCVData[]): OHLCVData[] {
    const byTime = new Map<number, OHLCVData>();
    for (const candle of candles) {
        const time = parseTimeToUnixSeconds(candle.time);
        if (time === null) continue;
        byTime.set(time, { ...candle, time: time as OHLCVData["time"] });
    }
    return Array.from(byTime.values()).sort((a, b) => Number(a.time) - Number(b.time));
}

function getCsvPath(symbol: string, interval: string): string {
    return resolve(IBKR_CSV_DIR, interval, `${symbol}.csv`);
}

function writeCsv(symbol: string, interval: string, candles: OHLCVData[]): void {
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

function parseResolvedContracts(symbol: string, payload: unknown): IbkrResolvedContract[] {
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

function parseHistoryCandles(payload: unknown): OHLCVData[] {
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

function parsePeriodToMs(period: string): number | null {
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

async function fetchHistorical(resolved: IbkrResolvedContract, interval: string, period: string): Promise<OHLCVData[]> {
    const maxSync = isMaxHistoryPeriod(period);
    const requestPeriod = maxSync
        ? MAX_SYNC_CHUNK_PERIOD_BY_INTERVAL[interval] ?? DEFAULT_PERIOD_BY_INTERVAL[interval] ?? "1y"
        : period;
    const periodMs = maxSync ? null : parsePeriodToMs(requestPeriod);
    const maxChunks = maxSync ? IBKR_HISTORY_MAX_SYNC_CHUNKS : IBKR_HISTORY_MAX_CHUNKS;
    const chunks: OHLCVData[][] = [];
    let nextStartTime: number | undefined;
    let previousFirstTime: number | null = null;

    for (let i = 0; i < maxChunks; i += 1) {
        if (stopRequested) break;
        const chunk = await fetchHistoricalChunk(resolved, interval, requestPeriod, nextStartTime);
        if (chunk.length === 0) break;
        chunks.push(chunk);

        const merged = mergeCandlesByTime(chunks.flat());
        if (periodMs !== null) {
            const newest = Number(merged[merged.length - 1]?.time);
            const oldest = Number(merged[0]?.time);
            if (Number.isFinite(newest) && Number.isFinite(oldest) && oldest * 1000 <= newest * 1000 - periodMs) {
                return trimCandlesToPeriod(merged, period);
            }
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

    const merged = mergeCandlesByTime(chunks.flat());
    return maxSync ? merged : trimCandlesToPeriod(merged, requestPeriod);
}

async function syncOneSymbol(symbol: string, interval: string, period: string, syncOnly: boolean): Promise<Record<string, unknown>> {
    const resolved = await resolveSymbol(symbol);
    const fetched = await fetchHistorical(resolved, interval, period);
    if (fetched.length === 0) {
        throw new HttpStatusError(502, `IBKR returned no ${interval} bars for ${symbol}.`);
    }

    const existing = syncOnly ? readCsvCandles(symbol, interval) : [];
    const merged = mergeCandlesByTime([...existing, ...fetched]);
    writeCsv(symbol, interval, merged);
    const catalogEntry = upsertCatalogEntry({ symbol, interval, candles: merged, resolved });
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

async function handleSyncRequest(body: Record<string, unknown>, syncOnly: boolean): Promise<Record<string, unknown>> {
    stopRequested = false;
    const symbols = normalizeSymbols(body.symbols ?? body.symbol);
    const interval = normalizeInterval(body.interval);
    const period = String(body.period ?? DEFAULT_PERIOD_BY_INTERVAL[interval] ?? "1y").trim();
    const results: unknown[] = [];
    const failed: unknown[] = [];
    let cancelled = false;
    for (const symbol of symbols) {
        if (stopRequested) {
            cancelled = true;
            break;
        }
        try {
            results.push(await syncOneSymbol(symbol, interval, period, syncOnly));
        } catch (error) {
            failed.push({
                symbol,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { ok: failed.length === 0 && !cancelled, cancelled, interval, results, failed };
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
                sendJson(res, isAuthenticatedBrokerageSession(payload) ? 200 : 401, {
                    ok: isAuthenticatedBrokerageSession(payload),
                    gatewayUrl: getGatewayUrl(),
                    keepAlive: {
                        active: keepAliveTimer !== null,
                        intervalMs: IBKR_KEEPALIVE_INTERVAL_MS,
                        lastTickleAt: lastKeepAliveAt,
                        lastError: lastKeepAliveError,
                    },
                    payload,
                    ...(!isAuthenticatedBrokerageSession(payload)
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
                const results = [];
                const failed = [];
                for (const symbol of symbols) {
                    try {
                        results.push(await resolveSymbol(symbol));
                    } catch (error) {
                        failed.push({ symbol, error: error instanceof Error ? error.message : String(error) });
                    }
                }
                sendJson(res, 200, { ok: failed.length === 0, results, failed });
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
                sendJson(res, 200, await handleSyncRequest(await readJsonBody(req), false));
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
                sendJson(res, 200, await handleSyncRequest(await readJsonBody(req), true));
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
            sendJson(res, 200, { ok: true, stopped: true });
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
