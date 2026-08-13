import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const cmf_flow_flip_confirmation: Strategy = {
    name: "CMF Flow Flip Confirmation",
    description: "Trades the zero-crossing of the cumulative money-flow proxy when the bar confirms the flip.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "CMF Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const cmf = calculateCMF(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [cmf], (i) => {
            const current = cmf[i];
            const previous = cmf[i - 1];
            if (current === null || previous === null) return null;

            const close = cleanData[i].close;
            const open = cleanData[i].open;

            if (current > 0 && previous <= 0 && close > open) {
                return createBuySignal(cleanData, i, "Flow flipped into accumulation");
            }
            if (current < 0 && previous >= 0 && close < open) {
                return createSellSignal(cleanData, i, "Flow flipped into distribution");
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
