import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewPercentileGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 15))),
        expansionPercentileMin: Math.max(0, Math.min(1, Number(params.expansionPercentileMin ?? 0.60))),
    };
}

export const true_range_skew_percentile_gate: Strategy = {
    name: "True Range Skew Percentile Gate",
    description: "True-range skew acceptance with percentile-rank expansion gate.",
    defaultParams: {
        lookback: 15,
        expansionPercentileMin: 0.60,
    },
    paramLabels: {
        lookback: "Lookback",
        expansionPercentileMin: "Expansion Percentile Min",
    },
    normalizeParams: normalizeTrueRangeSkewPercentileGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewPercentileGateParams(params);
        const lookback = p.lookback as number;
        const expansionPercentileMin = p.expansionPercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const percentileRank = buildPercentileRank(trueRange, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, percentileRank], (i) => {
            const skew = trueRangeSkew[i];
            const percentile = percentileRank[i];
            if (skew === null || percentile === null) return null;

            if (skew > 0 && percentile > expansionPercentileMin && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with percentile rank ${percentile.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && percentile > expansionPercentileMin && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with percentile rank ${percentile.toFixed(2)} and bearish acceptance`
                );
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
