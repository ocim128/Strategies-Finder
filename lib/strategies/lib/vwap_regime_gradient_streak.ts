import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 3))),
    };
}

export const vwap_regime_gradient_streak: Strategy = {
    name: "VWAP Regime Gradient Streak",
    description: "Trend entry triggered by a streak of consecutive close location gradients away from the rolling VWAP center.",
    defaultParams: {
        lookback: 30,
        minStreak: 3,
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
        const volumes = cleanData.map((d) => d.volume);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const signals: Signal[] = [];
        let previousCloseLocation = 0.5;
        let streak = 0;
        for (let i = 1; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const range = Math.max(0, bar.high - bar.low);
            const closeLocation = range <= 0
                ? 0.5
                : Math.max(0, Math.min(1, (bar.close - bar.low) / range));
            const grad = closeLocation - previousCloseLocation;
            previousCloseLocation = closeLocation;
            if (grad > 0) {
                streak = streak > 0 ? streak + 1 : 1;
            } else if (grad < 0) {
                streak = streak < 0 ? streak - 1 : -1;
            } else {
                streak = 0;
            }

            if (i < lookback) continue;
            const currentVwap = vwap[i];
            if (currentVwap === null) continue;

            const close = closes[i];
            // Buy: price is above VWAP, positive gradient streak >= minStreak
            if (close > currentVwap && streak >= minStreak) {
                signals.push(createBuySignal(cleanData, i, `VWAP Grad Streak Buy: Streak ${streak}`));
                continue;
            }
            // Sell: price is below VWAP, negative gradient streak <= -minStreak
            if (close < currentVwap && streak <= -minStreak) {
                signals.push(createSellSignal(cleanData, i, `VWAP Grad Streak Sell: Streak ${streak}`));
            }
        }
        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minStreak"],
    },
};
