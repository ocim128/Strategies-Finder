import type {
    Strategy,
    OHLCVData,
    StrategyParams,
    StrategyExecutionContext,
} from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildRelativeStrength } from "./cross-symbol-helpers";

function normalizeRelativeStrengthMeanReversionParams(params: StrategyParams): StrategyParams {
    const lookback = Math.max(10, Math.round(params.lookback ?? 30));
    const zThreshold = Math.max(0.5, Number(params.zThreshold ?? 2.0));
    return {
        ...params,
        lookback,
        zThreshold,
    };
}

export const relative_strength_mean_reversion: Strategy = {
    name: "Relative Strength Mean Reversion",
    description: "Mean-reversion on the z-score of the relative strength ratio (primary / secondary). When the ratio deviates significantly from its rolling mean, a reversal is expected.",
    defaultParams: {
        lookback: 30,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeRelativeStrengthMeanReversionParams,
    crossSymbolConfig: {
        defaultSymbol: "ETHUSDT",
        userSelectable: true,
        minBars: 50,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeRelativeStrengthMeanReversionParams(params);
        if (cleanData.length < p.lookback) return [];

        const secondaryData = context.crossSymbol.secondaryData;
        const primaryCloses = getCloses(cleanData);
        const secondaryCloses = getCloses(secondaryData);

        const ratio = buildRelativeStrength(primaryCloses, secondaryCloses);
        const zscore = buildRollingZScore(ratio, p.lookback);

        return createSignalLoop(cleanData, [zscore], (i) => {
            if (i < p.lookback) return null;
            const z = zscore[i];
            if (z === null) return null;

            if (z > p.zThreshold) {
                return createSellSignal(cleanData, i, `RS z-score ${z.toFixed(2)} > ${p.zThreshold}`);
            }
            if (z < -p.zThreshold) {
                return createBuySignal(cleanData, i, `RS z-score ${z.toFixed(2)} < -${p.zThreshold}`);
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
