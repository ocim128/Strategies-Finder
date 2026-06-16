import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRollingMedian,
    buildRollingZScore,
    buildStreakCount,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 5))),
    };
}

export const streak_exhaustion_median_fade: Strategy = {
    name: "Streak Exhaustion Median Fade",
    description: "Fades momentum streaks when price has drifted far from its rolling median.",
    defaultParams: {
        lookback: 30,
        minStreak: 5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minStreak: "Min Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const directions = extractBarMetricSeries(cleanData, "bodyDirection");
        const streaks = buildStreakCount(directions);
        const median = buildRollingMedian(closes, lookback);
        const closeZ = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [median, closeZ, streaks], (i) => {
            const m = median[i];
            const z = closeZ[i];
            const streak = streaks[i];
            if (m === null || z === null) return null;

            const close = closes[i];

            // Buy: close is below median, z-score is negative, and down-bar streak is >= minStreak
            if (close < m && z < 0 && streak <= -p.minStreak) {
                return createBuySignal(cleanData, i, `Streak exhaustion buy: streak ${Math.abs(streak)} bars, close < median`);
            }
            // Sell: close is above median, z-score is positive, and up-bar streak is >= minStreak
            if (close > m && z > 0 && streak >= p.minStreak) {
                return createSellSignal(cleanData, i, `Streak exhaustion sell: streak ${streak} bars, close > median`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minStreak"],
    },
};
