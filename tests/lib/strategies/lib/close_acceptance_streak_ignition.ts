import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming close acceptance streak flags correctly isolate micro-structure momentum aligned with median centerline.
// #SUGGEST_VERIFY: Verify streak counts reset cleanly when close acceptance changes sign or falls to zero.
function normalizeCloseAcceptanceStreakIgnitionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
        streakThreshold: Math.max(2, Math.round(Number(params.streakThreshold ?? 4))),
    };
}

export const close_acceptance_streak_ignition: Strategy = {
    name: "Close Acceptance Streak Ignition",
    description: "Confirms early trend momentum when price registers consecutive close acceptance above or below the rolling median.",
    defaultParams: {
        lookback: 50,
        streakThreshold: 4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        streakThreshold: "Streak Threshold",
    },
    normalizeParams: normalizeCloseAcceptanceStreakIgnitionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseAcceptanceStreakIgnitionParams(params);
        const lookback = p.lookback as number;
        const streakThreshold = p.streakThreshold as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        // Convert close acceptance to directional streak flags: +1 for positive, -1 for negative, 0 for zero
        const flags = closeAcceptance.map(v => v > 0 ? 1 : v < 0 ? -1 : 0);
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [median], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentMedian = median[i];
            const currentStreak = streaks[i];

            if (currentMedian === null) return null;

            // Buy logic: Close is above rolling median, and the positive close acceptance series streak reaches streakThreshold
            if (currentClose > currentMedian && currentStreak >= streakThreshold) {
                return createBuySignal(cleanData, i, `Close Acceptance Streak Bullish (streak=${currentStreak}, close=${currentClose.toFixed(2)}, median=${currentMedian.toFixed(2)})`);
            }

            // Sell logic: Close is below rolling median, and the negative close acceptance series streak reaches streakThreshold
            if (currentClose < currentMedian && currentStreak <= -streakThreshold) {
                return createSellSignal(cleanData, i, `Close Acceptance Streak Bearish (streak=${currentStreak}, close=${currentClose.toFixed(2)}, median=${currentMedian.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakThreshold"],
    },
};
