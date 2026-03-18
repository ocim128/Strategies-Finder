import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { calculateMACD } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

function normalizeCandlePatternPersistenceScoreMacdDualTfParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        scoreLookback: Math.max(2, Math.round(params.scoreLookback ?? 5)),
        scoreThreshold: Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6)),
        macdFastLen: Math.max(2, Math.round(params.macdFastLen ?? 8)),
    };
}

export const candle_pattern_persistence_score_macd_dual_tf: Strategy = {
    name: "Candle Pattern Persistence Score (MACD Dual TF)",
    description: "CPPS entries confirmed by two MACD timeframes — short catches momentum, long guards against regime change.",
    defaultParams: {
        scoreLookback: 5,
        scoreThreshold: 0.6,
        macdFastLen: 8,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        scoreThreshold: "Persistence Threshold",
        macdFastLen: "MACD Short Fast Period",
    },
    normalizeParams: normalizeCandlePatternPersistenceScoreMacdDualTfParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const macdFastLen = Math.max(2, Math.round(params.macdFastLen ?? 8));

        // Short MACD: fast period as given
        const shortSlow = Math.max(macdFastLen + 1, Math.round(macdFastLen * 2));
        const shortSignal = Math.max(2, Math.round(macdFastLen / 2));

        // Long MACD: fast period doubled for regime-level filtering
        const longFast = Math.round(macdFastLen * 2);
        const longSlow = Math.max(longFast + 1, Math.round(longFast * 2));
        const longSignal = Math.max(2, Math.round(longFast / 2));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const shortMACD = calculateMACD(closes, macdFastLen, shortSlow, shortSignal);
        const longMACD = calculateMACD(closes, longFast, longSlow, longSignal);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, shortMACD.histogram, longMACD.histogram], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const shortHist = shortMACD.histogram[i];
            const longHist = longMACD.histogram[i];

            if (shortHist === null || longHist === null) return null;
            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            // Buy only when BOTH short and long histogram are positive
            if (score > scoreThreshold && shortHist > 0 && longHist > 0) {
                return createBuySignal(cleanData, i, "CPPS bullish + dual MACD agree up");
            }
            // Sell only when BOTH short and long histogram are negative
            if (score < -scoreThreshold && shortHist < 0 && longHist < 0) {
                return createSellSignal(cleanData, i, "CPPS bearish + dual MACD agree down");
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
