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
import { buildPairSpread } from "./cross-symbol-helpers";

function normalizePairSpreadZscoreAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(params.lookback ?? 20)),
        threshold: Math.max(0.1, Number(params.threshold ?? 1.5)),
    };
}

export const pair_spread_zscore_alignment: Strategy = {
    name: "Pair Spread Z-Score Alignment",
    description: "The spread between primary and secondary closes measures relative value divergence. Z-scoring this spread normalizes it across regimes. Positive z-score means the primary is trading rich relative to the secondary; negative means cheap.",
    crossSymbolConfig: {
        defaultSymbol: "ETHUSDT",
        userSelectable: true,
        minBars: 50,
    },
    defaultParams: {
        lookback: 20,
        threshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Threshold",
    },
    normalizeParams: normalizePairSpreadZscoreAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizePairSpreadZscoreAlignmentParams(params);
        if (cleanData.length < p.lookback) return [];

        const primaryCloses = getCloses(cleanData);
        const secondaryCloses = getCloses(context.crossSymbol.secondaryData);
        const spread = buildPairSpread(primaryCloses, secondaryCloses);
        const zScore = buildRollingZScore(spread, p.lookback);

        return createSignalLoop(cleanData, [zScore], (i) => {
            if (i < p.lookback) return null;
            const z = zScore[i];
            if (z === null) return null;

            if (z > p.threshold) {
                return createBuySignal(cleanData, i, `Pair spread z-score ${z.toFixed(3)} above threshold (primary rich)`);
            }
            if (z < -p.threshold) {
                return createSellSignal(cleanData, i, `Pair spread z-score ${z.toFixed(3)} below threshold (primary cheap)`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
