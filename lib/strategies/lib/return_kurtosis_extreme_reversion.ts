import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingKurtosis, buildRollingZScore, buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        kurtosisPercentileMax: Math.max(0.1, Math.min(0.9, Number(params.kurtosisPercentileMax ?? 0.30))),
        returnZThreshold: Math.max(0.5, Number(params.returnZThreshold ?? 1.5)),
    };
}

export const return_kurtosis_extreme_reversion: Strategy = {
    name: "Return Kurtosis Extreme Reversion",
    description: "Reverts stretched ratios when return kurtosis is low (flat distribution), indicating trend exhaustion.",
    defaultParams: {
        lookback: 30,
        kurtosisPercentileMax: 0.30,
        returnZThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        kurtosisPercentileMax: "Max Kurtosis Percentile",
        returnZThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const kurtosis = buildRollingKurtosis(returnsClean, lookback);
        const kurtPctl = buildPercentileRank(kurtosis.map(v => v ?? 0), lookback);
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [kurtPctl, zscore], (i) => {
            const kp = kurtPctl[i];
            const z = zscore[i];
            if (kp === null || z === null) return null;
            if (kp >= (p.kurtosisPercentileMax as number)) return null;

            const zThresh = p.returnZThreshold as number;
            if (z < -zThresh) {
                return createBuySignal(cleanData, i, `Kurt pctl ${kp.toFixed(2)} z-score ${z.toFixed(2)} reversion buy`);
            }
            if (z > zThresh) {
                return createSellSignal(cleanData, i, `Kurt pctl ${kp.toFixed(2)} z-score ${z.toFixed(2)} reversion sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "kurtosisPercentileMax", "returnZThreshold"],
    },
};
