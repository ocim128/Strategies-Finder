import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRollingEntropy,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minEntropyPercentile: Math.max(0, Math.min(1, Number(params.minEntropyPercentile ?? 0.75))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.8)),
    };
}

export const entropy_gated_reversion_fade: Strategy = {
    name: "Entropy Gated Reversion Fade",
    description: "Fades close z-score extremes only when rolling entropy percentile is high (chaotic regimes).",
    defaultParams: {
        lookback: 30,
        minEntropyPercentile: 0.75,
        zThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minEntropyPercentile: "Min Entropy Percentile",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const closeZ = buildRollingZScore(closes, lookback);

        const entropy = buildRollingEntropy(closes, lookback, 5);
        const entropyNumbers = entropy.map((v) => (v !== null ? v : 0));
        const entropyPctl = buildPercentileRank(entropyNumbers, lookback);

        return createSignalLoop(cleanData, [closeZ, entropyPctl], (i) => {
            const z = closeZ[i];
            const ep = entropyPctl[i];
            if (z === null || ep === null) return null;

            if (ep > p.minEntropyPercentile) {
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Entropy-gated reversion buy: Z ${z.toFixed(2)}, entropy rank ${ep.toFixed(2)}`);
                }
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Entropy-gated reversion sell: Z ${z.toFixed(2)}, entropy rank ${ep.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEntropyPercentile", "zThreshold"],
    },
};
