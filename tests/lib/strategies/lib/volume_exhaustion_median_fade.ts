import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.0)),
        maxVolPercentile: Math.max(0, Math.min(1, Number(params.maxVolPercentile ?? 0.30))),
    };
}

export const volume_exhaustion_median_fade: Strategy = {
    name: "Volume Exhaustion Median Fade",
    description: "Fades close price z-score extremes when volume percentile rank is extremely low, indicating liquidity exhaustion on the illiquid leg.",
    defaultParams: {
        lookback: 25,
        zThreshold: 2.0,
        maxVolPercentile: 0.30,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
        maxVolPercentile: "Max Volume Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const closeZ = buildRollingZScore(closes, lookback);

        const volumes = getVolumes(cleanData);
        const volPctl = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [closeZ, volPctl], (i) => {
            const z = closeZ[i];
            const vp = volPctl[i];
            if (z === null || vp === null) return null;

            if (vp < p.maxVolPercentile) {
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Volume exhaustion buy: Z-score ${z.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Volume exhaustion sell: Z-score ${z.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold", "maxVolPercentile"],
    },
};
