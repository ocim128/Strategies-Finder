import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildAdjacentRangeOverlapSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_streak: Math.max(1, Math.round(Number(params.min_streak ?? 2))),
    };
}

export const adjacent_overlap_waterfall_continuation: Strategy = {
    name: "Adjacent Overlap Waterfall Continuation",
    description: "Rides runaway multi-bar momentum cascades when adjacent range overlap remains strictly below 0.25.",
    defaultParams: {
        min_streak: 2,
    },
    paramLabels: {
        min_streak: "Min Streak",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const min_streak = p.min_streak as number;
        if (cleanData.length < min_streak + 1) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const flags = overlap.map((v, idx) => (idx >= 1 && v < 0.25 ? 1 : 0));
        const lowOverlapStreak = buildStreakCount(flags);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 1) return null;

            if (lowOverlapStreak[i] >= min_streak) {
                if (cleanData[i].close > cleanData[i].open) {
                    return createBuySignal(cleanData, i, `Bullish waterfall continuation: low overlap streak ${lowOverlapStreak[i]} >= ${min_streak}, close > open`);
                }
                if (cleanData[i].close < cleanData[i].open) {
                    return createSellSignal(cleanData, i, `Bearish waterfall continuation: low overlap streak ${lowOverlapStreak[i]} >= ${min_streak}, close < open`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_streak"],
    },
};
