import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeCloseMedianZscoreAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(params.lookback ?? 30)),
        threshold: Math.max(0.1, Number(params.threshold ?? 1.0)),
    };
}

export const close_median_zscore_alignment: Strategy = {
    name: "Close Median Z-Score Alignment",
    description: "The z-score of the close relative to its rolling median and standard deviation measures how far price has displaced from its robust causal center. Positive displacement means price has shifted above the distribution center; negative means below.",
    defaultParams: {
        lookback: 30,
        threshold: 1.0,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Threshold",
    },
    normalizeParams: normalizeCloseMedianZscoreAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseMedianZscoreAlignmentParams(params);
        if (cleanData.length < p.lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, p.lookback);
        const stdDev = buildRollingStdDev(closes, p.lookback);

        return createSignalLoop(cleanData, [median, stdDev], (i) => {
            if (i < p.lookback) return null;
            const med = median[i];
            const sd = stdDev[i];
            if (med === null || sd === null || sd < 1e-9) return null;

            const z = (closes[i] - med) / sd;
            if (z > p.threshold) {
                return createBuySignal(cleanData, i, `Z-score ${z.toFixed(3)} above median exceeds threshold`);
            }
            if (z < -p.threshold) {
                return createSellSignal(cleanData, i, `Z-score ${z.toFixed(3)} below median exceeds threshold`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
