import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange, buildRollingEntropy, buildRollingZScore } from "./price-action-statistics-core";

function normalizeEntropyRegimeMeanReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        entropyPercentileMin: Math.max(0, Math.min(1, Number(params.entropyPercentileMin ?? 0.65))),
        returnZThreshold: Math.max(0, Number(params.returnZThreshold ?? 1.3)),
    };
}

export const entropy_regime_mean_reversion: Strategy = {
    name: "Entropy Regime Mean Reversion",
    description: "High-entropy regime as mean reversion filter.",
    defaultParams: {
        lookback: 25,
        entropyPercentileMin: 0.65,
        returnZThreshold: 1.3,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyPercentileMin: "Entropy Percentile Min",
        returnZThreshold: "Return Z-Score Threshold",
    },
    normalizeParams: normalizeEntropyRegimeMeanReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyRegimeMeanReversionParams(params);
        const lookback = p.lookback as number;
        const entropyPercentileMin = p.entropyPercentileMin as number;
        const returnZThreshold = p.returnZThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const signs = returns.map(r => r === null ? 0 : (r > 0 ? 1 : (r < 0 ? -1 : 0)));
        const entropy = buildRollingEntropy(signs, lookback);
        const cleanEntropy = entropy.map(e => e ?? 0);
        const entropyPercentile = buildPercentileRank(cleanEntropy, lookback);
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [entropyPercentile, zscore], (i) => {
            const entPct = entropyPercentile[i];
            const z = zscore[i];
            if (entPct === null || z === null) return null;

            if (entPct > entropyPercentileMin) {
                if (z < -returnZThreshold) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `High entropy percentile ${entPct.toFixed(2)} with extreme z-score down ${z.toFixed(2)}`
                    );
                }
                if (z > returnZThreshold) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `High entropy percentile ${entPct.toFixed(2)} with extreme z-score up ${z.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyPercentileMin", "returnZThreshold"],
    },
};
