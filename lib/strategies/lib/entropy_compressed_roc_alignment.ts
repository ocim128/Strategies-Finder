import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildRateOfChange, buildRollingEntropy } from "./price-action-statistics-core";

const ENTROPY_COMPRESSED_BINS = 5;
const ENTROPY_COMPRESSED_MAX = Math.log2(ENTROPY_COMPRESSED_BINS);

function normalizeEntropyCompressedRocAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
        entropy_max: Math.max(0, Math.min(1, Number(params.entropy_max ?? 0.4))),
    };
}

export const entropy_compressed_roc_alignment: Strategy = {
    name: "Entropy Compressed ROC Alignment",
    description:
        "Aligns with typical-price ROC only when normalized return entropy is low enough to indicate ordered movement.",
    defaultParams: {
        lookback: 20,
        entropy_max: 0.4,
    },
    paramLabels: {
        lookback: "Lookback",
        entropy_max: "Entropy Max",
    },
    normalizeParams: normalizeEntropyCompressedRocAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyCompressedRocAlignmentParams(params);
        const lookback = p.lookback as number;
        const entropyMax = p.entropy_max as number;
        if (cleanData.length < lookback + 2) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const roc = buildRateOfChange(typicalPrices, lookback);
        const returns = buildRateOfChange(typicalPrices, 1).map((value) => value ?? 0);
        const entropy = buildRollingEntropy(returns, lookback, ENTROPY_COMPRESSED_BINS)
            .map((value) => value === null ? null : value / ENTROPY_COMPRESSED_MAX);

        return createSignalLoop(cleanData, [roc, entropy], (i) => {
            const currentRoc = roc[i];
            const previousRoc = roc[i - 1];
            const normalizedEntropy = entropy[i];
            if (currentRoc === null || previousRoc === null || normalizedEntropy === null || normalizedEntropy >= entropyMax) return null;

            if (currentRoc > 0 && currentRoc > previousRoc) {
                return createBuySignal(cleanData, i, `Low entropy ROC acceleration ${currentRoc.toFixed(3)}`);
            }
            if (currentRoc < 0 && currentRoc < previousRoc) {
                return createSellSignal(cleanData, i, `Low entropy ROC deterioration ${currentRoc.toFixed(3)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropy_max"],
    },
};
