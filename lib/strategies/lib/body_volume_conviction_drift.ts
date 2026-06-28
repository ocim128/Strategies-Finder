import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildStreakCount, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeBodyVolumeConvictionDriftParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.50))),
        streakMin: Math.max(1, Math.round(Number(params.streakMin ?? 3))),
    };
}

export const body_volume_conviction_drift: Strategy = {
    name: "Body Volume Conviction Drift",
    description: "Body direction confirmed by proxy volume as order flow conviction.",
    defaultParams: {
        lookback: 30,
        volumePercentileMin: 0.50,
        streakMin: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        volumePercentileMin: "Volume Percentile Min",
        streakMin: "Streak Min",
    },
    normalizeParams: normalizeBodyVolumeConvictionDriftParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodyVolumeConvictionDriftParams(params);
        const lookback = p.lookback as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        const streakMin = p.streakMin as number;
        if (cleanData.length < lookback + 1) return [];

        const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        const filteredFlags: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const volPct = volumePercentile[i];
            if (volPct !== null && volPct >= volumePercentileMin) {
                filteredFlags[i] = bodyDir[i];
            } else {
                filteredFlags[i] = 0;
            }
        }

        const streakCounts = buildStreakCount(filteredFlags);

        return createSignalLoop(cleanData, [streakCounts], (i) => {
            const streak = streakCounts[i];
            if (streak === 0) return null;

            if (streak >= streakMin) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish high-conviction body streak of ${streak} bars`
                );
            }
            if (streak <= -streakMin) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish high-conviction body streak of ${Math.abs(streak)} bars`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volumePercentileMin", "streakMin"],
    },
};
