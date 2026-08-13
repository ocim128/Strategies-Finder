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

const CMF_GATE = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const cmf_extreme_fade: Strategy = {
    name: "CMF Extreme Fade",
    description: "Fades the cumulative money-flow proxy when it pins at an extreme over the lookback.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "CMF Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const cmf = calculateCMF(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [cmf], (i) => {
            const value = cmf[i];
            if (value === null) return null;

            if (value <= -CMF_GATE) {
                return createBuySignal(cleanData, i, `Extreme distribution proxy: cmf ${value.toFixed(2)}`);
            }
            if (value >= CMF_GATE) {
                return createSellSignal(cleanData, i, `Extreme accumulation proxy: cmf ${value.toFixed(2)}`);
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
