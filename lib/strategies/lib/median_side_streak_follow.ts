import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

const SIDE_STREAK_FLOOR = 3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const median_side_streak_follow: Strategy = {
    name: "Median Side Streak Follow",
    description: "Follows streaks of consecutive closes on the same side of the rolling median.",
    defaultParams: {
        lookback: 40,
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

        const side = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            side[i] = m === null ? 0 : closes[i] > m ? 1 : -1;
        }
        const streak = buildStreakCount(side);

        return createSignalLoop(cleanData, [median], (i) => {
            const s = streak[i];
            if (s >= SIDE_STREAK_FLOOR) {
                return createBuySignal(cleanData, i, `Median-side streak ${s}`);
            }
            if (s <= -SIDE_STREAK_FLOOR) {
                return createSellSignal(cleanData, i, `Median-side streak ${s}`);
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
