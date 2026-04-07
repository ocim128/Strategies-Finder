import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingCorrelation, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawVolPercentile = Number(params.volPercentile ?? 0.05);
    const rawNegativeCorrLimit = Number(params.negativeCorrLimit ?? -0.6);

    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 55)),
        volPercentile: Math.max(0, Math.min(1, Number.isFinite(rawVolPercentile) ? rawVolPercentile : 0.05)),
        negativeCorrLimit: Number.isFinite(rawNegativeCorrLimit) ? rawNegativeCorrLimit : -0.6 };
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    closes: number[];
    volumes: number[];
    correlation: number[];
    volumePercentileRank: number[];
    closeLocation: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    return {
        cleanData,
        closes,
        volumes,
        correlation: [],
        volumePercentileRank: [],
        closeLocation: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const synthetic_liquidity_vacuum: Strategy = {
    name: "Synthetic Liquidity Vacuum",
    description: "Fades structural breakouts when they occur in a complete liquidity vacuum (bottom 1% volume) while negatively correlated to price, identifying pure algorithmic ghost-prints.",
    defaultParams: {
        lookback: 55,
        volPercentile: 0.05,
        negativeCorrLimit: -0.6 },
    paramLabels: {
        lookback: "Window",
        volPercentile: "Volume Percentile",
        negativeCorrLimit: "Negative Corr Limit" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData, closes, volumes } = prepared;

        const lookback = Math.max(3, Math.round(params.lookback ?? 55));
        const volPercentile = Number(params.volPercentile ?? 0.05);
        const negativeCorrLimit = Number(params.negativeCorrLimit ?? -0.6);

        if (cleanData.length < lookback + 2) return [];

        // Calculate rolling correlation between closes and volumes
        let correlation = prepared.correlation;
        if (correlation.length === 0) {
            correlation = normalizeSeries(buildRollingCorrelation(closes, volumes, lookback));
            prepared.correlation = correlation;
        }

        // Calculate percentile rank of volume
        let volumePercentileRank = prepared.volumePercentileRank;
        if (volumePercentileRank.length === 0) {
            volumePercentileRank = normalizeSeries(buildPercentileRank(volumes, lookback));
            prepared.volumePercentileRank = volumePercentileRank;
        }

        // Get close location - compute manually since not in BarMetricType
        let closeLocation = prepared.closeLocation;
        if (closeLocation.length === 0) {
            closeLocation = cleanData.map(bar => {
                const range = bar.high - bar.low;
                if (range <= 0) return 0.5;
                return (bar.close - bar.low) / range;
            });
            prepared.closeLocation = closeLocation;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;

            const volRank = volumePercentileRank[i];
            const corr = correlation[i];
            const cLoc = closeLocation[i];

            if (volRank === null || corr === null || cLoc === null) return null;

            if (volRank < volPercentile && corr < negativeCorrLimit) {
                if (cLoc > 0.8) {
                    return createBuySignal(cleanData, i, "Synthetic Liquidity Vacuum Long");
                }
                if (cLoc < 0.2) {
                    return createSellSignal(cleanData, i, "Synthetic Liquidity Vacuum Short");
                }
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        synthetic_liquidity_vacuum.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentile", "negativeCorrLimit"] } };
