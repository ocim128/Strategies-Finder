import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeMultiCycleMedianAlignmentParams(params: StrategyParams): StrategyParams {
    const fastMedian = Math.max(2, Math.round(params.fastMedian ?? 20));
    const slowMedian = Math.max(fastMedian + 1, Math.round(params.slowMedian ?? 126));

    return {
        ...params,
        fastMedian,
        slowMedian,
    };
}

export const multi_cycle_median_alignment: Strategy = {
    name: "Multi-Cycle Median Alignment",
    description:
        "Aligns a medium-term and long-term rolling median, using the close relative to both centers to isolate cleaner structural trend windows.",
    defaultParams: {
        fastMedian: 20,
        slowMedian: 126,
    },
    paramLabels: {
        fastMedian: "Fast Median",
        slowMedian: "Slow Median",
    },
    normalizeParams: normalizeMultiCycleMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMultiCycleMedianAlignmentParams(params);
        const minLookback = p.slowMedian as number;
        if (cleanData.length < minLookback) return [];

        const closes = getCloses(cleanData);
        const fastMedian = buildRollingMedian(closes, p.fastMedian as number);
        const slowMedian = buildRollingMedian(closes, p.slowMedian as number);

        return createSignalLoop(cleanData, [fastMedian, slowMedian], (i) => {
            if (i < minLookback - 1) return null;

            const fast = fastMedian[i];
            const slow = slowMedian[i];
            if (fast === null || slow === null) return null;

            if (fast > slow && closes[i] > fast && closes[i] > slow) {
                return createBuySignal(cleanData, i, "Fast and slow medians aligned upward");
            }
            if (fast < slow && closes[i] < fast && closes[i] < slow) {
                return createSellSignal(cleanData, i, "Fast and slow medians aligned downward");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fastMedian", "slowMedian"],
    },
};
