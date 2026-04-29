import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeGapDisplacementReversalFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        gap_threshold: Math.max(0.0001, Math.abs(Number(params.gap_threshold ?? 0.02))),
    };
}

export const gap_displacement_reversal_fade: Strategy = {
    name: "Gap Displacement Reversal Fade",
    description:
        "Fades outsized overnight gaps, assuming extreme open-to-previous-close displacement is prone to short-horizon settlement back toward value.",
    defaultParams: {
        gap_threshold: 0.02,
    },
    paramLabels: {
        gap_threshold: "Gap Threshold",
    },
    normalizeParams: normalizeGapDisplacementReversalFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeGapDisplacementReversalFadeParams(params);
        const threshold = p.gap_threshold as number;
        if (cleanData.length < 2) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");

        return createSignalLoop(cleanData, [], (i) => {
            const gap = gapPct[i];
            if (gap <= -threshold) {
                return createBuySignal(cleanData, i, `Gap down ${gap.toFixed(4)} <= -${threshold}`);
            }
            if (gap >= threshold) {
                return createSellSignal(cleanData, i, `Gap up ${gap.toFixed(4)} >= ${threshold}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["gap_threshold"],
    },
};
