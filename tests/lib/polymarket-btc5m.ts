import type { OHLCVData } from "./strategies";
import { loadPolymarketOutcomes } from "./local-sqlite-polymarket-api";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";

// In-memory cache for Polymarket outcomes to avoid redundant SQLite fetches
// Key: seriesId, Value: { outcomes, fetchedAt, startTs, endTs }
type OutcomeCacheEntry = {
    outcomes: PolymarketOutcomeRow[];
    fetchedAt: number;
    startTs: number;
    endTs: number;
};
const outcomeCache = new Map<string, OutcomeCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

    return loadPolymarketOutcomes({
        seriesId,
        startTs: firstTs - 300,
        endTs: lastTs + 600,
    });
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

    // Check cache first
    const cached = outcomeCache.get(seriesId);
    const now = Date.now();
    if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
        // Check if cached range covers the requested range
        if (cached.startTs <= expandedStartTs && cached.endTs >= expandedEndTs) {
            return cached.outcomes;
        }
    }

    // Fetch from SQLite
    const outcomes = await loadPolymarketOutcomes({
        seriesId,
        startTs: expandedStartTs,
        endTs: expandedEndTs,
    });

    // Update cache
    outcomeCache.set(seriesId, {
        outcomes,
        fetchedAt: now,
        startTs: expandedStartTs,
        endTs: expandedEndTs,
    });

    return outcomes;
}
