import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    calculateCCI,
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

function normalizeCandlePatternPersistenceScoreCciZeroParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        scoreLookback: Math.max(2, Math.round(params.scoreLookback ?? 5)),
        scoreThreshold: Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6)),
        cciLen: Math.max(2, Math.round(params.cciLen ?? 20)),
    };
}

export const candle_pattern_persistence_score_cci_zero: Strategy = {
    name: "Candle Pattern Persistence Score (CCI Zero)",
    description: "CPPS entries filtered by CCI zero-line direction for active momentum phase participation.",
    defaultParams: {
        scoreLookback: 5,
        scoreThreshold: 0.6,
        cciLen: 20,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        scoreThreshold: "Persistence Threshold",
        cciLen: "CCI Period",
    },
    normalizeParams: normalizeCandlePatternPersistenceScoreCciZeroParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const cciLen = Math.max(2, Math.round(params.cciLen ?? 20));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, highs, lows, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const cci = calculateCCI(highs, lows, closes, cciLen);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, cci], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const cciNow = cci[i] as number;

            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            if (score > scoreThreshold && cciNow > 0) {
                return createBuySignal(cleanData, i, "CPPS bullish + CCI > 0");
            }
            if (score < -scoreThreshold && cciNow < 0) {
                return createSellSignal(cleanData, i, "CPPS bearish + CCI < 0");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback", "scoreThreshold", "cciLen"],
    },
};
