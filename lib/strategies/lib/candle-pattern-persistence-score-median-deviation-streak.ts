import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

function normalizeCandlePatternPersistenceScoreMedianDeviationStreakParams(params: StrategyParams): StrategyParams {
    const scoreLookback = Math.max(2, Math.round(params.scoreLookback ?? 5));
    const rawScoreThreshold = Number(params.scoreThreshold ?? 0.6);
    const scoreThreshold = Math.max(0, Math.min(1, Number.isFinite(rawScoreThreshold) ? rawScoreThreshold : 0.6));
    const medianLookback = Math.max(2, Math.round(params.medianLookback ?? 20));
    const rawStreakThreshold = Number(params.streakThreshold ?? 5);
    const streakThreshold = Math.max(1, Math.abs(Math.round(Number.isFinite(rawStreakThreshold) ? rawStreakThreshold : 5)));

    return {
        ...params,
        scoreLookback,
        scoreThreshold,
        medianLookback,
        streakThreshold,
    };
}

export const candle_pattern_persistence_score_median_deviation_streak: Strategy = {
    name: "Candle Pattern Persistence Score (Median Deviation Streak)",
    description: "CPPS entries filtered by same-direction rolling median streak persistence, with Min Avg Body % disabled.",
    defaultParams: {
        scoreLookback: 5,
        scoreThreshold: 0.6,
        medianLookback: 20,
        streakThreshold: 5,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        scoreThreshold: "Persistence Threshold",
        medianLookback: "Median Lookback",
        streakThreshold: "Streak Threshold",
    },
    normalizeParams: normalizeCandlePatternPersistenceScoreMedianDeviationStreakParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const normalizedParams = normalizeCandlePatternPersistenceScoreMedianDeviationStreakParams(params);
        const state = computeCandlePatternPersistenceState(data, normalizedParams.scoreLookback);
        const { cleanData, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const medians = buildRollingMedian(closes, normalizedParams.medianLookback);
        const signs = new Array(cleanData.length).fill(0);

        for (let i = 0; i < cleanData.length; i++) {
            const median = medians[i];
            if (median === null) continue;

            if (closes[i] > median) signs[i] = 1;
            else if (closes[i] < median) signs[i] = -1;
        }

        const streaks = buildStreakCount(signs);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, medians], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const streak = streaks[i];

            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            if (score > normalizedParams.scoreThreshold && streak >= normalizedParams.streakThreshold) {
                return createBuySignal(
                    cleanData,
                    i,
                    `CPPS bullish + Median Streak >= ${normalizedParams.streakThreshold}`
                );
            }
            if (score < -normalizedParams.scoreThreshold && streak <= -normalizedParams.streakThreshold) {
                return createSellSignal(
                    cleanData,
                    i,
                    `CPPS bearish + Median Streak <= -${normalizedParams.streakThreshold}`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback", "scoreThreshold", "medianLookback", "streakThreshold"],
    },
};
