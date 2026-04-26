import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEfficiencyGatedMedianParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 20)),
        efficiency_threshold: Math.max(0, Math.min(1, Number(params.efficiency_threshold ?? 0.3))),
    };
}

export const efficiency_gated_median: Strategy = {
    name: "Efficiency Gated Median",
    description: "When path efficiency is high, the market is behaving directionally rather than chop-like. In that regime, alignment relative to the rolling median acts as a simple continuation anchor.",
    defaultParams: {
        lookback: 20,
        efficiency_threshold: 0.3,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiency_threshold: "Efficiency Threshold",
    },
    normalizeParams: normalizeEfficiencyGatedMedianParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyGatedMedianParams(params);
        const lookback = p.lookback as number;
        const threshold = p.efficiency_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [median, efficiency], (i) => {
            const center = median[i];
            const er = efficiency[i];
            if (center === null || er === null || er <= threshold) return null;

            if (closes[i] > center) {
                return createBuySignal(cleanData, i, `ER ${er.toFixed(3)} > ${threshold} and close above median ${center.toFixed(2)}`);
            }
            if (closes[i] < center) {
                return createSellSignal(cleanData, i, `ER ${er.toFixed(3)} > ${threshold} and close below median ${center.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiency_threshold"],
    },
};
