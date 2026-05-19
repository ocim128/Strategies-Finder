import type { OHLCVData } from "./strategies";
import { loadPolymarketOutcomes } from "./local-sqlite-polymarket-api";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import {
    DEFAULT_POLYMARKET_OUTCOME_INTERVAL,
    getPolymarketOutcomeIntervalDurationSec,
    type PolymarketOutcomeInterval,
} from "./polymarket-outcome-interval";
import { getUnscopedBinanceStorageSymbol } from "./binance-market";

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

export const POLYMARKET_SERIES_BY_INTERVAL_AND_SYMBOL = {
    "5m": POLYMARKET_5M_SERIES_BY_SYMBOL,
    "15m": {
        BTCUSDT: "10192",
        ETHUSDT: "10191",
        SOLUSDT: "10423",
        XRPUSDT: "10422",
    },
    "1h": {
        BTCUSDT: "10114",
        ETHUSDT: "10117",
        SOLUSDT: "10122",
        XRPUSDT: "10123",
    },
} as const satisfies Record<PolymarketOutcomeInterval, Record<string, string>>;

export type SupportedPolymarketSymbol = keyof typeof POLYMARKET_SERIES_BY_INTERVAL_AND_SYMBOL["5m"];
export type SupportedPolymarket5mSymbol = SupportedPolymarketSymbol;
export const SUPPORTED_POLYMARKET_5M_SYMBOLS = Object.keys(POLYMARKET_5M_SERIES_BY_SYMBOL) as SupportedPolymarket5mSymbol[];
export const SUPPORTED_POLYMARKET_SYMBOLS = Object.keys(POLYMARKET_SERIES_BY_INTERVAL_AND_SYMBOL["5m"]) as SupportedPolymarketSymbol[];

export const BTC_5M_POLYMARKET_SERIES_ID = POLYMARKET_5M_SERIES_BY_SYMBOL.BTCUSDT;

export function getSupportedPolymarket5mSymbolsLabel(): string {
    return SUPPORTED_POLYMARKET_5M_SYMBOLS.join(", ");
}

export function normalizeSupportedPolymarket5mSymbol(symbol: string): SupportedPolymarket5mSymbol | null {
    const normalized = getUnscopedBinanceStorageSymbol(symbol);
    return normalized in POLYMARKET_SERIES_BY_INTERVAL_AND_SYMBOL["5m"]
        ? normalized as SupportedPolymarketSymbol
        : null;
}

export function resolvePolymarketOutcomeSymbol(
    chartSymbol: string,
    overrideSymbol?: string | null
): SupportedPolymarket5mSymbol | null {
    const normalizedOverride = typeof overrideSymbol === "string" ? overrideSymbol.trim().toUpperCase() : "";
    if (normalizedOverride.length > 0) {
        return normalizeSupportedPolymarket5mSymbol(normalizedOverride);
    }
    return normalizeSupportedPolymarket5mSymbol(chartSymbol);
}

export function getPolymarketSeriesIdForSymbol(
    symbol: string,
    outcomeInterval: PolymarketOutcomeInterval = DEFAULT_POLYMARKET_OUTCOME_INTERVAL
): string | null {
    const normalizedSymbol = normalizeSupportedPolymarket5mSymbol(symbol);
    if (!normalizedSymbol) {
        return null;
    }
    return POLYMARKET_SERIES_BY_INTERVAL_AND_SYMBOL[outcomeInterval][normalizedSymbol] ?? null;
}

export function getPolymarket5mSeriesIdForSymbol(symbol: string): string | null {
    return getPolymarketSeriesIdForSymbol(symbol, "5m");
}

export function getEffectivePolymarketSeriesId(
    chartSymbol: string,
    outcomeInterval: PolymarketOutcomeInterval = DEFAULT_POLYMARKET_OUTCOME_INTERVAL,
    overrideSymbol?: string | null
): string | null {
    const outcomeSymbol = resolvePolymarketOutcomeSymbol(chartSymbol, overrideSymbol);
    return outcomeSymbol ? POLYMARKET_SERIES_BY_INTERVAL_AND_SYMBOL[outcomeInterval][outcomeSymbol] : null;
}

export function getEffectivePolymarket5mSeriesId(
    chartSymbol: string,
    overrideSymbol?: string | null
): string | null {
    return getEffectivePolymarketSeriesId(chartSymbol, "5m", overrideSymbol);
}

export function isSupportedPolymarket5mRun(symbol: string, interval: string, outcomeSymbol?: string | null): boolean {
    return interval === "5m" && getEffectivePolymarket5mSeriesId(symbol, outcomeSymbol) !== null;
}

export function supportsPolymarketOutcomeBridgeRun(symbol: string, interval: string, outcomeSymbol?: string | null): boolean {
    return (interval === "5m" || interval === "1m") && getEffectivePolymarket5mSeriesId(symbol, outcomeSymbol) !== null;
}

export function isSupportedPolymarketOutcomeRun(
    symbol: string,
    interval: string,
    outcomeInterval: PolymarketOutcomeInterval = DEFAULT_POLYMARKET_OUTCOME_INTERVAL,
    outcomeSymbol?: string | null
): boolean {
    const supportedChartIntervals = ["1m", "5m", "15m", "1h", "4h"];
    return supportedChartIntervals.includes(interval)
        && getEffectivePolymarketSeriesId(symbol, outcomeInterval, outcomeSymbol) !== null;
}

/**
 * Check if a symbol/interval combination is supported for Polymarket multi-interval backtesting.
 * Supports 1m, 5m, 15m, 1h, 4h intervals using the same 5m SQLite outcome data.
 */
export function isSupportedPolymarketMultiIntervalRun(
    symbol: string,
    interval: string,
    outcomeSymbol?: string | null
): boolean {
    const supportedIntervals: string[] = ["1m", "5m", "15m", "1h", "4h"];
    return supportedIntervals.includes(interval) && getEffectivePolymarket5mSeriesId(symbol, outcomeSymbol) !== null;
}

export async function loadPolymarket5mOutcomesForChart(
    symbol: string,
    chartData: OHLCVData[],
    outcomeSymbol?: string | null
): Promise<PolymarketOutcomeRow[]> {
    return loadPolymarketOutcomesForChart(symbol, chartData, outcomeSymbol, "5m");
}

export async function loadPolymarketOutcomesForChart(
    symbol: string,
    chartData: OHLCVData[],
    outcomeSymbol?: string | null,
    outcomeInterval: PolymarketOutcomeInterval = DEFAULT_POLYMARKET_OUTCOME_INTERVAL
): Promise<PolymarketOutcomeRow[]> {
    if (chartData.length < 2) return [];

    const seriesId = getEffectivePolymarketSeriesId(symbol, outcomeInterval, outcomeSymbol);
    if (!seriesId) {
        return [];
    }

    const firstTs = parseTimeToUnixSeconds(chartData[0].time);
    const lastTs = parseTimeToUnixSeconds(chartData[chartData.length - 1].time);
    if (firstTs === null || lastTs === null) return [];

    const outcomeDurationSec = getPolymarketOutcomeIntervalDurationSec(outcomeInterval);
    return loadPolymarketOutcomesForExpandedRange(seriesId, firstTs - outcomeDurationSec, lastTs + (outcomeDurationSec * 2));
}

export async function loadPolymarket5mOutcomesForTimeRange(
    symbol: string,
    startTs: number,
    endTs: number,
    outcomeSymbol?: string | null
): Promise<PolymarketOutcomeRow[]> {
    return loadPolymarketOutcomesForTimeRange(symbol, startTs, endTs, outcomeSymbol, "5m");
}

export async function loadPolymarketOutcomesForTimeRange(
    symbol: string,
    startTs: number,
    endTs: number,
    outcomeSymbol?: string | null,
    outcomeInterval: PolymarketOutcomeInterval = DEFAULT_POLYMARKET_OUTCOME_INTERVAL
): Promise<PolymarketOutcomeRow[]> {
    const seriesId = getEffectivePolymarketSeriesId(symbol, outcomeInterval, outcomeSymbol);
    if (!seriesId) {
        return [];
    }

    // Expand the time range slightly to provide buffer
    const outcomeDurationSec = getPolymarketOutcomeIntervalDurationSec(outcomeInterval);
    const expandedStartTs = startTs - outcomeDurationSec;
    const expandedEndTs = endTs + (outcomeDurationSec * 2);

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
        limit: 100000, // Explicitly request max rows to prevent default 10k truncation on long charts
    });
    pendingOutcomeRequests.set(requestKey, request);

    try {
        return await request;
    } finally {
        pendingOutcomeRequests.delete(requestKey);
    }
}
