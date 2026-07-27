import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateKama } from "../trend-confirmation-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

export const kama_confirmation: Strategy = {
    name: "KAMA Confirmation",
    description: "Confirms direction relative to Kaufman's efficiency-adaptive moving average.",
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
        const kama = calculateKama(closes, lookback);

        return createCurrentBarSignalLoop(cleanData, [kama], (i) => {
            if (closes[i] > kama[i]!) return createBuySignal(cleanData, i, "Close above KAMA");
            if (closes[i] < kama[i]!) return createSellSignal(cleanData, i, "Close below KAMA");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
