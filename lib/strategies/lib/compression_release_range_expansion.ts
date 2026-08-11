import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildRangeSeries,
} from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const DEPRESSED_RANK = 0.2;
const EXPANSION_RANK = 0.9;
const CONFIRMING_CLOSE = 0.7;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
    };
}

export const compression_release_range_expansion: Strategy = {
    name: "Compression Release Range Expansion",
    description: "Buys expansion bars that break out of a compressed-range regime with a strong close, and sells the mirror.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Range Percentile Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const rangeRank = buildPercentileRank(buildRangeSeries(cleanData), lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangeRank, closeLocation], (i) => {
            const prevRank = rangeRank[i - 1];
            const currRank = rangeRank[i];
            const loc = closeLocation[i];
            if (prevRank === null || currRank === null || loc === null) return null;

            // Compression regime (previous bar quietly ranged) releases into an
            // expansion bar closing strongly in the direction of the release.
            if (prevRank <= DEPRESSED_RANK && currRank >= EXPANSION_RANK && loc >= CONFIRMING_CLOSE) {
                return createBuySignal(cleanData, i, `Compression release buy: prev range rank ${prevRank.toFixed(2)} -> ${currRank.toFixed(2)}, close loc ${loc.toFixed(2)}`);
            }
            if (prevRank <= DEPRESSED_RANK && currRank >= EXPANSION_RANK && loc <= 1 - CONFIRMING_CLOSE) {
                return createSellSignal(cleanData, i, `Compression release sell: prev range rank ${prevRank.toFixed(2)} -> ${currRank.toFixed(2)}, close loc ${loc.toFixed(2)}`);
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
