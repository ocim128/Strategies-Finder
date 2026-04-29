import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeRangeExtremeAcceptancePersistenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        streak_required: Math.max(1, Math.round(Number(params.streak_required ?? 5))),
    };
}

export const range_extreme_acceptance_persistence: Strategy = {
    name: "Range Extreme Acceptance Persistence",
    description:
        "Requires repeated daily closes outside the prior trailing range before accepting a breakout as real, filtering single-bar fake-outs.",
    defaultParams: {
        lookback: 63,
        streak_required: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        streak_required: "Streak Required",
    },
    normalizeParams: normalizeRangeExtremeAcceptancePersistenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRangeExtremeAcceptancePersistenceParams(params);
        const lookback = p.lookback as number;
        const streakRequired = p.streak_required as number;
        if (cleanData.length < lookback + streakRequired) return [];

        const closes = getCloses(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const flags = new Array(cleanData.length).fill(0);

        for (let i = 0; i < cleanData.length; i++) {
            const priorHigh = highest[i];
            const priorLow = lowest[i];
            if (priorHigh === null || priorLow === null) continue;
            if (closes[i] > priorHigh) {
                flags[i] = 1;
            } else if (closes[i] < priorLow) {
                flags[i] = -1;
            }
        }

        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [highest, lowest], (i) => {
            if (streaks[i] >= streakRequired) {
                return createBuySignal(cleanData, i, `Accepted above prior range for ${streaks[i]} days`);
            }
            if (streaks[i] <= -streakRequired) {
                return createSellSignal(cleanData, i, `Accepted below prior range for ${Math.abs(streaks[i])} days`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streak_required"],
    },
};
