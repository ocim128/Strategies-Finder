import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming typical price deviation from bar midpoint reverts when Z-score is extreme.
// #SUGGEST_VERIFY: Verify that lookback is sufficient to form a stable Z-score (>= 5).
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 35))),
        zThreshold: Math.max(0.1, Number(params.zThreshold ?? 2.2)),
    };
}

export const typical_midpoint_deviation_drift_reversion: Strategy = {
    name: "Typical Midpoint Deviation Drift Reversion",
    description: "Mean-reverts the Z-score of the difference between typical price and bar midpoint once it crosses extreme thresholds.",
    defaultParams: {
        lookback: 35,
        zThreshold: 2.2,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const zThreshold = p.zThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const typical = getTypicalPrices(cleanData);
        // Calculate midpoints: (high + low) / 2
        const midpoints = cleanData.map(d => (d.high + d.low) / 2);

        // Difference series: Typical - Midpoint
        const diff = typical.map((t, i) => t - midpoints[i]);

        const zScores = buildRollingZScore(diff, lookback);

        return createSignalLoop(cleanData, [zScores], (i) => {
            const z = zScores[i];
            if (z === null) return null;

            if (z < -zThreshold) {
                return createBuySignal(cleanData, i, `Typical-midpoint deviation Z-score ${z.toFixed(2)} < -${zThreshold}`);
            }
            if (z > zThreshold) {
                return createSellSignal(cleanData, i, `Typical-midpoint deviation Z-score ${z.toFixed(2)} > ${zThreshold}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
