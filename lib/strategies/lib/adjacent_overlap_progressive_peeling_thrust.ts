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
        max_final_overlap: Math.max(0, Math.min(1, Number(params.max_final_overlap ?? 0.3))),
    };
}

export const adjacent_overlap_progressive_peeling_thrust: Strategy = {
    name: "Adjacent Overlap Progressive Peeling Thrust",
    description: "Enters momentum breakouts when consecutive adjacent range overlaps strictly decrease into low shared territory.",
    defaultParams: {
        max_final_overlap: 0.3,
    },
    paramLabels: {
        max_final_overlap: "Max Final Overlap",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const maxFinalOverlap = p.max_final_overlap as number;
        if (cleanData.length < 3) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 2) return null;

            const o0 = overlap[i - 2];
            const o1 = overlap[i - 1];
            const o2 = overlap[i];

            if (o0 > o1 && o1 > o2 && o2 <= maxFinalOverlap) {
                if (closes[i] > closes[i - 2]) {
                    return createBuySignal(cleanData, i, `Bullish peeling thrust: overlap ${o0.toFixed(2)} > ${o1.toFixed(2)} > ${o2.toFixed(2)} <= ${maxFinalOverlap}, close > close[i-2]`);
                }
                if (closes[i] < closes[i - 2]) {
                    return createSellSignal(cleanData, i, `Bearish peeling thrust: overlap ${o0.toFixed(2)} > ${o1.toFixed(2)} > ${o2.toFixed(2)} <= ${maxFinalOverlap}, close < close[i-2]`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_final_overlap"],
    },
};
