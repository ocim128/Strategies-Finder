import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateAccumulationDistributionSlope } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 20))),
    };
}

export const accumulation_distribution_slope_confirmation: Strategy = {
    name: "Accumulation/Distribution Slope Confirmation",
    description: "Signals from the current A/D line change over a trailing lookback without shifting the result.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "A/D Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        const slope = calculateAccumulationDistributionSlope(cleanData, lookback);
        return createCurrentBarSignalLoop(cleanData, [slope], (i) => {
            if (slope[i]! > 0) return createBuySignal(cleanData, i, "A/D line rising");
            if (slope[i]! < 0) return createSellSignal(cleanData, i, "A/D line falling");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
