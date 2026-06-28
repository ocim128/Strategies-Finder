import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewDualLookbackParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        skewLookback: Math.max(4, Math.round(Number(params.skewLookback ?? 25))),
        expansionLookback: Math.max(4, Math.round(Number(params.expansionLookback ?? 10))),
    };
}

export const true_range_skew_dual_lookback: Strategy = {
    name: "True Range Skew Dual Lookback",
    description: "Dual lookback architecture for skewness stability and expansion sensitivity.",
    defaultParams: {
        skewLookback: 25,
        expansionLookback: 10,
    },
    paramLabels: {
        skewLookback: "Skew Lookback",
        expansionLookback: "Expansion Lookback",
    },
    normalizeParams: normalizeTrueRangeSkewDualLookbackParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewDualLookbackParams(params);
        const skewLookback = p.skewLookback as number;
        const expansionLookback = p.expansionLookback as number;
        const maxLookback = Math.max(skewLookback, expansionLookback);
        if (cleanData.length < maxLookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, skewLookback);
        const trueRangeMedian = buildRollingMedian(trueRange, expansionLookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            if (skew === null || median === null || trueRange[i] <= median) return null;

            if (skew > 0 && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with dual lookback expansion gate and bullish acceptance`
                );
            }
            if (skew < 0 && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with dual lookback expansion gate and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["skewLookback", "expansionLookback"],
    },
};
