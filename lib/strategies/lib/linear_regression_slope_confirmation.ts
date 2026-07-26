import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createCurrentBarSignalLoop, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { calculateLinearRegressionSlope } from "../traditional-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 20))),
    };
}

export const linear_regression_slope_confirmation: Strategy = {
    name: "Linear Regression Slope Confirmation",
    description: "Signals from the current trailing regression slope without projecting or shifting the result.",
    defaultParams: {
        period: 20,
    },
    paramLabels: {
        period: "Regression Period",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const period = normalizeParams(params).period as number;
        const slope = calculateLinearRegressionSlope(cleanData, period);
        return createCurrentBarSignalLoop(cleanData, [slope], (i) => {
            if (slope[i]! > 0) return createBuySignal(cleanData, i, "Regression slope above zero");
            if (slope[i]! < 0) return createSellSignal(cleanData, i, "Regression slope below zero");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
