import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRollingZScore,
    buildThresholdCrossingCount,
} from "./price-action-statistics-core";

const EXCURSION_BAND = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 60))),
    };
}

export const first_excursion_reversion: Strategy = {
    name: "First Excursion Reversion",
    description: "Fades only the first band excursion inside the lookback window, when the window's crossing count is exactly one.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback * 2) return [];

        const z = buildRollingZScore(getCloses(cleanData), lookback);
        // Leading warm-up nulls are coerced so the crossing counter sees a dense
        // series; the warm-up guard below keeps those bars silent.
        const zNumbers = z.map((v) => (v === null ? 0 : v));
        const crossings = buildThresholdCrossingCount(zNumbers, lookback, EXCURSION_BAND);
        // Crossing events reference the prior bar, so the count window is fully
        // real only one bar later than the z-score warm-up itself.
        const firstValid = lookback * 2 - 1;

        return createSignalLoop(cleanData, [crossings], (i) => {
            if (i < firstValid) return null;
            const curr = z[i];
            const prev = z[i - 1];
            const count = crossings[i];
            if (curr === null || prev === null || count === null) return null;

            // Fresh cross into the band and it is the window's first excursion.
            if (curr <= -EXCURSION_BAND && prev > -EXCURSION_BAND && count === 1) {
                return createBuySignal(cleanData, i, `First excursion buy: z ${curr.toFixed(2)}, ${count} crossing in window`);
            }
            if (curr >= EXCURSION_BAND && prev < EXCURSION_BAND && count === 1) {
                return createSellSignal(cleanData, i, `First excursion sell: z ${curr.toFixed(2)}, ${count} crossing in window`);
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
