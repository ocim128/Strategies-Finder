import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildWindowGivebackRatio } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        velocity_threshold: Math.max(0.05, Number(params.velocity_threshold ?? 0.25)),
    };
}

export const window_giveback_abrupt_trend_fracture: Strategy = {
    name: "Window Giveback Abrupt Trend Fracture",
    description: "Enters trend fracture reversal when giveback ratio surges by at least velocity_threshold directly from near-zero giveback (<= 0.08).",
    defaultParams: {
        velocity_threshold: 0.25,
    },
    paramLabels: {
        velocity_threshold: "Giveback Surge Threshold",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const velocityThreshold = Number(params.velocity_threshold);
        const closes = getCloses(cleanData);

        const gb = buildWindowGivebackRatio(cleanData, 20);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < 20) return null;
            const g0 = gb[i];
            const g1 = gb[i - 1];
            if (g0 === null || g1 === null) return null;

            if (g1 <= 0.08 && (g0 - g1) >= velocityThreshold) {
                if (closes[i] < closes[i - 20]) {
                    return createBuySignal(cleanData, i, `Bullish abrupt trend fracture: giveback surge ${(g0 - g1).toFixed(2)} from ${g1.toFixed(2)} <= 0.08 reversing down-window`);
                }
                if (closes[i] >= closes[i - 20]) {
                    return createSellSignal(cleanData, i, `Bearish abrupt trend fracture: giveback surge ${(g0 - g1).toFixed(2)} from ${g1.toFixed(2)} <= 0.08 reversing up-window`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["velocity_threshold"],
    },
};
