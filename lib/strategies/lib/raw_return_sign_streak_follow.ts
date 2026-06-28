import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildStreakCount } from "./price-action-statistics-core";

function normalizeRawReturnSignStreakFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakMin: Math.max(1, Math.round(Number(params.streakMin ?? 4))),
    };
}

export const raw_return_sign_streak_follow: Strategy = {
    name: "Raw Return Sign Streak Follow",
    description: "Consecutive return direction without regime confirmation.",
    defaultParams: {
        streakMin: 4,
    },
    paramLabels: {
        streakMin: "Streak Min",
    },
    normalizeParams: normalizeRawReturnSignStreakFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRawReturnSignStreakFollowParams(params);
        const streakMin = p.streakMin as number;
        if (cleanData.length < streakMin + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const streakFlags = returns.map(r => r === null || r === 0 ? 0 : (r > 0 ? 1 : -1));
        const streakCounts = buildStreakCount(streakFlags);

        return createSignalLoop(cleanData, [streakCounts], (i) => {
            const streak = streakCounts[i];
            if (streak === 0) return null;

            if (streak >= streakMin) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish return sign streak of ${streak} bars`
                );
            }
            if (streak <= -streakMin) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish return sign streak of ${Math.abs(streak)} bars`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakMin"],
    },
};
