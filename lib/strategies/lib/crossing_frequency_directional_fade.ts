import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";
import {
    buildRollingMedian,
    buildThresholdCrossingCount,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        crossingMin: Math.max(1, Math.round(Number(params.crossingMin ?? 5))),
    };
}

export const crossing_frequency_directional_fade: Strategy = {
    name: "Crossing Frequency Directional Fade",
    description: "Fades the drift component in an oscillating regime confirmed by frequent median crossings.",
    defaultParams: {
        lookback: 30,
        crossingMin: 5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        crossingMin: "Min Crossing Count",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        const diffs: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            diffs[i] = m !== null ? closes[i] - m : 0;
        }

        const crossCount = buildThresholdCrossingCount(diffs, lookback, 0);

        const closeLocation = buildCloseLocationSeries(cleanData);
        const clAvg = buildRollingAverage(closeLocation, lookback);

        return createSignalLoop(cleanData, [crossCount, clAvg], (i) => {
            const cc = crossCount[i];
            const cla = clAvg[i];
            if (cc === null || cla === null) return null;

            const cl = closeLocation[i];

            if (cc >= p.crossingMin) {
                // Buy: oscillation with upward drift, but current close is low
                if (cla > 0.6 && cl < 0.3) {
                    return createBuySignal(cleanData, i, `Crossing freq buy: CC ${cc}, CLA ${cla.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
                // Sell: oscillation with downward drift, but current close is high
                if (cla < 0.4 && cl > 0.7) {
                    return createSellSignal(cleanData, i, `Crossing freq sell: CC ${cc}, CLA ${cla.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "crossingMin"],
    },
};
