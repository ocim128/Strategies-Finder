import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        minStreak: Math.max(2, Math.round(Number(params.minStreak ?? 4))),
    };
}

export const body_direction_streak_persistence_follow: Strategy = {
    name: "Body Direction Streak Persistence Follow",
    description: "Follows runs of consecutive same-direction bodies as persistent unilateral auction flow, the mirror of the streak fades.",
    defaultParams: {
        minStreak: 4,
    },
    paramLabels: {
        minStreak: "Minimum Streak",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minStreak = p.minStreak as number;
        if (cleanData.length < minStreak) return [];

        // Doji bars read 0 and break the streak by construction.
        const streak = buildStreakCount(extractBarMetricSeries(cleanData, "bodyDirection"));

        return createSignalLoop(cleanData, [streak], (i) => {
            if (streak[i] >= minStreak) {
                return createBuySignal(cleanData, i, `Body streak follow buy: ${streak[i]} consecutive bullish bodies`);
            }
            if (streak[i] <= -minStreak) {
                return createSellSignal(cleanData, i, `Body streak follow sell: ${-streak[i]} consecutive bearish bodies`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["minStreak"],
    },
};
