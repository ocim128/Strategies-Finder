import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 15))),
        corrThreshold: Math.max(-1, Math.min(1, Number(params.corrThreshold ?? 0.4))),
    };
}

export const range_close_correlation_dislocation_follow: Strategy = {
    name: "Range-Close Correlation Dislocation Follow",
    description: "Follows moves when bar range and close location are positively correlated, indicating leg disagreement with directional conviction.",
    defaultParams: {
        lookback: 15,
        corrThreshold: 0.4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        corrThreshold: "Min Correlation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const closeLocations = buildCloseLocationSeries(cleanData);
        const corr = buildRollingCorrelation(ranges, closeLocations, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [corr, efficiency], (i) => {
            const c = corr[i];
            const er = efficiency[i];
            if (c === null || er === null) return null;

            const cl = closeLocations[i];

            if (c > p.corrThreshold && er > 0.2) {
                // Buy: positive range-close correlation and close is above midpoint -> follow trend
                if (cl > 0.5) {
                    return createBuySignal(cleanData, i, `Range-close corr buy: corr ${c.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
                // Sell: positive range-close correlation and close is below midpoint -> follow trend
                if (cl < 0.5) {
                    return createSellSignal(cleanData, i, `Range-close corr sell: corr ${c.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "corrThreshold"],
    },
};
