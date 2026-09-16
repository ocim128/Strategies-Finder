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
        pinch_max: Math.max(0.005, Number(params.pinch_max ?? 0.04)),
    };
}

export const variance_ratio_scale_invariant_lock: Strategy = {
    name: "Variance Ratio Scale Invariant Lock",
    description: "Enters scale-invariant superdiffusive trends when the absolute difference between 2-bar and 8-bar variance ratios collapses to near zero with both ratios > 1.15.",
    defaultParams: {
        pinch_max: 0.04,
    },
    paramLabels: {
        pinch_max: "Maximum VR Difference",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const pinchMax = Number(params.pinch_max);
        const closes = getCloses(cleanData);

        const vr2 = buildVarianceRatio(closes, 30, 2);
        const vr8 = buildVarianceRatio(closes, 30, 8);

        return createSignalLoop(cleanData, [vr2, vr8], (i) => {
            if (i < 8) return null;
            const v2 = vr2[i];
            const v8 = vr8[i];
            if (v2 === null || v8 === null) return null;

            if (Math.abs(v8 - v2) <= pinchMax && v2 >= 1.15) {
                if (closes[i] > closes[i - 8]) {
                    return createBuySignal(cleanData, i, `Bullish scale-invariant lock: |VR8-VR2|=${Math.abs(v8 - v2).toFixed(3)}<=${pinchMax}, close>close[i-8]`);
                }
                if (closes[i] < closes[i - 8]) {
                    return createSellSignal(cleanData, i, `Bearish scale-invariant lock: |VR8-VR2|=${Math.abs(v8 - v2).toFixed(3)}<=${pinchMax}, close<close[i-8]`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["pinch_max"],
    },
};
