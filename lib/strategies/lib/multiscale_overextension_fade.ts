import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingRobustZScore } from "./price-action-statistics-core";

const SLOW_WINDOW_MULTIPLE = 4;
const FAST_FADE_DEPTH = 2;
const SLOW_FADE_DEPTH = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const multiscale_overextension_fade: Strategy = {
    name: "Multiscale Overextension Fade",
    description: "Fades robust z-score extremes only when the same dislocation is confirmed at a fixed 4x slower window.",
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
        const slowLookback = lookback * SLOW_WINDOW_MULTIPLE;
        if (cleanData.length < slowLookback) return [];

        const closes = getCloses(cleanData);
        const fastZ = buildRollingRobustZScore(closes, lookback);
        const slowZ = buildRollingRobustZScore(closes, slowLookback);

        return createSignalLoop(cleanData, [fastZ, slowZ], (i) => {
            const fast = fastZ[i];
            const slow = slowZ[i];
            if (fast === null || slow === null) return null;

            if (fast <= -FAST_FADE_DEPTH && slow <= -SLOW_FADE_DEPTH) {
                return createBuySignal(cleanData, i, `Multiscale fade buy: fast z ${fast.toFixed(2)}, slow z ${slow.toFixed(2)}`);
            }
            if (fast >= FAST_FADE_DEPTH && slow >= SLOW_FADE_DEPTH) {
                return createSellSignal(cleanData, i, `Multiscale fade sell: fast z ${fast.toFixed(2)}, slow z ${slow.toFixed(2)}`);
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
