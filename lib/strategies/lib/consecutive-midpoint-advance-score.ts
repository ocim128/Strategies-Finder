import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export const consecutive_midpoint_advance_score: Strategy = {
    name: "Consecutive Midpoint Advance Score",
    description: "Tracks persistence of bar midpoint progression to capture directional center-of-gravity drift.",
    defaultParams: {
        lookback: 6,
        threshold: 0.65,
    },
    paramLabels: {
        lookback: "Score Window (bars)",
        threshold: "Persistence Threshold",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 6));
        const threshold = clamp(params.threshold ?? 0.65, 0, 1);

        const midpoint = cleanData.map((bar) => (bar.high + bar.low) / 2);
        const barScore: number[] = new Array(cleanData.length).fill(0);

        for (let i = 1; i < cleanData.length; i++) {
            if (midpoint[i] > midpoint[i - 1]) {
                barScore[i] = 1;
            } else if (midpoint[i] < midpoint[i - 1]) {
                barScore[i] = -1;
            }
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
                return createBuySignal(cleanData, i, "Midpoint advance persistence bullish");
            }
            if (score < -threshold) {
                return createSellSignal(cleanData, i, "Midpoint advance persistence bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
