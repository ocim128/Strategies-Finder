import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingSkewness, buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 40))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 2))),
    };
}

export const range_skewness_streak_alignment: Strategy = {
    name: "Range Skewness Streak Alignment",
    description: "Aligns range skewness expansion with directional return streaks exceeding median true range.",
    defaultParams: {
        lookback: 40,
        minStreak: 2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minStreak: "Min Return Streak",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const skewness = buildRollingSkewness(trueRange, lookback);
        const medianRange = buildRollingMedian(trueRange, lookback);

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const returnFlags = returns.map((r) => (r > 0 ? 1 : r < 0 ? -1 : 0));
        const streaks = buildStreakCount(returnFlags);

        return createSignalLoop(cleanData, [skewness, medianRange], (i) => {
            if (i < lookback) return null;
            const currentSkew = skewness[i];
            const currentMed = medianRange[i];
            if (currentSkew === null || currentMed === null) return null;

            const tr = trueRange[i];
            const streak = streaks[i];

            // Buy: True range skewness > 0.2, current true range > median range, and positive return streak >= minStreak
            if (currentSkew > 0.2 && tr > currentMed && streak >= minStreak) {
                return createBuySignal(cleanData, i, `Range Skew Streak Buy: Skew ${currentSkew.toFixed(2)}, Streak ${streak}`);
            }
            // Sell: True range skewness < -0.2, current true range > median range, and negative return streak <= -minStreak
            if (currentSkew < -0.2 && tr > currentMed && streak <= -minStreak) {
                return createSellSignal(cleanData, i, `Range Skew Streak Sell: Skew ${currentSkew.toFixed(2)}, Streak ${streak}`);
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
