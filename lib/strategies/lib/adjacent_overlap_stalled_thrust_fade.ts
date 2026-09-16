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
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        max_overlap: Math.max(0.01, Math.min(1, Number(params.max_overlap ?? 0.25))),
    };
}

export const adjacent_overlap_stalled_thrust_fade: Strategy = {
    name: "Adjacent Overlap Stalled Thrust Fade",
    description: "Fades expansion thrusts that fail to close near their extremes, stalling near their midpoints in low-overlap territory.",
    defaultParams: {
        max_overlap: 0.25,
    },
    paramLabels: {
        max_overlap: "Max Overlap",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const max_overlap = p.max_overlap as number;
        if (cleanData.length < 2) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [overlap, clsLoc], (i) => {
            if (i < 1) return null;
            const o = overlap[i];
            const loc = clsLoc[i];
            if (o === null || loc === null) return null;

            const isMidpointClose = loc >= 0.40 && loc <= 0.60;
            if (o < max_overlap && isMidpointClose) {
                if (cleanData[i].close < cleanData[i - 1].low) {
                    return createBuySignal(cleanData, i, `Bullish stalled thrust fade: overlap ${o.toFixed(3)} < ${max_overlap}, close < prior low, midpoint close location ${loc.toFixed(3)}`);
                }
                if (cleanData[i].close > cleanData[i - 1].high) {
                    return createSellSignal(cleanData, i, `Bearish stalled thrust fade: overlap ${o.toFixed(3)} < ${max_overlap}, close > prior high, midpoint close location ${loc.toFixed(3)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_overlap"],
    },
};
