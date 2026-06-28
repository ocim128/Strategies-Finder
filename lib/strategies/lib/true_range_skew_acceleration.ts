import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingMedian, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrueRangeSkewAccelerationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 15))),
        accelerationLookback: Math.max(1, Math.round(Number(params.accelerationLookback ?? 3))),
    };
}

export const true_range_skew_acceleration: Strategy = {
    name: "True Range Skew Acceleration",
    description: "Skewness acceleration (ROC of skewness) for early regime detection.",
    defaultParams: {
        lookback: 15,
        accelerationLookback: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        accelerationLookback: "Acceleration Lookback",
    },
    normalizeParams: normalizeTrueRangeSkewAccelerationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeSkewAccelerationParams(params);
        const lookback = p.lookback as number;
        const accelerationLookback = p.accelerationLookback as number;
        if (cleanData.length < lookback + accelerationLookback + 1) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trueRangeSkew = buildRollingSkewness(trueRange, lookback);
        const trueRangeMedian = buildRollingMedian(trueRange, lookback);
        const skewClean = trueRangeSkew.map(s => s ?? 0);
        const skewAcceleration = buildRateOfChange(skewClean, accelerationLookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trueRangeSkew, trueRangeMedian, skewAcceleration], (i) => {
            const skew = trueRangeSkew[i];
            const median = trueRangeMedian[i];
            const accel = skewAcceleration[i];
            if (skew === null || median === null || accel === null || trueRange[i] <= median) return null;

            if (skew > 0 && accel > 0 && closeAcceptance[i] > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive skew ${skew.toFixed(2)} with acceleration ${accel.toFixed(2)} and bullish acceptance`
                );
            }
            if (skew < 0 && accel < 0 && closeAcceptance[i] < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Negative skew ${skew.toFixed(2)} with acceleration ${accel.toFixed(2)} and bearish acceptance`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "accelerationLookback"],
    },
};
