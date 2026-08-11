import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingEntropy } from "./price-action-statistics-core";

const ENTROPY_THRESHOLD = 1.2;
const EXTREME_PLACEMENT = 0.7;
const ENTROPY_BINS = 5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const close_location_entropy_compression: Strategy = {
    name: "Close Location Entropy Compression",
    description: "Follows persistent one-sided settlement: when close-placement entropy collapses, ride closes at the concentrated extreme.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Placement Distribution Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const entropy = buildRollingEntropy(closeLocation, lookback, ENTROPY_BINS);

        return createSignalLoop(cleanData, [entropy, closeLocation], (i) => {
            const ent = entropy[i];
            const loc = closeLocation[i];
            if (ent === null || loc === null) return null;

            // Concentrated settlement at the range high: follow the placement.
            if (ent < ENTROPY_THRESHOLD && loc >= EXTREME_PLACEMENT) {
                return createBuySignal(cleanData, i, `Entropy compression buy: entropy ${ent.toFixed(2)} with close loc ${loc.toFixed(2)}`);
            }
            if (ent < ENTROPY_THRESHOLD && loc <= 1 - EXTREME_PLACEMENT) {
                return createSellSignal(cleanData, i, `Entropy compression sell: entropy ${ent.toFixed(2)} with close loc ${loc.toFixed(2)}`);
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
