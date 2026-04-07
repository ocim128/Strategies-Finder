import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingEntropy, buildRollingCorrelation, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    const rawEntropyPercentile = Number(params.entropyPercentile ?? 0.95);
    const rawCorrLimit = Number(params.corrLimit ?? 0.1);

    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 40)),
        entropyPercentile: Math.max(0, Math.min(1, Number.isFinite(rawEntropyPercentile) ? rawEntropyPercentile : 0.95)),
        corrLimit: Math.max(0, Math.abs(Number.isFinite(rawCorrLimit) ? rawCorrLimit : 0.1)) };
}

function buildReturns(series: number[]): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = 1; i < series.length; i++) {
        const prior = series[i - 1];
        res[i] = prior !== 0 ? (series[i] - prior) / prior : 0;
    }
    return res;
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

type PreparedData = {
    cleanData: OHLCVData[];
    closes: number[];
    volumes: number[];
    returns: number[];
    entropy: number[];
    correlation: number[];
    entropyPercentileRank: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    return {
        cleanData,
        closes,
        volumes,
        returns: buildReturns(closes),
        entropy: [],
        correlation: [],
        entropyPercentileRank: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const entropy_decorrelation_fade: Strategy = {
    name: "Entropy Decorrelation Fade",
    description: "Fades directional thrusts exclusively when phase-space disorder (Entropy) is at a historic maximum and price-volume correlation drops to absolute zero.",
    defaultParams: {
        lookback: 40,
        entropyPercentile: 0.95,
        corrLimit: 0.1 },
    paramLabels: {
        lookback: "Window",
        entropyPercentile: "Entropy Percentile",
        corrLimit: "Correlation Limit" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData, closes, volumes, returns } = prepared;

        const lookback = Math.max(3, Math.round(params.lookback ?? 40));
        const entropyPercentile = Number(params.entropyPercentile ?? 0.95);
        const corrLimit = Number(params.corrLimit ?? 0.1);

        if (cleanData.length < lookback + 2) return [];

        // Calculate entropy on returns
        let entropy = prepared.entropy;
        if (entropy.length === 0) {
            entropy = normalizeSeries(buildRollingEntropy(returns, lookback, 10));
            prepared.entropy = entropy;
        }

        // Calculate rolling correlation between closes and volumes
        let correlation = prepared.correlation;
        if (correlation.length === 0) {
            correlation = normalizeSeries(buildRollingCorrelation(closes, volumes, lookback));
            prepared.correlation = correlation;
        }

        // Calculate percentile rank of entropy
        let entropyPercentileRank = prepared.entropyPercentileRank;
        if (entropyPercentileRank.length === 0) {
            entropyPercentileRank = normalizeSeries(buildPercentileRank(entropy, lookback));
            prepared.entropyPercentileRank = entropyPercentileRank;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;

            const entropyRank = entropyPercentileRank[i];
            const absCorr = Math.abs(correlation[i]);
            const isBullishBar = cleanData[i].close < cleanData[i].open;
            const isBearishBar = cleanData[i].close > cleanData[i].open;

            if (entropyRank > entropyPercentile && absCorr < corrLimit) {
                if (isBullishBar) {
                    return createBuySignal(cleanData, i, "Entropy Decorrelation Long");
                }
                if (isBearishBar) {
                    return createSellSignal(cleanData, i, "Entropy Decorrelation Short");
                }
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        entropy_decorrelation_fade.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyPercentile", "corrLimit"] } };
