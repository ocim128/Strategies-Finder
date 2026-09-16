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
        max_overlap: Math.max(0, Math.min(1, Number(params.max_overlap ?? 0.25))),
    };
}

export const adjacent_range_expansion_thrust: Strategy = {
    name: "Adjacent Range Expansion Thrust",
    description: "Enters directional range expansion when consecutive range overlap drops below max_overlap with supportive close location.",
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
        const maxOverlap = p.max_overlap as number;
        if (cleanData.length < 2) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [overlap, closeLocation], (i) => {
            if (i < 1) return null;
            const ov = overlap[i];
            const cl = closeLocation[i];
            if (ov === null || cl === null) return null;

            if (ov < maxOverlap) {
                if (cl >= 0.80) {
                    return createBuySignal(cleanData, i, `Bullish range expansion thrust: overlap ${ov.toFixed(2)} < ${maxOverlap}, closeLocation ${cl.toFixed(2)} >= 0.80`);
                }
                if (cl <= 0.20) {
                    return createSellSignal(cleanData, i, `Bearish range expansion thrust: overlap ${ov.toFixed(2)} < ${maxOverlap}, closeLocation ${cl.toFixed(2)} <= 0.20`);
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
