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
    buildOpenLocationSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_overlap: Math.max(0.1, Math.min(0.9, Number(params.min_overlap ?? 0.55))),
    };
}

export const adjacent_overlap_rotational_drive_thrust: Strategy = {
    name: "Adjacent Overlap Rotational Drive Thrust",
    description: "Enters full-span rotational drive across high-overlap territory opening at one edge and closing at the opposite extreme.",
    defaultParams: {
        min_overlap: 0.55,
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
        const openLoc = buildOpenLocationSeries(cleanData);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [overlap, openLoc, clsLoc], (i) => {
            const ov = overlap[i];
            const oLoc = openLoc[i];
            const cLoc = clsLoc[i];
            if (ov === null || oLoc === null || cLoc === null) return null;

            if (ov >= minOverlap) {
                if (oLoc <= 0.20 && cLoc >= 0.85) {
                    return createBuySignal(cleanData, i, `Bullish rotational drive: overlap=${ov.toFixed(2)}>=${minOverlap}, openLoc=${oLoc.toFixed(2)}<=0.20, closeLoc=${cLoc.toFixed(2)}>=0.85`);
                }
                if (oLoc >= 0.80 && cLoc <= 0.15) {
                    return createSellSignal(cleanData, i, `Bearish rotational drive: overlap=${ov.toFixed(2)}>=${minOverlap}, openLoc=${oLoc.toFixed(2)}>=0.80, closeLoc=${cLoc.toFixed(2)}<=0.15`);
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
