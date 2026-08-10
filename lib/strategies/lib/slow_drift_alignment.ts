import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeSlowDriftAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        driftLookback: Math.max(20, Math.round(Number(params.driftLookback ?? 100))),
    };
}

export const slow_drift_alignment: Strategy = {
    name: "Slow Drift Alignment",
    description: "Aligns with a long-window close drift at an extreme percentile, confirmed by same-bar body direction.",
    defaultParams: {
        driftLookback: 100,
    },
    paramLabels: {
        driftLookback: "Drift Lookback",
    },
    normalizeParams: normalizeSlowDriftAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSlowDriftAlignmentParams(params);
        const driftLookback = p.driftLookback as number;
        if (cleanData.length < driftLookback + 1) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, driftLookback);
        const rocClean = roc.map((v) => v ?? 0);
        const driftRank = buildPercentileRank(rocClean, driftLookback);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");

        return createSignalLoop(cleanData, [driftRank], (i) => {
            if (i < driftLookback) return null;
            const rank = driftRank[i];
            if (rank === null) return null;

            if (rank > 0.7 && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Slow drift percentile ${rank.toFixed(2)} with up body`);
            }
            if (rank < 0.3 && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Slow drift percentile ${rank.toFixed(2)} with down body`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["driftLookback"],
    },
};
