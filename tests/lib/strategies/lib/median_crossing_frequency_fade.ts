import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildThresholdCrossingCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        crossingMin: Math.max(1, Math.round(Number(params.crossingMin ?? 5))),
    };
}

export const median_crossing_frequency_fade: Strategy = {
    name: "Median Crossing Frequency Fade",
    description: "Fades median overshoots during high crossing frequency regimes.",
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

        const diffs = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            diffs[i] = m !== null ? closes[i] - m : 0;
        }

        const crossingCount = buildThresholdCrossingCount(diffs, lookback, 0);

        return createSignalLoop(cleanData, [median, crossingCount], (i) => {
            const m = median[i];
            const cc = crossingCount[i];
            if (m === null || cc === null) return null;

            const close = closes[i];
            const open = cleanData[i].open;

            // Buy: high crossing frequency, close below median, close below open (rejecting downward)
            if (cc >= p.crossingMin && close < m && close < open) {
                return createBuySignal(cleanData, i, `Median crossing freq buy: crossings ${cc}`);
            }
            // Sell: high crossing frequency, close above median, close above open (rejecting upward)
            if (cc >= p.crossingMin && close > m && close > open) {
                return createSellSignal(cleanData, i, `Median crossing freq sell: crossings ${cc}`);
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
