import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 24))),
    };
}

export const initiative_pressure_flip_continuation: Strategy = {
    name: "Initiative Pressure Flip Continuation",
    description: "Follows the bar when initiative pressure flips from rejection into acceptance or back.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Pressure Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback);

        return createSignalLoop(cleanData, [pressure], (i) => {
            const current = pressure[i];
            const previous = pressure[i - 1];
            if (current === null || previous === null) return null;

            const close = cleanData[i].close;
            const open = cleanData[i].open;

            if (current > 0 && previous < 0 && close > open) {
                return createBuySignal(cleanData, i, "Pressure flipped into acceptance");
            }
            if (current < 0 && previous > 0 && close < open) {
                return createSellSignal(cleanData, i, "Pressure flipped into rejection");
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
