import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 10))),
    };
}

export const true_range_skew_acceptance: Strategy = {
    name: "True Range Skew Acceptance",
    description:
        "Trades true-range skew only when the current expanded bar also closes with directional acceptance.",
    defaultParams: {
        lookback: 10,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeTrueRangeSkewAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewAcceptanceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeMedian = buildRollingMedian(trueRange, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            if (skew === null || median === null || trueRange[i] <= median) return null;

            if (skew > 0 && closeAcceptance[i] > 0.5) {
                return createBuySignal(cleanData, i, `Positive true-range skew ${skew.toFixed(2)} with bullish acceptance`);
            }
            if (skew < 0 && closeAcceptance[i] < -0.5) {
                return createSellSignal(cleanData, i, `Negative true-range skew ${skew.toFixed(2)} with bearish acceptance`);
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
