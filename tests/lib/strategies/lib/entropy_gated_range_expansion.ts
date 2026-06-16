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
    buildRateOfChange,
    buildRollingEntropy,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        entropyPercentile: Math.max(0, Math.min(1, Number(params.entropyPercentile ?? 0.30))),
        rocZThreshold: Math.max(0, Number(params.rocZThreshold ?? 1.8)),
    };
}

export const entropy_gated_range_expansion: Strategy = {
    name: "Entropy Gated Range Expansion",
    description: "Chases breakouts emerging from low-entropy structured compression states.",
    defaultParams: {
        lookback: 30,
        entropyPercentile: 0.30,
        rocZThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyPercentile: "Entropy Percentile Threshold",
        rocZThreshold: "ROC Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const entropy = buildRollingEntropy(closes, lookback, 5);
        const entropyNumbers: number[] = entropy.map((v) => (v !== null ? v : 0));
        const entropyPercentileRank = buildPercentileRank(entropyNumbers, lookback);

        const roc = buildRateOfChange(closes, 1);
        const rocNumbers: number[] = roc.map((v) => (v !== null ? v : 0));
        const rocZ = buildRollingZScore(rocNumbers, lookback);

        return createSignalLoop(cleanData, [entropyPercentileRank, rocZ], (i) => {
            const ep = entropyPercentileRank[i];
            const rz = rocZ[i];
            if (ep === null || rz === null) return null;

            // Check if entropy rank was below threshold in the current or previous 3 bars
            let hasLowEntropy = false;
            for (let k = 0; k <= 3; k++) {
                const prevIdx = i - k;
                if (prevIdx >= 0) {
                    const prevEp = entropyPercentileRank[prevIdx];
                    if (prevEp !== null && prevEp < p.entropyPercentile) {
                        hasLowEntropy = true;
                        break;
                    }
                }
            }

            if (!hasLowEntropy) return null;

            if (rz > p.rocZThreshold) {
                return createBuySignal(cleanData, i, `Entropy-gated buy: ROC Z-score ${rz.toFixed(2)} following low entropy`);
            }
            if (rz < -p.rocZThreshold) {
                return createSellSignal(cleanData, i, `Entropy-gated sell: ROC Z-score ${rz.toFixed(2)} following low entropy`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyPercentile", "rocZThreshold"],
    },
};
