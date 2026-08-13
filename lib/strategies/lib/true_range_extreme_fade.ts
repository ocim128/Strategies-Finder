import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

const TRUE_RANGE_PERCENTILE_GATE = 0.9;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const true_range_extreme_fade: Strategy = {
    name: "True Range Extreme Fade",
    description: "Fades the direction of bars whose true range sits at a percentile extreme of its own history.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Percentile Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const pct = buildPercentileRank(trueRange, lookback);

        return createSignalLoop(cleanData, [pct], (i) => {
            const pr = pct[i];
            if (pr === null || pr < TRUE_RANGE_PERCENTILE_GATE) return null;

            // A blowout bar ends the local impulse: fade the bar's own direction.
            if (cleanData[i].close < cleanData[i].open) {
                return createBuySignal(cleanData, i, `Extreme-range down bar fades up: rank ${pr.toFixed(2)}`);
            }
            if (cleanData[i].close > cleanData[i].open) {
                return createSellSignal(cleanData, i, `Extreme-range up bar fades down: rank ${pr.toFixed(2)}`);
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
