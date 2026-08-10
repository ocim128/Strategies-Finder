import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeGapRepricingThresholdParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        gapThreshold: Math.max(0.002, Math.min(0.1, Number(params.gapThreshold ?? 0.02))),
    };
}

export const gap_repricing_threshold: Strategy = {
    name: "Gap Repricing Threshold",
    description: "Follows opens that reprice beyond a magic return threshold as information events.",
    defaultParams: {
        gapThreshold: 0.02,
    },
    paramLabels: {
        gapThreshold: "Gap Threshold",
    },
    normalizeParams: normalizeGapRepricingThresholdParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeGapRepricingThresholdParams(params);
        const gapThreshold = p.gapThreshold as number;
        if (cleanData.length < 2) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            if (gapPct[i] > gapThreshold) {
                return createBuySignal(cleanData, i, `Up repricing gap: ${(gapPct[i] * 100).toFixed(2)}%`);
            }
            if (gapPct[i] < -gapThreshold) {
                return createSellSignal(cleanData, i, `Down repricing gap: ${(gapPct[i] * 100).toFixed(2)}%`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["gapThreshold"],
    },
};
