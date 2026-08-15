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
const UPPER_ACCEPTANCE = 0.6;
const LOWER_ACCEPTANCE = 0.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const gap_and_go_continuation: Strategy = {
    name: "Gap And Go Continuation",
    description: "Continues extreme open gaps when the bar closes far on the gap side of its range.",
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

            if (rank > EXTREME_HIGH && closeLocation[i] > UPPER_ACCEPTANCE) {
                return createBuySignal(cleanData, i, `Accepted gap up: pctl ${rank.toFixed(2)}`);
            }
            if (rank < EXTREME_LOW && closeLocation[i] < LOWER_ACCEPTANCE) {
                return createSellSignal(cleanData, i, `Accepted gap down: pctl ${rank.toFixed(2)}`);
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
