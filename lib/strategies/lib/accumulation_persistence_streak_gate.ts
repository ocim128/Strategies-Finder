import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

function normalizeAccumulationPersistenceStreakGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakReq: Math.max(1, Math.round(params.streakReq ?? 5)),
        medianLookback: Math.max(2, Math.round(params.medianLookback ?? 20)),
    };
}

export const accumulation_persistence_streak_gate: Strategy = {
    name: "Accumulation Persistence Streak Gate",
    description:
        "Requires sustained positive or negative Chaikin money flow before allowing price to align with a rolling median, filtering out one-bar accumulation noise.",
    defaultParams: {
        streakReq: 5,
        medianLookback: 20,
    },
    paramLabels: {
        streakReq: "CMF Streak Requirement",
        medianLookback: "Median Lookback",
    },
    normalizeParams: normalizeAccumulationPersistenceStreakGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAccumulationPersistenceStreakGateParams(params);
        const lookback = p.medianLookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
        const streaks = buildStreakCount(
            cmf.map((value) => value === null ? 0 : value > 0 ? 1 : value < 0 ? -1 : 0)
        );
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [median], (i) => {
            if (i < lookback - 1) return null;

            const med = median[i];
            if (med === null) return null;

            if (streaks[i] >= (p.streakReq as number) && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive CMF streak ${streaks[i]} with close above median`);
            }
            if (streaks[i] <= -(p.streakReq as number) && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative CMF streak ${Math.abs(streaks[i])} with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakReq", "medianLookback"],
    },
};
