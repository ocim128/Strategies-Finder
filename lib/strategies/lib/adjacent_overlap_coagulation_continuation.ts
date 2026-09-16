import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildAdjacentRangeOverlapSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_final_overlap: Math.max(0.2, Math.min(0.95, Number(params.min_final_overlap ?? 0.70))),
    };
}

export const adjacent_overlap_coagulation_continuation: Strategy = {
    name: "Adjacent Overlap Coagulation Continuation",
    description: "Enters trend continuation when adjacent range overlap increases monotonically across 3 bars reaching at least min_final_overlap.",
    defaultParams: {
        min_final_overlap: 0.70,
    },
    paramLabels: {
        min_final_overlap: "Minimum Final Overlap",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const minFinal = Number(params.min_final_overlap);
        const closes = getCloses(cleanData);

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 2) return null;
            const o0 = overlap[i];
            const o1 = overlap[i - 1];
            const o2 = overlap[i - 2];
            if (o0 === null || o1 === null || o2 === null) return null;

            if (o2 < o1 && o1 < o0 && o0 >= minFinal) {
                if (closes[i] > closes[i - 2]) {
                    return createBuySignal(cleanData, i, `Bullish overlap coagulation: progression ${o2.toFixed(2)} < ${o1.toFixed(2)} < ${o0.toFixed(2)} >= ${minFinal}, up-trend`);
                }
                if (closes[i] < closes[i - 2]) {
                    return createSellSignal(cleanData, i, `Bearish overlap coagulation: progression ${o2.toFixed(2)} < ${o1.toFixed(2)} < ${o0.toFixed(2)} >= ${minFinal}, down-trend`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_final_overlap"],
    },
};
