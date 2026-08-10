import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import {
    extractBarMetricSeries,
    buildPercentileRank,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeQuietVolumeMoveFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const quiet_volume_move_fade: Strategy = {
    name: "Quiet Volume Move Fade",
    description: "Fades return z-score extremes only when participation is quiet, keeping the fade out of high-effort trends.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeQuietVolumeMoveFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeQuietVolumeMoveFadeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const zscore = buildRollingZScore(closeReturn, lookback);
        const volumes = getVolumes(cleanData);
        const volPct = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [zscore, volPct], (i) => {
            if (i < lookback) return null;
            const z = zscore[i];
            const vp = volPct[i];
            if (z === null || vp === null) return null;

            if (z < -2.0 && vp < 0.3) {
                return createBuySignal(cleanData, i, `Quiet-volume down extreme: z ${z.toFixed(2)}, vol percentile ${vp.toFixed(2)}`);
            }
            if (z > 2.0 && vp < 0.3) {
                return createSellSignal(cleanData, i, `Quiet-volume up extreme: z ${z.toFixed(2)}, vol percentile ${vp.toFixed(2)}`);
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
