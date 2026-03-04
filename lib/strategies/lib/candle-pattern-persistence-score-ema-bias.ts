import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { calculateEMA } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

export const candle_pattern_persistence_score_ema_bias: Strategy = {
    name: "Candle Pattern Persistence Score (EMA Bias)",
    description: "CPPS entries filtered by EMA trend alignment to reduce counter-trend flips.",
    defaultParams: {
        scoreLookback: 5,
        scoreThreshold: 0.6,
        emaLen: 100,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        scoreThreshold: "Persistence Threshold",
        emaLen: "EMA Period",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const emaLen = Math.max(2, Math.round(params.emaLen ?? 100));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const ema = calculateEMA(closes, emaLen);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, ema], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const emaNow = ema[i] as number;
            const close = cleanData[i].close;

            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            if (score > scoreThreshold && close > emaNow) {
                return createBuySignal(cleanData, i, "CPPS bullish + EMA trend");
            }
            if (score < -scoreThreshold && close < emaNow) {
                return createSellSignal(cleanData, i, "CPPS bearish + EMA trend");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback", "scoreThreshold", "emaLen"],
    },
};
