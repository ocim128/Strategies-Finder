import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const return_median_zero_cross: Strategy = {
    name: "Return Median Zero Cross",
    description: "Trades sign flips of the rolling median of one-bar returns, following the newly positive or negative regime.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Return Median Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const median = buildRollingMedian(returns, lookback);

        return createSignalLoop(cleanData, [median], (i) => {
            const prev = median[i - 1];
            const curr = median[i];
            if (prev === null || curr === null) return null;

            // Robust center of the return distribution flips sign.
            if (prev <= 0 && curr > 0) {
                return createBuySignal(cleanData, i, `Return median flip buy: ${prev.toFixed(5)} -> ${curr.toFixed(5)}`);
            }
            if (prev >= 0 && curr < 0) {
                return createSellSignal(cleanData, i, `Return median flip sell: ${prev.toFixed(5)} -> ${curr.toFixed(5)}`);
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
