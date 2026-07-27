import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateMcGinleyDynamic } from "../trend-confirmation-indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 200))),
    };
}

export const mcginley_dynamic_confirmation: Strategy = {
    name: "McGinley Dynamic Confirmation",
    description: "Confirms direction relative to a dynamic average that adjusts its response to price movement.",
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
        const dynamic = calculateMcGinleyDynamic(closes, lookback);

        return createCurrentBarSignalLoop(cleanData, [dynamic], (i) => {
            if (closes[i] > dynamic[i]!) return createBuySignal(cleanData, i, "Close above McGinley Dynamic");
            if (closes[i] < dynamic[i]!) return createSellSignal(cleanData, i, "Close below McGinley Dynamic");
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
