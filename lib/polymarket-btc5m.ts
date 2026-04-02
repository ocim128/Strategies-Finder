import type { OHLCVData } from "./strategies";
import { loadPolymarketOutcomes } from "./local-sqlite-polymarket-api";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";

// Deduplicate only concurrent identical requests.
// Persisting time-based rows across sequential calls can serve stale checkpoint
// prices after a sync updates the local SQLite data.
const pendingOutcomeRequests = new Map<string, Promise<PolymarketOutcomeRow[]>>();

export const POLYMARKET_5M_SERIES_BY_SYMBOL = {
    BTCUSDT: "10684",
    ETHUSDT: "10683",
    SOLUSDT: "10686",
    XRPUSDT: "10685",
} as const;

export type SupportedPolymarket5mSymbol = keyof typeof POLYMARKET_5M_SERIES_BY_SYMBOL;
export const SUPPORTED_POLYMARKET_5M_SYMBOLS = Object.keys(POLYMARKET_5M_SERIES_BY_SYMBOL) as SupportedPolymarket5mSymbol[];

export const BTC_5M_POLYMARKET_SERIES_ID = POLYMARKET_5M_SERIES_BY_SYMBOL.BTCUSDT;

export function getSupportedPolymarket5mSymbolsLabel(): string {
    return SUPPORTED_POLYMARKET_5M_SYMBOLS.join(", ");
}

export function normalizeSupportedPolymarket5mSymbol(symbol: string): SupportedPolymarket5mSymbol | null {
    const normalized = symbol.trim().toUpperCase();
    return normalized in POLYMARKET_5M_SERIES_BY_SYMBOL
        ? normalized as SupportedPolymarket5mSymbol
        : null;
}

export function getPolymarket5mSeriesIdForSymbol(symbol: string): string | null {
    const normalizedSymbol = normalizeSupportedPolymarket5mSymbol(symbol);
    return normalizedSymbol ? POLYMARKET_5M_SERIES_BY_SYMBOL[normalizedSymbol] : null;
}

export function isSupportedPolymarket5mRun(symbol: string, interval: string): boolean {
    return interval === "5m" && getPolymarket5mSeriesIdForSymbol(symbol) !== null;
}

export function supportsPolymarketOutcomeBridgeRun(symbol: string, interval: string): boolean {
    return (interval === "5m" || interval === "1m") && getPolymarket5mSeriesIdForSymbol(symbol) !== null;
}

/**
 * Check if a symbol/interval combination is supported for Polymarket multi-interval backtesting.
 * Supports 1m, 5m, 15m, 1h, 4h intervals using the same 5m SQLite outcome data.
 */
export function isSupportedPolymarketMultiIntervalRun(
    symbol: string,
    interval: string
): boolean {
    const supportedIntervals: string[] = ["1m", "5m", "15m", "1h", "4h"];
    return supportedIntervals.includes(interval) && getPolymarket5mSeriesIdForSymbol(symbol) !== null;
}

export async function loadPolymarket5mOutcomesForChart(
    symbol: string,
    chartData: OHLCVData[]
): Promise<PolymarketOutcomeRow[]> {
    if (chartData.length < 2) return [];

    const seriesId = getPolymarket5mSeriesIdForSymbol(symbol);
    if (!seriesId) {
        return [];
    }

    const firstTs = parseTimeToUnixSeconds(chartData[0].time);
    const lastTs = parseTimeToUnixSeconds(chartData[chartData.length - 1].time);
    if (firstTs === null || lastTs === null) return [];

    return loadPolymarketOutcomesForExpandedRange(seriesId, firstTs - 300, lastTs + 600);
}

export async function loadPolymarket5mOutcomesForTimeRange(
    symbol: string,
    startTs: number,
    endTs: number
): Promise<PolymarketOutcomeRow[]> {
    const seriesId = getPolymarket5mSeriesIdForSymbol(symbol);
    if (!seriesId) {
        return [];
    }

    // Expand the time range slightly to provide buffer
    const expandedStartTs = startTs - 300;
    const expandedEndTs = endTs + 600;

    return loadPolymarketOutcomesForExpandedRange(seriesId, expandedStartTs, expandedEndTs);
}

function buildOutcomeRequestKey(seriesId: string, startTs: number, endTs: number): string {
    return `${seriesId}:${startTs}:${endTs}`;
}

async function loadPolymarketOutcomesForExpandedRange(
    seriesId: string,
    startTs: number,
    endTs: number
): Promise<PolymarketOutcomeRow[]> {
    const requestKey = buildOutcomeRequestKey(seriesId, startTs, endTs);
    const pending = pendingOutcomeRequests.get(requestKey);
    if (pending) {
        return await pending;
    }

    const request = loadPolymarketOutcomes({
        seriesId,
        startTs,
        endTs,
    });
    pendingOutcomeRequests.set(requestKey, request);

    try {
        return await request;
    } finally {
        pendingOutcomeRequests.delete(requestKey);
    }
}
