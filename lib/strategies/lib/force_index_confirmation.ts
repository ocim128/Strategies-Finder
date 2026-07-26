import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateForceIndex } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 13))),
    };
}

export const force_index_confirmation: Strategy = {
    name: "Force Index Confirmation",
    description: "Signals from the current causal EMA of price change multiplied by volume.",
    defaultParams: {
        period: 13,
    },
    paramLabels: {
        period: "Force Index Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const force = calculateForceIndex(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [force], (i) => {
            if (force[i]! > 0) return createBuySignal(cleanData, i, "Force Index above zero");
            if (force[i]! < 0) return createSellSignal(cleanData, i, "Force Index below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
