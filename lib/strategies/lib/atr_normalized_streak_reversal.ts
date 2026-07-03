import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildStreakCount, buildRollingZScore } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 4))),
    };
}

export const atr_normalized_streak_reversal: Strategy = {
    name: "ATR-Normalized Streak Reversal",
    description: "Mean reversion after extreme streak of returns exceeding rolling ATR.",
    defaultParams: {
        lookback: 30,
        minStreak: 4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minStreak: "Min Streak Count",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const atr = calculateATR(highs, lows, closes, lookback);
        const zscore = buildRollingZScore(closes, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const atrVal = atr[i];
            if (atrVal !== null && atrVal > 0) {
                const ret = returns[i];
                if (ret > atrVal) {
                    flags[i] = 1;
                } else if (ret < -atrVal) {
                    flags[i] = -1;
                }
            }
        }

        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [zscore, closeLoc], (i) => {
            if (i < lookback) return null;
            const currentZ = zscore[i];
            const currentLoc = closeLoc[i];
            if (currentZ === null) return null;

            const streak = streaks[i];

            // Buy: downward streak of return exceeding ATR in magnitude >= minStreak, close z-score <= -1.8, and close location is between 0.4 and 0.6
            if (streak <= -minStreak && currentZ < -1.8 && currentLoc >= 0.4 && currentLoc <= 0.6) {
                return createBuySignal(cleanData, i, `ATR Streak Rev Buy: Streak ${streak}, Z ${currentZ.toFixed(2)}, Loc ${currentLoc.toFixed(2)}`);
            }
            // Sell: upward streak of return exceeding ATR in magnitude >= minStreak, close z-score >= 1.8, and close location is between 0.4 and 0.6
            if (streak >= minStreak && currentZ > 1.8 && currentLoc >= 0.4 && currentLoc <= 0.6) {
                return createSellSignal(cleanData, i, `ATR Streak Rev Sell: Streak ${streak}, Z ${currentZ.toFixed(2)}, Loc ${currentLoc.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minStreak"],
    },
};
