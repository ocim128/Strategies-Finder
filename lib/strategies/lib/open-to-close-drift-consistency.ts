import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function bodyDirection(bar: OHLCVData): number {
    if (bar.close > bar.open) return 1;
    if (bar.close < bar.open) return -1;
    return 0;
}

export const open_to_close_drift_consistency: Strategy = {
    name: "Open-to-Close Drift Consistency",
    description: "Tracks directional body agreement across bars and trades when consistency remains persistent.",
    defaultParams: {
        lookback: 5,
        threshold: 0.65,
    },
    paramLabels: {
        lookback: "Score Window (bars)",
        threshold: "Persistence Threshold",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 5));
        const threshold = clamp(params.threshold ?? 0.65, 0, 1);

        const direction: number[] = cleanData.map(bodyDirection);
        const barScore: number[] = new Array(cleanData.length).fill(0);

        for (let i = 1; i < cleanData.length; i++) {
            if (direction[i] === 0 || direction[i - 1] === 0) {
                barScore[i] = 0;
                continue;
            }
            barScore[i] = direction[i] === direction[i - 1] ? 1 : -1;
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
            if (score <= threshold) return null;

            if (direction[i] > 0) {
                return createBuySignal(cleanData, i, "Drift consistency bullish");
            }
            if (direction[i] < 0) {
                return createSellSignal(cleanData, i, "Drift consistency bearish");
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
