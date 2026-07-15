import type { OHLCVData, Polymarket1sGammaContextRow } from "../types/strategies";
import type { PolymarketClob1sQuoteRow, SecondMarketSymbol } from "./types";
import { SECOND_MARKET_SYMBOLS } from "./types";
import { decodeBinaryOhlcvRows } from "../ohlcv-binary";
import { fetchLocalApi } from "../local-api-transport";
import { getUnscopedBinanceStorageSymbol } from "../binance-market";

const SECOND_MARKET_REQUEST_TIMEOUT_MS = 8000;

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
    stats?: SecondMarketClobQuoteStats;
};

type SecondMarketGammaSnapshotsResponse = {
    ok: true;
    gammaSnapshots: Polymarket1sGammaContextRow[];
};

type SecondMarketApiError = {
    ok?: false;
    error?: string;
};

// Browser `fetch` resolves relative URLs against `window.location` itself.
// Node's `fetch` does NOT — it throws `TypeError: Invalid URL` for a bare
// `/api/...` path. Returning "" here produces a relative URL that
// `fetchLocalApi`/`resolveLocalApiUrl` resolves against the bound server
// socket (recorded via `rememberLoopbackOriginFromRequest`), NOT a hardcoded
// `localhost:5173` that silently breaks whenever Vite picks another port
// (5174+) and ignores `VITE_DEV_SERVER_ORIGIN`.
const BASE_URL = "";

export function normalizeSecondMarketChartSymbol(symbol: string): SecondMarketSymbol | null {
    const normalized = getUnscopedBinanceStorageSymbol(symbol);
    return SECOND_MARKET_SYMBOL_SET.has(normalized)
        ? normalized as SecondMarketSymbol
        : null;
}

export function isSecondMarketChartContext(symbol: string, interval: string): boolean {
    return interval.trim().toLowerCase() === "1s" && normalizeSecondMarketChartSymbol(symbol) !== null;
}

export type SecondMarketClobQuoteStats = {
    distinctSeconds?: number;
    missingSeconds?: number;
    exactSampleCoveragePct?: number;
    limit?: number;
    truncated?: boolean;
};

export type SecondMarketClobQuotesResult = {
    quotes: PolymarketClob1sQuoteRow[];
    stats?: SecondMarketClobQuoteStats;
};

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

    const url = `${BASE_URL}/api/second-market/candles?${params.toString()}`;
    const parseJsonCandles = async (jsonResponse: Response): Promise<OHLCVData[]> => {
        const payload = await jsonResponse.json().catch(() => ({})) as SecondMarketCandlesResponse | SecondMarketApiError;
        const data = assertOk(jsonResponse, payload, "/api/second-market/candles");
        return data.candles.map((row) => ({
            time: row.ts as OHLCVData["time"],
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
        }));
    };

    const response = await fetchLocalApi(url, {
        method: "GET",
        headers: { Accept: "application/octet-stream" },
    }, SECOND_MARKET_REQUEST_TIMEOUT_MS);
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && contentType.includes("application/octet-stream")) {
        const candles = decodeBinaryOhlcvRows(await response.arrayBuffer());
        if (candles) return candles;
        return parseJsonCandles(await fetchLocalApi(url, {
            method: "GET",
            headers: { Accept: "application/json" },
        }, SECOND_MARKET_REQUEST_TIMEOUT_MS));
    }
    return parseJsonCandles(response);
}

export async function loadSecondMarketClobQuotesWithStats(args: {
    symbol: SecondMarketSymbol;
    startTs: number;
    endTs: number;
    seriesId?: string;
}): Promise<SecondMarketClobQuotesResult> {
    const params = new URLSearchParams({
        symbol: args.symbol,
        startTs: String(Math.floor(args.startTs)),
        endTs: String(Math.floor(args.endTs)),
    });
    if (args.seriesId) params.set("seriesId", args.seriesId);

    const response = await fetchLocalApi(`${BASE_URL}/api/second-market/clob-quotes?${params.toString()}`, {
        method: "GET",
    }, SECOND_MARKET_REQUEST_TIMEOUT_MS);
    const payload = await response.json().catch(() => ({})) as SecondMarketClobQuotesResponse | SecondMarketApiError;
    const data = assertOk(response, payload, "/api/second-market/clob-quotes");
    return {
        quotes: data.quotes,
        stats: data.stats,
    };
}

export async function loadSecondMarketClobQuotes(args: {
    symbol: SecondMarketSymbol;
    startTs: number;
    endTs: number;
    seriesId?: string;
}): Promise<PolymarketClob1sQuoteRow[]> {
    return (await loadSecondMarketClobQuotesWithStats(args)).quotes;
}

export async function loadSecondMarketGammaSnapshots(args: {
    symbol: SecondMarketSymbol;
    startTs: number;
    endTs: number;
    seriesId?: string;
}): Promise<Polymarket1sGammaContextRow[]> {
    const params = new URLSearchParams({
        symbol: args.symbol,
        startTs: String(Math.floor(args.startTs)),
        endTs: String(Math.floor(args.endTs)),
    });
    if (args.seriesId) params.set("seriesId", args.seriesId);

    const response = await fetchLocalApi(`${BASE_URL}/api/second-market/gamma-snapshots?${params.toString()}`, {
        method: "GET",
    }, SECOND_MARKET_REQUEST_TIMEOUT_MS);
    const payload = await response.json().catch(() => ({})) as SecondMarketGammaSnapshotsResponse | SecondMarketApiError;
    return assertOk(response, payload, "/api/second-market/gamma-snapshots").gammaSnapshots;
}
