import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_streak: Math.max(1, Math.round(Number(params.min_streak ?? 2))),
    };
}

export const sweep_reclaim_absorption_cluster: Strategy = {
    name: "Sweep Reclaim Absorption Cluster",
    description: "Enters institutional reversals when directional sweep-reclaims persist across consecutive bars.",
    defaultParams: {
        min_streak: 2,
    },
    paramLabels: {
        min_streak: "Min Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minStreak = p.min_streak as number;
        if (cleanData.length < minStreak) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);
        const flags = sweep.map((s) => (s >= 0.15 ? 1 : s <= -0.15 ? -1 : 0));
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [], (i) => {
            const streak = streaks[i];

            if (streak >= minStreak) {
                return createBuySignal(cleanData, i, `Bullish sweep absorption cluster: positive sweep streak ${streak} >= ${minStreak}`);
            }
            if (streak <= -minStreak) {
                return createSellSignal(cleanData, i, `Bearish sweep absorption cluster: negative sweep streak ${Math.abs(streak)} >= ${minStreak}`);
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
