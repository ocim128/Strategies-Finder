import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateEMA } from "../indicators";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

export const typical_price_ema_confirmation: Strategy = {
    name: "Typical Price EMA Confirmation",
    description: "Confirms direction using an EMA of typical price so each bar's high and low inform the regime.",
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
        const typicalPrices = getTypicalPrices(cleanData);
        const ema = calculateEMA(typicalPrices, lookback);

        return createCurrentBarSignalLoop(cleanData, [ema], (i) => {
            if (typicalPrices[i] > ema[i]!) return createBuySignal(cleanData, i, "Typical price above its EMA");
            if (typicalPrices[i] < ema[i]!) return createSellSignal(cleanData, i, "Typical price below its EMA");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
