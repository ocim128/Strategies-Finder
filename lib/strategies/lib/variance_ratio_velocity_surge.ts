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
        velocity_threshold: Math.max(0.001, Number(params.velocity_threshold ?? 0.25)),
    };
}

export const variance_ratio_velocity_surge: Strategy = {
    name: "Variance Ratio Velocity Surge",
    description: "Enters momentum expansion upon an abrupt 1-bar positive jump in variance ratio (delta VR >= threshold).",
    defaultParams: {
        velocity_threshold: 0.25,
    },
    paramLabels: {
        velocity_threshold: "Velocity Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const threshold = p.velocity_threshold as number;
        if (cleanData.length < 28) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, 24, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 1) return null;
            const currentVr = vr[i];
            const prevVr = vr[i - 1];
            if (currentVr === null || prevVr === null) return null;

            const deltaVr = currentVr - prevVr;
            if (deltaVr >= threshold) {
                if (closes[i] > closes[i - 1]) {
                    return createBuySignal(cleanData, i, `Bullish VR velocity surge: delta VR ${deltaVr.toFixed(3)} >= ${threshold}, bull close`);
                }
                if (closes[i] < closes[i - 1]) {
                    return createSellSignal(cleanData, i, `Bearish VR velocity surge: delta VR ${deltaVr.toFixed(3)} >= ${threshold}, bear close`);
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
