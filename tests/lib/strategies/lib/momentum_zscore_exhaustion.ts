import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateMomentum } from "../indicators";
import { buildRollingZScore } from "./price-action-statistics-core";

export const momentum_zscore_exhaustion: Strategy = {
    name: "Momentum Z-Score Exhaustion",
    description: "Quantifies purely statistical exhaustion of velocity by applying a rolling z-score directly to raw price momentum. Triggers mean-reversion when a violent momentum spike structurally exceeds historically normalized variance bounds.",
    defaultParams: {
        momPeriod: 10,
        zscoreLookback: 50,
        zscoreTrigger: 3.0,
    },
    paramLabels: {
        momPeriod: "Momentum Period",
        zscoreLookback: "Z-Score Window",
        zscoreTrigger: "Z-Score Boundary",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const mPeriod = params.momPeriod as number;
        const zLookback = params.zscoreLookback as number;

        if (cleanData.length < Math.max(mPeriod, zLookback) + 10) return [];

        const mom = calculateMomentum(cleanData.map(d => d.close), mPeriod);

        const safeMom = mom.map(v => v === null ? 0 : v);
        const zscore = buildRollingZScore(safeMom, zLookback);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < Math.max(mPeriod, zLookback) || zscore[i] === null || mom[i] === null) return null;

            const z = zscore[i]!;
            const trigger = params.zscoreTrigger as number;

            if (z < -trigger) {
                return createBuySignal(cleanData, i, "Upside reversion from extreme negative momentum z-score limit");
            }
            if (z > trigger) {
                return createSellSignal(cleanData, i, "Downside reversion from extreme positive momentum z-score limit");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["momPeriod", "zscoreLookback", "zscoreTrigger"],
    },
};
