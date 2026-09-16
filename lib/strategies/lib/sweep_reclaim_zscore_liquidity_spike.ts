import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        z_threshold: Math.max(1.0, Number(params.z_threshold ?? 2.2)),
    };
}

export const sweep_reclaim_zscore_liquidity_spike: Strategy = {
    name: "Sweep Reclaim ZScore Liquidity Spike",
    description: "Enters liquidity captures when the rolling Z-score of continuous sweep scores exceeds +/- z_threshold standard deviations.",
    defaultParams: {
        z_threshold: 2.2,
    },
    paramLabels: {
        z_threshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const zThreshold = Number(params.z_threshold);

        const sweepScores = buildSweepReclaimScoreSeries(cleanData);
        const zScore = buildRollingZScore(sweepScores, 30);

        return createSignalLoop(cleanData, [zScore], (i) => {
            const z = zScore[i];
            if (z === null) return null;

            if (z >= zThreshold) {
                return createBuySignal(cleanData, i, `Bullish sweep z-score liquidity spike: z=${z.toFixed(2)} >= ${zThreshold}`);
            }
            if (z <= -zThreshold) {
                return createSellSignal(cleanData, i, `Bearish sweep z-score liquidity spike: z=${z.toFixed(2)} <= -${zThreshold}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["z_threshold"],
    },
};
