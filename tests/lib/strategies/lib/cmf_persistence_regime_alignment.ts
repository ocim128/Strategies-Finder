import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildStreakCount } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming Chaikin Money Flow persistence is a robust institutional indicator on second timescales.
// #SUGGEST_VERIFY: Verify streak timing behavior under low-volume regimes where CMF could be zero or flat.
function normalizeCmfPersistenceRegimeAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minStreak: Math.max(2, Math.round(Number(params.minStreak ?? 6))),
    };
}

export const cmf_persistence_regime_alignment: Strategy = {
    name: "CMF Persistence Regime Alignment",
    description: "Signals when Chaikin Money Flow (CMF) remains consecutively positive or negative for a specified streak duration.",
    defaultParams: {
        lookback: 30,
        minStreak: 6,
    },
    paramLabels: {
        lookback: "CMF Lookback",
        minStreak: "Min Streak Duration",
    },
    normalizeParams: normalizeCmfPersistenceRegimeAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCmfPersistenceRegimeAlignmentParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
        const flags = cmf.map(v => v !== null && v > 0 ? 1 : v !== null && v < 0 ? -1 : 0);
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [cmf], (i) => {
            if (i < lookback) return null;
            const currentCmf = cmf[i];
            const currentStreak = streaks[i];

            if (currentCmf === null) return null;

            // Buy logic: CMF is positive, and current streak of positive CMF is >= minStreak.
            if (currentCmf > 0 && currentStreak >= minStreak) {
                return createBuySignal(cleanData, i, `CMF Positive Persistence Streak (streak=${currentStreak}, CMF=${currentCmf.toFixed(3)})`);
            }

            // Sell logic: CMF is negative, and current streak of negative CMF is >= minStreak.
            if (currentCmf < 0 && currentStreak <= -minStreak) {
                return createSellSignal(cleanData, i, `CMF Negative Persistence Streak (streak=${currentStreak}, CMF=${currentCmf.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minStreak"],
    },
};
