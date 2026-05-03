import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    getWeightedClosePrices,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeTypicalWeightingConsensusQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 55))),
    };
}

export const typical_weighting_consensus_quorum: Strategy = {
    name: "Typical Weighting Consensus Quorum",
    description:
        "Requires typical price and weighted close price to agree relative to their own rolling medians.",
    defaultParams: {
        lookback: 55,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeTypicalWeightingConsensusQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalWeightingConsensusQuorumParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const weightedCloses = getWeightedClosePrices(cleanData);
        const typicalMedian = buildRollingMedian(typicalPrices, lookback);
        const weightedMedian = buildRollingMedian(weightedCloses, lookback);

        return createSignalLoop(cleanData, [typicalMedian, weightedMedian], (i) => {
            const typMed = typicalMedian[i];
            const weightedMed = weightedMedian[i];
            if (typMed === null || weightedMed === null) return null;

            if (typicalPrices[i] > typMed && weightedCloses[i] > weightedMed) {
                return createBuySignal(cleanData, i, "Typical and weighted close above medians");
            }
            if (typicalPrices[i] < typMed && weightedCloses[i] < weightedMed) {
                return createSellSignal(cleanData, i, "Typical and weighted close below medians");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
