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
import { calculateVWAP } from "../indicators";
import { buildStreakCount } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 3))),
    };
}

export const vwap_gradient_acceptance_streak: Strategy = {
    name: "VWAP Gradient Acceptance Streak",
    description: "Trend continuation triggered by a persistent streak of close location gradients away from the VWAP center.",
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
        const closeLoc = buildCloseLocationSeries(cleanData);

        const gradFlags = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const grad = closeLoc[i] - closeLoc[i - 1];
            if (grad > 0) {
                gradFlags[i] = 1;
            } else if (grad < 0) {
                gradFlags[i] = -1;
            }
        }

        const streaks = buildStreakCount(gradFlags);

        return createSignalLoop(cleanData, [vwap], (i) => {
            if (i < lookback) return null;
            const currentVwap = vwap[i];
            if (currentVwap === null) return null;

            const close = closes[i];
            const streak = streaks[i];

            // Buy: price is above VWAP, positive gradient streak >= minStreak
            if (close > currentVwap && streak >= minStreak) {
                return createBuySignal(cleanData, i, `VWAP Grad Streak Buy: Streak ${streak}`);
            }
            // Sell: price is below VWAP, negative gradient streak <= -minStreak
            if (close < currentVwap && streak <= -minStreak) {
                return createSellSignal(cleanData, i, `VWAP Grad Streak Sell: Streak ${streak}`);
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
