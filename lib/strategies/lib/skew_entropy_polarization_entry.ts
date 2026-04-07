import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRollingMedian, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSkewEntropyPolarizationEntryParams(params: StrategyParams): StrategyParams {
    const rawEntropyCeiling = Number(params.entropyCeiling ?? 1);
    const rawSkewThreshold = Number(params.skewThreshold ?? 0.35);

    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 30)),
        entropyCeiling: Number.isFinite(rawEntropyCeiling) ? rawEntropyCeiling : 1,
        skewThreshold: Math.max(0, Math.abs(Number.isFinite(rawSkewThreshold) ? rawSkewThreshold : 0.35)) };
}

function buildReturns(series: number[]): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = 1; i < series.length; i++) {
        const prior = series[i - 1];
        res[i] = prior !== 0 ? (series[i] - prior) / prior : 0;
    }
    return res;
}

type SkewEntropyPrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    returns: number[];
    skewByLookback: Map<number, number[]>;
    entropyByLookback: Map<number, number[]>;
    medianByLookback: Map<number, number[]>;
};

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

function prepareSkewEntropyData(data: OHLCVData[]): SkewEntropyPrepared {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    return {
        cleanData,
        closes,
        returns: buildReturns(closes),
        skewByLookback: new Map<number, number[]>(),
        entropyByLookback: new Map<number, number[]>(),
        medianByLookback: new Map<number, number[]>() };
}

function getPreparedSkewEntropyData(preparedData: unknown, data: OHLCVData[]): SkewEntropyPrepared {
    if (preparedData && typeof preparedData === "object" && "skewByLookback" in preparedData) {
        return preparedData as SkewEntropyPrepared;
    }
    return prepareSkewEntropyData(data);
}

export const skew_entropy_polarization_entry: Strategy = {
    name: "Skew Entropy Polarization Entry",
    description: "A directional regime can appear in the shape of returns before simple trend filters react. This enters when returns are ordered and asymmetrically biased.",
    defaultParams: {
        lookback: 30,
        entropyCeiling: 1,
        skewThreshold: 0.35 },
    paramLabels: {
        lookback: "Regime Lookback",
        entropyCeiling: "Entropy Ceiling",
        skewThreshold: "Abs Skew Threshold" },
    normalizeParams: normalizeSkewEntropyPolarizationEntryParams,
    prepareFinderData: (data) => prepareSkewEntropyData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedSkewEntropyData(preparedData, data);
        const { cleanData, closes, returns, skewByLookback, entropyByLookback, medianByLookback } = prepared;

        const lookback = Math.max(3, Math.round(params.lookback ?? 30));
        const entropyCeiling = Number(params.entropyCeiling ?? 1);
        const skewThreshold = Number(params.skewThreshold ?? 0.35);

        if (cleanData.length < lookback + 2) return [];

        let skew = skewByLookback.get(lookback);
        if (!skew) {
            skew = normalizeSeries(buildRollingSkewness(returns, lookback));
            skewByLookback.set(lookback, skew);
        }
        let entropy = entropyByLookback.get(lookback);
        if (!entropy) {
            entropy = normalizeSeries(buildRollingEntropy(returns, lookback, 10));
            entropyByLookback.set(lookback, entropy);
        }
        let median = medianByLookback.get(lookback);
        if (!median) {
            median = normalizeSeries(buildRollingMedian(closes, lookback));
            medianByLookback.set(lookback, median);
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;
            
            if (entropy[i] <= entropyCeiling) {
                if (skew[i] > skewThreshold && closes[i] > median[i]) {
                    return createBuySignal(cleanData, i, "Skew Entropy Polar Long");
                }
                if (skew[i] < -skewThreshold && closes[i] < median[i]) {
                    return createSellSignal(cleanData, i, "Skew Entropy Polar Short");
                }
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        skew_entropy_polarization_entry.executePrepared?.(prepareSkewEntropyData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyCeiling", "skewThreshold"] } };
