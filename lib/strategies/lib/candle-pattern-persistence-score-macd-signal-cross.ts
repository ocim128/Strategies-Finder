import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { calculateMACD } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

function normalizeCandlePatternPersistenceScoreMacdSignalCrossParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        scoreLookback: Math.max(2, Math.round(params.scoreLookback ?? 5)),
        scoreThreshold: Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6)),
        macdFastLen: Math.max(2, Math.round(params.macdFastLen ?? 12)),
    };
}

export const candle_pattern_persistence_score_macd_signal_cross: Strategy = {
    name: "Candle Pattern Persistence Score (MACD Signal Cross)",
    description: "CPPS entries only on fresh MACD/signal crossovers. Catches momentum starts, blocks exhausted trends.",
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
    normalizeParams: normalizeCandlePatternPersistenceScoreMacdSignalCrossParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const macdFastLen = Math.max(2, Math.round(params.macdFastLen ?? 12));
        const macdSlowLen = Math.max(macdFastLen + 1, Math.round(macdFastLen * 2));
        const macdSignalLen = Math.max(2, Math.round(macdFastLen / 2));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, closes, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const { macd, signal } = calculateMACD(closes, macdFastLen, macdSlowLen, macdSignalLen);

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, macd, signal], (i) => {
            if (i < 1) return null;
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const macdNow = macd[i];
            const macdPrev = macd[i - 1];
            const sigNow = signal[i];
            const sigPrev = signal[i - 1];

            if (macdNow === null || macdPrev === null || sigNow === null || sigPrev === null) return null;
            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            const bullCross = macdPrev <= sigPrev && macdNow > sigNow;
            const bearCross = macdPrev >= sigPrev && macdNow < sigNow;

            if (score > scoreThreshold && bullCross) {
                return createBuySignal(cleanData, i, "CPPS bullish + MACD signal cross up");
            }
            if (score < -scoreThreshold && bearCross) {
                return createSellSignal(cleanData, i, "CPPS bearish + MACD signal cross down");
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
