import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from "../strategy-helpers";

function normalizeCandlePatternPersistenceScoreParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        scoreLookback: Math.max(2, Math.round(params.scoreLookback ?? 5)),
        scoreThreshold: Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6)),
        minBodyPct: Math.max(0, Math.min(1, params.minBodyPct ?? 0.4)),
    };
}

export const candle_pattern_persistence_score: Strategy = {
    name: "Candle Pattern Persistence Score",
    description: "Builds a rolling directional candle-structure score and triggers entries when persistence crosses threshold.",
    defaultParams: {
        scoreLookback: 5,
        scoreThreshold: 0.6,
        minBodyPct: 0.4,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        scoreThreshold: "Persistence Threshold",
        minBodyPct: "Min Avg Body %",
    },
    normalizeParams: normalizeCandlePatternPersistenceScoreParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 3) return [];

        const scoreLookback = Math.max(2, Math.round(params.scoreLookback ?? 5));
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const minBodyPct = Math.max(0, Math.min(1, params.minBodyPct ?? 0.4));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const bodyScore: (number | null)[] = new Array(cleanData.length).fill(null);
        const bodyPct: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = 0; i < cleanData.length; i++) {
            const range = highs[i] - lows[i];
            if (range <= 0) continue;

            const signedBody = cleanData[i].close - cleanData[i].open;
            const absBody = Math.abs(signedBody);

            bodyScore[i] = Math.max(-1, Math.min(1, signedBody / range));
            bodyPct[i] = Math.max(0, Math.min(1, absBody / range));
        }

        const avgScore: (number | null)[] = new Array(cleanData.length).fill(null);
        const avgBodyPct: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = 0; i < cleanData.length; i++) {
            if (i < scoreLookback - 1) continue;

            let scoreSum = 0;
            let bodySum = 0;
            let count = 0;

            for (let j = i - scoreLookback + 1; j <= i; j++) {
                const s = bodyScore[j];
                const b = bodyPct[j];
                if (s === null || b === null) continue;
                scoreSum += s;
                bodySum += b;
                count++;
            }

            if (count < scoreLookback) continue;
            avgScore[i] = scoreSum / count;
            avgBodyPct[i] = bodySum / count;
        }

        return createSignalLoop(cleanData, [avgScore, avgBodyPct], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            if (avgBody < minBodyPct) return null;

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
        walkForwardParams: ["scoreLookback", "scoreThreshold", "minBodyPct"],
    },
};

