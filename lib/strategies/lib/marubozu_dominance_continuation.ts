import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeMarubozuDominanceContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const marubozu_dominance_continuation: Strategy = {
    name: "Marubozu Dominance Continuation",
    description: "Follows extreme body-share bars as one-sided control that tends to persist.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeMarubozuDominanceContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMarubozuDominanceContinuationParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const bodyRank = buildPercentileRank(bodyPct, lookback);

        return createSignalLoop(cleanData, [bodyRank], (i) => {
            if (i < lookback) return null;
            const rank = bodyRank[i];
            if (rank === null) return null;

            if (rank > 0.9 && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Marubozu up bar: body percentile ${rank.toFixed(2)}`);
            }
            if (rank > 0.9 && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Marubozu down bar: body percentile ${rank.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
