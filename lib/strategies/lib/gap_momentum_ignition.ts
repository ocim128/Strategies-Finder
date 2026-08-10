import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeGapMomentumIgnitionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const gap_momentum_ignition: Strategy = {
    name: "Gap Momentum Ignition",
    description: "Follows accelerating gap opens as directional initiation when the gap rate of change is at an extreme percentile.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeGapMomentumIgnitionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeGapMomentumIgnitionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const gapRoc = buildRateOfChange(gapPct, 1);
        const gapRocClean = gapRoc.map((v) => v ?? 0);
        const rocRank = buildPercentileRank(gapRocClean, lookback);

        return createSignalLoop(cleanData, [rocRank], (i) => {
            if (i < lookback) return null;
            const rank = rocRank[i];
            if (rank === null) return null;

            if (rank > 0.8 && gapPct[i] > 0) {
                return createBuySignal(cleanData, i, `Gap acceleration percentile ${rank.toFixed(2)} with positive gap (${(gapPct[i] * 100).toFixed(2)}%)`);
            }
            if (rank < 0.2 && gapPct[i] < 0) {
                return createSellSignal(cleanData, i, `Gap acceleration percentile ${rank.toFixed(2)} with negative gap (${(gapPct[i] * 100).toFixed(2)}%)`);
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
