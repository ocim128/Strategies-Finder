import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 3))),
    };
}

export const typical_close_acceptance_streak: Strategy = {
    name: "Typical Close Acceptance Streak",
    description: "Trend entry triggered by a consecutive streak of typical price exceeding or lagging the close price.",
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
        const typical = getTypicalPrices(cleanData);

        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            if (typical[i] > closes[i]) {
                flags[i] = 1;
            } else if (typical[i] < closes[i]) {
                flags[i] = -1;
            }
        }

        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            const streak = streaks[i];

            // Buy: streak of typical > close >= minStreak
            if (streak >= minStreak) {
                return createBuySignal(cleanData, i, `Typical Close Streak Buy: Streak ${streak}`);
            }
            // Sell: streak of typical < close <= -minStreak
            if (streak <= -minStreak) {
                return createSellSignal(cleanData, i, `Typical Close Streak Sell: Streak ${streak}`);
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
