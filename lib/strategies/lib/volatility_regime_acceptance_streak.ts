import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildRollingStdDev,
    buildPercentileRank,
    buildStreakCount,
} from "./price-action-statistics-core";
import { buildCloseAcceptanceSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 3))),
    };
}

export const volatility_regime_acceptance_streak: Strategy = {
    name: "Volatility Regime Acceptance Streak",
    description: "Enters during expanding volatility backed by a persistent streak of close acceptance bars.",
    defaultParams: {
        lookback: 40,
        minStreak: 3,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minStreak: "Min Streak Count",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, lookback);

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const flags = acceptance.map((val) => (val > 0 ? 1 : val < 0 ? -1 : 0));
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [volPct], (i) => {
            if (i < lookback) return null;
            const currentVolPct = volPct[i];
            if (currentVolPct === null) return null;

            const streak = streaks[i];

            // Buy: vol percentile > 0.65, positive close acceptance streak >= minStreak
            if (currentVolPct > 0.65 && streak >= minStreak) {
                return createBuySignal(cleanData, i, `Vol Accept Streak Buy: VolPct ${currentVolPct.toFixed(2)}, Streak ${streak}`);
            }
            // Sell: vol percentile > 0.65, negative close acceptance streak <= -minStreak
            if (currentVolPct > 0.65 && streak <= -minStreak) {
                return createSellSignal(cleanData, i, `Vol Accept Streak Sell: VolPct ${currentVolPct.toFixed(2)}, Streak ${streak}`);
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
