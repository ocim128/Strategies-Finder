import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getWeightedClosePrices,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";

const ENVELOPE_FLOOR = 0.1;
const ENVELOPE_CEILING = 0.9;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 24))),
    };
}

export const weighted_close_envelope_fade: Strategy = {
    name: "Weighted Close Envelope Fade",
    description: "Fades settlement-weighted price at the extremes of its own rolling envelope, toward the envelope center.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Envelope Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const weighted = getWeightedClosePrices(cleanData);
        const { min, max } = buildRollingMinMax(weighted, lookback, true);

        return createSignalLoop(cleanData, [min, max], (i) => {
            const lo = min[i];
            const hi = max[i];
            const prevLo = min[i - 1];
            const prevHi = max[i - 1];
            if (lo === null || hi === null || prevLo === null || prevHi === null) return null;

            const width = hi - lo;
            if (width <= 0) return null;

            const position = (weighted[i] - lo) / width;
            const prevPosition = (weighted[i - 1] - prevLo) / Math.max(prevHi - prevLo, Number.EPSILON);

            // Crossing into the envelope floor / ceiling, toward the center.
            if (prevPosition >= ENVELOPE_FLOOR && position < ENVELOPE_FLOOR) {
                return createBuySignal(cleanData, i, `Envelope buy: weighted-close position ${position.toFixed(3)} crossed below ${ENVELOPE_FLOOR}`);
            }
            if (prevPosition <= ENVELOPE_CEILING && position > ENVELOPE_CEILING) {
                return createSellSignal(cleanData, i, `Envelope sell: weighted-close position ${position.toFixed(3)} crossed above ${ENVELOPE_CEILING}`);
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
