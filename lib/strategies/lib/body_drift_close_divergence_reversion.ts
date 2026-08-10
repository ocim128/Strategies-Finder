import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries as extractFrequencyBarMetric } from "./price-action-frequency-core";
import {
    extractBarMetricSeries as extractStatisticBarMetric,
    buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeBodyDriftCloseDivergenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const body_drift_close_divergence_reversion: Strategy = {
    name: "Body Drift Close Divergence Reversion",
    description: "Reverses when the wick-robust body-mid drift disagrees with the close-to-close return at extreme percentile levels.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeBodyDriftCloseDivergenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodyDriftCloseDivergenceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const bodyMidDelta = extractFrequencyBarMetric(cleanData, "bodyMidDelta");
        const closeReturn = extractStatisticBarMetric(cleanData, "closeReturn");
        const bodyDriftRank = buildPercentileRank(bodyMidDelta, lookback);
        const closeReturnRank = buildPercentileRank(closeReturn, lookback);

        return createSignalLoop(cleanData, [bodyDriftRank, closeReturnRank], (i) => {
            if (i < lookback) return null;
            const driftRank = bodyDriftRank[i];
            const returnRank = closeReturnRank[i];
            if (driftRank === null || returnRank === null) return null;

            if (driftRank > 0.7 && returnRank < 0.3) {
                return createBuySignal(cleanData, i, `Body drift percentile ${driftRank.toFixed(2)} diverges from close return percentile ${returnRank.toFixed(2)}`);
            }
            if (driftRank < 0.3 && returnRank > 0.7) {
                return createSellSignal(cleanData, i, `Body drift percentile ${driftRank.toFixed(2)} diverges from close return percentile ${returnRank.toFixed(2)}`);
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
