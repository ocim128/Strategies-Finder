import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { calculateStochastic } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

export const candle_pattern_persistence_score_stoch_mid: Strategy = {
    name: "Candle Pattern Persistence Score (Stochastic Mid)",
    description: "CPPS entries filtered by Stochastic mid-band regime to keep high signal frequency with directional bias.",
    defaultParams: {
        scoreLookback: 5,
        scoreThreshold: 0.6,
        stochLen: 14,
    },
    paramLabels: {
        scoreLookback: "Score Window (bars)",
        scoreThreshold: "Persistence Threshold",
        stochLen: "Stochastic %K Period",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const stochLen = Math.max(3, Math.round(params.stochLen ?? 14));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, highs, lows, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const { k } = calculateStochastic(highs, lows, closes, stochLen, 3);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, k], (i) => {
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const kNow = k[i] as number;

            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            if (score > scoreThreshold && kNow > 55) {
                return createBuySignal(cleanData, i, "CPPS bullish + Stoch mid-band");
            }
            if (score < -scoreThreshold && kNow < 45) {
                return createSellSignal(cleanData, i, "CPPS bearish + Stoch mid-band");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["scoreLookback", "scoreThreshold", "stochLen"],
    },
};
