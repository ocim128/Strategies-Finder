import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawExtremeRank = Number(params.extremeRank ?? 90);

    return {
        ...params,
        rankLookback: Math.max(5, Math.round(params.rankLookback ?? 20)),
        extremeRank: Math.max(70, Math.min(99, Number.isFinite(rawExtremeRank) ? rawExtremeRank : 90)) };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    clvPercentileRank: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        clvPercentileRank: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const close_location_percentile_fade: Strategy = {
    name: "Close Location Percentile Fade",
    description: "Close Location Value (where close sits within the bar's high-low range) directly measures intrabar buying or selling pressure. When CLV's rolling percentile rank reaches an extreme, the market has been under sustained one-sided pressure.",
    defaultParams: {
        rankLookback: 20,
        extremeRank: 90 },
    paramLabels: {
        rankLookback: "Rank Lookback",
        extremeRank: "Extreme Rank" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const rankLookback = Math.max(5, Math.round(params.rankLookback ?? 20));
        const extremeRank = Number(params.extremeRank ?? 90);

        if (cleanData.length < rankLookback + 2) return [];

        // Calculate CLV series
        let clvSeries: number[] = [];
        // Get CLV percentile rank
        let clvPercentileRank = prepared.clvPercentileRank;
        if (clvPercentileRank.length === 0) {
            clvSeries = buildCloseLocationSeries(cleanData);
            // Convert 0-1 to 0-100 scale
            const ranks = buildPercentileRank(clvSeries, rankLookback);
            clvPercentileRank = normalizeSeries(ranks).map(v => v * 100);
            prepared.clvPercentileRank = clvPercentileRank;
        }

        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < rankLookback + 1) return null;

            const currentRank = clvPercentileRank[i];
            const prevRank = clvPercentileRank[i - 1];
            const currentClose = closes[i];
            const prevClose = closes[i - 1];

            if (currentRank === null || prevRank === null || currentClose === null || prevClose === null) return null;

            const lowerThreshold = 100 - extremeRank;

            // Buy: Rank was at extreme low and crosses back above (emerging from extreme low-close-location oversold)
            if (prevRank <= lowerThreshold && currentRank > lowerThreshold && currentClose > prevClose) {
                return createBuySignal(cleanData, i, "Close Location Percentile Fade Long");
            }

            // Sell: Rank was at extreme high and crosses back below (emerging from extreme high-close-location overbought)
            if (prevRank >= extremeRank && currentRank < extremeRank && currentClose < prevClose) {
                return createSellSignal(cleanData, i, "Close Location Percentile Fade Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        close_location_percentile_fade.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rankLookback", "extremeRank"] } };
