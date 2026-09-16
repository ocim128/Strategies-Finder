import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildAdjacentRangeOverlapSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_streak: Math.max(1, Math.round(Number(params.min_streak ?? 3))),
    };
}

export const adjacent_overlap_compression_breakout: Strategy = {
    name: "Adjacent Overlap Compression Breakout",
    description: "Trades breakouts from extended high-overlap congestion streaks when price breaks outside the prior bar with low overlap.",
    defaultParams: {
        min_streak: 3,
    },
    paramLabels: {
        min_streak: "Min Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minStreak = p.min_streak as number;
        if (cleanData.length < minStreak + 2) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const flags = overlap.map((v) => (v >= 0.60 ? 1 : 0));
        const overlapStreak = buildStreakCount(flags);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 1) return null;

            const priorStreak = overlapStreak[i - 1];
            const currentOverlap = overlap[i];
            if (priorStreak < minStreak || currentOverlap >= 0.40) return null;

            if (cleanData[i].close > cleanData[i - 1].high) {
                return createBuySignal(cleanData, i, `Bullish compression breakout: prior overlap streak ${priorStreak} >= ${minStreak}, overlap ${currentOverlap.toFixed(2)} < 0.40, close > prior high`);
            }
            if (cleanData[i].close < cleanData[i - 1].low) {
                return createSellSignal(cleanData, i, `Bearish compression breakout: prior overlap streak ${priorStreak} >= ${minStreak}, overlap ${currentOverlap.toFixed(2)} < 0.40, close < prior low`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_streak"],
    },
};
