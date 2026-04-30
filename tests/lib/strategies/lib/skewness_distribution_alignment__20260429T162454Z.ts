import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSkewnessDistributionAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 63))),
    };
}

export const skewness_distribution_alignment: Strategy = {
    name: "Skewness Distribution Alignment",
    description:
        "Pairs rolling skewness of daily closes with a trailing median so directional entries reflect both distribution asymmetry and settlement relative to a causal center.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeSkewnessDistributionAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessDistributionAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const skewness = buildRollingSkewness(closes, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [skewness, median], (i) => {
            if (i < lookback - 1) return null;

            const skew = skewness[i];
            const med = median[i];
            if (skew === null || med === null) return null;

            if (skew > 0 && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive skewness ${skew.toFixed(3)} with close above median`);
            }
            if (skew < 0 && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative skewness ${skew.toFixed(3)} with close below median`);
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
