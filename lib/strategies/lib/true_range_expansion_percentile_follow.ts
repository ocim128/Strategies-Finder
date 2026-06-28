import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingSkewness, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        expansionPercentileMin: Math.max(0.5, Math.min(0.99, Number(params.expansionPercentileMin ?? 0.75))),
    };
}

export const true_range_expansion_percentile_follow: Strategy = {
    name: "True Range Expansion Percentile Follow",
    description: "Follows genuine leg dislocations when true-range percentile rank breaks the upper quartile with directional skewness and close acceptance.",
    defaultParams: {
        lookback: 30,
        expansionPercentileMin: 0.75,
    },
    paramLabels: {
        lookback: "Lookback",
        expansionPercentileMin: "Min Expansion Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangePctl = buildPercentileRank(trueRange, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangePctl], (i) => {
            const skew = trueRangeSkew[i];
            const pctl = trueRangePctl[i];
            if (skew === null || pctl === null) return null;
            if (pctl < (p.expansionPercentileMin as number)) return null;

            const cl = closeLocation[i];
            if (skew > 0 && cl > 0.5) {
                return createBuySignal(cleanData, i, `TR expansion pctl ${pctl.toFixed(2)} positive skew ${skew.toFixed(2)} bullish acceptance`);
            }
            if (skew < 0 && cl < 0.5) {
                return createSellSignal(cleanData, i, `TR expansion pctl ${pctl.toFixed(2)} negative skew ${skew.toFixed(2)} bearish acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "expansionPercentileMin"],
    },
};
