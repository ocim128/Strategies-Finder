import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingMinMax } from "./price-action-statistics-core";

const FLOOR_POSITION = 0.1;
const SPRING_CLOSE = 0.7;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const range_envelope_spring_follow: Strategy = {
    name: "Range Envelope Spring Follow",
    description: "Follows the directional spring when a bar's range sits at the floor of its own rolling envelope.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Range Envelope Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const { min, max } = buildRollingMinMax(ranges, lookback, true);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [min, max, closeLocation], (i) => {
            const lo = min[i];
            const hi = max[i];
            const loc = closeLocation[i];
            if (lo === null || hi === null || loc === null) return null;

            const width = hi - lo;
            if (width <= 0) return null;

            const position = (ranges[i] - lo) / width;
            if (position > FLOOR_POSITION) return null;

            // Maximal compression with a directional close: the spring's side.
            if (loc >= SPRING_CLOSE) {
                return createBuySignal(cleanData, i, `Range spring buy: range at envelope floor ${position.toFixed(3)} with close loc ${loc.toFixed(2)}`);
            }
            if (loc <= 1 - SPRING_CLOSE) {
                return createSellSignal(cleanData, i, `Range spring sell: range at envelope floor ${position.toFixed(3)} with close loc ${loc.toFixed(2)}`);
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
