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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 28))),
    };
}

export const adjacent_overlap_percentile_drop_release: Strategy = {
    name: "Adjacent Overlap Percentile Drop Release",
    description: "Enters compression release when rolling overlap percentile abruptly drops from above 0.60 to below 0.30 in a single bar.",
    defaultParams: {
        lookback: 28,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const pctOverlap = buildPercentileRank(overlap, lookback);

        return createSignalLoop(cleanData, [pctOverlap], (i) => {
            if (i < 1) return null;
            const pPrev = pctOverlap[i - 1];
            const pCurr = pctOverlap[i];
            if (pPrev === null || pCurr === null) return null;

            if (pPrev >= 0.60 && pCurr <= 0.30) {
                if (cleanData[i].close > cleanData[i].open) {
                    return createBuySignal(cleanData, i, `Bullish overlap percentile drop: ${pPrev.toFixed(2)} -> ${pCurr.toFixed(2)}, close > open`);
                }
                if (cleanData[i].close < cleanData[i].open) {
                    return createSellSignal(cleanData, i, `Bearish overlap percentile drop: ${pPrev.toFixed(2)} -> ${pCurr.toFixed(2)}, close < open`);
                }
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
