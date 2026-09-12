import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

const Z_SCORE_FADE = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const median_deviation_fade_chop: Strategy = {
    name: "Median Deviation Fade Chop",
    description: "Fades closes deviating more than 1.5 standard deviations from the rolling central value, catching chop-range edges that revert to center.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const zScore = buildRollingZScore(getCloses(cleanData), lookback);

        return createSignalLoop(cleanData, [zScore], (i) => {
            const z = zScore[i];
            if (z === null) return null;

            if (z < -Z_SCORE_FADE) {
                return createBuySignal(cleanData, i, `Close z-score ${z.toFixed(2)} oversold from center`);
            }
            if (z > Z_SCORE_FADE) {
                return createSellSignal(cleanData, i, `Close z-score ${z.toFixed(2)} overbought from center`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
