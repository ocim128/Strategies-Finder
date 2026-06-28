import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildStreakCount, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        streakMin: Math.max(2, Math.round(Number(params.streakMin ?? 3))),
        efficiencyMin: Math.max(0.1, Math.min(0.95, Number(params.efficiencyMin ?? 0.40))),
    };
}

export const streak_efficiency_continuation: Strategy = {
    name: "Streak Efficiency Continuation",
    description: "Follows return sign streaks when efficiency confirms genuine directional coupling, not random runs.",
    defaultParams: {
        lookback: 20,
        streakMin: 3,
        efficiencyMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        streakMin: "Streak Min",
        efficiencyMin: "Min Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const signFlags = returns.map(v => v === null ? 0 : v > 0 ? 1 : v < 0 ? -1 : 0);
        const streaks = buildStreakCount(signFlags);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [efficiency], (i) => {
            const er = efficiency[i];
            if (er === null) return null;
            if (er < (p.efficiencyMin as number)) return null;

            const streak = streaks[i];
            const streakMin = p.streakMin as number;

            if (streak >= streakMin) {
                return createBuySignal(cleanData, i, `Streak ${streak} eff ${er.toFixed(2)} continuation buy`);
            }
            if (streak <= -streakMin) {
                return createSellSignal(cleanData, i, `Streak ${streak} eff ${er.toFixed(2)} continuation sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakMin", "efficiencyMin"],
    },
};
