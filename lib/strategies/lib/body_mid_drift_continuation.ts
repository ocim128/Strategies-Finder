import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 20))),
    };
}

export const body_mid_drift_continuation: Strategy = {
    name: "Body Mid Drift Continuation",
    description: "Continues the drift of the wick-robust body midpoint when both the smoothed and current drift agree.",
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

        const delta = extractBarMetricSeries(cleanData, "bodyMidDelta");
        const averageDrift = buildRollingAverage(delta, lookback);

        return createSignalLoop(cleanData, [averageDrift], (i) => {
            const avg = averageDrift[i];
            if (avg === null) return null;

            if (avg > 0 && delta[i] > 0) {
                return createBuySignal(cleanData, i, `Persistent body-mid drift up: avg ${avg.toFixed(4)}`);
            }
            if (avg < 0 && delta[i] < 0) {
                return createSellSignal(cleanData, i, `Persistent body-mid drift down: avg ${avg.toFixed(4)}`);
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
