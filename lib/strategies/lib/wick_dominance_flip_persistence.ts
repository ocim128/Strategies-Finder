import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";

const NEUTRAL_BAND = 0.15;
const MAX_FLIPS = 2;
const DOMINANCE_MAGNITUDE = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const wick_dominance_flip_persistence: Strategy = {
    name: "Wick Dominance Flip Persistence",
    description: "Follows strongly one-sided wick dominance when sign flips through the neutral band are rare: persistent absorption on one side.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Flip Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const imbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const flipCount = buildThresholdCrossingCount(imbalance, lookback, NEUTRAL_BAND);

        return createSignalLoop(cleanData, [flipCount, imbalance], (i) => {
            const flips = flipCount[i];
            const wick = imbalance[i];
            if (flips === null) return null;

            // One side persistently absorbs: few flips and strongly one-sided now.
            if (flips <= MAX_FLIPS && wick > DOMINANCE_MAGNITUDE) {
                return createBuySignal(cleanData, i, `Wick persistence buy: ${flips} flips, imbalance ${wick.toFixed(2)}`);
            }
            if (flips <= MAX_FLIPS && wick < -DOMINANCE_MAGNITUDE) {
                return createSellSignal(cleanData, i, `Wick persistence sell: ${flips} flips, imbalance ${wick.toFixed(2)}`);
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
