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
const BULLISH_PULLBACK_BAND = 0.4;
const BEARISH_PULLBACK_BAND = 0.6;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const conviction_bar_pullback_continuation: Strategy = {
    name: "Conviction Bar Pullback Continuation",
    description: "Enters the first pullback bar after a high body-proportion-percentile conviction bar.",
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
            const rank = convictionRank[i - 1];
            if (rank === null || rank <= CONVICTION_PERCENTILE) return null;

            const prior = cleanData[i - 1];
            if (prior.close > prior.open && closeLocation[i] < BULLISH_PULLBACK_BAND) {
                return createBuySignal(cleanData, i, "Pullback after bullish conviction bar");
            }
            if (prior.close < prior.open && closeLocation[i] > BEARISH_PULLBACK_BAND) {
                return createSellSignal(cleanData, i, "Pullback after bearish conviction bar");
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
