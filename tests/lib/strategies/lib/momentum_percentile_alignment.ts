import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateMomentum } from "../indicators";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeMomentumPercentileAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        threshold: Math.max(50, Math.min(99, Number(params.threshold ?? 70))),
    };
}

export const momentum_percentile_alignment: Strategy = {
    name: "Momentum Percentile Alignment",
    description:
        "Ranks current one-bar momentum against its own trailing distribution and aligns entries only when that momentum state is already statistically strong or weak.",
    defaultParams: {
        lookback: 63,
        threshold: 70,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Threshold",
    },
    normalizeParams: normalizeMomentumPercentileAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMomentumPercentileAlignmentParams(params);
        const lookback = p.lookback as number;
        const threshold = (p.threshold as number) / 100;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const momentum = calculateMomentum(closes, 1).map((value) => value ?? 0);
        const rank = buildPercentileRank(momentum, lookback);

        return createSignalLoop(cleanData, [rank], (i) => {
            const percentileRank = rank[i];
            if (percentileRank === null) return null;

            if (percentileRank > threshold) {
                return createBuySignal(cleanData, i, `Momentum percentile ${(percentileRank * 100).toFixed(1)}% above threshold`);
            }
            if (percentileRank < 1 - threshold) {
                return createSellSignal(cleanData, i, `Momentum percentile ${(percentileRank * 100).toFixed(1)}% below inverse threshold`);
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
