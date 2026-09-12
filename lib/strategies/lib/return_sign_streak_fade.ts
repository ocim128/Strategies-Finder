import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 5))),
        streakMin: Math.max(1, Math.round(Number(params.streakMin ?? 5))),
    };
}

export const return_sign_streak_fade: Strategy = {
    name: "Return Sign Streak Fade",
    description: "Fades persistent same-sign return streaks when one leg has outperformed for multiple bars.",
    defaultParams: {
        lookback: 5,
        streakMin: 5,
    },
    paramLabels: {
        lookback: "ROC Period",
        streakMin: "Min Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, lookback);

        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const r = roc[i];
            if (r === null || r === 0) {
                flags[i] = 0;
            } else {
                flags[i] = r > 0 ? 1 : -1;
            }
        }

        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [roc], (i) => {
            const streak = streaks[i];
            const currentRoc = roc[i];
            if (currentRoc === null) return null;

            // Buy: Negative streak of at least streakMin bars
            if (streak <= -p.streakMin) {
                return createBuySignal(cleanData, i, `Negative return streak fade: streak ${streak}`);
            }
            // Sell: Positive streak of at least streakMin bars
            if (streak >= p.streakMin) {
                return createSellSignal(cleanData, i, `Positive return streak fade: streak ${streak}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakMin"],
    },
};
