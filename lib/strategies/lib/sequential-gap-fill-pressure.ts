import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export const sequential_gap_fill_pressure: Strategy = {
    name: "Sequential Gap Fill Pressure",
    description: "Rolls directional gap-fill and gap-extension events into a persistence score.",
    defaultParams: {
        lookback: 7,
        threshold: 0.57,
        gapPct: 0.1,
    },
    paramLabels: {
        lookback: "Score Window (bars)",
        threshold: "Persistence Threshold",
        gapPct: "Min Gap vs Prev Range",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 7));
        const threshold = clamp(params.threshold ?? 0.57, 0, 1);
        const gapPct = Math.max(0, params.gapPct ?? 0.1);

        const barScore: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const prev = cleanData[i - 1];
            const curr = cleanData[i];

            const prevRange = prev.high - prev.low;
            if (prevRange <= 0) continue;

            const gap = curr.open - prev.close;
            if (Math.abs(gap) < gapPct * prevRange) continue;

            if (curr.open > prev.close) {
                if (curr.close > curr.open) {
                    barScore[i] = 1;
                } else if (curr.close < prev.close) {
                    barScore[i] = -1;
                }
            } else if (curr.open < prev.close) {
                if (curr.close < curr.open) {
                    barScore[i] = -1;
                } else if (curr.close > prev.close) {
                    barScore[i] = 1;
                }
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
                return createBuySignal(cleanData, i, "Sequential gap pressure bullish");
            }
            if (score < -threshold) {
                return createSellSignal(cleanData, i, "Sequential gap pressure bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold", "gapPct"],
    },
};
