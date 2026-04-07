import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { CPPS_MIN_BODY_PCT_HARDCODED } from "./candle-pattern-persistence-core";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

type PatternRegimeAlignmentPrepared = {
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

function normalizePatternRegimeAlignmentParams(params: StrategyParams): StrategyParams {
    const scoreLookback = Math.max(2, Math.round(params.scoreLookback ?? 5));
    const medianLookback = Math.max(2, Math.round(params.medianLookback ?? 20));
    const rawSlowWindow = Number(params.slowWindow ?? 30);
    const roundedSlowWindow = Math.round(Number.isFinite(rawSlowWindow) ? rawSlowWindow : 30);
    const slowWindow = Math.max(medianLookback + 1, roundedSlowWindow);

    return {
        scoreLookback,
        medianLookback,
        slowWindow };
}

function preparePatternRegimeAlignmentData(data: OHLCVData[]): PatternRegimeAlignmentPrepared {
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
        streakByLookback: new Map<number, number[]>() };
}

function getPreparedPatternRegimeAlignmentData(
    preparedData: unknown,
    data: OHLCVData[]
): PatternRegimeAlignmentPrepared {
    if (preparedData && typeof preparedData === "object" && "avgScoreByLookback" in preparedData && "streakByLookback" in preparedData) {
        return preparedData as PatternRegimeAlignmentPrepared;
    }
    return preparePatternRegimeAlignmentData(data);
}

function getPreparedScoreSeries(
    prepared: PatternRegimeAlignmentPrepared,
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

function getPreparedMedianSeries(
    prepared: PatternRegimeAlignmentPrepared,
    lookback: number
): (number | null)[] {
    let medians = prepared.medianByLookback.get(lookback);
    if (!medians) {
        medians = buildRollingMedian(prepared.closes, lookback);
        prepared.medianByLookback.set(lookback, medians);
    }
    return medians;
}

function getPreparedMedianStreakSeries(
    prepared: PatternRegimeAlignmentPrepared,
    medianLookback: number
): { medians: (number | null)[]; streaks: number[] } {
    const medians = getPreparedMedianSeries(prepared, medianLookback);

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

export const pattern_regime_alignment: Strategy = {
    name: "Pattern Regime Alignment",
    description: "Combines rolling candle-body persistence, a faster median-deviation streak, and a slower median regime filter. Enters only when short-term candle pressure and price both agree with the broader directional regime.",
    defaultParams: {
        scoreLookback: 5,
        medianLookback: 20,
        slowWindow: 30 },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        medianLookback: "Median Streak Window",
        slowWindow: "Slow Regime Window" },
    normalizeParams: normalizePatternRegimeAlignmentParams,
    prepareFinderData: (data) => preparePatternRegimeAlignmentData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedPatternRegimeAlignmentData(preparedData, data);
        const normalizedParams = normalizePatternRegimeAlignmentParams(params);
        const scoreLookback = normalizedParams.scoreLookback as number;
        const medianLookback = normalizedParams.medianLookback as number;
        const slowWindow = normalizedParams.slowWindow as number;

        if (prepared.cleanData.length < slowWindow + 2) return [];

        const { avgScore, avgBodyPct } = getPreparedScoreSeries(prepared, scoreLookback);
        const { streaks } = getPreparedMedianStreakSeries(prepared, medianLookback);
        const slowMedians = getPreparedMedianSeries(prepared, slowWindow);

        return createSignalLoop(prepared.cleanData, [avgScore, avgBodyPct, slowMedians], (i) => {
            const score = avgScore[i];
            const avgBody = avgBodyPct[i];
            const slowMedian = slowMedians[i];
            const streak = streaks[i];

            if (score === null || avgBody === null || slowMedian === null) return null;
            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            if (score > 0 && streak > 0 && prepared.closes[i] > slowMedian) {
                return createBuySignal(
                    prepared.cleanData,
                    i,
                    "Pattern bullish + median streak + slow regime align"
                );
            }
            if (score < 0 && streak < 0 && prepared.closes[i] < slowMedian) {
                return createSellSignal(
                    prepared.cleanData,
                    i,
                    "Pattern bearish + median streak + slow regime align"
                );
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        pattern_regime_alignment.executePrepared?.(
            preparePatternRegimeAlignmentData(data),
            params,
            data
        ) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback", "medianLookback", "slowWindow"] } };
