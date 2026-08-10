import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeBodyMidDriftStreakContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakReq: Math.max(2, Math.round(Number(params.streakReq ?? 3))),
    };
}

export const body_mid_drift_streak_continuation: Strategy = {
    name: "Body Mid Drift Streak Continuation",
    description: "Follows consecutive bars whose wick-robust body midpoints drift the same way as a persistent directional state.",
    defaultParams: {
        streakReq: 3,
    },
    paramLabels: {
        streakReq: "Min Drift Streak",
    },
    normalizeParams: normalizeBodyMidDriftStreakContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodyMidDriftStreakContinuationParams(params);
        const streakReq = p.streakReq as number;
        if (cleanData.length < streakReq + 2) return [];

        const bodyMidDelta = extractBarMetricSeries(cleanData, "bodyMidDelta");
        const signFlags = bodyMidDelta.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
        const streaks = buildStreakCount(signFlags);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            if (streaks[i] >= streakReq) {
                return createBuySignal(cleanData, i, `Body-mid drift streak of ${streaks[i]} bars`);
            }
            if (streaks[i] <= -streakReq) {
                return createSellSignal(cleanData, i, `Body-mid drift streak of ${-streaks[i]} bars`);
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
