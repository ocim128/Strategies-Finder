import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizeWickImbalanceSkewContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
    };
}

export const wick_imbalance_skew_continuation: Strategy = {
    name: "Wick Imbalance Skew Continuation",
    description: "Continues the routine rejection side identified by extreme skewness of the wick-imbalance distribution.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeWickImbalanceSkewContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeWickImbalanceSkewContinuationParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const skewness = buildRollingSkewness(wickImbalance, lookback);

        return createSignalLoop(cleanData, [skewness], (i) => {
            if (i < lookback) return null;
            const skew = skewness[i];
            if (skew === null) return null;

            if (skew < -0.8 && wickImbalance[i] > 0.05) {
                return createBuySignal(cleanData, i, `Negative wick-imbalance skew ${skew.toFixed(2)} with lower-wick dominance ${wickImbalance[i].toFixed(3)}`);
            }
            if (skew > 0.8 && wickImbalance[i] < -0.05) {
                return createSellSignal(cleanData, i, `Positive wick-imbalance skew ${skew.toFixed(2)} with upper-wick dominance ${wickImbalance[i].toFixed(3)}`);
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
