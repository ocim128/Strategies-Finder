import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeEfficiencyGatedMeanAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 20)),
        efficiency_threshold: Math.min(0.99, Math.max(0.01, Number(params.efficiency_threshold ?? 0.3))),
    };
}

export const efficiency_gated_mean_alignment: Strategy = {
    name: "Efficiency Gated Mean Alignment",
    description: "The efficiency ratio measures how net-directional recent price movement has been relative to total path length. When efficiency is high, the market is trending coherently and close alignment with the rolling mean is a valid directional entry.",
    defaultParams: {
        lookback: 20,
        efficiency_threshold: 0.3,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiency_threshold: "Efficiency Threshold",
    },
    normalizeParams: normalizeEfficiencyGatedMeanAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyGatedMeanAlignmentParams(params);
        if (cleanData.length < p.lookback) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, p.lookback);
        const mean = buildRollingAverage(closes, p.lookback);

        return createSignalLoop(cleanData, [efficiency, mean], (i) => {
            if (i < p.lookback) return null;
            const eff = efficiency[i];
            const avg = mean[i];
            if (eff === null || avg === null) return null;

            if (eff > p.efficiency_threshold && closes[i] > avg) {
                return createBuySignal(cleanData, i, `Efficient uptrend (${eff.toFixed(3)}) with close above mean`);
            }
            if (eff > p.efficiency_threshold && closes[i] < avg) {
                return createSellSignal(cleanData, i, `Efficient downtrend (${eff.toFixed(3)}) with close below mean`);
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
