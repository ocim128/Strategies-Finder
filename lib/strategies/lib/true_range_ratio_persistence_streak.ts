import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming true range persistence streaks isolate high-conviction institutional breakouts.
// #SUGGEST_VERIFY: Verify true range extraction handles quiet/flat bars without resetting to incorrect states.
function normalizeTrueRangeRatioPersistenceStreakParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(2, Math.round(Number(params.minStreak ?? 4))),
    };
}

export const true_range_ratio_persistence_streak: Strategy = {
    name: "True Range Ratio Persistence Streak",
    description: "Signals when a consecutive streak of expanding true ranges aligns with price return direction, showing persistent trend strength.",
    defaultParams: {
        lookback: 30,
        minStreak: 4,
    },
    paramLabels: {
        lookback: "Average TR Lookback",
        minStreak: "Min Streak Length",
    },
    normalizeParams: normalizeTrueRangeRatioPersistenceStreakParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeRatioPersistenceStreakParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback + 5) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const avgTr = buildRollingAverage(trueRange, lookback);

        // Track positive expansions: Close > Open and TR > Avg TR
        // Track negative expansions: Close < Open and TR > Avg TR
        const bullishFlags: number[] = new Array(cleanData.length).fill(0);
        const bearishFlags: number[] = new Array(cleanData.length).fill(0);

        for (let i = 0; i < cleanData.length; i++) {
            const tr = trueRange[i];
            const avg = avgTr[i];
            if (avg === null) continue;

            const isExpanding = tr > avg;
            const close = cleanData[i].close;
            const open = cleanData[i].open;

            if (isExpanding) {
                if (close > open) {
                    bullishFlags[i] = 1;
                } else if (close < open) {
                    bearishFlags[i] = -1;
                }
            }
        }

        const bullishStreaks = buildStreakCount(bullishFlags);
        const bearishStreaks = buildStreakCount(bearishFlags);

        return createSignalLoop(cleanData, [avgTr], (i) => {
            if (i < lookback) return null;
            const bullStreak = bullishStreaks[i];
            const bearStreak = bearishStreaks[i];

            // Buy logic: bullStreak reaches minStreak
            if (bullStreak >= minStreak) {
                return createBuySignal(cleanData, i, `Bullish Range Expansion Streak (streak=${bullStreak})`);
            }

            // Sell logic: bearStreak reaches at least minStreak (bearStreak is negative, so <= -minStreak)
            if (bearStreak <= -minStreak) {
                return createSellSignal(cleanData, i, `Bearish Range Expansion Streak (streak=${bearStreak})`);
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
