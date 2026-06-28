import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingEntropy, buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewEntropyGatedParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        entropyPercentileMax: Math.max(0, Math.min(1, Number(params.entropyPercentileMax ?? 0.40))),
    };
}

export const true_range_skew_entropy_gated: Strategy = {
    name: "True Range Skew Entropy Gated",
    description: "Entropy gate for directional regime confirmation.",
    defaultParams: {
        lookback: 20,
        entropyPercentileMax: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyPercentileMax: "Entropy Percentile Max",
    },
    normalizeParams: normalizeTrueRangeSkewEntropyGatedParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewEntropyGatedParams(params);
        const lookback = p.lookback as number;
        const entropyPercentileMax = p.entropyPercentileMax as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeMedian = buildRollingMedian(trueRange, lookback);
        const closeReturns = extractBarMetricSeries(cleanData, "closeReturn");
        const entropy = buildRollingEntropy(closeReturns, lookback);
        const cleanEntropy = entropy.map(e => e ?? 0);
        const entropyPercentile = buildPercentileRank(cleanEntropy, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian, entropyPercentile], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            const entPct = entropyPercentile[i];
            if (skew === null || median === null || entPct === null || trueRange[i] <= median) return null;

            if (skew > 0 && entPct < entropyPercentileMax && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with entropy percentile ${entPct.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && entPct < entropyPercentileMax && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with entropy percentile ${entPct.toFixed(2)} and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyPercentileMax"],
    },
};
