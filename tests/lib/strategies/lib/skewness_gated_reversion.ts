import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildRollingSkewness,
    buildRollingZScore,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        skewLimit: Math.max(0, Number(params.skewLimit ?? 1.2)),
    };
}

export const skewness_gated_reversion: Strategy = {
    name: "Skewness Gated Reversion",
    description: "Fades price extremes only when rolling skewness confirms return distribution asymmetry.",
    defaultParams: {
        lookback: 40,
        skewLimit: 1.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        skewLimit: "Skewness Limit",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const skew = buildRollingSkewness(returns, lookback);
        const returnZ = buildRollingZScore(returns, lookback);

        return createSignalLoop(cleanData, [skew, returnZ], (i) => {
            const s = skew[i];
            const z = returnZ[i];
            if (s === null || z === null) return null;

            // Buy: return z-score is below -1.8, skewness is positive -> long reversion
            if (z < -1.8 && s > p.skewLimit) {
                return createBuySignal(cleanData, i, `Skewness gated buy: z-score ${z.toFixed(2)}, skew ${s.toFixed(2)}`);
            }
            // Sell: return z-score is above 1.8, skewness is negative -> short reversion
            if (z > 1.8 && s < -p.skewLimit) {
                return createSellSignal(cleanData, i, `Skewness gated sell: z-score ${z.toFixed(2)}, skew ${s.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewLimit"],
    },
};
