import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

const MEDIAN_RANGE_WINDOW = 20;
const RELEASE_LOCATION = 0.7;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        minCompressionBars: Math.max(2, Math.round(Number(params.minCompressionBars ?? 4))),
    };
}

export const compression_streak_expansion_entry: Strategy = {
    name: "Compression Streak Expansion Entry",
    description: "Enters on the range release after a streak of compressed bars, riding the release in the direction of its close.",
    defaultParams: {
        minCompressionBars: 4,
    },
    paramLabels: {
        minCompressionBars: "Minimum Compression Bars",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minCompressionBars = p.minCompressionBars as number;
        if (cleanData.length < MEDIAN_RANGE_WINDOW + 1) return [];

        const ranges = buildRangeSeries(cleanData);
        const medianRange = buildRollingMedian(ranges, MEDIAN_RANGE_WINDOW);
        const closeLocation = buildCloseLocationSeries(cleanData);

        // Compressed flags against the fixed 20-bar median; null medians read as
        // not-compressed, so the streak only ever counts real compression.
        const flags = ranges.map((r, i) => {
            const med = medianRange[i];
            return med === null || r >= med ? 0 : 1;
        });
        const streak = buildStreakCount(flags);

        return createSignalLoop(cleanData, [medianRange, closeLocation], (i) => {
            const med = medianRange[i];
            const loc = closeLocation[i];
            if (med === null || loc === null || i < MEDIAN_RANGE_WINDOW + 1) return null;

            // Coiled long enough, then the release bar expands with a strong close.
            if (streak[i - 1] >= minCompressionBars && ranges[i] > med && loc >= RELEASE_LOCATION) {
                return createBuySignal(cleanData, i, `Compression release buy: ${streak[i - 1]} compressed bars then expansion with close loc ${loc.toFixed(2)}`);
            }
            if (streak[i - 1] >= minCompressionBars && ranges[i] > med && loc <= 1 - RELEASE_LOCATION) {
                return createSellSignal(cleanData, i, `Compression release sell: ${streak[i - 1]} compressed bars then expansion with close loc ${loc.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["minCompressionBars"],
    },
};
