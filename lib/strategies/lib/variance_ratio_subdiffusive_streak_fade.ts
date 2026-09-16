import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildStreakCount, buildVarianceRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_streak: Math.max(1, Math.round(Number(params.min_streak ?? 3))),
    };
}

export const variance_ratio_subdiffusive_streak_fade: Strategy = {
    name: "Variance Ratio Subdiffusive Streak Fade",
    description: "Fades persistent same-sign return streaks under certified subdiffusive variance ratio regimes.",
    defaultParams: {
        min_streak: 3,
    },
    paramLabels: {
        min_streak: "Min Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minStreak = p.min_streak as number;
        if (cleanData.length < 34) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, 30, 4);

        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            if (closes[i] > closes[i - 1]) flags[i] = 1;
            else if (closes[i] < closes[i - 1]) flags[i] = -1;
        }
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [vr], (i) => {
            const currentVr = vr[i];
            if (currentVr === null || currentVr > 0.75) return null;

            const streak = streaks[i];
            if (streak <= -minStreak) {
                return createBuySignal(cleanData, i, `Bullish subdiffusive streak fade: VR ${currentVr.toFixed(3)} <= 0.75, bear streak ${Math.abs(streak)} >= ${minStreak}`);
            }
            if (streak >= minStreak) {
                return createSellSignal(cleanData, i, `Bearish subdiffusive streak fade: VR ${currentVr.toFixed(3)} <= 0.75, bull streak ${streak} >= ${minStreak}`);
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
