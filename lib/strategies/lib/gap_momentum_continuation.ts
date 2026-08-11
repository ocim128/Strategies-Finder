import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const GAP_PERCENTILE = 0.9;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const gap_momentum_continuation: Strategy = {
    name: "Gap Momentum Continuation",
    description: "Follows large percentile gaps that the same bar closes in the gap direction: accepted, imbalance-driven price steps.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Gap Percentile Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const gapRank = buildPercentileRank(gapPct.map((g) => Math.abs(g)), lookback);

        return createSignalLoop(cleanData, [gapRank], (i) => {
            const rank = gapRank[i];
            if (rank === null || i < 1) return null;

            // Gap-and-go: the gap is unusual and the bar closes in its direction.
            if (rank >= GAP_PERCENTILE && gapPct[i] > 0 && closeReturn[i] > 0) {
                return createBuySignal(cleanData, i, `Gap momentum buy: ${(gapPct[i] * 100).toFixed(2)}% gap (rank ${rank.toFixed(2)}) continued up`);
            }
            if (rank >= GAP_PERCENTILE && gapPct[i] < 0 && closeReturn[i] < 0) {
                return createSellSignal(cleanData, i, `Gap momentum sell: ${(gapPct[i] * 100).toFixed(2)}% gap (rank ${rank.toFixed(2)}) continued down`);
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
