import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Plugin } from "vite";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import type {
    PolymarketClob1sQuoteRow,
    SecondMarketPolymarketEvent,
    SecondMarketSymbol,
} from "../second-market/types";
import type { ExecutionLabRecord, LiveTradeSubmitRequest, LiveTradeSubmitResponse } from "./execution-lab-model";
import {
    loadLiveExecutorStatus,
    submitLiveTradeToExecutor,
} from "./live-executor-adapter";
import { sanitizeExecutionLabPathPart, validateExecutionLabRecord } from "./paper-log-schema";
import {
    buildLiveTradeFailureResponse,
    LIVE_TRADE_MAX_EXPIRY_WINDOW_SEC,
    validateLiveTradeSubmitRequest,
} from "./live-trade-request";

const LOG_ROOT = resolve(process.cwd(), "logs", "paper-execution");
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LOG_BATCH_RECORDS = 100;
const LIVE_TRADE_LEDGER_TTL_MS = 60_000;
const MINER_DB_PATH = resolve(process.cwd(), "price-data", "1second-chart", "second-market-data.sqlite");
const MINER_LOG_PATH = resolve(process.cwd(), "price-data", "1second-chart", "logs", "execution-lab-1s-miner-latest.log");
const ESNO_BIN = resolve(
    process.cwd(),
    "..",
    "..",
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "esno.cmd" : "esno"
);
const ESNO_SCRIPT = resolve(process.cwd(), "..", "..", "..", "node_modules", "esno", "esno.js");
const BINANCE_BASES = {
    spot: "https://api.binance.com",
    futures: "https://fapi.binance.com",
} as const;
const BINANCE_KLINE_PATHS = {
    spot: "/api/v3/klines",
    futures: "/fapi/v1/klines",
} as const;
const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const CLOB_PRICE_URL = "https://clob.polymarket.com/price";
const SUPPORTED_SYMBOLS = new Set(["BTCUSDT", "XRPUSDT"]);

type LiveCandleRow = {
    symbol: SecondMarketSymbol;
    market_type: "spot" | "futures";
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trade_count: number | null;
    updated_at: number;
};

type LiveOutcomeRow = PolymarketOutcomeRow;
type CacheEntry<T> = {
    expiresAtMs: number;
    value: T;
};
type LiveTradeLedgerEntry = {
    payloadHash: string;
    expiresAtMs: number;
    pending?: Promise<LiveTradeSubmitResponse>;
    response?: LiveTradeSubmitResponse;
};

function sendJson(res: any, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
}

function payloadHash(value: unknown): string {
    return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of req) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        total += bytes.length;
        if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
        chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

export function normalizeExecutionLabClobPrice(value: unknown): number | null {
    if (typeof value === "string" && value.trim() === "") return null;
    const price = finiteNumber(value);
    return price !== null && price >= 0 && price <= 1 ? price : null;
}

function toUnixSeconds(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.floor(value > 1_000_000_000_000 ? value / 1000 : value);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) return Math.floor(numeric > 1_000_000_000_000 ? numeric / 1000 : numeric);
        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
    return null;
}

function parseSymbol(raw: string | null): SecondMarketSymbol | null {
    const symbol = String(raw || "").trim().toUpperCase();
    return SUPPORTED_SYMBOLS.has(symbol) ? symbol as SecondMarketSymbol : null;
}

function parseLimit(raw: string | null): number {
    const parsed = Number(raw || "50000");
    if (!Number.isFinite(parsed)) return 50000;
    return Math.max(1, Math.min(20000, Math.floor(parsed)));
}

function parseOutcomeInterval(raw: string | null): PolymarketOutcomeInterval {
    return raw === "15m" || raw === "1h" ? raw : "5m";
}

function outcomeIntervalDurationSec(interval: PolymarketOutcomeInterval): number {
    if (interval === "15m") return 900;
    if (interval === "1h") return 3600;
    return 300;
}

function stringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed)
            ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean)
            : [];
    } catch {
        return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    }
}

function chooseYesIndex(outcomes: readonly string[]): number {
    const normalized = outcomes.map((outcome) => outcome.trim().toLowerCase());
    const upIndex = normalized.findIndex((outcome) =>
        outcome === "up" || outcome === "yes" || outcome.includes("up")
    );
    return upIndex >= 0 ? upIndex : 0;
}

function normalizeLiveEvent(args: {
    symbol: SecondMarketSymbol;
    seriesId: string;
    outcomeInterval: PolymarketOutcomeInterval;
    event: Record<string, unknown>;
    market: Record<string, unknown>;
}): SecondMarketPolymarketEvent | null {
    const endTs = toUnixSeconds(args.event.endDate ?? args.event.end_date ?? args.market.endDate ?? args.market.end_date);
    if (endTs === null) return null;
    const marketSlug = String(args.market.slug ?? args.event.slug ?? "").trim();
    const eventSlug = String(args.event.slug ?? marketSlug).trim();
    const marketId = String(args.market.id ?? args.market.marketId ?? marketSlug).trim();
    const conditionId = String(args.market.conditionId ?? args.market.condition_id ?? "").trim();
    const outcomes = stringArray(args.market.outcomes);
    const tokenIds = stringArray(args.market.clobTokenIds ?? args.market.clob_token_ids);
    if (!marketSlug || !eventSlug || !marketId || tokenIds.length === 0) return null;

    const yesIndex = chooseYesIndex(outcomes);
    const yesTokenId = tokenIds[yesIndex] ?? tokenIds[0] ?? "";
    const noIndex = yesIndex === 0 && tokenIds.length > 1 ? 1 : yesIndex > 0 ? 0 : -1;
    const noTokenId = noIndex >= 0 ? tokenIds[noIndex] ?? "" : "";
    if (!yesTokenId) return null;

    return {
        seriesId: args.seriesId,
        symbol: args.symbol,
        outcomeInterval: args.outcomeInterval,
        eventSlug,
        marketId,
        conditionId,
        marketSlug,
        eventStartTs: endTs - outcomeIntervalDurationSec(args.outcomeInterval),
        eventEndTs: endTs,
        yesTokenId,
        noTokenId,
    };
}

function normalizeLiveOutcome(args: {
    symbol: SecondMarketSymbol;
    seriesId: string;
    outcomeInterval: PolymarketOutcomeInterval;
    event: Record<string, unknown>;
    market: Record<string, unknown>;
}): LiveOutcomeRow | null {
    const event = normalizeLiveEvent(args);
    if (!event) return null;
    const outcomes = stringArray(args.market.outcomes);
    const prices = stringArray(args.market.outcomePrices ?? args.market.outcome_prices);
    const yesPrice = Number(prices[chooseYesIndex(outcomes)] ?? prices[0]);
    if (!Number.isFinite(yesPrice)) return null;
    return {
        series_id: event.seriesId,
        event_slug: event.eventSlug,
        market_slug: event.marketSlug,
        interval: event.outcomeInterval,
        event_start_ts: event.eventStartTs,
        event_end_ts: event.eventEndTs,
        yes_token_id: event.yesTokenId,
        no_token_id: event.noTokenId,
        yes_open_price: null,
        yes_entry_minute_1_price: null,
        yes_entry_minute_2_price: null,
        yes_entry_minute_3_price: null,
        yes_entry_minute_4_price: null,
        resolved_outcome_up: yesPrice >= 0.5 ? 1 : 0,
        resolution_source: "gamma_live_outcomePrices",
        updated_at: Math.floor(Date.now() / 1000),
    };
}

function normalizeBinanceKline(symbol: SecondMarketSymbol, marketType: "spot" | "futures", row: unknown[]): LiveCandleRow | null {
    if (!Array.isArray(row) || row.length < 6) return null;
    const openMs = finiteNumber(row[0]);
    const open = finiteNumber(row[1]);
    const high = finiteNumber(row[2]);
    const low = finiteNumber(row[3]);
    const close = finiteNumber(row[4]);
    const volume = finiteNumber(row[5]);
    if (
        openMs === null || open === null || high === null || low === null || close === null || volume === null ||
        open <= 0 || high <= 0 || low <= 0 || close <= 0 || low > high
    ) {
        return null;
    }
    const tradeCount = finiteNumber(row[8]);
    return {
        symbol,
        market_type: marketType,
        ts: Math.floor(openMs / 1000),
        open,
        high,
        low,
        close,
        volume,
        trade_count: tradeCount === null ? null : Math.floor(tradeCount),
        updated_at: Math.floor(Date.now() / 1000),
    };
}

async function fetchLiveCandles(args: {
    symbol: SecondMarketSymbol;
    marketType: "spot" | "futures";
    startTs: number;
    endTs: number;
    limit: number;
}): Promise<LiveCandleRow[]> {
    const closedEndTs = Math.min(args.endTs, Math.floor(Date.now() / 1000) - 2);
    if (closedEndTs < args.startTs) return [];
    const out: LiveCandleRow[] = [];
    let cursorMs = Math.floor(args.startTs) * 1000;
    const endMs = Math.floor(closedEndTs) * 1000;

    while (cursorMs <= endMs && out.length < args.limit) {
        const requestLimit = Math.min(1000, args.limit - out.length);
        const url = new URL(`${BINANCE_BASES[args.marketType]}${BINANCE_KLINE_PATHS[args.marketType]}`);
        url.searchParams.set("symbol", args.symbol);
        url.searchParams.set("interval", "1s");
        url.searchParams.set("startTime", String(cursorMs));
        url.searchParams.set("endTime", String(endMs));
        url.searchParams.set("limit", String(requestLimit));

        const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Binance live 1s fetch failed: HTTP ${response.status}`);
        const rows = await response.json() as unknown;
        const rawRows = Array.isArray(rows) ? rows : [];
        if (rawRows.length === 0) break;

        for (const raw of rawRows) {
            const row = normalizeBinanceKline(args.symbol, args.marketType, raw as unknown[]);
            if (row && row.ts >= args.startTs && row.ts <= closedEndTs) out.push(row);
        }

        const lastOpenMs = finiteNumber((rawRows[rawRows.length - 1] as unknown[] | undefined)?.[0]);
        if (lastOpenMs === null) break;
        const nextCursorMs = lastOpenMs + 1000;
        if (nextCursorMs <= cursorMs || rawRows.length < requestLimit) break;
        cursorMs = nextCursorMs;
    }

    return out.sort((left, right) => left.ts - right.ts).slice(-args.limit);
}

async function fetchLiveEvents(args: {
    symbol: SecondMarketSymbol;
    outcomeInterval: PolymarketOutcomeInterval;
    seriesId: string;
}): Promise<SecondMarketPolymarketEvent[]> {
    const nowSec = Math.floor(Date.now() / 1000);
    const url = new URL(GAMMA_EVENTS_URL);
    url.searchParams.set("series_id", args.seriesId);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");
    url.searchParams.set("end_date_min", new Date((nowSec - outcomeIntervalDurationSec(args.outcomeInterval)) * 1000).toISOString());
    url.searchParams.set("limit", "100");

    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Gamma live events fetch failed: HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    const events = Array.isArray(payload) ? payload : [];
    return events.flatMap((event): SecondMarketPolymarketEvent[] => {
        if (!event || typeof event !== "object") return [];
        const eventRecord = event as Record<string, unknown>;
        const markets = Array.isArray(eventRecord.markets) ? eventRecord.markets : [];
        return markets
            .map((market) => market && typeof market === "object"
                ? normalizeLiveEvent({
                    symbol: args.symbol,
                    seriesId: args.seriesId,
                    outcomeInterval: args.outcomeInterval,
                    event: eventRecord,
                    market: market as Record<string, unknown>,
                })
                : null)
            .filter((item): item is SecondMarketPolymarketEvent => item !== null);
    });
}

async function fetchLiveOutcomes(args: {
    symbol: SecondMarketSymbol;
    outcomeInterval: PolymarketOutcomeInterval;
    seriesId: string;
    startTs: number;
    endTs: number;
}): Promise<LiveOutcomeRow[]> {
    const url = new URL(GAMMA_EVENTS_URL);
    url.searchParams.set("series_id", args.seriesId);
    url.searchParams.set("closed", "true");
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");
    url.searchParams.set("end_date_min", new Date(Math.max(0, Math.floor(args.startTs)) * 1000).toISOString());
    url.searchParams.set("end_date_max", new Date(Math.floor(args.endTs) * 1000).toISOString());
    url.searchParams.set("limit", "100");

    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Gamma live outcomes fetch failed: HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    const events = Array.isArray(payload) ? payload : [];
    return events.flatMap((event): LiveOutcomeRow[] => {
        if (!event || typeof event !== "object") return [];
        const eventRecord = event as Record<string, unknown>;
        const markets = Array.isArray(eventRecord.markets) ? eventRecord.markets : [];
        return markets
            .map((market) => market && typeof market === "object"
                ? normalizeLiveOutcome({
                    symbol: args.symbol,
                    seriesId: args.seriesId,
                    outcomeInterval: args.outcomeInterval,
                    event: eventRecord,
                    market: market as Record<string, unknown>,
                })
                : null)
            .filter((item): item is LiveOutcomeRow =>
                item !== null && item.event_end_ts >= args.startTs && item.event_end_ts <= args.endTs
            );
    });
}

async function fetchClobPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number | null> {
    if (!tokenId) return null;
    const url = new URL(CLOB_PRICE_URL);
    url.searchParams.set("token_id", tokenId);
    url.searchParams.set("side", side);
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { price?: unknown } | null;
    return normalizeExecutionLabClobPrice(payload?.price);
}

async function buildLiveQuote(event: SecondMarketPolymarketEvent, sampleTs: number): Promise<PolymarketClob1sQuoteRow> {
    const receivedTsMs = Date.now();
    const [yesBid, yesAsk, noBid, noAsk] = await Promise.all([
        fetchClobPrice(event.yesTokenId, "BUY"),
        fetchClobPrice(event.yesTokenId, "SELL"),
        fetchClobPrice(event.noTokenId, "BUY"),
        fetchClobPrice(event.noTokenId, "SELL"),
    ]);
    const flags: string[] = [];
    if (yesBid === null || yesAsk === null) flags.push("missing_yes_bid_ask");
    if (noBid === null || noAsk === null) flags.push("missing_no_bid_ask");
    return {
        series_id: event.seriesId,
        symbol: event.symbol,
        outcome_interval: event.outcomeInterval,
        event_start_ts: event.eventStartTs,
        event_end_ts: event.eventEndTs,
        condition_id: event.conditionId,
        market_slug: event.marketSlug,
        yes_token_id: event.yesTokenId,
        no_token_id: event.noTokenId,
        sample_ts: Math.floor(sampleTs),
        yes_bid: yesBid,
        yes_ask: yesAsk,
        yes_mid: yesBid !== null && yesAsk !== null ? (yesBid + yesAsk) / 2 : null,
        yes_last: null,
        no_bid: noBid,
        no_ask: noAsk,
        no_mid: noBid !== null && noAsk !== null ? (noBid + noAsk) / 2 : null,
        no_last: null,
        source: "polymarket_clob_live",
        source_ts_ms: receivedTsMs,
        quote_age_ms: Math.max(0, Date.now() - receivedTsMs),
        quality_flags: flags.join(","),
        updated_at: Math.floor(Date.now() / 1000),
    };
}

export function executionLabVitePlugin(): Plugin {
    const sessions = new Map<string, string>();
    const liveEventCache = new Map<string, CacheEntry<SecondMarketPolymarketEvent[]>>();
    const liveOutcomeCache = new Map<string, CacheEntry<LiveOutcomeRow[]>>();
    const inFlightFetches = new Map<string, Promise<unknown>>();
    const liveTradeLedger = new Map<string, LiveTradeLedgerEntry>();
    let minerProcess: ChildProcessWithoutNullStreams | null = null;
    let minerStartedAtIso: string | null = null;
    let minerExitCode: number | null = null;
    let minerMessage = "Idle";

    function pruneExpiredCache<T>(cache: Map<string, CacheEntry<T>>, now: number): void {
        for (const [cacheKey, entry] of cache.entries()) {
            if (entry.expiresAtMs <= now) {
                cache.delete(cacheKey);
            }
        }
    }

    function pruneLiveTradeLedger(now: number): void {
        for (const [requestId, entry] of liveTradeLedger.entries()) {
            if (entry.expiresAtMs <= now && !entry.pending) {
                liveTradeLedger.delete(requestId);
            }
        }
    }

    async function submitLiveTradeOnce(request: LiveTradeSubmitRequest): Promise<LiveTradeSubmitResponse> {
        const now = Date.now();
        pruneLiveTradeLedger(now);
        const hash = payloadHash(request);
        const existing = liveTradeLedger.get(request.requestId);
        if (existing) {
            if (existing.payloadHash !== hash) {
                return buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    status: "rejected",
                    reason: "request_id_payload_mismatch",
                    maxPrice: request.maxPrice,
                    minPrice: request.action === "exit" ? request.minPrice : undefined,
                });
            }
            if (existing.response) return existing.response;
            if (existing.pending) return await existing.pending;
        }

        const pending = submitLiveTradeToExecutor(request);
        const entry: LiveTradeLedgerEntry = {
            payloadHash: hash,
            expiresAtMs: now + LIVE_TRADE_LEDGER_TTL_MS,
            pending,
        };
        liveTradeLedger.set(request.requestId, entry);
        try {
            const response = await pending;
            entry.response = response;
            entry.expiresAtMs = Date.now() + LIVE_TRADE_LEDGER_TTL_MS;
            return response;
        } finally {
            entry.pending = undefined;
        }
    }

    async function loadCached<T>(
        cache: Map<string, CacheEntry<T>>,
        key: string,
        ttlMs: number,
        load: () => Promise<T>
    ): Promise<T> {
        const now = Date.now();
        pruneExpiredCache(cache, now);
        const cached = cache.get(key);
        if (cached && cached.expiresAtMs > now) return cached.value;

        const existing = inFlightFetches.get(key) as Promise<T> | undefined;
        if (existing) return existing;

        const pending = load()
            .then((value) => {
                cache.set(key, { expiresAtMs: Date.now() + ttlMs, value });
                return value;
            })
            .finally(() => {
                inFlightFetches.delete(key);
            });
        inFlightFetches.set(key, pending);
        return pending;
    }

    function appendValidatedRecords(records: readonly ExecutionLabRecord[]): { ok: true } | { ok: false; status: number; error: string } {
        if (records.length === 0) {
            return { ok: false, status: 400, error: "records must not be empty" };
        }
        if (records.length > MAX_LOG_BATCH_RECORDS) {
            return { ok: false, status: 400, error: `records must contain at most ${MAX_LOG_BATCH_RECORDS} items` };
        }

        const sessionId = records[0].sessionId;
        if (records.some((record) => record.sessionId !== sessionId)) {
            return { ok: false, status: 400, error: "records must belong to one session" };
        }

        const logPath = sessions.get(sessionId);
        if (!logPath) {
            return { ok: false, status: 404, error: "Unknown execution lab session" };
        }

        appendFileSync(logPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
        if (records.some((record) => record.recordType === "session_stop")) {
            sessions.delete(sessionId);
        }
        return { ok: true };
    }

    function minerStatusPayload() {
        const running = minerProcess !== null && minerProcess.exitCode === null && minerProcess.signalCode === null;
        return {
            ok: true as const,
            running,
            pid: running ? minerProcess?.pid ?? null : null,
            startedAtIso: running ? minerStartedAtIso : null,
            logPath: MINER_LOG_PATH,
            dbPath: MINER_DB_PATH,
            exitCode: minerExitCode,
            message: minerMessage,
        };
    }

    function startMiner(): ReturnType<typeof minerStatusPayload> {
        if (minerProcess && minerProcess.exitCode === null && minerProcess.signalCode === null) {
            minerMessage = "Already running";
            return minerStatusPayload();
        }
        if (!existsSync(ESNO_BIN) || !existsSync(ESNO_SCRIPT)) {
            throw new Error(`Missing esno launcher: ${ESNO_BIN}`);
        }

        mkdirSync(dirname(MINER_LOG_PATH), { recursive: true });
        const startedAtIso = new Date().toISOString();
        writeFileSync(
            MINER_LOG_PATH,
            [
                `[execution-lab-miner] Started ${startedAtIso}`,
                `Repo: ${process.cwd()}`,
                `ESNO: ${ESNO_BIN}`,
                `ESNO_SCRIPT: ${ESNO_SCRIPT}`,
                `NODE: ${process.execPath}`,
                `DB: ${MINER_DB_PATH}`,
                "Args: --mode live --symbols BTCUSDT,XRPUSDT",
                "",
            ].join("\n"),
            "utf8"
        );

        const logStream = createWriteStream(MINER_LOG_PATH, { flags: "a" });
        minerProcess = spawn(process.execPath, [
            ESNO_SCRIPT,
            "scripts/second-market-miner.ts",
            "--mode",
            "live",
            "--symbols",
            "BTCUSDT,XRPUSDT",
            "--db",
            MINER_DB_PATH,
        ], {
            cwd: process.cwd(),
            windowsHide: true,
        });
        minerStartedAtIso = startedAtIso;
        minerExitCode = null;
        minerMessage = "Running";
        minerProcess.stdout.pipe(logStream, { end: false });
        minerProcess.stderr.pipe(logStream, { end: false });
        minerProcess.once("exit", (code, signal) => {
            minerExitCode = code;
            minerMessage = signal ? `Exited by ${signal}` : `Exited with code ${code ?? "unknown"}`;
            appendFileSync(MINER_LOG_PATH, `\n[execution-lab-miner] ${minerMessage}\n`, "utf8");
            logStream.end();
            minerProcess = null;
        });
        minerProcess.once("error", (error) => {
            minerExitCode = 1;
            minerMessage = error.message;
            appendFileSync(MINER_LOG_PATH, `\n[execution-lab-miner] ERROR ${error.message}\n`, "utf8");
            logStream.end();
            minerProcess = null;
        });
        return minerStatusPayload();
    }

    function stopMiner(): ReturnType<typeof minerStatusPayload> {
        if (!minerProcess || minerProcess.exitCode !== null || minerProcess.signalCode !== null) {
            minerMessage = minerMessage === "Running" ? "Idle" : minerMessage;
            minerProcess = null;
            return minerStatusPayload();
        }
        minerMessage = "Stopping";
        minerProcess.kill();
        return minerStatusPayload();
    }

    const register = (middlewares: any, allowLiveSubmission: boolean) => {
        middlewares.use("/api/execution-lab", async (req: any, res: any) => {
            const method = req.method || "GET";
            const requestUrl = new URL(req.url || "/", "http://localhost");
            const path = requestUrl.pathname;

            try {
                if (method === "GET" && path === "/live-candles") {
                    const symbol = parseSymbol(requestUrl.searchParams.get("symbol"));
                    if (!symbol) {
                        sendJson(res, 400, { ok: false, error: "symbol must be BTCUSDT or XRPUSDT." });
                        return;
                    }
                    const marketType = requestUrl.searchParams.get("marketType") === "futures" ? "futures" : "spot";
                    const limit = parseLimit(requestUrl.searchParams.get("limit"));
                    const explicitEndTs = toUnixSeconds(requestUrl.searchParams.get("endTs"));
                    const explicitStartTs = toUnixSeconds(requestUrl.searchParams.get("startTs"));
                    const endTs = Math.min(explicitEndTs ?? Math.floor(Date.now() / 1000) - 2, Math.floor(Date.now() / 1000) - 2);
                    const lookbackLimit = Math.min(20000, Math.max(limit + 60, 120));
                    const startTs = explicitStartTs ?? Math.max(0, endTs - lookbackLimit + 1);
                    const fetched = await fetchLiveCandles({
                        symbol,
                        marketType,
                        startTs,
                        endTs,
                        limit: explicitStartTs === null ? lookbackLimit : limit,
                    });
                    sendJson(res, 200, { ok: true, source: "binance_live", symbol, marketType, candles: fetched.slice(-limit) });
                    return;
                }

                if (method === "GET" && path === "/live-events") {
                    const symbol = parseSymbol(requestUrl.searchParams.get("symbol"));
                    if (!symbol) {
                        sendJson(res, 400, { ok: false, error: "symbol must be BTCUSDT or XRPUSDT." });
                        return;
                    }
                    const outcomeInterval = parseOutcomeInterval(requestUrl.searchParams.get("outcomeInterval"));
                    const seriesId = String(requestUrl.searchParams.get("seriesId") || "").trim();
                    if (!seriesId) {
                        sendJson(res, 400, { ok: false, error: "seriesId is required." });
                        return;
                    }
                    const events = await loadCached(
                        liveEventCache,
                        `events|${symbol}|${outcomeInterval}|${seriesId}`,
                        2000,
                        () => fetchLiveEvents({ symbol, outcomeInterval, seriesId })
                    );
                    sendJson(res, 200, { ok: true, source: "gamma_live", symbol, outcomeInterval, seriesId, events });
                    return;
                }

                if (method === "GET" && path === "/live-outcomes") {
                    const symbol = parseSymbol(requestUrl.searchParams.get("symbol"));
                    if (!symbol) {
                        sendJson(res, 400, { ok: false, error: "symbol must be BTCUSDT or XRPUSDT." });
                        return;
                    }
                    const outcomeInterval = parseOutcomeInterval(requestUrl.searchParams.get("outcomeInterval"));
                    const seriesId = String(requestUrl.searchParams.get("seriesId") || "").trim();
                    const startTs = toUnixSeconds(requestUrl.searchParams.get("startTs"));
                    const endTs = toUnixSeconds(requestUrl.searchParams.get("endTs"));
                    if (!seriesId || startTs === null || endTs === null || endTs < startTs) {
                        sendJson(res, 400, { ok: false, error: "seriesId, startTs, and endTs are required." });
                        return;
                    }
                    const outcomes = await loadCached(
                        liveOutcomeCache,
                        `outcomes|${symbol}|${outcomeInterval}|${seriesId}|${startTs}|${endTs}`,
                        10000,
                        () => fetchLiveOutcomes({ symbol, outcomeInterval, seriesId, startTs, endTs })
                    );
                    sendJson(res, 200, { ok: true, source: "gamma_live_outcomes", symbol, outcomeInterval, seriesId, outcomes });
                    return;
                }

                if (method === "GET" && path === "/live-quote") {
                    const symbol = parseSymbol(requestUrl.searchParams.get("symbol"));
                    if (!symbol) {
                        sendJson(res, 400, { ok: false, error: "symbol must be BTCUSDT or XRPUSDT." });
                        return;
                    }
                    const outcomeInterval = parseOutcomeInterval(requestUrl.searchParams.get("outcomeInterval"));
                    const seriesId = String(requestUrl.searchParams.get("seriesId") || "").trim();
                    const eventStartTs = toUnixSeconds(requestUrl.searchParams.get("eventStartTs"));
                    const eventEndTs = toUnixSeconds(requestUrl.searchParams.get("eventEndTs"));
                    const sampleTs = toUnixSeconds(requestUrl.searchParams.get("sampleTs")) ?? Math.floor(Date.now() / 1000);
                    const marketSlug = String(requestUrl.searchParams.get("marketSlug") || "").trim();
                    const eventSlug = String(requestUrl.searchParams.get("eventSlug") || marketSlug).trim();
                    const marketId = String(requestUrl.searchParams.get("marketId") || marketSlug).trim();
                    const conditionId = String(requestUrl.searchParams.get("conditionId") || "").trim();
                    const yesTokenId = String(requestUrl.searchParams.get("yesTokenId") || "").trim();
                    const noTokenId = String(requestUrl.searchParams.get("noTokenId") || "").trim();
                    if (!seriesId || eventStartTs === null || eventEndTs === null || !marketSlug || !yesTokenId) {
                        sendJson(res, 400, { ok: false, error: "seriesId, event time, marketSlug, and yesTokenId are required." });
                        return;
                    }
                    if (sampleTs < Math.floor(Date.now() / 1000) - 30) {
                        sendJson(res, 409, { ok: false, error: "Historical CLOB quote requests must use stored second-market quotes." });
                        return;
                    }
                    const quote = await buildLiveQuote({
                        seriesId,
                        symbol,
                        outcomeInterval,
                        eventSlug,
                        marketId,
                        conditionId,
                        marketSlug,
                        eventStartTs,
                        eventEndTs,
                        yesTokenId,
                        noTokenId,
                    }, sampleTs);
                    sendJson(res, 200, { ok: true, source: "clob_live", quote });
                    return;
                }

                if (method === "GET" && path === "/miner/status") {
                    sendJson(res, 200, minerStatusPayload());
                    return;
                }

                if (method === "GET" && path === "/live/status") {
                    sendJson(res, 200, loadLiveExecutorStatus());
                    return;
                }

                if (method !== "POST") {
                    sendJson(res, 405, { ok: false, error: "Method not allowed" });
                    return;
                }

                if (path === "/miner/start") {
                    sendJson(res, 200, startMiner());
                    return;
                }

                if (path === "/miner/stop") {
                    sendJson(res, 200, stopMiner());
                    return;
                }

                if (path === "/live/trade") {
                    if (!allowLiveSubmission) {
                        sendJson(res, 404, { ok: false, error: "Live trade submission is not registered in preview mode." });
                        return;
                    }
                    const status = loadLiveExecutorStatus();
                    const payload = await readJsonBody(req as IncomingMessage);
                    const validation = validateLiveTradeSubmitRequest(payload, {
                        maxStakeUsd: status.maxStakeUsd,
                        sizingMode: status.sizingMode,
                        maxExpiryWindowSec: LIVE_TRADE_MAX_EXPIRY_WINDOW_SEC,
                    });
                    if (!validation.ok) {
                        sendJson(res, 400, { ok: false, error: validation.error });
                        return;
                    }
                    if (validation.request.orderType !== status.orderType) {
                        sendJson(res, 200, buildLiveTradeFailureResponse({
                            requestId: validation.request.requestId,
                            status: "rejected",
                            reason: "order_type_config_mismatch",
                            maxPrice: validation.request.maxPrice,
                            minPrice: validation.request.action === "exit" ? validation.request.minPrice : undefined,
                        }));
                        return;
                    }
                    sendJson(res, 200, await submitLiveTradeOnce(validation.request));
                    return;
                }

                if (path === "/session/start") {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const strategyKey = typeof payload.strategyKey === "string" ? payload.strategyKey : "";
                    const symbol = parseSymbol(typeof payload.symbol === "string" ? payload.symbol : "");
                    const startedAtIso = typeof payload.startedAtIso === "string" ? payload.startedAtIso : "";
                    if (!strategyKey.trim() || !symbol) {
                        sendJson(res, 400, { ok: false, error: "strategyKey and symbol are required" });
                        return;
                    }
                    const parsedStarted = Date.parse(startedAtIso);
                    const day = new Date(Number.isFinite(parsedStarted) ? parsedStarted : Date.now()).toISOString().slice(0, 10);
                    const sessionId = randomUUID();
                    const logPath = resolve(
                        LOG_ROOT,
                        sanitizeExecutionLabPathPart(strategyKey),
                        sanitizeExecutionLabPathPart(symbol),
                        day,
                        `${sessionId}.jsonl`,
                    );
                    mkdirSync(dirname(logPath), { recursive: true });
                    appendFileSync(logPath, "", "utf8");
                    sessions.set(sessionId, logPath);
                    sendJson(res, 200, { ok: true, sessionId, logPath });
                    return;
                }

                if (path === "/log") {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const validation = validateExecutionLabRecord(payload);
                    if (!validation.ok) {
                        sendJson(res, 400, { ok: false, error: validation.error });
                        return;
                    }
                    const appendResult = appendValidatedRecords([validation.record]);
                    if (!appendResult.ok) {
                        sendJson(res, appendResult.status, { ok: false, error: appendResult.error });
                        return;
                    }
                    sendJson(res, 200, { ok: true });
                    return;
                }

                if (path === "/logs") {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const rawRecords = Array.isArray(payload.records) ? payload.records : null;
                    if (!rawRecords) {
                        sendJson(res, 400, { ok: false, error: "records must be an array" });
                        return;
                    }
                    if (rawRecords.length > MAX_LOG_BATCH_RECORDS) {
                        sendJson(res, 400, { ok: false, error: `records must contain at most ${MAX_LOG_BATCH_RECORDS} items` });
                        return;
                    }
                    const records: ExecutionLabRecord[] = [];
                    for (const rawRecord of rawRecords) {
                        const validation = validateExecutionLabRecord(rawRecord);
                        if (!validation.ok) {
                            sendJson(res, 400, { ok: false, error: validation.error });
                            return;
                        }
                        records.push(validation.record);
                    }
                    const appendResult = appendValidatedRecords(records);
                    if (!appendResult.ok) {
                        sendJson(res, appendResult.status, { ok: false, error: appendResult.error });
                        return;
                    }
                    sendJson(res, 200, { ok: true });
                    return;
                }

                sendJson(res, 404, { ok: false, error: "Not found" });
            } catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        });
    };

    return {
        name: "execution-lab-api",
        configureServer(server) {
            register(server.middlewares, true);
        },
        configurePreviewServer(server) {
            register(
                server.middlewares,
                process.env.EXECUTION_LAB_ALLOW_LIVE_TRADE_PREVIEW === "1"
            );
        },
    };
}
