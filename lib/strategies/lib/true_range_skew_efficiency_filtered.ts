import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewEfficiencyFilteredParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 15))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.35))),
    };
}

export const true_range_skew_efficiency_filtered: Strategy = {
    name: "True Range Skew Efficiency Filtered",
    description: "True-range skew acceptance with efficiency-ratio noise filter.",
    defaultParams: {
        lookback: 15,
        efficiencyMin: 0.35,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizeTrueRangeSkewEfficiencyFilteredParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewEfficiencyFilteredParams(params);
        const lookback = p.lookback as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeMedian = buildRollingMedian(trueRange, lookback);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian, efficiencyRatio], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            const efficiency = efficiencyRatio[i];
            if (skew === null || median === null || efficiency === null || trueRange[i] <= median) return null;

            if (skew > 0 && efficiency > efficiencyMin && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with efficiency ${efficiency.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && efficiency > efficiencyMin && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with efficiency ${efficiency.toFixed(2)} and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiencyMin"],
    },
};
