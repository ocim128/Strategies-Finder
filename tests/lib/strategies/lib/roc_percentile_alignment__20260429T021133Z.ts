import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeRocPercentileAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        threshold: Math.max(50, Math.min(99, Number(params.threshold ?? 70))),
    };
}

export const roc_percentile_alignment: Strategy = {
    name: "ROC Percentile Alignment",
    description:
        "Ranks the current one-bar rate of change inside its trailing distribution so entries reflect momentum positioning rather than raw point-distance from recent price.",
    defaultParams: {
        lookback: 63,
        threshold: 70,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Percentile Threshold",
    },
    normalizeParams: normalizeRocPercentileAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRocPercentileAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const percentileRank = buildPercentileRank(roc, lookback);
        const threshold = (p.threshold as number) / 100;

        return createSignalLoop(cleanData, [percentileRank], (i) => {
            if (i < lookback) return null;

            const rank = percentileRank[i];
            if (rank === null) return null;

            if (rank > threshold) {
                return createBuySignal(cleanData, i, `ROC percentile ${rank.toFixed(2)} above bullish threshold`);
            }
            if (rank < 1 - threshold) {
                return createSellSignal(cleanData, i, `ROC percentile ${rank.toFixed(2)} below bearish threshold`);
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
