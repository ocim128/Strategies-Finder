import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildStreakCount, buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        maxVolumePercentile: Number(params.maxVolumePercentile ?? 0.4),
    };
}

export const failed_streak_exhaustion_fade: Strategy = {
    name: "Failed Streak Exhaustion Fade",
    description: "Fades streak exhaustion when it occurs during a low-volume regime and z-score shows overextension.",
    defaultParams: {
        lookback: 30,
        maxVolumePercentile: 0.4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxVolumePercentile: "Max Volume Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const flags = returns.map((r) => (r > 0 ? 1 : r < 0 ? -1 : 0));
        const streaks = buildStreakCount(flags);

        const volumes = cleanData.map((d) => d.volume);
        const volPct = buildPercentileRank(volumes, lookback);

        const closes = getCloses(cleanData);
        const closeZ = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [volPct, closeZ], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVolPct = volPct[i];
            const currentZ = closeZ[i];
            if (currentVolPct === null || currentZ === null) return null;

            const prevStreak = streaks[i - 1];
            const currStreak = streaks[i];

            // Downward streak of at least 3 ended (prevStreak <= -3 and currStreak >= 0)
            const downwardEnded = prevStreak <= -3 && currStreak >= 0;
            // Upward streak of at least 3 ended (prevStreak >= 3 and currStreak <= 0)
            const upwardEnded = prevStreak >= 3 && currStreak <= 0;

            if (downwardEnded && currentVolPct < (p.maxVolumePercentile as number) && currentZ < -1.8) {
                return createBuySignal(cleanData, i, `Failed Streak Fade Buy: PrevStreak ${prevStreak}, Z ${currentZ.toFixed(2)}, VolPct ${currentVolPct.toFixed(2)}`);
            }
            if (upwardEnded && currentVolPct < (p.maxVolumePercentile as number) && currentZ > 1.8) {
                return createSellSignal(cleanData, i, `Failed Streak Fade Sell: PrevStreak ${prevStreak}, Z ${currentZ.toFixed(2)}, VolPct ${currentVolPct.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxVolumePercentile"],
    },
};
