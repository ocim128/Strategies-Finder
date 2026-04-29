import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeRollingGapZscoreAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const rolling_gap_zscore_alignment: Strategy = {
    name: "Rolling Gap Z-Score Alignment",
    description:
        "Measures the current daily gap against its own trailing gap distribution and aligns entries once displacement is already statistically positive or negative.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRollingGapZscoreAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRollingGapZscoreAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const gaps = extractBarMetricSeries(cleanData, "gapPct");
        const gapZscore = buildRollingZScore(gaps, lookback);

        return createSignalLoop(cleanData, [gapZscore], (i) => {
            const z = gapZscore[i];
            if (z === null) return null;

            if (z > 0.5) {
                return createBuySignal(cleanData, i, `Gap z-score ${z.toFixed(2)} above 0.5`);
            }
            if (z < -0.5) {
                return createSellSignal(cleanData, i, `Gap z-score ${z.toFixed(2)} below -0.5`);
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
