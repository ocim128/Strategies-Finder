import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { Plugin } from "vite";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import type {
    PolymarketClob1sQuoteRow,
    SecondMarketPolymarketEvent,
    SecondMarketSymbol,
} from "../second-market/types";
import { fetchBinance1sCandles } from "../second-market/binance-1s-sync";
import type {
    ExecutionLabLiveUiConfig,
    ExecutionLabRecord,
    LiveCancelAllSubmitRequest,
    LiveCancelAllSubmitResponse,
    LiveTradeSubmitRequest,
    LiveTradeSubmitResponse,
} from "./execution-lab-model";
import {
    loadLiveExecutorStatus,
    submitLiveCancelAllToExecutor,
    submitLiveTradeToExecutor,
} from "./live-executor-adapter";
import { stableStringify } from "../json-utils";
import { sanitizeExecutionLabPathPart, validateExecutionLabRecord } from "./paper-log-schema";
import {
    buildLiveTradeFailureResponse,
    buildLiveCancelAllFailureResponse,
    LIVE_TRADE_MAX_EXPIRY_WINDOW_SEC,
    normalizeExecutionLabLiveUiConfig,
    validateLiveCancelAllSubmitRequest,
    validateLiveTradeSubmitRequest,
} from "./live-trade-request";
import { parseTimeToUnixSeconds } from "../time-normalization";
import {
    configureBinanceDns,
    resolveBinanceDnsMode,
    type BinanceDnsMode,
} from "../second-market/binance-dns";
import { readJsonBody, sendCaughtErrorJson } from "../vite-http-utils";
import { isAllowedLocalRequest } from "../local-route-authorization";

const DEFAULT_LOG_ROOT = resolve(process.cwd(), "logs", "paper-execution");
// Test-only override so the session-log spec can redirect log writes to a
// per-spec tempdir instead of the production `logs/paper-execution/` tree
// (audit Finding 3). `null` resolves to the production root.
let logRootForTests: string | null = null;

function logRoot(): string {
    return logRootForTests ?? DEFAULT_LOG_ROOT;
}

/** Test seam: redirect session-log writes to a per-spec tempdir. */
export function __setLogRootForTests(dir: string | null): void {
    logRootForTests = dir;
}
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
const BINANCE_SPOT_BASE = "https://api.binance.com";
const BINANCE_SPOT_KLINE_PATH = "/api/v3/klines";
const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const CLOB_PRICE_URL = "https://clob.polymarket.com/price";
const SUPPORTED_SYMBOLS = new Set(["BTCUSDT", "XRPUSDT"]);
const RECENT_LOCAL_QUOTE_FALLBACK_SEC = 2;
const MAX_STORED_LIVE_QUOTE_AGE_MS = 3_000;
const LIVE_CANDLE_RATE_LIMIT_BACKOFF_MS = 60_000;
const LIVE_CANDLE_TRANSIENT_BACKOFF_MS = 5_000;
const LIVE_CANDLE_CLOSED_LAG_SEC = 1;
const FUTURES_STORED_ZERO_TAIL_REFETCH_SEC = 8;
const DEFAULT_EXECUTION_LAB_BINANCE_DNS: BinanceDnsMode = "adguard-doh";
const BINANCE_LIVE_FETCH_TIMEOUT_MS = 15000;
const GAMMA_LIVE_FETCH_TIMEOUT_MS = 15000;
const CLOB_LIVE_FETCH_TIMEOUT_MS = 5000;
const EXECUTION_LAB_MINER_OUTCOME_INTERVALS: readonly PolymarketOutcomeInterval[] = ["5m", "15m"];

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
    source: string;
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
type LiveCancelLedgerEntry = {
    payloadHash: string;
    expiresAtMs: number;
    pending?: Promise<LiveCancelAllSubmitResponse>;
    response?: LiveCancelAllSubmitResponse;
};
type ExecutionLabMinerMarketType = "spot" | "futures";

function getExecutionLabBinanceDnsMode(): BinanceDnsMode {
    return resolveBinanceDnsMode(process.env.SECOND_MARKET_BINANCE_DNS, DEFAULT_EXECUTION_LAB_BINANCE_DNS);
}

function sendJson(res: any, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

function parseMinerMarketType(value: unknown): ExecutionLabMinerMarketType {
    return value === "futures" ? "futures" : "spot";
}

export function buildExecutionLabMinerProcessArgs(marketType: ExecutionLabMinerMarketType): string[] {
    return [
        ESNO_SCRIPT,
        "scripts/second-market-miner.ts",
        "--mode",
        "live",
        "--symbols",
        "BTCUSDT,XRPUSDT",
        "--market-type",
        marketType,
        "--outcome-intervals",
        EXECUTION_LAB_MINER_OUTCOME_INTERVALS.join(","),
        "--db",
        MINER_DB_PATH,
        "--binance-dns",
        getExecutionLabBinanceDnsMode(),
    ];
}

function payloadHash(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function readLiveUiConfigFromPayload(payload: Record<string, unknown>): ExecutionLabLiveUiConfig | undefined {
    return payload.liveConfig && typeof payload.liveConfig === "object" && !Array.isArray(payload.liveConfig)
        ? normalizeExecutionLabLiveUiConfig(payload.liveConfig)
        : undefined;
}

function readSessionIdFromPayload(payload: Record<string, unknown>): string | null {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    return sessionId || null;
}

function finiteNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorCauseMessage(error: unknown): string {
    if (!(error instanceof Error)) return "";
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    if (cause && typeof cause === "object" && "message" in cause) {
        return String((cause as { message?: unknown }).message ?? "");
    }
    return "";
}

function errorCode(error: unknown): string {
    if (error && typeof error === "object" && "code" in error) {
        return String((error as { code?: unknown }).code ?? "");
    }
    if (error instanceof Error) {
        const cause = (error as Error & { cause?: unknown }).cause;
        if (cause && typeof cause === "object" && "code" in cause) {
            return String((cause as { code?: unknown }).code ?? "");
        }
    }
    return "";
}

function describeExternalFetchError(label: string, error: unknown, timeoutMs: number): string {
    const message = errorMessage(error);
    const causeMessage = errorCauseMessage(error);
    const code = errorCode(error);
    const combined = `${message} ${causeMessage} ${code}`.toLowerCase();
    if (/aborted|timeout|timed out/.test(combined)) {
        return `${label} timed out after ${timeoutMs}ms`;
    }
    if (/dns|enotfound|eai_again|eai_nodata/.test(combined)) {
        return `${label} DNS lookup failed: ${message}`;
    }
    if (/fetch failed|network|econnreset|econnrefused|etimedout/.test(combined)) {
        return `${label} network request failed: ${message}`;
    }
    return `${label} failed: ${message}`;
}

async function fetchExternal(
    url: URL,
    label: string,
    timeoutMs: number
): Promise<Response> {
    try {
        return await fetch(url, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        throw new Error(describeExternalFetchError(label, error, timeoutMs));
    }
}

function liveCandleFetchBackoffMs(error: unknown): number {
    const message = errorMessage(error);
    if (/HTTP\s*(418|429)\b/i.test(message)) return LIVE_CANDLE_RATE_LIMIT_BACKOFF_MS;
    if (/HTTP\s*5\d\d\b/i.test(message) || /fetch failed|network|timeout|DNS lookup failed/i.test(message)) {
        return LIVE_CANDLE_TRANSIENT_BACKOFF_MS;
    }
    return 0;
}

export function normalizeExecutionLabClobPrice(value: unknown): number | null {
    if (typeof value === "string" && value.trim() === "") return null;
    const price = finiteNumber(value);
    return price !== null && price >= 0 && price <= 1 ? price : null;
}

function toUnixSeconds(value: unknown): number | null {
    return parseTimeToUnixSeconds(value);
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
        source: "binance_1s",
        updated_at: Math.floor(Date.now() / 1000),
    };
}

function hasTradeActivity(row: Pick<LiveCandleRow, "volume" | "trade_count">): boolean {
    return row.volume > 0 || (row.trade_count ?? 0) > 0;
}

let executionLabReadDb: DatabaseSync | null = null;
let exactLiveQuoteStmt: ReturnType<DatabaseSync["prepare"]> | null = null;
let recentLiveQuoteStmt: ReturnType<DatabaseSync["prepare"]> | null = null;
let executionLabReadDbExitHookRegistered = false;

function resetExecutionLabReadDb(): void {
    exactLiveQuoteStmt = null;
    recentLiveQuoteStmt = null;
    executionLabReadDb?.close();
    executionLabReadDb = null;
}

function getExecutionLabReadDb(): DatabaseSync | null {
    if (!existsSync(MINER_DB_PATH)) {
        resetExecutionLabReadDb();
        return null;
    }
    if (executionLabReadDb) return executionLabReadDb;
    try {
        executionLabReadDb = new DatabaseSync(MINER_DB_PATH, { readOnly: true });
        executionLabReadDb.exec("PRAGMA busy_timeout = 5000");
        if (!executionLabReadDbExitHookRegistered) {
            executionLabReadDbExitHookRegistered = true;
            process.once("exit", resetExecutionLabReadDb);
        }
        return executionLabReadDb;
    } catch {
        resetExecutionLabReadDb();
        return null;
    }
}

function loadStoredLiveCandles(args: {
    symbol: SecondMarketSymbol;
    marketType: "spot" | "futures";
    startTs: number;
    endTs: number;
    limit: number;
}): LiveCandleRow[] {
    const db = getExecutionLabReadDb();
    if (!db) return [];
    try {
        const rows = db.prepare(`
            SELECT symbol, market_type, ts, open, high, low, close, volume, trade_count, source, updated_at
            FROM binance_1s_candles
            WHERE symbol = ? AND market_type = ? AND ts >= ? AND ts <= ?
            ORDER BY ts ASC
            LIMIT ?
        `).all(
            args.symbol,
            args.marketType,
            Math.floor(args.startTs),
            Math.floor(args.endTs),
            Math.max(1, Math.floor(args.limit)),
        ) as LiveCandleRow[];
        return rows;
    } catch {
        resetExecutionLabReadDb();
        return [];
    }
}

async function fetchLiveCandles(args: {
    symbol: SecondMarketSymbol;
    marketType: "spot" | "futures";
    startTs: number;
    endTs: number;
    limit: number;
}): Promise<LiveCandleRow[]> {
    const closedEndTs = Math.min(args.endTs, Math.floor(Date.now() / 1000) - LIVE_CANDLE_CLOSED_LAG_SEC);
    if (closedEndTs < args.startTs) return [];
    if (args.marketType === "futures") {
        const signal = AbortSignal.timeout(BINANCE_LIVE_FETCH_TIMEOUT_MS);
        const rows = await fetchBinance1sCandles({
            symbol: args.symbol,
            marketType: "futures",
            startTs: args.startTs,
            endTs: closedEndTs,
            closedLagSec: LIVE_CANDLE_CLOSED_LAG_SEC,
            signal,
        }).catch((error: unknown) => {
            throw new Error(describeExternalFetchError(
                "Binance futures live 1s fetch",
                error,
                BINANCE_LIVE_FETCH_TIMEOUT_MS
            ));
        });
        return rows.slice(-args.limit).map((row) => ({
            symbol: row.symbol,
            market_type: row.market_type,
            ts: row.ts,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
            trade_count: row.trade_count,
            source: row.source,
            updated_at: row.updated_at,
        }));
    }

    const out: LiveCandleRow[] = [];
    let cursorMs = Math.floor(args.startTs) * 1000;
    const endMs = Math.floor(closedEndTs) * 1000;

    while (cursorMs <= endMs && out.length < args.limit) {
        const requestLimit = Math.min(1000, args.limit - out.length);
        const url = new URL(`${BINANCE_SPOT_BASE}${BINANCE_SPOT_KLINE_PATH}`);
        url.searchParams.set("symbol", args.symbol);
        url.searchParams.set("interval", "1s");
        url.searchParams.set("startTime", String(cursorMs));
        url.searchParams.set("endTime", String(endMs));
        url.searchParams.set("limit", String(requestLimit));

        const response = await fetchExternal(url, "Binance spot live 1s fetch", BINANCE_LIVE_FETCH_TIMEOUT_MS);
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

    const response = await fetchExternal(url, "Gamma live events fetch", GAMMA_LIVE_FETCH_TIMEOUT_MS);
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

    const response = await fetchExternal(url, "Gamma live outcomes fetch", GAMMA_LIVE_FETCH_TIMEOUT_MS);
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
    const response = await fetchExternal(url, "CLOB live price fetch", CLOB_LIVE_FETCH_TIMEOUT_MS);
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

function loadStoredLiveQuote(event: SecondMarketPolymarketEvent, sampleTs: number): PolymarketClob1sQuoteRow | null {
    const db = getExecutionLabReadDb();
    if (!db) return null;
    const targetTs = Math.floor(sampleTs);
    try {
        exactLiveQuoteStmt ??= db.prepare(`
            SELECT series_id, symbol, outcome_interval, event_start_ts, event_end_ts,
                   condition_id, market_slug, yes_token_id, no_token_id,
                   sample_ts, yes_bid, yes_ask, yes_mid, yes_last,
                   no_bid, no_ask, no_mid, no_last,
                   source, source_ts_ms, quote_age_ms, quality_flags, updated_at
            FROM polymarket_clob_1s_quotes
            WHERE series_id = ?
              AND symbol = ?
              AND event_start_ts = ?
              AND yes_token_id = ?
              AND no_token_id = ?
              AND sample_ts = ?
              AND event_start_ts <= sample_ts
              AND event_end_ts > sample_ts
            ORDER BY sample_ts DESC, source_ts_ms DESC, updated_at DESC
            LIMIT 1
        `);
        const row = exactLiveQuoteStmt.get(
            event.seriesId,
            event.symbol,
            event.eventStartTs,
            event.yesTokenId,
            event.noTokenId,
            targetTs,
        ) as PolymarketClob1sQuoteRow | undefined;
        return row ?? null;
    } catch {
        resetExecutionLabReadDb();
        return null;
    }
}

function splitQuoteQualityFlags(qualityFlags: string | null | undefined): string[] {
    return qualityFlags ? qualityFlags.split(",").map((flag) => flag.trim()).filter(Boolean) : [];
}

export function isFreshStoredLiveQuote(quote: PolymarketClob1sQuoteRow): boolean {
    const flags = splitQuoteQualityFlags(quote.quality_flags);
    if (flags.includes("carried_forward") || flags.includes("recent_local_fallback")) return false;
    if (quote.quote_age_ms !== null && quote.quote_age_ms > MAX_STORED_LIVE_QUOTE_AGE_MS) return false;
    if (quote.source_ts_ms !== null && Date.now() - quote.source_ts_ms > MAX_STORED_LIVE_QUOTE_AGE_MS) return false;
    if (quote.yes_bid === null || quote.yes_ask === null) return false;
    if (quote.no_bid === null || quote.no_ask === null) return false;
    return true;
}

function withRecentQuoteFallbackFlags(quote: PolymarketClob1sQuoteRow, sampleTs: number): PolymarketClob1sQuoteRow {
    const targetTs = Math.floor(sampleTs);
    const lagSec = Math.max(0, targetTs - Math.floor(quote.sample_ts));
    const existingFlags = quote.quality_flags ? `${quote.quality_flags},` : "";
    return {
        ...quote,
        sample_ts: targetTs,
        source: "second_market_db_recent",
        quote_age_ms: quote.source_ts_ms === null ? quote.quote_age_ms : Math.max(0, Date.now() - quote.source_ts_ms),
        quality_flags: `${existingFlags}recent_local_fallback,source_sample_lag_${lagSec}s`,
        updated_at: Math.floor(Date.now() / 1000),
    };
}

function loadRecentStoredLiveQuote(
    event: SecondMarketPolymarketEvent,
    sampleTs: number,
    maxLagSec: number
): PolymarketClob1sQuoteRow | null {
    const db = getExecutionLabReadDb();
    if (!db) return null;
    const targetTs = Math.floor(sampleTs);
    try {
        recentLiveQuoteStmt ??= db.prepare(`
            SELECT series_id, symbol, outcome_interval, event_start_ts, event_end_ts,
                   condition_id, market_slug, yes_token_id, no_token_id,
                   sample_ts, yes_bid, yes_ask, yes_mid, yes_last,
                   no_bid, no_ask, no_mid, no_last,
                   source, source_ts_ms, quote_age_ms, quality_flags, updated_at
            FROM polymarket_clob_1s_quotes
            WHERE series_id = ?
              AND symbol = ?
              AND event_start_ts = ?
              AND yes_token_id = ?
              AND no_token_id = ?
              AND sample_ts >= ?
              AND sample_ts <= ?
              AND event_start_ts <= sample_ts
              AND event_end_ts > sample_ts
            ORDER BY sample_ts DESC, source_ts_ms DESC, updated_at DESC
            LIMIT 1
        `);
        const row = recentLiveQuoteStmt.get(
            event.seriesId,
            event.symbol,
            event.eventStartTs,
            event.yesTokenId,
            event.noTokenId,
            targetTs - Math.max(0, Math.floor(maxLagSec)),
            targetTs - 1,
        ) as PolymarketClob1sQuoteRow | undefined;
        return row ? withRecentQuoteFallbackFlags(row, targetTs) : null;
    } catch {
        resetExecutionLabReadDb();
        return null;
    }
}

export function executionLabVitePlugin(): Plugin {
    configureBinanceDns(getExecutionLabBinanceDnsMode());

    const sessions = new Map<string, { logPath: string; lastActivityMs: number }>();
    const sessionLogQueues = new Map<string, Promise<void>>();
    // Audit Finding (abandoned session expiry): sessions were previously
    // removed only when a valid session_stop record arrived. Browser crashes,
    // reloads, network errors, or malicious session creation left entries (and
    // the associated session IDs accepted by live-trade validation) alive
    // indefinitely. The TTL below prunes idle sessions on the same lifecycle
    // hooks the existing live-ledger pruning already uses.
    const SESSION_IDLE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
    const liveEventCache = new Map<string, CacheEntry<SecondMarketPolymarketEvent[]>>();
    const liveOutcomeCache = new Map<string, CacheEntry<LiveOutcomeRow[]>>();
    const inFlightFetches = new Map<string, Promise<unknown>>();
    const liveCandleFetchBackoffUntil = new Map<string, number>();
    const liveTradeLedger = new Map<string, LiveTradeLedgerEntry>();
    const liveCancelLedger = new Map<string, LiveCancelLedgerEntry>();
    let minerProcess: ChildProcessWithoutNullStreams | null = null;
    let minerStartedAtIso: string | null = null;
    let minerExitCode: number | null = null;
    let minerMarketType: ExecutionLabMinerMarketType = "spot";
    let minerMessage = "Idle";

    function pruneExpiredCache<T>(cache: Map<string, CacheEntry<T>>, now: number): void {
        for (const [cacheKey, entry] of cache.entries()) {
            if (entry.expiresAtMs <= now) {
                cache.delete(cacheKey);
            }
        }
    }

    function pruneLiveLedgers(now: number): void {
        for (const [requestId, entry] of liveTradeLedger.entries()) {
            if (entry.expiresAtMs <= now && !entry.pending) {
                liveTradeLedger.delete(requestId);
            }
        }
        for (const [requestId, entry] of liveCancelLedger.entries()) {
            if (entry.expiresAtMs <= now && !entry.pending) {
                liveCancelLedger.delete(requestId);
            }
        }
    }

    async function submitLiveTradeOnce(
        request: LiveTradeSubmitRequest,
        liveUiConfig?: ExecutionLabLiveUiConfig
    ): Promise<LiveTradeSubmitResponse> {
        const now = Date.now();
        pruneLiveLedgers(now);
        const hash = payloadHash({ request, liveUiConfig: liveUiConfig ?? null });
        const existing = liveTradeLedger.get(request.requestId);
        if (existing) {
            if (existing.payloadHash !== hash) {
                return buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    status: "rejected",
                    reason: "request_id_payload_mismatch",
                    maxPrice: request.maxPrice,
                    limitPrice: request.action === "entry" && request.orderMode === "limit" ? request.limitPrice : undefined,
                    minPrice: request.action === "exit" ? request.minPrice : undefined,
                });
            }
            if (existing.response) return existing.response;
            if (existing.pending) return await existing.pending;
        }

        const pending = submitLiveTradeToExecutor(request, undefined, liveUiConfig);
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

    async function submitLiveCancelOnce(
        request: LiveCancelAllSubmitRequest,
        liveUiConfig?: ExecutionLabLiveUiConfig
    ): Promise<LiveCancelAllSubmitResponse> {
        const now = Date.now();
        pruneLiveLedgers(now);
        const hash = payloadHash({ request, liveUiConfig: liveUiConfig ?? null });
        const existing = liveCancelLedger.get(request.requestId);
        if (existing) {
            if (existing.payloadHash !== hash) {
                return buildLiveCancelAllFailureResponse({
                    requestId: request.requestId,
                    scope: request.scope,
                    status: "rejected",
                    reason: "request_id_payload_mismatch",
                });
            }
            if (existing.response) return existing.response;
            if (existing.pending) return await existing.pending;
        }

        const pending = submitLiveCancelAllToExecutor(request, undefined, liveUiConfig);
        const entry: LiveCancelLedgerEntry = {
            payloadHash: hash,
            expiresAtMs: now + LIVE_TRADE_LEDGER_TTL_MS,
            pending,
        };
        liveCancelLedger.set(request.requestId, entry);
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

    async function appendSessionLog(sessionId: string, logPath: string, text: string): Promise<void> {
        const previous = sessionLogQueues.get(sessionId) ?? Promise.resolve();
        const write = previous.then(() => appendFile(logPath, text, "utf8"));
        sessionLogQueues.set(sessionId, write.catch(() => undefined));
        await write;
    }

    function touchSession(sessionId: string): void {
        const entry = sessions.get(sessionId);
        if (entry) entry.lastActivityMs = Date.now();
    }

    /**
     * Audit Finding (abandoned session expiry): drop sessions whose
     * `lastActivityMs` is older than the idle TTL. Also clear the matching
     * sessionLogQueues entry so the in-flight write promise does not leak.
     * Called on session creation, log appends, and live-order submission so
     * the maps stay bounded regardless of browser lifecycle.
     */
    function pruneExpiredSessions(): void {
        const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
        for (const [sessionId, entry] of sessions) {
            if (entry.lastActivityMs < cutoff) {
                sessions.delete(sessionId);
                sessionLogQueues.delete(sessionId);
            }
        }
    }

    async function appendValidatedRecords(records: readonly ExecutionLabRecord[]): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
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

        pruneExpiredSessions();

        const entry = sessions.get(sessionId);
        if (!entry) {
            return { ok: false, status: 404, error: "Unknown execution lab session" };
        }

        await appendSessionLog(sessionId, entry.logPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
        if (records.some((record) => record.recordType === "session_stop")) {
            sessions.delete(sessionId);
            sessionLogQueues.delete(sessionId);
        } else {
            touchSession(sessionId);
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
            marketType: minerMarketType,
            message: minerMessage,
        };
    }

    function startMiner(marketType: ExecutionLabMinerMarketType): ReturnType<typeof minerStatusPayload> {
        if (minerProcess && minerProcess.exitCode === null && minerProcess.signalCode === null) {
            minerMessage = `Already running ${minerMarketType} 5m,15m`;
            return minerStatusPayload();
        }
        if (!existsSync(ESNO_BIN) || !existsSync(ESNO_SCRIPT)) {
            throw new Error(`Missing esno launcher: ${ESNO_BIN}`);
        }

        mkdirSync(dirname(MINER_LOG_PATH), { recursive: true });
        const startedAtIso = new Date().toISOString();
        const minerArgs = buildExecutionLabMinerProcessArgs(marketType);
        writeFileSync(
            MINER_LOG_PATH,
            [
                `[execution-lab-miner] Started ${startedAtIso}`,
                `Repo: ${process.cwd()}`,
                `ESNO: ${ESNO_BIN}`,
                `ESNO_SCRIPT: ${ESNO_SCRIPT}`,
                `NODE: ${process.execPath}`,
                `DB: ${MINER_DB_PATH}`,
                `Market type: ${marketType}`,
                `Outcome intervals: ${EXECUTION_LAB_MINER_OUTCOME_INTERVALS.join(",")}`,
                `Args: ${minerArgs.slice(1).join(" ")}`,
                "",
            ].join("\n"),
            "utf8"
        );

        const logStream = createWriteStream(MINER_LOG_PATH, { flags: "a" });
        minerProcess = spawn(process.execPath, minerArgs, {
            cwd: process.cwd(),
            windowsHide: true,
        });
        minerStartedAtIso = startedAtIso;
        minerExitCode = null;
        minerMarketType = marketType;
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
                    const fetchKey = `${symbol}|${marketType}`;
                    const explicitEndTs = toUnixSeconds(requestUrl.searchParams.get("endTs"));
                    const explicitStartTs = toUnixSeconds(requestUrl.searchParams.get("startTs"));
                    const latestClosedTs = Math.floor(Date.now() / 1000) - LIVE_CANDLE_CLOSED_LAG_SEC;
                    const endTs = Math.min(explicitEndTs ?? latestClosedTs, latestClosedTs);
                    const lookbackLimit = Math.min(20000, Math.max(limit + 60, 120));
                    const startTs = explicitStartTs ?? Math.max(0, endTs - lookbackLimit + 1);
                    const stored = loadStoredLiveCandles({
                        symbol,
                        marketType,
                        startTs,
                        endTs,
                        limit: explicitStartTs === null ? lookbackLimit : limit,
                    });
                    const latestStoredTs = stored.length > 0 ? stored[stored.length - 1].ts : null;
                    const requestedSeconds = Math.max(0, endTs - startTs + 1);
                    const hasExpectedCoverage = stored.length >= Math.min(
                        explicitStartTs === null ? lookbackLimit : limit,
                        requestedSeconds
                    );
                    const storedTail = stored.slice(-Math.min(FUTURES_STORED_ZERO_TAIL_REFETCH_SEC, stored.length));
                    const hasUsableStoredTail = marketType !== "futures"
                        || storedTail.length === 0
                        || storedTail.some(hasTradeActivity);
                    if (
                        stored.length > 0
                        && latestStoredTs !== null
                        && latestStoredTs >= endTs
                        && hasExpectedCoverage
                        && hasUsableStoredTail
                    ) {
                        sendJson(res, 200, { ok: true, source: "second_market_db", symbol, marketType, candles: stored.slice(-limit) });
                        return;
                    }
                    const backoffUntilMs = liveCandleFetchBackoffUntil.get(fetchKey) ?? 0;
                    if (backoffUntilMs > Date.now() && stored.length > 0) {
                        sendJson(res, 200, {
                            ok: true,
                            source: "second_market_db_backoff",
                            symbol,
                            marketType,
                            backoffUntilIso: new Date(backoffUntilMs).toISOString(),
                            candles: stored.slice(-limit),
                        });
                        return;
                    }
                    try {
                        const fetched = await fetchLiveCandles({
                            symbol,
                            marketType,
                            startTs,
                            endTs,
                            limit: explicitStartTs === null ? lookbackLimit : limit,
                        });
                        liveCandleFetchBackoffUntil.delete(fetchKey);
                        sendJson(res, 200, { ok: true, source: "binance_live", symbol, marketType, candles: fetched.slice(-limit) });
                    } catch (error) {
                        const backoffMs = liveCandleFetchBackoffMs(error);
                        if (backoffMs > 0) {
                            liveCandleFetchBackoffUntil.set(fetchKey, Date.now() + backoffMs);
                        }
                        if (stored.length > 0) {
                            sendJson(res, 200, {
                                ok: true,
                                source: "second_market_db_stale",
                                symbol,
                                marketType,
                                warning: errorMessage(error),
                                candles: stored.slice(-limit),
                            });
                            return;
                        }
                        throw error;
                    }
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
                    const event = {
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
                    };
                    const storedQuote = loadStoredLiveQuote(event, sampleTs);
                    const isHistoricalQuoteRequest = sampleTs < Math.floor(Date.now() / 1000) - 30;
                    if (storedQuote && isHistoricalQuoteRequest) {
                        sendJson(res, 200, { ok: true, source: "second_market_db", quote: storedQuote });
                        return;
                    }
                    if (storedQuote && isFreshStoredLiveQuote(storedQuote)) {
                        sendJson(res, 200, { ok: true, source: "second_market_db", quote: storedQuote });
                        return;
                    }
                    if (isHistoricalQuoteRequest) {
                        const recentStoredQuote = loadRecentStoredLiveQuote(event, sampleTs, RECENT_LOCAL_QUOTE_FALLBACK_SEC);
                        if (recentStoredQuote) {
                            sendJson(res, 200, { ok: true, source: "second_market_db_recent", quote: recentStoredQuote });
                            return;
                        }
                        sendJson(res, 409, { ok: false, error: "Historical CLOB quote requests must use stored second-market quotes." });
                        return;
                    }
                    try {
                        const quote = await buildLiveQuote(event, sampleTs);
                        sendJson(res, 200, { ok: true, source: "clob_live", quote });
                        return;
                    } catch (liveQuoteError) {
                        const recentStoredQuote = loadRecentStoredLiveQuote(event, sampleTs, RECENT_LOCAL_QUOTE_FALLBACK_SEC);
                        if (recentStoredQuote) {
                            sendJson(res, 200, { ok: true, source: "second_market_db_recent", quote: recentStoredQuote });
                            return;
                        }
                        if (storedQuote) {
                            sendJson(res, 200, { ok: true, source: "second_market_db_stale", quote: storedQuote });
                            return;
                        }
                        throw liveQuoteError;
                    }
                }

                if (method === "GET" && path === "/miner/status") {
                    sendJson(res, 200, minerStatusPayload());
                    return;
                }

                // Audit Finding (Execution Lab control-plane auth): every
                // state-changing route — miner start/stop, session creation,
                // logging, live trade, cancel — and the `/live/status` executor
                // config probe (which surfaces token IDs / order mode) MUST be
                // gated by the same loopback/bearer policy the IBKR, Batch, and
                // strategy-admin routes enforce. Without this, a Vite server
                // started with `--host`, exposed through a tunnel, or reached
                // from another machine could be driven into spawning processes,
                // writing files, and submitting or cancelling real orders.
                if (method === "POST" || (method === "GET" && path === "/live/status")) {
                    if (!isAllowedLocalRequest(req)) {
                        sendJson(res, 401, { ok: false, error: "Unauthorized: execution-lab mutation routes are local-only." });
                        return;
                    }
                }

                if (method === "GET" && path === "/live/status") {
                    sendJson(res, 200, loadLiveExecutorStatus());
                    return;
                }

                if (method !== "POST") {
                    sendJson(res, 405, { ok: false, error: "Method not allowed" });
                    return;
                }

                // Audit Finding (POST body content-type): every Execution Lab
                // POST passes `{ requireJsonContentType: true }` to its
                // `readJsonBody` call so curl/form-post traffic cannot bypass
                // JSON validation with a 415. The browser UI already sends
                // `Content-Type: application/json`.

                if (path === "/miner/start") {
                    const payload = await readJsonBody(req as IncomingMessage, MAX_BODY_BYTES, { requireJsonContentType: true });
                    sendJson(res, 200, startMiner(parseMinerMarketType(payload.marketType)));
                    return;
                }

                if (path === "/miner/stop") {
                    sendJson(res, 200, stopMiner());
                    return;
                }

                if (path === "/live/config/resolve") {
                    const payload = await readJsonBody(req as IncomingMessage, MAX_BODY_BYTES, { requireJsonContentType: true });
                    const liveUiConfig = readLiveUiConfigFromPayload(payload)
                        ?? normalizeExecutionLabLiveUiConfig(payload);
                    sendJson(res, 200, loadLiveExecutorStatus(undefined, liveUiConfig));
                    return;
                }

                if (path === "/live/trade") {
                    if (!allowLiveSubmission) {
                        sendJson(res, 404, { ok: false, error: "Live trade submission is not registered in preview mode." });
                        return;
                    }
                    const payload = await readJsonBody(req as IncomingMessage, MAX_BODY_BYTES, { requireJsonContentType: true });
                    const sessionId = readSessionIdFromPayload(payload);
                    pruneExpiredSessions();
                    if (!sessionId || !sessions.has(sessionId)) {
                        sendJson(res, 404, { ok: false, error: "Unknown execution lab session" });
                        return;
                    }
                    touchSession(sessionId);
                    const liveUiConfig = readLiveUiConfigFromPayload(payload);
                    const status = loadLiveExecutorStatus(undefined, liveUiConfig);
                    const validation = validateLiveTradeSubmitRequest(payload, {
                        maxStakeUsd: status.maxStakeUsd,
                        sizingMode: status.sizingMode,
                        orderMode: status.orderMode,
                        supportedTakerOrderTypes: status.supportedTakerOrderTypes,
                        supportedLimitOrderType: status.supportedLimitOrderType,
                        maxExpiryWindowSec: LIVE_TRADE_MAX_EXPIRY_WINDOW_SEC,
                    });
                    if (!validation.ok) {
                        sendJson(res, 400, { ok: false, error: validation.error });
                        return;
                    }
                    if (
                        validation.request.action === "entry"
                        && validation.request.orderMode !== status.orderMode
                    ) {
                        sendJson(res, 200, buildLiveTradeFailureResponse({
                            requestId: validation.request.requestId,
                            status: "rejected",
                            reason: "order_mode_config_mismatch",
                            maxPrice: validation.request.maxPrice,
                            limitPrice: validation.request.orderMode === "limit" ? validation.request.limitPrice : undefined,
                        }));
                        return;
                    }
                    const expectedOrderType = validation.request.action === "take_profit"
                        || (validation.request.action === "entry" && validation.request.orderMode === "limit")
                        ? status.supportedLimitOrderType
                        : status.takerOrderType;
                    if (validation.request.orderType !== expectedOrderType) {
                        sendJson(res, 200, buildLiveTradeFailureResponse({
                            requestId: validation.request.requestId,
                            status: "rejected",
                            reason: "order_type_config_mismatch",
                            maxPrice: validation.request.maxPrice,
                            limitPrice: validation.request.orderMode === "limit"
                                ? validation.request.limitPrice
                                : undefined,
                            minPrice: validation.request.action === "exit" || validation.request.action === "take_profit"
                                ? validation.request.minPrice
                                : undefined,
                        }));
                        return;
                    }
                    sendJson(res, 200, await submitLiveTradeOnce(validation.request, liveUiConfig));
                    return;
                }

                if (path === "/live/cancel-all") {
                    if (!allowLiveSubmission) {
                        sendJson(res, 404, { ok: false, error: "Live cancel-all submission is not registered in preview mode." });
                        return;
                    }
                    const payload = await readJsonBody(req as IncomingMessage, MAX_BODY_BYTES, { requireJsonContentType: true });
                    const sessionId = readSessionIdFromPayload(payload);
                    pruneExpiredSessions();
                    if (!sessionId || !sessions.has(sessionId)) {
                        sendJson(res, 404, { ok: false, error: "Unknown execution lab session" });
                        return;
                    }
                    touchSession(sessionId);
                    const liveUiConfig = readLiveUiConfigFromPayload(payload);
                    const status = loadLiveExecutorStatus(undefined, liveUiConfig);
                    const validation = validateLiveCancelAllSubmitRequest(payload, {
                        resolvedConfig: {
                            orderMode: status.orderMode,
                            cancelScope: status.cancelScope,
                            limitCancelAllOnExitEnabled: status.limitCancelAllOnExitEnabled,
                        },
                    });
                    if (!validation.ok) {
                        sendJson(res, 400, { ok: false, error: validation.error });
                        return;
                    }
                    sendJson(res, 200, await submitLiveCancelOnce(validation.request, liveUiConfig));
                    return;
                }

                if (path === "/session/start") {
                    const payload = await readJsonBody(req as IncomingMessage, MAX_BODY_BYTES, { requireJsonContentType: true });
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
                        logRoot(),
                        sanitizeExecutionLabPathPart(strategyKey),
                        sanitizeExecutionLabPathPart(symbol),
                        day,
                        `${sessionId}.jsonl`,
                    );
                    mkdirSync(dirname(logPath), { recursive: true });
                    appendFileSync(logPath, "", "utf8");
                    // Prune abandoned sessions before registering a new one so the
                    // map does not grow unbounded under browser-crash / reload
                    // cycles (audit Finding: abandoned session expiry).
                    pruneExpiredSessions();
                    sessions.set(sessionId, { logPath, lastActivityMs: Date.now() });
                    sendJson(res, 200, { ok: true, sessionId, logPath });
                    return;
                }

                if (path === "/log") {
                    const payload = await readJsonBody(req as IncomingMessage, MAX_BODY_BYTES, { requireJsonContentType: true });
                    const validation = validateExecutionLabRecord(payload);
                    if (!validation.ok) {
                        sendJson(res, 400, { ok: false, error: validation.error });
                        return;
                    }
                    const appendResult = await appendValidatedRecords([validation.record]);
                    if (!appendResult.ok) {
                        sendJson(res, appendResult.status, { ok: false, error: appendResult.error });
                        return;
                    }
                    sendJson(res, 200, { ok: true });
                    return;
                }

                if (path === "/logs") {
                    const payload = await readJsonBody(req as IncomingMessage, MAX_BODY_BYTES, { requireJsonContentType: true });
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
                    const appendResult = await appendValidatedRecords(records);
                    if (!appendResult.ok) {
                        sendJson(res, appendResult.status, { ok: false, error: appendResult.error });
                        return;
                    }
                    sendJson(res, 200, { ok: true });
                    return;
                }

                sendJson(res, 404, { ok: false, error: "Not found" });
            } catch (error) {
                // sendCaughtErrorJson maps HttpStatusError (400/413 from the
                // shared readJsonBody) to its own status and everything else to 500.
                sendCaughtErrorJson(res, error);
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
