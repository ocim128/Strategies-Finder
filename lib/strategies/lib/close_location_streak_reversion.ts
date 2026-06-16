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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        streakLength: Math.max(1, Math.round(Number(params.streakLength ?? 4))),
    };
}

export const close_location_streak_reversion: Strategy = {
    name: "Close Location Streak Reversion",
    description: "Fades buying/selling exhaustion after consecutive closes near extremes.",
    defaultParams: {
        lookback: 20,
        streakLength: 4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        streakLength: "Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);

        // Build flags array: +1 for cl > 0.80, -1 for cl < 0.20, 0 otherwise
        const flags: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const cl = closeLocation[i];
            if (cl > 0.80) {
                flags[i] = 1;
            } else if (cl < 0.20) {
                flags[i] = -1;
            }
        }

        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [streaks], (i) => {
            const streak = streaks[i];
            if (i < lookback) return null;

            // Buy: downside exhaustion (streak <= -streakLength)
            if (streak <= -p.streakLength) {
                return createBuySignal(cleanData, i, `Downside exhaustion streak of ${Math.abs(streak)} bars`);
            }
            // Sell: upside exhaustion (streak >= streakLength)
            if (streak >= p.streakLength) {
                return createSellSignal(cleanData, i, `Upside exhaustion streak of ${streak} bars`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakLength"],
    },
};
