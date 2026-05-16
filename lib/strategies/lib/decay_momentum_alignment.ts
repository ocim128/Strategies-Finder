import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCumulativeDecaySum, buildRateOfChange } from "./price-action-statistics-core";

function normalizeDecayMomentumAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        decay: Math.min(0.999, Math.max(0.01, Number(params.decay ?? 0.92))),
        roc_period: Math.max(1, Math.round(params.roc_period ?? 1)),
    };
}

export const decay_momentum_alignment: Strategy = {
    name: "Decay Momentum Alignment",
    description: "An exponentially decayed cumulative sum of signed bar-to-bar returns creates a smooth, lag-aware momentum reference frame. The decay sum is positive when recent net directional pressure is bullish; negative when bearish. Its sign directly drives entries.",
    defaultParams: {
        decay: 0.92,
        roc_period: 1,
    },
    paramLabels: {
        decay: "Decay Factor",
        roc_period: "ROC Period",
    },
    normalizeParams: normalizeDecayMomentumAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDecayMomentumAlignmentParams(params);
        if (cleanData.length < p.roc_period + 1) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, p.roc_period);

        // Replace null ROC values with 0 for the decay sum input
        const rocValues: number[] = roc.map((v) => (v === null ? 0 : v));
        const decaySum = buildCumulativeDecaySum(rocValues, p.decay);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < p.roc_period) return null;
            const ds = decaySum[i];

            if (ds > 0) {
                return createBuySignal(cleanData, i, `Decay momentum positive (${ds.toFixed(4)})`);
            }
            if (ds < 0) {
                return createSellSignal(cleanData, i, `Decay momentum negative (${ds.toFixed(4)})`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["decay", "roc_period"],
    },
};





