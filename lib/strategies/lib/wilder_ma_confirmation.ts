import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateWilderMovingAverage } from "../trend-confirmation-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

export const wilder_ma_confirmation: Strategy = {
    name: "Wilder MA Confirmation",
    description: "Confirms direction relative to Wilder's slower recursively smoothed moving average.",
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
        const wilder = calculateWilderMovingAverage(closes, lookback);

        return createCurrentBarSignalLoop(cleanData, [wilder], (i) => {
            if (closes[i] > wilder[i]!) return createBuySignal(cleanData, i, "Close above Wilder MA");
            if (closes[i] < wilder[i]!) return createSellSignal(cleanData, i, "Close below Wilder MA");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
