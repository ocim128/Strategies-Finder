import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateDoubleExponentialMovingAverage } from "../trend-confirmation-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

export const dema_confirmation: Strategy = {
    name: "DEMA Confirmation",
    description: "Confirms direction relative to a double exponential moving average with reduced lag.",
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
        const dema = calculateDoubleExponentialMovingAverage(closes, lookback);

        return createCurrentBarSignalLoop(cleanData, [dema], (i) => {
            if (closes[i] > dema[i]!) return createBuySignal(cleanData, i, "Close above DEMA");
            if (closes[i] < dema[i]!) return createSellSignal(cleanData, i, "Close below DEMA");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
