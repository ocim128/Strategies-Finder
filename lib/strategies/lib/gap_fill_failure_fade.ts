import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const EXTREME_LOW = 0.1;
const EXTREME_HIGH = 0.9;
const PLACEMENT_MID = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const gap_fill_failure_fade: Strategy = {
    name: "Gap Fill Failure Fade",
    description: "Fades extreme open gaps only when the same bar already closes back against the gap side.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Gap Percentile Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const gapRank = buildPercentileRank(gapPct, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [gapRank], (i) => {
            const rank = gapRank[i];
            if (rank === null) return null;

            if (rank < EXTREME_LOW && closeLocation[i] > PLACEMENT_MID) {
                return createBuySignal(cleanData, i, `Failed gap down filled: pctl ${rank.toFixed(2)}`);
            }
            if (rank > EXTREME_HIGH && closeLocation[i] < PLACEMENT_MID) {
                return createSellSignal(cleanData, i, `Failed gap up filled: pctl ${rank.toFixed(2)}`);
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
