import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

export const n_bar_momentum_confirmation: Strategy = {
    name: "N-Bar Momentum Confirmation",
    description: "Confirms direction from the sign of the close-to-close change over one trailing lookback.",
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

        return createCurrentBarSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            if (closes[i] > closes[i - lookback]) {
                return createBuySignal(cleanData, i, "Close above lookback close");
            }
            if (closes[i] < closes[i - lookback]) {
                return createSellSignal(cleanData, i, "Close below lookback close");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
