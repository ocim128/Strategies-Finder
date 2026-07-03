import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildStreakCount, buildPercentileRank } from "./price-action-statistics-core";
import { buildCloseAcceptanceSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 3))),
    };
}

export const volatility_gated_acceptance_streak: Strategy = {
    name: "Volatility Gated Acceptance Streak",
    description: "Enters when close acceptance streak is persistent and true range percentile confirms expanding volatility.",
    defaultParams: {
        lookback: 35,
        streakThreshold: 3,
    },
    paramLabels: {
        lookback: "Lookback Window",
        streakThreshold: "Streak Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const streakThreshold = p.streakThreshold as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            if (acceptance[i] > 0.6) {
                flags[i] = 1;
            } else if (acceptance[i] < 0.4) {
                flags[i] = -1;
            }
        }
        const streaks = buildStreakCount(flags);

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trPct = buildPercentileRank(trueRange, lookback);

        return createSignalLoop(cleanData, [trPct], (i) => {
            if (i < lookback) return null;
            const currentTrPct = trPct[i];
            if (currentTrPct === null) return null;

            const streak = streaks[i];

            // Buy: close acceptance > 0.6 streak >= streakThreshold, true range percentile rank > 0.65
            if (streak >= streakThreshold && currentTrPct > 0.65) {
                return createBuySignal(cleanData, i, `Vol Gated Accept Streak Buy: Streak ${streak}, TrPct ${currentTrPct.toFixed(2)}`);
            }
            // Sell: close acceptance < 0.4 streak <= -streakThreshold, true range percentile rank > 0.65
            if (streak <= -streakThreshold && currentTrPct > 0.65) {
                return createSellSignal(cleanData, i, `Vol Gated Accept Streak Sell: Streak ${streak}, TrPct ${currentTrPct.toFixed(2)}`);
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
