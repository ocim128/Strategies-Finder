import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildExtremeAgeSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        age_ratio_threshold: Math.max(1, Number(params.age_ratio_threshold ?? 6.0)),
    };
}

export const extreme_age_relative_temporal_ratio: Strategy = {
    name: "Extreme Age Relative Temporal Ratio",
    description: "Exploits structural order flow asymmetry when the temporal age of one trailing extreme dominates the opposing extreme by at least age_ratio_threshold.",
    defaultParams: {
        age_ratio_threshold: 6.0,
    },
    paramLabels: {
        age_ratio_threshold: "Age Ratio Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const threshold = p.age_ratio_threshold as number;
        if (cleanData.length < 24) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, 24);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            if (sh === null || sl === null) return null;

            const bullRatio = sl / (sh + 1);
            if (bullRatio >= threshold && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish temporal extreme dominance: sinceLow/sinceHigh ${bullRatio.toFixed(2)} >= ${threshold}, bull close`);
            }

            const bearRatio = sh / (sl + 1);
            if (bearRatio >= threshold && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish temporal extreme dominance: sinceHigh/sinceLow ${bearRatio.toFixed(2)} >= ${threshold}, bear close`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["age_ratio_threshold"],
    },
};
