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
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 32))),
    };
}

export const adjacent_overlap_exhaustion_dispersion_fade: Strategy = {
    name: "Adjacent Overlap Exhaustion Dispersion Fade",
    description: "Fades territorial over-expansion when adjacent range overlap drops to historical lows (bottom 5th percentile).",
    defaultParams: {
        lookback: 32,
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

        return createSignalLoop(cleanData, [pctOverlap], (i) => {
            if (i < 1) return null;
            const pctl = pctOverlap[i];
            if (pctl === null || pctl > 0.05) return null;

            if (cleanData[i].close < cleanData[i - 1].low) {
                return createBuySignal(cleanData, i, `Bullish overlap exhaustion fade: overlap percentile ${pctl.toFixed(3)} <= 0.05, close < prior low`);
            }
            if (cleanData[i].close > cleanData[i - 1].high) {
                return createSellSignal(cleanData, i, `Bearish overlap exhaustion fade: overlap percentile ${pctl.toFixed(3)} <= 0.05, close > prior high`);
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
