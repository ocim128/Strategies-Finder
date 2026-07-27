import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateHullMovingAverage } from "../trend-confirmation-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

export const hull_ma_confirmation: Strategy = {
    name: "Hull MA Confirmation",
    description: "Confirms direction relative to a Hull moving average whose subperiods derive from one lookback.",
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
        const hma = calculateHullMovingAverage(closes, lookback);

        return createCurrentBarSignalLoop(cleanData, [hma], (i) => {
            if (closes[i] > hma[i]!) return createBuySignal(cleanData, i, "Close above Hull MA");
            if (closes[i] < hma[i]!) return createSellSignal(cleanData, i, "Close below Hull MA");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
