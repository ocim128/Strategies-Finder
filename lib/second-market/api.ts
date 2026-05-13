import type { OHLCVData } from "../types/strategies";
import type { PolymarketClob1sQuoteRow, SecondMarketSymbol } from "./types";
import { SECOND_MARKET_SYMBOLS } from "./types";

const SECOND_MARKET_SYMBOL_SET = new Set<string>(SECOND_MARKET_SYMBOLS);

type SecondMarketCandlesResponse = {
    ok: true;
    candles: Array<{
        ts: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
    stats?: {
        latestDataTs?: number | null;
        latestLagSec?: number | null;
    };
};

type SecondMarketClobQuotesResponse = {
    ok: true;
    quotes: PolymarketClob1sQuoteRow[];
    stats?: {
        distinctSeconds?: number;
        missingSeconds?: number;
        exactSampleCoveragePct?: number;
    };
};

type SecondMarketApiError = {
    ok?: false;
    error?: string;
};

function getBaseUrl(): string {
    return typeof window === "undefined" ? "http://localhost:5173" : "";
}

export function normalizeSecondMarketChartSymbol(symbol: string): SecondMarketSymbol | null {
    const normalized = symbol.trim().toUpperCase();
    return SECOND_MARKET_SYMBOL_SET.has(normalized)
        ? normalized as SecondMarketSymbol
        : null;
}

export function isSecondMarketChartContext(symbol: string, interval: string): boolean {
    return interval.trim().toLowerCase() === "1s" && normalizeSecondMarketChartSymbol(symbol) !== null;
}

function assertOk<T extends { ok: true }>(
    response: Response,
    payload: T | SecondMarketApiError,
    endpoint: string
): T {
    if (!response.ok || payload.ok !== true) {
        throw new Error((payload as SecondMarketApiError).error ?? `${endpoint} failed (${response.status})`);
    }
    return payload as T;
}

export async function loadSecondMarketCandles(args: {
    symbol: SecondMarketSymbol;
    limit?: number;
    marketType?: "spot" | "futures";
    startTs?: number;
    endTs?: number;
}): Promise<OHLCVData[]> {
    const params = new URLSearchParams({
        symbol: args.symbol,
        marketType: args.marketType ?? "spot",
    });
    if (args.limit !== undefined) params.set("limit", String(Math.max(1, Math.floor(args.limit))));
    if (args.startTs !== undefined) params.set("startTs", String(Math.floor(args.startTs)));
    if (args.endTs !== undefined) params.set("endTs", String(Math.floor(args.endTs)));

    const response = await fetch(`${getBaseUrl()}/api/second-market/candles?${params.toString()}`, { method: "GET" });
    const payload = await response.json().catch(() => ({})) as SecondMarketCandlesResponse | SecondMarketApiError;
    const data = assertOk(response, payload, "/api/second-market/candles");
    return data.candles.map((row) => ({
        time: row.ts as OHLCVData["time"],
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
    }));
}

export async function loadSecondMarketClobQuotes(args: {
    symbol: SecondMarketSymbol;
    startTs: number;
    endTs: number;
    seriesId?: string;
}): Promise<PolymarketClob1sQuoteRow[]> {
    const params = new URLSearchParams({
        symbol: args.symbol,
        startTs: String(Math.floor(args.startTs)),
        endTs: String(Math.floor(args.endTs)),
    });
    if (args.seriesId) params.set("seriesId", args.seriesId);

    const response = await fetch(`${getBaseUrl()}/api/second-market/clob-quotes?${params.toString()}`, { method: "GET" });
    const payload = await response.json().catch(() => ({})) as SecondMarketClobQuotesResponse | SecondMarketApiError;
    return assertOk(response, payload, "/api/second-market/clob-quotes").quotes;
}
