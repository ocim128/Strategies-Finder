import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildStreakCount } from "./price-action-statistics-core";

const HIGH_EFFICIENCY_STREAK_MIN_ER = 0.6;

function normalizeHighEfficiencyStreakAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        min_streak: Math.max(1, Math.round(Number(params.min_streak ?? 3))),
    };
}

export const high_efficiency_streak_alignment: Strategy = {
    name: "High Efficiency Streak Alignment",
    description:
        "Requires a high efficiency ratio plus a minimum directional close streak before entering persistent moves.",
    defaultParams: {
        lookback: 20,
        min_streak: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        min_streak: "Minimum Streak",
    },
    normalizeParams: normalizeHighEfficiencyStreakAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeHighEfficiencyStreakAlignmentParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.min_streak as number;
        if (cleanData.length < lookback + minStreak + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const streakFlags = closes.map((close, i) => {
            if (i === 0) return 0;
            if (close > closes[i - 1]) return 1;
            if (close < closes[i - 1]) return -1;
            return 0;
        });
        const streaks = buildStreakCount(streakFlags);

        return createSignalLoop(cleanData, [efficiency], (i) => {
            const er = efficiency[i];
            if (er === null || er <= HIGH_EFFICIENCY_STREAK_MIN_ER) return null;

            if (streaks[i] >= minStreak) {
                return createBuySignal(cleanData, i, `High-efficiency positive streak ${streaks[i]} ER ${er.toFixed(2)}`);
            }
            if (streaks[i] <= -minStreak) {
                return createSellSignal(cleanData, i, `High-efficiency negative streak ${Math.abs(streaks[i])} ER ${er.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "min_streak"],
    },
};
