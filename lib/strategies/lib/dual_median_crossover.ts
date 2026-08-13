import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    checkCrossover,
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

const FAST_SLOW_RATIO = 3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 60))),
    };
}

export const dual_median_crossover: Strategy = {
    name: "Dual Median Crossover",
    description: "Trades the crossover of a fast rolling median of closes through a slow one.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Slow Median Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const fastWindow = Math.max(2, Math.round(lookback / FAST_SLOW_RATIO));
        const fast = buildRollingMedian(closes, fastWindow);
        const slow = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [fast, slow], (i) => {
            // Only evaluate once both index and index-1 are valid for the slow median.
            if (i < lookback + 1) return null;
            const cross = checkCrossover(fast, slow, i);
            if (cross === "bullish") {
                return createBuySignal(cleanData, i, "Fast median crossed above slow median");
            }
            if (cross === "bearish") {
                return createSellSignal(cleanData, i, "Fast median crossed below slow median");
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
