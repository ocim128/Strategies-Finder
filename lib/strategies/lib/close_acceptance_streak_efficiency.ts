import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildStreakCount, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        streakMin: Math.max(2, Math.round(Number(params.streakMin ?? 3))),
        efficiencyMin: Math.max(0.2, Math.min(0.8, Number(params.efficiencyMin ?? 0.4))),
    };
}

export const close_acceptance_streak_efficiency: Strategy = {
    name: "Close Acceptance Streak Efficiency",
    description: "Persistent directional close acceptance streaks validated by efficiency ratio signal sustained directional flow.",
    defaultParams: {
        lookback: 20,
        streakMin: 3,
        efficiencyMin: 0.4,
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
        if (cleanData.length < lookback + 5) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        // Directional flags from acceptance: >0 bullish, <0 bearish
        const accFlags = acceptance.map(v => v > 0.05 ? 1 : v < -0.05 ? -1 : 0);
        const streaks = buildStreakCount(accFlags);

        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const smoothedAcc = buildRollingAverage(acceptance, lookback);

        return createSignalLoop(cleanData, [efficiency, smoothedAcc], (i) => {
            const er = efficiency[i];
            const sa = smoothedAcc[i];
            if (er === null || sa === null) return null;

            const streak = streaks[i];
            const streakMin = p.streakMin as number;
            const erMin = p.efficiencyMin as number;

            // Short: bearish acceptance streak + high efficiency + negative smoothed
            if (streak <= -streakMin && er > erMin && sa < -0.05) {
                return createSellSignal(cleanData, i, `Acc streak ${streak} eff ${er.toFixed(2)} smoothed ${sa.toFixed(3)} sustained selling`);
            }
            // Long: bullish acceptance streak + high efficiency + positive smoothed
            if (streak >= streakMin && er > erMin && sa > 0.05) {
                return createBuySignal(cleanData, i, `Acc streak ${streak} eff ${er.toFixed(2)} smoothed ${sa.toFixed(3)} sustained buying`);
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
