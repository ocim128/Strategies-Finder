import type { OHLCVData } from "./strategies";
import { loadPolymarketOutcomes } from "./local-sqlite-polymarket-api";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";

export const BTC_5M_POLYMARKET_SERIES_ID = "10684";

const SUPPORTED_BTC_SYMBOLS = new Set([
    "BTCUSDT",
]);

export function isSupportedPolymarketBtcSymbol(symbol: string): boolean {
    return SUPPORTED_BTC_SYMBOLS.has(symbol.trim().toUpperCase());
}

export function isSupportedPolymarketBtc5mRun(symbol: string, interval: string): boolean {
    return interval === "5m" && isSupportedPolymarketBtcSymbol(symbol);
}

export async function loadBtc5mPolymarketOutcomesForChart(chartData: OHLCVData[]): Promise<PolymarketOutcomeRow[]> {
    if (chartData.length < 2) return [];

    const firstTs = parseTimeToUnixSeconds(chartData[0].time);
    const lastTs = parseTimeToUnixSeconds(chartData[chartData.length - 1].time);
    if (firstTs === null || lastTs === null) return [];

    return loadPolymarketOutcomes({
        seriesId: BTC_5M_POLYMARKET_SERIES_ID,
        startTs: firstTs - 300,
        endTs: lastTs + 600,
    });
}

export async function loadBtc5mPolymarketOutcomesForTimeRange(
    startTs: number,
    endTs: number
): Promise<PolymarketOutcomeRow[]> {
    return loadPolymarketOutcomes({
        seriesId: BTC_5M_POLYMARKET_SERIES_ID,
        startTs: startTs - 300,
        endTs: endTs + 600,
    });
}
