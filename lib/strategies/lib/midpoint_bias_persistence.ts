import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildThresholdCrossingCount, extractBarMetricSeries } from "./price-action-statistics-core";

const BIAS_STRENGTH = 0.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 12))),
    };
}

export const midpoint_bias_persistence: Strategy = {
    name: "Midpoint Bias Persistence",
    description: "Buys unbroken runs of closes above each bar's own midpoint and sells unbroken runs below it, gated by crossing silence.",
    defaultParams: {
        lookback: 12,
    },
    paramLabels: {
        lookback: "Bias Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closeMidpointDev = extractBarMetricSeries(cleanData, "closeMidpointDev");
        // Threshold 0 counts zero-line sign flips of the deviation causally.
        const flipCount = buildThresholdCrossingCount(closeMidpointDev, lookback, 0);

        return createSignalLoop(cleanData, [flipCount], (i) => {
            const flips = flipCount[i];
            if (flips === null) return null;

            // Bias never flipped across the window and is currently strongly positive.
            if (flips === 0 && closeMidpointDev[i] >= BIAS_STRENGTH) {
                return createBuySignal(cleanData, i, `Midpoint bias buy: no flips in ${lookback} bars, deviation ${closeMidpointDev[i].toFixed(2)}`);
            }
            // Bias never flipped and is currently strongly negative.
            if (flips === 0 && closeMidpointDev[i] <= -BIAS_STRENGTH) {
                return createSellSignal(cleanData, i, `Midpoint bias sell: no flips in ${lookback} bars, deviation ${closeMidpointDev[i].toFixed(2)}`);
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
