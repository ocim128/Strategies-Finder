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

export const range_expansion_directional_bias: Strategy = {
    name: "Range Expansion Directional Bias",
    description: "Scores directional persistence only when bar range expands beyond a configurable multiple.",
    defaultParams: {
        lookback: 6,
        threshold: 0.6,
        expansionMult: 1.2,
    },
    paramLabels: {
        lookback: "Score Window (bars)",
        threshold: "Persistence Threshold",
        expansionMult: "Min Range Expansion Mult",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 6));
        const threshold = clamp(params.threshold ?? 0.6, 0, 1);
        const expansionMult = Math.max(1, params.expansionMult ?? 1.2);

        const barScore: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const currRange = cleanData[i].high - cleanData[i].low;
            const prevRange = cleanData[i - 1].high - cleanData[i - 1].low;
            if (prevRange <= 0 || currRange <= 0) continue;

            if (currRange > expansionMult * prevRange) {
                barScore[i] = bodyDirection(cleanData[i]);
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
                return createBuySignal(cleanData, i, "Range expansion bias bullish");
            }
            if (score < -threshold) {
                return createSellSignal(cleanData, i, "Range expansion bias bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold", "expansionMult"],
    },
};
