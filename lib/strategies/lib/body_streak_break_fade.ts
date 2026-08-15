import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeBodyStreakBreakFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakMin: Math.max(2, Math.round(Number(params.streakMin ?? 3))),
    };
}

export const body_streak_break_fade: Strategy = {
    name: "Body Streak Break Fade",
    description: "Fades a same-direction body streak the moment the first opposite body breaks it, entering on the exhaustion event.",
    defaultParams: {
        streakMin: 3,
    },
    paramLabels: {
        streakMin: "Minimum Streak",
    },
    normalizeParams: normalizeBodyStreakBreakFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const streakMin = normalizeBodyStreakBreakFadeParams(params).streakMin as number;

        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const streak = buildStreakCount(bodyDirection);

        return createSignalLoop(cleanData, [], (i) => {
            if (i === 0) return null;
            if (streak[i - 1] <= -streakMin && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Body streak break buy: ${-streak[i - 1]} down bodies broken by an up body`);
            }
            if (streak[i - 1] >= streakMin && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Body streak break sell: ${streak[i - 1]} up bodies broken by a down body`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakMin"],
    },
};
