import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";

const DEVIATION_BAND = 2.0;
const EXHAUSTION_LOCATION = 0.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 24))),
    };
}

export const deviation_close_location_agreement_fade: Strategy = {
    name: "Deviation Close Location Agreement Fade",
    description: "Fades close deviations from the rolling median only when the same bar closes at its own extreme.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Deviation Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const std = buildRollingStdDev(closes, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [median, std, closeLocation], (i) => {
            const med = median[i];
            const sd = std[i];
            const loc = closeLocation[i];
            if (med === null || sd === null || sd <= 0 || loc === null) return null;

            const deviation = (closes[i] - med) / sd;

            // Stretched below the center AND closing at its low: exhaustion confirmed.
            if (deviation <= -DEVIATION_BAND && loc <= EXHAUSTION_LOCATION) {
                return createBuySignal(cleanData, i, `Deviation-location buy: dev ${deviation.toFixed(2)} at close loc ${loc.toFixed(2)}`);
            }
            if (deviation >= DEVIATION_BAND && loc >= 1 - EXHAUSTION_LOCATION) {
                return createSellSignal(cleanData, i, `Deviation-location sell: dev ${deviation.toFixed(2)} at close loc ${loc.toFixed(2)}`);
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
