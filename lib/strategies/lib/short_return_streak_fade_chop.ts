import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildStreakCount } from "./price-action-statistics-core";

const STREAK_FADE_MIN = 3;

export const short_return_streak_fade_chop: Strategy = {
    name: "Short Return Streak Fade Chop",
    description: "Fades 3-bar same-sign return streaks, tuned for choppy markets where directional moves exhaust faster than the 5-bar threshold.",
    defaultParams: {},
    paramLabels: {},
    execute: (data: OHLCVData[], _params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < STREAK_FADE_MIN + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const signs = returns.map((r) => (r !== null && r > 0 ? 1 : r !== null && r < 0 ? -1 : 0));
        const streaks = buildStreakCount(signs);

        return createSignalLoop(cleanData, [streaks], (i) => {
            const streak = streaks[i];

            if (streak <= -STREAK_FADE_MIN) {
                return createBuySignal(cleanData, i, `Short return streak fade: negative streak ${streak}`);
            }
            if (streak >= STREAK_FADE_MIN) {
                return createSellSignal(cleanData, i, `Short return streak fade: positive streak ${streak}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: [],
    },
};
