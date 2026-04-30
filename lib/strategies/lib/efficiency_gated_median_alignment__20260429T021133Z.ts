import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEfficiencyGatedMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        efficiency_lookback: Math.max(2, Math.round(Number(params.efficiency_lookback ?? 30))),
        median_lookback: Math.max(2, Math.round(Number(params.median_lookback ?? 55))),
        efficiency_floor: Math.max(0, Math.min(1, Number(params.efficiency_floor ?? 0.35))),
    };
}

export const efficiency_gated_median_alignment: Strategy = {
    name: "Efficiency Gated Median Alignment",
    description:
        "Uses path efficiency as a compact regime gate, then aligns the completed close against a trailing rolling median only when the recent market is behaving directionally rather than randomly.",
    defaultParams: {
        efficiency_lookback: 30,
        median_lookback: 55,
        efficiency_floor: 0.35,
    },
    paramLabels: {
        efficiency_lookback: "Efficiency Lookback",
        median_lookback: "Median Lookback",
        efficiency_floor: "Efficiency Floor",
    },
    normalizeParams: normalizeEfficiencyGatedMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyGatedMedianAlignmentParams(params);
        const efficiencyLookback = p.efficiency_lookback as number;
        const medianLookback = p.median_lookback as number;
        const minLookback = Math.max(efficiencyLookback, medianLookback);
        if (cleanData.length < minLookback) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, efficiencyLookback);
        const median = buildRollingMedian(closes, medianLookback);

        return createSignalLoop(cleanData, [efficiency, median], (i) => {
            if (i < minLookback - 1) return null;

            const er = efficiency[i];
            const med = median[i];
            if (er === null || med === null || er <= (p.efficiency_floor as number)) return null;

            if (closes[i] > med) {
                return createBuySignal(cleanData, i, `Efficient bullish settlement with ER ${er.toFixed(3)}`);
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, `Efficient bearish settlement with ER ${er.toFixed(3)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["efficiency_lookback", "median_lookback", "efficiency_floor"],
    },
};
