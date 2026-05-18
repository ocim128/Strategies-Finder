import type { OHLCVData } from "../types/strategies";
import { loadSecondMarketClobQuotes } from "../second-market/api";
import type { PolymarketClob1sQuoteRow, SecondMarketPolymarketEvent, SecondMarketSymbol } from "../second-market/types";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import type {
    ExecutionLabLiveUiConfig,
    ExecutionLabRecord,
    ExecutionLabResolvedLiveConfig,
    LiveCancelAllSubmitRequest,
    LiveCancelAllSubmitResponse,
    LiveExecutorStatus,
    LiveTradeSubmitRequest,
    LiveTradeSubmitResponse,
} from "./execution-lab-model";

type ApiError = { ok?: false; error?: string };
type SessionStartResponse = { ok: true; sessionId: string; logPath: string };
export type ExecutionLabMinerStatus = {
    ok: true;
    running: boolean;
    pid: number | null;
    startedAtIso: string | null;
    logPath: string;
    dbPath: string;
    exitCode: number | null;
    message?: string;
};
type LiveCandlesResponse = {
    ok: true;
    candles: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
};
type LiveEventsResponse = { ok: true; events: SecondMarketPolymarketEvent[] };
type LiveQuoteResponse = { ok: true; quote: PolymarketClob1sQuoteRow };
type LiveOutcomesResponse = { ok: true; outcomes: PolymarketOutcomeRow[] };
const MAX_EXECUTION_LAB_LOG_BATCH_RECORDS = 100;
const DEFAULT_API_TIMEOUT_MS = 10000;
const LIVE_TRADE_API_TIMEOUT_MS = 30000;

function baseUrl(): string {
    return typeof window === "undefined" ? "http://localhost:5173" : "";
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function getJson<T extends { ok: true }>(endpoint: string, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<T> {
    const response = await fetchWithTimeout(`${baseUrl()}${endpoint}`, { method: "GET" }, timeoutMs);
    const payload = await response.json().catch(() => ({})) as T | ApiError;
    if (!response.ok || payload.ok !== true) {
        throw new Error((payload as ApiError).error ?? `${endpoint} failed (${response.status})`);
    }
    return payload as T;
}

async function postJson<T extends { ok: true }>(endpoint: string, body: unknown, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<T> {
    const response = await fetchWithTimeout(`${baseUrl()}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }, timeoutMs);
    const payload = await response.json().catch(() => ({})) as T | ApiError;
    if (!response.ok || payload.ok !== true) {
        throw new Error((payload as ApiError).error ?? `${endpoint} failed (${response.status})`);
    }
    return payload as T;
}

export async function startExecutionLabSession(args: {
    strategyKey: string;
    symbol: string;
    startedAtIso: string;
}): Promise<SessionStartResponse> {
    return postJson<SessionStartResponse>("/api/execution-lab/session/start", args);
}

export async function appendExecutionLabRecord(record: ExecutionLabRecord): Promise<void> {
    await postJson<{ ok: true }>("/api/execution-lab/log", record);
}

export async function appendExecutionLabRecords(records: readonly ExecutionLabRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (records.length === 1) {
        await appendExecutionLabRecord(records[0]);
        return;
    }
    for (let index = 0; index < records.length; index += MAX_EXECUTION_LAB_LOG_BATCH_RECORDS) {
        const chunk = records.slice(index, index + MAX_EXECUTION_LAB_LOG_BATCH_RECORDS);
        await postJson<{ ok: true }>("/api/execution-lab/logs", { records: chunk });
    }
}

export async function startExecutionLabMiner(): Promise<ExecutionLabMinerStatus> {
    return postJson<ExecutionLabMinerStatus>("/api/execution-lab/miner/start", {});
}

export async function stopExecutionLabMiner(): Promise<ExecutionLabMinerStatus> {
    return postJson<ExecutionLabMinerStatus>("/api/execution-lab/miner/stop", {});
}

export async function loadExecutionLabMinerStatus(): Promise<ExecutionLabMinerStatus> {
    return getJson<ExecutionLabMinerStatus>("/api/execution-lab/miner/status");
}

export async function loadExecutionLabLiveExecutorStatus(): Promise<LiveExecutorStatus> {
    return getJson<LiveExecutorStatus>("/api/execution-lab/live/status");
}

export async function resolveExecutionLabLiveConfig(
    liveConfig: ExecutionLabLiveUiConfig
): Promise<ExecutionLabResolvedLiveConfig> {
    return postJson<ExecutionLabResolvedLiveConfig>("/api/execution-lab/live/config/resolve", { liveConfig });
}

export async function submitExecutionLabLiveTrade(
    request: LiveTradeSubmitRequest,
    liveConfig?: ExecutionLabLiveUiConfig
): Promise<LiveTradeSubmitResponse> {
    return postJson<LiveTradeSubmitResponse>(
        "/api/execution-lab/live/trade",
        liveConfig ? { ...request, liveConfig } : request,
        LIVE_TRADE_API_TIMEOUT_MS
    );
}

export async function submitExecutionLabLiveCancelAll(
    request: LiveCancelAllSubmitRequest,
    liveConfig?: ExecutionLabLiveUiConfig
): Promise<LiveCancelAllSubmitResponse> {
    return postJson<LiveCancelAllSubmitResponse>(
        "/api/execution-lab/live/cancel-all",
        liveConfig ? { ...request, liveConfig } : request,
        LIVE_TRADE_API_TIMEOUT_MS
    );
}

export async function loadExecutionLabLiveCandles(args: {
    symbol: SecondMarketSymbol;
    marketType?: "spot" | "futures";
    limit?: number;
    startTs?: number;
    endTs?: number;
}): Promise<OHLCVData[]> {
    const params = new URLSearchParams({ symbol: args.symbol, marketType: args.marketType ?? "spot" });
    if (args.limit !== undefined) params.set("limit", String(Math.max(1, Math.floor(args.limit))));
    if (args.startTs !== undefined) params.set("startTs", String(Math.floor(args.startTs)));
    if (args.endTs !== undefined) params.set("endTs", String(Math.floor(args.endTs)));
    const data = await getJson<LiveCandlesResponse>(`/api/execution-lab/live-candles?${params.toString()}`);
    return data.candles.map((row) => ({
        time: row.ts as OHLCVData["time"],
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
    }));
}

export async function loadExecutionLabLiveEvents(args: {
    symbol: SecondMarketSymbol;
    outcomeInterval: PolymarketOutcomeInterval;
    seriesId: string;
}): Promise<SecondMarketPolymarketEvent[]> {
    const params = new URLSearchParams({
        symbol: args.symbol,
        outcomeInterval: args.outcomeInterval,
        seriesId: args.seriesId,
    });
    const data = await getJson<LiveEventsResponse>(`/api/execution-lab/live-events?${params.toString()}`);
    return data.events;
}

export async function loadExecutionLabLiveQuote(args: {
    event: SecondMarketPolymarketEvent;
    sampleTs: number;
}): Promise<PolymarketClob1sQuoteRow> {
    const params = new URLSearchParams({
        symbol: args.event.symbol,
        outcomeInterval: args.event.outcomeInterval,
        seriesId: args.event.seriesId,
        eventSlug: args.event.eventSlug,
        marketId: args.event.marketId,
        conditionId: args.event.conditionId,
        marketSlug: args.event.marketSlug,
        eventStartTs: String(args.event.eventStartTs),
        eventEndTs: String(args.event.eventEndTs),
        yesTokenId: args.event.yesTokenId,
        noTokenId: args.event.noTokenId,
        sampleTs: String(Math.floor(args.sampleTs)),
    });
    const data = await getJson<LiveQuoteResponse>(`/api/execution-lab/live-quote?${params.toString()}`);
    return data.quote;
}

export async function loadExecutionLabLiveOutcomes(args: {
    symbol: SecondMarketSymbol;
    outcomeInterval: PolymarketOutcomeInterval;
    seriesId: string;
    startTs: number;
    endTs: number;
}): Promise<PolymarketOutcomeRow[]> {
    const params = new URLSearchParams({
        symbol: args.symbol,
        outcomeInterval: args.outcomeInterval,
        seriesId: args.seriesId,
        startTs: String(Math.floor(args.startTs)),
        endTs: String(Math.floor(args.endTs)),
    });
    const data = await getJson<LiveOutcomesResponse>(`/api/execution-lab/live-outcomes?${params.toString()}`);
    return data.outcomes;
}

export async function loadExecutionLabStoredQuotes(args: {
    symbol: SecondMarketSymbol;
    startTs: number;
    endTs: number;
    seriesId?: string;
}): Promise<PolymarketClob1sQuoteRow[]> {
    return loadSecondMarketClobQuotes(args);
}
