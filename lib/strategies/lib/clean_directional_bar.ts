import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { computePriceActionBarMetrics, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeCleanDirectionalBarParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        wickShareThreshold: Math.max(0.05, Math.min(0.5, Number(params.wickShareThreshold ?? 0.25))),
    };
}

export const clean_directional_bar: Strategy = {
    name: "Clean Directional Bar",
    description: "Follows directional bars whose losing-side wick stays within a magic share of the range, marking unopposed moves.",
    defaultParams: {
        wickShareThreshold: 0.25,
    },
    paramLabels: {
        wickShareThreshold: "Wick Share Threshold",
    },
    normalizeParams: normalizeCleanDirectionalBarParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCleanDirectionalBarParams(params);
        const wickShareThreshold = p.wickShareThreshold as number;
        if (cleanData.length < 2) return [];

        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const upperWickRatio: number[] = new Array(cleanData.length);
        const lowerWickRatio: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            const metrics = computePriceActionBarMetrics(cleanData[i]);
            upperWickRatio[i] = metrics.range > 0 ? metrics.upperWick / metrics.range : 0;
            lowerWickRatio[i] = metrics.range > 0 ? metrics.lowerWick / metrics.range : 0;
        }

        return createSignalLoop(cleanData, [], (i) => {
            if (bodyDirection[i] > 0 && upperWickRatio[i] <= wickShareThreshold) {
                return createBuySignal(cleanData, i, `Clean up bar: upper wick ${(upperWickRatio[i] * 100).toFixed(0)}% of range`);
            }
            if (bodyDirection[i] < 0 && lowerWickRatio[i] <= wickShareThreshold) {
                return createSellSignal(cleanData, i, `Clean down bar: lower wick ${(lowerWickRatio[i] * 100).toFixed(0)}% of range`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["wickShareThreshold"],
    },
};
