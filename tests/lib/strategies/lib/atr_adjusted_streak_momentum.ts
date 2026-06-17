import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 3))),
    };
}

export const atr_adjusted_streak_momentum: Strategy = {
    name: "ATR Adjusted Streak Momentum",
    description: "Follows a typical price return streak in early-stage, low-volatility regimes.",
    defaultParams: {
        lookback: 25,
        minStreak: 3,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minStreak: "Min Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);
        const ranges = buildRangeSeries(cleanData);

        const typical = getTypicalPrices(cleanData);
        const typicalReturns = buildRateOfChange(typical, 1);

        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const r = typicalReturns[i];
            if (r === null || r === 0) {
                flags[i] = 0;
            } else {
                flags[i] = r > 0 ? 1 : -1;
            }
        }

        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [atr, typicalReturns], (i) => {
            const currentAtr = atr[i];
            if (currentAtr === null) return null;

            const streak = streaks[i];
            const range = ranges[i];

            // Buy: positive return streak and low volatility (range < 0.9 * ATR)
            if (streak >= p.minStreak && range < 0.9 * currentAtr) {
                return createBuySignal(cleanData, i, `Typical price positive streak: ${streak}, Range ${range.toFixed(4)} < 0.9*ATR`);
            }
            // Sell: negative return streak and low volatility (range < 0.9 * ATR)
            if (streak <= -p.minStreak && range < 0.9 * currentAtr) {
                return createSellSignal(cleanData, i, `Typical price negative streak: ${streak}, Range ${range.toFixed(4)} < 0.9*ATR`);
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
