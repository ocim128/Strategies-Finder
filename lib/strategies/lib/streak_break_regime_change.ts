import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeStreakBreakRegimeChangeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakReq: Math.max(2, Math.round(Number(params.streakReq ?? 5))),
    };
}

export const streak_break_regime_change: Strategy = {
    name: "Streak Break Regime Change",
    description: "Follows the first counter-direction close that breaks a long same-direction close streak as a regime change.",
    defaultParams: {
        streakReq: 5,
    },
    paramLabels: {
        streakReq: "Min Prior Streak",
    },
    normalizeParams: normalizeStreakBreakRegimeChangeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeStreakBreakRegimeChangeParams(params);
        const streakReq = p.streakReq as number;
        if (cleanData.length < streakReq + 2) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const signFlags = closeReturn.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
        const streaks = buildStreakCount(signFlags);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            if (streaks[i - 1] <= -streakReq && streaks[i] > 0) {
                return createBuySignal(cleanData, i, `Down-close streak of ${-streaks[i - 1]} bars broken upward`);
            }
            if (streaks[i - 1] >= streakReq && streaks[i] < 0) {
                return createSellSignal(cleanData, i, `Up-close streak of ${streaks[i - 1]} bars broken downward`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakReq"],
    },
};
