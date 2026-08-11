import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

const MEDIAN_WINDOW = 60;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakLength: Math.max(3, Math.round(Number(params.streakLength ?? 8))),
    };
}

export const median_time_stretch_reversion: Strategy = {
    name: "Median Time Stretch Reversion",
    description: "Fades when closes have spent an abnormally long run of bars on one side of their rolling median.",
    defaultParams: {
        streakLength: 8,
    },
    paramLabels: {
        streakLength: "Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const streakLength = p.streakLength as number;
        if (cleanData.length < MEDIAN_WINDOW) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, MEDIAN_WINDOW);

        // Flags are +1 below the median and -1 above it; buildStreakCount
        // propagates the flag sign, so the magnitude reads the streak length.
        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const med = median[i];
            if (med === null || closes[i] === med) {
                flags[i] = 0;
            } else {
                flags[i] = closes[i] < med ? 1 : -1;
            }
        }
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [streaks], (i) => {
            const streak = streaks[i];

            // Fire only when the below-median stretch first reaches the threshold.
            if (streak === streakLength) {
                return createBuySignal(cleanData, i, `Median time stretch buy: ${streakLength} consecutive closes below median`);
            }
            // Fire only when the above-median stretch first reaches the threshold.
            if (streak === -streakLength) {
                return createSellSignal(cleanData, i, `Median time stretch sell: ${streakLength} consecutive closes above median`);
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
