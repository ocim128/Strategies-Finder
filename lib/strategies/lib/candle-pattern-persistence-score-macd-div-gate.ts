import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { calculateMACD } from "../indicators";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    CPPS_MIN_BODY_PCT_HARDCODED,
    computeCandlePatternPersistenceState,
} from "./candle-pattern-persistence-core";

export const candle_pattern_persistence_score_macd_div_gate: Strategy = {
    name: "Candle Pattern Persistence Score (MACD Divergence Gate)",
    description: "CPPS entries blocked when price-MACD divergence is detected — early warning of regime reversal.",
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
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const scoreThreshold = Math.max(0, Math.min(1, params.scoreThreshold ?? 0.6));
        const macdFastLen = Math.max(2, Math.round(params.macdFastLen ?? 12));
        const macdSlowLen = Math.max(macdFastLen + 1, Math.round(macdFastLen * 2));
        const macdSignalLen = Math.max(2, Math.round(macdFastLen / 2));

        const state = computeCandlePatternPersistenceState(data, params.scoreLookback ?? 5);
        const { cleanData, closes, highs, lows, avgScore, avgBodyPct } = state;
        if (cleanData.length < 3) return [];

        const { macd } = calculateMACD(closes, macdFastLen, macdSlowLen, macdSignalLen);

        // Divergence lookback window derived from MACD fast period
        const divLookback = Math.max(3, Math.round(macdFastLen));

        return createSignalLoop(cleanData, [avgScore, avgBodyPct, macd], (i) => {
            if (i < divLookback) return null;
            const score = avgScore[i] as number;
            const avgBody = avgBodyPct[i] as number;
            const macdNow = macd[i];

            if (macdNow === null) return null;
            if (avgBody < CPPS_MIN_BODY_PCT_HARDCODED) return null;

            // Check for bearish divergence: price making higher high but MACD isn't
            let bearishDiv = false;
            // Check for bullish divergence: price making lower low but MACD isn't
            let bullishDiv = false;

            const windowStart = i - divLookback + 1;

            // Find highest high / lowest low and their MACD in the lookback window (excluding current bar)
            let maxHigh = -Infinity;
            let maxHighMacd = -Infinity;
            let minLow = Infinity;
            let minLowMacd = Infinity;

            for (let j = windowStart; j < i; j++) {
                const m = macd[j];
                if (m === null) continue;

                if (highs[j] > maxHigh) {
                    maxHigh = highs[j];
                    maxHighMacd = m;
                }
                if (lows[j] < minLow) {
                    minLow = lows[j];
                    minLowMacd = m;
                }
            }

            // Bearish divergence: current high > previous max high, but MACD lower
            if (highs[i] > maxHigh && macdNow < maxHighMacd) {
                bearishDiv = true;
            }
            // Bullish divergence: current low < previous min low, but MACD higher
            if (lows[i] < minLow && macdNow > minLowMacd) {
                bullishDiv = true;
            }

            // Block buys on bearish divergence, block sells on bullish divergence
            if (score > scoreThreshold && !bearishDiv) {
                return createBuySignal(cleanData, i, "CPPS bullish + no bearish divergence");
            }
            if (score < -scoreThreshold && !bullishDiv) {
                return createSellSignal(cleanData, i, "CPPS bearish + no bullish divergence");
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
