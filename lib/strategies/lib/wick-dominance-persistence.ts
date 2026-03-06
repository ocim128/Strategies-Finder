import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export const wick_dominance_persistence: Strategy = {
    name: "Wick Dominance Persistence",
    description: "Scores persistent lower-vs-upper wick dominance to capture absorption and distribution pressure.",
    defaultParams: {
        lookback: 6,
        threshold: 0.55,
        wickRatio: 0.15,
    },
    paramLabels: {
        lookback: "Score Window (bars)",
        threshold: "Persistence Threshold",
        wickRatio: "Min Wick/Range Ratio",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 3) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 6));
        const threshold = clamp(params.threshold ?? 0.55, 0, 1);
        const wickRatio = clamp(params.wickRatio ?? 0.15, 0, 1);

        const barScore: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const range = bar.high - bar.low;
            if (range <= 0) continue;

            const upperWick = bar.high - Math.max(bar.open, bar.close);
            const lowerWick = Math.min(bar.open, bar.close) - bar.low;
            if (Math.max(upperWick, lowerWick) / range < wickRatio) continue;

            barScore[i] = clamp((lowerWick - upperWick) / range, -1, 1);
        }

        const avgScore: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = lookback - 1; i < cleanData.length; i++) {
            let sum = 0;
            for (let j = i - lookback + 1; j <= i; j++) {
                sum += barScore[j];
            }
            avgScore[i] = sum / lookback;
        }

        return createSignalLoop(cleanData, [avgScore], (i) => {
            const score = avgScore[i] as number;
            if (score > threshold) {
                return createBuySignal(cleanData, i, "Wick dominance persistence bullish");
            }
            if (score < -threshold) {
                return createSellSignal(cleanData, i, "Wick dominance persistence bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold", "wickRatio"],
    },
};
