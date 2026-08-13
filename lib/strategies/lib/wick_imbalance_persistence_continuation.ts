import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

const IMBALANCE_GATE = 0.1;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 20))),
    };
}

export const wick_imbalance_persistence_continuation: Strategy = {
    name: "Wick Imbalance Persistence Continuation",
    description: "Continues the side whose wick imbalance has been persistently defending.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Smoothing Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const imbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const averageImbalance = buildRollingAverage(imbalance, lookback);

        return createSignalLoop(cleanData, [averageImbalance], (i) => {
            const avg = averageImbalance[i];
            if (avg === null) return null;

            if (avg >= IMBALANCE_GATE && imbalance[i] > 0) {
                return createBuySignal(cleanData, i, `Persistent lower-wick defense: avg ${avg.toFixed(3)}`);
            }
            if (avg <= -IMBALANCE_GATE && imbalance[i] < 0) {
                return createSellSignal(cleanData, i, `Persistent upper-wick defense: avg ${avg.toFixed(3)}`);
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
