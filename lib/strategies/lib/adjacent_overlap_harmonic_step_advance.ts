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
        min_overlap: Math.max(0.1, Number(params.min_overlap ?? 0.382)),
    };
}

export const adjacent_overlap_harmonic_step_advance: Strategy = {
    name: "Adjacent Overlap Harmonic Step Advance",
    description: "Enters sustainable trend steps when adjacent range overlap settles within the harmonic golden ratio bracket with perimeter close location.",
    defaultParams: {
        min_overlap: 0.382,
    },
    paramLabels: {
        min_overlap: "Minimum Overlap Ratio",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const minOverlap = Number(params.min_overlap);

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [overlap, clsLoc], (i) => {
            const ov = overlap[i];
            const loc = clsLoc[i];
            if (ov === null || loc === null) return null;

            if (ov >= minOverlap && ov <= 0.618) {
                if (loc >= 0.80) {
                    return createBuySignal(cleanData, i, `Bullish harmonic advance: overlap=${ov.toFixed(3)} in [${minOverlap},0.618], closeLoc=${loc.toFixed(2)}>=0.80`);
                }
                if (loc <= 0.20) {
                    return createSellSignal(cleanData, i, `Bearish harmonic advance: overlap=${ov.toFixed(3)} in [${minOverlap},0.618], closeLoc=${loc.toFixed(2)}<=0.20`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_overlap"],
    },
};
