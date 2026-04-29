import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeCloseLocationMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const close_location_median_alignment: Strategy = {
    name: "Close Location Median Alignment",
    description:
        "Combines intrabar close location with a trailing rolling median so entries only align when both same-bar acceptance and multi-week centerline position agree.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeCloseLocationMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseLocationMedianAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const closeLocation = buildCloseLocationSeries(cleanData);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [median], (i) => {
            const m = median[i];
            if (m === null) return null;

            if (closeLocation[i] > 0.5 && closes[i] > m) {
                return createBuySignal(cleanData, i, `Upper-half close location with close above median`);
            }
            if (closeLocation[i] < 0.5 && closes[i] < m) {
                return createSellSignal(cleanData, i, `Lower-half close location with close below median`);
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
