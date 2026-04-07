import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(params.lookback ?? 20)) };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    median: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        median: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const rolling_median_cross: Strategy = {
    name: "Rolling Median Cross",
    description: "The rolling median is a robust central tendency that is insensitive to outliers. When price crosses above its rolling median, the distribution center has shifted bullish.",
    defaultParams: {
        lookback: 20 },
    paramLabels: {
        lookback: "Lookback" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const lookback = Math.max(5, Math.round(params.lookback ?? 20));

        if (cleanData.length < lookback + 2) return [];

        // Calculate rolling median
        let median = prepared.median;
        if (median.length === 0) {
            const closes = getCloses(cleanData);
            median = normalizeSeries(buildRollingMedian(closes, lookback));
            prepared.median = median;
        }

        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;

            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentMedian = median[i];
            const prevMedian = median[i - 1];

            if (currentClose === null || prevClose === null || currentMedian === null || prevMedian === null) return null;

            // Buy: Close crosses above median
            if (prevClose < prevMedian && currentClose >= currentMedian) {
                return createBuySignal(cleanData, i, "Rolling Median Cross Long");
            }

            // Sell: Close crosses below median
            if (prevClose >= prevMedian && currentClose < currentMedian) {
                return createSellSignal(cleanData, i, "Rolling Median Cross Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        rolling_median_cross.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"] } };
