import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    ensureCleanData,
    createSignalLoop,
    createBuySignal,
    createSellSignal
} from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        minStreak: Math.max(2, Math.round(Number(params.minStreak ?? 2))),
    };
}

export const directional_body_streak_exhaustion: Strategy = {
    name: "Directional Body Streak Exhaustion",
    description: "Reversal fade when a directional streak of bars exhausts and turns on current bar.",
    defaultParams: {
        "minStreak": 2
    },
    paramLabels: {
        "minStreak": "Min Streak Length"
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minStreak = p.minStreak as number;
        if (cleanData.length < minStreak + 2) return [];

        const upFlags = cleanData.map(d => d.close > d.open ? 1 : 0);
        const downFlags = cleanData.map(d => d.close < d.open ? 1 : 0);

        const upStreaks = buildStreakCount(upFlags);
        const downStreaks = buildStreakCount(downFlags);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;
            if (downStreaks[i - 1] >= minStreak && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Exhaustion reversal after ${downStreaks[i - 1]} red bars`);
            }
            if (upStreaks[i - 1] >= minStreak && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Exhaustion reversal after ${upStreaks[i - 1]} green bars`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["minStreak"]
    }
};
