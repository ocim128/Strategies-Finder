import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSkewnessDivergenceRegimeAnchorParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        skew_lookback: Math.max(3, Math.round(Number(params.skew_lookback ?? 63))),
        median_lookback: Math.max(2, Math.round(Number(params.median_lookback ?? 126))),
    };
}

export const skewness_divergence_regime_anchor: Strategy = {
    name: "Skewness Divergence Regime Anchor",
    description:
        "Treats skewness as a regime descriptor and only aligns with long-term median direction when the asymmetry of the recent distribution leans against the obvious price move.",
    defaultParams: {
        skew_lookback: 63,
        median_lookback: 126,
    },
    paramLabels: {
        skew_lookback: "Skew Lookback",
        median_lookback: "Median Lookback",
    },
    normalizeParams: normalizeSkewnessDivergenceRegimeAnchorParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessDivergenceRegimeAnchorParams(params);
        const minBars = Math.max(p.skew_lookback as number, p.median_lookback as number);
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const skewness = buildRollingSkewness(closes, p.skew_lookback as number);
        const median = buildRollingMedian(closes, p.median_lookback as number);

        return createSignalLoop(cleanData, [skewness, median], (i) => {
            const skew = skewness[i];
            const med = median[i];
            if (skew === null || med === null) return null;

            if (skew < 0 && closes[i] > med) {
                return createBuySignal(cleanData, i, `Negative skewness ${skew.toFixed(3)} with close above long-term median`);
            }
            if (skew > 0 && closes[i] < med) {
                return createSellSignal(cleanData, i, `Positive skewness ${skew.toFixed(3)} with close below long-term median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["skew_lookback", "median_lookback"],
    },
};
