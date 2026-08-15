import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

const EXPANSION_MULTIPLIER = 1.5;
const PLACEMENT_MID = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 30))),
    };
}

export const expansion_bar_directional_agreement: Strategy = {
    name: "Expansion Bar Directional Agreement",
    description: "Continues when a range-expansion bar closes directionally in the far half of its own range.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Median Range Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const medianRange = buildRollingMedian(ranges, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [medianRange], (i) => {
            const median = medianRange[i];
            if (median === null || median <= 0) return null;

            const ratio = ranges[i] / median;
            if (ratio <= EXPANSION_MULTIPLIER) return null;

            const bar = cleanData[i];
            if (bar.close > bar.open && closeLocation[i] > PLACEMENT_MID) {
                return createBuySignal(cleanData, i, `Accepted bullish expansion: ${ratio.toFixed(2)}x median range`);
            }
            if (bar.close < bar.open && closeLocation[i] < PLACEMENT_MID) {
                return createSellSignal(cleanData, i, `Accepted bearish expansion: ${ratio.toFixed(2)}x median range`);
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
