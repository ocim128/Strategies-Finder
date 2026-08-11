import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

const TAIL_LEVEL = 0.8;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const close_location_skew_tail_follow: Strategy = {
    name: "Close Location Skew Tail Follow",
    description: "Follows the tail regime of close placement: positive skew means occasional high closes pulse above a low bulk.",
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

        const skew = buildRollingSkewness(buildCloseLocationSeries(cleanData), lookback);

        return createSignalLoop(cleanData, [skew], (i) => {
            const prev = skew[i - 1];
            const curr = skew[i];
            if (curr === null) return null;

            // Crossing into the positive-tail regime; a null previous reading
            // counts as not-active so the first certified bar registers fresh.
            if ((prev === null || prev <= TAIL_LEVEL) && curr > TAIL_LEVEL) {
                return createBuySignal(cleanData, i, `Close-location skew buy: skew ${curr.toFixed(2)} crossed above ${TAIL_LEVEL}`);
            }
            if ((prev === null || prev >= -TAIL_LEVEL) && curr < -TAIL_LEVEL) {
                return createSellSignal(cleanData, i, `Close-location skew sell: skew ${curr.toFixed(2)} crossed below ${-TAIL_LEVEL}`);
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
