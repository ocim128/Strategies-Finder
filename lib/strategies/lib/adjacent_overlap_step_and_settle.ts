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
        high_overlap_threshold: Math.max(0.01, Math.min(1, Number(params.high_overlap_threshold ?? 0.65))),
    };
}

export const adjacent_overlap_step_and_settle: Strategy = {
    name: "Adjacent Overlap Step and Settle",
    description: "Trades value settlement following a 3-bar territorial rhythm: high overlap compression, expansion step, and settlement.",
    defaultParams: {
        high_overlap_threshold: 0.65,
    },
    paramLabels: {
        high_overlap_threshold: "High Overlap Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const high_overlap_threshold = p.high_overlap_threshold as number;
        if (cleanData.length < 3) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 2) return null;
            const o0 = overlap[i];
            const o1 = overlap[i - 1];
            const o2 = overlap[i - 2];
            if (o0 === null || o1 === null || o2 === null) return null;

            const isStepAndSettle = o2 >= high_overlap_threshold && o1 < 0.35 && o0 >= high_overlap_threshold;
            if (isStepAndSettle) {
                if (closes[i] > closes[i - 2]) {
                    return createBuySignal(cleanData, i, `Bullish step-and-settle: overlap rhythm ${o2.toFixed(2)}-${o1.toFixed(2)}-${o0.toFixed(2)}, close > close[i-2]`);
                }
                if (closes[i] < closes[i - 2]) {
                    return createSellSignal(cleanData, i, `Bearish step-and-settle: overlap rhythm ${o2.toFixed(2)}-${o1.toFixed(2)}-${o0.toFixed(2)}, close < close[i-2]`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["high_overlap_threshold"],
    },
};
