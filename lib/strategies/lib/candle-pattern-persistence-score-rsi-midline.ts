import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { calculateRSI } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

export const candle_pattern_persistence_score_rsi_midline: Strategy = {
    name: "Candle Pattern Persistence Score (RSI Midline)",
    description: "CPPS entries filtered by RSI midline regime to keep frequent but directional trades.",
    defaultParams: {
        scoreLookback: 5,
        scoreThreshold: 0.6,
        rsiLen: 14,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        scoreThreshold: "Persistence Threshold",
        rsiLen: "RSI Period",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const rsiLen = Math.max(2, Math.round(params.rsiLen ?? 14));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const rsi = calculateRSI(closes, rsiLen);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, rsi], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const rsiNow = rsi[i] as number;

            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            if (score > scoreThreshold && rsiNow > 50) {
                return createBuySignal(cleanData, i, "CPPS bullish + RSI > 50");
            }
            if (score < -scoreThreshold && rsiNow < 50) {
                return createSellSignal(cleanData, i, "CPPS bearish + RSI < 50");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback", "scoreThreshold", "rsiLen"],
    },
};
