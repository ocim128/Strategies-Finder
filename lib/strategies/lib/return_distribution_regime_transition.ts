import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildPercentileRank, buildRateOfChange, buildRollingKurtosis } from "./price-action-statistics-core";

function normalizeReturnDistributionRegimeTransitionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        kurtosisPercentileHigh: Math.max(0, Math.min(1, Number(params.kurtosisPercentileHigh ?? 0.70))),
        kurtosisPercentileLow: Math.max(0, Math.min(1, Number(params.kurtosisPercentileLow ?? 0.35))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.45))),
    };
}

export const return_distribution_regime_transition: Strategy = {
    name: "Return Distribution Regime Transition",
    description: "Return distribution shape transition from fat-tailed to normal.",
    defaultParams: {
        lookback: 30,
        kurtosisPercentileHigh: 0.70,
        kurtosisPercentileLow: 0.35,
        efficiencyMin: 0.45,
    },
    paramLabels: {
        lookback: "Lookback",
        kurtosisPercentileHigh: "Kurtosis Percentile High",
        kurtosisPercentileLow: "Kurtosis Percentile Low",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizeReturnDistributionRegimeTransitionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeReturnDistributionRegimeTransitionParams(params);
        const lookback = p.lookback as number;
        const kurtosisPercentileHigh = p.kurtosisPercentileHigh as number;
        const kurtosisPercentileLow = p.kurtosisPercentileLow as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const kurtosis = buildRollingKurtosis(cleanReturns, lookback);
        const cleanKurtosis = kurtosis.map(k => k ?? 0);
        const kurtosisPercentile = buildPercentileRank(cleanKurtosis, lookback);
        const cleanKurtPct = kurtosisPercentile.map(k => k ?? 0);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [kurtosisPercentile, efficiencyRatio, returns], (i) => {
            const kurtPct = kurtosisPercentile[i];
            const eff = efficiencyRatio[i];
            const ret = returns[i];
            if (kurtPct === null || eff === null || ret === null) return null;

            // Check if kurtosis percentile was above kurtosisPercentileHigh within the last 5 bars: i-4 to i
            const wasHigh = (cleanKurtPct[i] > kurtosisPercentileHigh) ||
                            (i >= 1 && cleanKurtPct[i - 1] > kurtosisPercentileHigh) ||
                            (i >= 2 && cleanKurtPct[i - 2] > kurtosisPercentileHigh) ||
                            (i >= 3 && cleanKurtPct[i - 3] > kurtosisPercentileHigh) ||
                            (i >= 4 && cleanKurtPct[i - 4] > kurtosisPercentileHigh);

            const isLow = kurtPct < kurtosisPercentileLow;

            if (wasHigh && isLow && eff > efficiencyMin) {
                if (ret > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Distribution transition: kurt percentile ${kurtPct.toFixed(2)}, efficiency ${eff.toFixed(2)}`
                    );
                }
                if (ret < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Distribution transition: kurt percentile ${kurtPct.toFixed(2)}, efficiency ${eff.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "kurtosisPercentileHigh", "kurtosisPercentileLow", "efficiencyMin"],
    },
};
