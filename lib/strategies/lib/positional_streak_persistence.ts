import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

const STREAK_FLOOR = 3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 20))),
    };
}

export const positional_streak_persistence: Strategy = {
    name: "Positional Streak Persistence",
    description: "Follows streaks of closes on the same side of the rolling median when the current bar agrees.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Median Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        // Fill warm-up nulls with the last available median so the streak is
        // continuous once the median exists; before the first median the bar has
        // no side (flag 0), which resets the streak.
        const filledMedian = new Array<number>(cleanData.length).fill(0);
        let lastMedian: number | null = null;
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            if (m !== null) lastMedian = m;
            filledMedian[i] = lastMedian ?? closes[i];
        }

        const side = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const c = closes[i];
            const m = filledMedian[i];
            side[i] = c > m ? 1 : c < m ? -1 : 0;
        }
        const streak = buildStreakCount(side);

        return createSignalLoop(cleanData, [], (i) => {
            const s = streak[i];

            if (s >= STREAK_FLOOR && closes[i] > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Positional streak above median: ${s}`);
            }
            if (s <= -STREAK_FLOOR && closes[i] < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Positional streak below median: ${s}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
