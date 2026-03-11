import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";

function buildReturns(series: number[]): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = 1; i < series.length; i++) {
        const prior = series[i - 1];
        res[i] = prior !== 0 ? (series[i] - prior) / prior : 0;
    }
    return res;
}

function buildRollingEntropy(series: number[], window: number): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = window; i < series.length; i++) {
        let positive = 0;
        let negative = 0;
        for (let j = 0; j < window; j++) {
            if (series[i - j] > 0) positive++;
            else if (series[i - j] < 0) negative++;
        }
        const totalParams = positive + negative;
        if (totalParams === 0) {
            res[i] = 0;
            continue;
        }
        const p1 = positive / totalParams;
        const p2 = negative / totalParams;
        
        let entropy = 0;
        if (p1 > 0) entropy -= p1 * Math.log2(p1);
        if (p2 > 0) entropy -= p2 * Math.log2(p2);
        
        res[i] = entropy;
    }
    return res;
}

function buildRollingMedian(series: number[], window: number): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = window - 1; i < series.length; i++) {
        const slice = series.slice(i - window + 1, i + 1).sort((a, b) => a - b);
        res[i] = slice[Math.floor(window / 2)];
    }
    return res;
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
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const closes = getCloses(cleanData);
        
        const fastWindow = params.fastWindow as number;
        const slowWindow = params.slowWindow as number;
        const ratioThreshold = params.ratioThreshold as number;

        const maxLookback = Math.max(fastWindow, slowWindow);
        if (cleanData.length < maxLookback + 2) return [];

        const returns = buildReturns(closes);
        const fastEntropy = buildRollingEntropy(returns, fastWindow);
        const slowEntropy = buildRollingEntropy(returns, slowWindow);
        const medians = buildRollingMedian(closes, slowWindow);

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
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastWindow", "slowWindow", "ratioThreshold"],
    },
};
