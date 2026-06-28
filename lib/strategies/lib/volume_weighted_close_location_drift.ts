import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeVolumeWeightedCloseLocationDriftParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        weightedScoreMin: Math.max(0, Math.min(1, Number(params.weightedScoreMin ?? 0.55))),
    };
}

export const volume_weighted_close_location_drift: Strategy = {
    name: "Volume Weighted Close Location Drift",
    description: "Proxy-volume-weighted close location as institutional flow.",
    defaultParams: {
        lookback: 30,
        weightedScoreMin: 0.55,
    },
    paramLabels: {
        lookback: "Lookback",
        weightedScoreMin: "Weighted Score Min",
    },
    normalizeParams: normalizeVolumeWeightedCloseLocationDriftParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeWeightedCloseLocationDriftParams(params);
        const lookback = p.lookback as number;
        const weightedScoreMin = p.weightedScoreMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        const weightedScore: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const volPct = volumePercentile[i];
            weightedScore[i] = volPct !== null ? closeLocation[i] * volPct : 0;
        }

        const smoothedScore = buildRollingAverage(weightedScore, lookback);

        return createSignalLoop(cleanData, [smoothedScore], (i) => {
            const score = smoothedScore[i];
            if (score === null) return null;

            if (score > weightedScoreMin) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Smoothed volume-weighted close location score ${score.toFixed(3)} above threshold ${weightedScoreMin}`
                );
            }
            if (score < (1 - weightedScoreMin)) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Smoothed volume-weighted close location score ${score.toFixed(3)} below threshold ${1 - weightedScoreMin}`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "weightedScoreMin"],
    },
};
