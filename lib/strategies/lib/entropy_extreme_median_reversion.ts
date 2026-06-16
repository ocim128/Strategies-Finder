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
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        entropyPercentileMin: Math.max(0, Math.min(1, Number(params.entropyPercentileMin ?? 0.80))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.7)),
    };
}

export const entropy_extreme_median_reversion: Strategy = {
    name: "Entropy Extreme Median Reversion",
    description: "Fades close price z-score extremes when rolling entropy rank is extremely high.",
    defaultParams: {
        lookback: 35,
        entropyPercentileMin: 0.80,
        zThreshold: 1.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyPercentileMin: "Min Entropy Percentile",
        zThreshold: "Close Z-Score Threshold",
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
        const entropyPercentile = buildPercentileRank(entropyNumbers, lookback);

        return createSignalLoop(cleanData, [closeZ, entropyPercentile], (i) => {
            const z = closeZ[i];
            const ep = entropyPercentile[i];
            if (z === null || ep === null) return null;

            if (ep > p.entropyPercentileMin) {
                // Buy: close price z-score is below -zThreshold and entropy percentile rank is high -> fade buy
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Entropy extreme buy: Z-score ${z.toFixed(2)}, entropy percentile ${ep.toFixed(2)}`);
                }
                // Sell: close price z-score is above zThreshold and entropy percentile rank is high -> fade sell
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Entropy extreme sell: Z-score ${z.toFixed(2)}, entropy percentile ${ep.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyPercentileMin", "zThreshold"],
    },
};
