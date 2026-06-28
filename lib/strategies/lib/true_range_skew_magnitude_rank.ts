import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewMagnitudeRankParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        skewPercentileMin: Math.max(0, Math.min(1, Number(params.skewPercentileMin ?? 0.70))),
    };
}

export const true_range_skew_magnitude_rank: Strategy = {
    name: "True Range Skew Magnitude Rank",
    description: "Skewness magnitude via percentile rank as signal quality gate.",
    defaultParams: {
        lookback: 20,
        skewPercentileMin: 0.70,
    },
    paramLabels: {
        lookback: "Lookback",
        skewPercentileMin: "Skew Percentile Min",
    },
    normalizeParams: normalizeTrueRangeSkewMagnitudeRankParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewMagnitudeRankParams(params);
        const lookback = p.lookback as number;
        const skewPercentileMin = p.skewPercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeMedian = buildRollingMedian(trueRange, lookback);
        const absSkew = trueRangeSkew.map(s => s === null ? 0 : Math.abs(s));
        const skewMagnitudePercentile = buildPercentileRank(absSkew, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian, skewMagnitudePercentile], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            const magPct = skewMagnitudePercentile[i];
            if (skew === null || median === null || magPct === null || trueRange[i] <= median) return null;

            if (skew > 0 && magPct > skewPercentileMin && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with magnitude percentile ${magPct.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && magPct > skewPercentileMin && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with magnitude percentile ${magPct.toFixed(2)} and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewPercentileMin"],
    },
};
