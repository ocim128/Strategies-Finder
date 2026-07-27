import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateLinearRegressionEndpoint } from "../trend-confirmation-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

export const linear_regression_center_confirmation: Strategy = {
    name: "Linear Regression Center Confirmation",
    description: "Confirms direction relative to the endpoint of a trailing least-squares trend line.",
    defaultParams: {
        lookback: 200,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        const closes = getCloses(cleanData);
        const center = calculateLinearRegressionEndpoint(closes, lookback);

        return createCurrentBarSignalLoop(cleanData, [center], (i) => {
            if (closes[i] > center[i]!) return createBuySignal(cleanData, i, "Close above regression center");
            if (closes[i] < center[i]!) return createSellSignal(cleanData, i, "Close below regression center");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
