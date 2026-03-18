import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { calculateMACD } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

function normalizeCandlePatternPersistenceScoreMacdZeroParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        scoreLookback: Math.max(2, Math.round(params.scoreLookback ?? 5)),
        scoreThreshold: Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6)),
        macdFastLen: Math.max(2, Math.round(params.macdFastLen ?? 12)),
    };
}

export const candle_pattern_persistence_score_macd_zero: Strategy = {
    name: "Candle Pattern Persistence Score (MACD Zero-Line)",
    description: "CPPS entries filtered by MACD line above/below zero. Smoother than histogram; resists whipsaw during minor pullbacks.",
    defaultParams: {
        scoreLookback: 5,
        scoreThreshold: 0.6,
        macdFastLen: 12,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        scoreThreshold: "Persistence Threshold",
        macdFastLen: "MACD Fast Period",
    },
    normalizeParams: normalizeCandlePatternPersistenceScoreMacdZeroParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const macdFastLen = Math.max(2, Math.round(params.macdFastLen ?? 12));
        const macdSlowLen = Math.max(macdFastLen + 1, Math.round(macdFastLen * 2));
        const macdSignalLen = Math.max(2, Math.round(macdFastLen / 2));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const { macd } = calculateMACD(closes, macdFastLen, macdSlowLen, macdSignalLen);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, macd], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const macdNow = macd[i] as number;

            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            if (score > scoreThreshold && macdNow > 0) {
                return createBuySignal(cleanData, i, "CPPS bullish + MACD > 0");
            }
            if (score < -scoreThreshold && macdNow < 0) {
                return createSellSignal(cleanData, i, "CPPS bearish + MACD < 0");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback", "scoreThreshold", "macdFastLen"],
    },
};
