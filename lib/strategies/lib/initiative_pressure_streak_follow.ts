import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildStreakCount } from "./price-action-statistics-core";

function normalizeInitiativePressureStreakFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        streakMin: Math.max(1, Math.round(Number(params.streakMin ?? 3))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.40))),
    };
}

export const initiative_pressure_streak_follow: Strategy = {
    name: "Initiative Pressure Streak Follow",
    description: "Persistent initiative pressure via streak counting.",
    defaultParams: {
        lookback: 30,
        streakMin: 3,
        volumePercentileMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        streakMin: "Streak Min",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeInitiativePressureStreakFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureStreakFollowParams(params);
        const lookback = p.lookback as number;
        const streakMin = p.streakMin as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const cleanPressure = pressure.map(pr => pr ?? 0);
        const pressureFlags = cleanPressure.map(pr => pr === 0 ? 0 : (pr > 0 ? 1 : -1));
        const streakCounts = buildStreakCount(pressureFlags);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [streakCounts, volumePercentile], (i) => {
            const streak = streakCounts[i];
            const volPct = volumePercentile[i];
            if (streak === 0 || volPct === null) return null;

            if (volPct > volumePercentileMin) {
                if (streak >= streakMin) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish initiative pressure streak of ${streak} bars confirmed by volume percentile ${volPct.toFixed(2)}`
                    );
                }
                if (streak <= -streakMin) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish initiative pressure streak of ${Math.abs(streak)} bars confirmed by volume percentile ${volPct.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakMin", "volumePercentileMin"],
    },
};
