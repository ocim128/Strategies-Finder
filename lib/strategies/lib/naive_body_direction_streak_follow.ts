import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildStreakCount, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeNaiveBodyDirectionStreakFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakMin: Math.max(1, Math.round(Number(params.streakMin ?? 4))),
    };
}

export const naive_body_direction_streak_follow: Strategy = {
    name: "Naive Body Direction Streak Follow",
    description: "Candle body direction streak without quality gates.",
    defaultParams: {
        streakMin: 4,
    },
    paramLabels: {
        streakMin: "Streak Min",
    },
    normalizeParams: normalizeNaiveBodyDirectionStreakFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeNaiveBodyDirectionStreakFollowParams(params);
        const streakMin = p.streakMin as number;
        if (cleanData.length < streakMin + 1) return [];

        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const streakCounts = buildStreakCount(bodyDirection);

        return createSignalLoop(cleanData, [streakCounts], (i) => {
            const streak = streakCounts[i];
            if (streak === 0) return null;

            if (streak >= streakMin) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish body direction streak of ${streak} bars`
                );
            }
            if (streak <= -streakMin) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish body direction streak of ${Math.abs(streak)} bars`
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
