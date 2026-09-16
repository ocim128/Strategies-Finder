import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildVarianceRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        accel_threshold: Math.max(0.01, Number(params.accel_threshold ?? 0.15)),
    };
}

export const variance_ratio_convexity_acceleration: Strategy = {
    name: "Variance Ratio Convexity Acceleration",
    description: "Captures trend acceleration when the second derivative (change in velocity) of the Variance Ratio turns strongly positive.",
    defaultParams: {
        accel_threshold: 0.15,
    },
    paramLabels: {
        accel_threshold: "Acceleration Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const accel_threshold = p.accel_threshold as number;
        if (cleanData.length < 24 + 4 + 2) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, 24, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 2) return null;
            const v0 = vr[i];
            const v1 = vr[i - 1];
            const v2 = vr[i - 2];
            if (v0 === null || v1 === null || v2 === null) return null;

            const convexity = (v0 - v1) - (v1 - v2);
            if (convexity >= accel_threshold) {
                if (closes[i] > closes[i - 1]) {
                    return createBuySignal(cleanData, i, `Bullish VR convexity acceleration: 2nd deriv ${convexity.toFixed(3)} >= ${accel_threshold}, close > close[i-1]`);
                }
                if (closes[i] < closes[i - 1]) {
                    return createSellSignal(cleanData, i, `Bearish VR convexity acceleration: 2nd deriv ${convexity.toFixed(3)} >= ${accel_threshold}, close < close[i-1]`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["accel_threshold"],
    },
};
