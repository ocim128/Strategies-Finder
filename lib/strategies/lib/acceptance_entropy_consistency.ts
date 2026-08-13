import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingEntropy } from "./price-action-statistics-core";

// Out of 5 bins the maximum entropy is log2(5) ~= 2.32; 1.0 means the
// acceptance distribution is heavily concentrated on one side.
const ENTROPY_GATE = 1.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 24))),
    };
}

export const acceptance_entropy_consistency: Strategy = {
    name: "Acceptance Entropy Consistency",
    description: "Follows the current bar only when close-acceptance placement has been consistent over the window.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Entropy Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const entropy = buildRollingEntropy(acceptance, lookback, 5);

        return createSignalLoop(cleanData, [entropy], (i) => {
            const h = entropy[i];
            if (h === null) return null;

            if (h <= ENTROPY_GATE && acceptance[i] > 0) {
                return createBuySignal(cleanData, i, `Consistent bullish placement: entropy ${h.toFixed(2)}`);
            }
            if (h <= ENTROPY_GATE && acceptance[i] < 0) {
                return createSellSignal(cleanData, i, `Consistent bearish placement: entropy ${h.toFixed(2)}`);
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
