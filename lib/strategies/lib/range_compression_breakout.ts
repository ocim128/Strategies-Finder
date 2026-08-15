import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRangeSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const COMPRESSION_FLOOR = 0.2;

function normalizeRangeCompressionBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const range_compression_breakout: Strategy = {
    name: "Range Compression Breakout",
    description: "Buys or sells closes beyond the prior-only trailing high/low after the previous bar's range percentile compressed, riding the release.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRangeCompressionBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeRangeCompressionBreakoutParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const rangeSeries = buildRangeSeries(cleanData);
        const pctRank = buildPercentileRank(rangeSeries, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        return createSignalLoop(cleanData, [pctRank], (i) => {
            if (i < lookback) return null;
            const priorRank = pctRank[i - 1];
            const highBound = highest[i];
            const lowBound = lowest[i];
            if (priorRank === null || highBound === null || lowBound === null) return null;
            const bar = cleanData[i];

            if (priorRank < COMPRESSION_FLOOR && bar.close > highBound) {
                return createBuySignal(cleanData, i, `Range compression breakout buy: prior range rank ${priorRank.toFixed(2)}, close above trailing high`);
            }
            if (priorRank < COMPRESSION_FLOOR && bar.close < lowBound) {
                return createSellSignal(cleanData, i, `Range compression breakout sell: prior range rank ${priorRank.toFixed(2)}, close below trailing low`);
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
