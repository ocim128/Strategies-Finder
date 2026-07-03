import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildStreakCount, buildPercentileRank } from "./price-action-statistics-core";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 3))),
    };
}

export const initiative_pressure_streak_follow: Strategy = {
    name: "Initiative Pressure Streak Follow",
    description: "Follows persistent initiative pressure streaks supported by high volume percentiles.",
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

        const ip = buildInitiativePressureSeries(cleanData, lookback);
        const flags = ip.map((val) => (val !== null && val > 0 ? 1 : val !== null && val < 0 ? -1 : 0));
        const streaks = buildStreakCount(flags);

        const volumes = cleanData.map((d) => d.volume);
        const volPct = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [volPct], (i) => {
            if (i < lookback) return null;
            const currentVolPct = volPct[i];
            if (currentVolPct === null) return null;

            const streak = streaks[i];

            // Buy: positive initiative pressure streak >= minStreak, volume percentile > 0.65
            if (streak >= minStreak && currentVolPct > 0.65) {
                return createBuySignal(cleanData, i, `IP Streak Follow Buy: Streak ${streak}, VolPct ${currentVolPct.toFixed(2)}`);
            }
            // Sell: negative initiative pressure streak <= -minStreak, volume percentile > 0.65
            if (streak <= -minStreak && currentVolPct > 0.65) {
                return createSellSignal(cleanData, i, `IP Streak Follow Sell: Streak ${streak}, VolPct ${currentVolPct.toFixed(2)}`);
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
