import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeClosePercentileStateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        upper_pct: Math.max(0.5, Math.min(1, Number(params.upper_pct ?? 0.7))),
        lower_pct: Math.max(0, Math.min(0.5, Number(params.lower_pct ?? 0.3))),
    };
}

export const close_percentile_state: Strategy = {
    name: "Close Percentile State",
    description:
        "Measures where the completed close sits inside its trailing close distribution and treats upper-tail or lower-tail settlement as daily state acceptance.",
    defaultParams: {
        lookback: 63,
        upper_pct: 0.7,
        lower_pct: 0.3,
    },
    paramLabels: {
        lookback: "Lookback",
        upper_pct: "Upper Percentile",
        lower_pct: "Lower Percentile",
    },
    normalizeParams: normalizeClosePercentileStateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeClosePercentileStateParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const percentileRank = buildPercentileRank(closes, lookback);

        return createSignalLoop(cleanData, [percentileRank], (i) => {
            if (i < lookback - 1) return null;

            const rank = percentileRank[i];
            if (rank === null) return null;

            if (rank > (p.upper_pct as number)) {
                return createBuySignal(cleanData, i, `Close percentile ${rank.toFixed(2)} above bullish threshold`);
            }
            if (rank < (p.lower_pct as number)) {
                return createSellSignal(cleanData, i, `Close percentile ${rank.toFixed(2)} below bearish threshold`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "upper_pct", "lower_pct"],
    },
};
