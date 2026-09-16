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
        divergence_threshold: Math.max(0.001, Number(params.divergence_threshold ?? 0.15)),
    };
}

export const variance_ratio_velocity_divergence_fade: Strategy = {
    name: "Variance Ratio Velocity Divergence Fade",
    description: "Fades price breakouts to new extremes when variance ratio velocity drops sharply, signaling a liquidity vacuum.",
    defaultParams: {
        divergence_threshold: 0.15,
    },
    paramLabels: {
        divergence_threshold: "Divergence Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const threshold = p.divergence_threshold as number;
        if (cleanData.length < 28) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, 24, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 1) return null;
            const currentVr = vr[i];
            const prevVr = vr[i - 1];
            if (currentVr === null || prevVr === null) return null;

            const deltaVr = currentVr - prevVr;
            if (deltaVr > -threshold) return null;

            if (cleanData[i].close < cleanData[i - 1].low) {
                return createBuySignal(cleanData, i, `Bullish VR velocity divergence fade: delta VR ${deltaVr.toFixed(4)} <= -${threshold}, close below prior low`);
            }
            if (cleanData[i].close > cleanData[i - 1].high) {
                return createSellSignal(cleanData, i, `Bearish VR velocity divergence fade: delta VR ${deltaVr.toFixed(4)} <= -${threshold}, close above prior high`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["divergence_threshold"],
    },
};
