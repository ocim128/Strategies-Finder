import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function buildReturns(series: number[]): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = 1; i < series.length; i++) {
        const prior = series[i - 1];
        res[i] = prior !== 0 ? (series[i] - prior) / prior : 0;
    }
    return res;
}

type EntropyRatioPrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    returns: number[];
    positivePrefix: number[];
    negativePrefix: number[];
    entropyByWindow: Map<number, number[]>;
    medianByWindow: Map<number, number[]>;
};

function buildSignPrefix(series: number[]): { positivePrefix: number[]; negativePrefix: number[] } {
    const positivePrefix = new Array(series.length + 1).fill(0);
    const negativePrefix = new Array(series.length + 1).fill(0);
    for (let i = 0; i < series.length; i++) {
        positivePrefix[i + 1] = positivePrefix[i] + (series[i] > 0 ? 1 : 0);
        negativePrefix[i + 1] = negativePrefix[i] + (series[i] < 0 ? 1 : 0);
    }
    return { positivePrefix, negativePrefix };
}

function buildRollingDirectionalEntropy(
    positivePrefix: number[],
    negativePrefix: number[],
    length: number,
    window: number
): number[] {
    const result = new Array(length).fill(0);
    for (let i = window; i < length; i++) {
        const start = i - window + 1;
        const end = i + 1;
        const positive = positivePrefix[end] - positivePrefix[start];
        const negative = negativePrefix[end] - negativePrefix[start];
        const total = positive + negative;
        if (total === 0) {
            result[i] = 0;
            continue;
        }

        const p1 = positive / total;
        const p2 = negative / total;
        let entropy = 0;
        if (p1 > 0) entropy -= p1 * Math.log2(p1);
        if (p2 > 0) entropy -= p2 * Math.log2(p2);
        result[i] = entropy;
    }
    return result;
}

function normalizeSeries(series: (number | null)[]): number[] {
    return series.map((value) => value ?? 0);
}

function prepareEntropyRatioData(data: OHLCVData[]): EntropyRatioPrepared {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const returns = buildReturns(closes);
    const { positivePrefix, negativePrefix } = buildSignPrefix(returns);
    return {
        cleanData,
        closes,
        returns,
        positivePrefix,
        negativePrefix,
        entropyByWindow: new Map<number, number[]>(),
        medianByWindow: new Map<number, number[]>(),
    };
}

function getPreparedEntropyRatioData(preparedData: unknown, data: OHLCVData[]): EntropyRatioPrepared {
    if (preparedData && typeof preparedData === "object" && "entropyByWindow" in preparedData) {
        return preparedData as EntropyRatioPrepared;
    }
    return prepareEntropyRatioData(data);
}

function normalizeEntropyRatioParams(params: StrategyParams): StrategyParams {
    const fastWindow = Math.max(2, Math.round(params.fastWindow ?? 10));
    const rawSlowWindow = Number(params.slowWindow ?? 30);
    const slowWindow = Math.max(fastWindow + 1, Math.round(Number.isFinite(rawSlowWindow) ? rawSlowWindow : 30));
    const rawRatioThreshold = Number(params.ratioThreshold ?? 0.78);
    const ratioThreshold = Number.isFinite(rawRatioThreshold) ? rawRatioThreshold : 0.78;

    return {
        ...params,
        fastWindow,
        slowWindow,
        ratioThreshold,
    };
}

export const entropy_ratio_regime_alignment: Strategy = {
    name: "Entropy Ratio Regime Alignment",
    description: "Trendable regimes begin when short-horizon return disorder collapses relative to the longer horizon. Enters when ratio compresses and price aligns with its rolling median.",
    defaultParams: {
        fastWindow: 10,
        slowWindow: 30,
        ratioThreshold: 0.78,
    },
    paramLabels: {
        fastWindow: "Fast Entropy Window",
        slowWindow: "Slow Entropy & Median Window",
        ratioThreshold: "Entropy Ratio Threshold",
    },
    normalizeParams: normalizeEntropyRatioParams,
    prepareFinderData: (data) => prepareEntropyRatioData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedEntropyRatioData(preparedData, data);
        const { cleanData, closes, positivePrefix, negativePrefix, entropyByWindow, medianByWindow } = prepared;
        const normalizedParams = normalizeEntropyRatioParams(params);
        const fastWindow = normalizedParams.fastWindow;
        const slowWindow = normalizedParams.slowWindow;
        const ratioThreshold = normalizedParams.ratioThreshold;

        const maxLookback = Math.max(fastWindow, slowWindow);
        if (cleanData.length < maxLookback + 2) return [];

        let fastEntropy = entropyByWindow.get(fastWindow);
        if (!fastEntropy) {
            fastEntropy = buildRollingDirectionalEntropy(positivePrefix, negativePrefix, closes.length, fastWindow);
            entropyByWindow.set(fastWindow, fastEntropy);
        }
        let slowEntropy = entropyByWindow.get(slowWindow);
        if (!slowEntropy) {
            slowEntropy = buildRollingDirectionalEntropy(positivePrefix, negativePrefix, closes.length, slowWindow);
            entropyByWindow.set(slowWindow, slowEntropy);
        }
        let medians = medianByWindow.get(slowWindow);
        if (!medians) {
            medians = normalizeSeries(buildRollingMedian(closes, slowWindow));
            medianByWindow.set(slowWindow, medians);
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (i < maxLookback) return null;
            
            const ratio = slowEntropy[i] > 0 ? fastEntropy[i] / slowEntropy[i] : 1;
            
            if (ratio <= ratioThreshold) {
                if (closes[i] > medians[i]) {
                    return createBuySignal(cleanData, i, "Entropy Ratio Align Long");
                }
                if (closes[i] < medians[i]) {
                    return createSellSignal(cleanData, i, "Entropy Ratio Align Short");
                }
            }
            
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        entropy_ratio_regime_alignment.executePrepared?.(prepareEntropyRatioData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastWindow", "slowWindow", "ratioThreshold"],
    },
};
