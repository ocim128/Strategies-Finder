import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildAdjacentRangeOverlapSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        max_overlap: Math.max(0.05, Math.min(0.5, Number(params.max_overlap ?? 0.30))),
    };
}

export const adjacent_overlap_expansion_wick_reversal: Strategy = {
    name: "Adjacent Overlap Expansion Wick Reversal",
    description: "Fades low-overlap expansion thrusts that terminate with an opposing 50%+ rejection wick.",
    defaultParams: {
        max_overlap: 0.30,
    },
    paramLabels: {
        max_overlap: "Maximum Expansion Overlap",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const maxOverlap = Number(params.max_overlap);

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 1) return null;
            const ov = overlap[i];
            if (ov === null || ov > maxOverlap) return null;

            const bar = cleanData[i];
            const prior = cleanData[i - 1];
            const range = bar.high - bar.low;
            if (range <= 0) return null;

            // Downward expansion with lower rejection wick >= 50%
            if (bar.low < prior.low && (bar.close - bar.low) >= range * 0.50) {
                return createBuySignal(cleanData, i, `Bullish expansion wick reversal: overlap=${ov.toFixed(2)}<=${maxOverlap}, lower rejection wick>=50%`);
            }

            // Upward expansion with upper rejection wick >= 50%
            if (bar.high > prior.high && (bar.high - bar.close) >= range * 0.50) {
                return createSellSignal(cleanData, i, `Bearish expansion wick reversal: overlap=${ov.toFixed(2)}<=${maxOverlap}, upper rejection wick>=50%`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_overlap"],
    },
};
