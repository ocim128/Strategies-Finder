import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildAdjacentRangeOverlapSeries,
    buildCloseLocationSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 20))),
    };
}

export const adjacent_overlap_goldilocks_trend_channel: Strategy = {
    name: "Adjacent Overlap Goldilocks Trend Channel",
    description: "Enters trend continuation when rolling mean overlap is balanced in the 0.45 to 0.55 Goldilocks zone with outer close location.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const avgOverlap = buildRollingAverage(overlap, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [avgOverlap, clsLoc], (i) => {
            const avgOv = avgOverlap[i];
            const loc = clsLoc[i];
            if (avgOv === null || loc === null) return null;

            if (avgOv >= 0.45 && avgOv <= 0.55) {
                if (loc >= 0.80) {
                    return createBuySignal(cleanData, i, `Bullish Goldilocks trend channel: avgOverlap=${avgOv.toFixed(2)} in [0.45,0.55], closeLoc=${loc.toFixed(2)}>=0.80`);
                }
                if (loc <= 0.20) {
                    return createSellSignal(cleanData, i, `Bearish Goldilocks trend channel: avgOverlap=${avgOv.toFixed(2)} in [0.45,0.55], closeLoc=${loc.toFixed(2)}<=0.20`);
                }
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
