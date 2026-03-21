import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
} from "./candle-pattern-persistence-core";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

function normalizeCandlePatternPersistenceScoreMedianDeviationStreakParams(params: StrategyParams): StrategyParams {
    const scoreLookback = Math.max(2, Math.round(params.scoreLookback ?? 5));
    const medianLookback = Math.max(2, Math.round(params.medianLookback ?? 20));

    return {
        ...params,
        scoreLookback,
        medianLookback,
    };
}

type CandlePatternPersistenceMedianDeviationPrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    scorePrefix: number[];
    bodyPctPrefix: number[];
    validPrefix: number[];
    avgScoreByLookback: Map<number, (number | null)[]>;
    avgBodyPctByLookback: Map<number, (number | null)[]>;
    medianByLookback: Map<number, (number | null)[]>;
    streakByLookback: Map<number, number[]>;
};

function prepareCandlePatternPersistenceMedianDeviationData(
    data: OHLCVData[]
): CandlePatternPersistenceMedianDeviationPrepared {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const scorePrefix = new Array(cleanData.length + 1).fill(0);
    const bodyPctPrefix = new Array(cleanData.length + 1).fill(0);
    const validPrefix = new Array(cleanData.length + 1).fill(0);

    for (let i = 0; i < cleanData.length; i++) {
        scorePrefix[i + 1] = scorePrefix[i];
        bodyPctPrefix[i + 1] = bodyPctPrefix[i];
        validPrefix[i + 1] = validPrefix[i];

        const range = cleanData[i].high - cleanData[i].low;
        if (range <= 0) {
            continue;
        }

        const signedBody = cleanData[i].close - cleanData[i].open;
        const absBody = Math.abs(signedBody);
        const bodyScore = Math.max(-1, Math.min(1, signedBody / range));
        const bodyPct = Math.max(0, Math.min(1, absBody / range));

        scorePrefix[i + 1] += bodyScore;
        bodyPctPrefix[i + 1] += bodyPct;
        validPrefix[i + 1] += 1;
    }

    return {
        cleanData,
        closes,
        scorePrefix,
        bodyPctPrefix,
        validPrefix,
        avgScoreByLookback: new Map<number, (number | null)[]>(),
        avgBodyPctByLookback: new Map<number, (number | null)[]>(),
        medianByLookback: new Map<number, (number | null)[]>(),
        streakByLookback: new Map<number, number[]>(),
    };
}

function getPreparedCandlePatternPersistenceMedianDeviationData(
    preparedData: unknown,
    data: OHLCVData[]
): CandlePatternPersistenceMedianDeviationPrepared {
    if (preparedData && typeof preparedData === "object" && "avgScoreByLookback" in preparedData && "streakByLookback" in preparedData) {
        return preparedData as CandlePatternPersistenceMedianDeviationPrepared;
    }
    return prepareCandlePatternPersistenceMedianDeviationData(data);
}

function getPreparedScoreSeries(
    prepared: CandlePatternPersistenceMedianDeviationPrepared,
    scoreLookback: number
): { avgScore: (number | null)[]; avgBodyPct: (number | null)[] } {
    let avgScore = prepared.avgScoreByLookback.get(scoreLookback);
    let avgBodyPct = prepared.avgBodyPctByLookback.get(scoreLookback);
    if (avgScore && avgBodyPct) {
        return { avgScore, avgBodyPct };
    }

    avgScore = new Array(prepared.cleanData.length).fill(null);
    avgBodyPct = new Array(prepared.cleanData.length).fill(null);

    for (let i = scoreLookback - 1; i < prepared.cleanData.length; i++) {
        const end = i + 1;
        const start = end - scoreLookback;
        const validCount = prepared.validPrefix[end] - prepared.validPrefix[start];
        if (validCount < scoreLookback) {
            continue;
        }

        avgScore[i] = (prepared.scorePrefix[end] - prepared.scorePrefix[start]) / scoreLookback;
        avgBodyPct[i] = (prepared.bodyPctPrefix[end] - prepared.bodyPctPrefix[start]) / scoreLookback;
    }

    prepared.avgScoreByLookback.set(scoreLookback, avgScore);
    prepared.avgBodyPctByLookback.set(scoreLookback, avgBodyPct);
    return { avgScore, avgBodyPct };
}

function getPreparedMedianStreakSeries(
    prepared: CandlePatternPersistenceMedianDeviationPrepared,
    medianLookback: number
): { medians: (number | null)[]; streaks: number[] } {
    let medians = prepared.medianByLookback.get(medianLookback);
    if (!medians) {
        medians = buildRollingMedian(prepared.closes, medianLookback);
        prepared.medianByLookback.set(medianLookback, medians);
    }

    let streaks = prepared.streakByLookback.get(medianLookback);
    if (!streaks) {
        const signs = new Array(prepared.cleanData.length).fill(0);
        for (let i = 0; i < prepared.cleanData.length; i++) {
            const median = medians[i];
            if (median === null) continue;

            if (prepared.closes[i] > median) signs[i] = 1;
            else if (prepared.closes[i] < median) signs[i] = -1;
        }

        streaks = buildStreakCount(signs);
        prepared.streakByLookback.set(medianLookback, streaks);
    }

    return { medians, streaks };
}

export const candle_pattern_persistence_score_median_deviation_streak: Strategy = {
    name: "Candle Pattern Persistence Score (Median Deviation Streak)",
    description: "CPPS entries filtered by same-direction rolling median streak persistence, with Min Avg Body % disabled.",
    defaultParams: {
        scoreLookback: 5,
        medianLookback: 20,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        medianLookback: "Median Lookback",
    },
    normalizeParams: normalizeCandlePatternPersistenceScoreMedianDeviationStreakParams,
    prepareFinderData: (data) => prepareCandlePatternPersistenceMedianDeviationData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedCandlePatternPersistenceMedianDeviationData(preparedData, data);
        const normalizedParams = normalizeCandlePatternPersistenceScoreMedianDeviationStreakParams(params);
        const scoreLookback = normalizedParams.scoreLookback as number;
        const medianLookback = normalizedParams.medianLookback as number;

        if (prepared.cleanData.length < 3) return [];

        const { avgScore, avgBodyPct } = getPreparedScoreSeries(prepared, scoreLookback);
        const { medians, streaks } = getPreparedMedianStreakSeries(prepared, medianLookback);

        return createSignalLoop(prepared.cleanData, [avgScore, avgBodyPct, medians], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const streak = streaks[i];

            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            if (score > 0 && streak > 0) {
                return createBuySignal(
                    prepared.cleanData,
                    i,
                    `CPPS bullish > 0 + Median Streak > 0`
                );
            }
            if (score < 0 && streak < 0) {
                return createSellSignal(
                    prepared.cleanData,
                    i,
                    `CPPS bearish < 0 + Median Streak < 0`
                );
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        candle_pattern_persistence_score_median_deviation_streak.executePrepared?.(
            prepareCandlePatternPersistenceMedianDeviationData(data),
            params,
            data
        ) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback", "medianLookback"],
    },
};
