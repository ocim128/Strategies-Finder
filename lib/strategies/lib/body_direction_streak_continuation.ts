import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeBodyDirectionStreakContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakMin: Math.max(2, Math.round(Number(params.streakMin ?? 4))),
    };
}

export const body_direction_streak_continuation: Strategy = {
    name: "Body Direction Streak Continuation",
    description: "Extends consecutive same-direction bodies once the streak of close-versus-open placement reaches a threshold.",
    defaultParams: {
        streakMin: 4,
    },
    paramLabels: {
        streakMin: "Minimum Streak",
    },
    normalizeParams: normalizeBodyDirectionStreakContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const streakMin = normalizeBodyDirectionStreakContinuationParams(params).streakMin as number;

        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const streak = buildStreakCount(bodyDirection);

        return createCurrentBarSignalLoop(cleanData, [], (i) => {
            if (i === 0) return null;
            if (streak[i] >= streakMin) {
                return createBuySignal(cleanData, i, `Body direction streak buy: ${streak[i]} consecutive up bodies`);
            }
            if (streak[i] <= -streakMin) {
                return createSellSignal(cleanData, i, `Body direction streak sell: ${-streak[i]} consecutive down bodies`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakMin"],
    },
};
