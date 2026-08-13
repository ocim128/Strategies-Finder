import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

const WICK_PERCENTILE_GATE = 0.9;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const deep_wick_reversal: Strategy = {
    name: "Deep Wick Reversal",
    description: "Reverses at bars whose lower or upper wick sits at a percentile extreme of its own history.",
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

        const lowWickPct = buildPercentileRank(extractBarMetricSeries(cleanData, "lowerWick"), lookback);
        const upWickPct = buildPercentileRank(extractBarMetricSeries(cleanData, "upperWick"), lookback);

        return createSignalLoop(cleanData, [lowWickPct, upWickPct], (i) => {
            const lowRank = lowWickPct[i];
            const upRank = upWickPct[i];
            if (lowRank === null || upRank === null) return null;

            if (lowRank >= WICK_PERCENTILE_GATE) {
                return createBuySignal(cleanData, i, `Deep lower-wick rejection: rank ${lowRank.toFixed(2)}`);
            }
            if (upRank >= WICK_PERCENTILE_GATE) {
                return createSellSignal(cleanData, i, `Deep upper-wick rejection: rank ${upRank.toFixed(2)}`);
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
