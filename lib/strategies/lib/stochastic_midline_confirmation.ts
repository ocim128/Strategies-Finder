import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateStochasticK } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        stochasticPeriod: Math.max(2, Math.round(Number(params.stochasticPeriod ?? 14))),
    };
}

export const stochastic_midline_confirmation: Strategy = {
    name: "Stochastic Midline Confirmation",
    description: "Signals with raw Stochastic %K direction around its fixed 50 midpoint.",
    defaultParams: {
        stochasticPeriod: 14,
    },
    paramLabels: {
        stochasticPeriod: "Stochastic Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.stochasticPeriod as number;
        if (cleanData.length < period) return [];

        const stochastic = calculateStochasticK(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), period);
        return createSignalLoop(cleanData, [stochastic], (i) => {
            if (stochastic[i]! > 50) return createBuySignal(cleanData, i, "Stochastic %K above 50");
            if (stochastic[i]! < 50) return createSellSignal(cleanData, i, "Stochastic %K below 50");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["stochasticPeriod"],
    },
};
