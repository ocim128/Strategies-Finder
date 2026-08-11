import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCumulativeDecaySum,
    buildRateOfChange,
} from "./price-action-statistics-core";

// Skip the accumulator's anchor region: before this many bars the decayed sum
// is dominated by its start-at-zero initialization, so early zero crossings
// would be initialization artifacts rather than pressure flips.
const ANCHOR_WARMUP = 10;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.9))),
    };
}

export const decay_weighted_momentum_zero_cross: Strategy = {
    name: "Decay Weighted Momentum Zero Cross",
    description: "Trades zero crossings of an exponentially decayed accumulator of signed bar returns.",
    defaultParams: {
        decay: 0.9,
    },
    paramLabels: {
        decay: "Decay Memory",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const decay = p.decay as number;
        if (cleanData.length < ANCHOR_WARMUP) return [];

        // Signed per-bar returns with the leading null coerced to 0.
        const returns = buildRateOfChange(getCloses(cleanData), 1).map((v) => (v === null ? 0 : v));
        const accum = buildCumulativeDecaySum(returns, decay);

        return createSignalLoop(cleanData, [accum], (i) => {
            if (i < ANCHOR_WARMUP) return null;

            // Decayed pressure balance flips sign.
            if (accum[i - 1] <= 0 && accum[i] > 0) {
                return createBuySignal(cleanData, i, `Decay momentum buy: accum ${accum[i - 1].toFixed(5)} -> ${accum[i].toFixed(5)} crosses zero`);
            }
            if (accum[i - 1] >= 0 && accum[i] < 0) {
                return createSellSignal(cleanData, i, `Decay momentum sell: accum ${accum[i - 1].toFixed(5)} -> ${accum[i].toFixed(5)} crosses zero`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["decay"],
    },
};
