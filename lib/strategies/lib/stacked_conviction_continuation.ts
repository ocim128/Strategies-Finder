import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const CONVICTION_PERCENTILE = 0.8;
const UPPER_PLACEMENT = 0.6;
const LOWER_PLACEMENT = 0.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const stacked_conviction_continuation: Strategy = {
    name: "Stacked Conviction Continuation",
    description: "Continues after two consecutive same-direction bars whose body proportions both rank above the conviction band.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Conviction Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const convictionRank = buildPercentileRank(bodyPct, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [convictionRank], (i) => {
            const priorRank = convictionRank[i - 1];
            const currentRank = convictionRank[i];
            if (priorRank === null || currentRank === null) return null;
            if (priorRank <= CONVICTION_PERCENTILE || currentRank <= CONVICTION_PERCENTILE) return null;

            const prior = cleanData[i - 1];
            const current = cleanData[i];
            if (
                prior.close > prior.open &&
                current.close > current.open &&
                closeLocation[i] > UPPER_PLACEMENT
            ) {
                return createBuySignal(cleanData, i, "Stacked bullish conviction bars");
            }
            if (
                prior.close < prior.open &&
                current.close < current.open &&
                closeLocation[i] < LOWER_PLACEMENT
            ) {
                return createSellSignal(cleanData, i, "Stacked bearish conviction bars");
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
