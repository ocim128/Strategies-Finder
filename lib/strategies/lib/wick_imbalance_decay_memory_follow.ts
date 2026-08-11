import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

const ABSORPTION_LEVEL = 1.5;
// Skip the accumulator's anchor region: before this many bars the decayed sum
// is dominated by its start-at-zero initialization.
const ANCHOR_WARMUP = 10;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        decay: Math.max(0.05, Math.min(0.99, Number(params.decay ?? 0.9))),
    };
}

export const wick_imbalance_decay_memory_follow: Strategy = {
    name: "Wick Imbalance Decay Memory Follow",
    description: "Follows the decaying accumulation of rejection-wick asymmetry: sustained lower-wick defense crossing a positive level favors continuation higher.",
    defaultParams: {
        decay: 0.9,
    },
    paramLabels: {
        decay: "Wick Memory Decay",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const decay = p.decay as number;
        if (cleanData.length < ANCHOR_WARMUP) return [];

        const imbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const accum = buildCumulativeDecaySum(imbalance, decay);

        return createSignalLoop(cleanData, [accum], (i) => {
            if (i < ANCHOR_WARMUP) return null;
            const prev = accum[i - 1];
            const curr = accum[i];

            // Accumulated lower-wick absorption crosses above the level: buyers
            // have persistently defended lows.
            if (prev <= ABSORPTION_LEVEL && curr > ABSORPTION_LEVEL) {
                return createBuySignal(cleanData, i, `Wick memory buy: decayed imbalance ${prev.toFixed(3)} -> ${curr.toFixed(3)} crossed above ${ABSORPTION_LEVEL}`);
            }
            if (prev >= -ABSORPTION_LEVEL && curr < -ABSORPTION_LEVEL) {
                return createSellSignal(cleanData, i, `Wick memory sell: decayed imbalance ${prev.toFixed(3)} -> ${curr.toFixed(3)} crossed below ${-ABSORPTION_LEVEL}`);
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
