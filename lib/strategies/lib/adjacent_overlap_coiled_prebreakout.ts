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
        min_overlap: Math.max(0.01, Math.min(1, Number(params.min_overlap ?? 0.7))),
    };
}

export const adjacent_overlap_coiled_prebreakout: Strategy = {
    name: "Adjacent Overlap Coiled Pre-breakout",
    description: "Enters directional expansion when adjacent 4H bars exhibit extreme range overlap with directional close pressure.",
    defaultParams: {
        min_overlap: 0.7,
    },
    paramLabels: {
        min_overlap: "Min Overlap Ratio",
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
                if (loc >= 0.85) {
                    return createBuySignal(cleanData, i, `Bullish coiled prebreakout: overlap ${o.toFixed(3)} >= ${min_overlap}, close location ${loc.toFixed(3)} >= 0.85`);
                }
                if (loc <= 0.15) {
                    return createSellSignal(cleanData, i, `Bearish coiled prebreakout: overlap ${o.toFixed(3)} >= ${min_overlap}, close location ${loc.toFixed(3)} <= 0.15`);
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
