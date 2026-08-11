import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

const EXTREME_CLOSE = 0.8;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakLength: Math.max(2, Math.round(Number(params.streakLength ?? 3))),
    };
}

export const close_location_streak_continuation: Strategy = {
    name: "Close Location Streak Continuation",
    description: "Rides streaks of consecutive bars closing in the extreme upper or lower portion of their own ranges.",
    defaultParams: {
        streakLength: 3,
    },
    paramLabels: {
        streakLength: "Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const streakLength = p.streakLength as number;
        if (cleanData.length < streakLength) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const flags = closeLocation.map((loc) => {
            if (loc === null) return 0;
            if (loc >= EXTREME_CLOSE) return 1;
            if (loc <= 1 - EXTREME_CLOSE) return -1;
            return 0;
        });
        const streak = buildStreakCount(flags);

        return createSignalLoop(cleanData, [streak], (i) => {
            // Fires only when the streak first reaches the threshold; a longer
            // streak reads as a larger magnitude, so the equality check is a
            // genuine first-touch (no repeat entries mid-streak).
            if (streak[i] === streakLength) {
                return createBuySignal(cleanData, i, `Close-location buy streak: ${streakLength} consecutive extreme-high closes`);
            }
            if (streak[i] === -streakLength) {
                return createSellSignal(cleanData, i, `Close-location sell streak: ${streakLength} consecutive extreme-low closes`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakLength"],
    },
};
