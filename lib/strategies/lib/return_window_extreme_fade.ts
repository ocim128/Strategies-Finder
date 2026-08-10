import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    extractBarMetricSeries,
    buildRollingMinMax,
} from "./price-action-statistics-core";

function normalizeReturnWindowExtremeFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const return_window_extreme_fade: Strategy = {
    name: "Return Window Extreme Fade",
    description: "Fades returns that set a fresh window minimum or maximum in an oscillating market.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeReturnWindowExtremeFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeReturnWindowExtremeFadeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const minMax = buildRollingMinMax(closeReturn, lookback);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            const minVal = minMax.min[i];
            const maxVal = minMax.max[i];
            if (minVal === null || maxVal === null) return null;

            if (closeReturn[i] <= minVal && closeReturn[i] < 0) {
                return createBuySignal(cleanData, i, `Fresh window-low return ${closeReturn[i].toFixed(4)}`);
            }
            if (closeReturn[i] >= maxVal && closeReturn[i] > 0) {
                return createSellSignal(cleanData, i, `Fresh window-high return ${closeReturn[i].toFixed(4)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
