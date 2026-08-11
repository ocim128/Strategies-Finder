import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingRobustZScore } from "./price-action-statistics-core";

const TURN_BAND = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const zscore_turn_confirmation: Strategy = {
    name: "Z-Score Turn Confirmation",
    description: "Fades robust z-score extremes only after the reading crosses back inside the band, confirming the dislocation has stopped expanding.",
    defaultParams: {
        lookback: 40,
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

        const z = buildRollingRobustZScore(getCloses(cleanData), lookback);

        return createSignalLoop(cleanData, [z], (i) => {
            const prev = z[i - 1];
            const curr = z[i];
            if (prev === null || curr === null) return null;

            // Cross back up inside the band after an oversold extreme.
            if (prev <= -TURN_BAND && curr > -TURN_BAND) {
                return createBuySignal(cleanData, i, `Z-score turn buy: z ${curr.toFixed(2)} crossed back inside from ${prev.toFixed(2)}`);
            }
            // Cross back down inside the band after an overbought extreme.
            if (prev >= TURN_BAND && curr < TURN_BAND) {
                return createSellSignal(cleanData, i, `Z-score turn sell: z ${curr.toFixed(2)} crossed back inside from ${prev.toFixed(2)}`);
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
