import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildAdjacentRangeOverlapSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const adjacent_overlap_relative_choke: Strategy = {
    name: "Adjacent Overlap Relative Choke",
    description: "Trades breakouts from historically extreme range overlap congestion (prior overlap percentile >= 90%).",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const pctOverlap = buildPercentileRank(overlap, lookback);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 1) return null;
            const prevPct = pctOverlap[i - 1];
            if (prevPct === null || prevPct < 0.90) return null;

            if (cleanData[i].close > cleanData[i - 1].high) {
                return createBuySignal(cleanData, i, `Bullish overlap choke breakout: prior overlap pctl ${prevPct.toFixed(2)} >= 0.90, close > prior high`);
            }
            if (cleanData[i].close < cleanData[i - 1].low) {
                return createSellSignal(cleanData, i, `Bearish overlap choke breakout: prior overlap pctl ${prevPct.toFixed(2)} >= 0.90, close < prior low`);
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
