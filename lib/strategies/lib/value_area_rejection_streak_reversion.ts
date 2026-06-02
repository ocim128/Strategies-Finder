import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming failed breakouts out of value area quickly revert to POC.
// #SUGGEST_VERIFY: Verify maxStreak (>= 1) limits weak breakouts accurately.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
        maxStreak: Math.max(1, Math.round(Number(params.maxStreak ?? 3))),
    };
}

export const value_area_rejection_streak_reversion: Strategy = {
    name: "Value Area Rejection Streak Reversion",
    description: "Reverts to POC when a breakout outside VAH/VAL fails to generate a persistent close acceptance streak and crosses back inside.",
    defaultParams: {
        lookback: 60,
        maxStreak: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        maxStreak: "Max Streak",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const maxStreak = p.maxStreak as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const { vah, val } = buildRollingValueArea(cleanData, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const streaks = buildStreakCount(acceptance);

        // Pre-track consecutive bars spent outside VAL or VAH
        const consecutiveBelowVal: number[] = new Array(cleanData.length).fill(0);
        const consecutiveAboveVah: number[] = new Array(cleanData.length).fill(0);

        for (let i = 1; i < cleanData.length; i++) {
            const v = val[i - 1];
            const h = vah[i - 1];
            if (v === null || h === null) continue;
            consecutiveBelowVal[i] = closes[i - 1] < v ? consecutiveBelowVal[i - 1] + 1 : 0;
            consecutiveAboveVah[i] = closes[i - 1] > h ? consecutiveAboveVah[i - 1] + 1 : 0;
        }

        return createSignalLoop(cleanData, [val, vah], (i) => {
            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentVal = val[i];
            const prevVal = val[i - 1];
            const currentVah = vah[i];
            const prevVah = vah[i - 1];

            if (currentVal === null || prevVal === null || currentVah === null || prevVah === null) return null;

            // Buy: Close crosses above VAL (re-entering from below) after a negative close acceptance streak failed to exceed maxStreak
            const wasBelow = consecutiveBelowVal[i] > 0;
            const crossedAboveVal = prevClose <= prevVal && currentClose > currentVal;
            if (wasBelow && crossedAboveVal) {
                // Check if the previous bar had a negative streak length that was small (failed to persist)
                const prevStreak = streaks[i - 1];
                if (prevStreak < 0 && prevStreak >= -maxStreak) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish Value Area reclaim: negative streak of ${prevStreak} failed to exceed max ${maxStreak}`
                    );
                }
            }

            // Sell: Close crosses below VAH (re-entering from above) after a positive close acceptance streak failed to exceed maxStreak
            const wasAbove = consecutiveAboveVah[i] > 0;
            const crossedBelowVah = prevClose >= prevVah && currentClose < currentVah;
            if (wasAbove && crossedBelowVah) {
                const prevStreak = streaks[i - 1];
                if (prevStreak > 0 && prevStreak <= maxStreak) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish Value Area reject: positive streak of ${prevStreak} failed to exceed max ${maxStreak}`
                    );
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxStreak"],
    },
};
