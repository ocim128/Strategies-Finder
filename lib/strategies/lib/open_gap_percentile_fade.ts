import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const GAP_PCTL_FLOOR = 0.1;
const GAP_PCTL_CEILING = 0.9;

function normalizeOpenGapPercentileFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const open_gap_percentile_fade: Strategy = {
    name: "Open Gap Percentile Fade",
    description: "Fades open-to-prior-close gaps sitting at extreme percentiles of their own recent gap distribution.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeOpenGapPercentileFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeOpenGapPercentileFadeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const pctRank = buildPercentileRank(gapPct, lookback);

        return createSignalLoop(cleanData, [pctRank], (i) => {
            if (i < lookback) return null;
            const rank = pctRank[i];
            if (rank === null) return null;

            if (rank < GAP_PCTL_FLOOR) {
                return createBuySignal(cleanData, i, `Open gap fade buy: gap rank ${rank.toFixed(3)} below ${GAP_PCTL_FLOOR}`);
            }
            if (rank > GAP_PCTL_CEILING) {
                return createSellSignal(cleanData, i, `Open gap fade sell: gap rank ${rank.toFixed(3)} above ${GAP_PCTL_CEILING}`);
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
