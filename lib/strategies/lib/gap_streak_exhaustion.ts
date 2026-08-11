import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildStreakCount, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakLength: Math.max(2, Math.round(Number(params.streakLength ?? 3))),
    };
}

export const gap_streak_exhaustion: Strategy = {
    name: "Gap Streak Exhaustion",
    description: "Fades consecutive same-direction opening gaps once the boundary-pressure run reaches the streak length.",
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
        if (cleanData.length < streakLength + 1) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const g = gapPct[i];
            if (g === 0) {
                flags[i] = 0;
            } else {
                flags[i] = g > 0 ? 1 : -1;
            }
        }
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [], (i) => {
            const streak = streaks[i];

            // Fire only when the down-gap run first reaches the threshold.
            if (streak === -streakLength) {
                return createBuySignal(cleanData, i, `Gap streak buy: ${streakLength} consecutive down gaps`);
            }
            // Fire only when the up-gap run first reaches the threshold.
            if (streak === streakLength) {
                return createSellSignal(cleanData, i, `Gap streak sell: ${streakLength} consecutive up gaps`);
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
