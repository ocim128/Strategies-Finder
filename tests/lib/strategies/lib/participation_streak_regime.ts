import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

function normalizeParticipationStreakRegimeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streak_lookback: Math.max(2, Math.round(Number(params.streak_lookback ?? 20))),
        regime_threshold: Math.max(1, Math.round(Number(params.regime_threshold ?? 3))),
    };
}

export const participation_streak_regime: Strategy = {
    name: "Participation Streak Regime",
    description:
        "Routes persistent close-to-median participation streaks to momentum alignment and quiet streak regimes to close-distribution reversion.",
    defaultParams: {
        streak_lookback: 20,
        regime_threshold: 3,
    },
    paramLabels: {
        streak_lookback: "Streak Lookback",
        regime_threshold: "Regime Threshold",
    },
    normalizeParams: normalizeParticipationStreakRegimeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParticipationStreakRegimeParams(params);
        const lookback = p.streak_lookback as number;
        const threshold = p.regime_threshold as number;
        if (cleanData.length < lookback + threshold + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const closeRank = buildPercentileRank(closes, lookback);
        const initiativePressure = buildInitiativePressureSeries(cleanData, lookback);
        const streakFlags = closes.map((close, i) => {
            const med = median[i];
            if (med === null) return 0;
            if (close > med) return 1;
            if (close < med) return -1;
            return 0;
        });
        const streaks = buildStreakCount(streakFlags);

        return createSignalLoop(cleanData, [median, closeRank, initiativePressure], (i) => {
            const med = median[i];
            const rank = closeRank[i];
            const pressure = initiativePressure[i];
            if (med === null || rank === null || pressure === null) return null;

            const streak = streaks[i];
            if (Math.abs(streak) >= threshold) {
                if (streak > 0 && closes[i] > med && pressure > 0) {
                    return createBuySignal(cleanData, i, `Positive participation streak ${streak}`);
                }
                if (streak < 0 && closes[i] < med && pressure < 0) {
                    return createSellSignal(cleanData, i, `Negative participation streak ${Math.abs(streak)}`);
                }
                return null;
            }

            if (rank <= 0.25 && pressure > -0.2) {
                return createBuySignal(cleanData, i, `Low streak lower-quartile reversion rank ${(rank * 100).toFixed(0)}%`);
            }
            if (rank >= 0.75 && pressure < 0.2) {
                return createSellSignal(cleanData, i, `Low streak upper-quartile reversion rank ${(rank * 100).toFixed(0)}%`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streak_lookback", "regime_threshold"],
    },
};
