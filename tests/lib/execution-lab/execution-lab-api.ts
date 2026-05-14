import type { OHLCVData } from "../types/strategies";
import type { PolymarketClob1sQuoteRow, SecondMarketPolymarketEvent, SecondMarketSymbol } from "../second-market/types";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import type { ExecutionLabRecord } from "./execution-lab-model";

type ApiError = { ok?: false; error?: string };
type SessionStartResponse = { ok: true; sessionId: string; logPath: string };
type LiveCandlesResponse = {
    ok: true;
    candles: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
};
type LiveEventsResponse = { ok: true; events: SecondMarketPolymarketEvent[] };
type LiveQuoteResponse = { ok: true; quote: PolymarketClob1sQuoteRow };
type LiveOutcomesResponse = { ok: true; outcomes: PolymarketOutcomeRow[] };

function baseUrl(): string {
    return typeof window === "undefined" ? "http://localhost:5173" : "";
}

async function getJson<T extends { ok: true }>(endpoint: string): Promise<T> {
    const response = await fetch(`${baseUrl()}${endpoint}`, { method: "GET" });
    const payload = await response.json().catch(() => ({})) as T | ApiError;
    if (!response.ok || payload.ok !== true) {
        throw new Error((payload as ApiError).error ?? `${endpoint} failed (${response.status})`);
    }
    return payload as T;
}

async function postJson<T extends { ok: true }>(endpoint: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl()}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
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
