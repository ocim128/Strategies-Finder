import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export const close_position_momentum_score: Strategy = {
    name: "Close Position Momentum Score",
    description: "Uses rolling close-in-range positioning to detect persistent directional momentum pressure.",
    defaultParams: {
        lookback: 5,
        upperZone: 0.72,
        lowerZone: 0.28,
    },
    paramLabels: {
        lookback: "Score Window (bars)",
        upperZone: "Upper Trigger Zone",
        lowerZone: "Lower Trigger Zone",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 3) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 5));
        const upperZone = clamp(params.upperZone ?? 0.72, 0.5, 1);
        const lowerZone = clamp(params.lowerZone ?? 0.28, 0, 0.5);
        const effectiveUpper = Math.max(upperZone, lowerZone);
        const effectiveLower = Math.min(lowerZone, upperZone);

        const closePos: number[] = new Array(cleanData.length).fill(0.5);
        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const range = bar.high - bar.low;
            if (range <= 0) continue;
            closePos[i] = clamp((bar.close - bar.low) / range, 0, 1);
        }

        const avgClosePos: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = lookback - 1; i < cleanData.length; i++) {
            let sum = 0;
            for (let j = i - lookback + 1; j <= i; j++) {
                sum += closePos[j];
            }
            avgClosePos[i] = sum / lookback;
        }

        return createSignalLoop(cleanData, [avgClosePos], (i) => {
            const value = avgClosePos[i] as number;
            if (value > effectiveUpper) {
                return createBuySignal(cleanData, i, "Close position momentum bullish");
            }
            if (value < effectiveLower) {
                return createSellSignal(cleanData, i, "Close position momentum bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "upperZone", "lowerZone"],
    },
};
