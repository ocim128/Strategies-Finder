import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { calculateMACD } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

function normalizeCandlePatternPersistenceScoreMacdHistSlopeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        scoreLookback: Math.max(2, Math.round(params.scoreLookback ?? 5)),
        scoreThreshold: Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6)),
        macdFastLen: Math.max(2, Math.round(params.macdFastLen ?? 12)),
    };
}

export const candle_pattern_persistence_score_macd_hist_slope: Strategy = {
    name: "Candle Pattern Persistence Score (MACD Hist Slope)",
    description: "CPPS entries filtered by histogram acceleration — requires momentum to be increasing, not just positive.",
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
    normalizeParams: normalizeCandlePatternPersistenceScoreMacdHistSlopeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const macdFastLen = Math.max(2, Math.round(params.macdFastLen ?? 12));
        const macdSlowLen = Math.max(macdFastLen + 1, Math.round(macdFastLen * 2));
        const macdSignalLen = Math.max(2, Math.round(macdFastLen / 2));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const { histogram } = calculateMACD(closes, macdFastLen, macdSlowLen, macdSignalLen);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, histogram], (i) => {
            if (i < 1) return null;
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const histNow = histogram[i];
            const histPrev = histogram[i - 1];

            if (histNow === null || histPrev === null) return null;
            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            // Buy: histogram positive AND increasing (accelerating bullish momentum)
            if (score > scoreThreshold && histNow > 0 && histNow > histPrev) {
                return createBuySignal(cleanData, i, "CPPS bullish + hist accelerating up");
            }
            // Sell: histogram negative AND decreasing (accelerating bearish momentum)
            if (score < -scoreThreshold && histNow < 0 && histNow < histPrev) {
                return createSellSignal(cleanData, i, "CPPS bearish + hist accelerating down");
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
