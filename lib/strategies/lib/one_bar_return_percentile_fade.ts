import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

const RETURN_PCTL_FLOOR = 0.1;
const RETURN_PCTL_CEILING = 0.9;

function normalizeOneBarReturnPercentileFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const one_bar_return_percentile_fade: Strategy = {
    name: "One Bar Return Percentile Fade",
    description: "Fades single-bar return extremes at the percentiles of their own trailing distribution.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeOneBarReturnPercentileFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeOneBarReturnPercentileFadeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const returnPct = buildPercentileRank(returns, lookback);

        return createSignalLoop(cleanData, [returnPct], (i) => {
            if (i < lookback) return null;
            const rank = returnPct[i];
            if (rank === null) return null;

            if (rank < RETURN_PCTL_FLOOR) {
                return createBuySignal(cleanData, i, `One-bar return fade buy: return rank ${rank.toFixed(2)} below ${RETURN_PCTL_FLOOR}`);
            }
            if (rank > RETURN_PCTL_CEILING) {
                return createSellSignal(cleanData, i, `One-bar return fade sell: return rank ${rank.toFixed(2)} above ${RETURN_PCTL_CEILING}`);
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
