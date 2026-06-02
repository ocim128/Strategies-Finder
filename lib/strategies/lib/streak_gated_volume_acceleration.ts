import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingZScore, buildStreakCount } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming return streak counts are robust and volume z-score threshold isolates true institutional interest without fake-outs.
// #SUGGEST_VERIFY: Verify return streak count calculation handles quiet/flat bars without resetting to incorrect states.
function normalizeStreakGatedVolumeAccelerationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        streakThreshold: Math.max(2, Math.round(Number(params.streakThreshold ?? 4))),
    };
}

export const streak_gated_volume_acceleration: Strategy = {
    name: "Streak Gated Volume Acceleration",
    description: "Filters early-stage high-conviction trends by requiring a persistent return direction streak aligned with an expanding volume Z-score.",
    defaultParams: {
        lookback: 30,
        streakThreshold: 4,
    },
    paramLabels: {
        lookback: "Z-score Lookback",
        streakThreshold: "Streak Threshold",
    },
    normalizeParams: normalizeStreakGatedVolumeAccelerationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeStreakGatedVolumeAccelerationParams(params);
        const lookback = p.lookback as number;
        const streakThreshold = p.streakThreshold as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        // Calculate return direction flags
        const returnFlags: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const diff = closes[i] - closes[i - 1];
            returnFlags[i] = diff > 0 ? 1 : diff < 0 ? -1 : 0;
        }

        const streaks = buildStreakCount(returnFlags);
        const volZ = buildRollingZScore(volumes, lookback);

        return createSignalLoop(cleanData, [volZ], (i) => {
            if (i < lookback) return null;
            const currentStreak = streaks[i];
            const currentVolZ = volZ[i];

            if (currentVolZ === null) return null;

            // Trigger when volume Z-score is greater than 1.5
            if (currentVolZ > 1.5) {
                // Bullish: Streak of positive returns reaches streakThreshold
                if (currentStreak >= streakThreshold) {
                    return createBuySignal(cleanData, i, `Streak Gated Volume Bullish (streak=${currentStreak}, volZ=${currentVolZ.toFixed(2)})`);
                }
                // Bearish: Streak of negative returns reaches streakThreshold
                if (currentStreak <= -streakThreshold) {
                    return createSellSignal(cleanData, i, `Streak Gated Volume Bearish (streak=${currentStreak}, volZ=${currentVolZ.toFixed(2)})`);
                }
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
