import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    checkCrossover,
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";

const FAST_WINDOW = 3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 12))),
    };
}

export const acceptance_crossover_momentum: Strategy = {
    name: "Acceptance Crossover Momentum",
    description: "Follows the bias switch when the fast close-acceptance average crosses the slow one.",
    defaultParams: {
        lookback: 12,
    },
    paramLabels: {
        lookback: "Slow Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const fast = buildRollingAverage(acceptance, FAST_WINDOW);
        const slow = buildRollingAverage(acceptance, lookback);

        return createSignalLoop(cleanData, [fast, slow], (i) => {
            const cross = checkCrossover(fast, slow, i);
            if (cross === "bullish") {
                return createBuySignal(cleanData, i, "Fast acceptance crossed above slow");
            }
            if (cross === "bearish") {
                return createSellSignal(cleanData, i, "Fast acceptance crossed below slow");
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
