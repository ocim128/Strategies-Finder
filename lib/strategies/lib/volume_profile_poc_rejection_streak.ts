import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming rolling Point of Control (POC) represents a strong value area center and rejection streaks are predictive.
// #SUGGEST_VERIFY: Verify POC rejection streak counts handles flat/consolidation phases safely.
function normalizeVolumeProfilePocRejectionStreakParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        minStreak: Math.max(2, Math.round(Number(params.minStreak ?? 4))),
    };
}

export const volume_profile_poc_rejection_streak: Strategy = {
    name: "Volume Profile POC Rejection Streak",
    description: "Signals after a failed break of the volume profile Point of Control (POC) followed by a persistent streak of close acceptance away from value.",
    defaultParams: {
        lookback: 50,
        minStreak: 4,
    },
    paramLabels: {
        lookback: "Profile Lookback",
        minStreak: "Min Acceptance Streak",
    },
    normalizeParams: normalizeVolumeProfilePocRejectionStreakParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeProfilePocRejectionStreakParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const { poc } = buildRollingValueArea(cleanData, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        const flags = closeAcceptance.map(v => v > 0 ? 1 : v < 0 ? -1 : 0);
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [poc], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentPoc = poc[i];
            const currentStreak = streaks[i];

            if (currentPoc === null) return null;

            // Buy logic: Close is above the POC, and a positive close acceptance streak has reached at least minStreak.
            if (currentClose > currentPoc && currentStreak >= minStreak) {
                return createBuySignal(cleanData, i, `POC Rejection Bullish Streak (streak=${currentStreak}, close=${currentClose.toFixed(2)}, POC=${currentPoc.toFixed(2)})`);
            }

            // Sell logic: Close is below the POC, and a negative close acceptance streak has reached at least minStreak.
            if (currentClose < currentPoc && currentStreak <= -minStreak) {
                return createSellSignal(cleanData, i, `POC Rejection Bearish Streak (streak=${currentStreak}, close=${currentClose.toFixed(2)}, POC=${currentPoc.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minStreak"],
    },
};
