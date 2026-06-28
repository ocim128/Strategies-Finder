import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange, buildStreakCount } from "./price-action-statistics-core";

function normalizeReturnStreakEfficiencyConfirmedParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        streakMin: Math.max(1, Math.round(Number(params.streakMin ?? 3))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.40))),
    };
}

export const return_streak_efficiency_confirmed: Strategy = {
    name: "Return Streak Efficiency Confirmed",
    description: "Return sign streak with efficiency confirmation.",
    defaultParams: {
        lookback: 20,
        streakMin: 3,
        efficiencyMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        streakMin: "Streak Min",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizeReturnStreakEfficiencyConfirmedParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeReturnStreakEfficiencyConfirmedParams(params);
        const lookback = p.lookback as number;
        const streakMin = p.streakMin as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const returnFlags = returns.map(r => r === null ? 0 : (r > 0 ? 1 : (r < 0 ? -1 : 0)));
        const streakCounts = buildStreakCount(returnFlags);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [streakCounts, efficiencyRatio], (i) => {
            const streak = streakCounts[i];
            const eff = efficiencyRatio[i];
            if (streak === 0 || eff === null) return null;

            if (eff > efficiencyMin) {
                if (streak >= streakMin) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish return streak of ${streak} bars with efficiency ${eff.toFixed(2)}`
                    );
                }
                if (streak <= -streakMin) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish return streak of ${Math.abs(streak)} bars with efficiency ${eff.toFixed(2)}`
                    );
                }
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
