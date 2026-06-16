import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRollingZScore,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.8)),
        minWickPercentile: Math.max(0.5, Math.min(1.0, Number(params.minWickPercentile ?? 0.80))),
    };
}

export const wick_rejection_median_fade: Strategy = {
    name: "Wick Rejection Median Fade",
    description: "Fades deviation from the rolling median when the current bar displays a large wick pointing away from the median.",
    defaultParams: {
        lookback: 25,
        zThreshold: 1.8,
        minWickPercentile: 0.80,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
        minWickPercentile: "Min Wick Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const closeZ = buildRollingZScore(closes, lookback);

        const rawImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        // Lower wick percentile (rawImbalance represents lower - upper)
        const lowerWickPercentile = buildPercentileRank(rawImbalance, lookback);

        // Upper wick percentile (negating rawImbalance to represent upper - lower)
        const upperWickSeries = rawImbalance.map((v) => -v);
        const upperWickPercentile = buildPercentileRank(upperWickSeries, lookback);

        return createSignalLoop(cleanData, [closeZ, lowerWickPercentile, upperWickPercentile], (i) => {
            const z = closeZ[i];
            const lp = lowerWickPercentile[i];
            const up = upperWickPercentile[i];
            if (z === null || lp === null || up === null) return null;

            // Buy: price is below median (Z < -zThreshold) and lower wick is extreme (lp > minWickPercentile)
            if (z < -p.zThreshold && lp > p.minWickPercentile) {
                return createBuySignal(cleanData, i, `Wick rejection buy: Z ${z.toFixed(2)}, lower wick rank ${lp.toFixed(2)}`);
            }
            // Sell: price is above median (Z > zThreshold) and upper wick is extreme (up > minWickPercentile)
            if (z > p.zThreshold && up > p.minWickPercentile) {
                return createSellSignal(cleanData, i, `Wick rejection sell: Z ${z.toFixed(2)}, upper wick rank ${up.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold", "minWickPercentile"],
    },
};
