import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import {
    extractBarMetricSeries,
    buildRollingSkewness,
} from "./price-action-statistics-core";

function normalizeLongSkewNegativeDriftParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        skewLookback: Math.max(30, Math.round(Number(params.skewLookback ?? 150))),
    };
}

export const long_skew_negative_drift: Strategy = {
    name: "Long Skew Drift Fade",
    description: "Fades placement extremes according to the long-window skew regime of the return distribution.",
    defaultParams: {
        skewLookback: 150,
    },
    paramLabels: {
        skewLookback: "Skew Lookback",
    },
    normalizeParams: normalizeLongSkewNegativeDriftParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLongSkewNegativeDriftParams(params);
        const skewLookback = p.skewLookback as number;
        if (cleanData.length < skewLookback + 1) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const skewness = buildRollingSkewness(closeReturn, skewLookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [skewness], (i) => {
            if (i < skewLookback) return null;
            const skew = skewness[i];
            if (skew === null) return null;

            if (skew < -0.5 && closeLocation[i] < 0.3) {
                return createBuySignal(cleanData, i, `Negative-skew grind regime (${skew.toFixed(2)}) with bottom placement ${closeLocation[i].toFixed(2)}`);
            }
            if (skew > 0.5 && closeLocation[i] > 0.7) {
                return createSellSignal(cleanData, i, `Positive-skew distribution regime (${skew.toFixed(2)}) with top placement ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["skewLookback"],
    },
};
