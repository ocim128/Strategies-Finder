import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes, getCloses } from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawVolumeThreshold = Number(params.volumeThreshold ?? 85);

    return {
        ...params,
        volumeLookback: Math.max(5, Math.round(params.volumeLookback ?? 20)),
        volumeThreshold: Math.max(60, Math.min(99, Number.isFinite(rawVolumeThreshold) ? rawVolumeThreshold : 85)) };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    volumePercentileRank: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        volumePercentileRank: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const volume_percentile_momentum: Strategy = {
    name: "Volume Percentile Momentum",
    description: "When volume percentile rank is very high, participation is elevated relative to recent history. High volume confirms the current price move has institutional backing.",
    defaultParams: {
        volumeLookback: 20,
        volumeThreshold: 85 },
    paramLabels: {
        volumeLookback: "Volume Lookback",
        volumeThreshold: "Volume Threshold" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const volumeLookback = Math.max(5, Math.round(params.volumeLookback ?? 20));
        const volumeThreshold = Number(params.volumeThreshold ?? 85);

        if (cleanData.length < volumeLookback + 2) return [];

        // Calculate volume percentile rank
        let volumePercentileRank = prepared.volumePercentileRank;
        if (volumePercentileRank.length === 0) {
            const volumes = getVolumes(cleanData);
            // buildPercentileRank returns 0-1 scale, convert to 0-100
            const ranks = buildPercentileRank(volumes, volumeLookback);
            volumePercentileRank = normalizeSeries(ranks).map(v => v * 100);
            prepared.volumePercentileRank = volumePercentileRank;
        }

        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < volumeLookback + 1) return null;

            const volRank = volumePercentileRank[i];
            const currentClose = closes[i];
            const prevClose = closes[i - 1];

            if (volRank === null || currentClose === null || prevClose === null) return null;

            // Buy: Volume percentile above threshold AND close higher than previous
            if (volRank > volumeThreshold && currentClose > prevClose) {
                return createBuySignal(cleanData, i, "Volume Percentile Momentum Long");
            }

            // Sell: Volume percentile above threshold AND close lower than previous
            if (volRank > volumeThreshold && currentClose < prevClose) {
                return createSellSignal(cleanData, i, "Volume Percentile Momentum Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        volume_percentile_momentum.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volumeLookback", "volumeThreshold"] } };
