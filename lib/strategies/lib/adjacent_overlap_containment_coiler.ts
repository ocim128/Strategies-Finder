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
        min_overlap: Math.max(0.01, Math.min(1, Number(params.min_overlap ?? 0.9))),
    };
}

export const adjacent_overlap_containment_coiler: Strategy = {
    name: "Adjacent Overlap Containment Coiler",
    description: "Pre-positions for directional breakouts when near-total range containment (overlap >= min_overlap) is coupled with biased close location.",
    defaultParams: {
        min_overlap: 0.9,
    },
    paramLabels: {
        min_overlap: "Min Containment Overlap",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const min_overlap = p.min_overlap as number;
        if (cleanData.length < 2) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [overlap, clsLoc], (i) => {
            if (i < 1) return null;
            const o = overlap[i];
            const loc = clsLoc[i];
            if (o === null || loc === null) return null;

            if (o >= min_overlap) {
                if (loc >= 0.75) {
                    return createBuySignal(cleanData, i, `Bullish containment coiler: overlap ${o.toFixed(3)} >= ${min_overlap}, close location ${loc.toFixed(3)} >= 0.75`);
                }
                if (loc <= 0.25) {
                    return createSellSignal(cleanData, i, `Bearish containment coiler: overlap ${o.toFixed(3)} >= ${min_overlap}, close location ${loc.toFixed(3)} <= 0.25`);
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
