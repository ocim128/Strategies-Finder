import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeTypicalPriceZscoreAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 126))),
        z_threshold: Math.max(0.1, Math.abs(Number(params.z_threshold ?? 1.5))),
    };
}

export const typical_price_zscore_alignment: Strategy = {
    name: "Typical Price Z-Score Alignment",
    description:
        "Treats large positive or negative typical-price z-scores as continuation states, assuming statistically expensive daily bars can keep extending.",
    defaultParams: {
        lookback: 126,
        z_threshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        z_threshold: "Z Threshold",
    },
    normalizeParams: normalizeTypicalPriceZscoreAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPriceZscoreAlignmentParams(params);
        const lookback = p.lookback as number;
        const zThreshold = p.z_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const zscore = buildRollingZScore(typicalPrices, lookback);

        return createSignalLoop(cleanData, [zscore], (i) => {
            const z = zscore[i];
            if (z === null) return null;

            if (z > zThreshold) {
                return createBuySignal(cleanData, i, `Typical price z-score ${z.toFixed(2)} above threshold`);
            }
            if (z < -zThreshold) {
                return createSellSignal(cleanData, i, `Typical price z-score ${z.toFixed(2)} below threshold`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "z_threshold"],
    },
};
