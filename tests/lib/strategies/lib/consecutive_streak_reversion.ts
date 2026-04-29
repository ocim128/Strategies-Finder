import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildStreakCount, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeConsecutiveStreakReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streak_len: Math.max(2, Math.round(Number(params.streak_len ?? 6))),
    };
}

export const consecutive_streak_reversion: Strategy = {
    name: "Consecutive Streak Reversion",
    description:
        "Fades extended runs of same-direction daily bodies, betting that a prolonged close-to-close streak is due for a short mean-reversion pullback.",
    defaultParams: {
        streak_len: 6,
    },
    paramLabels: {
        streak_len: "Streak Length",
    },
    normalizeParams: normalizeConsecutiveStreakReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeConsecutiveStreakReversionParams(params);
        const streakLength = p.streak_len as number;
        if (cleanData.length < streakLength) return [];

        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const streaks = buildStreakCount(bodyDirection);

        return createSignalLoop(cleanData, [], (i) => {
            const streak = streaks[i];
            if (streak <= -streakLength) {
                return createBuySignal(cleanData, i, `Bearish body streak reached ${Math.abs(streak)} bars`);
            }
            if (streak >= streakLength) {
                return createSellSignal(cleanData, i, `Bullish body streak reached ${streak} bars`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streak_len"],
    },
};
