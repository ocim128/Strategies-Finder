import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeRollingMedianCenterlineParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    };
}

export const rolling_median_centerline: Strategy = {
    name: "Rolling Median Centerline",
    description: "The rolling median is the causal 50th-percentile consensus price. Closes above it imply buyers are accepting progressively higher value; closes below imply sellers are controlling value acceptance.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRollingMedianCenterlineParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRollingMedianCenterlineParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [median], (i) => {
            if (i < lookback - 1) return null;
            const center = median[i];
            if (center === null) return null;

            if (closes[i] > center) {
                return createBuySignal(cleanData, i, `Close ${closes[i].toFixed(2)} above rolling median ${center.toFixed(2)}`);
            }
            if (closes[i] < center) {
                return createSellSignal(cleanData, i, `Close ${closes[i].toFixed(2)} below rolling median ${center.toFixed(2)}`);
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
