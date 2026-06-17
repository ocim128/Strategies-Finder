import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 3))),
        streakMin: Math.max(1, Math.round(Number(params.streakMin ?? 3))),
    };
}

export const close_location_streak_mean_reversion: Strategy = {
    name: "Close Location Streak Mean Reversion",
    description: "Fades persistent extreme close location streaks.",
    defaultParams: {
        lookback: 3,
        streakMin: 3,
    },
    paramLabels: {
        lookback: "Streak Lookback",
        streakMin: "Min Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        if (cleanData.length < p.streakMin) return [];

        const closeLoc = buildCloseLocationSeries(cleanData);

        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const cl = closeLoc[i];
            if (cl > 0.8) {
                flags[i] = 1;
            } else if (cl < 0.2) {
                flags[i] = -1;
            } else {
                flags[i] = 0;
            }
        }

        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [streaks], (i) => {
            const streak = streaks[i];

            // Buy: persistently closing at bottom
            if (streak <= -p.streakMin) {
                return createBuySignal(cleanData, i, `Close location bottom streak buy: streak ${streak}`);
            }
            // Sell: persistently closing at top
            if (streak >= p.streakMin) {
                return createSellSignal(cleanData, i, `Close location top streak sell: streak ${streak}`);
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
