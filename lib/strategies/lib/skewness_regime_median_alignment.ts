import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingSkewness, buildRollingMedian } from "./price-action-statistics-core";

function normalizeSkewnessRegimeMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    };
}

export const skewness_regime_median_alignment: Strategy = {
    name: "Skewness Regime Median Alignment",
    description: "Rolling skewness of typical prices reveals distribution shape: positive skew means the right tail dominates (bullish regime), negative means the left tail dominates (bearish). Align close direction with the skewness-defined regime relative to the rolling median.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeSkewnessRegimeMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessRegimeMedianAlignmentParams(params);
        if (cleanData.length < p.lookback) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const skewness = buildRollingSkewness(typicalPrices, p.lookback);
        const median = buildRollingMedian(typicalPrices, p.lookback);

        return createSignalLoop(cleanData, [skewness, median], (i) => {
            if (i < p.lookback) return null;
            const skew = skewness[i];
            const med = median[i];
            if (skew === null || med === null) return null;

            if (skew > 0 && typicalPrices[i] > med) {
                return createBuySignal(cleanData, i, `Positive skew regime (${skew.toFixed(3)}) with price above median`);
            }
            if (skew < 0 && typicalPrices[i] < med) {
                return createSellSignal(cleanData, i, `Negative skew regime (${skew.toFixed(3)}) with price below median`);
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
