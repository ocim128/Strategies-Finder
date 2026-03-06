import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export const shadow_reversal_frequency_score: Strategy = {
    name: "Shadow Reversal Frequency Score",
    description: "Scores repeated wick-based rejection bars to capture persistent low-reject or high-reject behavior.",
    defaultParams: {
        lookback: 7,
        threshold: 0.45,
        shadowMult: 1.5,
    },
    paramLabels: {
        lookback: "Score Window (bars)",
        threshold: "Persistence Threshold",
        shadowMult: "Shadow/Body Mult",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 3) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 7));
        const threshold = clamp(params.threshold ?? 0.45, 0, 1);
        const shadowMult = Math.max(0, params.shadowMult ?? 1.5);

        const barScore: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const body = Math.abs(bar.close - bar.open);
            const upperWick = bar.high - Math.max(bar.open, bar.close);
            const lowerWick = Math.min(bar.open, bar.close) - bar.low;

            const bullishReject = lowerWick > shadowMult * body;
            const bearishReject = upperWick > shadowMult * body;

            if (bullishReject && !bearishReject) {
                barScore[i] = 1;
            } else if (bearishReject && !bullishReject) {
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
                return createBuySignal(cleanData, i, "Shadow rejection persistence bullish");
            }
            if (score < -threshold) {
                return createSellSignal(cleanData, i, "Shadow rejection persistence bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold", "shadowMult"],
    },
};
