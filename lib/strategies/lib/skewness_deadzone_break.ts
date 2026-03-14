import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeSkewnessDeadzoneBreakParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        skewLookback: Math.max(3, Math.round(params.skewLookback ?? 20)),
        maxSkewAbs: Math.max(0, params.maxSkewAbs ?? 0.3),
        rocBreakout: Math.max(0, params.rocBreakout ?? 1.5),
    };
}

export const skewness_deadzone_break: Strategy = {
    name: "Skewness Deadzone Break",
    description: "Treats collapsed absolute skewness as a symmetry deadzone and triggers only when ROC suddenly breaks that balance.",
    defaultParams: {
        skewLookback: 20,
        maxSkewAbs: 0.3,
        rocBreakout: 1.5,
    },
    paramLabels: {
        skewLookback: "Skewness Lookback",
        maxSkewAbs: "Max |Skewness|",
        rocBreakout: "ROC Breakout (%)",
    },
    normalizeParams: normalizeSkewnessDeadzoneBreakParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 5) return [];

        const skewLookback = Math.max(3, Math.round(params.skewLookback ?? 20));
        const maxSkewAbs = Math.max(0, params.maxSkewAbs ?? 0.3);
        const rocBreakout = Math.max(0, params.rocBreakout ?? 1.5);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const skewness = buildRollingSkewness(returns, skewLookback);
        const rocPct = buildRateOfChange(getCloses(cleanData), skewLookback).map((value) =>
            value === null ? null : value * 100
        );

        return createSignalLoop(cleanData, [skewness, rocPct], (i) => {
            const priorSkew = skewness[i - 1] as number;
            const currentRoc = rocPct[i] as number;
            if (Math.abs(priorSkew) >= maxSkewAbs) return null;

            if (currentRoc >= rocBreakout) {
                return createBuySignal(cleanData, i, "Skewness deadzone broken bullishly");
            }

            if (currentRoc <= -rocBreakout) {
                return createSellSignal(cleanData, i, "Skewness deadzone broken bearishly");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["skewLookback", "maxSkewAbs", "rocBreakout"],
    },
};
