import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewAcceptanceQualityParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 15))),
        acceptancePercentileMin: Math.max(0, Math.min(1, Number(params.acceptancePercentileMin ?? 0.60))),
    };
}

export const true_range_skew_acceptance_quality: Strategy = {
    name: "True Range Skew Acceptance Quality",
    description: "Close acceptance quality via percentile rank.",
    defaultParams: {
        lookback: 15,
        acceptancePercentileMin: 0.60,
    },
    paramLabels: {
        lookback: "Lookback",
        acceptancePercentileMin: "Acceptance Percentile Min",
    },
    normalizeParams: normalizeTrueRangeSkewAcceptanceQualityParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewAcceptanceQualityParams(params);
        const lookback = p.lookback as number;
        const acceptancePercentileMin = p.acceptancePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeMedian = buildRollingMedian(trueRange, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);
        const absAcceptance = closeAcceptance.map(Math.abs);
        const acceptancePercentile = buildPercentileRank(absAcceptance, lookback);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian, acceptancePercentile], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            const acceptPct = acceptancePercentile[i];
            if (skew === null || median === null || acceptPct === null || trueRange[i] <= median) return null;

            if (skew > 0 && closeAcceptance[i] > 0 && acceptPct > acceptancePercentileMin) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with acceptance percentile ${acceptPct.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && closeAcceptance[i] < 0 && acceptPct > acceptancePercentileMin) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with acceptance percentile ${acceptPct.toFixed(2)} and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acceptancePercentileMin"],
    },
};
