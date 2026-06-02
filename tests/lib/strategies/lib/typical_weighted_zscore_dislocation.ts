import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices, getWeightedClosePrices } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming typical price and weighted close Z-score difference highlights temporary microstructure dislocations.
// #SUGGEST_VERIFY: Verify rolling Z-score calculation handles identical typical and weighted prices without zero-division issues.
function normalizeTypicalWeightedZscoreDislocationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        zThreshold: Math.max(0.1, Number(params.zThreshold ?? 2.2)),
    };
}

export const typical_weighted_zscore_dislocation: Strategy = {
    name: "Typical Price and Weighted Close Z-Score Dislocation",
    description: "Signals short-term typical price vs volume-weighted close dislocations that resolve back to fair value.",
    defaultParams: {
        lookback: 30,
        zThreshold: 2.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeTypicalWeightedZscoreDislocationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalWeightedZscoreDislocationParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const typical = getTypicalPrices(cleanData);
        const weighted = getWeightedClosePrices(cleanData);

        const difference: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            difference[i] = typical[i] - weighted[i];
        }

        const zscore = buildRollingZScore(difference, lookback);

        return createSignalLoop(cleanData, [zscore], (i) => {
            if (i < lookback) return null;
            const z = zscore[i];

            if (z === null) return null;

            // Buy: Z-score is less than -zThreshold (typical price oversold relative to volume-weighted close)
            if (z < -p.zThreshold) {
                return createBuySignal(cleanData, i, `Typical vs Weighted Dislocation Bullish (z=${z.toFixed(2)})`);
            }

            // Sell: Z-score is greater than zThreshold (typical price overbought relative to volume-weighted close)
            if (z > p.zThreshold) {
                return createSellSignal(cleanData, i, `Typical vs Weighted Dislocation Bearish (z=${z.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
