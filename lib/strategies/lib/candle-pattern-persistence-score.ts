import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from "../strategy-helpers";

function normalizeCandlePatternPersistenceScoreParams(params: StrategyParams): StrategyParams {
    const normalized: StrategyParams = {
        ...params,
        scoreLookback: Math.max(2, Math.round(params.scoreLookback ?? 5)),
        scoreThreshold: 0,
    };

    if ('minBodyPct' in params) {
        normalized.minBodyPct = 0;
    }

    return normalized;
}

export const candle_pattern_persistence_score: Strategy = {
    name: "Candle Pattern Persistence Score",
    description: "Builds a rolling directional candle-structure score and triggers entries when persistence crosses zero, with Persistence Threshold and Min Avg Body % disabled.",
    defaultParams: {
        scoreLookback: 5,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
    },
    normalizeParams: normalizeCandlePatternPersistenceScoreParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 3) return [];

        const normalized = normalizeCandlePatternPersistenceScoreParams(params);
        const scoreLookback = normalized.scoreLookback;
        const scoreThreshold = normalized.scoreThreshold;

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const bodyScore: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = 0; i < cleanData.length; i++) {
            const range = highs[i] - lows[i];
            if (range <= 0) continue;

            const signedBody = cleanData[i].close - cleanData[i].open;

            bodyScore[i] = Math.max(-1, Math.min(1, signedBody / range));
        }

        const avgScore: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = 0; i < cleanData.length; i++) {
            if (i < scoreLookback - 1) continue;

            let scoreSum = 0;
            let count = 0;

            for (let j = i - scoreLookback + 1; j <= i; j++) {
                const s = bodyScore[j];
                if (s === null) continue;
                scoreSum += s;
                count++;
            }

            if (count < scoreLookback) continue;
            avgScore[i] = scoreSum / count;
        }

        return createSignalLoop(cleanData, [avgScore], (i) => {
            const score = avgScore[i] as number;

            if (score > scoreThreshold) {
                return createBuySignal(cleanData, i, "Candle persistence bullish");
            }
            if (score < -scoreThreshold) {
                return createSellSignal(cleanData, i, "Candle persistence bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback"],
    },
};

