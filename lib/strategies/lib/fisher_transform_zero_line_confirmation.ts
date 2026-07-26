import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateFisherTransform } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 10))),
    };
}

export const fisher_transform_zero_line_confirmation: Strategy = {
    name: "Fisher Transform Zero-Line Confirmation",
    description: "Signals from the causal Fisher Transform of the current trailing midpoint range.",
    defaultParams: {
        period: 10,
    },
    paramLabels: {
        period: "Fisher Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const fisher = calculateFisherTransform(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [fisher], (i) => {
            if (fisher[i]! > 0) return createBuySignal(cleanData, i, "Fisher Transform above zero");
            if (fisher[i]! < 0) return createSellSignal(cleanData, i, "Fisher Transform below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
