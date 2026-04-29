import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeExtremeZscoreTailFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        z_threshold: Math.max(0.1, Math.abs(Number(params.z_threshold ?? 2.5))),
    };
}

export const extreme_zscore_tail_fade: Strategy = {
    name: "Extreme Z-Score Tail Fade",
    description:
        "Fades extreme rolling close-price z-scores on the assumption that statistical tails snap back toward their trailing mean.",
    defaultParams: {
        lookback: 63,
        z_threshold: 2.5,
    },
    paramLabels: {
        lookback: "Lookback",
        z_threshold: "Z Threshold",
    },
    normalizeParams: normalizeExtremeZscoreTailFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeExtremeZscoreTailFadeParams(params);
        const lookback = p.lookback as number;
        const threshold = p.z_threshold as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [zscore], (i) => {
            const z = zscore[i];
            if (z === null) return null;

            if (z < -threshold) {
                return createBuySignal(cleanData, i, `Close z-score ${z.toFixed(2)} < -${threshold}`);
            }
            if (z > threshold) {
                return createSellSignal(cleanData, i, `Close z-score ${z.toFixed(2)} > ${threshold}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "z_threshold"],
    },
};
