import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange, buildRollingKurtosis, buildRollingZScore } from "./price-action-statistics-core";

function normalizeReturnKurtosisRegimeReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        kurtosisPercentileMax: Math.max(0, Math.min(1, Number(params.kurtosisPercentileMax ?? 0.35))),
        returnZThreshold: Math.max(0, Number(params.returnZThreshold ?? 1.3)),
    };
}

export const return_kurtosis_regime_reversion: Strategy = {
    name: "Return Kurtosis Regime Reversion",
    description: "Return distribution kurtosis as regime indicator for mean reversion.",
    defaultParams: {
        lookback: 25,
        kurtosisPercentileMax: 0.35,
        returnZThreshold: 1.3,
    },
    paramLabels: {
        lookback: "Lookback",
        kurtosisPercentileMax: "Kurtosis Percentile Max",
        returnZThreshold: "Return Z-Score Threshold",
    },
    normalizeParams: normalizeReturnKurtosisRegimeReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeReturnKurtosisRegimeReversionParams(params);
        const lookback = p.lookback as number;
        const kurtosisPercentileMax = p.kurtosisPercentileMax as number;
        const returnZThreshold = p.returnZThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const kurtosis = buildRollingKurtosis(cleanReturns, lookback);
        const cleanKurtosis = kurtosis.map(k => k ?? 0);
        const kurtosisPercentile = buildPercentileRank(cleanKurtosis, lookback);
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [kurtosisPercentile, zscore], (i) => {
            const kurtPct = kurtosisPercentile[i];
            const z = zscore[i];
            if (kurtPct === null || z === null) return null;

            if (kurtPct < kurtosisPercentileMax) {
                if (z < -returnZThreshold) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Kurtosis percentile ${kurtPct.toFixed(2)} with extreme z-score down ${z.toFixed(2)}`
                    );
                }
                if (z > returnZThreshold) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Kurtosis percentile ${kurtPct.toFixed(2)} with extreme z-score up ${z.toFixed(2)}`
                    );
                }
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
