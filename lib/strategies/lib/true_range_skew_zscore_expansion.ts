import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingSkewness, buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewZScoreExpansionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 0.5)),
    };
}

export const true_range_skew_zscore_expansion: Strategy = {
    name: "True Range Skew Z-Score Expansion",
    description: "Range z-score expansion gate instead of median.",
    defaultParams: {
        lookback: 20,
        zThreshold: 0.5,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeTrueRangeSkewZScoreExpansionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewZScoreExpansionParams(params);
        const lookback = p.lookback as number;
        const zThreshold = p.zThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeZScore = buildRollingZScore(trueRange, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeZScore], (i) => {
            const skew = trueRangeSkew[i];
            const zscore = trueRangeZScore[i];
            if (skew === null || zscore === null) return null;

            if (skew > 0 && zscore > zThreshold && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with z-score expansion ${zscore.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && zscore < -zThreshold && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with z-score expansion ${zscore.toFixed(2)} and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
