import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeDojiResolutionContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        dojiThreshold: Math.max(0.05, Math.min(0.5, Number(params.dojiThreshold ?? 0.15))),
    };
}

export const doji_resolution_continuation: Strategy = {
    name: "Doji Resolution Continuation",
    description: "Follows the first high-conviction bar that resolves a prior indecision doji.",
    defaultParams: {
        dojiThreshold: 0.15,
    },
    paramLabels: {
        dojiThreshold: "Doji Body Threshold",
    },
    normalizeParams: normalizeDojiResolutionContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDojiResolutionContinuationParams(params);
        const dojiThreshold = p.dojiThreshold as number;
        if (cleanData.length < 2) return [];

        const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            if (bodyPct[i - 1] <= dojiThreshold && bodyPct[i] >= 0.5 && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Conviction bar (body ${(bodyPct[i] * 100).toFixed(0)}%) resolves prior doji (body ${(bodyPct[i - 1] * 100).toFixed(0)}%)`);
            }
            if (bodyPct[i - 1] <= dojiThreshold && bodyPct[i] >= 0.5 && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Conviction bar (body ${(bodyPct[i] * 100).toFixed(0)}%) resolves prior doji (body ${(bodyPct[i - 1] * 100).toFixed(0)}%)`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["dojiThreshold"],
    },
};
