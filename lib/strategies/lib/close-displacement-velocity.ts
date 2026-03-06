import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export const close_displacement_velocity: Strategy = {
    name: "Close Displacement Velocity",
    description: "Tracks normalized close-to-close displacement velocity over a rolling window.",
    defaultParams: {
        lookback: 5,
        threshold: 0.5,
        minRange: 0,
    },
    paramLabels: {
        lookback: "Velocity Window (bars)",
        threshold: "Velocity Threshold",
        minRange: "Min Bar Range",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 4) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 5));
        const threshold = clamp(params.threshold ?? 0.5, 0, 1);
        const minRange = Math.max(0, params.minRange ?? 0);

        const velocity: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const range = cleanData[i].high - cleanData[i].low;
            if (range <= 0 || range < minRange) continue;

            const displacement = cleanData[i].close - cleanData[i - 1].close;
            velocity[i] = clamp(displacement / range, -1, 1);
        }

        const avgVelocity: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = lookback - 1; i < cleanData.length; i++) {
            let sum = 0;
            for (let j = i - lookback + 1; j <= i; j++) {
                sum += velocity[j];
            }
            avgVelocity[i] = sum / lookback;
        }

        return createSignalLoop(cleanData, [avgVelocity], (i) => {
            const value = avgVelocity[i] as number;
            if (value > threshold) {
                return createBuySignal(cleanData, i, "Close displacement velocity bullish");
            }
            if (value < -threshold) {
                return createSellSignal(cleanData, i, "Close displacement velocity bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold", "minRange"],
    },
};
