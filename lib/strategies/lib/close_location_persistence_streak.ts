import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

function normalizeCloseLocationPersistenceStreakParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streak_threshold: Math.max(1, Math.round(Number(params.streak_threshold ?? 4))),
    };
}

export const close_location_persistence_streak: Strategy = {
    name: "Close Location Persistence Streak",
    description:
        "Signals when the close location inside each daily range persists above or below the bar centerline for consecutive sessions.",
    defaultParams: {
        streak_threshold: 4,
    },
    paramLabels: {
        streak_threshold: "Streak Threshold",
    },
    normalizeParams: normalizeCloseLocationPersistenceStreakParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseLocationPersistenceStreakParams(params);
        const streakThreshold = p.streak_threshold as number;
        if (cleanData.length < streakThreshold + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const locationMedian = buildRollingMedian(closeLocation, streakThreshold);
        const locationFlags = closeLocation.map((location) => {
            if (location > 0.5) return 1;
            if (location < 0.5) return -1;
            return 0;
        });
        const streaks = buildStreakCount(locationFlags);

        return createSignalLoop(cleanData, [locationMedian], (i) => {
            const medianLocation = locationMedian[i];
            if (medianLocation === null) return null;

            if (streaks[i] >= streakThreshold && medianLocation > 0.5) {
                return createBuySignal(cleanData, i, `Upper close-location streak ${streaks[i]}`);
            }
            if (streaks[i] <= -streakThreshold && medianLocation < 0.5) {
                return createSellSignal(cleanData, i, `Lower close-location streak ${Math.abs(streaks[i])}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streak_threshold"],
    },
};
